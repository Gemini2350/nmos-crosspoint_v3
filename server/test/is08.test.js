// IS-08 Audio Channel Mapping: /io and /map/active as the Details page shows them.
const test = require("node:test");
const assert = require("node:assert");
const c = require("../dist/lib/is08.js");

const RXA = "aaaaaaaa-0000-4000-8000-000000000001";
const RXB = "aaaaaaaa-0000-4000-8000-000000000002";
const SRC_MIX = "bbbbbbbb-0000-4000-8000-000000000001";
const SRC_REMOTE = "bbbbbbbb-0000-4000-8000-000000000009";
const TX_MIX = "cccccccc-0000-4000-8000-000000000001";

const ch = (n, p = "Ch ") => Array.from({ length: n }, (_, i) => ({ label: p + (i + 1) }));
const io = {
    inputs: {
        inA: { properties: { name: "Input 1", description: "" }, parent: { id: RXA, type: "receiver" }, channels: ch(8), caps: { reordering: true, block_size: 1 } },
        inB: { properties: { name: "Input 2", description: "" }, parent: { id: RXB, type: "receiver" }, channels: ch(8), caps: { reordering: true, block_size: 1 } },
        ana: { properties: { name: "Analog In", description: "" }, parent: { id: null, type: null }, channels: ch(4), caps: { reordering: true, block_size: 1 } },
        far: { properties: { name: "Input 4", description: "" }, parent: { id: SRC_REMOTE, type: "source" }, channels: ch(2), caps: { reordering: true, block_size: 1 } },
    },
    outputs: {
        mix: { properties: { name: "Output 1", description: "" }, source_id: SRC_MIX, channels: ch(8), caps: { routable_inputs: null } },
        hp: { properties: { name: "Headphones", description: "" }, source_id: null, channels: ch(2), caps: { routable_inputs: ["inA", "inB", null] } },
    },
};
const route = (input, idx) => ({ input, channel_index: idx });
const active = {
    activation: { mode: null, requested_time: null, activation_time: null },
    map: {
        mix: { 0: route("inA", 0), 1: route("inA", 1), 2: route("inB", 0), 3: route("inB", 1), 4: route("inA", 4), 5: route("inA", 5), 6: route(null, null), 7: route(null, null) },
        hp: { 0: route("inA", 0), 1: route("inA", 1) },
    },
};
const lookup = {
    receiverName: (id) => ({ [RXA]: "RX Studio A", [RXB]: "RX Studio B" })[id],
    sourceSenders: (id) => id === SRC_MIX ? [{ id: TX_MIX, name: "TX Mix" }] : id === SRC_REMOTE ? [{ id: "x", name: "Stagebox 1-8" }] : [],
    sourceLabel: (id) => id === SRC_MIX ? "Mix source" : undefined,
    receiverOfSource: () => undefined,
};

test("the Channel Mapping API among a device's controls", () => {
    assert.deepEqual(c.channelMapHrefs([
        { type: "urn:x-nmos:control:sr-ctrl/v1.1", href: "http://a/x-nmos/connection/v1.1/" },
        { type: "urn:x-nmos:control:cm-ctrl/v1.0", href: "http://a/x-nmos/channelmapping/v1.0/" },
        { type: "urn:x-nmos:control:cm-ctrl/v1.0", href: "http://b/x-nmos/channelmapping/v1.0/" },
    ]), ["http://a/x-nmos/channelmapping/v1.0/", "http://b/x-nmos/channelmapping/v1.0/"]);
    assert.deepEqual(c.channelMapHrefs(undefined), []);
});

test("inputs and outputs are named after what the operator knows", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.deepEqual(v.inputs.map(i => [i.id, i.name, i.kind, i.receiverId, i.deviceName, i.channels.length]), [
        ["inA", "RX Studio A", "receiver", RXA, "Input 1", 8],
        ["inB", "RX Studio B", "receiver", RXB, "Input 2", 8],
        ["ana", "Analog In", "local", null, "", 4],
        ["far", "Stagebox 1-8", "source", null, "Input 4", 2],
    ]);
    assert.deepEqual(v.outputs.map(o => [o.id, o.name, o.kind, o.senderIds, o.deviceName]), [
        ["mix", "TX Mix", "sender", [TX_MIX], "Output 1"],
        ["hp", "Headphones", "local", [], ""],
    ]);
});

test("an input naming the originating source belongs to the receiver taking it", () => {
    const v = c.buildChannelMapView(io, active, { ...lookup, receiverOfSource: (id) => id === SRC_REMOTE ? { id: RXB, name: "RX Studio B" } : undefined });
    const far = v.inputs.find(i => i.id === "far");
    assert.deepEqual([far.name, far.kind, far.receiverId], ["RX Studio B", "receiver", RXB]);
});

test("the active map, 1-based, unrouted as null", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    const mix = v.outputs[0].channels;
    assert.deepEqual(mix.slice(0, 3), [
        { label: "Ch 1", input: "inA", inputChannel: 1 },
        { label: "Ch 2", input: "inA", inputChannel: 2 },
        { label: "Ch 3", input: "inB", inputChannel: 1 },
    ]);
    assert.deepEqual(mix[6], { label: "Ch 7", input: null, inputChannel: null });
});

test("a map entry missing, or naming an input the device does not list, counts as unrouted", () => {
    const v = c.buildChannelMapView(io, { map: { mix: { 0: route("nope", 0) } } }, lookup);
    assert.deepEqual(v.outputs[0].channels[0], { label: "Ch 1", input: null, inputChannel: null });
    assert.deepEqual(v.outputs[0].channels[1], { label: "Ch 2", input: null, inputChannel: null });
});

test("runs of an output: one per input and consecutive channels, muted ones too", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.deepEqual(c.outputSegments(v, v.outputs[0]), [
        { input: "inA", name: "RX Studio A", from: 1, to: 2, outFrom: 1, outTo: 2 },
        { input: "inB", name: "RX Studio B", from: 1, to: 2, outFrom: 3, outTo: 4 },
        { input: "inA", name: "RX Studio A", from: 5, to: 6, outFrom: 5, outTo: 6 },
        { input: null, name: null, from: null, to: null, outFrom: 7, outTo: 8 },
    ]);
    // Out of order within one input: a new run each time.
    const swapped = c.buildChannelMapView(io, { map: { mix: { 0: route("inA", 1), 1: route("inA", 0) } } }, lookup);
    assert.deepEqual(c.outputSegments(swapped, swapped.outputs[0]).slice(0, 2).map(s => [s.from, s.to, s.outFrom, s.outTo]), [[2, 2, 1, 1], [1, 1, 2, 2]]);
});

test("where a receiver's channels go, per output", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.deepEqual(c.receiverTargets(v, RXA), [
        { output: "mix", name: "TX Mix", ranges: [[1, 2], [5, 6]] },
        { output: "hp", name: "Headphones", ranges: [[1, 2]] },
    ]);
    assert.deepEqual(c.receiverTargets(v, RXB), [{ output: "mix", name: "TX Mix", ranges: [[3, 4]] }]);
    assert.deepEqual(c.receiverTargets(v, "unknown"), []);
});

test("ranges", () => {
    assert.deepEqual(c.toRanges([5, 1, 2, 3, 3, 8]), [[1, 3], [5, 5], [8, 8]]);
    assert.deepEqual(c.toRanges([]), []);
});

test("a broken answer gives an empty view, not an exception", () => {
    assert.deepEqual(c.buildChannelMapView(null, null, lookup), { inputs: [], outputs: [] });
    assert.deepEqual(c.buildChannelMapView({ inputs: { x: {} }, outputs: { y: { source_id: 5 } } }, {}, lookup),
        { inputs: [{ id: "x", name: "x", deviceName: "", kind: "local", receiverId: null, channels: [], reordering: true, blockSize: 1 }],
          outputs: [{ id: "y", name: "y", deviceName: "", kind: "local", sourceId: null, senderIds: [], channels: [], routable: null, mayMute: true }] });
});

// ----- Step 3: switching -----
const W = (pairs) => pairs.map((p) => p === null ? { input: null, channel: null } : { input: p[0], channel: p[1] });
const now = [["inA", 1], ["inA", 2], ["inB", 1], ["inB", 2], ["inA", 5], ["inA", 6], null, null];

test("caps are part of the view: routable inputs, silent channels, block size, reordering", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.deepEqual(v.outputs.map(o => [o.id, o.routable, o.mayMute]), [["mix", null, true], ["hp", ["inA", "inB"], true]]);
    assert.deepEqual(v.inputs.map(i => [i.id, i.reordering, i.blockSize]), [["inA", true, 1], ["inB", true, 1], ["ana", true, 1], ["far", true, 1]]);
    const strict = c.buildChannelMapView({ inputs: io.inputs, outputs: { hp: { ...io.outputs.hp, caps: { routable_inputs: ["inA"] } } } }, active, lookup);
    assert.deepEqual([strict.outputs[0].routable, strict.outputs[0].mayMute], [["inA"], false]);
});

test("only the channels that change go into the activation, unrouted as two nulls", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    const want = W([["inA", 1], ["inA", 2], ["inB", 3], ["inB", 4], ["inA", 5], ["inA", 6], ["ana", 1], null]);
    assert.deepEqual(c.checkOutputMap(v, "mix", want), []);
    assert.deepEqual(c.mapAction(v, "mix", want), { mix: {
        2: { input: "inB", channel_index: 2 }, 3: { input: "inB", channel_index: 3 }, 6: { input: "ana", channel_index: 0 } } });
    const mute = W([null, ...now.slice(1)]);
    assert.deepEqual(c.mapAction(v, "mix", mute), { mix: { 0: { input: null, channel_index: null } } });
    assert.equal(c.mapAction(v, "mix", W(now)), null);
    assert.deepEqual(c.activationBody({ x: {} }), { activation: { mode: "activate_immediate", requested_time: null }, action: { x: {} } });
});

test("routable_inputs: an input the output does not take, and silence where the device forbids it", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.deepEqual(c.checkOutputMap(v, "hp", W([["ana", 1], ["inA", 2]])),
        ["Analog In cannot feed Headphones: the device does not route that input to this output."]);
    // The device's own current map is never held against a change elsewhere.
    const strict = c.buildChannelMapView({ inputs: io.inputs, outputs: { hp: { ...io.outputs.hp, caps: { routable_inputs: ["inB"] } } } }, active, lookup);
    assert.deepEqual(c.checkOutputMap(strict, "hp", W([["inA", 1], ["inB", 2]])), []);
    assert.deepEqual(c.checkOutputMap(strict, "hp", W([["inA", 1], null])),
        ["Headphones cannot have silent channels (2): the device needs an input on every channel."]);
});

test("block size: whole blocks, aligned to multiples of the size", () => {
    const blocky = { inputs: { ...io.inputs, inA: { ...io.inputs.inA, caps: { reordering: true, block_size: 2 } } }, outputs: io.outputs };
    const v = c.buildChannelMapView(blocky, active, lookup);
    assert.deepEqual(c.checkOutputMap(v, "mix", W(now)), []);
    assert.deepEqual(c.checkOutputMap(v, "mix", W([["inA", 1], ["inB", 2], ["inB", 1], ["inB", 2], ["inA", 5], ["inA", 6], null, null])),
        ["RX Studio A routes in blocks of 2: channels 1–2 go to TX Mix together."]);
    // Channels 2-3 straddle two blocks: both blocks are incomplete.
    assert.equal(c.checkOutputMap(v, "mix", W([["inA", 2], ["inA", 3], ["inB", 1], ["inB", 2], null, null, null, null])).length, 2);
});

test("no reordering: one fixed offset per input within an output", () => {
    const fixed = { inputs: { ...io.inputs, inB: { ...io.inputs.inB, caps: { reordering: false, block_size: 1 } } }, outputs: io.outputs };
    const v = c.buildChannelMapView(fixed, active, lookup);
    assert.deepEqual(c.checkOutputMap(v, "mix", W(now)), []);
    assert.deepEqual(c.checkOutputMap(v, "mix", W([["inA", 1], ["inA", 2], ["inB", 2], ["inB", 1], ["inA", 5], ["inA", 6], null, null])),
        ["RX Studio B cannot reorder: its channels keep their order and spacing in TX Mix."]);
    // Shifted as a whole is fine.
    assert.deepEqual(c.checkOutputMap(v, "mix", W([["inA", 1], ["inA", 2], ["inB", 3], ["inB", 4], ["inA", 5], ["inA", 6], null, null])), []);
});

test("malformed requests: wrong length, half-null, unknown input, channel out of range", () => {
    const v = c.buildChannelMapView(io, active, lookup);
    assert.match(c.checkOutputMap(v, "mix", W([["inA", 1]]))[0], /has 8 channels, 1 were given/);
    assert.match(c.checkOutputMap(v, "nope", W(now))[0], /not in the Channel Map/);
    const bad = W(now); bad[0] = { input: "inA", channel: null };
    assert.match(c.checkOutputMap(v, "mix", bad)[0], /needs a channel/);
    const unknown = W(now); unknown[0] = { input: "zzz", channel: 1 };
    assert.match(c.checkOutputMap(v, "mix", unknown)[0], /input zzz is not in the Channel Map/);
    const far = W(now); far[0] = { input: "ana", channel: 5 };
    assert.match(c.checkOutputMap(v, "mix", far)[0], /Analog In has no channel 5/);
});
