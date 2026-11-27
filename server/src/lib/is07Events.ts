/*
 * Pure helpers for reading IS-07 (Event & Tally) senders: which WebSocket
 * servers and MQTT brokers to connect to, what their messages say, and how a
 * value reads on screen. No I/O, so the rules can be tested on registry JSON
 * and message samples alone. The connections live in is07Monitor.ts.
 */

import { joinHref, transportKind } from "./nmosConnectionPatch";

/** One source a connection reads, and the senders that publish it. */
export interface EventSourceRef {
    sourceId: string,
    senderIds: string[],
    // Events API href of the source (".../sources/{id}/"), "" when unknown.
    restUrl: string,
}

export interface WsTarget {
    kind: "websocket",
    key: string,              // the connection_uri
    uri: string,
    sources: EventSourceRef[],
}

export interface MqttTarget {
    kind: "mqtt",
    key: string,              // protocol://host:port
    url: string,
    host: string,
    port: number,
    secure: boolean,
    // broker_topic → the source published on it
    topics: { [topic: string]: EventSourceRef },
    // connection_status_broker_topic → the senders it speaks for
    statusTopics: { [topic: string]: string[] },
}

/** A sender that is not read, and why (shown on the Setup page). */
export interface SkippedSender {
    senderId: string,
    reason: string,
}

export interface EventTargets {
    ws: WsTarget[],
    mqtt: MqttTarget[],
    skipped: SkippedSender[],
    // IS-07 senders switched off (IS-05 master_enable false): nothing to read.
    off: string[],
}

function resolved(v: any): boolean {
    return v !== undefined && v !== null && v !== "" && v !== "auto";
}

/**
 * The WebSocket servers and MQTT brokers to connect to, from the registry and
 * the senders' IS-05 /active. A sender switched off (IS-05 master_enable
 * false) publishes nothing and is left out. One WebSocket server commonly
 * serves every source of a device, so senders are grouped by connection_uri
 * (one connection, one subscription list); MQTT senders by broker.
 *
 * Senders that need authorization (IS-10 tokens) are skipped with a reason:
 * the crosspoint holds no token for them.
 */
export function eventTargets(state: any): EventTargets {
    const out: EventTargets = { ws: [], mqtt: [], skipped: [], off: [] };
    const ws: { [key: string]: WsTarget } = {};
    const mq: { [key: string]: MqttTarget } = {};
    const senders = state?.senders || {};
    for (const id of Object.keys(senders)) {
        const sender = senders[id];
        const kind = transportKind(sender?.transport);
        if (kind !== "websocket" && kind !== "mqtt") continue;
        const active = state?.senderActiveData?.[id];
        if (!active) { out.skipped.push({ senderId: id, reason: "IS-05 not read" }); continue; }
        if (active.master_enable === false) { out.off.push(id); continue; }
        const tp = active.transport_params?.[0] || {};
        const flow = state?.flows?.[sender.flow_id];
        const sourceId = resolved(tp.ext_is_07_source_id) ? "" + tp.ext_is_07_source_id : (flow?.source_id ? "" + flow.source_id : "");
        if (!sourceId) { out.skipped.push({ senderId: id, reason: "no source" }); continue; }
        let restUrl = resolved(tp.ext_is_07_rest_api_url) ? "" + tp.ext_is_07_rest_api_url : "";
        if (!restUrl) {
            const ctl = (state?.devices?.[sender.device_id]?.controls || [])
                .find((c: any) => typeof c?.type === "string" && c.type.startsWith("urn:x-nmos:control:events") && typeof c.href === "string");
            if (ctl) { restUrl = joinHref(ctl.href, "sources/" + sourceId + "/"); }
        }
        if (kind === "websocket") {
            const uri = resolved(tp.connection_uri) ? "" + tp.connection_uri : "";
            if (!/^wss?:\/\//i.test(uri)) { out.skipped.push({ senderId: id, reason: "no WebSocket address" }); continue; }
            if (tp.connection_authorization === true) { out.skipped.push({ senderId: id, reason: "needs authorization (IS-10)" }); continue; }
            const t = ws[uri] || (ws[uri] = { kind: "websocket", key: uri, uri, sources: [] });
            const ref = t.sources.find((s) => s.sourceId === sourceId);
            if (ref) { ref.senderIds.push(id); if (!ref.restUrl) ref.restUrl = restUrl; }
            else { t.sources.push({ sourceId, senderIds: [id], restUrl }); }
        } else {
            const host = resolved(tp.destination_host) ? "" + tp.destination_host : "";
            const topic = resolved(tp.broker_topic) ? "" + tp.broker_topic : "";
            if (!host || !topic) { out.skipped.push({ senderId: id, reason: "no broker or topic" }); continue; }
            if (tp.broker_authorization === true) { out.skipped.push({ senderId: id, reason: "needs authorization (IS-10)" }); continue; }
            const secure = tp.broker_protocol === "secure-mqtt";
            const port = Number(tp.destination_port) > 0 ? Number(tp.destination_port) : (secure ? 8883 : 1883);
            const hostPart = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
            const url = (secure ? "mqtts://" : "mqtt://") + hostPart + ":" + port;
            const t = mq[url] || (mq[url] = { kind: "mqtt", key: url, url, host, port, secure, topics: {}, statusTopics: {} });
            const ref = t.topics[topic];
            if (ref) { ref.senderIds.push(id); }
            else { t.topics[topic] = { sourceId, senderIds: [id], restUrl }; }
            if (resolved(tp.connection_status_broker_topic)) {
                const st = "" + tp.connection_status_broker_topic;
                (t.statusTopics[st] || (t.statusTopics[st] = [])).push(id);
            }
        }
    }
    out.ws = Object.values(ws).sort((a, b) => a.key.localeCompare(b.key));
    out.mqtt = Object.values(mq).sort((a, b) => a.key.localeCompare(b.key));
    return out;
}

/** What an IS-07 message is. */
export type EventMessage =
    { type: "state", sourceId: string, flowId: string, eventType: string, payload: any, created: string } |
    { type: "health" } |
    { type: "reboot" | "shutdown", sourceId: string } |
    { type: "connection_status", active: boolean } |
    { type: "other" };

/** Parses one message (a WebSocket frame or an MQTT payload). null when it
 *  is not JSON or not an object. */
export function parseEventMessage(text: any): EventMessage | null {
    let m: any;
    try { m = JSON.parse("" + text); } catch (e) { return null; }
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    switch (m.message_type) {
        case "state":
            if (typeof m.identity?.source_id !== "string" || !m.payload || typeof m.payload !== "object") return { type: "other" };
            return {
                type: "state",
                sourceId: m.identity.source_id,
                flowId: typeof m.identity.flow_id === "string" ? m.identity.flow_id : "",
                eventType: typeof m.event_type === "string" ? m.event_type : "",
                payload: m.payload,
                created: typeof m.timing?.creation_timestamp === "string" ? m.timing.creation_timestamp : "",
            };
        case "health": return { type: "health" };
        case "reboot":
        case "shutdown":
            return { type: m.message_type, sourceId: typeof m.identity?.source_id === "string" ? m.identity.source_id : "" };
        case "connection_status": return { type: "connection_status", active: m.active === true };
    }
    return { type: "other" };
}

/** An IS-07 timestamp ("<seconds>:<nanoseconds>") for now. IS-07 uses TAI;
 *  37 s is the TAI-UTC offset since 2017. */
export function taiTimestamp(nowMs: number = Date.now()): string {
    const ms = nowMs + 37000;
    return Math.floor(ms / 1000) + ":" + ((ms % 1000) * 1000000);
}

/** How a value reads: `kind` "on"/"off" for a boolean, "val" otherwise. */
export interface EventDisplay {
    text: string,
    kind: "on" | "off" | "val",
    // The line explaining it in the tooltip, e.g. "tx (2) – Studio condition is tx".
    detail: string,
}

function numberOf(v: any): number | null {
    if (typeof v === "number" && isFinite(v)) return v;
    if (v && typeof v === "object" && typeof v.value === "number") {
        const scale = (typeof v.scale === "number" && v.scale !== 0) ? v.scale : 1;
        return v.value / scale;
    }
    return null;
}

/** Decimals a scale implies: 10 → 1, 100 → 2; otherwise up to 3, trimmed. */
function formatNumber(v: number, scale: any): string {
    if (typeof scale === "number" && scale > 1) {
        const d = Math.log10(scale);
        if (Number.isInteger(d) && d <= 6) return v.toFixed(d);
    }
    if (Number.isInteger(v)) return "" + v;
    return ("" + parseFloat(v.toFixed(3)));
}

/** The unit of a measurement: the type definition's, else the last word of
 *  "number/<measure>/<unit>" (IS-07 measurement naming). */
export function eventUnit(eventType: string, typeDef: any): string {
    if (typeof typeDef?.unit === "string" && typeDef.unit) return typeDef.unit;
    const parts = ("" + (eventType || "")).split("/");
    if (parts[0] === "number" && parts.length === 3 && parts[1] !== "enum") return parts[2];
    return "";
}

/**
 * How a state reads on screen. An enum shows the label its type definition
 * gives the value (IS-07: label and description are mandatory per value); a
 * number is value / scale with its unit; a boolean is on or off.
 * @param typeDef the source's type from the Events API, null when not read
 */
export function formatEventValue(eventType: string, payload: any, typeDef: any): EventDisplay {
    const raw = payload ? payload.value : undefined;
    const base = ("" + (eventType || typeDef?.type || "")).split("/")[0];
    const values: any[] = Array.isArray(typeDef?.values) ? typeDef.values : [];
    const isBool = base === "boolean" || typeof raw === "boolean";
    let rawText: string;
    let num: number | null = null;
    if (base === "number" || typeof raw === "number") {
        num = numberOf(payload);
        rawText = num === null ? JSON.stringify(raw) : formatNumber(num, payload?.scale);
    } else if (typeof raw === "string") {
        rawText = raw;
    } else if (typeof raw === "boolean") {
        rawText = raw ? "true" : "false";
    } else {
        rawText = raw === undefined ? "–" : JSON.stringify(raw);
    }
    const kind: "on" | "off" | "val" = isBool ? (raw === true ? "on" : "off") : "val";
    if (values.length > 0) {
        const hit = values.find((e: any) => e && (e.value === raw || (num !== null && numberOf({ value: e.value, scale: payload?.scale }) === num)));
        if (hit && typeof hit.label === "string") {
            const desc = typeof hit.description === "string" && hit.description ? " – " + hit.description : "";
            return { text: hit.label, kind, detail: hit.label + " (" + rawText + ")" + desc };
        }
    }
    const unit = num !== null ? eventUnit(eventType, typeDef) : "";
    const text = rawText + (unit ? " " + unit : "");
    return { text, kind, detail: text };
}
