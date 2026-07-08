/*
 * NMOS Crosspoint — Generic DDNS Service (RFC 2136 Dynamic Updates)
 *
 * Pushes NMOS node names (or user aliases) as A records into any DNS server
 * that accepts standard RFC 2136 UPDATE messages, authenticated with a TSIG
 * key (RFC 8945) or — keyAlgorithm "none" — unsigned, for servers that
 * authorise updates by source IP (BIND allow-update { <ip>; };). Works with
 * BIND9, Knot DNS, PowerDNS, Microsoft DNS, and others.
 * This replaces the earlier pfSense/Unbound-specific pfRest integration —
 * no vendor API, just the DNS protocol itself.
 *
 * Each push is a single atomic UPDATE: "delete A RRset for <name>, add
 * <name> <ttl> IN A <ip>" — replace semantics, idempotent. Renames delete
 * the old FQDN in the same message.
 *
 * Ownership: RFC 2136 has no way to tag or enumerate "our" records (the
 * pfRest version used description tags for that), so the service keeps its
 * own inventory of pushed entries in ./state/ddnsPushed.json. That file is
 * what allows removing a node's record after a server restart.
 *
 * Pushes are debounced (2 s) so a burst of NMOS updates produces one UPDATE
 * message per node rather than dozens.
 *
 * Transport is TCP (like `nsupdate -v`) — universally supported for
 * updates and avoids UDP truncation/retry handling.
 */

import * as net from "net";
import * as crypto from "crypto";
import { SyncLog } from "./syncLog";

const fs = require("fs");

export interface DdnsSettings {
    enabled: boolean;
    server: string;        // authoritative DNS server (IP or hostname)
    port: number;          // 53
    zone: string;          // zone the records live in, e.g. "media.example.net"
    ttl: number;           // record TTL in seconds
    keyName: string;       // TSIG key name
    keySecret: string;     // TSIG shared secret, base64
    keyAlgorithm: string;  // hmac-sha256 | hmac-sha512 | hmac-sha1 | hmac-md5
}

interface PendingNode {
    nodeId: string;
    displayName: string;
    ip: string;
}

interface PushedEntry {
    nodeId: string;
    host: string;
    domain: string;   // = zone (field name kept for UI compatibility)
    ip: string;
    ts: string;
}

const PUSHED_STATE_PATH = "./state/ddnsPushed.json";

// TSIG algorithm registry: config value → { wire name, node crypto digest }.
// hmac-md5 has a special historic wire name (RFC 8945 §6).
const TSIG_ALGORITHMS: { [k: string]: { wire: string, digest: string } } = {
    "hmac-sha256": { wire: "hmac-sha256",              digest: "sha256" },
    "hmac-sha512": { wire: "hmac-sha512",              digest: "sha512" },
    "hmac-sha1":   { wire: "hmac-sha1",                digest: "sha1"   },
    "hmac-md5":    { wire: "hmac-md5.sig-alg.reg.int", digest: "md5"    },
};

const RCODE_NAMES: { [k: number]: string } = {
    0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP",
    5: "REFUSED", 6: "YXDOMAIN", 7: "YXRRSET", 8: "NXRRSET", 9: "NOTAUTH",
    10: "NOTZONE",
};

export class DdnsService {
    private static _instance: DdnsService | null = null;
    public static get instance(): DdnsService | null { return this._instance; }

    private settings: DdnsSettings = {
        enabled: false, server: "", port: 53, zone: "",
        ttl: 300, keyName: "", keySecret: "", keyAlgorithm: "hmac-sha256"
    };

    // Pending pushes — coalesced over the debounce window.
    private pending: Map<string, PendingNode> = new Map();
    private debounceTimer: any = null;

    // Inventory of records we own, keyed by nodeId. Persisted so a restart
    // can still remove records for forgotten devices (RFC 2136 offers no
    // server-side way to list "our" records).
    private lastPushed: Map<string, PushedEntry> = new Map();

    private onChange: (() => void) | null = null;
    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    private notifyChange() {
        if (this.onChange) {
            try { this.onChange(); } catch { /* swallow */ }
        }
    }
    getPushedEntries(): PushedEntry[] {
        return Array.from(this.lastPushed.values()).sort((a, b) => a.host.localeCompare(b.host));
    }

    constructor() {
        DdnsService._instance = this;
        this.loadPushedState();
    }

    setSettings(s: any) {
        if (!s || typeof s !== "object") return;
        this.settings = {
            enabled:      !!s.enabled,
            server:       typeof s.server === "string" ? s.server.trim() : "",
            port:         (typeof s.port === "number" && s.port > 0 && s.port < 65536) ? s.port : 53,
            zone:         typeof s.zone === "string" ? s.zone.trim().replace(/\.+$/, "") : "",
            ttl:          (typeof s.ttl === "number" && s.ttl > 0) ? s.ttl : 300,
            keyName:      typeof s.keyName === "string" ? s.keyName.trim().replace(/\.+$/, "") : "",
            keySecret:    typeof s.keySecret === "string" ? s.keySecret.trim() : "",
            // "none" = unsigned updates (server authorises by source IP).
            keyAlgorithm: s.keyAlgorithm === "none" ? "none"
                          : (TSIG_ALGORITHMS[s.keyAlgorithm] ? s.keyAlgorithm : "hmac-sha256"),
        };
    }

    /** Unsigned mode: plain RFC 2136 without a TSIG record. */
    private get unsigned(): boolean {
        return this.settings.keyAlgorithm === "none";
    }

    isEnabled(): boolean {
        if (!this.settings.enabled || !this.settings.server || !this.settings.zone) return false;
        if (this.unsigned) return true;
        return !!this.settings.keyName && !!this.settings.keySecret;
    }


    // ----- Persistence of the ownership inventory -----

    private loadPushedState() {
        try {
            const raw = fs.readFileSync(PUSHED_STATE_PATH);
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                for (const e of arr) {
                    if (e && typeof e.nodeId === "string" && typeof e.host === "string") {
                        this.lastPushed.set(e.nodeId, e);
                    }
                }
            }
        } catch (e) { /* first run — file doesn't exist yet */ }
    }

    private savePushedState() {
        try {
            fs.writeFileSync(PUSHED_STATE_PATH, JSON.stringify(this.getPushedEntries(), null, 2));
        } catch (e: any) {
            SyncLog.log("warn", "DDNS", "Could not persist " + PUSHED_STATE_PATH + ": " + (e?.message || e));
        }
    }


    // ----- Push pipeline (same outward shape as the old DNS Push service) -----

    /** Schedule a push for a single node; bursts coalesce via debounce. */
    scheduleNodePush(nodeId: string, displayName: string, ip: string) {
        if (!this.isEnabled()) return;
        if (!nodeId || !displayName || !ip) return;
        this.pending.set(nodeId, { nodeId, displayName, ip });
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            const batch = Array.from(this.pending.values());
            this.pending.clear();
            this.flush(batch).catch(e => SyncLog.log("error", "DDNS", "Flush failed: " + (e?.message || e)));
        }, 2000);
    }

    private async flush(batch: PendingNode[]) {
        if (!this.isEnabled() || batch.length === 0) return;
        const zone = this.settings.zone;
        let changed = false;

        for (const node of batch) {
            const host = this.sanitiseHost(node.displayName);
            if (!host) continue;
            const fqdn = host + "." + zone;
            const prev = this.lastPushed.get(node.nodeId);

            // Nothing to do when name + IP are unchanged.
            if (prev && prev.host === host && prev.ip === node.ip) continue;

            const ops: UpdateOp[] = [];
            // Rename: remove the old FQDN's A RRset in the same atomic update.
            if (prev && prev.host !== host) {
                ops.push({ kind: "deleteRRset", name: prev.host + "." + zone });
            }
            // Replace semantics for the current FQDN.
            ops.push({ kind: "deleteRRset", name: fqdn });
            ops.push({ kind: "addA", name: fqdn, ttl: this.settings.ttl, ip: node.ip });

            try {
                await this.sendUpdate(ops);
                SyncLog.log("info", "DDNS", `Updated ${fqdn} → ${node.ip}` + (prev && prev.host !== host ? ` (renamed from ${prev.host}.${zone})` : ""));
                this.lastPushed.set(node.nodeId, { nodeId: node.nodeId, host, domain: zone, ip: node.ip, ts: new Date().toISOString() });
                changed = true;
            } catch (e: any) {
                SyncLog.log("error", "DDNS", `Update failed for ${fqdn}: ` + (e?.message || e));
            }
        }

        if (changed) {
            this.savePushedState();
            this.notifyChange();
        }
    }

    /** Remove the DNS record for a single node (device forgotten). */
    async removeNode(nodeId: string) {
        if (!nodeId) return;
        const prev = this.lastPushed.get(nodeId);
        if (!prev) {
            SyncLog.log("info", "DDNS", "No DNS record to remove for nodeId=" + nodeId);
            return;
        }
        if (!this.settings.server) return;                                   // can't reach the server
        if (!this.unsigned && !this.settings.keySecret) return;             // can't sign the update
        const fqdn = prev.host + "." + (prev.domain || this.settings.zone);
        try {
            await this.sendUpdate([{ kind: "deleteRRset", name: fqdn }]);
            SyncLog.log("info", "DDNS", `Removed DNS record ${fqdn}`);
            this.lastPushed.delete(nodeId);
            this.savePushedState();
            this.notifyChange();
        } catch (e: any) {
            SyncLog.log("error", "DDNS", `Remove failed for ${fqdn}: ` + (e?.message || e));
        }
    }

    /** Push every passed node now (feature just enabled / settings changed). */
    async syncAll(nodes: PendingNode[]) {
        if (!this.isEnabled()) return;
        if (nodes.length === 0) return;
        await this.flush(nodes);
    }

    private sanitiseHost(name: string): string {
        if (!name) return "";
        return ("" + name)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 63);
    }


    // ----- RFC 2136 UPDATE + RFC 8945 TSIG (hand-encoded wire format) -----
    //
    // An UPDATE message is small and fixed-shape, so we encode it directly
    // rather than pulling in a DNS library:
    //   Header | Zone section (zone SOA IN) | Update RRs | TSIG RR
    // The TSIG MAC is an HMAC over the message as it looks WITHOUT the TSIG
    // record (ARCOUNT excludes it), followed by the TSIG "variables".

    private async sendUpdate(ops: UpdateOp[]) {
        // Unsigned mode ("none"): send the bare UPDATE without a TSIG RR —
        // the server is expected to authorise by source address.
        const signing = !this.unsigned;
        const alg = TSIG_ALGORITHMS[this.settings.keyAlgorithm] || TSIG_ALGORITHMS["hmac-sha256"];
        let secret = Buffer.alloc(0);
        if (signing) {
            secret = Buffer.from(this.settings.keySecret, "base64");
            if (secret.length === 0) throw new Error("TSIG secret is not valid base64");
        }

        const id = crypto.randomBytes(2).readUInt16BE(0);

        // --- message without TSIG ---
        const parts: Buffer[] = [];
        const header = Buffer.alloc(12);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(5 << 11, 2);         // opcode UPDATE, all flags 0
        header.writeUInt16BE(1, 4);                // ZOCOUNT
        header.writeUInt16BE(0, 6);                // PRCOUNT
        header.writeUInt16BE(ops.length, 8);       // UPCOUNT
        header.writeUInt16BE(0, 10);               // ADCOUNT (TSIG not counted for MAC)
        parts.push(header);

        // Zone section: <zone> SOA IN
        parts.push(encodeName(this.settings.zone));
        parts.push(u16(6), u16(1));                // TYPE SOA, CLASS IN

        for (const op of ops) {
            if (op.kind === "addA") {
                const ipBytes = ipv4ToBytes(op.ip);
                if (!ipBytes) throw new Error("not an IPv4 address: " + op.ip);
                parts.push(encodeName(op.name));
                parts.push(u16(1), u16(1));        // TYPE A, CLASS IN
                parts.push(u32(op.ttl));
                parts.push(u16(4), ipBytes);
            } else {
                // Delete RRset: CLASS ANY, TTL 0, empty RDATA
                parts.push(encodeName(op.name));
                parts.push(u16(1), u16(255));      // TYPE A, CLASS ANY
                parts.push(u32(0));
                parts.push(u16(0));
            }
        }
        const unsigned = Buffer.concat(parts);
        let message = unsigned;

        if (signing) {
            // --- TSIG MAC (RFC 8945 §4.3.3): HMAC(message + TSIG variables) ---
            const timeSigned = Math.floor(Date.now() / 1000);
            const fudge = 300;
            const keyNameWire = encodeName(this.settings.keyName.toLowerCase());
            const algWire = encodeName(alg.wire);

            const tsigVars = Buffer.concat([
                keyNameWire,
                u16(255),                              // CLASS ANY
                u32(0),                                // TTL 0
                algWire,
                u48(timeSigned),
                u16(fudge),
                u16(0),                                // Error
                u16(0),                                // Other Len
            ]);
            const mac = crypto.createHmac(alg.digest, secret)
                .update(Buffer.concat([unsigned, tsigVars]))
                .digest();

            // --- append TSIG RR, bump ARCOUNT ---
            const rdata = Buffer.concat([
                algWire,
                u48(timeSigned),
                u16(fudge),
                u16(mac.length), mac,
                u16(id),                               // Original ID
                u16(0),                                // Error
                u16(0),                                // Other Len
            ]);
            const tsigRR = Buffer.concat([
                keyNameWire,
                u16(250),                              // TYPE TSIG
                u16(255),                              // CLASS ANY
                u32(0),                                // TTL
                u16(rdata.length), rdata,
            ]);
            message = Buffer.concat([unsigned, tsigRR]);
            message.writeUInt16BE(1, 10);              // ADCOUNT = 1 (TSIG)
        }

        const response = await this.sendTcp(message);
        if (response.length < 12) throw new Error("short DNS response");
        if (response.readUInt16BE(0) !== id) throw new Error("DNS response ID mismatch");
        const rcode = response[3] & 0x0f;
        if (rcode !== 0) {
            throw new Error("server returned " + (RCODE_NAMES[rcode] || ("RCODE " + rcode)) +
                (rcode === 9 ? " (TSIG key name/secret/algorithm wrong?)" : "") +
                (rcode === 5 ? (signing ? " (zone not allowing updates with this key?)"
                                        : " (zone not allowing unsigned updates from this address?)") : ""));
        }
    }

    /** DNS-over-TCP round trip: 2-byte length prefix, single message each way. */
    private sendTcp(message: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const sock = new net.Socket();
            const chunks: Buffer[] = [];
            let done = false;
            const finish = (err: Error | null, data?: Buffer) => {
                if (done) return;
                done = true;
                try { sock.destroy(); } catch (e) {}
                if (err) reject(err); else resolve(data!);
            };
            sock.setTimeout(5000, () => finish(new Error("timeout talking to " + this.settings.server + ":" + this.settings.port)));
            sock.on("error", (e) => finish(e));
            sock.on("data", (d) => {
                chunks.push(d);
                const buf = Buffer.concat(chunks);
                if (buf.length >= 2) {
                    const len = buf.readUInt16BE(0);
                    if (buf.length >= 2 + len) finish(null, buf.subarray(2, 2 + len));
                }
            });
            sock.connect(this.settings.port, this.settings.server, () => {
                const framed = Buffer.alloc(2 + message.length);
                framed.writeUInt16BE(message.length, 0);
                message.copy(framed, 2);
                sock.write(framed);
            });
        });
    }
}

type UpdateOp =
    | { kind: "addA", name: string, ttl: number, ip: string }
    | { kind: "deleteRRset", name: string };

// ----- wire-format helpers -----

function encodeName(name: string): Buffer {
    const labels = ("" + name).replace(/\.+$/, "").split(".").filter(l => l.length > 0);
    const parts: Buffer[] = [];
    for (const label of labels) {
        const b = Buffer.from(label, "ascii");
        if (b.length > 63) throw new Error("DNS label too long: " + label);
        parts.push(Buffer.from([b.length]), b);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

function u16(v: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; }
function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function u48(v: number): Buffer {
    const b = Buffer.alloc(6);
    b.writeUInt16BE(Math.floor(v / 0x100000000) & 0xffff, 0);
    b.writeUInt32BE(v % 0x100000000, 2);
    return b;
}

function ipv4ToBytes(ip: string): Buffer | null {
    const parts = ("" + ip).split(".");
    if (parts.length !== 4) return null;
    const bytes = parts.map(p => parseInt(p, 10));
    if (bytes.some(x => isNaN(x) || x < 0 || x > 255)) return null;
    return Buffer.from(bytes);
}
