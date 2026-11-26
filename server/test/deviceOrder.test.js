// Run with `npm test`, which compiles first: exercises the compiled helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const o = require("../dist/lib/deviceOrder");

const ids = (devs) => devs.map((d) => d.id);

test("devices order by crosspoint number, not by discovery order", () => {
    // Discovery order as a registry might announce them.
    const devs = [
        { id: "sink1", num: 1009, displayLabel: "Sink 1" },
        { id: "b1", num: 1005, displayLabel: "studio-b - Source 1" },
        { id: "a2", num: 1002, displayLabel: "default - Source 2" },
        { id: "a1", num: 1001, displayLabel: "default - Source 1" },
    ];
    assert.deepEqual(ids(o.sortDevices(devs)), ["a1", "a2", "b1", "sink1"]);
});

test("unnumbered devices go last, in natural label order", () => {
    const devs = [
        { id: "x10", num: -1, displayLabel: "Source 10" },
        { id: "n", num: 1003, displayLabel: "Zulu" },
        { id: "x2", num: -1, displayLabel: "Source 2" },
    ];
    // Natural order, not string order: "Source 2" before "Source 10".
    assert.deepEqual(ids(o.sortDevices(devs)), ["n", "x2", "x10"]);
});

test("equal numbers fall back to the label, then the id", () => {
    const devs = [
        { id: "c", num: 7, displayLabel: "Sink 1" },
        { id: "b", num: 7, displayLabel: "Sink" },
        { id: "a2", num: 7, displayLabel: "Sink" },
    ];
    assert.deepEqual(ids(o.sortDevices(devs)), ["a2", "b", "c"]);
});

test("labels compare as a total order", () => {
    // ComplexCompare puts these three in a cycle, so the sort result
    // depended on the input order.
    const base = [
        { id: "1", num: -1, displayLabel: "a1" },
        { id: "2", num: -1, displayLabel: "a1a" },
        { id: "3", num: -1, displayLabel: "a01b" },
    ];
    const want = ids(o.sortDevices([...base]));
    for (const perm of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        assert.deepEqual(ids(o.sortDevices(perm.map((i) => base[i]))), want);
    }
});

test("the label falls back to alias, then name", () => {
    const devs = [
        { id: "1", num: -1, name: "Beta" },
        { id: "2", num: -1, alias: "Alpha", name: "Zeta" },
    ];
    assert.deepEqual(ids(o.sortDevices(devs)), ["2", "1"]);
});

test("the order does not depend on the input order", () => {
    const base = [
        { id: "a", num: 3, displayLabel: "A" },
        { id: "b", num: -1, displayLabel: "B" },
        { id: "c", num: 1, displayLabel: "C" },
        { id: "d", num: -1, displayLabel: "A" },
    ];
    const want = ["c", "a", "d", "b"];
    assert.deepEqual(ids(o.sortDevices([...base])), want);
    assert.deepEqual(ids(o.sortDevices([...base].reverse())), want);
});

// The worker hands out its next dynamic number; the tests start at 2000.
function fresh() {
    let next = 2000;
    return () => next++;
}

function shadow() {
    return { a: { num: 1000 }, b: { num: 1001 }, c: { num: 1002 } };
}

test("moving onto a number in use swaps the two devices", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "c", 1000, fresh()), true);
    assert.deepEqual(d, { a: { num: 1002 }, b: { num: 1001 }, c: { num: 1000 } });
});

test("moving onto a free number leaves the others alone", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "a", 5, fresh()), true);
    assert.deepEqual(d, { a: { num: 5 }, b: { num: 1001 }, c: { num: 1002 } });
});

test("the number arrives as a string from the UI", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "b", "1002", fresh()), true);
    assert.deepEqual(d, { a: { num: 1000 }, b: { num: 1002 }, c: { num: 1001 } });
});

test("-1 clears the number and moves nobody else", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "b", -1, fresh()), true);
    assert.deepEqual(d, { a: { num: 1000 }, b: { num: -1 }, c: { num: 1002 } });
});

test("an unnumbered device taking a number gives its holder a fresh one", () => {
    // Handing over -1 would leave the holder unselectable by number.
    const d = { a: { num: -1 }, b: { num: 4 } };
    assert.equal(o.moveDeviceNum(d, "a", 4, fresh()), true);
    assert.deepEqual(d, { a: { num: 4 }, b: { num: 2000 } });
});

test("no fresh number is drawn when nobody is displaced", () => {
    let calls = 0;
    const d = { a: { num: -1 }, b: { num: 4 } };
    assert.equal(o.moveDeviceNum(d, "a", 5, () => { calls++; return 2000; }), true);
    assert.equal(calls, 0);
    assert.deepEqual(d, { a: { num: 5 }, b: { num: 4 } });
});

test("no change for the same number, 0, garbage or an unknown device", () => {
    for (const [id, num] of [["a", 1000], ["a", 0], ["a", -5], ["a", "x"], ["a", "9".repeat(20)], ["zz", 3]]) {
        const d = shadow();
        assert.equal(o.moveDeviceNum(d, id, num, fresh()), false, `${id} -> ${num}`);
        assert.deepEqual(d, shadow());
    }
});

// ----- Flows within a device, view ranks, drag & drop -----
const o2 = require("../dist/lib/deviceOrder.js");

test("flows of a device sort by the name shown, naturally, per type", () => {
    const dev = { senders: { audio: [
        { id: "c", name: "Ch 10" }, { id: "a", name: "Ch 2" }, { id: "b", name: "zzz", alias: "Ch 1" },
    ], video: [] }, receivers: { video: [{ id: "y", name: "B" }, { id: "x", name: "a" }] } };
    o2.sortDeviceFlows(dev);
    assert.deepEqual(dev.senders.audio.map(f => f.id), ["b", "a", "c"]);
    assert.deepEqual(dev.receivers.video.map(f => f.id), ["x", "y"]);
});

test("view ranks: by name, and by essence then number", () => {
    const devs = [
        { id: "1", num: 1, displayLabel: "Zeta", senders: { audio: [{}] }, receivers: {} },
        { id: "2", num: 2, displayLabel: "alpha", senders: { video: [{}] }, receivers: {} },
        { id: "3", num: 3, displayLabel: "Beta", senders: {}, receivers: { data: [{}] } },
        { id: "4", num: 4, displayLabel: "Gamma", senders: { audio: [{}] }, receivers: { video: [{}] } },
    ];
    const r = o2.viewRanks(devs);
    assert.deepEqual(["1", "2", "3", "4"].map(id => r[id].name), [3, 0, 1, 2]);
    assert.deepEqual(["1", "2", "3", "4"].map(id => r[id].type), [2, 0, 3, 1]);
});

const seq = (spec) => spec.split(" ").map(s => { const [id, n] = s.split(":"); return { id, num: Number(n) }; });

test("a moved device takes a free number in the gap and touches nothing else", () => {
    assert.deepEqual(o2.placeDevices(seq("A:10 B:20 C:30"), ["C"], "B"), { C: 11 });
    assert.deepEqual(o2.placeDevices(seq("A:10 B:20 C:30"), ["A"], null), { A: 31 });
    // already where it would go: nothing changes
    assert.deepEqual(o2.placeDevices(seq("A:10 B:20 C:30"), ["B"], "C"), {});
});

test("without a gap the devices behind it move up only as far as needed", () => {
    assert.deepEqual(o2.placeDevices(seq("A:1 B:2 C:3 D:4 E:9"), ["D"], "B"), { D: 2, B: 3, C: 4 });
    assert.deepEqual(o2.placeDevices(seq("A:1 B:2 C:3"), ["C"], "A"), { C: 1, A: 2, B: 3 });
});

test("a node moves as a block and keeps its inner order", () => {
    // node N = (N1, N2) from the end to the front
    assert.deepEqual(o2.placeDevices(seq("A:1000 B:1001 N1:1002 N2:1003"), ["N1", "N2"], "A"),
        { N1: 1, N2: 2 });
    // behind B (30) the block needs numbers above 30, below C (40)
    assert.deepEqual(o2.placeDevices(seq("A:10 N1:20 N2:21 B:30 C:40"), ["N1", "N2"], "C"), { N1: 31, N2: 32 });
    // a block that is already in place keeps its numbers
    assert.deepEqual(o2.placeDevices(seq("A:10 N1:20 N2:21 B:30"), ["N1", "N2"], "B"), {});
});

test("unnumbered devices in front of the block get numbers, ones behind stay", () => {
    // B needs a number below A's 5; A keeps its own
    assert.deepEqual(o2.placeDevices(seq("A:5 B:-1 C:-1"), ["A"], "C"), { B: 1 });
    assert.deepEqual(o2.placeDevices(seq("A:5 B:-1 C:-1"), ["C"], "B"), { C: 6 });
});

test("a move that makes no sense changes nothing", () => {
    assert.equal(o2.placeDevices(seq("A:1 B:2"), ["X"], null), null);
    assert.equal(o2.placeDevices(seq("A:1 B:2"), ["A"], "A"), null);
    assert.equal(o2.placeDevices(seq("A:1 B:2"), ["A"], "nope"), null);
});
