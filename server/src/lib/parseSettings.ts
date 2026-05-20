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


    // multicastRanges — single CIDR per category.
    //   audioLow:  audio with channels <= 2
    //   audioHigh: audio with channels > 2
    //   video:     any video stream
    // Pairs of (odd IP, odd+1) are allocated within each range so the same
    // sender always uses primary (odd) for Leg 1 and secondary (odd+1) for
    // Leg 2 — the +1 stays reserved even for single-leg senders.
    let defaultRanges:any = {
        audioLow:  "239.130.0.0/16",
        audioHigh: "239.131.0.0/16",
        video:     "239.120.0.0/16"
    };
    let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
    let oldR:any = (settings.multicastRanges && typeof settings.multicastRanges === "object") ? settings.multicastRanges : {};
    let newR:any = {};
    for(let key of ["audioLow","audioHigh","video"] as const){
        let candidate:any = oldR[key];
        // accept string (new format) or { primary, secondary } (old format)
        if(typeof candidate === "string" && cidrRe.test(candidate)){
            newR[key] = candidate;
        }else if(candidate && typeof candidate === "object" && typeof candidate.primary === "string" && cidrRe.test(candidate.primary)){
            newR[key] = candidate.primary;
        }
    }
    // Migrate from previous mode that used video/audio/other keys
    if(!newR.video && typeof oldR.video === "object" && oldR.video.primary){
        if(cidrRe.test(oldR.video.primary)) newR.video = oldR.video.primary;
    }
    if(!newR.audioLow && typeof oldR.audio === "object" && oldR.audio.primary){
        if(cidrRe.test(oldR.audio.primary)) newR.audioLow = oldR.audio.primary;
    }
    if(!newR.audioHigh && typeof oldR.audio === "object" && oldR.audio.primary){
        if(cidrRe.test(oldR.audio.primary)) newR.audioHigh = oldR.audio.primary;
    }
    settings.multicastRanges = {
        audioLow:  newR.audioLow  || defaultRanges.audioLow,
        audioHigh: newR.audioHigh || defaultRanges.audioHigh,
        video:     newR.video     || defaultRanges.video,
    };


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
        { id:"grassvalley",  name:"Grass Valley",     labels:"Grass Valley",      protocol:"http",  port:80,  path:"/" }
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


    return settings;
}