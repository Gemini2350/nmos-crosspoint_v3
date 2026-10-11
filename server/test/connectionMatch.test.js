// Run with `npm test`, after `npm run build`: exercises the compiled matcher.
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../dist/lib/connectionMatch");

const flow = (id, type, transport, num) => ({ id, type, num, capabilities: { transport } });

test("a 2110 sender is never matched to an MXL receiver", () => {
    const r = m.matchConnections([flow("tx-rtp", "video", "rtp", 1)], [flow("rx-mxl", "video", "mxl", 1)], false);
    assert.deepEqual(r.connections, []);
    assert.deepEqual(r.refused.map((f) => f.id), ["rx-mxl"]);
});

test("device-level connect pairs each receiver within its transport family", () => {
    const src = [flow("tx-rtp-v", "video", "rtp", 1), flow("tx-mxl-v", "video", "mxl", 2), flow("tx-rtp-a", "audio", "rtp", 3)];
    const dst = [flow("rx-rtp-v", "video", "rtp", 1), flow("rx-mxl-v", "video", "mxl", 2), flow("rx-rtp-a", "audio", "rtp", 3)];
    const r = m.matchConnections(src, dst, false);
    assert.deepEqual(r.connections.map((c) => [c.dst.id, c.src && c.src.id]),
        [["rx-rtp-v", "tx-rtp-v"], ["rx-mxl-v", "tx-mxl-v"], ["rx-rtp-a", "tx-rtp-a"]]);
    assert.deepEqual(r.refused, []);
});

test("a receiver no sender can feed is left alone, not disconnected", () => {
    // All-RTP source device against a device with an MXL and an RTP receiver:
    // the RTP one connects, the MXL one keeps whatever it has.
    const r = m.matchConnections([flow("tx-rtp-v", "video", "rtp", 1)],
        [flow("rx-mxl-v", "video", "mxl", 1), flow("rx-rtp-a", "audio", "rtp", 2)], false);
    assert.deepEqual(r.refused.map((f) => f.id), ["rx-mxl-v"]);
    // Same family, no matching essence: disconnect, as it always was.
    assert.deepEqual(r.connections.map((c) => [c.dst.id, c.src]), [["rx-rtp-a", null]]);
});

test("disconnect reaches every receiver whatever its transport", () => {
    const r = m.matchConnections([], [flow("rx-mxl-v", "video", "mxl", 1), flow("rx-rtp-v", "video", "rtp", 2)], true);
    assert.deepEqual(r.connections.map((c) => [c.dst.id, c.src]), [["rx-mxl-v", null], ["rx-rtp-v", null]]);
    assert.deepEqual(r.refused, []);
});

test("the lowest-numbered unused sender of the right type is picked", () => {
    const src = [flow("b", "audio", "rtp", 5), flow("a", "audio", "rtp", 2)];
    const r = m.matchConnections(src, [flow("rx", "audio", "rtp", 1)], false);
    assert.equal(r.connections[0].src.id, "a");
});
