/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/


const fs = require("fs");
const path = require("path");

// Build-version string for the UI's Setup page. Single source of truth is
// server/package.json — bump the version there for each release and the
// number shows up in the Setup header automatically. Compiled to
// dist/server.js, so we walk one directory up to find package.json.
let CROSSPOINT_VERSION = "unknown";
try{
    CROSSPOINT_VERSION = require(path.join(__dirname, "..", "package.json")).version || "unknown";
}catch(e){}

import {MdnsService} from "./lib/mdnsService"

import { SyncLog } from "./lib/syncLog";


import { NmosRegistryConnector } from "./lib/nmosConnector";
import { WebsocketClient } from "./lib/SyncServer/websocketClient";

import { WebsocketSyncServer } from "./lib/SyncServer/websocketSyncServer";
import { CrosspointAbstraction } from "./lib/crosspointAbstraction";
import { SyncObject } from "./lib/SyncServer/syncObject";
import { parseSettings } from "./lib/parseSettings";
import { MulticastLeaseManager } from "./lib/multicastLeaseManager";
import { DnsPushService } from "./lib/dnsPushService";
import { NmosNodeApi } from "./lib/NmosNode/NmosNodeApi";
import { NmosNodeRegistration } from "./lib/NmosNode/NmosNodeRegistration";




const uiConfig = {
    "disabledModules":{
        "core":[]
    }
};


const log = new SyncLog();
SyncLog.log("info", "Process", "Server Startup.");

let settings: any = {};
try {
    let rawFile = fs.readFileSync("./config/settings.json");
    let tempSettings = JSON.parse(rawFile);
    settings = parseSettings(tempSettings);
} catch (e) {
    SyncLog.log("error", "Settings", "Error while reading file: ./config/settings.json", e);
    SyncLog.log("error", "Settings", "Can not run without Configuration...");
    process.exit();
}

if(settings.hasOwnProperty("logOutput")){
    log.setOutput(settings.logOutput);
}

let serverPort = 80;
let serverAddress = "0.0.0.0";

let modDisabled:string[]=[];

let mdns = new MdnsService(settings);
try{
    if(settings.hasOwnProperty("disabledModules") && settings.disabledModules.hasOwnProperty("core")){
        uiConfig.disabledModules.core = settings.disabledModules.core;
        settings.core.forEach((m)=>{
            let name = ""+m;
            modDisabled.push(name);
        });
    }
}catch(e){}

try{
    if(settings.hasOwnProperty('server') && settings.server.hasOwnProperty('port')){
        let serverPortTemp = parseInt(settings.server.port);
        if(serverPortTemp > 0 && serverPortTemp < 65536){
            serverPort = serverPortTemp;
        }else{
            throw new Error("Settings server port not a usable number.")
        }
    }else{
        throw new Error("Settings server port not a usable number.")
    }
}catch(e){
    SyncLog.log("error", "Settings", "Can not read Server Port from settings. Default to "+serverPort+".", e);
}

try{
    if(settings.hasOwnProperty('server') && settings.server.hasOwnProperty('address')){
        let serverAddressTemp = parseInt(settings.server.address);
    }else{
        throw new Error("Settings server address not a usable.");
    }
}catch(e){
    SyncLog.log("error", "Settings", "Can not read Server Address from settings. Default to "+serverAddress+".", e);
}

// Make the server.port available to NmosNodeApi (used to build the
// advertised manifest_href). settings.server may not have it explicitly set.
if(!settings.server || typeof settings.server !== "object") settings.server = {};
settings.server.port = serverPort;

// Construct the virtual NMOS Node API BEFORE the WebSocket server so we can
// mount its routes via the init() hook. Registration (POST to registry +
// heartbeat) happens further down once the registry connector exists.
const nmosNodeApi = new NmosNodeApi(settings);

WebsocketSyncServer.init(serverAddress, serverPort, (app:any) => {
    // Mount /x-nmos/... routes BEFORE the SPA-fallback so the registry and
    // any controller can query our virtual Node directly. Doing this in the
    // init callback guarantees the routes are registered between the static
    // middleware and the `/*` index.html fallback.
    nmosNodeApi.mount(app);
});
let server = WebsocketSyncServer.getInstance();
let users:any = null;
try {
    let rawFile = fs.readFileSync("./config/users.json");
    users = JSON.parse(rawFile);
} catch (e) {
    SyncLog.log("error", "Server", "Error while reading file: ./config/users.json", e);
}
if(users){
    server.relaodAuthData(users);
}


const crosspoint = new CrosspointAbstraction(settings);
const nmosConnector = new NmosRegistryConnector(settings);
const multicastLeaseManager = new MulticastLeaseManager(settings);
const dnsPushService = new DnsPushService();
try { dnsPushService.setSettings(settings.dnsPush); } catch (e) {}

// Register the virtual NMOS Node with the configured registry. Slight delay
// so the registry-side subscriptions in NmosRegistryConnector have a chance
// to come up first — that way, the registry's WS push reflecting our own
// just-registered Node lands cleanly in nmosState without racing.
const nmosNodeRegistration = new NmosNodeRegistration(settings);
setTimeout(async () => {
    try {
        // Ask the kernel which local IP it would use to reach the registry
        // (handles multi-homed / routed setups correctly without forcing
        // the operator to configure virtualNode.advertiseHost). The sync
        // subnet-match fallback inside NmosNodeApi covers same-VLAN setups
        // until this completes.
        await nmosNodeApi.detectAdvertiseHostAsync();
    } catch (e) {}
    try { nmosNodeRegistration.start(); } catch (e:any) {
        SyncLog.log("error", "NMOS Node", "Initial registration failed: " + (e?.message || e));
    }
}, 2000);

// Hook into the live registry switch: tear down our registration on the
// old registry, then re-register on the new one. NmosRegistryConnector
// already calls `reconnectStaticRegistries()` on a settings change — we
// piggy-back via an onRegistrySwitched callback to keep coupling minimal.
let _originalReconnect = (NmosRegistryConnector.instance as any)?.reconnectStaticRegistries?.bind(NmosRegistryConnector.instance);
if (_originalReconnect && NmosRegistryConnector.instance) {
    (NmosRegistryConnector.instance as any).reconnectStaticRegistries = async function() {
        try { await nmosNodeRegistration.stop(); } catch (e) {}
        _originalReconnect();
        // Give the new registry's WS subscription a tick to connect before
        // we POST our resources, so the registry's incoming PUTs find a
        // ready receiver. Re-run advertiseHost detection because the new
        // registry might live on a different subnet / interface.
        setTimeout(async () => {
            try {
                nmosNodeApi.setSettings(settings);
                await nmosNodeApi.detectAdvertiseHostAsync();
            } catch (e) {}
            try { nmosNodeRegistration.start(); } catch (e:any) {
                SyncLog.log("error", "NMOS Node", "Re-registration on new registry failed: " + (e?.message || e));
            }
        }, 2000);
    };
}

// Inventory of currently-pushed DNS entries, exposed to the Setup page.
function getDnsPushedSnapshot() {
    return {
        entries: dnsPushService.getPushedEntries(),
        updatedAt: new Date().toISOString()
    };
}
const dnsPushedSync: SyncObject = new SyncObject("dnsPushed", getDnsPushedSnapshot());
dnsPushService.setOnChange(() => {
    try { dnsPushedSync.setState(getDnsPushedSnapshot()); } catch (e) {}
});

// Build a fast { senderUuid → bitrate } map from the enriched crosspoint
// state. Crosspoint flow ids are namespaced as "nmos_<uuid>"; lease keys are
// raw UUIDs — hence the slice.
function buildBitrateIndex(): { [uuid: string]: any } {
    let out: { [uuid: string]: any } = {};
    try {
        let devs: any[] = (crosspoint.crosspointState && Array.isArray(crosspoint.crosspointState.devices))
            ? crosspoint.crosspointState.devices : [];
        for (let d of devs) {
            if (!d || !d.senders) continue;
            for (let type of Object.keys(d.senders)) {
                let arr = d.senders[type];
                if (!Array.isArray(arr)) continue;
                for (let s of arr) {
                    if (!s || typeof s.id !== "string") continue;
                    if (!s.id.startsWith("nmos_")) continue;
                    out[s.id.slice(5)] = s.bitrate;
                }
            }
        }
    } catch (e) {}
    return out;
}

// Each lease gets:
//   liveStatus — "active" / "inactive" / "missing", looked up from the live
//                NMOS sender table (subscription.active flag).
//   bitrate    — pulled from the enriched crosspoint state so the Setup
//                inventory shows the same value as the Details page.
// The Setup-page UI used to derive both fields client-side; doing it on the
// server keeps the multicastLeases sync object self-contained.
function getMulticastLeaseSnapshot() {
    let raw = multicastLeaseManager.getAllLeases();
    let nmosSenders: any = null;
    try {
        if (NmosRegistryConnector.instance) {
            nmosSenders = (NmosRegistryConnector.instance as any).nmosState?.senders;
        }
    } catch (e) {}
    let bitrateByUuid = buildBitrateIndex();
    let enriched: any = {};
    for (let id in raw) {
        let l = raw[id];
        if (!l) continue;
        let liveStatus: "active" | "inactive" | "missing" = "missing";
        try {
            let s = nmosSenders ? nmosSenders[id] : null;
            if (s) {
                liveStatus = (s.subscription && s.subscription.active) ? "active" : "inactive";
            }
        } catch (e) {}
        enriched[id] = Object.assign({}, l, {
            liveStatus,
            bitrate: bitrateByUuid[id]
        });
    }
    return {
        leases: enriched,
        stats: multicastLeaseManager.getStats(),
        updatedAt: new Date().toISOString()
    };
}
const multicastLeasesSync: SyncObject = new SyncObject("multicastLeases", getMulticastLeaseSnapshot());
multicastLeaseManager.setOnChange(() => {
    try {
        multicastLeasesSync.setState(getMulticastLeaseSnapshot());
    } catch (e) {}
});

// The lease snapshot's liveStatus + bitrate are sourced from the crosspoint
// state, so we need to republish whenever that state changes (e.g. a sender
// becomes active or its bitrate is recomputed). The lease manager itself
// doesn't see these transitions.
try {
    crosspoint.onStateUpdated = () => {
        try { multicastLeasesSync.setState(getMulticastLeaseSnapshot()); } catch (e) {}
    };
} catch (e) {}

// Make the allocator collision-aware against live NMOS senders: when picking
// a fresh pair, the manager will also skip any IP currently advertised in any
// sender's IS-05 active transport_params (including senders without a lease).
multicastLeaseManager.setExternalIpsProvider((excludeSenderId: string) => {
    try {
        if (NmosRegistryConnector.instance) {
            return NmosRegistryConnector.instance.getActiveSenderIps(excludeSenderId);
        }
    } catch (e) {}
    return new Set<string>();
});

// No periodic sweep — the NMOS registry's WebSocket subscription on /senders
// already pushes us an update whenever a sender's IS-04 resource (incl. its
// subscription.active flag) changes, which is what we use to trigger the
// per-sender reconcile. The only place we still invoke sweepAllSenders is
// once on the user toggling Auto-Allocation ON, so any pre-existing senders
// that haven't had a websocket update since then get their lease.




server.addSyncObject("log","global",log);

server.addSyncObject("nmos","global",nmosConnector.syncNmos);
server.addSyncObject("nmosConnectionState","global",nmosConnector.syncConnectionState);

server.addSyncObject("crosspoint","global",crosspoint.syncCrosspoint);


const uiConfigSync: SyncObject = new SyncObject("uiconfig", uiConfig);
server.addSyncObject("uiconfig","public",uiConfigSync);


// ----- Editable setup config exposed to the UI -----
// Currently this exposes the first NMOS registry entry plus the
// "acceptable GMID" hint used in the Details view. The values are mirrored
// into settings.json so they survive a restart; the in-memory settings of a
// running server are only partially updated, hence the restartRequired flag.
function getSetupConfigState() {
    let registry = { ip:"", port:80 };
    try{
        if(Array.isArray(settings.staticNmosRegistries) && settings.staticNmosRegistries.length > 0){
            let r = settings.staticNmosRegistries[0] || {};
            registry.ip = (typeof r.ip === "string") ? r.ip : "";
            let p = parseInt(""+r.port);
            registry.port = (!isNaN(p) && p > 0 && p < 65536) ? p : 80;
        }
    }catch(e){}
    let vendorProfiles:any[] = [];
    try{
        if(Array.isArray(settings.vendorProfiles)){
            vendorProfiles = settings.vendorProfiles.map((v:any) => ({...v}));
        }
    }catch(e){}
    let virtualSenders:any[] = [];
    try{
        if(Array.isArray(settings.virtualSenders)){
            virtualSenders = settings.virtualSenders.map((v:any) => ({
                id: v.id, name: v.name || "", sdp: v.sdp || "",
                senderId: v.senderId || ""
            }));
        }
    }catch(e){}
    let multicastRange:string = (typeof settings.multicastRange === "string") ? settings.multicastRange : "";
    let autoMulticast = {
        enabled: !!(settings.autoMulticast && settings.autoMulticast.enabled),
        // `!== false` default no longer fits — `false` is now the default,
        // so the UI gets exactly what's persisted.
        reconnectReceiversOnSenderChange: !!settings.reconnectReceiversOnSenderChange
    };
    let autoActivateInactiveSender = !!settings.autoActivateInactiveSender;
    let multicastStats = (MulticastLeaseManager.instance
        ? MulticastLeaseManager.instance.getStats()
        : { pool:{used:0,total:0}, audio:{used:0,total:0}, video:{used:0,total:0} });

    // DNS Push settings — the API key is never sent back to the client.
    // `apiKeySet` lets the UI show a placeholder so the user knows a key is
    // configured without leaking the actual value.
    let dnsPushCfg:any = (settings.dnsPush && typeof settings.dnsPush === "object") ? settings.dnsPush : {};
    let dnsPush = {
        enabled:     !!dnsPushCfg.enabled,
        serverIp:    (typeof dnsPushCfg.serverIp === "string")   ? dnsPushCfg.serverIp : "",
        serverPort:  (typeof dnsPushCfg.serverPort === "number") ? dnsPushCfg.serverPort : 443,
        protocol:    dnsPushCfg.protocol === "http" ? "http" : "https",
        apiKey:      "",
        apiKeySet:   !!(typeof dnsPushCfg.apiKey === "string" && dnsPushCfg.apiKey.length > 0),
        domain:      (typeof dnsPushCfg.domain === "string" && dnsPushCfg.domain) ? dnsPushCfg.domain : "local",
        insecureTLS: dnsPushCfg.insecureTLS !== false,
    };

    // Auth snapshot — just the configured username(s) so the UI can show
    // "current login" in the change-credentials form. The password is NEVER
    // sent out; the client only knows whether one is set.
    let authUsers:string[] = [];
    try{
        if(users && users.users && typeof users.users === "object"){
            authUsers = Object.keys(users.users);
        }
    }catch(e){}

    // Virtual NMOS Node feature: master toggle the Setup page exposes,
    // plus the read-only nodeId so the Details page can detect which
    // crosspoint senders belong to our virtual device (and hide the
    // multicast-edit button for them — virtual senders are read-only over
    // IS-05, the IP comes straight from the operator-pasted SDP).
    let virtualNodeCfg = (settings.virtualNode && typeof settings.virtualNode === "object") ? settings.virtualNode : {};
    let virtualNode = {
        enabled:  virtualNodeCfg.enabled !== false,
        deviceId: (typeof virtualNodeCfg.deviceId === "string") ? virtualNodeCfg.deviceId : "",
        nodeId:   (typeof virtualNodeCfg.nodeId   === "string") ? virtualNodeCfg.nodeId   : ""
    };

    return {
        registry,
        acceptableGmid: (typeof settings.acceptableGmid === "string") ? settings.acceptableGmid : "",
        vendorProfiles,
        virtualSenders,
        virtualNode,
        multicastRange,
        autoMulticast,
        autoActivateInactiveSender,
        multicastStats,
        dnsPush,
        auth: { users: authUsers },
        restartRequired: false,
        // Build version (from server/package.json). UI renders it in the
        // Setup page header so the operator can tell deploys apart at a
        // glance.
        version: CROSSPOINT_VERSION
    };
}
const setupConfigSync: SyncObject = new SyncObject("setupConfig", getSetupConfigState());
server.addSyncObject("setupConfig","public",setupConfigSync);

// Refresh the setupConfig SyncObject when the crosspoint abstraction
// renames a virtual sender (alias change on the Details page). Keeps the
// Setup-page form in sync with the actually-stored name without
// requiring a reload.
try{
    crosspoint.onVirtualSendersChange = () => {
        try{ setupConfigSync.setState(getSetupConfigState()); }catch(e){}
        // Also re-register the renamed sender with the registry so other
        // controllers see the new label without waiting for the next
        // settings.json round-trip.
        try{
            nmosNodeApi.setSettings(settings);
            nmosNodeRegistration.setSettings(settings);
            nmosNodeRegistration.syncResources().catch(()=>{});
        }catch(e){}
    };
}catch(e){}


/**
 * Walk every NMOS node and pair it with the display name we want to push
 * to DNS. If any crosspoint device that belongs to this node has been
 * given a user alias, that alias wins; otherwise we use the node label.
 *
 * Returns an array of `{nodeId, displayName, ip}` ready for
 * DnsPushService.scheduleNodePush / syncAll.
 */
function collectDnsPushNodes(): { nodeId:string, displayName:string, ip:string }[] {
    let out: { nodeId:string, displayName:string, ip:string }[] = [];
    try{
        let nc = NmosRegistryConnector.instance;
        if(!nc) return out;
        // The NmosRegistryConnector keeps the authoritative state in a private
        // field; the SyncObject's `state` is just a publishable copy of the
        // same object. Cast through `any` to read it without changing the
        // class's public surface.
        let nmos:any = (nc as any).nmosState;
        if(!nmos || !nmos.nodes) return out;

        // Build a map nodeId → preferred alias (first crosspoint device whose
        // alias was customised by the user). Handles both nmos_<deviceId>
        // direct devices and nmosgrp_<hash> grouphint groups.
        let aliasByNode: { [nodeId:string]: string } = {};
        try{
            // crosspointState is updated on every worker tick.
            let xpDevices = (crosspoint.crosspointState && Array.isArray(crosspoint.crosspointState.devices))
                          ? crosspoint.crosspointState.devices : [];
            if(Array.isArray(xpDevices)){
                for(let xd of xpDevices){
                    if(!xd || typeof xd.id !== "string") continue;
                    let alias = (typeof xd.alias === "string") ? xd.alias : "";
                    let name  = (typeof xd.name  === "string") ? xd.name  : "";
                    if(!alias || alias === name) continue;  // not user-customised

                    let xdNodeId = "";
                    if(xd.id.startsWith("nmos_")){
                        let devId = xd.id.slice(5);
                        let dev:any = nmos.devices?.[devId];
                        if(dev && dev.node_id) xdNodeId = dev.node_id;
                    }else if(xd.id.startsWith("nmosgrp_")){
                        for(let type of Object.keys(xd.senders || {})){
                            for(let s of (xd.senders[type] || [])){
                                if(!s || typeof s.id !== "string") continue;
                                if(!s.id.startsWith("nmos_")) continue;
                                let sender:any = nmos.senders?.[s.id.slice(5)];
                                if(sender && sender.device_id){
                                    let dev:any = nmos.devices?.[sender.device_id];
                                    if(dev && dev.node_id){ xdNodeId = dev.node_id; }
                                    break;
                                }
                            }
                            if(xdNodeId) break;
                        }
                    }

                    if(xdNodeId && !aliasByNode[xdNodeId]){
                        aliasByNode[xdNodeId] = alias;
                    }
                }
            }
        }catch(e){}

        for(let nodeId in nmos.nodes){
            let n:any = nmos.nodes[nodeId];
            if(!n) continue;
            let ip = "";
            try{
                if(typeof n.href === "string" && n.href){
                    ip = new URL(n.href).hostname;
                }
            }catch(e){}
            if(!ip) continue;
            let displayName = aliasByNode[nodeId] || n.label || "";
            if(!displayName) continue;
            out.push({ nodeId, displayName, ip });
        }
    }catch(e){}
    return out;
}

server.addSyncObject("multicastLeases","global",multicastLeasesSync);
server.addSyncObject("dnsPushed","global",dnsPushedSync);

// Release a single multicast lease from the Setup page inventory. The
// allocated pair goes back into the pool; the next call to ensureLease
// for that sender (e.g. when reconcile fires again) will allocate a fresh
// pair if auto-allocation is enabled.
server.addRoute("POST", "releaseLease","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            let sid = (postData && typeof postData.senderId === "string") ? postData.senderId.trim() : "";
            if(!sid){
                reject({message:"missing senderId"});
                return;
            }
            multicastLeaseManager.releaseLeases([sid]);
            resolve({message:200, data:{ released: sid }});
        }catch(e:any){
            reject({message: (e && e.message) ? e.message : "releaseLease failed"});
        }
    });
});

// Release every multicast lease in one shot. Active senders that still need
// a lease and have auto-allocation enabled will get a fresh pair allocated
// on the next reconcile cycle — same path as releasing a single lease.
server.addRoute("POST", "releaseAllLeases","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            let ids = Object.keys(multicastLeaseManager.getAllLeases());
            if(ids.length === 0){
                resolve({message:200, data:{ released: 0 }});
                return;
            }
            multicastLeaseManager.releaseLeases(ids);
            SyncLog.log("info", "Multicast Lease", "Released ALL " + ids.length + " leases via UI.");
            resolve({message:200, data:{ released: ids.length }});
        }catch(e:any){
            reject({message: (e && e.message) ? e.message : "releaseAllLeases failed"});
        }
    });
});

server.addRoute("POST", "setupConfig","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            let next = getSetupConfigState();

            // Apply incoming changes (only known fields)
            if(postData && typeof postData === "object"){
                if(postData.registry && typeof postData.registry === "object"){
                    if(typeof postData.registry.ip === "string"){
                        next.registry.ip = postData.registry.ip.trim();
                    }
                    if(postData.registry.port !== undefined){
                        let p = parseInt(""+postData.registry.port);
                        if(!isNaN(p) && p > 0 && p < 65536){
                            next.registry.port = p;
                        }
                    }
                }
                if(typeof postData.acceptableGmid === "string"){
                    next.acceptableGmid = postData.acceptableGmid.trim().toUpperCase();
                }
                if(typeof postData.multicastRange === "string"){
                    let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
                    let v = postData.multicastRange.trim();
                    if(cidrRe.test(v)){
                        next.multicastRange = v;
                    }
                }
                if(postData.autoMulticast && typeof postData.autoMulticast === "object"){
                    if(typeof postData.autoMulticast.enabled === "boolean"){
                        next.autoMulticast.enabled = postData.autoMulticast.enabled;
                    }
                    // Accept the new name; tolerate the old one for backwards compat.
                    if(typeof postData.autoMulticast.reconnectReceiversOnSenderChange === "boolean"){
                        next.autoMulticast.reconnectReceiversOnSenderChange = postData.autoMulticast.reconnectReceiversOnSenderChange;
                    }else if(typeof postData.autoMulticast.reconnectReceiversOnMulticastChange === "boolean"){
                        next.autoMulticast.reconnectReceiversOnSenderChange = postData.autoMulticast.reconnectReceiversOnMulticastChange;
                    }
                }
                if(typeof postData.autoActivateInactiveSender === "boolean"){
                    next.autoActivateInactiveSender = postData.autoActivateInactiveSender;
                }
                if(postData.dnsPush && typeof postData.dnsPush === "object"){
                    let d = postData.dnsPush;
                    if(typeof d.enabled === "boolean"){ next.dnsPush.enabled = d.enabled; }
                    if(typeof d.serverIp === "string"){ next.dnsPush.serverIp = d.serverIp.trim(); }
                    if(d.serverPort !== undefined){
                        let p = parseInt(""+d.serverPort);
                        if(!isNaN(p) && p > 0 && p < 65536){ next.dnsPush.serverPort = p; }
                    }
                    if(d.protocol === "http" || d.protocol === "https"){ next.dnsPush.protocol = d.protocol; }
                    // Empty/undefined apiKey means "keep the existing one" —
                    // we never send the real value out, so the UI couldn't
                    // round-trip it on save. Any non-empty string replaces it.
                    if(typeof d.apiKey === "string" && d.apiKey.length > 0){
                        next.dnsPush.apiKey = d.apiKey;
                        next.dnsPush.apiKeySet = true;
                    }
                    if(typeof d.domain === "string" && d.domain.trim()){ next.dnsPush.domain = d.domain.trim(); }
                    if(typeof d.insecureTLS === "boolean"){ next.dnsPush.insecureTLS = d.insecureTLS; }
                }
                if(Array.isArray(postData.vendorProfiles)){
                    next.vendorProfiles = postData.vendorProfiles
                        .filter((v:any) => v && typeof v === "object")
                        .map((v:any) => {
                            let port = parseInt(""+v.port);
                            if(isNaN(port) || port <= 0 || port > 65535){ port = 80; }
                            let protocol = (""+v.protocol).toLowerCase();
                            if(protocol !== "http" && protocol !== "https"){ protocol = "http"; }
                            let path = (typeof v.path === "string" && v.path) ? v.path : "/";
                            if(!path.startsWith("/")){ path = "/" + path; }
                            let labels = "";
                            if(typeof v.labels === "string"){ labels = v.labels; }
                            else if(typeof v.labelContains === "string"){ labels = v.labelContains; }
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
                if(Array.isArray(postData.virtualSenders)){
                    // Preserve existing senderIds keyed by the editor `id`
                    // so an edit-and-save doesn't churn the UUIDs and break
                    // any currently-connected receivers.
                    let prevSenderIds: {[id:string]:string} = {};
                    try{
                        if(Array.isArray(settings.virtualSenders)){
                            for(let v of settings.virtualSenders){
                                if(v && typeof v.id === "string" && typeof v.senderId === "string"){
                                    prevSenderIds[v.id] = v.senderId;
                                }
                            }
                        }
                    }catch(e){}
                    next.virtualSenders = postData.virtualSenders
                        .filter((v:any) => v && typeof v === "object")
                        .map((v:any) => {
                            let id = (typeof v.id === "string" && v.id) ? v.id : ("vs_" + Math.random().toString(36).slice(2,10));
                            let senderId = (typeof v.senderId === "string" && /^[a-f0-9-]{36}$/i.test(v.senderId))
                                ? v.senderId
                                : (prevSenderIds[id] || "");  // parseSettings will mint one if still ""
                            return {
                                id,
                                name: (typeof v.name === "string") ? v.name.trim() : "",
                                sdp:  (typeof v.sdp === "string") ? v.sdp : "",
                                senderId
                            };
                        });
                }
                if(postData.virtualNode && typeof postData.virtualNode === "object" && typeof postData.virtualNode.enabled === "boolean"){
                    // getSetupConfigState always seeds next.virtualNode with
                    // { enabled, deviceId, nodeId } — we only ever flip the
                    // operator-controlled enable flag here.
                    if(next.virtualNode){
                        next.virtualNode.enabled = postData.virtualNode.enabled;
                    }
                }
            }

            // Reflect into the in-memory settings object
            if(!Array.isArray(settings.staticNmosRegistries) || settings.staticNmosRegistries.length === 0){
                settings.staticNmosRegistries = [{ip:"", port:80, priority:10, domain:""}];
            }
            let firstChanged = false;
            if(settings.staticNmosRegistries[0].ip !== next.registry.ip){
                settings.staticNmosRegistries[0].ip = next.registry.ip;
                firstChanged = true;
            }
            if(settings.staticNmosRegistries[0].port !== next.registry.port){
                settings.staticNmosRegistries[0].port = next.registry.port;
                firstChanged = true;
            }
            let prevAcceptableGmid = settings.acceptableGmid || "";
            settings.acceptableGmid = next.acceptableGmid;
            settings.vendorProfiles = next.vendorProfiles;

            // Track whether anything that affects our published IS-04 Node
            // changed (virtual senders, acceptable GMID for the clock entry,
            // the master enable toggle). If yes, rebuild + re-POST below.
            let virtualSendersChanged = Array.isArray(next.virtualSenders);
            let gmidChanged           = prevAcceptableGmid !== settings.acceptableGmid;
            let prevVirtualEnabled    = !settings.virtualNode || settings.virtualNode.enabled !== false;
            let nextVirtualEnabled    = (next.virtualNode && typeof next.virtualNode.enabled === "boolean")
                                            ? next.virtualNode.enabled
                                            : prevVirtualEnabled;
            let virtualToggleChanged  = prevVirtualEnabled !== nextVirtualEnabled;

            if(virtualToggleChanged){
                if(!settings.virtualNode) settings.virtualNode = {};
                settings.virtualNode.enabled = nextVirtualEnabled;
            }

            if(virtualSendersChanged){
                settings.virtualSenders = next.virtualSenders;
                // Re-run the parse step on just this slice so any missing
                // senderId / sourceId / flowId UUIDs get minted and the
                // schema stays self-healing (same logic as boot-time read).
                try{
                    let tmp:any = { virtualSenders: settings.virtualSenders };
                    parseSettings(tmp);
                    settings.virtualSenders = tmp.virtualSenders;
                }catch(e){}
                // Notify the crosspoint abstraction so the worker's
                // virtualSenders mirror stays current (used by the alias-
                // rename round-trip; the worker no longer materialises a
                // synthetic device).
                try{ crosspoint.setVirtualSenders(settings.virtualSenders); }catch(e){}
            }

            // Master toggle transitions take precedence over re-sync: when
            // turning the feature off we DELETE everything from the registry;
            // when turning it on we POST it all from scratch. Both reset the
            // tracking sets inside NmosNodeRegistration.
            if(virtualToggleChanged){
                try{ nmosNodeApi.setSettings(settings); }catch(e){}
                try{ nmosNodeRegistration.setSettings(settings); }catch(e){}
                if(nextVirtualEnabled){
                    // off → on: register from scratch.
                    nmosNodeRegistration.start().catch(()=>{});
                }else{
                    // on → off: deregister and stop heartbeat.
                    nmosNodeRegistration.stop().catch(()=>{});
                }
            }else if(virtualSendersChanged || gmidChanged){
                // Rebuild the IS-04 / IS-05 record cache from the new
                // settings (virtual senders' SDPs and the acceptable GMID
                // both feed into the Node + Sender records) and re-POST
                // everything so the registry sees the change.
                try{
                    nmosNodeApi.setSettings(settings);
                    nmosNodeRegistration.setSettings(settings);
                    nmosNodeRegistration.syncResources().catch(()=>{});
                }catch(e:any){
                    SyncLog.log("warn", "NMOS Node", "Could not re-sync to registry: " + (e?.message || e));
                }
            }
            // Track whether the multicast pool CIDR changed — the UI sends
            // the same Adopt-vs-Renew choice for that case, so we need a
            // flag to fan out the corresponding sweep below.
            let prevMulticastRange = (typeof settings.multicastRange === "string") ? settings.multicastRange : "";
            let multicastRangeChanged = false;
            if(typeof next.multicastRange === "string" && next.multicastRange){
                if(prevMulticastRange !== next.multicastRange){
                    multicastRangeChanged = true;
                }
                settings.multicastRange = next.multicastRange;
            }
            let autoMulticastWasEnabled = !!(settings.autoMulticast && settings.autoMulticast.enabled);
            settings.autoMulticast = { enabled: !!next.autoMulticast.enabled };
            settings.reconnectReceiversOnSenderChange = !!next.autoMulticast.reconnectReceiversOnSenderChange;
            settings.autoActivateInactiveSender = !!next.autoActivateInactiveSender;
            // Strip the obsolete in-memory field too so the next settings.json
            // write doesn't carry it forward.
            if(settings.hasOwnProperty("reconnectReceiversOnMulticastChange")){
                delete settings.reconnectReceiversOnMulticastChange;
            }
            try{
                if(MulticastLeaseManager.instance){
                    MulticastLeaseManager.instance.setSettings(settings);
                }
            }catch(e){}

            // ----- DNS Push settings -----
            // Preserve the existing API key if the form sent us an empty one.
            let dnsPushWasEnabled = !!(settings.dnsPush && settings.dnsPush.enabled);
            let prevApiKey = (settings.dnsPush && typeof settings.dnsPush.apiKey === "string") ? settings.dnsPush.apiKey : "";
            let newApiKey = next.dnsPush.apiKey || prevApiKey;
            settings.dnsPush = {
                enabled:     !!next.dnsPush.enabled,
                serverIp:    next.dnsPush.serverIp,
                serverPort:  next.dnsPush.serverPort,
                protocol:    next.dnsPush.protocol,
                apiKey:      newApiKey,
                domain:      next.dnsPush.domain,
                insecureTLS: !!next.dnsPush.insecureTLS,
            };
            try{
                if(DnsPushService.instance){
                    DnsPushService.instance.setSettings(settings.dnsPush);
                }
            }catch(e){}
            // Adopt-vs-Renew sweep. Fires in two cases:
            //   1) Auto-Allocation just got switched ON.
            //   2) Auto-Allocation is on and the operator picked a new
            //      multicast CIDR — current leases may be outside the new
            //      range, so we offer the same choice.
            // `adoptOnEnable`:
            //   true  → keep each sender's current IP as its lease (no PATCH,
            //           no stream interruption);
            //   false → force everyone onto a fresh pool address (disruptive).
            let needSweep =
                (!autoMulticastWasEnabled && settings.autoMulticast.enabled) ||
                (settings.autoMulticast.enabled && multicastRangeChanged);
            if(needSweep){
                try{
                    if(NmosRegistryConnector.instance){
                        let adopt = !!(postData && postData.autoMulticast && postData.autoMulticast.adoptOnEnable === true);
                        if(adopt){
                            NmosRegistryConnector.instance.adoptCurrentSenderIPs();
                        }else{
                            NmosRegistryConnector.instance.sweepAllSenders();
                        }
                    }
                }catch(e){}
            }

            // If DNS Push was just enabled (or any field changed while
            // enabled), push every currently known NMOS node so the user
            // doesn't have to wait for a node-update event to see entries
            // appear.
            try{
                if(settings.dnsPush.enabled && DnsPushService.instance){
                    let nodes = collectDnsPushNodes();
                    if(nodes.length > 0){
                        DnsPushService.instance.syncAll(nodes).catch(()=>{});
                    }
                }
            }catch(e){}
            // Silence unused-warning — kept for potential future use (e.g.
            // logging "DNS Push enabled" only on the off→on transition).
            void dnsPushWasEnabled;

            // Persist to settings.json
            try{
                fs.writeFileSync("./config/settings.json", JSON.stringify(settings, null, 4));
                SyncLog.log("info", "Settings", "Updated ./config/settings.json from setup page.");
            }catch(e:any){
                SyncLog.log("error", "Settings", "Failed to write ./config/settings.json: " + e.message);
                reject({message:"Could not write settings.json: " + e.message});
                return;
            }

            // Refresh stats after the manager has the new settings
            try{
                if(MulticastLeaseManager.instance){
                    next.multicastStats = MulticastLeaseManager.instance.getStats();
                }
            }catch(e){}

            // Scrub the DNS Push password from the response — the version of
            // `next` we built above carries the cleartext password the user
            // just typed, which must never make it back over the wire. The
            // canonical "what the UI is allowed to see" shape comes from
            // getSetupConfigState() (password is always "" there).
            try{
                let safeDnsPush = getSetupConfigState().dnsPush;
                next.dnsPush = safeDnsPush;
            }catch(e){}

            // A registry change is hot-applied: tear down every active query
            // API WebSocket and re-subscribe to the new IP/port. The NMOS
            // SyncObject is reset along the way so the UI doesn't keep cards
            // for devices that belong to the old registry.
            if(firstChanged){
                try{
                    if(NmosRegistryConnector.instance){
                        NmosRegistryConnector.instance.reconnectStaticRegistries();
                    }
                }catch(e:any){
                    SyncLog.log("error", "NMOS Settings", "Live registry switch failed: " + (e?.message || e));
                }
            }
            // Restart no longer required — keep the field for back-compat
            // with older UIs but always report false from here on.
            next.restartRequired = false;
            setupConfigSync.setState(next);

            resolve({message:200, data:next});
        }catch(e:any){
            reject({message: "setupConfig failed: " + e.message});
        }
    });
});





// ----- Change admin credentials -----
// The auth model stores `sha256(plaintextPassword)` in users.json (see
// `users.json` and websocketClient.processAuth). The client only ever
// knows that hash too — never the plaintext password as stored on disk.
// So this route accepts:
//   currentUsername     — the user being modified (must equal client.user)
//   currentPasswordHash — sha256(currentPlaintext) computed in the browser
//   newUsername         — optional rename; if "" or unchanged, no rename
//   newPasswordHash     — sha256(newPlaintext); if "" the password is kept
// We refuse if the caller isn't logged in (`__noAuth`), or if they try to
// edit a different user than they're authenticated as. After the rename
// the user will be auto-logged-out — their stored hash no longer matches.
server.addRoute("POST", "changeCredentials","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            if(!client || !client.user || client.user === "__noAuth"){
                reject({message:"Not authenticated."});
                return;
            }
            let curUser = (postData && typeof postData.currentUsername === "string") ? postData.currentUsername.trim() : "";
            let curHash = (postData && typeof postData.currentPasswordHash === "string") ? postData.currentPasswordHash.trim().toLowerCase() : "";
            let newUser = (postData && typeof postData.newUsername === "string") ? postData.newUsername.trim() : "";
            let newHash = (postData && typeof postData.newPasswordHash === "string") ? postData.newPasswordHash.trim().toLowerCase() : "";

            if(!curUser){ reject({message:"Current username is required."}); return; }
            if(curUser !== client.user){
                reject({message:"You can only change the credentials of your own account."});
                return;
            }
            if(!users || !users.users || typeof users.users !== "object" || !users.users[curUser]){
                reject({message:"User not found."});
                return;
            }
            let stored = users.users[curUser];
            let storedPass = (typeof stored.password === "string") ? stored.password.toLowerCase() : "";
            if(!storedPass || storedPass !== curHash){
                reject({message:"Current password is wrong."});
                return;
            }
            // Validate the optional new username
            if(newUser && newUser !== curUser){
                if(!/^[A-Za-z0-9_.-]{1,64}$/.test(newUser)){
                    reject({message:"New username must be 1-64 characters: letters, digits, _ . -"});
                    return;
                }
                if(users.users.hasOwnProperty(newUser)){
                    reject({message:"That username already exists."});
                    return;
                }
            }
            if(newHash){
                if(!/^[a-f0-9]{64}$/.test(newHash)){
                    reject({message:"New password hash malformed."});
                    return;
                }
            }
            // Apply: rename (preserves groups), then optionally update password.
            let finalUser = (newUser && newUser !== curUser) ? newUser : curUser;
            if(finalUser !== curUser){
                users.users[finalUser] = { ...stored };
                delete users.users[curUser];
            }
            if(newHash){
                users.users[finalUser].password = newHash;
            }
            // Persist users.json (atomic-ish — write temp then rename).
            try{
                let tmp = "./config/users.json.tmp";
                fs.writeFileSync(tmp, JSON.stringify(users, null, 4));
                fs.renameSync(tmp, "./config/users.json");
                SyncLog.log("info", "Settings", "Updated ./config/users.json (credentials change for "+curUser+(finalUser!==curUser?" → "+finalUser:"")+").");
            }catch(e:any){
                SyncLog.log("error", "Settings", "Failed to write ./config/users.json: " + e.message);
                reject({message:"Could not write users.json: " + e.message});
                return;
            }
            // Hot-reload the in-memory auth table so the next auth attempt
            // (after the client re-logs-in) is checked against the new data.
            try{ server.relaodAuthData(users); }catch(e){}

            // Refresh the setupConfig SyncObject so the username field
            // updates everywhere immediately.
            try{ setupConfigSync.setState(getSetupConfigState()); }catch(e){}

            resolve({message:200, data:{ ok:true, username: finalUser, passwordChanged: !!newHash }});
        }catch(e:any){
            reject({message: "changeCredentials failed: " + (e?.message || e)});
        }
    });
});


// ----- Multicast lease export / import -----
server.addRoute("GET", "exportLeases","global", (client: WebsocketClient, query:string[]) => {
    return new Promise((resolve, reject) => {
        try{
            let data = MulticastLeaseManager.instance ? MulticastLeaseManager.instance.exportLeases() : {version:1, leases:{}};
            resolve({message:200, data});
        }catch(e:any){ reject({message: "exportLeases failed: " + e.message}); }
    });
});
server.addRoute("POST", "importLeases","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            if(!MulticastLeaseManager.instance){
                reject({message:"Lease manager not available"});
                return;
            }
            let result = MulticastLeaseManager.instance.importLeases(postData);
            // Republish stats
            try{
                let s = getSetupConfigState();
                setupConfigSync.setState(s);
            }catch(e){}
            resolve({message:200, data: result});
        }catch(e:any){
            reject({message:"importLeases failed: " + e.message});
        }
    });
});


server.addRoute("GET", "flowInfo","global" , (client: WebsocketClient, query:string[]) => {
    return new Promise((resolve, reject) => {
        let flowId = query[0];
        if(flowId){
            let flow = crosspoint.getFlowInfo(flowId);
            if(flow){
                resolve({message:200, data:flow});
            }else{
                reject("flow not found");
            }
        }else{
            reject("missing flow Id");
        }
        
    });
});

server.addRoute("POST", "makeconnection","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .makeConnection(postData)
            .then((data) => resolve({message:200, data:data}))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "changealias","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .changeAlias(postData.id, postData.alias)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "enableFlow","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableFlow(postData.id, false)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "disableFlow","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableFlow(postData.id, true)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "enableReceiver","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableReceiver(postData.id, false)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "disableReceiver","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableReceiver(postData.id, true)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});


server.addRoute("POST", "setMulticast","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .setMulticast(postData.id, postData.data)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});





server.addRoute("POST", "togglehidden","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .toggleHidden(postData.id)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});



// Crosspoint editor
server.addRoute("POST", "crosspoint","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .crosspointApi(postData)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});


