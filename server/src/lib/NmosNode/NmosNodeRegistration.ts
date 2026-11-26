/*
 * NMOS Crosspoint — IS-04 Registration Client
 *
 * Pushes the virtual Node + Devices + Sources + Flows + Senders (built by
 * NmosNodeApi) to the configured NMOS registry, then keeps the Node alive
 * with periodic heartbeats. Without this, the registry would never know
 * about virtual senders even though /x-nmos/... is being served — other
 * controllers can't query a Node they were never told about.
 *
 * Lifecycle:
 *
 *   start()           — POST node → devices → sources → flows → senders,
 *                       then begin the heartbeat loop.
 *   syncResources()   — re-POST every resource (used after the operator
 *                       saves a settings change so renames/SDP updates land).
 *   stop()            — DELETE the node (registry deletes its children
 *                       automatically) and stop the heartbeat. Used when
 *                       the live-registry-switch tears the old registry
 *                       down before bringing the new one up.
 *
 * Where it registers (registryBase): a registration API of its own when
 * settings.virtualNode.registration says so (a registry whose query and
 * registration APIs differ), else the registry the crosspoint uses — the
 * static one, else the one discovered. When that target changes, the
 * resources move: deleted at the old registry, posted at the new one.
 *
 * On 404 from a heartbeat we treat the Node as forgotten by the registry
 * and re-POST everything from scratch.
 */

import { NmosNodeApi } from "./NmosNodeApi";
import { SyncLog } from "../syncLog";
import { httpBase } from "../virtualDevices";

const axios = require("axios");

export class NmosNodeRegistration {
    public static instance: NmosNodeRegistration | null = null;

    private settings:any;
    private heartbeatTimer:any = null;
    private heartbeatMs = 5000;
    // How many heartbeat ticks between safety re-syncs of all resources.
    // 12 ticks × 5 s = 60 s. The safety sync catches drift scenarios where
    // the heartbeat is healthy (node present) but the registry has lost or
    // never received some of our dependent resources — without this we'd
    // be stuck POSTing nothing because 404 is never returned on
    // /health/nodes/<id>.
    private safetyResyncEveryNTicks = 12;
    // Generation counter — bumped on stop() / settings change so a stray
    // re-POST after the registry was torn down doesn't undo the teardown.
    private gen = 0;
    private running = false;
    // Set while a syncResources() is mid-flight so concurrent triggers
    // (heartbeat 404 + safety re-sync + setupConfig POST) don't interleave
    // two POST sequences against the same registry.
    private syncInFlight = false;

    // IDs we last POSTed to the registry, so syncResources() can DELETE
    // entries that disappeared from settings.virtualSenders.
    private lastSenderIds: Set<string> = new Set();
    private lastFlowIds:   Set<string> = new Set();
    private lastSourceIds: Set<string> = new Set();
    private lastDeviceIds: Set<string> = new Set();
    // The registration API the resources were posted to. stop() and a
    // change of target clean up there, not at wherever settings point now.
    private registeredAt = "";
    private heartbeatFailed = false;

    /** The registry the crosspoint uses (set by server.ts), for the
     *  "registry" mode when no static registry is configured. */
    public registrySource: () => { ip: string, port: number } | null = () => null;

    /** Shown on the Setup page: where the Node registers and how that went. */
    public status: { target: string, state: "off" | "registered" | "error" | "none", error: string, devices: number, senders: number } =
        { target: "", state: "off", error: "", devices: 0, senders: 0 };
    public onStatus: () => void = () => {};

    constructor(settings:any){
        this.settings = settings;
        NmosNodeRegistration.instance = this;
    }

    public setSettings(settings:any){
        this.settings = settings;
    }

    /** The registry base URL ("http://ip:port"), or "" if there is none —
     *  for the configured registration, or for the one given. */
    public registryBase(reg:any = this.settings?.virtualNode?.registration): string {
        try{
            if(reg?.mode === "custom") return (reg.host && reg.port) ? httpBase(reg.host, reg.port) : "";
            let list = this.settings?.staticNmosRegistries;
            let r = Array.isArray(list) ? list[0] : null;
            if(r && r.ip && r.port) return httpBase(r.ip, r.port);
            let cur = this.registrySource();
            if(cur && cur.ip && cur.port) return httpBase(cur.ip, cur.port);
        }catch(e){}
        return "";
    }

    private setStatus(next: Partial<NmosNodeRegistration["status"]>){
        // The target as the Setup page shows it: the registry, not the path.
        if(next.target) next = { ...next, target: next.target.replace(/\/x-nmos\/registration\/v1\.3$/, "") };
        let merged = { ...this.status, ...next };
        if(JSON.stringify(merged) === JSON.stringify(this.status)) return;
        this.status = merged;
        try{ this.onStatus(); }catch(e){}
    }

    /** A registry error as the Setup page shows it. */
    private static describe(e:any): string {
        let st = e?.response?.status;
        if(st){
            let body = e.response.data;
            let msg = (body && typeof body === "object") ? (body.error || body.debug || "") : "";
            return "HTTP " + st + (msg ? (": " + String(msg).slice(0, 200)) : "");
        }
        return e?.code || e?.message || String(e);
    }

    private registeredStatus(resources:any){
        this.setStatus({ target: this.registeredAt, state: "registered", error: "",
            devices: resources.devices.length, senders: resources.senders.length });
    }

    private apiBase(): string {
        let base = this.registryBase();
        return base ? (base + "/x-nmos/registration/v1.3") : "";
    }


    /** POST every resource (node first, then dependents). Idempotent — the
     *  registry treats a re-POST of an existing resource as an update.
     *
     *  Only runs when `settings.virtualNode.enabled` is explicitly true —
     *  the feature is opt-in (default off in parseSettings).
     */
    public async start(){
        if(this.running) return;
        if(this.settings?.virtualNode?.enabled !== true){
            SyncLog.log("info", "NMOS Node Registration", "Virtual Node feature disabled in settings — skipping registration.");
            this.setStatus({ target: "", state: "off", error: "" });
            return;
        }
        this.running = true;
        this.gen++;
        let myGen = this.gen;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api){
            SyncLog.log("warn", "NMOS Node Registration", "NmosNodeApi missing — not registering.");
            this.running = false;
            return;
        }
        if(!url){
            // No registry yet: one may be discovered later, and the
            // heartbeat loop registers there as soon as it is.
            SyncLog.log("info", "NMOS Node Registration", "No registry to register the virtual Node at yet.");
            this.setStatus({ target: "", state: "none", error: "" });
            this.scheduleHeartbeat(myGen);
            return;
        }
        this.registeredAt = url;
        let resources = api.getResources();
        if(!resources.node){
            SyncLog.log("warn", "NMOS Node Registration", "No node resource built — skipping registration.");
            this.running = false;
            return;
        }

        SyncLog.log("info", "NMOS Node Registration", "Registering virtual Node + " + resources.senders.length + " sender(s) on " + url);

        // POST the node first AND start the heartbeat right after — the
        // registry expires the node after ~12 s without a heartbeat, and
        // POSTing all dependent resources for a large virtualSenders list
        // can take longer than that on a slow link. Starting the heartbeat
        // before the dependent POSTs keeps the TTL fresh and prevents the
        // "node disappears mid-registration" failure mode.
        let nodePosted = false;
        try{
            await this.postResource(url, "node", resources.node);
            nodePosted = true;
        }catch(e:any){
            SyncLog.log("error", "NMOS Node Registration", "Initial node POST failed (heartbeat 404 path will retry): " + (e?.message || e));
            this.setStatus({ target: url, state: "error", error: NmosNodeRegistration.describe(e) });
        }

        if(myGen !== this.gen) return;   // stop() was called mid-flight
        this.scheduleHeartbeat(myGen);

        // Best-effort POST of the dependent resources. Individual failures
        // are logged but don't abort the rest — the periodic safety re-sync
        // inside the heartbeat will refill any gaps that the registry has.
        try{
            if(nodePosted){
                for(let d of resources.devices) await this.postResource(url, "device", d);
                for(let s of resources.sources) await this.postResource(url, "source", s);
                for(let f of resources.flows)   await this.postResource(url, "flow",   f);
                for(let s of resources.senders) await this.postResource(url, "sender", s);
                this.snapshotIds(resources);
                if(myGen === this.gen) this.registeredStatus(resources);
            }
        }catch(e:any){
            SyncLog.log("warn", "NMOS Node Registration", "Dependent-resource POST failed during initial registration (safety re-sync will retry): " + (e?.message || e));
            if(myGen === this.gen) this.setStatus({ target: url, state: "error", error: NmosNodeRegistration.describe(e) });
        }
    }


    /** Remember which IDs we last published, so the next syncResources()
     *  can DELETE the ones that have since disappeared from settings. */
    private snapshotIds(resources:any){
        this.lastSenderIds = new Set(resources.senders.map((s:any) => s.id));
        this.lastFlowIds   = new Set(resources.flows.map((f:any) => f.id));
        this.lastSourceIds = new Set(resources.sources.map((s:any) => s.id));
        this.lastDeviceIds = new Set(resources.devices.map((d:any) => d.id));
    }

    /** DELETE what was last published at `url`, children before parents,
     *  and the node too when asked. Errors are the caller's. */
    private async deregisterAt(url:string, withNode:boolean, nodeId:string){
        for(let id of Array.from(this.lastSenderIds)) await this.deleteResource(url, "senders", id);
        for(let id of Array.from(this.lastFlowIds))   await this.deleteResource(url, "flows",   id);
        for(let id of Array.from(this.lastSourceIds)) await this.deleteResource(url, "sources", id);
        for(let id of Array.from(this.lastDeviceIds)) await this.deleteResource(url, "devices", id);
        if(withNode && nodeId) await this.deleteResource(url, "nodes", nodeId);
    }

    private clearIds(){
        this.lastSenderIds.clear();
        this.lastFlowIds.clear();
        this.lastSourceIds.clear();
        this.lastDeviceIds.clear();
    }


    /** Re-POST every resource AND DELETE any whose id has since disappeared
     *  from settings. Cheaper than a stop()+start() round-trip and is what
     *  we want when the operator added/removed/renamed a virtual sender,
     *  or when the periodic safety re-sync inside the heartbeat fires.
     *
     *  Guarded by `syncInFlight` so the three callers (heartbeat 404,
     *  periodic safety re-sync, setupConfig POST) can't interleave two
     *  POST sequences against the same registry.
     */
    public async syncResources(){
        if(!this.running){
            return this.start();
        }
        if(this.syncInFlight) return;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api) return;
        let resources = api.getResources();
        if(!resources.node) return;

        this.syncInFlight = true;
        let myGen = this.gen;
        try{
            // 0) The target changed (another registration API, another
            //    registry): take everything down at the old one first.
            if(this.registeredAt && this.registeredAt !== url){
                SyncLog.log("info", "NMOS Node Registration", "Registration target changed — deregistering at " + this.registeredAt);
                try{ await this.deregisterAt(this.registeredAt, true, resources.node.id); }
                catch(e:any){ SyncLog.log("verbose", "NMOS Node Registration", "Cleanup at the old target: " + (e?.message || e)); }
                this.clearIds();
                this.registeredAt = "";
            }
            if(!url){
                this.setStatus({ target: "", state: "none", error: "" });
                return;
            }
            this.registeredAt = url;

            // 1) DELETE resources that vanished between this sync and the
            //    last successful publication. Order matters: senders before
            //    flows before sources (children before parents).
            let nowSenders = new Set(resources.senders.map((s:any) => s.id));
            let nowFlows   = new Set(resources.flows.map((f:any) => f.id));
            let nowSources = new Set(resources.sources.map((s:any) => s.id));
            for(let id of Array.from(this.lastSenderIds)){
                if(!nowSenders.has(id)) await this.deleteResource(url, "senders", id);
            }
            for(let id of Array.from(this.lastFlowIds)){
                if(!nowFlows.has(id)) await this.deleteResource(url, "flows", id);
            }
            for(let id of Array.from(this.lastSourceIds)){
                if(!nowSources.has(id)) await this.deleteResource(url, "sources", id);
            }
            let nowDevices = new Set(resources.devices.map((d:any) => d.id));
            for(let id of Array.from(this.lastDeviceIds)){
                if(!nowDevices.has(id)) await this.deleteResource(url, "devices", id);
            }

            // 2) POST every currently-known resource (idempotent → update).
            //    Node FIRST — if it's missing in the registry, every
            //    dependent POST below would return 404 otherwise.
            await this.postResource(url, "node", resources.node);
            for(let d of resources.devices) await this.postResource(url, "device", d);
            for(let s of resources.sources) await this.postResource(url, "source", s);
            for(let f of resources.flows)   await this.postResource(url, "flow",   f);
            for(let s of resources.senders) await this.postResource(url, "sender", s);

            this.snapshotIds(resources);
            if(myGen !== this.gen) return;
            this.registeredStatus(resources);
            SyncLog.log("verbose", "NMOS Node Registration", "Re-synchronised virtual sender resources to registry.");
        }catch(e:any){
            SyncLog.log("warn", "NMOS Node Registration", "Sync failed: " + (e?.message || e));
            if(myGen === this.gen) this.setStatus({ target: url, state: "error", error: NmosNodeRegistration.describe(e) });
        }finally{
            this.syncInFlight = false;
        }
    }


    /** DELETE every resource and stop the heartbeat. Order matters: the
     *  registry rejects DELETEs of resources that still have dependents.
     *
     *  We clear the heartbeat interval BEFORE we begin DELETEing so an
     *  in-flight heartbeat tick can't 404 and re-register everything we're
     *  about to take down. The gen bump is a belt-and-braces extra check
     *  inside the timer callback.
     */
    public async stop(){
        if(!this.running) return;
        if(this.heartbeatTimer){
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.running = false;
        this.gen++;
        this.setStatus({ target: "", state: "off", error: "", devices: 0, senders: 0 });
        let api = NmosNodeApi.instance;
        // Where they were posted — settings may already point elsewhere.
        let url = this.registeredAt;
        this.registeredAt = "";
        if(!api || !url){ this.clearIds(); return; }
        let resources = api.getResources();
        // What is published now and what was published last: a sender
        // removed in the same save as the switch-off is still registered.
        for(let s of resources.senders) this.lastSenderIds.add(s.id);
        for(let f of resources.flows)   this.lastFlowIds.add(f.id);
        for(let s of resources.sources) this.lastSourceIds.add(s.id);
        for(let d of resources.devices) this.lastDeviceIds.add(d.id);

        try{
            await this.deregisterAt(url, true, resources.node?.id);
            SyncLog.log("info", "NMOS Node Registration", "Deregistered virtual Node + resources from registry.");
        }catch(e:any){
            // Most likely the registry is already gone — that's fine, the
            // resources expire on their own without a heartbeat anyway.
            SyncLog.log("verbose", "NMOS Node Registration", "Cleanup DELETE on tear-down: " + (e?.message || e));
        }
        this.clearIds();
    }


    private async postResource(url:string, type:string, data:any){
        let resp = await axios.post(url + "/resource", { type, data }, { timeout: 4000 });
        if(resp.status !== 200 && resp.status !== 201){
            throw new Error("Unexpected status " + resp.status + " on POST /resource type=" + type);
        }
    }

    private async deleteResource(url:string, plural:string, id:string){
        try{
            await axios.delete(url + "/resource/" + plural + "/" + id, { timeout: 4000 });
        }catch(e:any){
            // 404 == not there, that's fine.
            if(e?.response?.status !== 404){
                throw e;
            }
        }
    }


    private scheduleHeartbeat(myGen:number){
        let tickCount = 0;
        if(this.heartbeatTimer){ clearInterval(this.heartbeatTimer); }
        this.heartbeatTimer = setInterval(async () => {
            if(myGen !== this.gen) return;
            let api = NmosNodeApi.instance;
            let url = this.apiBase();
            if(!api) return;
            let node = api.getNode();
            if(!node) return;
            // Another target (the registry was switched or discovered,
            // or none any more): move there instead of a heartbeat.
            if(url !== this.registeredAt){
                this.syncResources().catch(()=>{});
                return;
            }
            if(!url) return;

            tickCount++;
            let triggeredResync = false;

            try{
                await axios.post(url + "/health/nodes/" + node.id, undefined, { timeout: 4000 });
                // Reachable again after a failed heartbeat: the registry
                // still holds the Node (else this would have been a 404).
                if(this.heartbeatFailed && myGen === this.gen){
                    this.heartbeatFailed = false;
                    this.setStatus({ state: "registered", error: "" });
                }
            }catch(e:any){
                if(myGen !== this.gen) return;  // stop() raced us — drop it
                if(e?.response?.status !== 404){
                    this.heartbeatFailed = true;
                    this.setStatus({ target: url, state: "error", error: NmosNodeRegistration.describe(e) });
                }
                if(e?.response?.status === 404){
                    // Registry forgot the node entirely (restart,
                    // garbage-collect …). Re-publish everything from
                    // scratch — syncResources() itself rechecks this.gen so
                    // a stop() landing between the 404 and the POSTs still
                    // wins.
                    SyncLog.log("warn", "NMOS Node Registration", "Heartbeat returned 404 — re-registering.");
                    this.syncResources().catch(()=>{});
                    triggeredResync = true;
                }
                // Any other error: just try again next tick.
            }

            // Safety re-sync. Without this, if /health/nodes returns 200
            // (node is healthy) but the registry has lost or never
            // received one of our dependent resources (device, source,
            // flow, sender — happens when a partial registration was
            // interrupted, or the registry garbage-collected stale
            // resources), we would never notice. POSTs are idempotent, so
            // running syncResources every safetyResyncEveryNTicks ticks is
            // cheap and self-healing.
            if(!triggeredResync && tickCount % this.safetyResyncEveryNTicks === 0){
                SyncLog.log("verbose", "NMOS Node Registration", "Periodic safety re-sync of all resources.");
                this.syncResources().catch(()=>{});
            }
        }, this.heartbeatMs);
    }
}
