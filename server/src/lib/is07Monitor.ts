/*
 * NMOS Crosspoint — IS-07 Event & Tally monitor (read-only consumer)
 *
 * Reads the current value of every IS-07 sender so the Crosspoint and
 * Details pages can show it. Switched on in Setup (settings.eventMonitor).
 *
 *   WebSocket: one connection per connection_uri (a device's server usually
 *   carries all its sources), a "subscription" command listing the sources;
 *   the server answers with their current states and pushes every change.
 *   The client reports its health every 5 s -- the server drops a client
 *   silent for 12 s -- and treats a server silent for 12 s as gone.
 *
 *   MQTT: one connection per broker, subscribed to each sender's
 *   broker_topic (state messages are retained, so a late joiner gets the
 *   current one at once) and connection_status_broker_topic.
 *
 * Push only, nothing is polled. The Events API is read once per source for
 * its type definition (enum labels, unit); IS-07 meant it "for consumer late
 * joiners", not for "regular high intensity polling".
 *
 * A value whose connection is lost, whose sender announced a shutdown or
 * reboot, or whose MQTT connection status says inactive is kept but marked
 * stale, with the reason.
 */

import * as WebSocket from "ws";
import axios from "axios";
import { SyncLog } from "./syncLog";
import { deviceRequest } from "./deviceEndpoints";
import { joinHref } from "./nmosConnectionPatch";
import { eventTargets, parseEventMessage, taiTimestamp, formatEventValue, EventTargets, WsTarget, MqttTarget, EventDisplay } from "./is07Events";

const mqtt = require("mqtt");

const HEALTH_MS = 5000;
const SILENCE_MS = 12000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TYPE_RETRY_MS = 60000;

interface SourceValue {
    eventType: string,
    payload: any,
    // When the value last changed (ms), not when it was last repeated.
    since: number,
    // "" while live; otherwise why the value may be out of date.
    stale: string,
}

export interface SenderEventValue {
    display: EventDisplay,
    eventType: string,
    since: number,
    stale: string,
    // "WebSocket 10.0.0.5:8870" / "MQTT broker 10.0.0.9:1883"
    via: string,
}

export interface EventConnectionStatus {
    label: string,
    level: "success" | "warning" | "error",
    detail: string,
}

type StateSink = (sourceId: string, eventType: string, payload: any) => void;
type StaleSink = (sourceIds: string[], reason: string) => void;

function hostOf(url: string): string {
    try { return new URL(url).host; } catch (e) { return url; }
}

/** One WebSocket server and the sources subscribed on it. */
class WsEventConnection {
    private ws: any = null;
    private disposed = false;
    private backoff = RECONNECT_MIN_MS;
    private reconnectTimer: any = null;
    private healthTimer: any = null;
    private lastHeard = 0;
    private sources: string[] = [];
    public state: "connecting" | "connected" | "down" = "connecting";
    public lastError = "";

    constructor(public readonly uri: string, sources: string[], private onState: StateSink, private onStale: StaleSink, private onStatus: () => void) {
        this.sources = sources.slice().sort();
        this.connect();
    }

    get label(): string { return "WebSocket " + hostOf(this.uri); }
    get sourceCount(): number { return this.sources.length; }

    setSources(sources: string[]) {
        const next = sources.slice().sort();
        if (next.join(",") === this.sources.join(",")) return;
        this.sources = next;
        // IS-07: a new subscription command replaces the list; the server
        // sends the current state of every source in it again.
        this.subscribe();
    }

    private subscribe() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ command: "subscription", sources: this.sources })); } catch (e) {}
        }
    }

    private connect() {
        if (this.disposed) return;
        this.state = "connecting";
        let ws: any;
        try {
            ws = new WebSocket(this.uri, { handshakeTimeout: 5000 });
        } catch (e: any) {
            this.lastError = e?.message || "" + e;
            this.closed();
            return;
        }
        this.ws = ws;
        ws.on("open", () => {
            if (this.disposed) { try { ws.close(); } catch (e) {} return; }
            this.backoff = RECONNECT_MIN_MS;
            this.state = "connected";
            this.lastError = "";
            this.lastHeard = Date.now();
            this.subscribe();
            this.startHealth();
            this.onStatus();
        });
        ws.on("message", (data: any) => {
            this.lastHeard = Date.now();
            const m = parseEventMessage(data);
            if (m && m.type === "state") { this.onState(m.sourceId, m.eventType, m.payload); }
        });
        ws.on("error", (e: any) => { this.lastError = e?.message || e?.code || "error"; });
        ws.on("close", () => { if (this.ws === ws) { this.closed(); } });
    }

    private startHealth() {
        this.stopHealth();
        this.healthTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            // The server answers a health command within 5 s; heard nothing
            // for 12 s, it is taken as gone, the same rule it applies to us.
            if (Date.now() - this.lastHeard > SILENCE_MS) {
                this.lastError = "no answer for " + Math.round(SILENCE_MS / 1000) + " s";
                try { ws.terminate(); } catch (e) {}
                return;
            }
            try { ws.send(JSON.stringify({ command: "health", timestamp: taiTimestamp() })); } catch (e) {}
        }, HEALTH_MS);
    }

    private stopHealth() {
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    }

    private closed() {
        this.stopHealth();
        this.ws = null;
        if (this.disposed) return;
        const wasUp = this.state === "connected";
        this.state = "down";
        this.onStale(this.sources, "connection to " + hostOf(this.uri) + " lost");
        if (wasUp) { SyncLog.log("warning", "IS-07", "Event WebSocket closed: " + this.uri + (this.lastError ? " (" + this.lastError + ")" : "")); }
        this.onStatus();
        if (this.reconnectTimer) return;
        const delay = this.backoff;
        this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    }

    dispose() {
        this.disposed = true;
        this.stopHealth();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            // The last source leaving: IS-07 recommends closing the socket.
            try { ws.close(); } catch (e) {}
        }
    }
}

/** One MQTT broker and the topics read from it. */
class MqttEventConnection {
    private client: any = null;
    private topics: { [topic: string]: string } = {};          // broker_topic → sourceId
    private statusTopics: { [topic: string]: string[] } = {};  // status topic → sourceIds
    public state: "connecting" | "connected" | "down" = "connecting";
    public lastError = "";
    private disposed = false;

    constructor(private target: MqttTarget, private onState: StateSink, private onStale: StaleSink, private onLive: (sourceIds: string[]) => void, private onStatus: () => void) {
        this.applyTarget(target);
        this.client = mqtt.connect(target.url, {
            clientId: "nmos-crosspoint-" + Math.random().toString(16).slice(2, 10),
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 5000,
        });
        this.client.on("connect", () => {
            this.state = "connected";
            this.lastError = "";
            this.subscribeAll();
            this.onStatus();
        });
        this.client.on("message", (topic: string, payload: any) => this.onMessage(topic, payload));
        this.client.on("error", (e: any) => { this.lastError = e?.message || e?.code || "error"; });
        this.client.on("close", () => {
            if (this.disposed) return;
            const wasUp = this.state === "connected";
            this.state = "down";
            this.onStale(Object.values(this.topics), "connection to broker " + this.hostPort + " lost");
            if (wasUp) { SyncLog.log("warning", "IS-07", "MQTT broker connection lost: " + this.target.url + (this.lastError ? " (" + this.lastError + ")" : "")); }
            this.onStatus();
        });
    }

    get hostPort(): string { return hostOf(this.target.url); }
    get label(): string { return "MQTT broker " + this.hostPort; }
    get sourceCount(): number { return new Set(Object.values(this.topics)).size; }

    private applyTarget(target: MqttTarget) {
        this.target = target;
        this.topics = {};
        for (const t of Object.keys(target.topics)) { this.topics[t] = target.topics[t].sourceId; }
        this.statusTopics = {};
        for (const t of Object.keys(target.statusTopics)) {
            const senders = target.statusTopics[t];
            const sources = Object.values(target.topics).filter((r) => r.senderIds.some((id) => senders.includes(id))).map((r) => r.sourceId);
            this.statusTopics[t] = Array.from(new Set(sources));
        }
    }

    private allTopics(): string[] {
        return Array.from(new Set([...Object.keys(this.topics), ...Object.keys(this.statusTopics)]));
    }

    private subscribeAll() {
        const list = this.allTopics();
        if (list.length > 0 && this.client?.connected) { this.client.subscribe(list, { qos: 1 }); }
    }

    setTarget(target: MqttTarget) {
        const before = this.allTopics();
        this.applyTarget(target);
        const after = this.allTopics();
        if (!this.client?.connected) return;
        const gone = before.filter((t) => !after.includes(t));
        const added = after.filter((t) => !before.includes(t));
        if (gone.length > 0) { this.client.unsubscribe(gone); }
        if (added.length > 0) { this.client.subscribe(added, { qos: 1 }); }
    }

    private onMessage(topic: string, payload: any) {
        const m = parseEventMessage(payload);
        if (!m) return;
        if (this.topics[topic] !== undefined) {
            const sourceId = this.topics[topic];
            if (m.type === "state") {
                this.onState(m.sourceId || sourceId, m.eventType, m.payload);
            } else if (m.type === "shutdown" || m.type === "reboot") {
                this.onStale([sourceId], "sender announced " + m.type);
            }
        }
        if (this.statusTopics[topic] && m.type === "connection_status") {
            if (m.active) { this.onLive(this.statusTopics[topic]); }
            else { this.onStale(this.statusTopics[topic], "sender offline (MQTT connection status)"); }
        }
    }

    dispose() {
        this.disposed = true;
        try { this.client?.end(true); } catch (e) {}
        this.client = null;
    }
}

export class Is07Monitor {
    public static instance: Is07Monitor;

    private enabled = false;
    private lastNmosState: any = null;
    private targets: EventTargets = { ws: [], mqtt: [], skipped: [], off: [] };
    private ws: Map<string, WsEventConnection> = new Map();
    private mq: Map<string, MqttEventConnection> = new Map();
    private values: Map<string, SourceValue> = new Map();
    // sender id → its source and the connection that reads it
    private senders: Map<string, { sourceId: string, via: string }> = new Map();
    private typeDefs: Map<string, any> = new Map();
    private typeTried: Map<string, number> = new Map();
    private changeTimer: any = null;

    /** Fired (debounced) whenever a value or a connection changed. */
    public onChange: (() => void) | null = null;

    constructor() {
        Is07Monitor.instance = this;
    }

    isEnabled(): boolean { return this.enabled; }

    /** Master switch (Setup page). Off closes every connection and forgets
     *  every value; on connects from the last known registry state. */
    setEnabled(v: boolean) {
        if (this.enabled === v) return;
        this.enabled = v;
        if (!v) {
            SyncLog.log("info", "IS-07", "Event & Tally monitor switched off — closing its connections.");
            for (const c of Array.from(this.ws.values())) { c.dispose(); }
            for (const c of Array.from(this.mq.values())) { c.dispose(); }
            this.ws.clear();
            this.mq.clear();
            this.values.clear();
            this.senders.clear();
            this.targets = { ws: [], mqtt: [], skipped: [], off: [] };
            this.changed();
        } else {
            SyncLog.log("info", "IS-07", "Event & Tally monitor switched on.");
            if (this.lastNmosState) { this.updateFromNmos(this.lastNmosState); }
        }
    }

    /** Reconcile connections against the registry and the senders' /active. */
    updateFromNmos(state: any) {
        this.lastNmosState = state;
        if (!this.enabled) return;
        let t: EventTargets;
        try { t = eventTargets(state); } catch (e) { return; }
        const before = JSON.stringify(this.targets);
        this.targets = t;

        const wanted = new Set<string>();
        const senders: Map<string, { sourceId: string, via: string }> = new Map();
        for (const w of t.ws) {
            for (const s of w.sources) { wanted.add(s.sourceId); for (const id of s.senderIds) senders.set(id, { sourceId: s.sourceId, via: "WebSocket " + hostOf(w.uri) }); }
            const ids = w.sources.map((s) => s.sourceId);
            const c = this.ws.get(w.key);
            if (c) { c.setSources(ids); }
            else {
                this.ws.set(w.key, new WsEventConnection(w.uri, ids,
                    (sid, et, p) => this.applyState(sid, et, p), (sids, why) => this.markStale(sids, why), () => this.changed()));
            }
        }
        for (const [key, c] of Array.from(this.ws.entries())) {
            if (!t.ws.some((w) => w.key === key)) { c.dispose(); this.ws.delete(key); }
        }
        for (const m of t.mqtt) {
            for (const r of Object.values(m.topics)) { wanted.add(r.sourceId); for (const id of r.senderIds) senders.set(id, { sourceId: r.sourceId, via: "MQTT broker " + hostOf(m.url) }); }
            const c = this.mq.get(m.key);
            if (c) { c.setTarget(m); }
            else {
                this.mq.set(m.key, new MqttEventConnection(m,
                    (sid, et, p) => this.applyState(sid, et, p), (sids, why) => this.markStale(sids, why),
                    (sids) => this.markLive(sids), () => this.changed()));
            }
        }
        for (const [key, c] of Array.from(this.mq.entries())) {
            if (!t.mqtt.some((m) => m.key === key)) { c.dispose(); this.mq.delete(key); }
        }
        this.senders = senders;
        for (const sid of Array.from(this.values.keys())) { if (!wanted.has(sid)) this.values.delete(sid); }

        // Type definitions, once per source (retried after a minute at the
        // earliest, and only when the registry changes anyway).
        const rest: { [sid: string]: string } = {};
        for (const w of t.ws) for (const s of w.sources) if (s.restUrl) rest[s.sourceId] = s.restUrl;
        for (const m of t.mqtt) for (const r of Object.values(m.topics)) if (r.restUrl) rest[r.sourceId] = r.restUrl;
        for (const sid of Object.keys(rest)) {
            if (this.typeDefs.has(sid)) continue;
            const tried = this.typeTried.get(sid) || 0;
            if (Date.now() - tried < TYPE_RETRY_MS) continue;
            this.typeTried.set(sid, Date.now());
            axios.get(joinHref(rest[sid], "type"), deviceRequest(5000)).then((r: any) => {
                if (r && r.data && typeof r.data === "object") { this.typeDefs.set(sid, r.data); this.changed(); }
            }).catch((e: any) => {
                SyncLog.log("debug", "IS-07", "No type definition for source " + sid + ": " + (e?.message || e?.code));
            });
        }
        if (JSON.stringify(this.targets) !== before) { this.changed(); }
    }

    private applyState(sourceId: string, eventType: string, payload: any) {
        if (!this.enabled) return;
        const prev = this.values.get(sourceId);
        const same = prev && JSON.stringify(prev.payload) === JSON.stringify(payload) && prev.eventType === eventType;
        if (same && prev && prev.stale === "") return;
        this.values.set(sourceId, { eventType, payload, since: same && prev ? prev.since : Date.now(), stale: "" });
        this.changed();
    }

    private markStale(sourceIds: string[], reason: string) {
        let any = false;
        for (const sid of sourceIds) {
            const v = this.values.get(sid);
            if (v && v.stale !== reason) { v.stale = reason; any = true; }
        }
        if (any) this.changed();
    }

    /** MQTT connection status active again: only the status-based mark is
     *  lifted, a fresh state message lifts the others. */
    private markLive(sourceIds: string[]) {
        let any = false;
        for (const sid of sourceIds) {
            const v = this.values.get(sid);
            if (v && v.stale === "sender offline (MQTT connection status)") { v.stale = ""; any = true; }
        }
        if (any) this.changed();
    }

    private changed() {
        if (this.changeTimer) return;
        this.changeTimer = setTimeout(() => {
            this.changeTimer = null;
            try { if (this.onChange) this.onChange(); } catch (e) {}
        }, 250);
    }

    /** The current value of one IS-07 sender, null when none was read. */
    senderValue(senderId: string, flowEventType: string = ""): SenderEventValue | null {
        if (!this.enabled) return null;
        const ref = this.senders.get(senderId);
        if (!ref) return null;
        const v = this.values.get(ref.sourceId);
        if (!v) return null;
        const eventType = v.eventType || flowEventType;
        return {
            display: formatEventValue(eventType, v.payload, this.typeDefs.get(ref.sourceId) || null),
            eventType,
            since: v.since,
            stale: v.stale,
            via: ref.via,
        };
    }

    /** Whether a sender's source has a value that is not stale. */
    isLive(senderId: string): boolean {
        const ref = this.senders.get(senderId);
        const v = ref ? this.values.get(ref.sourceId) : null;
        return !!v && v.stale === "";
    }

    /** One row per WebSocket server and broker, for the Setup page. */
    connections(): EventConnectionStatus[] {
        const out: EventConnectionStatus[] = [];
        const row = (c: { label: string, state: string, lastError: string, sourceCount: number }) => {
            const n = c.sourceCount + (c.sourceCount === 1 ? " source" : " sources");
            const level = c.state === "connected" ? "success" : c.state === "connecting" ? "warning" : "error";
            const what = c.state === "connected" ? "connected" : c.state === "connecting" ? "connecting" : ("not reachable" + (c.lastError ? " (" + c.lastError + ")" : ""));
            out.push({ label: c.label, level, detail: n + " · " + what });
        };
        for (const c of Array.from(this.ws.values())) row(c);
        for (const c of Array.from(this.mq.values())) row(c);
        return out.sort((a, b) => a.label.localeCompare(b.label));
    }

    /** Senders switched off and senders that cannot be read, with why. */
    notRead(): { off: string[], skipped: { senderId: string, reason: string }[] } {
        return { off: this.targets.off.slice(), skipped: this.targets.skipped.slice() };
    }

    /** Distinct sources read, and how many of them are live. */
    counts(): { live: number, total: number } {
        const all = new Set<string>();
        for (const ref of Array.from(this.senders.values())) all.add(ref.sourceId);
        let live = 0;
        for (const sid of Array.from(all)) { const v = this.values.get(sid); if (v && v.stale === "") live++; }
        return { live, total: all.size + this.targets.off.length + this.targets.skipped.length };
    }
}
