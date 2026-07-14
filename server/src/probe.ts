/*
 * NMOS Crosspoint — Multicast Probe (crosspoint_probe)
 *
 * Tiny companion process for hosts attached to the media network. It
 * connects OUT to the crosspoint server, waits for join/leave commands
 * and forwards the multicast RTP packets as unicast over the websocket
 * (binary frames: [2 byte BE stream id][raw UDP payload]).
 *
 * Deliberately dumb: no NMOS, no decoding, no config file. Environment:
 *   CROSSPOINT_URL   ws://crosspoint-host[:port]      (required; /probe is
 *                    appended automatically when no path is given)
 *   PROBE_TOKEN      shared token from the Setup page  (required)
 *   PROBE_NAME       display name, e.g. "Studio A"     (default: hostname)
 *   PROBE_IFACE      local interface IP for the IGMP joins (default: OS pick)
 */

import * as WebSocket from "ws";
import * as dgram from "dgram";
import * as os from "os";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 30000;
// Stop queueing frames into a stalled websocket: monitoring audio is
// disposable, memory is not.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function log(msg: string) {
    console.log(new Date().toISOString() + "  " + msg);
}

let url = ("" + (process.env.CROSSPOINT_URL || "")).trim();
const token = ("" + (process.env.PROBE_TOKEN || "")).trim();
const name = ("" + (process.env.PROBE_NAME || "")).trim() || os.hostname();
const iface = ("" + (process.env.PROBE_IFACE || "")).trim();

if (!url || !token) {
    console.error("crosspoint_probe: CROSSPOINT_URL and PROBE_TOKEN are required.");
    console.error("  docker run --network host -e MODE=probe -e CROSSPOINT_URL=ws://<crosspoint> -e PROBE_TOKEN=<token> [-e PROBE_NAME=\"Studio A\"] [-e PROBE_IFACE=<ip>] gemini2350/nmos-crosspoint_v3");
    process.exit(1);
}
url = url.replace(/^http/, "ws");
try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === "/") u.pathname = "/probe";
    url = u.toString();
} catch (e) {
    console.error("crosspoint_probe: invalid CROSSPOINT_URL: " + url);
    process.exit(1);
}

interface StreamEntry { socket: dgram.Socket; multicast: string; port: number; }
const streams: Map<number, StreamEntry> = new Map();

function leaveAll() {
    for (const [id, s] of Array.from(streams)) {
        try { s.socket.dropMembership(s.multicast, iface || undefined); } catch (e) {}
        try { s.socket.close(); } catch (e) {}
        streams.delete(id);
    }
}

function joinStream(ws: any, id: number, multicast: string, port: number) {
    if (streams.has(id)) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (e) => {
        try { ws.send(JSON.stringify({ type: "error", id, message: "socket error: " + e.message })); } catch (err) {}
        try { socket.close(); } catch (err) {}
        streams.delete(id);
    });
    socket.bind(port, () => {
        try {
            socket.addMembership(multicast, iface || undefined);
            log("joined " + multicast + ":" + port + " (stream " + id + ")");
        } catch (e: any) {
            try { ws.send(JSON.stringify({ type: "error", id, message: "could not join " + multicast + ": " + (e?.message || e) })); } catch (err) {}
            try { socket.close(); } catch (err) {}
            streams.delete(id);
            return;
        }
    });
    socket.on("message", (pkt: Buffer) => {
        if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
        const frame = Buffer.allocUnsafe(2 + pkt.length);
        frame.writeUInt16BE(id, 0);
        pkt.copy(frame, 2);
        try { ws.send(frame, { binary: true }); } catch (e) {}
    });
    streams.set(id, { socket, multicast, port });
}

function leaveStream(id: number) {
    const s = streams.get(id);
    if (!s) return;
    try { s.socket.dropMembership(s.multicast, iface || undefined); } catch (e) {}
    try { s.socket.close(); } catch (e) {}
    streams.delete(id);
    log("left " + s.multicast + ":" + s.port + " (stream " + id + ")");
}

let backoff = RECONNECT_MIN_MS;
function connect() {
    log("connecting to " + url + " as \"" + name + "\"");
    const ws: any = new WebSocket(url, { handshakeTimeout: 5000 });
    let pingTimer: any = null;
    let lastPong = Date.now();

    ws.on("open", () => {
        backoff = RECONNECT_MIN_MS;
        ws.send(JSON.stringify({ type: "hello", token, name }));
        lastPong = Date.now();
        pingTimer = setInterval(() => {
            if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
                log("pong timeout — reconnecting");
                try { ws.terminate(); } catch (e) {}
                return;
            }
            try { ws.ping(); } catch (e) {}
        }, PING_INTERVAL_MS);
    });
    ws.on("pong", () => { lastPong = Date.now(); });
    ws.on("message", (data: any, isBinary: boolean) => {
        if (isBinary) return;
        let msg: any;
        try { msg = JSON.parse("" + data); } catch (e) { return; }
        if (msg?.type === "welcome") { log("connected and authenticated"); return; }
        if (msg?.type === "join" && typeof msg.id === "number" && typeof msg.multicast === "string" && msg.port) {
            joinStream(ws, msg.id, msg.multicast, Number(msg.port));
        }
        if (msg?.type === "leave" && typeof msg.id === "number") {
            leaveStream(msg.id);
        }
    });
    ws.on("close", () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        leaveAll();
        log("disconnected — retrying in " + Math.round(backoff / 1000) + "s");
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    });
    ws.on("error", (e: any) => {
        log("connection error: " + (e?.message || e));
        /* close follows */
    });
}

log("crosspoint_probe starting (iface=" + (iface || "default") + ")");
connect();
