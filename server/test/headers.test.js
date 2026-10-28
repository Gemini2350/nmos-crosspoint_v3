// Request header size the web server accepts. A browser sends every cookie set
// for the parent domain with each request, which can pass Node's 16 KiB default.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { WebsocketSyncServer } = require("../dist/lib/SyncServer/websocketSyncServer.js");

// A Cookie header of about `bytes`, in cookies of the size a session or token
// cookie has.
function cookies(bytes) {
    const parts = [];
    for (let i = 0; bytes > 0; i++) {
        const n = Math.min(bytes, 400);
        parts.push("c" + i + "=" + "v".repeat(n));
        bytes -= n;
    }
    return parts.join("; ");
}

function get(port, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/headers-probe", headers: { cookie } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
    });
}

test("a request carrying 24 KiB of cookies is served, one past 64 KiB is refused", async () => {
    WebsocketSyncServer.init("127.0.0.1", 0, (app) => app.get("/headers-probe", (req, res) => res.send("ok")));
    const server = WebsocketSyncServer.getInstance().httpServer;
    await new Promise((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    try {
        const port = server.address().port;
        assert.equal(await get(port, cookies(1024)), 200);
        assert.equal(await get(port, cookies(24 * 1024)), 200);
        assert.equal(await get(port, cookies(60 * 1024)), 200);
        assert.equal(await get(port, cookies(70 * 1024)), 431);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
