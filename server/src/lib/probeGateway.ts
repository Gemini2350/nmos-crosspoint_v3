/*
 * NMOS Crosspoint — Probe Gateway
 *
 * Server side of the multicast probe: a tiny companion container
 * (crosspoint_probe) runs on a host attached to the media network,
 * connects OUT to this server on ws://<crosspoint>/probe and forwards
 * multicast RTP as unicast. That way the crosspoint container itself
 * never needs multicast access — unusual for Docker hosts.
 *
 * Protocol (probe ↔ gateway, one websocket):
 *   probe → gateway   {type:"hello", token, name}          first message, auth
 *   gateway → probe   {type:"welcome"}                     auth OK
 *   gateway → probe   {type:"join",  id, multicast, port}  start forwarding
 *   gateway → probe   {type:"leave", id}                   stop forwarding
 *   probe → gateway   binary frame: [2 byte BE stream id][raw UDP payload]
 *   probe → gateway   {type:"error", id, message}          join failed etc.
 *
 * Liveness: RFC 6455 ping/pong both ways (same pattern as the IS-12 and
 * query-API connections — 15 s ping, 30 s pong timeout).
 */

import * as WebSocket from "ws";
import { SyncLog } from "./syncLog";
import { SyncObject } from "./SyncServer/syncObject";
import { WebsocketSyncServer } from "./SyncServer/websocketSyncServer";

const PING_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 30000;
const HELLO_TIMEOUT_MS = 5000;

interface ProbeEntry {
    ws: any;
    name: string;
    address: string;
    connectedAt: string;
    streams: Map<number, (payload: Buffer) => void>;
    pingTimer: any;
    lastPong: number;
}

export class ProbeGateway {
    public static instance: ProbeGateway | null = null;

    private probes: Set<ProbeEntry> = new Set();
    private streamSeq = 1;
    private token = "";
    public syncProbes: SyncObject;

    constructor(token: string) {
        ProbeGateway.instance = this;
        this.token = token;
        this.syncProbes = new SyncObject("probeState", this.buildState());

        const wss = new WebSocket.Server({ noServer: true });
        WebsocketSyncServer.getInstance().addUpgradePath("/probe", (request, socket, head) => {
            wss.handleUpgrade(request, socket, head, (ws: any) => {
                this.handleConnection(ws, request);
            });
        });
    }

    setToken(token: string) {
        this.token = token;
        this.publishState();
    }

    /** True when at least one authenticated probe is connected. */
    hasProbe(): boolean {
        return this.probes.size > 0;
    }

    /**
     * Ask a probe to join a multicast group and forward its packets. Picks
     * the probe with the fewest active streams. Returns a handle whose
     * close() sends the leave and unregisters — or null when no probe is
     * connected.
     */
    join(multicast: string, port: number, onPacket: (payload: Buffer) => void): { probeName: string, close: () => void } | null {
        let best: ProbeEntry | null = null;
        for (const p of Array.from(this.probes)) {
            if (!best || p.streams.size < best.streams.size) best = p;
        }
        if (!best) return null;
        const probe = best;
        const id = (this.streamSeq++) & 0xFFFF;
        probe.streams.set(id, onPacket);
        try { probe.ws.send(JSON.stringify({ type: "join", id, multicast, port })); } catch (e) {}
        SyncLog.log("info", "Probe", "Stream " + id + " (" + multicast + ":" + port + ") → probe \"" + probe.name + "\"");
        this.publishState();
        return {
            probeName: probe.name,
            close: () => {
                if (!probe.streams.delete(id)) return;
                try { probe.ws.send(JSON.stringify({ type: "leave", id })); } catch (e) {}
                this.publishState();
            }
        };
    }

    private handleConnection(ws: any, request: any) {
        const address = "" + (request?.socket?.remoteAddress || "");
        let entry: ProbeEntry | null = null;

        // First message must be the hello with the correct token.
        const helloTimer = setTimeout(() => {
            try { ws.close(); } catch (e) {}
        }, HELLO_TIMEOUT_MS);

        ws.on("message", (data: any, isBinary: boolean) => {
            if (entry && isBinary) {
                // [2 byte BE stream id][raw UDP payload]
                const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (buf.length < 3) return;
                const id = buf.readUInt16BE(0);
                const cb = entry.streams.get(id);
                if (cb) { try { cb(buf.slice(2)); } catch (e) {} }
                return;
            }
            let msg: any;
            try { msg = JSON.parse("" + data); } catch (e) { return; }
            if (!entry) {
                if (msg?.type !== "hello" || !this.token || msg.token !== this.token) {
                    SyncLog.log("warn", "Probe", "Rejected probe connection from " + address + " (bad or missing token).");
                    try { ws.close(); } catch (e) {}
                    return;
                }
                clearTimeout(helloTimer);
                entry = {
                    ws,
                    name: ("" + (msg.name || "probe")).substring(0, 64),
                    address,
                    connectedAt: new Date().toISOString(),
                    streams: new Map(),
                    pingTimer: null,
                    lastPong: Date.now(),
                };
                this.probes.add(entry);
                try { ws.on("pong", () => { if (entry) entry.lastPong = Date.now(); }); } catch (e) {}
                entry.pingTimer = setInterval(() => {
                    if (!entry) return;
                    if (Date.now() - entry.lastPong > PONG_TIMEOUT_MS) {
                        SyncLog.log("warn", "Probe", "Pong timeout for probe \"" + entry.name + "\" — terminating.");
                        try { ws.terminate(); } catch (e) {}
                        return;
                    }
                    try { ws.ping(); } catch (e) {}
                }, PING_INTERVAL_MS);
                try { ws.send(JSON.stringify({ type: "welcome" })); } catch (e) {}
                SyncLog.log("info", "Probe", "Probe \"" + entry.name + "\" connected from " + address + ".");
                this.publishState();
                return;
            }
            if (msg?.type === "error") {
                SyncLog.log("warn", "Probe", "Probe \"" + entry.name + "\" reported: " + (msg.message || "unknown error") + (msg.id ? " (stream " + msg.id + ")" : ""));
            }
        });

        ws.on("close", () => {
            clearTimeout(helloTimer);
            if (!entry) return;
            if (entry.pingTimer) { clearInterval(entry.pingTimer); entry.pingTimer = null; }
            this.probes.delete(entry);
            SyncLog.log("info", "Probe", "Probe \"" + entry.name + "\" disconnected" + (entry.streams.size ? " — " + entry.streams.size + " active stream(s) lost (listeners keep running, audio pauses until resubscribe)." : "."));
            entry = null;
            this.publishState();
        });
        ws.on("error", () => { /* close follows */ });
    }

    private buildState() {
        return {
            token: this.token,
            probes: Array.from(this.probes).map((p) => ({
                name: p.name,
                address: p.address,
                connectedAt: p.connectedAt,
                streams: p.streams.size,
            })),
        };
    }

    private publishState() {
        try { this.syncProbes.setState(this.buildState()); } catch (e) {}
    }
}
