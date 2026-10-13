// Pacing of the Multicast DHCP reconcile PATCHes (one at a time, growing waits).
const test = require("node:test");
const assert = require("node:assert");
const { LeaseRetryGate, DELAYS } = require("../dist/lib/leaseRetry.js");

const T = "239.113.0.11:5010";

test("the first attempt goes out at once", () => {
    const g = new LeaseRetryGate();
    assert.deepEqual(g.mayTry("s", T, 0), { ok: true });
});

test("one PATCH per sender at a time, even when forced", () => {
    const g = new LeaseRetryGate();
    g.begin("s", T, 0);
    assert.deepEqual(g.mayTry("s", T, 999_999), { ok: false, reason: "in-flight" });
    assert.deepEqual(g.mayTry("s", T, 999_999, true), { ok: false, reason: "in-flight" });
    assert.deepEqual(g.mayTry("other", T, 0), { ok: true });
});

test("each attempt towards the same target waits longer, the last wait repeats", () => {
    const g = new LeaseRetryGate();
    let now = 0;
    const waits = [];
    for (let i = 0; i < DELAYS.length + 2; i++) {
        assert.equal(g.mayTry("s", T, now).ok, true, "attempt " + (i + 1));
        g.begin("s", T, now);
        const next = g.end("s");
        waits.push(next - now);
        const early = g.mayTry("s", T, next - 1);
        assert.deepEqual(early, { ok: false, reason: "waiting", retryAt: next });
        now = next;
    }
    assert.deepEqual(waits, [...DELAYS, DELAYS[DELAYS.length - 1], DELAYS[DELAYS.length - 1]]);
});

test("an accepted PATCH that changes nothing waits like a refused one", () => {
    // end() does not care about the answer: only /active (inSync) clears it.
    const g = new LeaseRetryGate();
    g.begin("s", T, 0);
    g.end("s");
    assert.equal(g.mayTry("s", T, 1000).ok, false);
});

test("found on its lease, the sender starts from scratch", () => {
    const g = new LeaseRetryGate();
    g.begin("s", T, 0); g.end("s");
    g.begin("s", T, DELAYS[0]); g.end("s");
    g.inSync("s");
    assert.deepEqual(g.mayTry("s", T, DELAYS[0] + 1), { ok: true });
    assert.equal(g.begin("s", T, DELAYS[0] + 1), 1);
});

test("a new target goes out at once and counts from one", () => {
    const g = new LeaseRetryGate();
    g.begin("s", T, 0); g.end("s");
    assert.deepEqual(g.mayTry("s", "239.113.0.13:5010", 1), { ok: true });
    assert.equal(g.begin("s", "239.113.0.13:5010", 1), 1);
});

test("a forced attempt (Renew from Pool) skips the wait but keeps counting", () => {
    const g = new LeaseRetryGate();
    g.begin("s", T, 0); g.end("s");
    assert.deepEqual(g.mayTry("s", T, 1, true), { ok: true });
    assert.equal(g.begin("s", T, 1), 2);
});
