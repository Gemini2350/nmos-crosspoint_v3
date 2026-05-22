/*
 * NMOS Crosspoint — DNS Push Service
 *
 * Pushes NMOS node names (or user aliases) as host_overrides to the pfSense
 * DNS Resolver (Unbound) via the pfRest REST API.
 *   See https://pfrest.org/api-docs/
 *
 * Each managed entry's description is tagged with `NMOS-Crosspoint:<nodeId>`
 * so the service can recognise which entries it owns and never touches
 * manually-configured ones.
 *
 * Pushes are debounced (2 s) so a burst of NMOS updates produces one API
 * batch rather than dozens of parallel calls.
 *
 * Every batch ends with a POST to `/api/v2/services/dns_resolver/apply` —
 * Unbound stages changes until applied, so without it the entries would sit
 * invisible in the running config and DNS would still answer with the old
 * data.
 */

import axios, { AxiosInstance } from "axios";
import * as https from "https";
import { SyncLog } from "./syncLog";

export interface DnsPushSettings {
    enabled: boolean;
    serverIp: string;
    serverPort: number;
    protocol: "http" | "https";
    apiKey: string;
    domain: string;
    insecureTLS: boolean;
}

// We always target the Resolver (Unbound) — pfSense default since 2.2 — and
// don't expose the Forwarder (dnsmasq) option. Keeps the UI simple; if a
// deployment ever needs Forwarder it's a one-line change here.
const DNS_SERVICE_BASE = "/api/v2/services/dns_resolver";

interface HostOverride {
    id?: number;
    host: string;
    domain: string;
    ip: string[];
    descr?: string;
}

interface PendingNode {
    nodeId: string;
    displayName: string;
    ip: string;
}

const OWNER_TAG = "NMOS-Crosspoint";

export class DnsPushService {
    private static _instance: DnsPushService | null = null;
    public static get instance(): DnsPushService | null { return this._instance; }

    private settings: DnsPushSettings = {
        enabled: false, serverIp: "", serverPort: 443, protocol: "https",
        apiKey: "", domain: "local", insecureTLS: true
    };

    // Pending pushes — coalesced over the debounce window so a burst of NMOS
    // node updates results in a single batch of API calls.
    private pending: Map<string, PendingNode> = new Map();
    private debounceTimer: any = null;

    // Inventory of entries we've successfully pushed (or refreshed) to the
    // pfSense resolver. Keyed by nodeId. Surfaced to the Setup page via a
    // SyncObject so the operator can see what's actually live.
    private lastPushed: Map<string, { nodeId:string, host:string, domain:string, ip:string, ts:string }> = new Map();
    private onChange: (() => void) | null = null;
    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    private notifyChange() {
        if (this.onChange) {
            try { this.onChange(); } catch { /* swallow */ }
        }
    }
    getPushedEntries(): Array<{ nodeId:string, host:string, domain:string, ip:string, ts:string }> {
        return Array.from(this.lastPushed.values()).sort((a,b)=>a.host.localeCompare(b.host));
    }

    constructor() {
        DnsPushService._instance = this;
    }

    setSettings(s: any) {
        if (!s || typeof s !== "object") return;
        this.settings = {
            enabled:     !!s.enabled,
            serverIp:    typeof s.serverIp    === "string" ? s.serverIp.trim() : "",
            serverPort:  (typeof s.serverPort === "number" && s.serverPort > 0 && s.serverPort < 65536) ? s.serverPort : 443,
            protocol:    s.protocol === "http" ? "http" : "https",
            apiKey:      typeof s.apiKey      === "string" ? s.apiKey : "",
            domain:      (typeof s.domain     === "string" && s.domain) ? s.domain.trim() : "local",
            insecureTLS: s.insecureTLS !== false,
        };
    }

    isEnabled(): boolean {
        return this.settings.enabled
            && !!this.settings.serverIp
            && !!this.settings.apiKey;
    }


    // ----- API helpers -----

    private getAxios(): AxiosInstance {
        const base = `${this.settings.protocol}://${this.settings.serverIp}:${this.settings.serverPort}`;
        // pfRest API Key authentication — sent as the `X-API-Key` header.
        //   See https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/#api-key
        //
        // pfRest refuses axios's default multi-value Accept header with a 406
        // (`CONTENT_HANDLER_ENCODE_NOT_FOUND` — "No content handler exists for
        // `application/json, text/plain, */*`"). It demands a single MIME
        // type, so we force `application/json` on every request.
        const inst = axios.create({
            baseURL: base,
            timeout: 15000,
            httpsAgent: this.settings.insecureTLS
                ? new https.Agent({ rejectUnauthorized: false })
                : undefined,
            headers: {
                "Content-Type": "application/json",
                "Accept":       "application/json",
                "X-API-Key":    this.settings.apiKey,
            },
        });
        // Belt-and-braces: axios merges per-method header defaults (`common`,
        // `get`, `post`, …) into the request, and its built-in defaults
        // include the offending multi-value Accept. Pin all of them to the
        // single value pfRest accepts.
        try{
            inst.defaults.headers.common["Accept"] = "application/json";
            ["get","post","put","patch","delete","head"].forEach((m)=>{
                try{ (inst.defaults.headers as any)[m]["Accept"] = "application/json"; }catch(e){}
            });
        }catch(e){}
        return inst;
    }

    private sanitiseHost(name: string): string {
        if (!name) return "";
        return ("" + name)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 63);
    }

    private async applyChanges(ax: AxiosInstance) {
        try {
            await ax.post(DNS_SERVICE_BASE + "/apply", {});
        } catch (e: any) {
            // Without a successful apply, pfSense holds the change in the
            // staged config and Unbound keeps answering with the old data —
            // so this matters. Log loudly instead of swallowing it.
            SyncLog.log("error", "DNS Push", "apply call failed: " +
                (e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || e)));
        }
    }

    /** Fetch every host_override currently configured on the pfSense. */
    private async listOverrides(ax: AxiosInstance): Promise<HostOverride[]> {
        try {
            const res = await ax.get(DNS_SERVICE_BASE + "/host_overrides");
            const data = (res.data && (res.data.data ?? res.data)) || [];
            if (!Array.isArray(data)) return [];
            return data.map((o: any) => ({
                id:     o.id,
                host:   o.host,
                domain: o.domain,
                ip:     Array.isArray(o.ip) ? o.ip : (o.ip ? [o.ip] : []),
                descr:  o.descr || "",
            }));
        } catch (e: any) {
            SyncLog.log("error", "DNS Push", "List host_overrides failed: " + (e?.message || e));
            return [];
        }
    }


    // ----- Push pipeline -----

    /**
     * Schedule a push for a single node. Coalesces multiple calls into one
     * batch via a short debounce window.
     */
    scheduleNodePush(nodeId: string, displayName: string, ip: string) {
        if (!this.isEnabled()) return;
        if (!nodeId || !displayName || !ip) return;
        this.pending.set(nodeId, { nodeId, displayName, ip });
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            const batch = Array.from(this.pending.values());
            this.pending.clear();
            this.flush(batch).catch(e => SyncLog.log("error", "DNS Push", "Flush failed: " + (e?.message || e)));
        }, 2000);
    }

    private async flush(batch: PendingNode[]) {
        if (!this.isEnabled() || batch.length === 0) return;
        const ax = this.getAxios();
        const all = await this.listOverrides(ax);
        const domain = this.settings.domain || "local";
        let changed = false;
        for (const node of batch) {
            const host = this.sanitiseHost(node.displayName);
            if (!host) continue;
            const tag = OWNER_TAG + ":" + node.nodeId;
            // pfRest's Resolver (Unbound) host_override schema expects `ip` as
            // an array of strings (a single override can resolve to multiple
            // IPs). Sending a plain string returns 400 FIELD_INVALID_MANY_VALUE.
            // (The Forwarder schema is the opposite — it wants a single string
            // — but we don't target the Forwarder.)
            const body = { host, domain, ip: [node.ip], descr: tag };
            const owned = all.find(o => (o.descr || "").includes(tag));

            try {
                if (owned && owned.id !== undefined) {
                    if (owned.host === host && owned.domain === domain &&
                        Array.isArray(owned.ip) && owned.ip.length === 1 && owned.ip[0] === node.ip) {
                        // already up to date — still record so the inventory
                        // shows it (timestamp may be from a previous run)
                        if(!this.lastPushed.has(node.nodeId)){
                            this.lastPushed.set(node.nodeId, { nodeId: node.nodeId, host, domain, ip: node.ip, ts: new Date().toISOString() });
                            this.notifyChange();
                        }
                        continue;
                    }
                    await ax.patch(DNS_SERVICE_BASE + "/host_override", { id: owned.id, ...body });
                    SyncLog.log("info", "DNS Push", `Updated ${host}.${domain} → ${node.ip}  (id=${owned.id})`);
                    this.lastPushed.set(node.nodeId, { nodeId: node.nodeId, host, domain, ip: node.ip, ts: new Date().toISOString() });
                    this.notifyChange();
                    changed = true;
                } else {
                    // Avoid clobbering a non-owned manual entry with the same name
                    const collision = all.find(o => o.host === host && o.domain === domain);
                    if (collision && !(collision.descr || "").includes(OWNER_TAG)) {
                        SyncLog.log("warn", "DNS Push", `Skipping ${host}.${domain} — already exists and is not owned by NMOS Crosspoint.`);
                        continue;
                    }
                    await ax.post(DNS_SERVICE_BASE + "/host_override", body);
                    SyncLog.log("info", "DNS Push", `Created ${host}.${domain} → ${node.ip}`);
                    this.lastPushed.set(node.nodeId, { nodeId: node.nodeId, host, domain, ip: node.ip, ts: new Date().toISOString() });
                    this.notifyChange();
                    changed = true;
                }
            } catch (e: any) {
                SyncLog.log("error", "DNS Push", `Push failed for ${host}.${domain}: ` + (e?.response?.data ? JSON.stringify(e.response.data) : e?.message || e));
            }
        }
        if (changed) await this.applyChanges(ax);
    }

    /**
     * Remove the DNS entry for a single node. Called when a device is
     * forgotten via the Details page.
     */
    async removeNode(nodeId: string) {
        if (!nodeId) return;
        if (!this.settings.serverIp) return;  // can't reach the API anyway
        const ax = this.getAxios();
        const all = await this.listOverrides(ax);
        const tag = OWNER_TAG + ":" + nodeId;
        const owned = all.find(o => (o.descr || "").includes(tag));
        if (!owned || owned.id === undefined) {
            SyncLog.log("info", "DNS Push", "No DNS entry to remove for nodeId=" + nodeId);
            return;
        }
        try {
            await ax.delete(DNS_SERVICE_BASE + `/host_override?id=${owned.id}`);
            await this.applyChanges(ax);
            SyncLog.log("info", "DNS Push", `Removed DNS entry ${owned.host}.${owned.domain} (id=${owned.id})`);
            if(this.lastPushed.delete(nodeId)){
                this.notifyChange();
            }
        } catch (e: any) {
            SyncLog.log("error", "DNS Push", `Remove failed for nodeId=${nodeId}: ` + (e?.message || e));
        }
    }

    /**
     * Push every passed node now. Used when the user just enabled the
     * feature so existing NMOS nodes don't have to wait for a state change
     * to get pushed.
     */
    async syncAll(nodes: PendingNode[]) {
        if (!this.isEnabled()) return;
        if (nodes.length === 0) return;
        await this.flush(nodes);
    }
}
