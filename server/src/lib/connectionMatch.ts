/*
 * The connection matcher behind makeConnection, free of state so it can be
 * tested. ui/src/routes/crosspoint.svelte (computePreviewConnections) carries
 * a port of it for the hover preview; a change here has to land there too.
 */
import { flowsConnectable, transportsCompatible } from "./transport";

export interface MatchedConnection {
    src: any,
    dst: any,
}

export interface MatchResult {
    connections: MatchedConnection[],
    // Receivers the request cannot feed: no sender in it shares their
    // transport family. They are left as they are, not disconnected.
    refused: any[],
}

/**
 * Pair every receiver flow with a sender flow.
 *
 * A receiver whose transport family no sender in the request offers is
 * refused and left alone: an MXL receiver has nothing to take from a 2110
 * sender and the reverse, and switching it off because of that would be a
 * disconnect nobody asked for. Only the family decides: a receiver of the
 * right family but an essence no sender offers is disconnected, as it always
 * was on a device-level take. Every other receiver gets the lowest-numbered
 * unused sender of its essence type and transport family, or -- as it always
 * has -- no sender at all, which disconnects it.
 */
export function matchConnections(srcFlows: any[], dstFlows: any[], disconnect: boolean): MatchResult {
    const out: MatchResult = { connections: [], refused: [] };
    let usedSources: string[] = [];
    for (const dstFlow of dstFlows) {
        if (!disconnect && !srcFlows.some((s) => transportsCompatible(dstFlow?.capabilities?.transport, s?.capabilities?.transport))) {
            out.refused.push(dstFlow);
            continue;
        }
        const connection: MatchedConnection = { src: null, dst: dstFlow };
        if (!disconnect) {
            for (const srcFlow of srcFlows) {
                if (!flowsConnectable(dstFlow, srcFlow) || usedSources.includes(srcFlow.id)) continue;
                if (connection.src == null) {
                    connection.src = srcFlow;
                    usedSources.push(srcFlow.id);
                } else if (connection.src.num > srcFlow.num) {
                    // The earlier pick's id stays in usedSources and the
                    // replacement's is not added -- kept as it was, the UI
                    // preview mirrors exactly this.
                    connection.src = srcFlow;
                }
            }
        }
        out.connections.push(connection);
    }
    return out;
}
