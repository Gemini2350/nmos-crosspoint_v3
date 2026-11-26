/*
 * Total bandwidth of a device and of a node: what its active streams put on
 * each network. Pure helpers, so the rules can be tested without a registry.
 *
 * Every stream counts on the legs it is enabled on, leg by leg: with
 * ST 2022-7 each leg is its own network (its own link, its own NIC), so the
 * number that matters for a link is the load per leg. A stream whose bitrate
 * is not known is counted as a stream but adds nothing; the label then says
 * "≥". Bitrates are in Mbit/s, as the crosspoint computes them per leg.
 */

import { transportFamily } from "./transport";

/** A flow's bitrate as the crosspoint state carries it. */
export type FlowBitrate = { v: number, hint: string } | number | null | undefined;

/** The running total for one direction (sending or receiving). */
export interface BandwidthSum {
    legs: number[];      // Mbit/s per leg index (0 = leg 1)
    streams: number;     // streams counted, known or not
    unknown: number;     // of those, without a known bitrate (added nothing)
    estimated: number;   // of those, at an estimated maximum (JPEG XS, ANC)
}

/** What the Details page shows for one direction. */
export interface BandwidthView {
    label: string;       // "2 × 2.21 Gbit/s", "≥ 9.9 Mbit/s", "2.21 + 1.10 Gbit/s"
    tooltip: string;     // one line per fact, "\n"-separated
    legs: number[];
    streams: number;
    unknown: number;
}

export interface Bandwidth { tx: BandwidthView | null; rx: BandwidthView | null; }

export function emptySum(): BandwidthSum {
    return { legs: [], streams: 0, unknown: 0, estimated: 0 };
}

/** Mbit/s, or null when the bitrate is not known. */
export function bitrateMbps(b: FlowBitrate): number | null {
    if (typeof b === "number") return Number.isFinite(b) && b > 0 ? b : null;
    if (!b || typeof b !== "object") return null;
    if (b.hint === "unknown") return null;
    const v = Number(b.v);
    return Number.isFinite(v) && v > 0 ? v : null;
}

/** Whether a flow is a media stream on the network: RTP, or a transport not
 *  known (counted rather than hidden). MXL stays in shared memory; IS-07
 *  events over WebSocket or MQTT are no media streams. */
export function onTheNetwork(transport: string | null | undefined): boolean {
    const f = transportFamily(transport);
    return f === "rtp" || f === "";
}

/**
 * The legs a stream is enabled on, from its IS-05 /active transport_params
 * (rtp_enabled false = that leg is off). Without them (its Connection API
 * not read), all of its legs: what its SDP or IS-04 interface_bindings
 * give, at least one. Empty when every leg is switched off.
 */
export function enabledLegs(transportParams: any, legCount: number): number[] {
    if (Array.isArray(transportParams) && transportParams.length > 0) {
        const out: number[] = [];
        transportParams.forEach((tp: any, i: number) => { if (tp?.rtp_enabled !== false) out.push(i); });
        return out;
    }
    const n = Math.max(1, Math.floor(legCount) || 0);
    return Array.from({ length: n }, (_, i) => i);
}

/** Add one stream on the given legs. Nothing on the wire = not counted. */
export function addStream(sum: BandwidthSum, bitrate: FlowBitrate, legs: number[]): void {
    if (legs.length === 0) return;
    sum.streams++;
    const v = bitrateMbps(bitrate);
    if (v === null) { sum.unknown++; return; }
    if (bitrate && typeof bitrate === "object" && bitrate.hint === "max") sum.estimated++;
    for (const i of legs) {
        while (sum.legs.length <= i) sum.legs.push(0);
        sum.legs[i] += v;
    }
}

/** Add a stream whose bitrate is not known (a receiver taking from a sender
 *  the registry does not have). */
export function addUnknown(sum: BandwidthSum): void {
    sum.streams++;
    sum.unknown++;
}

export function mergeSums(a: BandwidthSum, b: BandwidthSum): BandwidthSum {
    const legs: number[] = [];
    for (let i = 0; i < Math.max(a.legs.length, b.legs.length); i++) legs.push((a.legs[i] || 0) + (b.legs[i] || 0));
    return {
        legs,
        streams: a.streams + b.streams,
        unknown: a.unknown + b.unknown,
        estimated: a.estimated + b.estimated,
    };
}

/** "< 1 Mbit/s", "9.9 Mbit/s", "2.21 Gbit/s" (as the flows show theirs). */
export function formatRate(mbps: number): string {
    if (mbps >= 1000) return (mbps / 1000).toFixed(2) + " Gbit/s";
    const r = Math.round(mbps * 10) / 10;
    if (r < 1) return "< 1 Mbit/s";
    return r.toFixed(1) + " Mbit/s";
}

// Equal within rounding: the legs of a 2022-7 device carry the same streams.
function allEqual(legs: number[]): boolean {
    return legs.every((v) => Math.abs(v - legs[0]) < 0.05);
}

/**
 * The view for one direction, or null when there is nothing to show: no
 * stream, or none with a known bitrate.
 */
export function bandwidthView(sum: BandwidthSum, dir: "tx" | "rx"): BandwidthView | null {
    // Legs that carry nothing known (a leg only an unknown stream is on)
    // still count as a leg; a trailing run of zero legs does not exist.
    const legs = sum.legs.slice();
    if (sum.streams === 0 || legs.length === 0 || legs.every((v) => v <= 0)) return null;

    const pre = sum.unknown > 0 ? "≥ " : "";
    let label: string;
    if (legs.length === 1) {
        label = formatRate(legs[0]);
    } else if (allEqual(legs)) {
        label = legs.length + " × " + formatRate(legs[0]);
    } else {
        const giga = Math.max(...legs) >= 1000;
        label = legs.map((v) => giga ? (v / 1000).toFixed(2) : formatRate(v).replace(" Mbit/s", "")).join(" + ")
            + (giga ? " Gbit/s" : " Mbit/s");
    }

    const what = dir === "tx" ? "active sender" : "active receiver";
    const lines: string[] = [];
    lines.push((dir === "tx" ? "Sending" : "Receiving") + ", " + sum.streams + " " + what + (sum.streams === 1 ? "" : "s"));
    legs.forEach((v, i) => lines.push("Leg " + (i + 1) + ": " + formatRate(v)));
    if (legs.length === 2) lines.push("Both networks: " + formatRate(legs[0] + legs[1]));
    if (legs.length > 2) lines.push("All networks: " + formatRate(legs.reduce((a, b) => a + b, 0)));
    if (sum.unknown > 0) lines.push(sum.unknown + " with unknown bitrate, not counted");
    if (sum.estimated > 0) lines.push(sum.estimated + " counted at an estimated maximum");

    return { label: pre + label, tooltip: lines.join("\n"), legs, streams: sum.streams, unknown: sum.unknown };
}

export function bandwidthOf(tx: BandwidthSum, rx: BandwidthSum): Bandwidth {
    return { tx: bandwidthView(tx, "tx"), rx: bandwidthView(rx, "rx") };
}
