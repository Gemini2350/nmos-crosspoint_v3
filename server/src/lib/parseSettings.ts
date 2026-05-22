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
    // Operator-defined senders that don't exist in any NMOS registry. Each
    // entry stores a raw SDP that the user pasted on the Setup page. The
    // sender shows up in the Crosspoint under a synthetic "Virtual Device"
    // node and, when used as the source of a connection, the receiver gets
    // PATCHed with this SDP as its transport_file — no IS-05 push on the
    // sender side, since there is no sender side.
    //
    // Schema: { id:string, name:string, sdp:string }
    if(!Array.isArray(settings.virtualSenders)){
        settings.virtualSenders = [];
    }else{
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
        settings.virtualSenders = settings.virtualSenders
            .filter((v:any) => v && typeof v === "object")
            .map((v:any) => ({
                id:        (typeof v.id === "string" && v.id) ? v.id : ("vs_" + Math.random().toString(36).slice(2,10)),
                name:      (typeof v.name === "string") ? v.name : "",
                sdp:       (typeof v.sdp === "string") ? v.sdp : "",
                // Stable UUID published as `sender_id` on the receiver PATCH.
                // Generated once and reused on every save so receivers stay
                // bound to the same virtual sender across reloads.
                senderId:  (typeof v.senderId === "string" && /^[a-f0-9-]{36}$/i.test(v.senderId)) ? v.senderId : mkUuid()
            }));
    }


    // ----- DNS Push (pfSense REST API) -----
    // When enabled, NMOS node labels (or user aliases) are pushed as DNS
    // host_overrides on the pfSense DNS forwarder via the pfrest API.
    //
    // Auth: API Key sent as the `X-API-Key` header.
    //   See https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/#api-key
    //
    // Endpoints used:
    //   GET /api/v2/services/dns_forwarder/host_overrides   – list current entries
    //   POST  …/host_override                              – create new
    //   PATCH …/host_override                              – update existing
    //   DELETE …/host_override?id=N                        – remove
    //   POST  …/host_overrides/apply                       – apply pending changes
    let defaultDns:any = {
        enabled: false,
        serverIp: "",
        serverPort: 443,
        protocol: "https",
        apiKey: "",
        domain: "local",
        insecureTLS: true,
    };
    if(!settings.dnsPush || typeof settings.dnsPush !== "object"){
        settings.dnsPush = defaultDns;
    }else{
        settings.dnsPush = {
            enabled:     !!settings.dnsPush.enabled,
            serverIp:    (typeof settings.dnsPush.serverIp    === "string") ? settings.dnsPush.serverIp.trim() : "",
            serverPort:  (typeof settings.dnsPush.serverPort  === "number" && settings.dnsPush.serverPort  > 0 && settings.dnsPush.serverPort  < 65536) ? settings.dnsPush.serverPort : 443,
            protocol:    settings.dnsPush.protocol === "http" ? "http" : "https",
            apiKey:      (typeof settings.dnsPush.apiKey      === "string") ? settings.dnsPush.apiKey : "",
            domain:      (typeof settings.dnsPush.domain      === "string" && settings.dnsPush.domain) ? settings.dnsPush.domain.trim() : "local",
            insecureTLS: settings.dnsPush.insecureTLS !== false,
        };
    }


    return settings;
}