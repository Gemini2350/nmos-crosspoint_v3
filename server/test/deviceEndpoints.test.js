// One device API under several hrefs: which one is asked, when the next one
// is tried, and that a dead href is given up on quickly.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const axios = require("axios");
const d = require("../dist/lib/deviceEndpoints.js");

const A = "http://10.0.0.1/x-nmos/connection/v1.1/";
const B = "http://192.168.0.1/x-nmos/connection/v1.1/";
const C = "http://dev.example/x-nmos/connection/v1.1/";

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const answered = (status) => Object.assign(new Error("Request failed with status code " + status), { code: "ERR_BAD_RESPONSE", response: { status, data: { code: status, error: "no" } } });

test("the device's order, until an href has answered", () => {
    const m = new d.EndpointMemory();
    assert.deepEqual(m.order("k", [A, B, C]), [A, B, C]);
    m.remember("k", B);
    assert.deepEqual(m.order("k", [A, B, C]), [B, A, C]);
    // No longer advertised: the device's order again.
    assert.deepEqual(m.order("k", [A, C]), [A, C]);
    // Per key.
    assert.deepEqual(m.order("other", [A, B]), [A, B]);
});

test("an unreachable href is skipped, the one that answers is asked first next time", async () => {
    const m = new d.EndpointMemory();
    const asked = [], notes = [];
    const request = async (href) => { asked.push(href); if (href === A) throw refused(); return "ok from " + href; };
    assert.equal(await d.tryEndpoints(m, "IS-05 dev", [A, B, C], request, (n) => notes.push(n)), "ok from " + B);
    assert.deepEqual(asked, [A, B]);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /10\.0\.0\.1.*ECONNREFUSED.*not reachable, using http:\/\/192\.168\.0\.1/);

    asked.length = 0;
    assert.equal(await d.tryEndpoints(m, "IS-05 dev", [A, B, C], request, (n) => notes.push(n)), "ok from " + B);
    assert.deepEqual(asked, [B]);
    assert.equal(notes.length, 1, "nothing new to say");
});

test("a device that answered with an error is not asked again elsewhere", async () => {
    const m = new d.EndpointMemory();
    const asked = [];
    const request = async (href) => { asked.push(href); throw answered(500); };
    await assert.rejects(d.tryEndpoints(m, "k", [A, B], request), (e) => e.response.status === 500 && !d.allUnreachable(e));
    assert.deepEqual(asked, [A]);
    // It reached the device: kept as the href to use.
    assert.equal(m.lastFor("k"), A);
});

test("a fault of our own is not taken for an unreachable href", async () => {
    const m = new d.EndpointMemory();
    const asked = [];
    await assert.rejects(d.tryEndpoints(m, "k", [A, B], async (href) => { asked.push(href); throw new TypeError("bug"); }), TypeError);
    assert.deepEqual(asked, [A]);
    assert.equal(m.lastFor("k"), undefined);
});

test("none reachable: the last connection error, marked and listing what was tried", async () => {
    const m = new d.EndpointMemory();
    await assert.rejects(d.tryEndpoints(m, "k", [A, B], async () => { throw refused(); }), (e) => {
        assert.equal(d.allUnreachable(e), true);
        assert.equal(e.code, "ECONNREFUSED");
        assert.equal(e.tried.length, 2);
        return true;
    });
    await assert.rejects(d.tryEndpoints(m, "k", [], async () => "never"), (e) => d.allUnreachable(e));
});

test("a socket that does not connect is given up with ETIMEDOUT", async () => {
    // TEST-NET-1 (RFC 5737) is never routed: the connect hangs or fails at once.
    const socket = net.connect({ host: "192.0.2.1", port: 9 });
    const started = Date.now();
    d.guardConnect(socket, 300);
    const err = await new Promise((resolve) => socket.on("error", resolve));
    assert.ok(Date.now() - started < 2000, "gave up after " + (Date.now() - started) + " ms");
    assert.ok(["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(err.code), err.code);
});

test("a connected socket is left alone, however long the answer takes", async () => {
    const server = http.createServer((q, r) => setTimeout(() => r.end("late"), 500));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const socket = net.connect({ host: "127.0.0.1", port: server.address().port });
        d.guardConnect(socket, 100);
        socket.write("GET / HTTP/1.0\r\n\r\n");
        let got = "";
        socket.on("data", (c) => got += c);
        await new Promise((resolve, reject) => { socket.on("end", resolve); socket.on("error", reject); });
        assert.match(got, /late$/);
    } finally {
        server.close();
    }
});

test("requests to a device go through the agent that gives up the connect", async () => {
    const server = http.createServer((q, r) => r.end("{}"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const r = await axios.get("http://127.0.0.1:" + server.address().port + "/", d.deviceRequest(10000));
        assert.equal(r.status, 200);
    } finally {
        server.close();
    }
    const started = Date.now();
    await assert.rejects(axios.get("http://192.0.2.1:9/", d.deviceRequest(10000)), (e) => {
        assert.ok(["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(e.code), e.code);
        return true;
    });
    assert.ok(Date.now() - started < d.CONNECT_TIMEOUT_MS + 1500, "gave up after " + (Date.now() - started) + " ms");
});
