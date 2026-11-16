/*
 * One device API, several hrefs. A device lists the same API under a host
 * name and each of its addresses, or once per network interface: several
 * `controls` of one type (IS-05, IS-08, IS-12), several `services` of one
 * type (IS-13). IS-04 sets no order between them; they are equal ways to the
 * same API.
 *
 * Crosspoint asks the href that last answered for that device and API first,
 * then the others in the order the device lists them, and moves on only when
 * an href cannot be reached. A device that answered has given its verdict,
 * which is the same behind every href. A dead href costs at most
 * CONNECT_TIMEOUT_MS: the TCP connect gives up after that, independent of the
 * time a device may take to answer.
 */

import * as http from "http";
import * as https from "https";
import { tryNextControl } from "./nmosConnectionPatch";

export const CONNECT_TIMEOUT_MS = 3000;

/** Ends a socket that has not connected within `ms` with ETIMEDOUT, which
 *  counts as unreachable. A connected socket is left alone however long the
 *  answer takes; that is the request's own timeout. */
export function guardConnect(socket: any, ms: number): any {
    if (!socket || socket.connecting !== true) return socket;
    const timer = setTimeout(() => {
        const e: any = new Error("connect timed out after " + ms + " ms");
        e.code = "ETIMEDOUT";
        socket.destroy(e);
    }, ms);
    const clear = () => clearTimeout(timer);
    socket.once("connect", clear);
    socket.once("close", clear);
    return socket;
}

// The default agents' settings (keep-alive etc.), plus the connect timeout.
class DeviceHttpAgent extends http.Agent {
    createConnection(options: any, cb?: any): any {
        return guardConnect((http.Agent.prototype as any).createConnection.call(this, options, cb), CONNECT_TIMEOUT_MS);
    }
}
class DeviceHttpsAgent extends https.Agent {
    createConnection(options: any, cb?: any): any {
        return guardConnect((https.Agent.prototype as any).createConnection.call(this, options, cb), CONNECT_TIMEOUT_MS);
    }
}
const httpAgent = new DeviceHttpAgent({ ...(http.globalAgent as any).options });
const httpsAgent = new DeviceHttpsAgent({ ...(https.globalAgent as any).options });

/** axios options for a request to a device: the answer may take
 *  `timeoutMs`, the connect at most CONNECT_TIMEOUT_MS. */
export function deviceRequest(timeoutMs: number): { timeout: number, httpAgent: http.Agent, httpsAgent: https.Agent } {
    return { timeout: timeoutMs, httpAgent, httpsAgent };
}

/** Per device and API, the href that answered last. */
export class EndpointMemory {
    private last: Map<string, string> = new Map();

    /** `hrefs` with the one that answered last for `key` first, the rest in
     *  the device's order. Unchanged when that one is no longer listed. */
    order(key: string, hrefs: string[]): string[] {
        const l = this.last.get(key);
        if (!l || !hrefs.includes(l)) return hrefs.slice();
        return [l, ...hrefs.filter(h => h !== l)];
    }
    remember(key: string, href: string): void { this.last.set(key, href); }
    lastFor(key: string): string | undefined { return this.last.get(key); }
}

/** The error tryEndpoints rejects with when no href could be reached. */
export function allUnreachable(e: any): boolean {
    return !!(e && e.allUnreachable);
}

/**
 * Runs `request` on the hrefs of one device API until one answers.
 *
 * Resolves with the first answer. Rejects with the device's own error as soon
 * as an href answered with one (or `request` failed for another reason), and
 * with the last connection error, marked `allUnreachable` and listing what was
 * tried, when no href could be reached. `note` hears about an href that was
 * skipped, once per change of the href in use.
 */
export async function tryEndpoints<T>(
    memory: EndpointMemory,
    key: string,
    hrefs: string[],
    request: (href: string) => Promise<T>,
    note?: (message: string) => void,
): Promise<T> {
    const order = memory.order(key, hrefs);
    const skipped: string[] = [];
    let lastError: any = null;
    const settle = (href: string) => {
        memory.remember(key, href);
        if (skipped.length > 0 && note) {
            note(skipped.join(", ") + " not reachable, using " + href);
        }
    };
    for (const href of order) {
        try {
            const result = await request(href);
            settle(href);
            return result;
        } catch (e: any) {
            if (!tryNextControl(e)) {
                // An answer, even an error, says this href reaches the device.
                if (e && e.response) settle(href);
                throw e;
            }
            skipped.push(href + " (" + (e?.code || e?.message || e) + ")");
            lastError = e;
        }
    }
    const err: any = lastError || new Error("no endpoint advertised");
    err.allUnreachable = true;
    err.tried = skipped;
    throw err;
}
