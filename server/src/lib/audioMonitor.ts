/*
 * NMOS Crosspoint — Audio Monitor service (experimental)
 *
 * Listen to a multicast ST 2110-30 / AES67 sender on the server, transcode
 * the PCM to Opus, and stream it to one or more browsers via WebRTC. Used
 * for in-UI headphone monitoring of any sender that's currently published
 * on the network.
 *
 * Pipeline:
 *
 *   ┌──────────┐  RTP   ┌────────────┐ PCM  ┌────────────┐ Opus  ┌──────────┐
 *   │ dgram UDP│──────▶│ Depacketize │─────▶│ Opus encode│──────▶│ per-     │
 *   │ + IGMP   │       │  L16/L24/L32│      │ 48k stereo │       │ consumer │
 *   │          │       │  channel    │      │ 20 ms      │       │ writeRtp │
 *   │          │       │  picker     │      │ frames     │       │          │
 *   └──────────┘       └─────────────┘      └────────────┘       └──────────┘
 *                                                                      │
 *                                                                      ▼
 *                            werift MediaStreamTrack → DTLS/SRTP → browser
 *
 * One Producer per `senderId`. Multiple Consumers per Producer (SFU
 * style — encoder runs once, RTP packets are fan-outed). When the last
 * Consumer leaves, the Producer drops IGMP membership and closes.
 *
 * The implementation uses two optional native dependencies. They are
 * resolved with a lazy `require()` so the service skeleton compiles and
 * the WS routes stay reachable even if the host is missing them; in that
 * case subscribe() returns { ok:false, error:"…" }.
 *
 *   • @discordjs/opus  – Opus encoder
 *   • werift           – pure-Node WebRTC stack
 *
 * Supported audio:
 *   • L16 / L24 / L32 PCM (AES67 / ST 2110-30)
 *   • Sample rates: 48000 Hz (no resampler; we error out otherwise)
 *   • Source channel count: any; the operator picks a stereo pair
 *
 * Not yet:
 *   • Sample-rate conversion (44.1 / 96 kHz sources rejected for now)
 *   • Channel switch without re-subscribing (set in subscribe args)
 *   • PTP-aware playout (we just buffer the latest packets and pump)
 */

import * as dgram from "dgram";
import * as sdpTransform from "sdp-transform";
import { SyncLog } from "./syncLog";


// ---------- Optional deps ----------
let _werift: any = null;
let _opus: any   = null;
function tryLoadDeps(): boolean {
    if (_werift && _opus) return true;
    try {
        if (!_werift) _werift = require("werift");
        if (!_opus)   _opus   = require("@discordjs/opus");
        return !!(_werift && _opus);
    } catch (e: any) {
        SyncLog.log("warn", "AudioMonitor", "Optional deps not installed (werift / @discordjs/opus): " + (e?.message || e));
        return false;
    }
}


// ---------- Types ----------

export interface SubscribeArgs {
    senderId:   string;
    listenerId: string;
    sdp:        string;
    channels?:  [number, number];
    iface?:     string;
}

interface ParsedSdp {
    multicast:  string;
    port:       number;
    encoding:   "L16" | "L24" | "L32";
    sampleRate: number;
    channels:   number;
}

interface ProducerEntry {
    senderId:   string;
    sdpParams:  ParsedSdp;
    udpSocket:  dgram.Socket;
    listeners:  Set<string>;
    pickL:      number;          // channel index for left
    pickR:      number;          // channel index for right

    // ----- Encoder + pump -----
    opusEncoder: any;            // OpusEncoder instance (48000, 2)

    /**
     * Rolling stereo PCM buffer, interleaved Int16 L,R,L,R,…
     * Sized for ~200 ms of audio (= 9600 frames × 2 ch × 2 bytes = 38 KB).
     * Writes wrap at the end (ring) and `availableSamples` tracks how many
     * stereo frames the consumer side can pull.
     */
    pcm: Int16Array;
    pcmCap:       number;        // capacity in frames (per-channel)
    pcmWrite:     number;        // next write index (frames)
    pcmRead:      number;        // next read index (frames)
    pcmAvail:     number;        // frames buffered

    // ----- Outgoing RTP state -----
    rtpSeq:  number;
    rtpTs:   number;
    rtpSsrc: number;
    payloadType: number;         // dynamic — picked from the answer SDP

    pumpTimer:  any;
    started:    boolean;
}

interface ConsumerEntry {
    listenerId: string;
    senderId:   string;
    pc:         any;             // werift RTCPeerConnection
    track:      any;             // werift MediaStreamTrack (audio sendonly)
    payloadType?: number;        // negotiated Opus PT (from the answer)
    // Trickled-out ICE candidates buffer. The browser polls via the
    // `audioMonitorIceServer` route — we accumulate here and drain.
    pendingServerIce: any[];
}


const FRAME_MS         = 20;     // 20 ms Opus frame
const SAMPLE_RATE      = 48000;
const FRAME_SAMPLES    = SAMPLE_RATE * FRAME_MS / 1000;   // 960
const PCM_CAP_FRAMES   = 9600;   // ~200 ms ring buffer



// ---------- Service ----------

export class AudioMonitorService {
    private static _instance: AudioMonitorService | null = null;
    public static get instance(): AudioMonitorService | null { return this._instance; }

    private producers: Map<string, ProducerEntry> = new Map();
    private consumers: Map<string, ConsumerEntry> = new Map();
    // WS-Client → Set seiner aktiven listenerIds. Damit kann der Server
    // bei WS-Disconnect (Browser-Tab geschlossen, Netzwerkabbruch)
    // sofort alle zugehörigen Consumer abräumen, ohne auf werift's
    // DTLS-Keepalive-Timeout (~30 s) zu warten.
    private clientListeners: WeakMap<object, Set<string>> = new WeakMap();
    public registerListenerForClient(client: any, listenerId: string){
        let s = this.clientListeners.get(client);
        if (!s) { s = new Set(); this.clientListeners.set(client, s); }
        s.add(listenerId);
    }
    public unregisterListener(listenerId: string){
        // WeakMap erlaubt keine iteration — wir verlassen uns drauf, dass
        // unsubscribe() vom Sub-Pfad denselben listenerId mit removed wird.
        // Nichts zusätzliches zu tun, der Eintrag wird beim nächsten
        // wsClient-Lookup einfach übersprungen falls dort noch drin.
        // (Vollständiger cleanup: in subscribe-Map ebenfalls löschen.)
    }
    /** Tear down all listeners belonging to a WS client. */
    async dropWsClient(client: any): Promise<void> {
        const s = this.clientListeners.get(client);
        if (!s) return;
        const ids = Array.from(s);
        this.clientListeners.delete(client);
        for (const lid of ids) {
            try { await this.unsubscribe(lid); } catch (e) {}
        }
    }

    constructor() {
        AudioMonitorService._instance = this;
        tryLoadDeps();
    }

    isAvailable(): boolean { return tryLoadDeps(); }


    // ===== SDP =====

    static parseSdpForMonitor(sdpText: string): ParsedSdp {
        const parsed = sdpTransform.parse(sdpText);
        const audio = (parsed.media || []).find(m => m.type === "audio");
        if (!audio) throw new Error("SDP has no audio media section");

        const rtp = (audio.rtp || [])[0];
        if (!rtp) throw new Error("SDP audio has no rtpmap");
        const codec = (rtp.codec || "").toUpperCase();
        if (codec !== "L16" && codec !== "L24" && codec !== "L32") {
            throw new Error("Unsupported audio codec for monitoring: " + codec);
        }
        const sampleRate = Number(rtp.rate) || 0;
        const channels   = Number(rtp.encoding) || 0;
        if (!sampleRate || !channels) throw new Error("SDP rtpmap missing rate / channels");
        if (sampleRate !== SAMPLE_RATE) {
            throw new Error("Only 48000 Hz sources supported by the monitor (got " + sampleRate + ")");
        }

        let group = "";
        if (audio.connection && audio.connection.ip)          group = audio.connection.ip.split("/")[0];
        else if (parsed.connection && parsed.connection.ip)   group = parsed.connection.ip.split("/")[0];
        if (!group) throw new Error("SDP has no connection IP");

        const port = Number(audio.port) || 5004;
        return { multicast: group, port, encoding: codec, sampleRate, channels };
    }


    // ===== Producer lifecycle =====

    private bytesPerSample(enc: ParsedSdp["encoding"]): number {
        return enc === "L16" ? 2 : enc === "L24" ? 3 : 4;
    }

    /**
     * Convert one big-endian PCM word to a normalised Int16 sample
     * (clipping to the 16-bit range so the encoder gets clean material
     * even when the source is 24/32-bit).
     */
    private pcmWordToInt16(buf: Buffer, offset: number, enc: ParsedSdp["encoding"]): number {
        let v32 = 0;
        if (enc === "L16") {
            v32 = buf.readInt16BE(offset);
            return v32;
        }
        if (enc === "L24") {
            const b0 = buf[offset], b1 = buf[offset+1], b2 = buf[offset+2];
            v32 = (b0 << 16) | (b1 << 8) | b2;
            if (v32 & 0x800000) v32 |= ~0xFFFFFF;   // sign-extend 24-bit
            // 24 → 16: drop the 8 LSBs (rounding via >> 8 is fine for monitoring)
            return Math.max(-32768, Math.min(32767, v32 >> 8));
        }
        // L32 — AES67 carries 24-bit data left-aligned in 32 bits.
        v32 = buf.readInt32BE(offset);
        return Math.max(-32768, Math.min(32767, v32 >> 16));
    }

    private depacketise(prod: ProducerEntry, rtpPayload: Buffer) {
        const bps = this.bytesPerSample(prod.sdpParams.encoding);
        const ch  = prod.sdpParams.channels;
        const frameStride = bps * ch;                       // bytes per multichannel sample frame
        const nFrames = Math.floor(rtpPayload.length / frameStride);
        if (nFrames <= 0) return;

        const pickL = Math.min(prod.pickL, ch - 1);
        const pickR = Math.min(prod.pickR, ch - 1);

        // Append into the ring buffer
        const pcm = prod.pcm;
        for (let f = 0; f < nFrames; f++) {
            // Drop the oldest frame if we're about to overflow — keeps
            // latency bounded under packet bursts.
            if (prod.pcmAvail >= prod.pcmCap) {
                prod.pcmRead = (prod.pcmRead + 1) % prod.pcmCap;
                prod.pcmAvail--;
            }
            const base = f * frameStride;
            const l = this.pcmWordToInt16(rtpPayload, base + pickL * bps, prod.sdpParams.encoding);
            const r = this.pcmWordToInt16(rtpPayload, base + pickR * bps, prod.sdpParams.encoding);
            const w = prod.pcmWrite * 2;
            pcm[w]   = l;
            pcm[w+1] = r;
            prod.pcmWrite = (prod.pcmWrite + 1) % prod.pcmCap;
            prod.pcmAvail++;
        }
    }

    /**
     * Pull one 20 ms frame from the ring buffer, encode it, and write it
     * to every consumer's track. Runs on a setInterval to maintain a
     * steady 50 Hz output cadence even if the source packetisation is
     * different (most AES67 senders use 1 ms packetisation → 20 packets
     * make up one Opus frame).
     */
    private pump(prod: ProducerEntry) {
        if (prod.pcmAvail < FRAME_SAMPLES) return;   // wait for more data

        // Copy out FRAME_SAMPLES stereo Int16 samples into a contiguous buffer
        const stride = 2;                            // L+R per frame
        const out = Buffer.alloc(FRAME_SAMPLES * stride * 2); // 2 bytes per Int16
        for (let i = 0; i < FRAME_SAMPLES; i++) {
            const r = prod.pcmRead * 2;
            out.writeInt16LE(prod.pcm[r],   i * 4);
            out.writeInt16LE(prod.pcm[r+1], i * 4 + 2);
            prod.pcmRead = (prod.pcmRead + 1) % prod.pcmCap;
            prod.pcmAvail--;
        }

        let opusFrame: Buffer;
        try {
            opusFrame = prod.opusEncoder.encode(out);
        } catch (e: any) {
            SyncLog.log("warn", "AudioMonitor", "opus encode failed: " + (e?.message || e));
            return;
        }
        if (!opusFrame || opusFrame.length === 0) return;

        // Per-consumer RTP write. Two things to get right or the browser
        // silently drops everything:
        //   1) SSRC must match what werift announced in the SDP — so we
        //      pull it from cons.track.ssrc, NOT a producer-wide random.
        //   2) PayloadType must match what the browser answered with.
        //      Since we pinned the offer to PT 96 (single codec) and the
        //      answerer keeps the offerer's PT, 96 is the safe default;
        //      we still honour cons.payloadType if the answer happened
        //      to renumber it.
        prod.rtpSeq = (prod.rtpSeq + 1) & 0xFFFF;
        prod.rtpTs  = (prod.rtpTs + FRAME_SAMPLES) >>> 0;

        const { RtpPacket, RtpHeader } = _werift;
        for (const lid of prod.listeners) {
            const cons = this.consumers.get(lid);
            if (!cons || !cons.track) continue;
            try {
                const ssrc = (typeof cons.track.ssrc === "number") ? cons.track.ssrc : 0;
                const header = new RtpHeader({
                    version:        2,
                    padding:        false,
                    extension:      false,
                    marker:         false,
                    payloadType:    cons.payloadType ?? 96,
                    sequenceNumber: prod.rtpSeq,
                    timestamp:      prod.rtpTs,
                    ssrc:           ssrc
                });
                const pkt = new RtpPacket(header, opusFrame);
                cons.track.writeRtp(pkt);
            } catch (e) { /* swallow per-consumer write errors */ }
        }
    }

    private async openProducer(senderId: string, sdp: string, ch: [number, number], iface: string): Promise<ProducerEntry> {
        const params = AudioMonitorService.parseSdpForMonitor(sdp);
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        await new Promise<void>((resolve, reject) => {
            sock.bind(params.port, () => {
                try {
                    sock.addMembership(params.multicast, iface || "0.0.0.0");
                    resolve();
                } catch (e) { reject(e); }
            });
            sock.once("error", reject);
        });

        const prod: ProducerEntry = {
            senderId, sdpParams: params, udpSocket: sock,
            listeners: new Set(),
            pickL: Math.max(0, Math.min(ch[0], params.channels - 1)),
            pickR: Math.max(0, Math.min(ch[1], params.channels - 1)),

            opusEncoder: new _opus.OpusEncoder(SAMPLE_RATE, 2),

            pcm:      new Int16Array(PCM_CAP_FRAMES * 2),
            pcmCap:   PCM_CAP_FRAMES,
            pcmWrite: 0,
            pcmRead:  0,
            pcmAvail: 0,

            rtpSeq:      Math.floor(Math.random() * 0xFFFF),
            rtpTs:       Math.floor(Math.random() * 0xFFFFFFFF) >>> 0,
            rtpSsrc:     Math.floor(Math.random() * 0xFFFFFFFF) >>> 0,
            payloadType: 96,

            pumpTimer: null,
            started:   false
        };

        sock.on("message", (pkt: Buffer) => {
            // Minimum RTP header is 12 bytes. We don't care about CSRC /
            // extensions for monitoring; just skip past them.
            if (pkt.length < 12) return;
            const b0 = pkt[0];
            const cc = b0 & 0x0F;
            let headerLen = 12 + cc * 4;
            const hasExt = (b0 & 0x10) !== 0;
            if (hasExt && pkt.length >= headerLen + 4) {
                const extLenWords = pkt.readUInt16BE(headerLen + 2);
                headerLen += 4 + extLenWords * 4;
            }
            if (headerLen >= pkt.length) return;
            this.depacketise(prod, pkt.slice(headerLen));
        });

        prod.pumpTimer = setInterval(() => {
            try { this.pump(prod); } catch (e) {}
        }, FRAME_MS);
        prod.started = true;

        SyncLog.log("info", "AudioMonitor",
            "IGMP-joined " + params.multicast + ":" + params.port +
            "  src=" + params.encoding + "/" + params.channels + "ch  pick=" + prod.pickL + "/" + prod.pickR +
            "  for " + senderId);
        return prod;
    }

    private closeProducer(prod: ProducerEntry) {
        try { if (prod.pumpTimer) clearInterval(prod.pumpTimer); } catch {}
        try { prod.udpSocket.dropMembership(prod.sdpParams.multicast); } catch {}
        try { prod.udpSocket.close(); } catch {}
        SyncLog.log("info", "AudioMonitor", "IGMP-left  " + prod.sdpParams.multicast + " (no more listeners)");
    }


    // ===== Subscribe / signaling API =====

    async subscribe(args: SubscribeArgs): Promise<{ ok: true; offer: any } | { ok: false; error: string }> {
        if (!tryLoadDeps()) {
            return { ok: false, error: "Audio monitor not available (werift / @discordjs/opus missing)" };
        }

        // ----- Producer -----
        let prod = this.producers.get(args.senderId);
        if (!prod) {
            try {
                prod = await this.openProducer(args.senderId, args.sdp, args.channels || [0, 1], args.iface || "0.0.0.0");
                this.producers.set(args.senderId, prod);
            } catch (e: any) {
                return { ok: false, error: "Could not join multicast: " + (e?.message || e) };
            }
        }
        prod.listeners.add(args.listenerId);

        // ----- Consumer / WebRTC -----
        const { RTCPeerConnection, MediaStreamTrack } = _werift;
        let pc: any, track: any, offer: any;
        try {
            pc = new RTCPeerConnection({ iceServers: [] });
            track = new MediaStreamTrack({ kind: "audio" });
            // Prefer addTransceiver(track, opts) but fall back to addTrack
            // if the signature isn't what we expect on this werift version.
            let transceiver: any = null;
            try {
                transceiver = pc.addTransceiver(track, { direction: "sendonly" });
            } catch (e) {}
            if (!transceiver) {
                try { transceiver = pc.addTrack(track); } catch (e) {}
            }
            if (!transceiver) throw new Error("could not attach audio track to peer connection");

            // Pin the codec preferences to a single Opus 48k stereo. Without
            // this werift offers a long codec list, the browser may pick a
            // non-Opus PT, and our outgoing Opus payload becomes
            // undecodable. Forcing one codec also gives us a stable
            // payloadType to stamp on outgoing RTP packets.
            try {
                const RTCRtpCodecParameters = _werift.RTCRtpCodecParameters;
                if (RTCRtpCodecParameters && transceiver.setCodecPreferences) {
                    transceiver.setCodecPreferences([
                        new RTCRtpCodecParameters({
                            mimeType:    "audio/opus",
                            clockRate:   48000,
                            channels:    2,
                            payloadType: 96
                        })
                    ]);
                }
            } catch (e) {
                SyncLog.log("warn", "AudioMonitor", "setCodecPreferences failed: " + ((e as any)?.message || e));
            }
            // Auto-clean: if the browser tab is closed abruptly the
            // PeerConnection moves to "failed" / "closed" and our
            // explicit unsubscribe route may not be hit. Hook the
            // connection-state events so the producer always shuts down
            // when its last consumer disappears.
            try{
                pc.connectionStateChange?.subscribe?.((state:string) => {
                    SyncLog.log("info", "AudioMonitor", "PC " + args.listenerId + " connection state: " + state);
                    if (state === "failed" || state === "closed" || state === "disconnected") {
                        this.unsubscribe(args.listenerId).catch(()=>{});
                    }
                });
            }catch(e){}
            try{
                pc.iceConnectionStateChange?.subscribe?.((state:string) => {
                    SyncLog.log("info", "AudioMonitor", "PC " + args.listenerId + " ICE state: " + state);
                });
            }catch(e){}
            offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // Wait for ICE gathering to complete before handing the SDP
            // to the browser. werift doesn't write the host candidates
            // into the SDP until the gathering completes, and without
            // them the browser has nowhere to send the DTLS handshake
            // → no media flows. Bounded wait (2 s) so a slow gathering
            // doesn't hang forever; we then send whatever's there.
            await new Promise<void>((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                try{
                    if (pc.iceGatheringState === "complete") return finish();
                    pc.iceGatheringStateChange?.subscribe?.((s:string) => {
                        if (s === "complete") finish();
                    });
                }catch(e){}
                setTimeout(finish, 2000);
            });
            // Pick the final SDP that now includes gathered candidates.
            offer = pc.localDescription || offer;
        } catch (e: any) {
            // Drop the listener ref so the producer can shut down if it's
            // the only one.
            prod.listeners.delete(args.listenerId);
            if (prod.listeners.size === 0) {
                this.closeProducer(prod);
                this.producers.delete(args.senderId);
            }
            return { ok: false, error: "WebRTC offer failed: " + (e?.message || e) };
        }

        this.consumers.set(args.listenerId, {
            listenerId: args.listenerId,
            senderId:   args.senderId,
            pc, track,
            pendingServerIce: []
        });
        return { ok: true, offer: { type: offer.type, sdp: offer.sdp } };
    }

    /**
     * Parse the answer SDP to learn the Opus payload type the browser
     * chose, so the pump's RTP packets carry the right PT. Browsers
     * typically pick 111 (Chrome) or 109/120 (Safari).
     */
    private extractOpusPt(sdpText: string): number | null {
        try {
            const parsed = sdpTransform.parse(sdpText);
            for (const m of (parsed.media || [])) {
                if (m.type !== "audio") continue;
                const rtp = (m.rtp || []).find((r:any) => (r.codec || "").toLowerCase() === "opus");
                if (rtp && typeof rtp.payload === "number") return rtp.payload;
            }
        } catch (e) {}
        return null;
    }

    async answer(listenerId: string, answer: any): Promise<{ ok: boolean; error?: string }> {
        const c = this.consumers.get(listenerId);
        if (!c) return { ok: false, error: "no such listener" };
        try {
            await c.pc.setRemoteDescription(answer);
            const pt = this.extractOpusPt(answer?.sdp || "");
            if (pt !== null) c.payloadType = pt;
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: "setRemoteDescription failed: " + (e?.message || e) };
        }
    }

    async ice(listenerId: string, candidate: any): Promise<{ ok: boolean }> {
        const c = this.consumers.get(listenerId);
        if (!c || !candidate) return { ok: false };
        try { await c.pc.addIceCandidate(candidate); } catch (e) {}
        return { ok: true };
    }

    /**
     * Live channel-pair switch — updates the producer's pickL / pickR in
     * place without tearing the multicast / encoder / PeerConnection
     * down. Avoids the IGMP-leave/join churn (and the resulting audio
     * gap or worse: a `bind` race on the same UDP port that broke the
     * stream a few seconds after a switch).
     */
    setChannels(listenerId: string, channels: [number, number]): boolean {
        const c = this.consumers.get(listenerId);
        if (!c) return false;
        const prod = this.producers.get(c.senderId);
        if (!prod) return false;
        const ch = prod.sdpParams.channels;
        prod.pickL = Math.max(0, Math.min(channels[0] | 0, ch - 1));
        prod.pickR = Math.max(0, Math.min(channels[1] | 0, ch - 1));
        // Wipe the jitter buffer — anything queued was the previous pair.
        prod.pcmRead = 0;
        prod.pcmWrite = 0;
        prod.pcmAvail = 0;
        SyncLog.log("info", "AudioMonitor", "Switched channel pair for " + c.senderId + " → " + prod.pickL + "/" + prod.pickR);
        return true;
    }

    async unsubscribe(listenerId: string): Promise<void> {
        const c = this.consumers.get(listenerId);
        if (!c) return;
        try { await c.pc.close(); } catch (e) {}
        this.consumers.delete(listenerId);

        const prod = this.producers.get(c.senderId);
        if (!prod) return;
        prod.listeners.delete(listenerId);
        if (prod.listeners.size === 0) {
            this.closeProducer(prod);
            this.producers.delete(c.senderId);
        }
    }

    /**
     * Tear down every consumer whose listenerId begins with the given
     * prefix. The UI uses `<clientId>:<random>` as listenerId, so the
     * WebSocket disconnect path can call dropClient(clientId) to free
     * everything.
     */
    async dropClient(clientPrefix: string): Promise<void> {
        const ids: string[] = [];
        for (const lid of this.consumers.keys()) {
            if (lid.startsWith(clientPrefix + ":")) ids.push(lid);
        }
        for (const lid of ids) await this.unsubscribe(lid);
    }

    /**
     * Wipe every consumer + producer. Called from the SIGTERM/SIGINT
     * shutdown path (so Ctrl-C on `docker-compose up` stops within the
     * default 10 s grace window instead of timing out on lingering UDP
     * sockets + WebRTC peer connections), and from the Setup toggle
     * flipping the feature off.
     */
    async shutdownAll(): Promise<void> {
        const lids = Array.from(this.consumers.keys());
        for (const lid of lids) {
            try { await this.unsubscribe(lid); } catch (e) {}
        }
        // Safety net — producers should already be gone via unsubscribe.
        for (const [sid, prod] of Array.from(this.producers.entries())) {
            try { this.closeProducer(prod); } catch (e) {}
            this.producers.delete(sid);
        }
    }


    // ===== Diagnostics =====

    snapshot(): any {
        return {
            available: this.isAvailable(),
            producers: Array.from(this.producers.values()).map(p => ({
                senderId: p.senderId,
                multicast: p.sdpParams.multicast + ":" + p.sdpParams.port,
                encoding: p.sdpParams.encoding,
                sourceChannels: p.sdpParams.channels,
                pick: [p.pickL, p.pickR],
                listeners: p.listeners.size,
                pcmBufferedMs: Math.round((p.pcmAvail / SAMPLE_RATE) * 1000)
            })),
            consumers: this.consumers.size
        };
    }
}
