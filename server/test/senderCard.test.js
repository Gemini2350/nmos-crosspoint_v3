// Run with `npm test`, after `npm run build`: the sender hover card.
const test = require("node:test");
const assert = require("node:assert/strict");
const { senderCard, CARD_RECEIVERS } = require("../dist/lib/senderCard");

const base = (o = {}) => ({
    available: true, active: true, transport: "rtp",
    format: "1920x1080p50 BT709 SDR", codec: "RAW", bitrate: { v: 2203.9456, hint: "ok" },
    manifestOk: true,
    legs: [{ index: 0, dstIp: "239.50.0.10", dstPort: 5004, srcIp: "10.9.9.9" }],
    mxl: null, is07: null, receivers: [], bcp008Enabled: true, monitor: null,
    ...o,
});
const row = (card, k) => card.rows.find((r) => r.k === k);

test("a sender without BCP-008: active state, format, multicast, says nothing monitors it", () => {
    const c = senderCard(base({ receivers: ["Multiviewer / MV In 2"] }));
    assert.equal(c.state, "Active");
    assert.equal(c.tone, "on");
    assert.equal(row(c, "Format").v, "1920x1080p50 · RAW · 2.20 Gbit/s");
    assert.deepEqual(row(c, "Multicast"), { k: "Multicast", v: "239.50.0.10:5004 ← 10.9.9.9", tone: "mono" });
    assert.equal(row(c, "Receivers").v, "Multiviewer / MV In 2");
    assert.deepEqual(row(c, "Health"), { k: "Health", v: "not monitored (no BCP-008)", tone: "dim" });
});

test("inactive, no receivers; with BCP-008 switched off in Setup there is no health row", () => {
    const c = senderCard(base({ active: false, bcp008Enabled: false }));
    assert.equal(c.state, "Inactive");
    assert.equal(c.tone, "off");
    assert.deepEqual(row(c, "Receivers"), { k: "Receivers", v: "none", tone: "dim" });
    assert.equal(row(c, "Health"), undefined);
});

test("a BCP-008 sender: the device's state, and its message only while something is wrong", () => {
    const warn = senderCard(base({ monitor: { status: 2, message: "Link: eth1 down" } }));
    assert.equal(warn.state, "Partially healthy");
    assert.equal(warn.tone, "warn");
    assert.deepEqual(row(warn, "Message"), { k: "Message", v: "Link: eth1 down", tone: "warn" });
    assert.equal(row(warn, "Health"), undefined);
    // A healthy device keeps its last message until a reset: not shown.
    const ok = senderCard(base({ monitor: { status: 1, message: "Previously: no essence" } }));
    assert.equal(ok.state, "Healthy");
    assert.equal(ok.tone, "ok");
    assert.equal(row(ok, "Message"), undefined);
    assert.equal(senderCard(base({ monitor: { status: 3, message: "x" } })).rows.at(-1).tone, "err");
    // BCP-008 switched off: the monitor is not shown even if one is known.
    assert.equal(senderCard(base({ bcp008Enabled: false, monitor: { status: 3, message: "x" } })).state, "Active");
});

test("2022-7 legs, a duplicate group, an unreadable SDP, unicast", () => {
    const c = senderCard(base({
        manifestOk: false,
        legs: [
            { index: 0, dstIp: "239.50.0.17", dstPort: 5004, srcIp: "10.9.9.9", dup: true, dupText: "Camera 2 / Cam 2 Video" },
            { index: 1, dstIp: "239.60.0.17", dstPort: 5004, srcIp: "" },
        ],
    }));
    assert.equal(row(c, "Leg 1").v, "239.50.0.17:5004 ← 10.9.9.9");
    assert.equal(row(c, "Leg 2").v, "239.60.0.17:5004");
    assert.deepEqual(row(c, "Duplicate"), { k: "Duplicate", v: "239.50.0.17 also sent by Camera 2 / Cam 2 Video", tone: "warn" });
    assert.deepEqual(row(c, "SDP"), { k: "SDP", v: "not readable", tone: "warn" });
    assert.equal(row(senderCard(base({ legs: [{ index: 0, dstIp: "10.1.2.3", dstPort: 5004, srcIp: "" }] })), "Unicast").v, "10.1.2.3:5004");
});

test("MXL and IS-07 senders show their endpoint instead of addresses; no SDP warning", () => {
    const m = senderCard(base({ transport: "mxl", legs: [], manifestOk: true, mxl: { domainId: "dom", flowId: "f1" } }));
    assert.equal(row(m, "MXL flow").v, "f1");
    assert.equal(row(m, "Domain").v, "dom");
    assert.equal(row(m, "Multicast"), undefined);
    const e = senderCard(base({ transport: "websocket", legs: [], format: "", codec: "", bitrate: { v: 0, hint: "unknown" }, is07: { tag: "WS", host: "10.0.0.5:80" } }));
    assert.equal(row(e, "Events").v, "WS 10.0.0.5:80");
    assert.equal(row(e, "Format"), undefined);
});

test("long receiver lists end in '+ N more'; an unavailable sender only says so", () => {
    const many = Array.from({ length: 7 }, (_, n) => "Dev / Rx " + (n + 1));
    const c = senderCard(base({ receivers: many }));
    const names = c.rows.filter((r) => r.k === "Receivers" || (r.k === "" && !r.tone));
    assert.equal(names.length, CARD_RECEIVERS - 1);
    assert.deepEqual(c.rows.at(-2), { k: "", v: "+ " + (7 - (CARD_RECEIVERS - 1)) + " more", tone: "dim" });
    const exact = senderCard(base({ receivers: many.slice(0, CARD_RECEIVERS) }));
    assert.equal(exact.rows.filter((r) => r.v.startsWith("Dev / Rx")).length, CARD_RECEIVERS);
    const gone = senderCard(base({ available: false, format: "", codec: "", bitrate: { v: 0, hint: "unknown" }, legs: [] }));
    assert.equal(gone.state, "Unavailable");
    assert.equal(gone.rows.length, 0);
    // A bitrate at an estimated maximum (JPEG XS) says so.
    assert.match(row(senderCard(base({ bitrate: { v: 150, hint: "max" } })), "Format").v, /≤ 150\.0 Mbit\/s$/);
});
