// Total bandwidth of a device / node, per leg.
const test = require("node:test");
const assert = require("node:assert/strict");
const b = require("../dist/lib/bandwidth.js");

const ok = (v) => ({ v, hint: "ok" });

test("the bitrate: known, estimated or not known", () => {
    assert.equal(b.bitrateMbps(ok(9.9)), 9.9);
    assert.equal(b.bitrateMbps({ v: 1, hint: "max" }), 1);
    assert.equal(b.bitrateMbps({ v: 0, hint: "unknown" }), null);
    assert.equal(b.bitrateMbps({ v: 5, hint: "unknown" }), null);
    assert.equal(b.bitrateMbps(ok(0)), null);
    assert.equal(b.bitrateMbps(12), 12);
    assert.equal(b.bitrateMbps(undefined), null);
});

test("on the network: RTP and unknown transports; not MXL, WebSocket, MQTT", () => {
    assert.equal(b.onTheNetwork("urn:x-nmos:transport:rtp.mcast"), true);
    assert.equal(b.onTheNetwork("rtp"), true);
    assert.equal(b.onTheNetwork(""), true);
    assert.equal(b.onTheNetwork(undefined), true);
    assert.equal(b.onTheNetwork("urn:x-nmos:transport:mxl"), false);
    assert.equal(b.onTheNetwork("websocket"), false);
    assert.equal(b.onTheNetwork("mqtt"), false);
});

test("enabled legs from /active, else all legs it has", () => {
    assert.deepEqual(b.enabledLegs([{ rtp_enabled: true }, { rtp_enabled: true }], 2), [0, 1]);
    assert.deepEqual(b.enabledLegs([{ rtp_enabled: true }, { rtp_enabled: false }], 2), [0]);
    assert.deepEqual(b.enabledLegs([{ rtp_enabled: false }, { rtp_enabled: true }], 2), [1]);
    assert.deepEqual(b.enabledLegs([{ rtp_enabled: false }], 1), []);
    assert.deepEqual(b.enabledLegs([{}], 2), [0]);
    assert.deepEqual(b.enabledLegs(undefined, 2), [0, 1]);
    assert.deepEqual(b.enabledLegs(undefined, 0), [0]);
});

test("ST 2022-7: per leg, '2 ×' when both carry the same", () => {
    const s = b.emptySum();
    b.addStream(s, ok(2203.9), [0, 1]);
    b.addStream(s, ok(9.9), [0, 1]);
    b.addStream(s, { v: 1, hint: "max" }, [0, 1]);
    const v = b.bandwidthView(s, "tx");
    assert.equal(v.label, "2 × 2.21 Gbit/s");
    assert.deepEqual(v.legs.map((x) => Math.round(x * 10) / 10), [2214.8, 2214.8]);
    assert.equal(v.streams, 3);
    assert.equal(v.tooltip, "Sending, 3 active senders\nLeg 1: 2.21 Gbit/s\nLeg 2: 2.21 Gbit/s\nBoth networks: 4.43 Gbit/s\n1 counted at an estimated maximum");
});

test("one leg, Mbit/s, '< 1'", () => {
    const s = b.emptySum();
    b.addStream(s, ok(3.0), [0]);
    assert.equal(b.bandwidthView(s, "rx").label, "3.0 Mbit/s");
    assert.equal(b.bandwidthView(s, "rx").tooltip, "Receiving, 1 active receiver\nLeg 1: 3.0 Mbit/s");
    const t = b.emptySum();
    b.addStream(t, ok(0.3), [0]);
    assert.equal(b.bandwidthView(t, "tx").label, "< 1 Mbit/s");
});

test("legs that differ: one value per leg, one unit", () => {
    const s = b.emptySum();
    b.addStream(s, ok(2203.9), [0, 1]);
    b.addStream(s, ok(1100), [0]);
    assert.equal(b.bandwidthView(s, "tx").label, "3.30 + 2.20 Gbit/s");
    const m = b.emptySum();
    b.addStream(m, ok(9.9), [0, 1]);
    b.addStream(m, ok(3), [1]);
    assert.equal(b.bandwidthView(m, "tx").label, "9.9 + 12.9 Mbit/s");
});

test("unknown bitrates: '≥', named in the tooltip; nothing known: no view", () => {
    const s = b.emptySum();
    b.addStream(s, ok(2210.2), [0]);
    b.addStream(s, { v: 0, hint: "unknown" }, [0]);
    b.addUnknown(s);
    const v = b.bandwidthView(s, "tx");
    assert.equal(v.label, "≥ 2.21 Gbit/s");
    assert.match(v.tooltip, /^Sending, 3 active senders\nLeg 1: 2\.21 Gbit\/s\n2 with unknown bitrate, not counted$/);
    const u = b.emptySum();
    b.addUnknown(u); b.addUnknown(u);
    assert.equal(b.bandwidthView(u, "rx"), null);
    assert.equal(b.bandwidthView(b.emptySum(), "tx"), null);
});

test("every leg off: not on the wire, not counted", () => {
    const s = b.emptySum();
    b.addStream(s, ok(100), []);
    assert.equal(s.streams, 0);
    assert.equal(b.bandwidthView(s, "tx"), null);
});

test("a node is the sum of its devices", () => {
    const a = b.emptySum(), c = b.emptySum();
    b.addStream(a, ok(2214.8), [0, 1]);
    b.addStream(c, ok(2214.8), [0, 1]);
    b.addUnknown(c);
    const n = b.mergeSums(a, c);
    assert.deepEqual(n.legs.map((x) => Math.round(x * 10) / 10), [4429.6, 4429.6]);
    assert.equal(n.streams, 3);
    assert.equal(n.unknown, 1);
    assert.equal(b.bandwidthView(n, "tx").label, "≥ 2 × 4.43 Gbit/s");
    const both = b.bandwidthOf(n, b.emptySum());
    assert.equal(both.rx, null);
    assert.equal(both.tx.label, "≥ 2 × 4.43 Gbit/s");
});
