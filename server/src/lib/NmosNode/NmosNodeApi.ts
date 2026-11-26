/*
 * NMOS Crosspoint — IS-04 Node API + IS-05 Connection API
 *
 * Mounts read-only NMOS endpoints on the existing Express server so the
 * virtual senders we register look identical to native NMOS senders when
 * queried by any controller, receiver or registry:
 *
 *   /x-nmos/node/v1.3/self                              — the Node resource
 *   /x-nmos/node/v1.3/devices[/<id>]                    — the virtual Devices
 *   /x-nmos/node/v1.3/sources[/<id>]                    — one Source per sender
 *   /x-nmos/node/v1.3/flows[/<id>]                      — one Flow per sender
 *   /x-nmos/node/v1.3/senders[/<id>]                    — every virtual Sender
 *   /x-nmos/node/v1.3/receivers                         — [] (we don't receive)
 *
 *   /x-nmos/connection/v1.0/single/senders                              — list of UUIDs
 *   /x-nmos/connection/v1.0/single/senders/<id>/constraints             — IS-05 constraint set
 *   /x-nmos/connection/v1.0/single/senders/<id>/staged                  — staged transport_params
 *   /x-nmos/connection/v1.0/single/senders/<id>/active                  — active transport_params
 *   /x-nmos/connection/v1.0/single/senders/<id>/transportfile           — the raw SDP
 *   /x-nmos/connection/v1.0/bulk/senders                                — bulk staging (POST stub)
 *
 * Virtual senders are read-only from the network side: PATCH/POST on
 * /staged returns 405. The IS-05 surface exists purely so receivers and
 * controllers that resolve `manifest_href` work without special-casing.
 */

import { parseVirtualSdp, buildVideoComponents } from "./sdpToNmos";
import { SyncLog } from "../syncLog";

export class NmosNodeApi {
    public static instance: NmosNodeApi | null = null;

    private settings:any;
    // Cache of derived IS-04 / IS-05 records keyed by UUID, regenerated on
    // every settings change. Cheaper than re-parsing the SDP on every request.
    private nodeResource:any   = null;
    private deviceResources:    { [id:string]: any } = {};
    private senderResources:    { [id:string]: any } = {};
    private flowResources:      { [id:string]: any } = {};
    private sourceResources:    { [id:string]: any } = {};
    private transportFiles:     { [id:string]: string } = {};
    private transportParams:    { [id:string]: any[] }  = {};
    // Cached "<senderId> → parsed SDP" so the registration path doesn't
    // re-parse and the API doesn't either.
    public lastError: { [id:string]: string } = {};

    constructor(settings:any){
        this.settings = settings;
        NmosNodeApi.instance = this;
        this.rebuild();
    }

    /** Push fresh settings (e.g. after a Setup-page save) and re-derive everything. */
    public setSettings(settings:any){
        this.settings = settings;
        this.rebuild();
    }

    /**
     * Build an HTTP URL while omitting the default port (`:80`). nmos-cpp's
     * IS-04 validator canonicalises URIs and treats `http://host:80/` as
     * "non-canonical with default port specified" — schema-strict registries
     * therefore reject it. Same logic for `:443` with https.
     */
    private buildUrl(host:string, port:number, protocol:string, path:string): string {
        let portSuffix = ((protocol === "http" && port === 80) || (protocol === "https" && port === 443))
            ? "" : (":" + port);
        return protocol + "://" + host + portSuffix + path;
    }

    /** Re-parse every virtual sender's SDP and rebuild the IS-04 records. */
    public rebuild(){
        let virtualNode = this.settings?.virtualNode || {};
        let advertiseHost: string = this.computeAdvertiseHost();
        let advertisePort: number = this.computeAdvertisePort();
        let advertiseProto: string = "http";
        let version = this.nmosVersion();

        // Resolve the local OS interface that owns advertiseHost so we can
        // publish a real MAC as port_id (the IS-04 schema flat-out refuses
        // `null` for that field — it accepts EUI-48 / EUI-64 in dash form,
        // or a freeform non-empty string).
        let { ifaceName, ifaceMac } = this.resolveLocalInterface(advertiseHost);

        // Pick the clock entry: if the operator configured an "acceptable
        // GMID" on the Setup page we publish ourselves as PTP-locked to it
        // (it's the operator's declared truth for this network), otherwise
        // we fall back to an internal clock so the schema still validates.
        let clock = this.buildClockEntry();

        // ----- Node -----
        // Schema-strict registries (nmos-cpp via libjsonschema) check IS-04
        // v1.3.3 carefully. Notes:
        //   - href must NOT include the default port (canonical URI form).
        //   - hostname is OPTIONAL and uses `format: hostname` — strict
        //     validators reject IP addresses there, so we omit it entirely.
        //   - endpoint.authorization is optional but explicit `false`
        //     plays better with strict validators.
        //   - interfaces[].port_id MUST be a non-empty string or MAC; null
        //     is NOT accepted.
        //   - attached_network_device is optional and must be an object
        //     when present — omitted entirely since we have no data.
        this.nodeResource = {
            id:          virtualNode.nodeId,
            version,
            label:       virtualNode.label || "NMOS Crosspoint Virtual Node",
            description: "Virtual senders managed by NMOS Crosspoint",
            tags:        {},
            href:        this.buildUrl(advertiseHost, advertisePort, advertiseProto, "/"),
            caps:        {},
            api: {
                versions: ["v1.3"],
                endpoints: [
                    { host: advertiseHost, port: advertisePort, protocol: advertiseProto, authorization: false }
                ]
            },
            services: [],
            clocks: [ clock ],
            interfaces: [
                {
                    name:       ifaceName,
                    // chassis_id allows null per schema; we use the MAC if
                    // we have one so controllers can correlate the Node
                    // with LLDP / SNMP discovery on the same NIC.
                    chassis_id: ifaceMac || null,
                    port_id:    ifaceMac || ifaceName
                }
            ]
        };

        // ----- Senders / Flows / Sources -----
        this.senderResources = {};
        this.flowResources   = {};
        this.sourceResources = {};
        this.transportFiles  = {};
        this.transportParams = {};
        this.lastError       = {};
        // Each sender's device; one not (or no longer) among the devices
        // belongs to the first, as parseSettings assigns it.
        let devices: any[] = (this.settings?.virtualDevices || []).filter((d:any) => d && d.id);
        if(devices.length === 0 && virtualNode.deviceId) devices = [{ id: virtualNode.deviceId, name: "Virtual Senders" }];
        let deviceIds = new Set(devices.map((d:any) => d.id));
        let deviceOf = (vs:any) => deviceIds.has(vs.deviceId) ? vs.deviceId : devices[0]?.id;

        for(let vs of (this.settings?.virtualSenders || [])){
            if(!vs || !vs.senderId || !vs.flowId || !vs.sourceId) continue;
            try{
                let parsed = parseVirtualSdp(vs.sdp);
                let label  = vs.name || ("Virtual " + vs.senderId.slice(0,8));

                // Source
                let source:any = {
                    id:          vs.sourceId,
                    version,
                    label,
                    description: "",
                    tags:        {},
                    format:      parsed.format,
                    caps:        {},
                    device_id:   deviceOf(vs),
                    parents:     [],
                    clock_name:  "clk0"
                };
                if(parsed.format === "urn:x-nmos:format:audio" && parsed.audio){
                    // source_audio: channels is required, grain_rate is optional.
                    source.channels = Array.from({length: parsed.audio.channels}, (_,i) => ({
                        label: "Channel " + (i+1)
                    }));
                }else if(parsed.format === "urn:x-nmos:format:video" && parsed.video){
                    // source_generic: grain_rate is required (frame rate).
                    source.grain_rate = parsed.video.grainRate;
                }
                this.sourceResources[vs.sourceId] = source;

                // Flow
                let flow:any = {
                    id:          vs.flowId,
                    version,
                    label,
                    description: "",
                    tags:        {},
                    format:      parsed.format,
                    media_type:  parsed.mediaType,
                    source_id:   vs.sourceId,
                    device_id:   deviceOf(vs),
                    parents:     []
                };
                if(parsed.format === "urn:x-nmos:format:audio" && parsed.audio){
                    flow.sample_rate = { numerator: parsed.audio.sampleRate, denominator: 1 };
                    flow.bit_depth   = parsed.audio.bitDepth;
                }else if(parsed.format === "urn:x-nmos:format:video" && parsed.video){
                    // flow_video_raw requires colorspace + transfer_characteristic;
                    // fill in safe defaults when the SDP omits them so the
                    // registry doesn't reject the flow.
                    flow.frame_width    = parsed.video.width;
                    flow.frame_height   = parsed.video.height;
                    flow.interlace_mode = parsed.video.interlace;
                    flow.grain_rate     = parsed.video.grainRate;
                    flow.colorspace             = parsed.video.colorimetry  || "BT709";
                    flow.transfer_characteristic = parsed.video.transferChar || "SDR";
                    flow.components = buildVideoComponents(
                        parsed.video.width, parsed.video.height,
                        parsed.video.depth || 10, parsed.video.sampling
                    );
                }
                this.flowResources[vs.flowId] = flow;

                // Sender (with manifest_href pointing back at us). Use the
                // canonical-URL helper so the default port is omitted —
                // strict registries reject "http://host:80/..." URIs.
                let manifestUrl = this.buildUrl(advertiseHost, advertisePort, advertiseProto,
                    "/x-nmos/connection/v1.0/single/senders/" + vs.senderId + "/transportfile");
                let sender:any = {
                    id:                 vs.senderId,
                    version,
                    label,
                    description:        "",
                    tags:               {},
                    flow_id:            vs.flowId,
                    transport:          "urn:x-nmos:transport:rtp.mcast",
                    device_id:          deviceOf(vs),
                    manifest_href:      manifestUrl,
                    // Must reference an entry in node.interfaces[].name
                    // (`ifaceName` resolved above, defaults to the actual
                    // OS interface owning advertiseHost).
                    interface_bindings: [ifaceName],
                    caps:               {},
                    subscription:       { receiver_id: null, active: true }
                };
                this.senderResources[vs.senderId] = sender;

                // IS-05 transport state + the raw SDP for /transportfile.
                this.transportFiles[vs.senderId]  = vs.sdp;
                this.transportParams[vs.senderId] = parsed.transportParams;
            }catch(e:any){
                let msg = (e && e.message) ? e.message : String(e);
                this.lastError[vs.senderId] = msg;
                SyncLog.log("warn", "NMOS Node", "Virtual sender " + vs.senderId + " (" + (vs.name||"") + ") skipped: " + msg);
            }
        }

        // ----- Devices -----
        // One per settings.virtualDevices entry, listing the senders built
        // above (a sender whose SDP failed is not registered, so not listed).
        // They share the Node's IS-05 Connection API.
        this.deviceResources = {};
        for(let d of devices){
            this.deviceResources[d.id] = {
                id:          d.id,
                version,
                label:       d.name || "Virtual Device",
                description: "",
                tags:        {},
                type:        "urn:x-nmos:device:generic",
                node_id:     virtualNode.nodeId,
                senders:     Object.values(this.senderResources).filter((x:any) => x.device_id === d.id).map((x:any) => x.id),
                receivers:   [],
                controls: [
                    {
                        href:          this.buildUrl(advertiseHost, advertisePort, advertiseProto, "/x-nmos/connection/v1.0/"),
                        type:          "urn:x-nmos:control:sr-ctrl/v1.0",
                        authorization: false
                    }
                ]
            };
        }
    }

    /** Snapshot used by NmosNodeRegistration when POSTing to the registry. */
    public getResources(){
        return {
            node:   this.nodeResource,
            devices: Object.values(this.deviceResources),
            sources: Object.values(this.sourceResources),
            flows:   Object.values(this.flowResources),
            senders: Object.values(this.senderResources)
        };
    }

    public getNode()    { return this.nodeResource; }
    public getDevices() { return Object.values(this.deviceResources); }
    public getSenders() { return Object.values(this.senderResources); }
    public getFlows()   { return Object.values(this.flowResources); }
    public getSources() { return Object.values(this.sourceResources); }


    /** Attach the IS-04 + IS-05 GET routes to an Express app. */
    public mount(app:any){
        const json = (res:any, obj:any) => {
            res.setHeader("Content-Type", "application/json");
            res.send(JSON.stringify(obj));
        };

        // ---- IS-04 Node API ----
        app.get("/x-nmos/node",      (_req:any, res:any) => json(res, ["v1.3/"]));
        app.get("/x-nmos/node/",     (_req:any, res:any) => json(res, ["v1.3/"]));
        app.get("/x-nmos/node/v1.3", (_req:any, res:any) =>
            json(res, ["self/","devices/","sources/","flows/","senders/","receivers/"])
        );
        app.get("/x-nmos/node/v1.3/", (_req:any, res:any) =>
            json(res, ["self/","devices/","sources/","flows/","senders/","receivers/"])
        );

        app.get("/x-nmos/node/v1.3/self", (_req:any, res:any) => {
            if(!this.nodeResource) return res.status(503).send("Node not initialised");
            json(res, this.nodeResource);
        });

        app.get("/x-nmos/node/v1.3/devices",         (_req:any, res:any) => {
            json(res, Object.values(this.deviceResources));
        });
        app.get("/x-nmos/node/v1.3/devices/:id",     (req:any, res:any) => {
            let r = this.deviceResources[req.params.id];
            if(r) return json(res, r);
            res.status(404).send("Not Found");
        });

        app.get("/x-nmos/node/v1.3/sources",         (_req:any, res:any) => json(res, Object.values(this.sourceResources)));
        app.get("/x-nmos/node/v1.3/sources/:id",     (req:any, res:any) => {
            let r = this.sourceResources[req.params.id];
            if(r) return json(res, r);
            res.status(404).send("Not Found");
        });

        app.get("/x-nmos/node/v1.3/flows",           (_req:any, res:any) => json(res, Object.values(this.flowResources)));
        app.get("/x-nmos/node/v1.3/flows/:id",       (req:any, res:any) => {
            let r = this.flowResources[req.params.id];
            if(r) return json(res, r);
            res.status(404).send("Not Found");
        });

        app.get("/x-nmos/node/v1.3/senders",         (_req:any, res:any) => json(res, Object.values(this.senderResources)));
        app.get("/x-nmos/node/v1.3/senders/:id",     (req:any, res:any) => {
            let r = this.senderResources[req.params.id];
            if(r) return json(res, r);
            res.status(404).send("Not Found");
        });

        app.get("/x-nmos/node/v1.3/receivers",       (_req:any, res:any) => json(res, []));

        // ---- IS-05 Connection API ----
        app.get("/x-nmos/connection",      (_req:any, res:any) => json(res, ["v1.0/"]));
        app.get("/x-nmos/connection/",     (_req:any, res:any) => json(res, ["v1.0/"]));
        app.get("/x-nmos/connection/v1.0", (_req:any, res:any) => json(res, ["bulk/","single/"]));
        app.get("/x-nmos/connection/v1.0/", (_req:any, res:any) => json(res, ["bulk/","single/"]));
        app.get("/x-nmos/connection/v1.0/single",  (_req:any, res:any) => json(res, ["senders/","receivers/"]));
        app.get("/x-nmos/connection/v1.0/single/", (_req:any, res:any) => json(res, ["senders/","receivers/"]));

        app.get("/x-nmos/connection/v1.0/single/senders", (_req:any, res:any) =>
            json(res, Object.keys(this.senderResources).map(id => id + "/"))
        );
        app.get("/x-nmos/connection/v1.0/single/senders/:id", (req:any, res:any) => {
            if(!this.senderResources[req.params.id]) return res.status(404).send("Not Found");
            json(res, ["constraints/","staged/","active/","transportfile/"]);
        });

        app.get("/x-nmos/connection/v1.0/single/senders/:id/constraints", (req:any, res:any) => {
            let tp = this.transportParams[req.params.id];
            if(!tp) return res.status(404).send("Not Found");
            // Empty constraint set per leg — we don't accept reconfiguration
            // anyway, but receivers' clients still hit this endpoint.
            json(res, tp.map(() => ({})));
        });

        const stagedActive = (req:any, res:any) => {
            let tp = this.transportParams[req.params.id];
            let sdp = this.transportFiles[req.params.id];
            if(!tp || sdp === undefined) return res.status(404).send("Not Found");
            json(res, {
                sender_id: null,
                master_enable: true,
                activation: { mode: null, requested_time: null, activation_time: null },
                transport_params: tp,
                transport_file: { data: sdp, type: "application/sdp" }
            });
        };
        app.get("/x-nmos/connection/v1.0/single/senders/:id/staged", stagedActive);
        app.get("/x-nmos/connection/v1.0/single/senders/:id/active", stagedActive);

        app.get("/x-nmos/connection/v1.0/single/senders/:id/transportfile", (req:any, res:any) => {
            let sdp = this.transportFiles[req.params.id];
            if(sdp === undefined) return res.status(404).send("Not Found");
            res.setHeader("Content-Type", "application/sdp");
            res.send(sdp);
        });

        // Virtual senders are read-only — PATCHing them makes no sense.
        const readonly = (_req:any, res:any) => {
            res.status(405).setHeader("Allow", "GET").send("Method Not Allowed");
        };
        app.patch("/x-nmos/connection/v1.0/single/senders/:id/staged", readonly);
        app.post ("/x-nmos/connection/v1.0/bulk/senders",              readonly);

        app.get("/x-nmos/connection/v1.0/single/receivers",  (_req:any, res:any) => json(res, []));
        app.get("/x-nmos/connection/v1.0/bulk",  (_req:any, res:any) => json(res, ["senders/","receivers/"]));

        // Root discovery
        app.get("/x-nmos",  (_req:any, res:any) => json(res, ["node/","connection/"]));
        app.get("/x-nmos/", (_req:any, res:any) => json(res, ["node/","connection/"]));

        SyncLog.log("info", "NMOS Node", "IS-04 / IS-05 HTTP routes mounted on /x-nmos/...");
    }


    // ----- Helpers -----
    private nmosVersion(): string {
        // IS-04 expects "<seconds>:<nanoseconds>" since epoch — we mint it
        // every time something changes so registries pick up updates.
        let ms = Date.now();
        let s  = Math.floor(ms / 1000);
        let ns = (ms - s * 1000) * 1_000_000;
        return s + ":" + ns;
    }

    /**
     * Find the OS network interface that owns `advertiseHost`. Returns its
     * name (used as node.interfaces[].name and as the sender's
     * interface_bindings entry) and its MAC address in IS-04's dash-form
     * EUI-48 / EUI-64 (e.g. "aa-bb-cc-dd-ee-ff"), used as port_id /
     * chassis_id. Both fields require non-null per the IS-04 v1.3.3 schema;
     * MAC is the canonical value, but if we can't resolve one we fall
     * back to a freeform string that still passes the pattern check.
     */
    private resolveLocalInterface(advertiseHost:string): { ifaceName: string, ifaceMac: string } {
        try{
            let os = require("os");
            let ifs = os.networkInterfaces();
            // Pass 1: exact match on the advertised IP.
            for(let name of Object.keys(ifs)){
                for(let iface of (ifs[name] || [])){
                    if(iface.family !== "IPv4" || iface.internal) continue;
                    if(iface.address === advertiseHost){
                        return { ifaceName: name, ifaceMac: this.normaliseMac(iface.mac) };
                    }
                }
            }
            // Pass 2: any non-loopback IPv4.
            for(let name of Object.keys(ifs)){
                for(let iface of (ifs[name] || [])){
                    if(iface.family === "IPv4" && !iface.internal){
                        return { ifaceName: name, ifaceMac: this.normaliseMac(iface.mac) };
                    }
                }
            }
        }catch(e){}
        return { ifaceName: "eth0", ifaceMac: "" };
    }

    /**
     * Build the `clocks[0]` entry. When the operator has set an "Acceptable
     * PTP GMID" on the Setup page we surface ourselves as PTP, locked to
     * that GMID — controllers that filter / colour-code by GMID then see
     * the virtual senders as members of the configured PTP domain. With
     * no acceptable GMID, we fall back to an internal clock (which still
     * satisfies the IS-04 schema but signals "no PTP information").
     *
     * Normalises the operator's input so it matches the IS-04 v1.3.3
     * gmid pattern `^([0-9a-f]{2}-){7}[0-9a-f]{2}$` (lowercase, dashes).
     */
    private buildClockEntry(): any {
        let raw:string = (this.settings?.acceptableGmid || "").trim();
        let gmid = this.normaliseGmid(raw);
        if(!gmid){
            return { name: "clk0", ref_type: "internal" };
        }
        return {
            name:      "clk0",
            ref_type:  "ptp",
            version:   "IEEE1588-2008",
            gmid,
            locked:    true,
            traceable: false
        };
    }

    /**
     * Accept the operator's GMID in any of the common notations (lowercase
     * or uppercase, dashes / colons / dots) and return the canonical IS-04
     * form (lowercase, dash-separated, 8 octets). Returns "" when the
     * input doesn't yield enough hex digits.
     */
    private normaliseGmid(raw:string): string {
        if(!raw) return "";
        let hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
        if(hex.length !== 16) return "";
        let parts:string[] = [];
        for(let i = 0; i < 16; i += 2){
            parts.push(hex.substr(i, 2));
        }
        return parts.join("-");
    }

    /**
     * Convert a `:` / `.`-separated MAC into the IS-04 dash form
     * (lowercase, two hex digits per group, EUI-48 or EUI-64). Returns ""
     * if the input doesn't look like a MAC at all.
     */
    private normaliseMac(mac:string): string {
        if(typeof mac !== "string") return "";
        let cleaned = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
        if(cleaned.length !== 12 && cleaned.length !== 16) return "";
        let parts:string[] = [];
        for(let i = 0; i < cleaned.length; i += 2){
            parts.push(cleaned.substr(i, 2));
        }
        let joined = parts.join("-");
        // EUI-48 = "00-00-00-00-00-00" (all zeros) is what Node.js returns
        // when the interface has no MAC (loopback, tun, …). Treat that as
        // "no MAC" so we fall through to the freeform port_id branch.
        if(/^(00-){5}00$/.test(joined)) return "";
        return joined;
    }

    /**
     * Source IP we advertise to the registry (used inside `node.href` and
     * `sender.manifest_href` so receivers and controllers can fetch our IS-04
     * resources and SDPs). Lookup priority:
     *
     *   1) `settings.virtualNode.advertiseHost` — explicit operator override.
     *   2) Async detection result cached in `this.detectedAdvertiseHost`
     *      (populated by detectAdvertiseHostAsync(): a dgram.connect to the
     *      registry IP returns the kernel's chosen source IP, which handles
     *      routed / multi-homed setups correctly).
     *   3) Synchronous fallback: the local interface whose subnet contains
     *      the registry IP (`sameSubnet`) — covers the common "registry on
     *      the same VLAN" case before async detection has a chance to run.
     *   4) First non-loopback IPv4 (last-resort default).
     *   5) 127.0.0.1 — explicit so we never publish an empty href.
     */
    private detectedAdvertiseHost: string = "";

    private computeAdvertiseHost(): string {
        let cfg:string = (this.settings?.virtualNode?.advertiseHost || "").trim();
        if(cfg) return cfg;
        if(this.detectedAdvertiseHost) return this.detectedAdvertiseHost;

        let registryIp = this.settings?.staticNmosRegistries?.[0]?.ip || "";
        try{
            let os = require("os");
            let ifs = os.networkInterfaces();
            // Pass 1: pick the interface whose subnet contains the registry.
            if(registryIp){
                for(let name of Object.keys(ifs)){
                    for(let iface of (ifs[name] || [])){
                        if(iface.family !== "IPv4" || iface.internal) continue;
                        if(this.sameSubnet(iface.address, iface.netmask, registryIp)){
                            return iface.address;
                        }
                    }
                }
            }
            // Pass 2: first non-loopback IPv4.
            for(let name of Object.keys(ifs)){
                for(let iface of (ifs[name] || [])){
                    if(iface.family === "IPv4" && !iface.internal){
                        return iface.address;
                    }
                }
            }
        }catch(e){}
        return "127.0.0.1";
    }

    /** IPv4 same-subnet test using the interface netmask. */
    private sameSubnet(ip:string, netmask:string, target:string): boolean {
        try{
            const toInt = (s:string) => {
                let parts = s.split(".").map(x => parseInt(x));
                if(parts.length !== 4 || parts.some(x => isNaN(x) || x < 0 || x > 255)) return -1;
                return ((parts[0]<<24) | (parts[1]<<16) | (parts[2]<<8) | parts[3]) >>> 0;
            };
            let a = toInt(ip), m = toInt(netmask), t = toInt(target);
            if(a < 0 || m < 0 || t < 0) return false;
            return (a & m) === (t & m);
        }catch(e){ return false; }
    }

    /**
     * Ask the kernel which local IP it would use when sending to the
     * registry. This is the bullet-proof answer for multi-homed and routed
     * setups — it follows the host's routing table exactly. Sync helpers
     * can only guess by subnet matching, so this runs once at startup (and
     * every time the registry changes) and caches the result.
     *
     * On failure (no registry configured, host unreachable, dgram errors)
     * the previously cached value is kept and computeAdvertiseHost falls
     * back to its sync heuristics.
     */
    public detectAdvertiseHostAsync(): Promise<void> {
        let registryIp = this.settings?.staticNmosRegistries?.[0]?.ip || "";
        if(!registryIp) return Promise.resolve();

        return new Promise<void>((resolve) => {
            try{
                const dgram = require("dgram");
                const socket = dgram.createSocket("udp4");
                let done = false;
                const finish = (addr:string) => {
                    if(done) return;
                    done = true;
                    try{ socket.close(); }catch(e){}
                    if(addr){
                        if(addr !== this.detectedAdvertiseHost){
                            this.detectedAdvertiseHost = addr;
                            // Re-derive node/sender hrefs with the new IP.
                            this.rebuild();
                        }
                    }
                    resolve();
                };
                socket.connect(53, registryIp, () => {
                    try{
                        let a = socket.address();
                        finish(a?.address || "");
                    }catch(e){ finish(""); }
                });
                socket.on("error", () => finish(""));
                setTimeout(() => finish(""), 1000);
            }catch(e){ resolve(); }
        });
    }

    private computeAdvertisePort(): number {
        let p = parseInt(""+(this.settings?.server?.port || 80));
        if(isNaN(p) || p <= 0 || p > 65535) p = 80;
        return p;
    }
}
