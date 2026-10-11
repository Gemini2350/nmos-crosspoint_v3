/*
 * Pure helpers for building IS-05 requests. Kept free of state and I/O so the
 * shape of what is sent to a device can be tested without one.
 */

/** IS-05 control types, newest first. v1.2 adds to v1.1 without changing what
 *  a v1.1 client sends or reads, so the newest one a device offers is used. */
export const SR_CTRL_TYPES = [
    { type: "urn:x-nmos:control:sr-ctrl/v1.2", version: "v1.2" },
    { type: "urn:x-nmos:control:sr-ctrl/v1.1", version: "v1.1" },
    { type: "urn:x-nmos:control:sr-ctrl/v1.0", version: "v1.0" },
];

export const TRANSPORT_MXL = "urn:x-nmos:transport:mxl";

/** Every Connection API href of the newest version a device advertises. */
export function selectControlHrefs(controls: any[]): { href: string, version: string }[] {
    if (!Array.isArray(controls)) return [];
    for (const t of SR_CTRL_TYPES) {
        const hrefs = controls
            .filter((c: any) => c && c.type === t.type && typeof c.href === "string")
            .map((c: any) => ({ href: c.href, version: t.version }));
        if (hrefs.length > 0) return hrefs;
    }
    return [];
}

/** The short transport name the crosspoint works with, "" when unknown. */
export function transportKind(urn: string): string {
    switch (urn) {
        case "urn:x-nmos:transport:rtp": return "rtp";
        case "urn:x-nmos:transport:rtp.mcast": return "rtp.mcast";
        case "urn:x-nmos:transport:rtp.ucast": return "rtp";
        case TRANSPORT_MXL: return "mxl";
        case "urn:x-nmos:transport:websocket": return "websocket";
        case "urn:x-nmos:transport:mqtt": return "mqtt";
    }
    return "";
}

/** Joins a Connection API href and a path without doubling the slash. */
export function joinHref(href: string, path: string): string {
    return href.endsWith("/") ? href + path : href + "/" + path;
}

export interface MxlEndpoint {
    flowId: string,
    domainId: string,
}

/**
 * The MXL flow and domain a sender writes, from its IS-05 /active.
 *
 * BCP-007-03 resolves both into /active once the sender is active: the flow is
 * what a receiver opens and the domain is where. Either missing means there is
 * nothing a receiver could be pointed at, which is refused here rather than
 * patched through as nulls a receiver would take as "read nothing".
 */
export function mxlEndpointFromActive(active: any): MxlEndpoint {
    const leg = active?.transport_params?.[0];
    const flowId = leg?.mxl_flow_id;
    const domainId = leg?.mxl_domain_id;
    if (typeof flowId !== "string" || flowId === "" || flowId === "auto") {
        throw new Error("MXL sender has no resolved mxl_flow_id in its active parameters (is it enabled?)");
    }
    if (typeof domainId !== "string" || domainId === "" || domainId === "auto") {
        throw new Error("MXL sender has no resolved mxl_domain_id in its active parameters");
    }
    return { flowId, domainId };
}

/** The flow and domain an MXL sender writes now, or null when its /active
 *  names none or it is switched off. */
export function resolvedMxlEndpoint(active: any): MxlEndpoint | null {
    if (!active || active.master_enable === false) return null;
    try {
        return mxlEndpointFromActive(active);
    } catch (e) {
        return null;
    }
}

/**
 * The staged PATCH connecting an MXL receiver to a sender's flow.
 *
 * No transport_file: MXL has none, and the sender's manifest_href is null.
 * The receiver's constraints are checked first, because a receiver that can
 * only reach one domain cannot read a flow written in another, and saying so
 * here is clearer than the 400 the device would answer.
 */
export function buildMxlReceiverPatch(senderId: string | null, endpoint: MxlEndpoint, receiverConstraints: any): any {
    const allowed = receiverConstraints?.[0]?.mxl_domain_id?.enum;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(endpoint.domainId)) {
        throw new Error("MXL domain mismatch: the sender writes in domain " + endpoint.domainId +
            " but the receiver only accepts " + allowed.join(", "));
    }
    return {
        sender_id: senderId,
        master_enable: true,
        activation: { mode: "activate_immediate" },
        transport_params: [{ mxl_flow_id: endpoint.flowId, mxl_domain_id: endpoint.domainId }],
    };
}

/** The staged PATCH disconnecting an MXL receiver. */
export function buildMxlDisconnectPatch(): any {
    return {
        sender_id: null,
        master_enable: false,
        activation: { mode: "activate_immediate" },
    };
}

/**
 * The staged PATCH switching a sender on or off without changing where it
 * sends. An RTP sender gets rtp_enabled on every leg. Any other sender gets no
 * transport_params: rtp_enabled is not one of its parameters (MXL, WebSocket,
 * MQTT), and a device answers a parameter outside its constraints with 400.
 * Takes the IS-04 transport URN.
 */
export function buildSenderEnablePatch(transport: string, legCount: number, disable: boolean): any {
    const patch: any = {
        receiver_id: null,
        master_enable: !disable,
        activation: { mode: "activate_immediate" },
    };
    if (!transportKind(transport).startsWith("rtp")) return patch;
    patch.transport_params = [];
    for (let i = 0; i < Math.max(1, legCount); i++) {
        patch.transport_params.push({ rtp_enabled: !disable });
    }
    return patch;
}

/**
 * Whether the multicast lease manager may give a sender a group. Only an RTP
 * multicast sender takes one: an MXL, WebSocket or MQTT sender has no
 * destination_ip and answers a PATCH carrying one with 400, and its /active
 * never shows a leased group, so every refresh would try again. A unicast RTP
 * sender's destination is its receiver, not a group from the pool.
 */
export function usesMulticastLease(sender: any): boolean {
    const kind = transportKind(sender?.transport);
    return kind === "rtp.mcast" || sender?.transport === "urn:x-nmos:transport:rtp";
}

/** Whether a sender has destination_ip and destination_port to PATCH at all. */
export function hasRtpDestination(sender: any): boolean {
    return transportKind(sender?.transport).startsWith("rtp");
}

export interface SdpLeg {
    multicast_ip: string,
    destination_port: number,
    source_ip: string,
}

/**
 * RTP transport_params, one per receiver leg. A leg the SDP has no media
 * block for is switched off explicitly: strict receivers reject the whole
 * PATCH when a leg is left enabled with nothing to bind to.
 */
export function buildRtpTransportParams(receiverLegCount: number, sdpLegs: SdpLeg[], disconnect: boolean): any[] {
    const out: any[] = [];
    for (let i = 0; i < receiverLegCount; i++) {
        if (disconnect) {
            out.push({ rtp_enabled: false });
            continue;
        }
        if (i < sdpLegs.length && sdpLegs[i].multicast_ip) {
            const leg: any = {
                multicast_ip: sdpLegs[i].multicast_ip,
                destination_port: sdpLegs[i].destination_port,
                rtp_enabled: true,
            };
            if (sdpLegs[i].source_ip) { leg.source_ip = sdpLegs[i].source_ip; }
            out.push(leg);
        } else {
            out.push({ rtp_enabled: false });
        }
    }
    return out;
}

// Errors that say the href could not be reached rather than that the device
// refused the request. A node advertises one Connection API under several
// hrefs -- a host name and each address -- and one that does not resolve or
// refuses the connection says nothing about the next.
const UNREACHABLE = new Set([
    "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
    "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
]);

// Whether a failed request should be retried on the node's next href. A device
// that answered has given its verdict, which is the same behind every href.
export function tryNextControl(e: any): boolean {
    if (e && e.response) return false;
    return UNREACHABLE.has(e && e.code);
}
