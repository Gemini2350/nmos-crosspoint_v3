/**
 * Paces the PATCHes Multicast DHCP sends to put a sender on its lease.
 *
 * The lease reconcile runs after every IS-05 /active refresh of a sender.
 * A device that refuses the PATCH (or answers 200 and then does not apply
 * it) leaves /active where it was, so without pacing every refresh fired
 * the next PATCH: a flood in the log, and PATCHes overlapping on the same
 * sender. Here:
 *  - one PATCH per sender at a time;
 *  - after each attempt towards the same target the next one waits longer,
 *    from 30 s doubling to 10 min like the MXL re-patch (mxlFollow) —
 *    success is only what /active shows,
 *    so an accepted PATCH that changes nothing counts like a refused one;
 *  - a sender found on its lease, or a new target, starts from scratch;
 *  - `force` (an explicit "Renew from Pool") skips the wait, never the
 *    one-at-a-time rule.
 * Pure: the caller passes the time, so it can be tested without timers.
 */

export const DELAYS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000];

type Entry = { target: string, attempts: number, notBefore: number, inFlight: boolean };

export type Decision = { ok: true } | { ok: false, reason: "in-flight" | "waiting", retryAt?: number };

export class LeaseRetryGate {
    private entries = new Map<string, Entry>();

    constructor(private delays: number[] = DELAYS) {}

    /** May a PATCH towards `target` go out for sender `id` now? */
    mayTry(id: string, target: string, now: number, force = false): Decision {
        const e = this.entries.get(id);
        if (!e) return { ok: true };
        if (e.inFlight) return { ok: false, reason: "in-flight" };
        if (force || e.target !== target) return { ok: true };
        if (now < e.notBefore) return { ok: false, reason: "waiting", retryAt: e.notBefore };
        return { ok: true };
    }

    /** A PATCH towards `target` goes out now. Returns the attempt number. */
    begin(id: string, target: string, now: number): number {
        const e = this.entries.get(id);
        const attempts = (e && e.target === target) ? e.attempts + 1 : 1;
        this.entries.set(id, { target, attempts, notBefore: now + this.delay(attempts), inFlight: true });
        return attempts;
    }

    /** The PATCH came back. Returns when the next attempt may go out. */
    end(id: string): number {
        const e = this.entries.get(id);
        if (!e) return 0;
        e.inFlight = false;
        return e.notBefore;
    }

    /** The sender is on its lease: nothing to pace any more. */
    inSync(id: string): void {
        this.entries.delete(id);
    }

    /** Wait after attempt `n` (1-based); the last delay repeats. */
    delay(n: number): number {
        return this.delays[Math.min(Math.max(n, 1), this.delays.length) - 1];
    }
}
