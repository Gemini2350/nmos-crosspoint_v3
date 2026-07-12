/*
 * NMOS Crosspoint — BCP-008 Status Monitoring (IS-12 / MS-05-02 client)
 *
 * Implements the controller side of AMWA BCP-008-01 (Receiver Status) and
 * BCP-008-02 (Sender Status): for every NMOS device that advertises an
 * IS-12 control endpoint (urn:x-nmos:control:ncp/v1.0) we open the NCP
 * WebSocket, walk the device model from the root block (oid 1, fixed by
 * MS-05-02), and pick out every NcStatusMonitor descendant:
 *
 *   NcStatusMonitor    classId [1,2,2]
 *   NcReceiverMonitor  classId [1,2,2,1]   (BCP-008-01)
 *   NcSenderMonitor    classId [1,2,2,2]   (BCP-008-02)
 *
 * Each monitor's NcObject.touchpoints (property 1p7) names the IS-04
 * sender/receiver it watches; overallStatus (3p1) is the worst-of-all
 * rollup the spec requires the DEVICE to compute — exactly what the UI
 * wants to show, so we never re-derive it ourselves:
 *
 *   0 Inactive · 1 Healthy · 2 PartiallyHealthy · 3 Unhealthy
 *
 * Live updates come via IS-12 subscriptions (PropertyChanged events on the
 * monitor oids) after one initial read at connect time — no periodic
 * polling. Connections reconcile against the registry state: new ncp
 * devices get a connection, vanished devices are torn down and their
 * statuses dropped.
 *
 * The service is read-only on the network (Get + subscribe, never Set).
 */

import * as WebSocket from "ws";
import { SyncLog } from "./syncLog";

export interface MonitorStatus {
    status: number;        // NcOverallStatus 0..3 (see above)
    message: string;       // overallStatusMessage ("" when the device sends none)
    kind: "sender" | "receiver";
    deviceId: string;      // owning NMOS device (for teardown bookkeeping)
    // The four BCP-008 status domains. `s` is the current state (same 0..3
    // scale; link uses AllUp=1 / SomeDown=2 / AllDown=3), `c` the status
    // transition counter (how often it degraded since the last reset — a
    // non-zero counter does NOT mean the CURRENT state is bad). Keys:
    //   link   → linkStatus (4p1, counter 4p3)
    //   path   → connectionStatus (rx) / transmissionStatus (tx)  (4p4, 4p6)
    //   sync   → externalSynchronizationStatus (4p7, 4p9)
    //   payload→ streamStatus (rx) / essenceStatus (tx)  (4p11, 4p13)
    // A key is absent when the device doesn't implement that property.
    domains: { link?: DomainVal, path?: DomainVal, sync?: DomainVal, payload?: DomainVal };
}

export interface DomainVal { s: number; c: number; }

// IS-12 message types
const MT_COMMAND = 0;
const MT_COMMAND_RESPONSE = 1;
const MT_NOTIFICATION = 2;
const MT_SUBSCRIPTION = 3;

// MS-05-02 ids used here
const ROOT_BLOCK_OID = 1;
const METHOD_GET = { level: 1, index: 1 };                 // NcObject.Get(id)
const METHOD_GET_MEMBERS = { level: 2, index: 1 };         // NcBlock.GetMemberDescriptors(recurse)
const PROP_TOUCHPOINTS = { level: 1, index: 7 };           // NcObject.touchpoints (1p6 is userLabel!)
const PROP_OVERALL_STATUS = { level: 3, index: 1 };        // NcStatusMonitor.overallStatus
const PROP_OVERALL_STATUS_MESSAGE = { level: 3, index: 2 };// NcStatusMonitor.overallStatusMessage

// The four status domains, identical property layout on NcReceiverMonitor
// and NcSenderMonitor (only the semantics of 4p4/4p11 differ). Verified
// against the AMWA reference mock device (nmos-device-control-mock).
const DOMAIN_PROPS: Array<{ key: "link"|"path"|"sync"|"payload", id: { level: number, index: number }, counterId: { level: number, index: number } }> = [
    { key: "link",    id: { level: 4, index: 1 },  counterId: { level: 4, index: 3 } },
    { key: "path",    id: { level: 4, index: 4 },  counterId: { level: 4, index: 6 } },
    { key: "sync",    id: { level: 4, index: 7 },  counterId: { level: 4, index: 9 } },
    { key: "payload", id: { level: 4, index: 11 }, counterId: { level: 4, index: 13 } },
];
// ResetCountersAndMessages lives at DIFFERENT method ids on the two
// monitor classes (verified against the AMWA mock): the receiver monitor
// has two Get methods before it (4m3), the sender monitor only one (4m2).
const METHOD_RESET_RECEIVER = { level: 4, index: 3 };
const METHOD_RESET_SENDER   = { level: 4, index: 2 };

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const COMMAND_TIMEOUT_MS = 8000;

function classIdIsStatusMonitor(classId: any): boolean {
    return Array.isArray(classId) && classId.length >= 3
        && classId[0] === 1 && classId[1] === 2 && classId[2] === 2;
}

// MS-05-02 NcMethodStatus uses HTTP-like codes: 200 Ok, 298/299 deprecation
// warnings (value still valid), 4xx/5xx errors. Some early implementations
// answered 0 for Ok — accept both.
function statusOk(s: any): boolean {
    return s === 0 || (typeof s === "number" && s >= 200 && s < 300);
}

interface MonitorRef {
    oid: number;
    flowId: string;                 // IS-04 sender/receiver UUID from the touchpoint
    kind: "sender" | "receiver";
}

/** One IS-12 connection to one NMOS device. */
class DeviceMonitorConnection {
    private ws: any = null;
    private disposed = false;
    private backoff = RECONNECT_MIN_MS;
    private reconnectTimer: any = null;
    private handleSeq = 1;
    private pending: Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }> = new Map();
    private monitors: MonitorRef[] = [];
    private loggedNoMonitors = false;
    private loggedConnecting = false;

    constructor(
        public deviceId: string,
        public url: string,
        private onStatus: (flowId: string, st: MonitorStatus | null) => void,
    ) {
        this.connect();
    }

    dispose() {
        this.disposed = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.failAllPending(new Error("disposed"));
        try { if (this.ws) this.ws.close(); } catch (e) {}
        this.ws = null;
        // Drop every status this connection contributed.
        for (const m of this.monitors) { this.onStatus(m.flowId, null); }
        this.monitors = [];
    }

    private connect() {
        if (this.disposed) return;
        try {
            if (!this.loggedConnecting) {
                this.loggedConnecting = true;
                SyncLog.log("info", "BCP-008", "IS-12 control endpoint found — connecting to " + this.url);
            }
            const ws: any = new WebSocket(this.url, { handshakeTimeout: 5000 });
            this.ws = ws;
            ws.on("open", () => {
                this.backoff = RECONNECT_MIN_MS;
                SyncLog.log("verbose", "BCP-008", "Connected to " + this.url + " — discovering device model.");
                this.discover().catch((e: any) => {
                    SyncLog.log("verbose", "BCP-008", "Discovery failed on " + this.url + ": " + (e?.message || e));
                    try { ws.close(); } catch (err) {}
                });
            });
            ws.on("message", (data: any) => { this.onMessage(data); });
            ws.on("error", () => { /* close follows */ });
            ws.on("close", () => { this.onClosed(); });
        } catch (e: any) {
            this.onClosed();
        }
    }

    private onClosed() {
        if (this.disposed) return;
        this.failAllPending(new Error("connection closed"));
        this.ws = null;
        // Statuses are stale once the control connection is gone — drop them
        // rather than showing outdated health.
        for (const m of this.monitors) { this.onStatus(m.flowId, null); }
        this.monitors = [];
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    }

    private failAllPending(err: Error) {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            try { p.reject(err); } catch (e) {}
        }
        this.pending.clear();
    }

    // ----- IS-12 plumbing -----

    private send(obj: any) {
        try { this.ws?.send(JSON.stringify(obj)); } catch (e) {}
    }

    /** Send one command and await its response result. */
    private command(oid: number, methodId: { level: number, index: number }, args: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== 1) { reject(new Error("not connected")); return; }
            const handle = this.handleSeq++;
            const timer = setTimeout(() => {
                this.pending.delete(handle);
                reject(new Error("IS-12 command timeout"));
            }, COMMAND_TIMEOUT_MS);
            this.pending.set(handle, { resolve, reject, timer });
            this.send({
                messageType: MT_COMMAND,
                commands: [{ handle, oid, methodId, arguments: args }]
            });
        });
    }

    private getProperty(oid: number, propertyId: { level: number, index: number }): Promise<any> {
        return this.command(oid, METHOD_GET, { id: propertyId }).then((result: any) => {
            if (!result || !statusOk(result.status)) {
                throw new Error("Get failed (status " + result?.status +
                    (result?.errorMessage ? " — " + result.errorMessage : "") + ")");
            }
            return result.value;
        });
    }

    private onMessage(data: any) {
        let msg: any;
        try { msg = JSON.parse("" + data); } catch (e) { return; }
        if (!msg || typeof msg.messageType !== "number") return;

        if (msg.messageType === MT_COMMAND_RESPONSE && Array.isArray(msg.responses)) {
            for (const r of msg.responses) {
                // Some devices echo the handle as a string — normalise.
                const handle = Number(r?.handle);
                const p = this.pending.get(handle);
                if (!p) continue;
                this.pending.delete(handle);
                clearTimeout(p.timer);
                p.resolve(r.result);
            }
            return;
        }

        if (msg.messageType === MT_NOTIFICATION && Array.isArray(msg.notifications)) {
            for (const n of msg.notifications) {
                this.onNotification(n);
            }
            return;
        }

        // messageType 5 = protocol error from the device — surface it, these
        // are gold when debugging vendor quirks.
        if (msg.messageType === 5) {
            SyncLog.log("verbose", "BCP-008", "IS-12 error message from " + this.url + ": " + ("" + data).substring(0, 300));
        }
    }

    private onNotification(n: any) {
        // Only PropertyChanged (eventId 1e1) on our monitor oids is relevant.
        const mon = this.monitors.find(m => m.oid === n?.oid);
        if (!mon || !n?.eventData?.propertyId) return;
        const pid = n.eventData.propertyId;
        if (pid.level === PROP_OVERALL_STATUS.level && pid.index === PROP_OVERALL_STATUS.index) {
            this.publish(mon, { status: Number(n.eventData.value) | 0 });
            return;
        }
        if (pid.level === PROP_OVERALL_STATUS_MESSAGE.level && pid.index === PROP_OVERALL_STATUS_MESSAGE.index) {
            this.publish(mon, { message: "" + (n.eventData.value ?? "") });
            return;
        }
        for (const dp of DOMAIN_PROPS) {
            if (pid.level === dp.id.level && pid.index === dp.id.index) {
                this.publish(mon, { domain: { key: dp.key, s: Number(n.eventData.value) | 0 } });
                return;
            }
            if (pid.level === dp.counterId.level && pid.index === dp.counterId.index) {
                this.publish(mon, { domain: { key: dp.key, c: Number(n.eventData.value) | 0 } });
                return;
            }
        }
    }

    // Cache the last published values per oid so partial updates (a status
    // change without a new message, a single domain flip) merge instead of
    // clobbering the rest.
    private lastByOid: Map<number, { status: number, message: string, domains: any }> = new Map();
    private publish(mon: MonitorRef, patch: { status?: number, message?: string, domain?: { key: string, s?: number, c?: number } }) {
        const prev = this.lastByOid.get(mon.oid) || { status: 1, message: "", domains: {} };
        const next = {
            status: (patch.status === undefined) ? prev.status : patch.status,
            message: (patch.message === undefined) ? prev.message : patch.message,
            domains: { ...prev.domains },
        };
        if (patch.domain) {
            const d = { ...(next.domains[patch.domain.key] || { s: 1, c: 0 }) };
            if (patch.domain.s !== undefined) d.s = patch.domain.s;
            if (patch.domain.c !== undefined) d.c = patch.domain.c;
            next.domains[patch.domain.key] = d;
        }
        this.lastByOid.set(mon.oid, next);
        SyncLog.log("verbose", "BCP-008", mon.kind + " " + mon.flowId + " → status " + next.status +
            (next.message ? " (" + next.message + ")" : ""));
        this.onStatus(mon.flowId, {
            status: next.status,
            message: next.message,
            kind: mon.kind,
            deviceId: this.deviceId,
            domains: next.domains,
        });
    }

    // ----- discovery + initial read -----

    private async discover() {
        const membersResult: any = await this.command(ROOT_BLOCK_OID, METHOD_GET_MEMBERS, { recurse: true });
        if (!membersResult || !statusOk(membersResult.status) || !Array.isArray(membersResult.value)) {
            throw new Error("GetMemberDescriptors failed (status " + membersResult?.status +
                (membersResult?.errorMessage ? " — " + membersResult.errorMessage : "") +
                (membersResult && statusOk(membersResult.status) && !Array.isArray(membersResult.value) ? ", value is not an array" : "") + ")");
        }
        const monitorDescs = membersResult.value.filter((d: any) => classIdIsStatusMonitor(d?.classId));
        if (monitorDescs.length === 0) {
            // Device speaks IS-12 but exposes no NcStatusMonitors — say so
            // ONCE (info), otherwise this case is indistinguishable from
            // "nothing happening" in the logs.
            if (!this.loggedNoMonitors) {
                this.loggedNoMonitors = true;
                SyncLog.log("info", "BCP-008", "Connected to " + this.url + " — device model has " + membersResult.value.length + " members but no BCP-008 status monitors (classId 1.2.2.x).");
            }
            this.monitors = [];
            return;
        }

        SyncLog.log("verbose", "BCP-008", "Found " + monitorDescs.length + " status monitor(s) on " + this.url + " — resolving touchpoints.");

        const found: MonitorRef[] = [];
        let tpSample = "";
        for (const d of monitorDescs) {
            try {
                const tps: any = await this.getProperty(d.oid, PROP_TOUCHPOINTS);
                if (!tpSample) { try { tpSample = JSON.stringify(tps).substring(0, 300); } catch (e) {} }
                if (!Array.isArray(tps)) continue;
                for (const tp of tps) {
                    const res = tp?.resource;
                    if (!res || typeof res.id !== "string") continue;
                    // Spec says singular ("receiver"/"sender"), but be lenient
                    // with implementations using the IS-04 plural form.
                    const rt = ("" + res.resourceType).replace(/s$/, "");
                    if (rt === "receiver" || rt === "sender") {
                        found.push({ oid: d.oid, flowId: res.id, kind: rt });
                        break;
                    }
                }
            } catch (e: any) {
                SyncLog.log("verbose", "BCP-008", "Touchpoint read failed for oid " + d.oid + " on " + this.url + ": " + (e?.message || e));
            }
        }
        this.monitors = found;
        if (found.length === 0) {
            // Monitors exist but none maps to an IS-04 sender/receiver —
            // without that mapping the matrix has nothing to attach to.
            SyncLog.log("info", "BCP-008", monitorDescs.length + " status monitor(s) on " + this.url +
                " but none exposed a usable IS-04 touchpoint. Sample touchpoints value: " + (tpSample || "(none)"));
            return;
        }

        // Subscribe first, then do ONE initial read — no gap where a change
        // could slip by. From here on the subscription notifications carry
        // every update; no periodic re-poll needed.
        this.send({ messageType: MT_SUBSCRIPTION, subscriptions: found.map(m => m.oid) });
        await this.pollAll();
        SyncLog.log("info", "BCP-008", "Monitoring " + found.length + " sender/receiver monitors via " + this.url);
    }

    private async pollAll() {
        for (const m of this.monitors) {
            try {
                const status = await this.getProperty(m.oid, PROP_OVERALL_STATUS);
                let message = "";
                try { message = "" + ((await this.getProperty(m.oid, PROP_OVERALL_STATUS_MESSAGE)) ?? ""); } catch (e) {}
                // Domain statuses + transition counters — each individually
                // optional (PropertyNotImplemented is fine).
                const domains: any = {};
                for (const dp of DOMAIN_PROPS) {
                    try {
                        const v = await this.getProperty(m.oid, dp.id);
                        if (v === null || v === undefined) continue;
                        let c = 0;
                        try { c = Number(await this.getProperty(m.oid, dp.counterId)) | 0; } catch (e) {}
                        domains[dp.key] = { s: Number(v) | 0, c };
                    } catch (e) { /* domain not implemented */ }
                }
                this.lastByOid.set(m.oid, { status: Number(status) | 0, message, domains });
                this.publish(m, { status: Number(status) | 0 });
            } catch (e) { /* keep last known */ }
        }
    }

    /** Invoke ResetCountersAndMessages (4m3) on the monitor watching the
     *  given IS-04 flow. Returns false when this connection has no monitor
     *  for it. Counters/messages are re-read afterwards. */
    async resetFor(flowId: string): Promise<boolean> {
        const mon = this.monitors.find(m => m.flowId === flowId);
        if (!mon) return false;
        const resetId = mon.kind === "sender" ? METHOD_RESET_SENDER : METHOD_RESET_RECEIVER;
        const result = await this.command(mon.oid, resetId, {});
        if (!statusOk(result?.status)) {
            throw new Error("ResetCountersAndMessages failed (status " + result?.status +
                (result?.errorMessage ? " — " + result.errorMessage : "") + ")");
        }
        SyncLog.log("info", "BCP-008", "Counters/messages reset for " + mon.kind + " " + flowId);
        await this.pollAll();
        return true;
    }
}

export class Bcp008Monitor {
    public static instance: Bcp008Monitor;

    private conns: Map<string, DeviceMonitorConnection> = new Map();   // deviceId → connection
    private statusByFlow: { [flowId: string]: MonitorStatus } = {};
    private changeTimer: any = null;
    private enabled = true;
    private lastNmosState: any = null;

    /** Fired (debounced) whenever any status changed — the crosspoint
     *  abstraction hooks this to re-publish its enriched state. */
    public onChange: (() => void) | null = null;

    constructor() {
        Bcp008Monitor.instance = this;
    }

    /** Status for one IS-04 sender/receiver UUID, or null. */
    getStatus(flowId: string): MonitorStatus | null {
        return this.statusByFlow[flowId] || null;
    }

    /** Reset the transition counters + messages for one flow's monitor. */
    async resetCounters(flowId: string): Promise<boolean> {
        for (const conn of Array.from(this.conns.values())) {
            if (await conn.resetFor(flowId)) return true;
        }
        return false;
    }

    /** Master switch (Setup page). Disabling tears every connection down
     *  and clears all statuses; re-enabling reconnects immediately from the
     *  last known registry state. */
    setEnabled(v: boolean) {
        if (this.enabled === v) return;
        this.enabled = v;
        if (!v) {
            SyncLog.log("info", "BCP-008", "Status monitoring disabled in Setup — closing all control connections.");
            for (const conn of Array.from(this.conns.values())) { conn.dispose(); }
            this.conns.clear();
            this.statusByFlow = {};
            try { if (this.onChange) this.onChange(); } catch (e) {}
        } else {
            SyncLog.log("info", "BCP-008", "Status monitoring enabled.");
            if (this.lastNmosState) { this.updateFromNmos(this.lastNmosState); }
        }
    }
    isEnabled(): boolean { return this.enabled; }

    /** Reconcile connections against the current registry state. */
    updateFromNmos(state: any) {
        this.lastNmosState = state;
        if (!this.enabled) return;
        const wanted: Map<string, string> = new Map();   // deviceId → ncp url
        try {
            const devices = state?.devices || {};
            for (const devId in devices) {
                const controls = devices[devId]?.controls;
                if (!Array.isArray(controls)) continue;
                for (const c of controls) {
                    if (typeof c?.type === "string" && c.type.startsWith("urn:x-nmos:control:ncp/")
                        && typeof c?.href === "string" && c.href.startsWith("ws")) {
                        wanted.set(devId, c.href);
                        break;
                    }
                }
            }
        } catch (e) { return; }

        // Drop connections whose device vanished or whose endpoint moved.
        for (const [devId, conn] of Array.from(this.conns.entries())) {
            const url = wanted.get(devId);
            if (!url || url !== conn.url) {
                conn.dispose();
                this.conns.delete(devId);
            }
        }
        // Open connections for new devices.
        for (const [devId, url] of wanted.entries()) {
            if (this.conns.has(devId)) continue;
            this.conns.set(devId, new DeviceMonitorConnection(devId, url, (flowId, st) => {
                this.applyStatus(flowId, st);
            }));
        }
    }

    private applyStatus(flowId: string, st: MonitorStatus | null) {
        const prev = this.statusByFlow[flowId];
        if (st === null) {
            if (!prev) return;
            delete this.statusByFlow[flowId];
        } else {
            // Compare EVERYTHING including domains + counters. Devices often
            // notify overallStatus first and the domain/counter properties
            // right after — comparing only status+message dropped those
            // follow-ups and the UI lagged one transition behind.
            if (prev && prev.status === st.status && prev.message === st.message
                && JSON.stringify(prev.domains) === JSON.stringify(st.domains)) return;
            this.statusByFlow[flowId] = st;
        }
        // Short debounce: folds a notification burst (one transition emits
        // up to ~10 property changes) into one crosspoint re-publish without
        // adding noticeable latency.
        if (this.changeTimer) return;
        this.changeTimer = setTimeout(() => {
            this.changeTimer = null;
            try { if (this.onChange) this.onChange(); } catch (e) {}
        }, 250);
    }
}
