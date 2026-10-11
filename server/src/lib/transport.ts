/*
 * Pure helpers about transports: which family a sender or receiver belongs
 * to, whether two of them can be connected, whether one is ST 2022-7
 * redundant, and which sender a receiver is taking when it does not say.
 * Free of state and I/O so the rules can be tested on registry JSON alone.
 */

import { MxlEndpoint, resolvedMxlEndpoint } from "./nmosConnectionPatch";

export type TransportFamily = "rtp" | "mxl" | "websocket" | "mqtt" | "";

/** The family of an IS-04 transport, from its URN or from the short name the
 *  crosspoint keeps ("rtp", "rtp.mcast", "mxl"). All RTP variants are one
 *  family: an rtp.mcast receiver takes an rtp sender. "" = not known. */
export function transportFamily(transport: string | null | undefined): TransportFamily {
    let t = ("" + (transport || "")).trim().toLowerCase();
    if (t.startsWith("urn:x-nmos:transport:")) {
        t = t.substring("urn:x-nmos:transport:".length);
    }
    if (t === "rtp" || t.startsWith("rtp.")) return "rtp";
    if (t === "mxl") return "mxl";
    if (t === "websocket") return "websocket";
    if (t === "mqtt") return "mqtt";
    return "";
}

/** Two transports can be connected when they are the same family. An unknown
 *  side is not refused here: there is nothing to compare, and the device
 *  answers for itself. */
export function transportsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
    const fa = transportFamily(a);
    const fb = transportFamily(b);
    if (fa === "" || fb === "") return true;
    return fa === fb;
}

/** The crosspoint's own rule for a sender flow feeding a receiver flow: the
 *  same essence type and a compatible transport. */
export function flowsConnectable(dst: any, src: any): boolean {
    if (!dst || !src) return false;
    if (dst.type !== src.type) return false;
    return transportsCompatible(dst.capabilities?.transport, src.capabilities?.transport);
}

/** Legs a sender sends on. A sender switched off disables every leg it has,
 *  so then its configured legs count: it is still set up for two. */
function sendingLegs(transportParams: any): number {
    if (!Array.isArray(transportParams)) return 0;
    const enabled = transportParams.filter((tp: any) => tp && tp.rtp_enabled !== false).length;
    return enabled > 0 ? enabled : transportParams.length;
}

/**
 * ST 2022-7 on a sender: two legs. The IS-05 /active parameters say what is
 * on the wire and win; without them the SDP's `a=group:DUP` or its two media
 * sections, then two interface bindings.
 * @param sender IS-04 sender
 * @param active the sender's IS-05 /active, if read
 * @param sdp the sender's parsed SDP (sdp-transform), if read
 */
export function senderIsRedundant(sender: any, active?: any, sdp?: any): boolean {
    if (transportFamily(sender?.transport) !== "rtp") return false;
    if (active && Array.isArray(active.transport_params) && active.transport_params.length > 0) {
        return sendingLegs(active.transport_params) >= 2;
    }
    if (sdp) {
        if (Array.isArray(sdp.groups) && sdp.groups.some((g: any) => ("" + g?.type).toUpperCase() === "DUP")) return true;
        if (Array.isArray(sdp.media) && sdp.media.length >= 2) return true;
        if (Array.isArray(sdp.media) && sdp.media.length > 0) return false;
    }
    return Array.isArray(sender?.interface_bindings) && sender.interface_bindings.length >= 2;
}

/**
 * ST 2022-7 on a receiver: two legs to receive on. IS-05 gives a receiver one
 * set of parameters (and one entry in /constraints) per interface binding, so
 * the IS-04 bindings already say it; /active, when read, can only add to that.
 */
export function receiverIsRedundant(receiver: any, active?: any): boolean {
    if (transportFamily(receiver?.transport) !== "rtp") return false;
    const bindings = Array.isArray(receiver?.interface_bindings) ? receiver.interface_bindings.length : 0;
    const legs = (active && Array.isArray(active.transport_params)) ? active.transport_params.length : 0;
    return Math.max(bindings, legs) >= 2;
}

function sameAddress(a: any, b: any): boolean {
    return ("" + a).trim() === ("" + b).trim();
}

/**
 * The sender an RTP receiver takes, found by address.
 *
 * IS-04 `subscription.sender_id` and IS-05 `sender_id` are allowed to be null
 * while a receiver runs: a controller may connect by transport file alone, and
 * a device that lost its Connection API state reports what it joins but not
 * who asked. What the receiver joins is in its /active parameters, what a
 * sender sends to in its own. A receiver leg names a group, a port and
 * optionally a source; a sender leg that sends to the same group and port,
 * from that source when both name one, is a match.
 *
 * Returns the sender id matching the most legs, or "" when none does or when
 * two senders tie -- a guess would draw a connection that may not exist.
 *
 * @param receiverActive the receiver's IS-05 /active
 * @param senderActiveData IS-05 /active per sender id
 * @param senders IS-04 senders per id; a sender missing here is not a candidate
 */
export function matchSenderByAddress(receiverActive: any, senderActiveData: { [id: string]: any }, senders: { [id: string]: any }): string {
    const rxLegs = (Array.isArray(receiverActive?.transport_params) ? receiverActive.transport_params : [])
        .filter((l: any) => l && l.rtp_enabled !== false && l.multicast_ip && l.destination_port !== null && l.destination_port !== undefined && l.destination_port !== "auto");
    if (rxLegs.length === 0) return "";

    let best = "";
    let bestCount = 0;
    let tie = false;
    for (const id of Object.keys(senderActiveData || {})) {
        const sender = senders ? senders[id] : null;
        if (!sender || transportFamily(sender.transport) !== "rtp") continue;
        const active = senderActiveData[id];
        if (!active || active.master_enable === false || !Array.isArray(active.transport_params)) continue;
        const txLegs = active.transport_params.filter((l: any) => l && l.rtp_enabled !== false && l.destination_ip);

        let count = 0;
        for (const rx of rxLegs) {
            const hit = txLegs.some((tx: any) =>
                sameAddress(tx.destination_ip, rx.multicast_ip) &&
                sameAddress(tx.destination_port, rx.destination_port) &&
                (!rx.source_ip || !tx.source_ip || sameAddress(tx.source_ip, rx.source_ip)));
            if (hit) count++;
        }
        if (count === 0) continue;
        if (count > bestCount) {
            best = id;
            bestCount = count;
            tie = false;
        } else if (count === bestCount) {
            tie = true;
        }
    }
    return tie ? "" : best;
}

/** Whether an MXL receiver's /active points at this flow. A side naming no
 *  domain does not rule the other out. */
export function mxlReceiverReads(receiverActive: any, endpoint: MxlEndpoint): boolean {
    const leg = receiverActive?.transport_params?.[0];
    if (!leg || leg.mxl_flow_id !== endpoint.flowId) return false;
    const domain = leg.mxl_domain_id;
    return typeof domain !== "string" || domain === "" || domain === "auto" || domain === endpoint.domainId;
}

/**
 * The sender an MXL receiver takes, found by the flow it reads: the one MXL
 * sender whose /active writes that flow. "" when none does or two do.
 */
export function matchSenderByMxlFlow(receiverActive: any, senderActiveData: { [id: string]: any }, senders: { [id: string]: any }): string {
    let found = "";
    for (const id of Object.keys(senderActiveData || {})) {
        const sender = senders ? senders[id] : null;
        if (!sender || transportFamily(sender.transport) !== "mxl") continue;
        const endpoint = resolvedMxlEndpoint(senderActiveData[id]);
        if (!endpoint || !mxlReceiverReads(receiverActive, endpoint)) continue;
        if (found) return "";
        found = id;
    }
    return found;
}

/**
 * The sender a receiver is connected to, "" when none.
 *
 * Only a running receiver (IS-04 `subscription.active`) has one. It is the
 * sender the IS-04 subscription names, else the one its IS-05 /active names,
 * else the one sending to the addresses an RTP receiver joins
 * (matchSenderByAddress) or writing the flow an MXL receiver reads
 * (matchSenderByMxlFlow).
 */
export function connectedSenderId(receiver: any, receiverActive: any, senderActiveData: { [id: string]: any }, senders: { [id: string]: any }): string {
    const sub = receiver?.subscription;
    if (!sub || !sub.active) return "";
    if (sub.sender_id) return "" + sub.sender_id;
    if (receiverActive?.sender_id) return "" + receiverActive.sender_id;
    const family = transportFamily(receiver?.transport);
    if (family !== "rtp" && family !== "mxl") return "";
    // IS-05 says it is switched off: nothing is joined, whatever IS-04 says.
    if (receiverActive && receiverActive.master_enable === false) return "";
    if (family === "mxl") return matchSenderByMxlFlow(receiverActive, senderActiveData, senders);
    return matchSenderByAddress(receiverActive, senderActiveData, senders);
}

/** A receiver whose sender only its IS-05 /active can tell: running, RTP or
 *  MXL, and not naming the sender in IS-04. */
export function receiverNeedsActive(receiver: any): boolean {
    const sub = receiver?.subscription;
    const family = transportFamily(receiver?.transport);
    return !!(sub && sub.active && !sub.sender_id && (family === "rtp" || family === "mxl"));
}

/** A receiver whose IS-05 /active is kept: one receiverNeedsActive names,
 *  and any running MXL receiver, whose /active is the only place saying
 *  which flow it reads (see mxlFollow.mxlReceiversOffFlow). */
export function receiverActiveRead(receiver: any): boolean {
    const sub = receiver?.subscription;
    if (!sub || !sub.active) return false;
    return receiverNeedsActive(receiver) || transportFamily(receiver?.transport) === "mxl";
}
