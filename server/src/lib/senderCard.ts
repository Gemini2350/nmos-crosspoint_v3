/*
 * The info card a sender shows on hover in the Crosspoint matrix: what it
 * sends, where to, who takes it, and how it is doing. Every sender gets the
 * same card; a sender with a BCP-008 monitor shows the device's health in
 * the state line, one without says that nothing monitors it -- a missing
 * state must not read as "healthy".
 *
 * Pure: the crosspoint enrichment collects the facts, this composes the
 * text, so the UI only renders.
 */

import { bitrateMbps, formatRate, FlowBitrate } from "./bandwidth";

export type SenderCardTone = "on" | "off" | "ok" | "warn" | "err";

export interface SenderCardRow {
    k: string;                                  // "" continues the row above
    v: string;
    tone?: "dim" | "warn" | "err" | "mono";
}

export interface SenderCard {
    state: string;
    tone: SenderCardTone;
    rows: SenderCardRow[];
}

export interface SenderCardLeg {
    index: number;
    dstIp: string;
    dstPort: string | number;
    srcIp: string;
    dup?: boolean;
    dupText?: string;
}

export interface SenderCardInput {
    available: boolean;
    active: boolean;
    transport: string;                          // transportFamily(): rtp, mxl, websocket, mqtt, ""
    format: string;
    codec: string;
    bitrate: FlowBitrate;
    manifestOk: boolean;
    legs: SenderCardLeg[];
    mxl?: { domainId: string, flowId: string } | null;
    is07?: { tag: string, host: string } | null;
    receivers: string[];                        // labels of the receivers taking it now
    bcp008Enabled: boolean;
    monitor?: { status: number, message: string } | null;
}

/** How many receivers are named before "+ N more". */
export const CARD_RECEIVERS = 4;

const STATE_NAMES = ["Inactive", "Healthy", "Partially healthy", "Unhealthy"];
const STATE_TONES: SenderCardTone[] = ["off", "ok", "warn", "err"];

/** The matrix is a quick glance: the BT709 / SDR defaults are dropped
 *  (non-default colorimetry stays), the Details page keeps the full string. */
export function shortFormat(format: string): string {
    return ("" + (format || "")).replace(" BT709", "").replace(" SDR", "").trim();
}

function rateText(bitrate: FlowBitrate): string {
    const mbps = bitrateMbps(bitrate);
    if (mbps === null) return "";
    const max = !!bitrate && typeof bitrate === "object" && bitrate.hint === "max";
    return (max ? "≤ " : "") + formatRate(mbps);
}

function legText(l: SenderCardLeg): string {
    if (!l.dstIp) return "not set";
    return l.dstIp + (l.dstPort !== "" && l.dstPort !== null && l.dstPort !== undefined ? ":" + l.dstPort : "") + (l.srcIp ? " ← " + l.srcIp : "");
}

function isMulticast(ip: string): boolean {
    const first = parseInt(("" + ip).split(".")[0], 10);
    return (first >= 224 && first <= 239) || /^ff/i.test("" + ip);
}

export function senderCard(i: SenderCardInput): SenderCard {
    const rows: SenderCardRow[] = [];

    let state: string, tone: SenderCardTone;
    const monitored = i.bcp008Enabled && !!i.monitor && typeof i.monitor.status === "number";
    if (!i.available) { state = "Unavailable"; tone = "off"; }
    else if (monitored) {
        const s = Math.max(0, Math.min(3, i.monitor!.status | 0));
        state = STATE_NAMES[s]; tone = STATE_TONES[s];
    }
    else { state = i.active ? "Active" : "Inactive"; tone = i.active ? "on" : "off"; }

    const media = [shortFormat(i.format), i.codec, rateText(i.bitrate)].filter((x) => !!x);
    if (media.length > 0) rows.push({ k: "Format", v: media.join(" · ") });

    if (i.transport === "mxl") {
        rows.push({ k: "MXL flow", v: i.mxl?.flowId || "—", tone: "mono" });
        rows.push({ k: "Domain", v: i.mxl?.domainId || "—", tone: "mono" });
    } else if (i.transport === "websocket" || i.transport === "mqtt") {
        rows.push({ k: "Events", v: i.is07 ? i.is07.tag + " " + i.is07.host : "endpoint not read", tone: i.is07 ? "mono" : "dim" });
    } else if (i.legs.length > 0) {
        const one = i.legs.length === 1;
        for (const l of i.legs) {
            const k = one ? (l.dstIp && !isMulticast(l.dstIp) ? "Unicast" : "Multicast") : "Leg " + (l.index + 1);
            rows.push({ k, v: legText(l), tone: "mono" });
        }
        for (const l of i.legs) {
            if (l.dup) rows.push({ k: "Duplicate", v: l.dstIp + " also sent by " + (l.dupText || "another active sender"), tone: "warn" });
        }
    }
    if (i.available && !i.manifestOk && (i.transport === "rtp" || i.transport === "")) {
        rows.push({ k: "SDP", v: "not readable", tone: "warn" });
    }

    if (i.available) {
        if (i.receivers.length === 0) rows.push({ k: "Receivers", v: "none", tone: "dim" });
        const shown = i.receivers.length > CARD_RECEIVERS ? CARD_RECEIVERS - 1 : CARD_RECEIVERS;
        i.receivers.slice(0, shown).forEach((r, n) => rows.push({ k: n === 0 ? "Receivers" : "", v: r }));
        if (i.receivers.length > shown) rows.push({ k: "", v: "+ " + (i.receivers.length - shown) + " more", tone: "dim" });
    }

    if (i.available && i.bcp008Enabled) {
        if (!monitored) rows.push({ k: "Health", v: "not monitored (no BCP-008)", tone: "dim" });
        else if (i.monitor!.status >= 2 && i.monitor!.message) {
            rows.push({ k: "Message", v: i.monitor!.message, tone: i.monitor!.status === 3 ? "err" : "warn" });
        }
    }

    return { state, tone, rows };
}
