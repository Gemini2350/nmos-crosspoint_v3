// Run with `npm test`, which compiles first: exercises the compiled helpers.
//
// The sender, receiver and ids follow the ST 2110 gateway's MXL sender in
// fixtures/rtp-by-address.json and the tile receiver reading it; the /active
// shape is BCP-007-03's. A writer that derives its flow id from the stream
// format answers a format change with another mxl_flow_id and IS-04 flow_id,
// and an unplugged input with null for both.
const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../dist/lib/mxlFollow");
const t = require("../dist/lib/transport");
const p = require("../dist/lib/nmosConnectionPatch");
const fx = require("./fixtures/rtp-by-address.json");

const SENDER = "0c8dda41-fb99-5577-b032-7cc8606e134a";
const TILE_0 = "b5c9984a-727b-5cf6-83b9-fa352947018b";
const DOMAIN = "3f1c6a52-7d4b-4d40-9d8e-0c6b5a0e1d11";
const FLOW_1080 = "5e0b8e3a-1a2b-5c3d-8e4f-0a1b2c3d4e5f";
const FLOW_720 = "9d8c7b6a-5f4e-5d3c-8b2a-1f0e9d8c7b6a";
const IS04_1080 = "e38aa40e-44bb-507f-a02d-391de256362e";
const IS04_720 = "71c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e";

const senderActive = (flow, domain = DOMAIN, on = true) => ({
    sender_id: null,
    receiver_id: null,
    master_enable: on,
    transport_params: [{ mxl_flow_id: flow, mxl_domain_id: flow === null ? null : domain }],
});
const ep = (flow, domain = DOMAIN) => ({ flowId: flow, domainId: domain });
const step = (last, active, is04) => f.mxlSenderStep(last, p.resolvedMxlEndpoint(active), is04);
// Reads one after another, as getSenderActive folds them in.
const run = (reads) => {
    let seen = null;
    return reads.map(([active, is04]) => {
        const s = step(seen, active, is04);
        seen = s.seen;
        return s;
    });
};

test("a sender switched off or with no flow resolves to nothing", () => {
    assert.deepEqual(p.resolvedMxlEndpoint(senderActive(FLOW_1080)), ep(FLOW_1080));
    assert.equal(p.resolvedMxlEndpoint(senderActive(null)), null);
    assert.equal(p.resolvedMxlEndpoint(senderActive(FLOW_1080, DOMAIN, false)), null);
    assert.equal(p.resolvedMxlEndpoint(senderActive("auto")), null);
    assert.equal(p.resolvedMxlEndpoint(undefined), null);
});

test("a format change moves the receivers to the new flow", () => {
    const [first, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_720), IS04_720],
    ]);
    // A first sighting has nothing to compare with.
    assert.equal(first.action, "none");
    assert.equal(second.action, "follow");
    assert.deepEqual(second.from, ep(FLOW_1080));
    assert.deepEqual(second.seen.endpoint, ep(FLOW_720));
});

test("a flow moved to another domain is followed too", () => {
    const [, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080, "other-domain"), IS04_1080],
    ]);
    assert.equal(second.action, "follow");
    assert.deepEqual(second.from, ep(FLOW_1080));
});

test("an unplugged input never points a receiver at nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(null), null],
    ]);
    assert.deepEqual(steps.map((s) => s.action), ["none", "none", "none"]);
    // The flow the receivers were pointed at is kept, not forgotten.
    assert.deepEqual(steps[2].seen.endpoint, ep(FLOW_1080));
});

test("an input plugged back in with another format is followed from the flow before the gap", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(FLOW_720), IS04_720],
    ]);
    assert.equal(steps[2].action, "follow");
    assert.deepEqual(steps[2].from, ep(FLOW_1080));
});

test("an input plugged back in with the same format changes nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(FLOW_1080), IS04_1080],
    ]);
    // IS-04 went from null to an id, so /active is read once more; the
    // flow is the one the receivers read, so nobody is patched.
    assert.equal(steps[2].action, "reread");
    const again = f.mxlSenderStep(steps[2].seen, ep(FLOW_1080), IS04_1080);
    assert.equal(again.action, "none");
});

test("an IS-04 flow change that /active does not show yet is read again, once", () => {
    const [, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080), IS04_720],
    ]);
    assert.equal(second.action, "reread");
    // The second read shows the move.
    const moved = f.mxlSenderStep(second.seen, ep(FLOW_720), IS04_720);
    assert.equal(moved.action, "follow");
    assert.deepEqual(moved.from, ep(FLOW_1080));
    // Or it still does not: no further read, no loop.
    const still = f.mxlSenderStep(second.seen, ep(FLOW_1080), IS04_720);
    assert.equal(still.action, "none");
});

test("a sender read again unchanged does nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080), IS04_1080],
    ]);
    assert.equal(steps[1].action, "none");
});

const mxlRx = (id, sub) => ({ id, transport: "urn:x-nmos:transport:mxl", interface_bindings: [], subscription: sub });
const rxActive = (flow, sender = null, on = true) => ({
    sender_id: sender, master_enable: on,
    transport_params: [{ mxl_flow_id: flow, mxl_domain_id: DOMAIN }],
});

const none = new Map();

test("a receiver taking the sender by name is pointed at the flow it writes now", () => {
    // The tile receiver as read: running, IS-04 and IS-05 name the sender.
    // Its /active still reads the 1080 flow; the sender writes the 720 one.
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const active = { [TILE_0]: rxActive(FLOW_1080, SENDER) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), [TILE_0]);
    // Named in IS-05 only.
    const byIs05 = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), byIs05, { rx: rxActive(FLOW_1080, SENDER) }, none), ["rx"]);
});

test("a receiver left on an old flow is found with no move seen, as after a restart", () => {
    // Nothing remembered of the sender: the first read already shows the
    // new flow. The step rule has nothing to follow ...
    const first = f.mxlSenderStep(null, ep(FLOW_720), IS04_720);
    assert.equal(first.action, "none");
    // ... and the receiver's own /active still says where it is.
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, first.seen.endpoint, receivers, { [TILE_0]: rxActive(FLOW_1080, SENDER) }, none), [TILE_0]);
});

test("a receiver already on the flow, not yet read, or off is not patched", () => {
    const receivers = {
        on: mxlRx("on", { active: true, sender_id: SENDER }),
        unread: mxlRx("unread", { active: true, sender_id: SENDER }),
        disabled: mxlRx("disabled", { active: true, sender_id: SENDER }),
        stopped: mxlRx("stopped", { active: false, sender_id: SENDER }),
        other: mxlRx("other", { active: true, sender_id: "another-sender" }),
        rtp: { ...mxlRx("rtp", { active: true, sender_id: SENDER }), transport: "urn:x-nmos:transport:rtp.mcast" },
    };
    const active = {
        on: rxActive(FLOW_720, SENDER),
        disabled: rxActive(FLOW_1080, SENDER, false),
        stopped: rxActive(FLOW_1080, SENDER),
        other: rxActive(FLOW_1080, "another-sender"),
        rtp: rxActive(FLOW_1080, SENDER),
    };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), []);
    // Same flow id in another domain is another flow.
    const moved = { on: { ...rxActive(FLOW_720, SENDER), transport_params: [{ mxl_flow_id: FLOW_720, mxl_domain_id: "other-domain" }] } };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), { on: receivers.on }, moved, none), ["on"]);
});

test("a receiver is re-patched at most once per value of the sender's flow", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const active = { [TILE_0]: rxActive(FLOW_1080, SENDER) };
    const patched = new Map([[TILE_0, f.mxlRepatchKey(SENDER, ep(FLOW_720))]]);
    // Patched to 720 and still reading 1080 -- refused, or not applied yet.
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, patched), []);
    // The sender moves again: one more attempt.
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_1080 + "-b"), receivers, active, patched), [TILE_0]);
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720, "other-domain"), receivers, active, patched), [TILE_0]);
});

test("a receiver refusing a flow is asked once while the sender stays on it", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const patched = new Map();
    const on1080 = { [TILE_0]: rxActive(FLOW_1080, SENDER) };
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
    // Refused: still on 1080. Every further read of either side sends nothing.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), []);
    assert.equal(patched.get(TILE_0), f.mxlRepatchKey(SENDER, ep(FLOW_720)));
});

test("a receiver that refused a flow is asked again when the sender comes back to it", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const patched = new Map();
    const on1080 = { [TILE_0]: rxActive(FLOW_1080, SENDER) };
    // 1080 -> 720, refused.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
    // Back to 1080, where the receiver still is: nothing to send.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched), []);
    // 720 again: the receiver reads a flow nobody writes, so it is asked again.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
});

test("an unnamed receiver that refused a flow is asked again on the next move to it", () => {
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    const patched = new Map();
    const on1080 = { rx: rxActive(FLOW_1080) };
    const unnamed = () => f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), receivers, on1080);
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched, unnamed()), ["rx"]);
    // Refused; the sender goes back to 1080 and then to 720 again.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched), []);
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched, unnamed()), ["rx"]);
    // A claim for another sender is left alone.
    patched.set("rx", f.mxlRepatchKey("another-sender", ep(FLOW_1080)));
    f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched);
    assert.equal(patched.get("rx"), f.mxlRepatchKey("another-sender", ep(FLOW_1080)));
});

test("receivers naming no sender follow when they read the flow the sender left", () => {
    const receivers = {
        byFlow: mxlRx("byFlow", { active: true, sender_id: null }),
        elsewhere: mxlRx("elsewhere", { active: true, sender_id: null }),
        disabled: mxlRx("disabled", { active: true, sender_id: null }),
        unread: mxlRx("unread", { active: true, sender_id: null }),
        // Named ones are the level rule's.
        named: mxlRx("named", { active: true, sender_id: SENDER }),
        byIs05: mxlRx("byIs05", { active: true, sender_id: null }),
    };
    const active = {
        byFlow: rxActive(FLOW_1080),
        elsewhere: rxActive(FLOW_720),
        disabled: rxActive(FLOW_1080, null, false),
        named: rxActive(FLOW_1080, SENDER),
        byIs05: rxActive(FLOW_1080, "another-sender"),
    };
    assert.deepEqual(f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), receivers, active), ["byFlow"]);
    const otherDomain = { byFlow: { ...rxActive(FLOW_1080), transport_params: [{ mxl_flow_id: FLOW_1080, mxl_domain_id: "other-domain" }] } };
    assert.deepEqual(f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), { byFlow: receivers.byFlow }, otherDomain), []);
});

test("every running MXL receiver has its /active read, named or not", () => {
    assert.equal(t.receiverActiveRead(fx.receivers[TILE_0]), true);
    assert.equal(t.receiverActiveRead(mxlRx("rx", { active: true, sender_id: null })), true);
    assert.equal(t.receiverActiveRead(mxlRx("rx", { active: false, sender_id: SENDER })), false);
    // RTP stays as it was: only when naming no sender.
    const rtp = (sub) => ({ ...mxlRx("rtp", sub), transport: "urn:x-nmos:transport:rtp.mcast" });
    assert.equal(t.receiverActiveRead(rtp({ active: true, sender_id: SENDER })), false);
    assert.equal(t.receiverActiveRead(rtp({ active: true, sender_id: null })), true);
});

test("overlapping /active reads: a late older answer never replaces a newer one", () => {
    const o = new f.ReadOrder();
    const a = o.begin(SENDER);
    const b = o.begin(SENDER);
    assert.equal(o.take(SENDER, b), true);
    assert.equal(o.take(SENDER, a), false);
});

test("overlapping /active reads: the older answer counts when the newer read fails", () => {
    const o = new f.ReadOrder();
    const a = o.begin(SENDER);
    const b = o.begin(SENDER);
    // a answers first; b then fails and takes nothing. a must have counted.
    assert.equal(o.take(SENDER, a), true);
    // And b answering after all still wins over a.
    assert.equal(o.take(SENDER, b), true);
    // Senders are ordered separately.
    const c = o.begin("other");
    assert.equal(o.take("other", c), true);
    o.forget(SENDER);
    assert.equal(o.take(SENDER, o.begin(SENDER)), true);
});

test("overlapping /active reads: an answer arriving after the sender was removed is dropped", () => {
    const o = new f.ReadOrder();
    const old = o.begin(SENDER);
    o.forget(SENDER);
    assert.equal(o.take(SENDER, old), false);
    // Registered again: the read begun for the earlier sender still does not
    // count, the new one does.
    const fresh = o.begin(SENDER);
    assert.equal(o.take(SENDER, old), false);
    assert.equal(o.take(SENDER, fresh), true);
    // A registry switch forgets every sender.
    const before = o.begin("other");
    o.clear();
    assert.equal(o.take("other", before), false);
});

test("an MXL receiver naming no sender is connected by the flow it reads", () => {
    const rx = mxlRx("rx", { active: true, sender_id: null });
    const senders = { [SENDER]: fx.senders[SENDER], twin: { ...fx.senders[SENDER], id: "twin" } };
    const active = { [SENDER]: senderActive(FLOW_1080), twin: senderActive(FLOW_720) };
    assert.equal(t.receiverNeedsActive(rx), true);
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), active, senders), SENDER);
    // The sender moved on: the receiver reads a flow nobody writes.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { ...active, [SENDER]: senderActive(FLOW_720, "d2") }, senders), "");
    // Switched off in IS-05.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080, null, false), active, senders), "");
    // Two senders writing the same flow: not guessed between.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { ...active, twin: senderActive(FLOW_1080) }, senders), "");
    // A sender switched off writes nothing.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { [SENDER]: senderActive(FLOW_1080, DOMAIN, false) }, senders), "");
});

const S2 = "7a6b5c4d-3e2f-5a1b-9c8d-7e6f5a4b3c2d";
const FLOW_S2 = "1f2e3d4c-5b6a-5f7e-8d9c-0b1a2f3e4d5c";
const mxlSender = (id) => ({ ...fx.senders[SENDER], id });

test("the sender a receiver takes is the one its /active names, IS-04 only while /active is unknown", () => {
    assert.equal(f.mxlNamedSender({ sender_id: null }, { sender_id: S2 }), S2);
    assert.equal(f.mxlNamedSender({ sender_id: SENDER }, { sender_id: SENDER }), SENDER);
    assert.equal(f.mxlNamedSender({ sender_id: SENDER }, { sender_id: S2 }), S2);
    // /active names none: it takes none, whatever IS-04 still says.
    assert.equal(f.mxlNamedSender({ sender_id: SENDER }, { sender_id: null }), "");
    assert.equal(f.mxlNamedSender({ sender_id: SENDER }, {}), "");
    // /active not read yet.
    assert.equal(f.mxlNamedSender({ sender_id: SENDER }, undefined), SENDER);
    assert.equal(f.mxlNamedSender({ sender_id: null }, null), "");
});

test("a receiver IS-04 names but whose /active names no sender is not taken by name", () => {
    // Another controller connected it by flow alone; IS-04 lags.
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: SENDER }) };
    const active = { rx: rxActive(FLOW_S2) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), []);
    // It counts as naming none, so the edge rule may move it off a flow left.
    assert.deepEqual(f.mxlUnnamedReceiversOnFlow(ep(FLOW_S2), receivers, active), ["rx"]);
});

test("a receiver IS-04 names for one sender but /active routes to another is left where it is", () => {
    // IS-04 still says SENDER; /active says S2 and reads S2's flow, as after
    // another controller routed it and IS-04 has not caught up.
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: SENDER }) };
    const active = { rx: rxActive(FLOW_S2, S2) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), []);
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, active, new Map()), []);
});

test("a receiver is checked again just before its PATCH", () => {
    const senders = { [SENDER]: mxlSender(SENDER), [S2]: mxlSender(S2) };
    const senderActiveData = { [SENDER]: senderActive(FLOW_720), [S2]: senderActive(FLOW_S2) };
    const named = mxlRx("rx", { active: true, sender_id: SENDER });
    const unnamed = mxlRx("rx", { active: true, sender_id: null });
    const check = (rx, active, from = null, sa = senderActiveData) =>
        f.mxlRepatchEligible(SENDER, ep(FLOW_720), rx, active, from, senders, sa);
    // Still on the old flow, still taking the sender: patched.
    assert.equal(check(named, rxActive(FLOW_1080, SENDER)), true);
    // Disconnected by the operator meanwhile: /active unknown, or off.
    assert.equal(check(named, undefined), false);
    assert.equal(check(named, null), false);
    assert.equal(check(named, rxActive(FLOW_1080, SENDER, false)), false);
    assert.equal(check(mxlRx("rx", { active: false, sender_id: SENDER }), rxActive(FLOW_1080, SENDER)), false);
    // Disconnected by name only: /active names no sender any more.
    assert.equal(check(named, rxActive(FLOW_1080)), false);
    // Routed to another sender meanwhile.
    assert.equal(check(named, rxActive(FLOW_S2, S2)), false);
    // Already on the flow.
    assert.equal(check(named, rxActive(FLOW_720)), false);
    // Naming no sender: only while it still reads the flow the sender left.
    assert.equal(check(unnamed, rxActive(FLOW_1080), ep(FLOW_1080)), true);
    assert.equal(check(unnamed, rxActive(FLOW_S2), ep(FLOW_1080)), false);
    assert.equal(check(unnamed, rxActive(FLOW_1080)), false);
    // ... and no other sender has started writing it.
    assert.equal(check(unnamed, rxActive(FLOW_1080), ep(FLOW_1080), { ...senderActiveData, [S2]: senderActive(FLOW_1080) }), false);
    // Not MXL.
    assert.equal(check({ ...named, transport: "urn:x-nmos:transport:rtp.mcast" }, rxActive(FLOW_1080, SENDER)), false);
});

test("receivers naming no sender stay on a flow another sender still writes", () => {
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    const active = { rx: rxActive(FLOW_1080) };
    const senders = { [SENDER]: mxlSender(SENDER), [S2]: mxlSender(S2) };
    // SENDER left 1080 for 720; S2 writes 1080: the receiver may be S2's.
    assert.deepEqual(f.mxlUnnamedFollowers(SENDER, ep(FLOW_1080), receivers, active, senders,
        { [SENDER]: senderActive(FLOW_720), [S2]: senderActive(FLOW_1080) }), []);
    // Nobody else writes 1080: it follows.
    assert.deepEqual(f.mxlUnnamedFollowers(SENDER, ep(FLOW_1080), receivers, active, senders,
        { [SENDER]: senderActive(FLOW_720), [S2]: senderActive(FLOW_S2) }), ["rx"]);
    // A sender switched off writes nothing.
    assert.deepEqual(f.mxlUnnamedFollowers(SENDER, ep(FLOW_1080), receivers, active, senders,
        { [SENDER]: senderActive(FLOW_720), [S2]: senderActive(FLOW_1080, DOMAIN, false) }), ["rx"]);
});

test("only a receiver refusing the flow keeps its claim", () => {
    // A 4xx answer, or constraints excluding the sender's domain.
    assert.equal(f.mxlRefused({ status: 400 }), true);
    assert.equal(f.mxlRefused({ refused: true }), true);
    // Unreachable, timed out, a 5xx: not a refusal.
    assert.equal(f.mxlRefused({ status: 500 }), false);
    assert.equal(f.mxlRefused(new Error("Receiver Control unreachable.")), false);
    assert.equal(f.mxlRefused(null), false);

    const key = f.mxlRepatchKey(SENDER, ep(FLOW_720));
    const settle = (outcome, before = key, sentKey = key) => {
        const m = new Map([["rx", before]]);
        f.mxlSettleClaim(m, "rx", key, outcome, sentKey);
        return m.get("rx");
    };
    assert.equal(settle("patched"), key);
    assert.equal(settle({ error: { status: 400 } }), key);
    assert.equal(settle({ error: { refused: true } }), key);
    // Nothing sent, or failed on the way: released, so the next read tries again.
    assert.equal(settle("skipped"), undefined);
    assert.equal(settle({ error: { status: 503 } }), undefined);
    assert.equal(settle({ error: new Error("timeout") }), undefined);
    // Kept under the flow actually sent when the sender moved meanwhile.
    const other = f.mxlRepatchKey(SENDER, ep(FLOW_1080));
    assert.equal(settle("patched", key, other), other);
    // A claim made meanwhile for another value is left alone.
    assert.equal(settle("skipped", other), other);
});

test("a released claim is tried again once its backoff is over, not before", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const active = { [TILE_0]: rxActive(FLOW_1080, SENDER) };
    const patched = new Map();
    const retry = new Map();
    const key = f.mxlRepatchKey(SENDER, ep(FLOW_720));
    const targets = (now) => f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, active, patched, [], retry, now);
    const fail = (now) => f.mxlSettleClaim(patched, TILE_0, key, { error: { status: 503 } }, key, retry, now);
    assert.deepEqual(targets(0), [TILE_0]);
    fail(1000);
    // Every read of the sender or a sibling receiver looks again: not yet.
    assert.deepEqual(targets(1000), []);
    assert.deepEqual(targets(30999), []);
    assert.deepEqual(targets(31000), [TILE_0]);
    // Failing again doubles the wait.
    fail(31000);
    assert.deepEqual(targets(90999), []);
    assert.deepEqual(targets(91000), [TILE_0]);
    // ... up to 10 min.
    let now = 91000;
    for (let i = 0; i < 10; i++) { fail(now); now = retry.get(TILE_0).due; targets(now); }
    assert.equal(retry.get(TILE_0).wait, 600000);
    // Taken: the backoff is gone.
    f.mxlSettleClaim(patched, TILE_0, key, "patched", key, retry, now);
    assert.equal(retry.has(TILE_0), false);
});

test("a receiver seen on its sender's flow starts a later backoff afresh", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const patched = new Map();
    const retry = new Map([[TILE_0, { due: 500000, wait: 480000 }]]);
    // Somebody else got it onto the flow meanwhile.
    f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, { [TILE_0]: rxActive(FLOW_720, SENDER) }, patched, [], retry, 1000);
    assert.equal(retry.has(TILE_0), false);
    // The sender moves; the receiver is asked at once.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, { [TILE_0]: rxActive(FLOW_720, SENDER) }, patched, [], retry, 1000), [TILE_0]);
    // A stopped receiver's backoff is dropped.
    const stopped = new Map([["gone", { due: 9e9, wait: 60000 }]]);
    f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, {}, new Map(), [], stopped, 0);
    assert.equal(stopped.has("gone"), false);
});

test("the flow a sender left is kept until its unnamed followers have moved", () => {
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    const senders = { [SENDER]: mxlSender(SENDER) };
    const sa = { [SENDER]: senderActive(FLOW_720) };
    const pend = (pending, stepFrom, active) => f.mxlPendingFollow(SENDER, pending, stepFrom, receivers, active, senders, sa);
    // The move is seen: the follower is due, the flow left is kept.
    const first = pend(null, ep(FLOW_1080), { rx: rxActive(FLOW_1080) });
    assert.deepEqual(first, { from: ep(FLOW_1080), unnamed: ["rx"] });
    // Its PATCH failed: a later read with no move still finds it.
    assert.deepEqual(pend(first.from, null, { rx: rxActive(FLOW_1080) }), { from: ep(FLOW_1080), unnamed: ["rx"] });
    // It moved: nothing is kept.
    assert.deepEqual(pend(first.from, null, { rx: rxActive(FLOW_720, SENDER) }), { from: null, unnamed: [] });
    // Nothing pending, no move.
    assert.deepEqual(pend(null, null, { rx: rxActive(FLOW_1080) }), { from: null, unnamed: [] });
    // A new move replaces the flow kept.
    assert.deepEqual(pend(ep("older"), ep(FLOW_1080), { rx: rxActive(FLOW_1080) }).from, ep(FLOW_1080));
});

test("the claim of a receiver that stopped running or is gone is dropped", () => {
    const key = f.mxlRepatchKey(SENDER, ep(FLOW_720));
    const patched = new Map([["stopped", key], ["gone", key], ["other", f.mxlRepatchKey(S2, ep(FLOW_S2))]]);
    const receivers = {
        stopped: mxlRx("stopped", { active: false, sender_id: SENDER }),
        other: mxlRx("other", { active: true, sender_id: S2 }),
    };
    f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, { other: rxActive(FLOW_1080, S2) }, patched);
    assert.deepEqual([...patched.keys()], ["other"]);
});

test("a receiver /active read again unchanged is not a change", () => {
    assert.equal(f.receiverActiveChanged(rxActive(FLOW_1080), rxActive(FLOW_1080)), false);
    assert.equal(f.receiverActiveChanged(rxActive(FLOW_1080), rxActive(FLOW_720)), true);
    assert.equal(f.receiverActiveChanged(rxActive(FLOW_1080), rxActive(FLOW_1080, null, false)), true);
    assert.equal(f.receiverActiveChanged(undefined, rxActive(FLOW_1080)), true);
    assert.equal(f.receiverActiveChanged(undefined, undefined), false);
});
