export function parseSettings(settings:any){


    if(!settings.hasOwnProperty("reconnectOnSdpChanges")){
        settings.reconnectOnSdpChanges = false;
    }else{
        if(typeof settings.reconnectOnSdpChanges != "boolean"){
            settings.reconnectOnSdpChanges = false;
        }
    }


    if(!settings.hasOwnProperty("fixSdpBugs")){
        settings.fixSdpBugs = false;
    }else{
        if(typeof settings.fixSdpBugs != "boolean"){
            settings.fixSdpBugs = false;
        }
    }


    // Multicast Auto-Allocation (the "DHCP for multicasts" feature).
    // autoMulticast is an object now: { enabled: bool }. We migrate the
    // historic boolean form transparently.
    if(typeof settings.autoMulticast === "boolean"){
        settings.autoMulticast = { enabled: settings.autoMulticast };
    }
    if(!settings.autoMulticast || typeof settings.autoMulticast !== "object"){
        settings.autoMulticast = { enabled: false };
    }
    if(typeof settings.autoMulticast.enabled !== "boolean"){
        settings.autoMulticast.enabled = false;
    }


    // multicastRange — ONE shared CIDR pool used for every sender, regardless
    // of media type. Pairs of (odd IP, odd+1) are allocated within the range
    // so the same sender always uses primary (odd) for Leg 1 and secondary
    // (odd+1) for Leg 2 — the +1 stays reserved even for single-leg senders.
    let defaultRange:string = "239.30.0.0/16";
    let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
    if(typeof settings.multicastRange !== "string" || !cidrRe.test(settings.multicastRange.trim())){
        settings.multicastRange = defaultRange;
    }else{
        settings.multicastRange = settings.multicastRange.trim();
    }


    if(!settings.hasOwnProperty("firstDynamicNumber")){
        settings.firstDynamicNumber = 1000;
    }else{
        if(typeof settings.firstDynamicNumber != "number"){
            settings.firstDynamicNumber = 1000;
        }else{
            settings.firstDynamicNumber = Number.parseInt(settings.firstDynamicNumber);
        }

        if(settings.firstDynamicNumber < 1){
            settings.firstDynamicNumber = 1000;
        }
    }


    // PTP Grand-Master ID that the UI considers "acceptable". Used purely for
    // visualisation (green vs. yellow device status dot in the Details view).
    if(!settings.hasOwnProperty("acceptableGmid") || typeof settings.acceptableGmid != "string"){
        settings.acceptableGmid = "";
    }


    // When true, every time a sender's SDP changes (destination IP/port, channel
    // count, video format, colorimetry, …) we re-execute the connection of every
    // receiver currently listening to that sender, so they pick up the new
    // manifest. Defaults to FALSE — many devices renegotiate fine on their
    // own and the extra PATCH storm can briefly interrupt unrelated streams.
    // The "Reallocate from pool" sweep ignores this flag and always reconnects.
    //
    // Migrated from the older `reconnectReceiversOnMulticastChange` name.
    if(typeof settings.reconnectReceiversOnSenderChange !== "boolean"){
        if(typeof settings.reconnectReceiversOnMulticastChange === "boolean"){
            settings.reconnectReceiversOnSenderChange = settings.reconnectReceiversOnMulticastChange;
        }else{
            settings.reconnectReceiversOnSenderChange = false;
        }
    }
    // Drop the obsolete field so settings.json stays clean after the next save.
    if(settings.hasOwnProperty("reconnectReceiversOnMulticastChange")){
        delete settings.reconnectReceiversOnMulticastChange;
    }


    // When the Crosspoint UI requests a connection whose source sender is
    // currently inactive (master_enable=false), should we automatically
    // PATCH it active first? Defaults to FALSE: many control rooms gate
    // sender activation through a separate workflow and don't want a stray
    // click on the Crosspoint matrix to push a signal on the wire.
    if(typeof settings.autoActivateInactiveSender !== "boolean"){
        settings.autoActivateInactiveSender = false;
    }


    // Vendor profiles — define how to build the "open device web UI" link
    // for each manufacturer. A device is matched against profiles in order;
    // the first profile whose labels list contains a substring of the node's
    // label or description wins.
    //
    // labels: comma-separated list of case-insensitive substrings, e.g.
    //         "Matrox, ConvertIP, X1" — any match counts.
    //
    // The link is built as: <protocol>://<host>:<port><path>, where host
    // comes from the NMOS node's href. path defaults to "/".
    let defaultVendorProfiles = [
        { id:"matrox",       name:"Matrox ConvertIP", labels:"Matrox, ConvertIP", protocol:"https", port:443, path:"/" },
        { id:"embrionix",    name:"Riedel Embrionix", labels:"Embrionix",         protocol:"https", port:443, path:"/" },
        { id:"riedel",       name:"Riedel",           labels:"Riedel",            protocol:"http",  port:80,  path:"/" },
        { id:"lawo",         name:"Lawo",             labels:"Lawo",              protocol:"http",  port:80,  path:"/" },
        { id:"aja",          name:"AJA",              labels:"AJA",               protocol:"http",  port:80,  path:"/" },
        { id:"imagine",      name:"Imagine",          labels:"Imagine",           protocol:"http",  port:80,  path:"/" },
        { id:"sony",         name:"Sony",             labels:"Sony",              protocol:"http",  port:80,  path:"/" },
        { id:"grassvalley",  name:"Grass Valley",     labels:"Grass Valley",      protocol:"http",  port:80,  path:"/" },
        { id:"blackmagic",   name:"Blackmagic",       labels:"Blackmagic",        protocol:"http",  port:80,  path:"/admin" },
        { id:"merging",      name:"Merging",          labels:"Anubis, Hapi, Horus", protocol:"http", port:80, path:"/advanced" },
        { id:"directout",    name:"DirectOut",        labels:"ExBox",             protocol:"http",  port:80,  path:"/" },
        { id:"qsc",          name:"QSC",              labels:"Core",              protocol:"http",  port:80,  path:"/" }
    ];
    if(!Array.isArray(settings.vendorProfiles)){
        settings.vendorProfiles = defaultVendorProfiles;
    }else{
        // Sanitise existing entries — migrate older entries with macPrefix /
        // labelContains to the new "labels" field.
        settings.vendorProfiles = settings.vendorProfiles
            .filter((v:any) => v && typeof v === "object")
            .map((v:any) => {
                let port = parseInt(""+v.port);
                if(isNaN(port) || port <= 0 || port > 65535){ port = 80; }
                let protocol = (""+v.protocol).toLowerCase();
                if(protocol !== "http" && protocol !== "https"){ protocol = "http"; }
                let path = (typeof v.path === "string" && v.path) ? v.path : "/";
                if(!path.startsWith("/")){ path = "/" + path; }
                let labels = "";
                if(typeof v.labels === "string"){
                    labels = v.labels;
                }else if(typeof v.labelContains === "string"){
                    labels = v.labelContains; // migrate from older field
                }
                return {
                    id: (typeof v.id === "string" && v.id) ? v.id : ("v_" + Math.random().toString(36).slice(2,8)),
                    name: (typeof v.name === "string") ? v.name : "",
                    labels,
                    protocol,
                    port,
                    path
                };
            });
    }


    // ----- Virtual Senders -----
    // Operator-defined senders that don't exist on any real NMOS device.
    // Each entry stores a raw SDP that the user pasted on the Setup page.
    // NMOS Crosspoint exposes itself as an IS-04 Node and registers every
    // virtual sender as a regular NMOS sender (with its own source + flow)
    // — so every NMOS-aware controller on the network sees them, not just
    // this UI. Receivers PATCHed to a virtual sender therefore go through
    // the standard sender_id resolution; there is no "virtual_" prefix
    // anywhere in the runtime any more.
    //
    // Schema: { id, name, sdp, senderId, sourceId, flowId } per sender.
    // The three UUIDs are minted once and kept across saves so receiver
    // subscriptions stay valid over restarts.
    let crypto:any;
    try{ crypto = require("crypto"); }catch(e){}
    let mkUuid = () => {
        try{
            if(crypto && typeof crypto.randomUUID === "function"){
                return crypto.randomUUID();
            }
        }catch(e){}
        // Fallback: simple-but-deterministic UUID-shaped random string.
        // Good enough for an identifier; not cryptographically strong.
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            let r = Math.random() * 16 | 0;
            let v = c === "x" ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
    let uuidRe = /^[a-f0-9-]{36}$/i;

    if(!Array.isArray(settings.virtualSenders)){
        settings.virtualSenders = [];
    }else{
        settings.virtualSenders = settings.virtualSenders
            .filter((v:any) => v && typeof v === "object")
            .map((v:any) => ({
                id:        (typeof v.id === "string" && v.id) ? v.id : ("vs_" + Math.random().toString(36).slice(2,10)),
                name:      (typeof v.name === "string") ? v.name : "",
                sdp:       (typeof v.sdp === "string") ? v.sdp : "",
                // Three stable UUIDs: published as sender_id / flow_id /
                // source_id in the IS-04 records this server registers.
                senderId:  (typeof v.senderId === "string" && uuidRe.test(v.senderId)) ? v.senderId : mkUuid(),
                sourceId:  (typeof v.sourceId === "string" && uuidRe.test(v.sourceId)) ? v.sourceId : mkUuid(),
                flowId:    (typeof v.flowId   === "string" && uuidRe.test(v.flowId))   ? v.flowId   : mkUuid()
            }));
    }


    // ----- Audio Monitor (listen to a sender in the browser) -----
    // When enabled, the Details page shows a headphone button on audio
    // senders; the server IGMP-joins the multicast, transcodes PCM → Opus
    // and streams it to the browser via WebRTC. Fully off by default.
    if(!settings.audioMonitor || typeof settings.audioMonitor !== "object"){
        settings.audioMonitor = { enabled: false };
    }
    if(typeof settings.audioMonitor.enabled !== "boolean"){
        settings.audioMonitor.enabled = false;
    }


    // ----- BCP-008 status monitoring (IS-12) -----
    // Read-only health monitoring of senders/receivers on devices that
    // expose NcStatusMonitors. Default ON — it only opens control
    // connections to devices that advertise an ncp endpoint anyway.
    if(!settings.bcp008 || typeof settings.bcp008 !== "object"){
        settings.bcp008 = { enabled: true };
    }
    if(typeof settings.bcp008.enabled !== "boolean"){
        settings.bcp008.enabled = true;
    }

    // ----- Virtual NMOS Node identity -----
    // The Node + Device records (one of each, shared by ALL virtual senders)
    // we publish to the registry. UUIDs are persisted so the registry sees
    // the same Node across restarts and doesn't accumulate orphans.
    if(!settings.virtualNode || typeof settings.virtualNode !== "object"){
        settings.virtualNode = {};
    }
    // Master switch — when false, NMOS Crosspoint does not register itself
    // as an IS-04 Node and virtualSenders are inert. Default OFF — the
    // feature registers resources in the operator's registry, so it should
    // be an explicit opt-in on the Setup page. Installs that already saved
    // an explicit `enabled: true` keep it.
    if(typeof settings.virtualNode.enabled !== "boolean"){
        settings.virtualNode.enabled = false;
    }
    if(typeof settings.virtualNode.nodeId !== "string" || !uuidRe.test(settings.virtualNode.nodeId)){
        settings.virtualNode.nodeId = mkUuid();
    }
    if(typeof settings.virtualNode.deviceId !== "string" || !uuidRe.test(settings.virtualNode.deviceId)){
        settings.virtualNode.deviceId = mkUuid();
    }
    if(typeof settings.virtualNode.label !== "string" || !settings.virtualNode.label){
        settings.virtualNode.label = "NMOS Crosspoint Virtual Node";
    }
    // Optional override for the host/IP we advertise to the registry. When
    // empty, NmosNodeRegistration auto-detects the first non-loopback IPv4.
    if(typeof settings.virtualNode.advertiseHost !== "string"){
        settings.virtualNode.advertiseHost = "";
    }


    // ----- DDNS (RFC 2136 Dynamic Updates) -----
    // When enabled, NMOS node labels (or user aliases) are pushed as A
    // records into any DNS server that accepts standard RFC 2136 UPDATE
    // messages with TSIG-key auth (BIND9, Knot, PowerDNS, Windows DNS, …).
    //
    // Schema: { enabled, server, port, zone, ttl, keyName, keySecret,
    //           keyAlgorithm }. keySecret is the base64 TSIG shared secret.
    // "none" = unsigned RFC 2136 updates — for servers that authorise by
    // source IP (BIND allow-update { <ip>; };) instead of a TSIG key.
    const DDNS_ALGORITHMS = ["hmac-sha256", "hmac-sha512", "hmac-sha1", "hmac-md5", "none"];
    let defaultDdns:any = {
        enabled: false,
        server: "",
        port: 53,
        zone: "",
        ttl: 300,
        keyName: "",
        keySecret: "",
        keyAlgorithm: "hmac-sha256",
    };
    if(!settings.ddns || typeof settings.ddns !== "object"){
        settings.ddns = { ...defaultDdns };
        // One-time migration from the removed pfSense/pfRest "dnsPush"
        // integration: carry over the server address and the domain (as the
        // zone) so the operator doesn't have to retype them — but leave the
        // feature DISABLED, because the pfRest API key is useless for TSIG
        // and pushing with wrong credentials would just spam error logs.
        if(settings.dnsPush && typeof settings.dnsPush === "object"){
            if(typeof settings.dnsPush.serverIp === "string"){ settings.ddns.server = settings.dnsPush.serverIp.trim(); }
            if(typeof settings.dnsPush.domain === "string" && settings.dnsPush.domain){ settings.ddns.zone = settings.dnsPush.domain.trim(); }
        }
    }else{
        settings.ddns = {
            enabled:      !!settings.ddns.enabled,
            server:       (typeof settings.ddns.server === "string") ? settings.ddns.server.trim() : "",
            port:         (typeof settings.ddns.port === "number" && settings.ddns.port > 0 && settings.ddns.port < 65536) ? settings.ddns.port : 53,
            zone:         (typeof settings.ddns.zone === "string") ? settings.ddns.zone.trim().replace(/\.+$/, "") : "",
            ttl:          (typeof settings.ddns.ttl === "number" && settings.ddns.ttl > 0) ? settings.ddns.ttl : 300,
            keyName:      (typeof settings.ddns.keyName === "string") ? settings.ddns.keyName.trim().replace(/\.+$/, "") : "",
            keySecret:    (typeof settings.ddns.keySecret === "string") ? settings.ddns.keySecret.trim() : "",
            keyAlgorithm: DDNS_ALGORITHMS.includes(settings.ddns.keyAlgorithm) ? settings.ddns.keyAlgorithm : "hmac-sha256",
        };
    }
    // Drop the obsolete pfSense config so it doesn't linger in settings.json.
    if(settings.hasOwnProperty("dnsPush")){
        delete settings.dnsPush;
    }


    return settings;
}