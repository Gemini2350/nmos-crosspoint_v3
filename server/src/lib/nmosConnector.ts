/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import * as WebSocket from "ws";
import * as dns from "dns";
import axios from "axios";
import { SyncObject } from "./SyncServer/syncObject";
import { Subject } from "rxjs";

import { setTimeout as sleep } from 'node:timers/promises'

import { LoggedError, SyncLog } from "./syncLog";

import {MdnsService} from "./mdnsService"

import * as jsonpatch from 'fast-json-patch';


import * as sdpTransform from 'sdp-transform';
import { CrosspointAbstraction, CrosspointConnectionSenderInfo } from "./crosspointAbstraction";
import { MulticastLeaseManager } from "./multicastLeaseManager";
import { DdnsService } from "./ddnsService";

const fs = require("fs");



export class NmosRegistryConnector {
    private logReset = true;
    static instance:null|NmosRegistryConnector = null;
    public syncNmos: SyncObject;
    public syncConnectionState: SyncObject;

    public static registerHook(type:"nodes"|"devices"|"flows"|"senders"|"receivers"|"sources"|"sendersManifestDetail", callback: (id:string, data:any) => any){
        this.hookCallbackList[type].push(callback);
        if(NmosRegistryConnector.instance){
            Object.keys(NmosRegistryConnector.instance.nmosState[type]).forEach((item)=>{
                callback(item, NmosRegistryConnector.instance.nmosState[type][item]);
            });
        }
    }

    public static registerModifier(type:"nodes"|"devices"|"flows"|"senders"|"receivers"|"sources"|"sendersManifestDetail", callback: (id:string, data:any) => any){
        this.modifierCallbackList[type].push(callback);
    }

    static hookCallbackList = {
        "nodes" : [],
        "devices" : [],
        "sources" : [],
        "senders" : [],
        "receivers" : [],
        "flows" : [],
        "sendersManifestDetail":[]
    }

    static modifierCallbackList = {
        "nodes" : [],
        "devices" : [],
        "sources" : [],
        "senders" : [],
        "receivers" : [],
        "flows" : [],
        "sendersManifestDetail":[]
    }

    settings:any = {};

    constructor(config:any, loaddev = false) {
        this.settings = config;
        NmosRegistryConnector.instance = this;
        this.syncNmos = new SyncObject("nmos", this.nmosState);
        this.syncConnectionState = new SyncObject("nmosConnectionState");

        this.registryVersionList = this.settings.nmos.registryVersions;
        this.connectVersionList = this.settings.nmos.connectVersions

        // TODO dev cleanup
        //if(loaddev){
        if(false){
            try {
                let rawFile = fs.readFileSync("./state/devnmosstate/devnmosstate.json");
                let nmosDev = JSON.parse(rawFile);

                for(let type in nmosDev){
                    for(let path in nmosDev[type]){
                        let postData = nmosDev[type][path];
                            NmosRegistryConnector.modifierCallbackList[type].forEach((f)=>{
                                postData = f(path, postData);
                            })
                            this.nmosState[type][path] = postData;
                            NmosRegistryConnector.hookCallbackList[type].forEach((f)=>{
                                f(path, postData);
                            })
                    }
                }

            } catch (e) {}
            this.scheduleSyncNmos();
            this.updateCrosspoint();
        }
        // ----- dev cleanup

        
        this.settings.staticNmosRegistries.forEach((staticRegistry) => {
            // An empty IP means "no static registry configured" — skip it so
            // the discovery cascade (unicast DNS-SD, then mDNS) can take over.
            if(!staticRegistry || !staticRegistry.ip || !staticRegistry.port) return;
            try {
                let registry: NmosRegistry = {
                    ip: staticRegistry.ip,
                    port: staticRegistry.port,
                    priority: staticRegistry.priority,
                    source: "static",
                    domain: staticRegistry.domain,
                };
                this.addRegistry(registry);
                SyncLog.log("info","NMOS Settings","Adding Static Registry: "+ JSON.stringify(staticRegistry) );
            } catch (e) {
                SyncLog.log("error","NMOS Settings","Can not add Static Registry: "+ JSON.stringify(staticRegistry) );
            }
        });

        // Unicast DNS-SD discovery runs first (default ON) — one DNS query
        // round against the search domain is cheap and instant. mDNS follows
        // as the fallback; the source ranking inside addRegistry() makes
        // sure a DNS-SD result outranks mDNS and a static entry beats both.
        this.dnssdQuery().catch(()=>{});
        this.dnssdQueryInterval = setInterval(() => {
            this.dnssdQuery().catch(()=>{});
        }, 60000);

        setTimeout(()=>{
            this.mdnsQuery();
        },5000);
        this.mdnsQueryInterval = setInterval(() => {
            this.mdnsQuery();
        }, 20000);

        MdnsService.registerHook((response) => {
            response.answers.forEach((answer) => {
                
                if (answer.name == "_nmos-registration._tcp.local") {
                    let registry: NmosRegistry = { ip: "0.0.0.0", port: 0, priority: 1000, source: "mdns", domain: "" };
                    response.additionals.forEach((element) => {
                        if (element.type == "A") {
                            registry.ip = element.data;
                        }
                        if (element.type == "SRV") {
                            registry.port = element.data.port;
                            registry.domain = element.data.target;
                        }
                    });
                    if (registry.port != 0 && registry.ip != "0.0.0.0") {
                        this.addRegistry(registry);
                    }
                }
            });
        });
    }

    private mdnsQuery() {
        MdnsService.query({
            questions: [
                {
                    name: "_nmos-registration._tcp.local",
                    type: "PTR",
                    class: "IN",
                },
            ],
        });
    }

    // Discovery cascade: an operator-entered static IP always wins, unicast
    // DNS-SD beats mDNS. Registries from a lower-ranked source are ignored
    // while a higher-ranked one is connected; a higher-ranked discovery
    // takes over from a lower-ranked connection.
    private static sourceRank(source: string): number {
        return source === "static" ? 3 : source === "dnssd" ? 2 : 1;
    }

    /** Resolve the DNS-SD domains to query: the Setup override if set,
     *  otherwise the system resolver's search domains (/etc/resolv.conf —
     *  present in the container; empty list elsewhere is a clean no-op). */
    private dnssdSearchDomains(): string[] {
        let cfg = "";
        try{ cfg = ("" + (this.settings?.registryDiscovery?.domain || "")).trim().replace(/\.+$/, ""); }catch(e){}
        if(cfg){ return [cfg]; }
        try{
            const txt = fs.readFileSync("/etc/resolv.conf", "utf8");
            const domains: string[] = [];
            for(const line of ("" + txt).split("\n")){
                const m = line.match(/^\s*(search|domain)\s+(.+)$/);
                if(!m) continue;
                for(const d of m[2].trim().split(/\s+/)){
                    const clean = d.trim().replace(/\.+$/, "");
                    if(clean && clean !== "local" && !domains.includes(clean)){ domains.push(clean); }
                }
            }
            return domains;
        }catch(e){ return []; }
    }

    /** Unicast DNS-SD (RFC 6763 over normal DNS): PTR on
     *  _nmos-register._tcp.<domain> (v1.3; plus the deprecated
     *  _nmos-registration._tcp name) → SRV per instance → A record. */
    private async dnssdQuery() {
        try{
            if(this.settings?.registryDiscovery?.unicastDnssd === false) return;
        }catch(e){}
        const domains = this.dnssdSearchDomains();
        if(domains.length === 0){
            if(!this.loggedDnssdNoDomain){
                this.loggedDnssdNoDomain = true;
                SyncLog.log("verbose", "NMOS", "Unicast DNS-SD discovery: no DNS search domain found and none configured — relying on mDNS / static registry.");
            }
            return;
        }
        const services = ["_nmos-register._tcp.", "_nmos-registration._tcp."];
        for(const domain of domains){
            for(const svc of services){
                let instances: string[] = [];
                try{ instances = await dns.promises.resolvePtr(svc + domain); }
                catch(e){ continue; }   // NXDOMAIN etc. — try the next name
                for(const inst of instances){
                    try{
                        const srvs = await dns.promises.resolveSrv(inst);
                        for(const srv of srvs){
                            const target = ("" + srv.name).replace(/\.+$/, "");
                            if(!target || !srv.port) continue;
                            let ip = target;
                            try{
                                const addrs = await dns.promises.resolve4(target);
                                if(addrs.length > 0){ ip = addrs[0]; }
                            }catch(e){ /* keep the hostname — works in the URL too */ }
                            this.addRegistry({
                                ip,
                                port: srv.port,
                                priority: (typeof srv.priority === "number") ? srv.priority : 100,
                                source: "dnssd",
                                domain,
                            });
                        }
                    }catch(e){ /* instance without SRV — skip */ }
                }
            }
        }
    }

    private addRegistry(registry: NmosRegistry) {
        const rank = NmosRegistryConnector.sourceRank(registry.source);

        // Same endpoint already known → keep the connection, just upgrade
        // the source label when a higher-ranked discovery confirms it.
        for (let i = 0; i < this.nmosRegistryList.length; i++) {
            const el = this.nmosRegistryList[i];
            if (el.ip + ":" + el.port == registry.ip + ":" + registry.port) {
                if (rank > NmosRegistryConnector.sourceRank(el.source)) {
                    this.nmosRegistryList[i] = registry;
                    this.updateSyncConnectionState();
                }
                return;
            }
        }

        let bestRank = 0;
        for (const el of this.nmosRegistryList) {
            bestRank = Math.max(bestRank, NmosRegistryConnector.sourceRank(el.source));
        }
        if (bestRank > 0 && rank < bestRank) {
            SyncLog.log("verbose", "NMOS Settings", "Ignoring " + registry.source + " registry " + registry.ip + ":" + registry.port + " — a higher-priority source is connected.");
            return;
        }
        if (bestRank > 0 && rank > bestRank) {
            SyncLog.log("info", "NMOS Settings", registry.source + " registry " + registry.ip + ":" + registry.port + " outranks the current source — switching.");
            this.disconnectAllRegistries();
        }

        this.nmosRegistryList.push(registry);
        SyncLog.log("info","NMOS Settings","Adding Registry ("+registry.source+"): "+registry.ip + ":"+registry.port );
        this.connectRegistry(registry);

        this.updateSyncConnectionState();
    }
    connectRegistry(registry: NmosRegistry) {
        // TODO: disconnects and reconnects

        const url = "http://" + registry.ip + ":" + registry.port + "";
        this.getSubscription(url, "/nodes");
        this.getSubscription(url, "/devices");
        this.getSubscription(url, "/sources");
        this.getSubscription(url, "/senders");
        this.getSubscription(url, "/receivers");
        this.getSubscription(url, "/flows");
    }

    private mdnsQueryInterval = null;
    private dnssdQueryInterval: any = null;
    private loggedDnssdNoDomain = false;
    private mdnsBrowser: any = null;
    private registryVersionList = ["v1.3","v1.2"];
    private connectVersionList = ["v1.1", "v1.0"];
    private channelmappingVersionList = ["v1.0"];
    private nmosRegistryList: NmosRegistry[] = [];

    // Generation counter for live registry switching. Every WebSocket
    // subscription captures the generation it was started under; lingering
    // reconnect timers (onclose / .catch) bail out when the generation has
    // advanced, so a switch from registry A → B can't be undone by a
    // stale auto-reconnect aiming at A.
    private registryGen = 0;


    // ----- syncNmos coalescing -----
    // The registry can fire dozens of WebSocket grains per second on a busy
    // network, and the raw flow used to call syncNmos.setState() on EVERY
    // one of them. setState deep-clones the entire nmosState and runs a
    // full JSON-patch diff against the previous copy — on a registry with
    // thousands of senders/flows that's milliseconds of CPU per call, burnt
    // even for a no-op version bump. We coalesce: every change schedules a
    // single setState ~80 ms later, so a burst of N grains collapses into
    // one clone+diff+broadcast. The published state is always the latest
    // (we read this.nmosState at flush time, not at schedule time).
    private syncNmosTimer:any = null;
    private scheduleSyncNmos(){
        if(this.syncNmosTimer != null) return;
        this.syncNmosTimer = setTimeout(()=>{
            this.syncNmosTimer = null;
            try{
                // Publish WITHOUT sendersManifestDetail: the raw+parsed SDPs
                // dominated the object's size (multi-MB init per client) and
                // the UI now fetches single SDPs via the getSenderSdp route.
                let pub:any = { ...this.nmosState };
                delete pub.sendersManifestDetail;
                this.syncNmos.setState(pub);
            }catch(e){}
        }, 80);
    }

    updateCrosspointTimer:any = null;
    updateCrosspointLimit = 0;
    updateCrosspoint(){
        if(this.updateCrosspointTimer != null){
            if(this.updateCrosspointLimit < 10){
                this.updateCrosspointLimit++;
            }else{
                return;
            }
        }
        if(this.updateCrosspointTimer != null){
            clearTimeout(this.updateCrosspointTimer);
            this.updateCrosspointTimer = null;
        }
        this.updateCrosspointTimer = setTimeout(()=>{
            this.updateCrosspointLimit = 0;
            this.updateCrosspointTimer = null;
            if(CrosspointAbstraction.instance){
                CrosspointAbstraction.instance.updateFromNmos(this.nmosState);
            }
        },100);
    }

    private nmosState = {
        devices: {},
        sources: {},
        senders: {},
        receivers: {},
        flows: {},
        nodes: {},
        senderActiveData:{},
        channelmapping:{},
        sendersManifestDetail :{}
    };
    private connections = {};


    private getSubscription(nmosRegistryUrl: string, resource: string) {
        // Version cascade: subscribe with the newest Query API version and
        // fall back to the next one only when the subscription POST fails.
        // Subscribing to ALL versions in parallel (the old behaviour) doubled
        // the websockets and made the registry deliver every event twice.
        this.getVersionSubscription(nmosRegistryUrl, resource, 0);
    }

    private getVersionSubscription(nmosRegistryUrl: string, resource: string, versionIndex:number){
        const version = this.registryVersionList[versionIndex];
        if(!version) return;
        // Capture the generation at subscribe time. If reconnectStaticRegistries
        // is called mid-flight (live switch), this.registryGen advances and the
        // late-arriving response / reconnect timer skips itself.
        const myGen = this.registryGen;
        axios.post(nmosRegistryUrl + "/x-nmos/query/" + version + "/subscriptions", {
            resource_path: resource,
            params: {},
            persist: false,
            max_update_rate_ms: 50,
        }).then((response: any) => {
            if(myGen !== this.registryGen) return;  // Registry was switched while we were waiting.
            this.logReset = true;
            let subscription = response.data;
            let fullResource = nmosRegistryUrl + "_" + resource + "_" + version;
            // With the cascade there is exactly ONE live subscription per
            // resource — drop entries from another version (left over when a
            // reconnect landed on a different Query API version).
            for(const key of Object.keys(this.connections)){
                if(key.startsWith(nmosRegistryUrl + "_" + resource + "_") && key !== fullResource){
                    try{ if(this.connections[key].pingInterval){ clearInterval(this.connections[key].pingInterval); } }catch(e){}
                    try{ this.connections[key].ws.onmessage = () => {}; }catch(e){}
                    try{ this.connections[key].ws.close(); }catch(e){}
                    delete this.connections[key];
                }
            }
            if (this.connections[fullResource]) {
                this.connections[fullResource].ws.onmessage = (message) => {};
                try{ if(this.connections[fullResource].pingInterval){ clearInterval(this.connections[fullResource].pingInterval); } }catch(e){}
                try{
                    this.connections[fullResource].ws.close();
                }catch(e){}
            }
            let newWs:any = new WebSocket(subscription.ws_href);
            this.connections[fullResource] = {
                version,
                subscription,
                ws: newWs,
                pingInterval: null,
                pongPending: false,
                lastPongAt: Date.now()
            };

            this.connections[fullResource].ws.error = () => {
                this.connections[fullResource].ws.onmessage = (message) => {};
            };

            this.connections[fullResource].ws.onclose = () => {
                this.connections[fullResource].ws.onmessage = (message) => {};
                try{ if(this.connections[fullResource]?.pingInterval){ clearInterval(this.connections[fullResource].pingInterval); this.connections[fullResource].pingInterval = null; } }catch(e){}

                if(myGen !== this.registryGen){
                    // This close was caused by the live-switch teardown — don't
                    // log scary "closed" lines and don't try to reconnect.
                    return;
                }

                SyncLog.log("error",  "NMOS","Closed subscription to Registry: " + nmosRegistryUrl + ", " + resource + ", " + version );
                setTimeout(()=>{
                    if(myGen !== this.registryGen) return;
                    // Restart the cascade from the newest version — a registry
                    // restart may well have brought a newer Query API along.
                    this.getVersionSubscription(nmosRegistryUrl,resource,0);
                },1000)
                this.updateSyncConnectionState();
            };
            this.connections[fullResource].ws.onopen = () => {
                this.updateSyncConnectionState();
            };

            // Native RFC 6455 pong frame — emitted by the `ws` library when
            // the NMOS query API answers our heartbeat. Clearing pongPending
            // tells the liveness timer the connection is alive.
            newWs.on("pong", () => {
                let conn:any = this.connections[fullResource];
                if(!conn) return;
                conn.pongPending = false;
                conn.lastPongAt  = Date.now();
            });

            // Heartbeat. Without this, an idle subscription that gets dropped
            // by a stateful firewall / NAT between server and registry sits
            // silently forever — no onclose, no reconnect, the UI shows
            // stale devices. We send a native ping every 15 s; if no pong
            // comes back within 30 s we terminate() so onclose fires and
            // the standard reconnect path takes over.
            const pingMs   = 15000;
            const pongMs   = 30000;
            this.connections[fullResource].pingInterval = setInterval(() => {
                let conn:any = this.connections[fullResource];
                if(!conn) return;
                if(myGen !== this.registryGen) return;
                try{
                    if(conn.ws.readyState !== conn.ws.OPEN) return;
                    if(conn.pongPending && (Date.now() - conn.lastPongAt) > pongMs){
                        SyncLog.log("warn", "NMOS", "Pong timeout on subscription " + resource + " (" + nmosRegistryUrl + ") — terminating for reconnect.");
                        try{ conn.ws.terminate(); }catch(e){}
                        return;
                    }
                    conn.pongPending = true;
                    conn.ws.ping();
                }catch(e){}
            }, pingMs);

            this.connections[fullResource].ws.onmessage = (message) => {
                if(myGen !== this.registryGen) return;
                this.updateState(JSON.parse(message.data),version);
            };

            SyncLog.log("info",  "NMOS","Subscribed to Registry: " + nmosRegistryUrl + ", " + resource + ", " + version );
        }).catch((error) => {
            if(myGen !== this.registryGen) return;  // Switched registries while the POST was failing.
            if(versionIndex + 1 < this.registryVersionList.length){
                // The registry may simply not offer this Query API version —
                // fall through to the next one right away.
                this.getVersionSubscription(nmosRegistryUrl, resource, versionIndex + 1);
                return;
            }
            	setTimeout(()=>{
                    if(myGen !== this.registryGen) return;
                    this.getVersionSubscription(nmosRegistryUrl,resource,0);
                },20000)
                if(this.logReset){
                    this.logReset = false;
                    SyncLog.log("error",  "NMOS","Error While creating NMOS Subscription on Registry: " + nmosRegistryUrl + ", " + resource + ", " + version, {message:error.message});
                }
        });
    }


    /**
     * Tear down every active WebSocket subscription, drop the registry list
     * and wipe the cached NMOS state. Used by reconnectStaticRegistries() to
     * cleanly switch to a new query API URL without restarting the process.
     *
     * Reconnect timers from this generation are made no-ops by bumping
     * `this.registryGen` (every WS handler captured the value at subscribe
     * time and bails out when it no longer matches).
     */
    private disconnectAllRegistries(){
        this.registryGen++;
        for(let key of Object.keys(this.connections)){
            let conn:any = this.connections[key];
            try{ if(conn.pingInterval){ clearInterval(conn.pingInterval); conn.pingInterval = null; } }catch(e){}
            try{
                conn.ws.onmessage = () => {};
                conn.ws.onclose   = () => {};
                conn.ws.onerror   = () => {};
            }catch(e){}
            try{ conn.ws.close(); }catch(e){}
        }
        this.connections = {};
        this.nmosRegistryList = [];
        // Reset the in-memory NMOS state so the UI doesn't see stale devices
        // from the previous registry. setState emits a JSON-patch reset to
        // every subscribed client.
        this.nmosState = {
            devices: {}, sources: {}, senders: {}, receivers: {},
            flows: {}, nodes: {}, senderActiveData: {}, channelmapping: {},
            sendersManifestDetail: {}
        };
        // Cancel any pending coalesced sync and push the empty state right
        // away so the UI clears immediately on a registry switch.
        if(this.syncNmosTimer != null){ clearTimeout(this.syncNmosTimer); this.syncNmosTimer = null; }
        this.syncNmos.setState(this.nmosState);
        this.updateSyncConnectionState();
    }


    /**
     * Hot-apply a change to settings.staticNmosRegistries: tear down all
     * existing query-API subscriptions, then re-subscribe to whatever the
     * settings now point at. Used by the Setup page so the operator never
     * has to restart the server to switch between registries.
     */
    public reconnectStaticRegistries(){
        SyncLog.log("info", "NMOS", "Live-switching NMOS registry — tearing down existing subscriptions.");
        this.disconnectAllRegistries();
        try{
            if(Array.isArray(this.settings.staticNmosRegistries)){
                this.settings.staticNmosRegistries.forEach((staticRegistry:any) => {
                    if(!staticRegistry || !staticRegistry.ip || !staticRegistry.port) return;
                    try {
                        let registry: NmosRegistry = {
                            ip: staticRegistry.ip,
                            port: staticRegistry.port,
                            priority: staticRegistry.priority,
                            source: "static",
                            domain: staticRegistry.domain,
                        };
                        this.addRegistry(registry);
                        SyncLog.log("info", "NMOS Settings", "Re-adding Static Registry: " + JSON.stringify(staticRegistry));
                    } catch (e) {
                        SyncLog.log("error", "NMOS Settings", "Can not add Static Registry: " + JSON.stringify(staticRegistry));
                    }
                });
            }
        }catch(e){}
        // Force a crosspoint rebuild so the UI clears any device cards that
        // were built from the old registry's state.
        this.updateCrosspoint();

        // With no static registry configured the discovery cascade repopulates
        // the list — re-query right away instead of waiting for the next tick
        // (up to 60s for DNS-SD, 20s for mDNS).
        setTimeout(() => {
            this.dnssdQuery().catch(()=>{});
            this.mdnsQuery();
        }, 250);
    }

    private versionIsPrefered(oldVersion:string, newVersion:string, registry=true){
        let list = this.registryVersionList;
        if(!registry){
            list = this.connectVersionList
        }
        let newIndex = list.indexOf(newVersion);
        let oldIndex = list.indexOf(oldVersion)
        if(newIndex <= oldIndex){
            return true;
        }
        return false;

    }

    updateNewNmosItemTimer:any|null = null;
    private updateState(message: any, version:string) {
        //console.log("updates from registry: " + message.type)
        let newItem = false;
        let type = "";
        let changes = false;
        let changesConnect = false;
        try {
            type = (message.grain.topic as string).split("/").join("");
        } catch (e) {}
        //console.log("updates from registry: " +  (message.grain.topic as string) + " > " + type)
        if (this.nmosState[type]) {
            //console.log(JSON.stringify(message,null, 2))
            message.grain.data.forEach((g: any) => {
                if (g.hasOwnProperty("path") && typeof g.path == "string") {
                    if (g.hasOwnProperty("post")) {
                        // add or update element
                        if (typeof g.post == "object") {
                            if(this.nmosState[type][g.path] && !this.versionIsPrefered(this.nmosState[type][g.path]["_sourceVersion"], version)){
                                // do not update
                            }else{
                                let postData = g.post;
                                NmosRegistryConnector.modifierCallbackList[type].forEach((f)=>{
                                    postData = f(g.path, postData);
                                })
                                if(this.nmosState[type].hasOwnProperty(g.path)){
                                    //Update
                                }else{
                                    newItem = true;
                                    changes = true;
                                }

                                postData["_sourceVersion"] = version;

                                NmosRegistryConnector.hookCallbackList[type].forEach((f)=>{
                                    f(g.path, postData);
                                })

                                if(!newItem){
                                    let diff = jsonpatch.compare(this.nmosState[type][g.path], postData);
                                    if(diff.length == 0){
                                        // nothing
                                    }else if(diff.length == 1 &&  diff[0].op == "replace" && diff[0].path == "/version"){
                                        // nothing... relevant
                                    }else if(diff.length == 2 && diff[1].op == "replace" && diff[1].path == "/subscription/sender_id" ){
                                        changesConnect = true;
                                        // TODO, isolate changes 
                                        changes = true;
                                    }else{
                                        changes = true;
                                    }
                                    
                                }

                                if(changes && type == "devices"){
                                    this.loadChannelMaping(postData);
                                }

                                this.nmosState[type][g.path] = postData;

                                // DNS Push: whenever a node's label or href
                                // changes, schedule a push. Debounced inside
                                // the service so a burst of updates produces
                                // a single API batch.
                                if(type === "nodes"){
                                    try{
                                        let ip = "";
                                        try{
                                            if(typeof postData.href === "string" && postData.href){
                                                ip = new URL(postData.href).hostname;
                                            }
                                        }catch(e){}
                                        let displayName = this.resolveDnsDisplayName(g.path, postData.label || "");
                                        if(DdnsService.instance && ip && displayName){
                                            DdnsService.instance.scheduleNodePush(g.path, displayName, ip);
                                        }
                                    }catch(e){}
                                }

                            }

                        }
                    } else {
                        // remove element
                        try {
                            if(this.nmosState[type][g.path]["_sourceVersion"] == version){
                                delete this.nmosState[type][g.path];
                                // DNS Push: a node that's gone from the
                                // registry should not keep a stale DNS entry.
                                if(type === "nodes"){
                                    try{
                                        if(DdnsService.instance){
                                            DdnsService.instance.removeNode(g.path).catch(()=>{});
                                        }
                                    }catch(e){}
                                }
                                changes = true;
                            }
                        } catch (e) {}
                    }
                }
            });
        }
        // TODO
        //fs.writeFileSync("./state/devnmosstate/devnmosstate.json", JSON.stringify(this.nmosState));
        this.scheduleSyncNmos();
        if(newItem){
            if(this.updateNewNmosItemTimer){
                clearTimeout(this.updateNewNmosItemTimer);
            }
            this.updateNewNmosItemTimer = setTimeout(() => {
                this.updateNewNmosItemTimer = null;
                this.updateCrosspoint();
            }, 1000);
            
        }else{
            if(changes){
                if(this.updateNewNmosItemTimer){

                }else{
                    this.updateCrosspoint();
                }
            }
        }

        
                message.grain.data.forEach((g: any) => {


                    if (type == "senders" || type == "flows") {
                        setTimeout(()=>{
                            this.getSenderManifestData(type, g);
                        },200);
                        setTimeout(()=>{
                            this.getSenderManifestData(type, g);
                        },5000);
                    }

                    if(type == "senders"){
                        setTimeout(()=>{
                            this.getSenderActive(type, g);
                        },100);
                    }
                });


        

    }

    async loadChannelMaping(postData:any){
        let cmLoaded = false;
        for(let c of postData.controls){
            // TODO: other versions
            if(c.type=="urn:x-nmos:control:cm-ctrl/v1.0"){
                try{
                    let io = await axios.get(c.href + "/io");
                    let map = await axios.get(c.href + "/map/active");

                    for(let k in io.data.outputs){

                        let data = io.data.outputs[k];
                        if(data.source_id == null){
                            data["receivers"] = [];

                            
                            for(let inId of io.data.outputs[k].caps.routable_inputs){
                                try{
                                    if(io.data.inputs[inId].parent.type = "receiver"){
                                        data["receivers"].push(io.data.inputs[inId].parent.id)
                                    }
                                }catch(e){}
                            }
                            
                            if(data.receivers.length > 0){
                                this.nmosState.channelmapping[k] = data;
                            }
                        }
                    }

                
                    cmLoaded = true;
                    

                }catch(e){
                    //console.log(e);
                }
            }
        }

        this.scheduleSyncNmos();
        this.updateCrosspoint();

    }



    getSenderManifestData(type:string, g:any){
        if (g.hasOwnProperty("path") && typeof g.path == "string") {
            if (g.hasOwnProperty("post")) {
                // add or update element
                if (typeof g.post == "object") {

                    let manifest_href = "";
                    let active = false;
                    let senderId = "";
                    let label = "";

                    let source:any = null;
                    try{

                        if (type == "senders") {
                            source = g.post;
                            senderId = g.path;
                        }
                        if (type == "flows") {
                            source = this.nmosState.senders[g.post.source_id];
                            senderId = g.post.source_id;
                        }

                    
                        if(source && source.hasOwnProperty("manifest_href")){
                            manifest_href = source.manifest_href;
                            active = source.subscription?.active;
                            senderId = g.path;
                            label = g.post.label
                        }
                        
                    }catch(e){}

                    
                    // We previously only fetched the manifest while the sender's
                    // subscription was active. Most ST 2110 senders expose the SDP
                    // unconditionally (it describes the staged transport), so we
                    // try regardless. If the device 404s we log a debug warning
                    // and move on - the catch handler stays untouched.
                    let _activeUnused = active; // kept for backwards compatibility
                    if (manifest_href && senderId) {
                        axios.get(g.post.manifest_href).then(response => {
                            if(response.data.length > 10){
                                // TODO Check for BAD SDP Files, is this already enough, more than 10 chars and more than 0 flows
                                let sdp = sdpTransform.parse(response.data);
                                sdp["_RAWSDP"] = response.data;
                                if(sdp.media.length == 0){
                                    // Some devices (e.g. Merging Anubis) reply with
                                    // a session-only SDP — header lines but no `m=`
                                    // media section — while the sender is inactive.
                                    // That's expected, not a bug. Only flag the
                                    // warning when the sender is actually active.
                                    let inactive = false;
                                    try{
                                        let s:any = this.nmosState.senders?.[senderId];
                                        if(s && s.subscription){
                                            inactive = !s.subscription.active;
                                        }
                                    }catch(e){}
                                    if(!inactive){
                                        SyncLog.log("warn", "NMOS", "Got BAD SDP File for Flow: " + label + " ( ID: " + senderId +" )")
                                    }
                                    try{
                                        // TODO Test
                                        delete this.nmosState["sendersManifestDetail"][senderId];
                                        this.scheduleSyncNmos();
                                    }catch(e){}
                                }else{
                                    if(this.nmosState["sendersManifestDetail"][senderId] && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP.length > 10 ){
                                        if(this.nmosState["sendersManifestDetail"][senderId]._RAWSDP != sdp["_RAWSDP"]){
                                            this.reconnectOnChanges(senderId);
                                        }
                                    }
                                    this.nmosState["sendersManifestDetail"][senderId] = sdp;
                                    this.scheduleSyncNmos();
                                    this.updateCrosspoint();
                                }
                            }else{
                                // Same suppression as above: inactive senders
                                // legitimately return tiny / empty manifests.
                                let inactive = false;
                                try{
                                    let s:any = this.nmosState.senders?.[senderId];
                                    if(s && s.subscription){
                                        inactive = !s.subscription.active;
                                    }
                                }catch(e){}
                                if(!inactive){
                                    SyncLog.log("warn", "NMOS", "Got BAD SDP File for Flow: " + label + " ( ID: " + senderId +" )")
                                }
                                try{
                                    // TODO Test
                                    delete this.nmosState["sendersManifestDetail"][senderId];
                                }catch(e){}
                            }
                        }).catch(e=>{
                            SyncLog.log("warn", "NMOS", "Can not get SDP File for Flow: " + label + " ( ID: " + senderId +" )")
                        });
                    }
                }
            } else {
                if (type == "senders") {
                    // remove element
                    try {
                        delete this.nmosState["sendersManifestDetail"][g.path];
                        this.scheduleSyncNmos();
                        this.updateCrosspoint();
                    } catch (e) {}
                    
                }
            }
        }
    }


    async getSenderActive(type:string, g:any){
        if (g.hasOwnProperty("path") && typeof g.path == "string") {
            if (g.hasOwnProperty("post")) {
                // add or update element
                if (typeof g.post == "object") {

                    let active_href = [];
                    let senderId = "";
                    let sender = null;
                    let device = null;


                    try{
                        senderId = g.path;
                        sender = g.post;
                        device = this.nmosState.devices[sender.device_id];

                        // Accept BOTH supported IS-05 control versions.
                        // Devices that advertise v1.1 only (e.g. QSC Core)
                        // previously slipped through this filter, which left
                        // their senderActiveData empty — and the Multicast
                        // Lease Manager could never reconcile the address.
                        // Order matters: v1.1 first, so newer devices that
                        // advertise both don't get stuck on the older URL
                        // (which may exist for compatibility but lack fields).
                        let preferred = ["urn:x-nmos:control:sr-ctrl/v1.1", "urn:x-nmos:control:sr-ctrl/v1.0"];
                        for(let ctrlType of preferred){
                            device.controls.forEach((c:any)=>{
                                if(c.type === ctrlType){
                                    let href = c.href;
                                    if(href[href.length-1] !== "/"){
                                        href += "/";
                                    }
                                    href += "single/senders/"+senderId+"/active/";
                                    active_href.push(href);
                                }
                            });
                            if(active_href.length > 0) break;
                        }
                        
                        
                    }catch(e){}

                    if(active_href.length == 0){
                        SyncLog.log("warn", "NMOS", "Can not get active configuration of sender, no controls available.")
                    }

                    let gotData = false;
                    for(let href of active_href){
                        try{
                            let response = await axios.get(href);
                            this.nmosState.senderActiveData[senderId] = response.data;
                            gotData = true;
                            break;
                        }catch(e){
                            SyncLog.log("warn", "NMOS", "Can not get active configuration of sender:",{error: e.message, href : href});
                        }
                    }

                    // Always publish the new state so the UI sees changes even
                    // for inactive senders (e.g. after setFlowMulticast).
                    this.scheduleSyncNmos();
                    this.updateCrosspoint();
                    if(!gotData){
                        // no-op: kept for clarity
                    }

                    // ----- Multicast Lease Manager: ensure + reconcile -----
                    // Runs only when auto-allocation is enabled and we received
                    // up-to-date active data. The manager allocates a pair if
                    // the sender doesn't have one yet, then forces the
                    // configured addresses if reality drifts from the lease.
                    if(gotData){
                        try{
                            this.reconcileSenderWithLease(senderId);
                        }catch(e:any){
                            SyncLog.log("warn", "Multicast Lease", "Reconcile failed for " + senderId + ": " + e.message);
                        }
                    }
                }
            } else {
                if (type == "senders") {
                    // remove element
                    try {
                        delete this.nmosState.senderActiveData[g.path];
                        this.scheduleSyncNmos();
                        this.updateCrosspoint();
                    } catch (e) {}
                    
                }
            }
        }
    }

    updateSyncConnectionState() {
        let list = [];
        this.nmosRegistryList.forEach((registry) => {
            let entry:any = structuredClone(registry);
            //let entry = JSON.parse(JSON.stringify(registry));
            entry.connected = [];
            try {
                const url = "http://" + registry.ip + ":" + registry.port + "";
                let endpoints = ["nodes", "devices", "sources", "senders", "receivers", "flows"];
                endpoints.forEach((e) => {
                    Object.keys(this.connections).forEach((c)=>{
                        if(c.startsWith(url + "_/" + e )){
                            if (this.connections[c].ws.readyState == WebSocket.OPEN) {
                                entry.connected.push({endpoint:e, version:this.connections[c].version, connected:true});
                            }else{
                                entry.connected.push({endpoint:e, version:this.connections[c].version, connected:false});
                            }
                        }
                    })
                });
            } catch (e) {}
            list.push(entry);
        });
        this.syncConnectionState.setState({ registries: list });

        // Re-arm the periodic refresh as a SINGLE timer. This method is also
        // called directly on connection open/close and on registry switch;
        // without clearing the previous timer first, every such call used to
        // spawn an additional independent 2 s loop, so the number of
        // structuredClone()+setState passes per second grew without bound
        // over the lifetime of the process. Keeping one handle caps it at
        // exactly one refresh every 2 s.
        if(this.connectionStateTimer != null){
            clearTimeout(this.connectionStateTimer);
        }
        this.connectionStateTimer = setTimeout(()=>{
            this.connectionStateTimer = null;
            this.updateSyncConnectionState();
        }, 2000);
    }
    private connectionStateTimer:any = null;


    reconnectOnChanges(senderId:string){
        CrosspointAbstraction.instance.reconnectOnChangesFromNmos(senderId);
    }

    /**
     * Pick the hostname we want to publish to DNS for this node. If the user
     * has set a custom alias on any crosspoint device that belongs to this
     * node, that alias wins. Otherwise the node label is used.
     *
     * Handles both flavours of crosspoint device id:
     *   nmos_<deviceId>    → direct device lookup
     *   nmosgrp_<hash>     → look at one of the group's senders to find the
     *                        backing NMOS device.
     */
    resolveDnsDisplayName(nodeId:string, fallback:string): string {
        try{
            let xp = CrosspointAbstraction.instance;
            if(!xp || !xp.crosspointState || !Array.isArray(xp.crosspointState.devices)){
                return fallback || "";
            }
            for(let xd of xp.crosspointState.devices){
                if(!xd || typeof xd.id !== "string") continue;
                let alias = (typeof xd.alias === "string") ? xd.alias : "";
                let name  = (typeof xd.name  === "string") ? xd.name  : "";
                if(!alias || alias === name) continue;  // not user-customised

                let xdNodeId = "";
                if(xd.id.startsWith("nmos_")){
                    let devId = xd.id.slice(5);
                    let dev:any = this.nmosState.devices[devId];
                    if(dev) xdNodeId = dev.node_id || "";
                }else if(xd.id.startsWith("nmosgrp_")){
                    // All senders in a grouphint group belong to one device.
                    for(let type of Object.keys(xd.senders || {})){
                        for(let s of (xd.senders[type] || [])){
                            if(!s || typeof s.id !== "string") continue;
                            if(!s.id.startsWith("nmos_")) continue;
                            let sender:any = this.nmosState.senders[s.id.slice(5)];
                            if(sender && sender.device_id){
                                let dev:any = this.nmosState.devices[sender.device_id];
                                if(dev) xdNodeId = dev.node_id || "";
                                break;
                            }
                        }
                        if(xdNodeId) break;
                    }
                }

                if(xdNodeId === nodeId){
                    return alias;
                }
            }
        }catch(e){}
        return fallback || "";
    }

    /**
     * "Renew from Pool" — force every active sender onto a fresh address.
     *
     * The naive version (just calling reconcileSenderWithLease for every id)
     * was buggy: senders that already had a lease never got re-allocated,
     * since ensureLease() returns the existing lease when one is present.
     * The fix is to RELEASE every active sender's lease first so the
     * allocator pool is full again, then reconcile each one — that path
     * allocates fresh and PATCHes the device.
     *
     * To avoid hammering devices with simultaneous IS-05 PATCHes when there
     * are many senders, the reconciles are spaced ~30ms apart.
     */
    public sweepAllSenders(){
        try{
            let manager = MulticastLeaseManager.instance;
            if(!manager) return;

            // Collect ids in two buckets — active senders get a re-allocation,
            // inactive ones keep waiting (they'll be reconciled the moment
            // their subscription.active flips true via the IS-04 WS event).
            let activeIds: string[] = [];
            for(let senderId in this.nmosState.senders){
                let sender = this.nmosState.senders[senderId];
                if(!sender) continue;
                if(sender.subscription && sender.subscription.active){
                    activeIds.push(senderId);
                }
            }

            // Step 1 — return every active sender's pair to the pool.
            if(activeIds.length > 0){
                manager.releaseLeases(activeIds);
                SyncLog.log("info", "Multicast Lease", "Renew from Pool: released " + activeIds.length + " active sender lease(s).");
            }

            // Step 2 — reconcile each one with a small delay between PATCHes.
            // 30ms × N still gives sub-second total for typical (≤30 senders)
            // deployments while preventing simultaneous-PATCH timeouts on
            // devices that throttle their IS-05 endpoint.
            const DELAY_MS = 30;
            activeIds.forEach((senderId, idx) => {
                setTimeout(()=>{
                    try{
                        this.reconcileSenderWithLease(senderId, true);
                    }catch(e:any){
                        SyncLog.log("warn", "Multicast Lease", "Renew failed for " + senderId + ": " + e.message);
                    }
                }, idx * DELAY_MS);
            });
        }catch(e){}
    }

    /**
     * Walk every active sender and adopt its *current* IS-05 destination IPs
     * as the lease, instead of allocating new ones from the pool. Used when
     * the user enables Auto-Allocation and wants to keep existing streams
     * untouched. Falls back to a fresh allocation per-sender if adoption is
     * not possible (no IP set yet, collision with another lease, etc.).
     */
    public adoptCurrentSenderIPs(){
        let manager = MulticastLeaseManager.instance;
        if(!manager) return;
        try{
            for(let senderId in this.nmosState.senders){
                try{
                    let sender = this.nmosState.senders[senderId];
                    if(!sender) continue;
                    let isActive = !!(sender.subscription && sender.subscription.active);
                    if(!isActive) continue;
                    if(manager.getLease(senderId)) continue;  // already has a lease

                    let flow:any = this.nmosState.flows[sender.flow_id];
                    if(!flow) continue;
                    let source:any = this.nmosState.sources[flow.source_id];
                    let mediaType:string = flow.media_type || "";
                    let channels:number = 0;
                    try{
                        if(source && Array.isArray(source.channels)){
                            channels = source.channels.length;
                        }
                    }catch(e){}

                    let deviceLabel = "";
                    let nodeId = "";
                    try{
                        let dev = this.nmosState.devices[sender.device_id];
                        if(dev){ deviceLabel = dev.label || ""; nodeId = dev.node_id || ""; }
                    }catch(e){}

                    let activeData:any = (this.nmosState as any).senderActiveData?.[senderId];
                    let primaryIp = "";
                    let secondaryIp = "";
                    let port = 5004;
                    if(activeData && Array.isArray(activeData.transport_params)){
                        let tp0 = activeData.transport_params[0];
                        let tp1 = activeData.transport_params[1];
                        if(tp0 && typeof tp0.destination_ip === "string"){ primaryIp = tp0.destination_ip; }
                        if(tp1 && typeof tp1.destination_ip === "string"){ secondaryIp = tp1.destination_ip; }
                        if(tp0 && typeof tp0.destination_port === "number" && tp0.destination_port > 0){
                            port = tp0.destination_port;
                        }
                    }

                    let lease:any = null;
                    if(primaryIp){
                        lease = manager.adoptLease({
                            senderId, mediaType, channels, deviceLabel, nodeId, port,
                            primaryIp, secondaryIp
                        });
                    }
                    if(!lease){
                        // Adoption failed (no current IP / collision) → fall
                        // back to a fresh pool allocation for this one.
                        manager.ensureLease({ senderId, mediaType, channels, deviceLabel, nodeId, port, isActive: true });
                        // And reconcile so the device actually gets the new IP.
                        this.reconcileSenderWithLease(senderId);
                    }
                    // Adopted leases match the device's current IPs, so no
                    // PATCH is needed — reconcile would be a no-op.
                }catch(e){}
            }
        }catch(e){}
    }

    /**
     * Return a set of all destination IPs that NMOS-known senders currently
     * advertise in their IS-05 active transport_params. Used by the Multicast
     * Lease Manager to avoid handing out an address that's already in use on
     * the wire, even by senders that don't yet have a managed lease.
     *
     * The `excludeSenderId` is excluded from the scan (so a sender being
     * allocated doesn't conflict with its own previous addresses).
     */
    public getActiveSenderIps(excludeSenderId?: string): Set<string> {
        const ips: Set<string> = new Set<string>();
        try{
            const data:any = (this.nmosState as any).senderActiveData;
            if(!data) return ips;
            for(const id in data){
                if(excludeSenderId && id === excludeSenderId) continue;
                const active = data[id];
                if(!active || !Array.isArray(active.transport_params)) continue;
                active.transport_params.forEach((tp:any) => {
                    if(tp && typeof tp.destination_ip === "string" && tp.destination_ip){
                        ips.add(tp.destination_ip);
                    }
                });
            }
        }catch(e){}
        return ips;
    }

    /**
     * Find whether the given sender's multicast IPs collide with any *other*
     * currently active sender on the same leg index. Returns null if there's
     * no conflict, otherwise returns the offending sender's label, id, the
     * conflicting leg index and the multicast IP.
     *
     * Same-sender legs do NOT conflict with each other (primary/secondary
     * failover is allowed to use the same multicast). Cross-leg comparison
     * is also allowed — only leg 0 of one sender vs leg 0 of another etc.
     */
    findMulticastConflict(senderId:string): { id:string, label:string, leg:number, multicast:string } | null {
        try{
            let activeData:any = (this.nmosState as any).senderActiveData?.[senderId];
            if(!activeData || !Array.isArray(activeData.transport_params)){
                return null;
            }
            // Build the list of multicasts we want to claim, per leg index.
            let ourLegs: Array<{ index:number, ip:string }> = [];
            activeData.transport_params.forEach((tp:any, index:number)=>{
                if(tp && typeof tp.destination_ip === "string" && tp.destination_ip){
                    ourLegs.push({ index, ip: tp.destination_ip });
                }
            });
            if(ourLegs.length === 0){
                return null;
            }
            // Iterate every OTHER sender that is currently active.
            for(let otherId in this.nmosState.senders){
                if(otherId === senderId){ continue; }
                let other = this.nmosState.senders[otherId];
                if(!other || !other.subscription || !other.subscription.active){
                    continue;
                }
                let otherActive:any = (this.nmosState as any).senderActiveData?.[otherId];
                if(!otherActive || !Array.isArray(otherActive.transport_params)){
                    continue;
                }
                for(let leg of ourLegs){
                    let tp = otherActive.transport_params[leg.index];
                    if(tp && typeof tp.destination_ip === "string" && tp.destination_ip === leg.ip){
                        let label = other.label || otherId;
                        // Add device label as prefix for context
                        try{
                            let dev = this.nmosState.devices[other.device_id];
                            if(dev && dev.label){
                                label = dev.label + " / " + label;
                            }
                        }catch(e){}
                        return { id: otherId, label, leg: leg.index, multicast: leg.ip };
                    }
                }
            }
        }catch(e){}
        return null;
    }


    async connectionGetSenderInfo(senderId:string){
        let info:CrosspointConnectionSenderInfo = {
            senderId: senderId,
            interfaces:[],
            manifestFile:"",
            active:false,
            error:"",
            transport:""
        }
        let deviceId
        let device 
        let nodeId 
        let node 
        let flowId
        let sender
        let flow 
        let manifest
        try{
            sender = this.nmosState.senders[senderId]
            flowId = sender.flow_id
            deviceId = sender.device_id;
            device = this.nmosState.devices[deviceId];
            nodeId = device.node_id;
            node = this.nmosState.nodes[nodeId];
        }catch(e){
            info.error = "Sender not available in NMOS";
            return info;
        }

        // TODO: need to load manifest always
        // Now: Always load manifest
        //if(this.nmosState.sendersManifestDetail.hasOwnProperty(senderId)){
        //    manifest = this.nmosState.sendersManifestDetail[senderId]
        //    info.manifestFile = manifest._RAWSDP;
        //}else{
            // Load manifest
            try{
                let sdp = await axios.get(sender.manifest_href)
                info.manifestFile = sdp.data;
            }catch(e){
                info.error = "Can not load Manifest from sender: " + e.code;
                return info;
            }
        //}

        sender.interface_bindings.forEach((name:any)=>{
            node.interfaces.forEach((inter:any)=>{
                if(inter.name == name){
                    info.interfaces.push({name:name,mac:inter.port_id});
                }
            })
        });

        if(sender.transport == "urn:x-nmos:transport:rtp.mcast"){
            info.transport = "rtp.mcast"
        }
        if(sender.transport == "urn:x-nmos:transport:rtp"){
            info.transport = "rtp"
        } 

        info.active = sender.subscription.active;

        return info
    }

    async makeConnection(receiverId:string, senderInfo: CrosspointConnectionSenderInfo){

        if(senderInfo.error != ""){
            SyncLog.log("warning", "NMOS Connect", "No valid sender Info: " + senderInfo.error);
            throw new Error(senderInfo.error);
        }

        // IS-05 v1.x: `requested_time` MUST NOT be supplied for
        // `activate_immediate` activations. Sending `null` works on most
        // devices but strict implementations (Merging Anubis) reject the
        // whole PATCH with HTTP 500. So we leave it absent.
        let patch: any = {
            activation: {
                mode: "activate_immediate",
             },
            transport_params: [],
        };



        if(senderInfo.senderId == "disconnect"){
            //
        }else if(senderInfo.senderId){
            patch.sender_id = senderInfo.senderId;
        }else{
            // Virtual sender — no NMOS sender to bind to. Send null
            // explicitly so strict IS-05 implementations accept the
            // PATCH (empty string is not a valid sender_id).
            patch.sender_id = null;
        }

        let deviceId
        let device
        let nodeId
        let node
        let receiver
        try{
            receiver = this.nmosState.receivers[receiverId]
            deviceId = receiver.device_id;
            device = this.nmosState.devices[deviceId];
            nodeId = device.node_id;
            node = this.nmosState.nodes[nodeId];
        }catch(e){
            SyncLog.log("warning", "NMOS Connect", "Receiver with ID: "+receiverId+" is not available in NMOS");
            throw new Error("NMOS: Receiver not available. (Offline?)");
        }

        let interfaces = [];
        receiver.interface_bindings.forEach((name:any)=>{
            node.interfaces.forEach((inter:any)=>{
                if(inter.name == name){
                    interfaces.push({name:name,mac:inter.port_id});
                }
            })
        });

        // Parse the SDP so we can build EXPLICIT transport_params per leg
        // (multicast_ip / destination_port / source_ip). Some receivers
        // (Anubis among them) reject `{interface_ip:"auto"}` when the SDP
        // has fewer media blocks than the receiver has interface_bindings,
        // so we MUST also disable the surplus legs with rtp_enabled:false.
        let sdpLegs: Array<{ multicast_ip:string, destination_port:number, source_ip:string }> = [];
        if(senderInfo.transport == "rtp.mcast" || senderInfo.transport == "rtp"){
            try{
                let parsedSdp:any = sdpTransform.parse(senderInfo.manifestFile || "");
                if(parsedSdp && Array.isArray(parsedSdp.media)){
                    sdpLegs = parsedSdp.media.map((m:any) => {
                        let destIp = "";
                        let srcIp  = "";
                        try{
                            if(m.sourceFilter && m.sourceFilter.destAddress){
                                destIp = "" + m.sourceFilter.destAddress;
                                srcIp  = "" + (m.sourceFilter.srcList || "");
                            }else if(m.connection && m.connection.ip){
                                destIp = ("" + m.connection.ip).split("/")[0];
                            }else if(parsedSdp.connection && parsedSdp.connection.ip){
                                destIp = ("" + parsedSdp.connection.ip).split("/")[0];
                            }
                        }catch(e){}
                        let port = (typeof m.port === "number" && m.port > 0) ? m.port : 5004;
                        return { multicast_ip: destIp, destination_port: port, source_ip: srcIp };
                    });
                }
            }catch(e){
                SyncLog.log("warning", "NMOS Connect", "Could not parse SDP for transport_params: " + (e?.message || e));
            }
        }

        let receiverLegCount = receiver.interface_bindings.length;
        for(let i = 0; i < receiverLegCount; i++){
            if(senderInfo.senderId == "disconnect"){
                patch.transport_params.push({ rtp_enabled: false });
                continue;
            }
            if(senderInfo.transport == "rtp.mcast" || senderInfo.transport == "rtp"){
                // The SDP has exactly one transport entry per `m=` block.
                // Receiver legs without a matching media block must be
                // explicitly disabled — leaving them as `{rtp_enabled:true,
                // interface_ip:"auto"}` makes strict receivers reject the
                // whole PATCH because there's no media to bind to.
                if(i < sdpLegs.length && sdpLegs[i].multicast_ip){
                    let leg:any = {
                        multicast_ip:     sdpLegs[i].multicast_ip,
                        destination_port: sdpLegs[i].destination_port,
                        rtp_enabled:      true
                    };
                    if(sdpLegs[i].source_ip){ leg.source_ip = sdpLegs[i].source_ip; }
                    patch.transport_params.push(leg);
                }else{
                    patch.transport_params.push({ rtp_enabled: false });
                }
            }else if(senderInfo.transport == "websocket" || senderInfo.transport == "mqtt"){
                // TODO Websocket / MQTT
                patch.transport_params.push({});
            }else{
                SyncLog.log("warning", "NMOS Connect", "Sender has no transport Information.");
                throw new Error("Transport Type missing.");
            }
        }

        if(senderInfo.transport == "rtp.mcast" || senderInfo.transport == "rtp"){
            let manifest = senderInfo.manifestFile;

            if(this.settings.fixSdpBugs){
                manifest = manifest.replace("colorimetry=UNSPECIFIED;", "colorimetry=BT709;");
                manifest = manifest.replace("TCS=UNSPECIFIED;", "TCS=SDR;");
            }

            patch.transport_file = {
                type: "application/sdp",
                data: manifest,
            };
        }

        if(senderInfo.senderId == "disconnect"){
            patch.master_enable = false;
        }else{
            patch.master_enable = true;
        }
        // Warum ????

        //if (receiver.subscription.active) {
        //if (!receiverInformation.active.master_enable) {
            //if(senderInfo.senderId == "disconnect"){
            //    patch.master_enable = false;
            //}else{
            //
            //}
        //}else{
            //if(senderInfo.senderId == "disconnect"){
            //    
            //}else{
            //    patch.master_enable = true;
            //}
        //}

        let versionFound = false;
        let controlHrefs = [];
        let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

        for(let type of controlTypes){
            device.controls.forEach((control)=>{
                if(control.type == type.type){
                    controlHrefs.push({href:control.href, version:type.version});
                    versionFound = true;
                }
            })
            if(versionFound){
                break;
            }
        }

        let done = false;

        // TODO Check control hrefs for first response....

        for(let href of controlHrefs){
            // TODO, version specific things
            let fixSlash = ""
            if(href.href[href.href.length-1] == "/"){
                fixSlash = ""
            }else{
                fixSlash = "/"
            }
            let patchHref = href.href + fixSlash + "single/receivers/" + receiverId + "/staged"
            try{
                let result = await axios.patch(patchHref, patch, {timeout:30000});
                return SyncLog.log("success", "nmos_connect", "Successfully patched: "+receiverId, {href:patchHref, data:patch})
            }catch(e){
                if (axios.isAxiosError(e)) {
                    if(e.code == "ETIMEDOUT"){
                        // NEXT
                        let id = SyncLog.log("info", "nmos_connect", "Patch on "+patchHref+" timed out, trying next.");
                    }else{
                        // TODO....
                        if(e.code == "ERR_BAD_REQUEST"){
                            let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            throw new LoggedError("Patch failed: "+e.response.data.error + " / " +e.response.data.debug , id);
                        }
                        let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                        throw new LoggedError("Receiver returned Error: "+e.code, id);
                    }
                }else{
                    throw new LoggedError("Patch Failed: "+e.message);
                }
                
            }
        }
        let id = SyncLog.log("error", "nmos_connect", "Receiver Control unreachable.",{controlHrefs,patch});
        throw new LoggedError("Receiver Control unreachable.", id);
    }



    async enableFlow(senderId:string, disable=false){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                device.controls.forEach((control)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                })
                if(versionFound){
                    break;
                }
            }

            // Determine number of legs: prefer interface_bindings, otherwise
            // fall back to whatever the sender currently advertises in its
            // active transport_params; default to 1 leg.
            let legCount = 1;
            try{
                if(Array.isArray(sender.interface_bindings) && sender.interface_bindings.length > 0){
                    legCount = sender.interface_bindings.length;
                }else{
                    let activeData = (this.nmosState as any).senderActiveData?.[senderId];
                    if(activeData && Array.isArray(activeData.transport_params) && activeData.transport_params.length > 0){
                        legCount = activeData.transport_params.length;
                    }
                }
            }catch(e){}
            if(legCount < 1){ legCount = 1; }

            let rtpEnabled = !disable;
            let transportParams:any[] = [];
            for(let i=0;i<legCount;i++){
                transportParams.push({ rtp_enabled: rtpEnabled });
            }

            let patch:any = {
                "receiver_id": null,
                "master_enable": !disable,
                "activation": {
                    "mode": "activate_immediate",
                    "requested_time": null,
                },
                "transport_params": transportParams
            };


            for(let href of controlHrefs){
                // TODO, version specific things
                let fixSlash = ""
                if(href.href[href.href.length-1] == "/"){
                    fixSlash = ""
                }else{
                    fixSlash = "/"
                }
                let patchHref = href.href + fixSlash + "single/senders/" + senderId + "/staged";
                try{
                    await axios.patch(patchHref, patch, {timeout:30000});
                    SyncLog.log("success", "nmos", "Successfully enabled: "+senderId, {href:patchHref, data:patch})
                    return;
                }catch(e){
                    if (axios.isAxiosError(e)) {
                        if(e.code == "ETIMEDOUT"){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" timed out, trying next.");
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
        }catch(e){

        }

    }


    /**
     * Toggle a receiver's master_enable flag. Used by the Details page
     * to activate / deactivate a receiver without changing its current
     * sender subscription (sender_id and transport_file stay in place).
     */
    async enableReceiver(receiverId:string, disable=false){
        try{
            let versionFound = false;
            let controlHrefs:any[] = [];

            let receiver = this.nmosState.receivers[receiverId];
            if(!receiver){
                SyncLog.log("warning", "NMOS", "Cannot toggle receiver, unknown id: " + receiverId);
                return;
            }
            let device = this.nmosState.devices[receiver.device_id];

            let controlTypes = [
                {type:"urn:x-nmos:control:sr-ctrl/v1.1", version:"v1.1"},
                {type:"urn:x-nmos:control:sr-ctrl/v1.0", version:"v1.0"}
            ];
            for(let type of controlTypes){
                device.controls.forEach((control:any)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                });
                if(versionFound){ break; }
            }

            let patch:any = {
                master_enable: !disable,
                activation: {
                    mode: "activate_immediate",
                    requested_time: null
                }
            };

            for(let href of controlHrefs){
                let fixSlash = (href.href[href.href.length-1] == "/") ? "" : "/";
                let patchHref = href.href + fixSlash + "single/receivers/" + receiverId + "/staged";
                try{
                    await axios.patch(patchHref, patch, {timeout:30000});
                    SyncLog.log("success", "nmos", "Successfully " + (disable?"disabled":"enabled") + " receiver: " + receiverId, {href:patchHref, data:patch});
                    return;
                }catch(e:any){
                    if(axios.isAxiosError(e)){
                        if(e.code == "ETIMEDOUT"){
                            SyncLog.log("info", "nmos", "Patch on " + receiverId + " timed out, trying next.");
                        }else{
                            let logBody:any = {controlHrefs, failedControl:patchHref, patch};
                            if(e.code == "ERR_BAD_REQUEST" && e.response){
                                logBody.error = e.response.data;
                            }else{
                                logBody.message = e.message;
                            }
                            SyncLog.log("error", "nmos", "Receiver " + receiverId + " returned Error: " + e.code, logBody);
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
        }catch(e){}
    }


    async setFlowMulticast(senderId:string, data:any){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                device.controls.forEach((control)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                })
                if(versionFound){
                    break;
                }
            }

            // Determine number of legs the sender actually advertises.
            let legCount = 1;
            try{
                if(Array.isArray(sender.interface_bindings) && sender.interface_bindings.length > 0){
                    legCount = sender.interface_bindings.length;
                }else{
                    let activeData = (this.nmosState as any).senderActiveData?.[senderId];
                    if(activeData && Array.isArray(activeData.transport_params) && activeData.transport_params.length > 0){
                        legCount = activeData.transport_params.length;
                    }
                }
            }catch(e){}
            if(legCount < 1){ legCount = 1; }

            // Also stretch the array if the requested index demands it
            if(Array.isArray(data.legs)){
                data.legs.forEach((l:any)=>{
                    if(typeof l.index === "number" && l.index + 1 > legCount){
                        legCount = l.index + 1;
                    }
                });
            }

            let transportParams:any[] = [];
            for(let i=0;i<legCount;i++){
                transportParams.push({});
            }

            // Preserve the sender's current master_enable across the PATCH.
            // Per IS-05 a missing field means "leave unchanged", but some
            // firmwares (notably Merging Anubis) misread the omission and
            // deactivate the sender when only transport_params change. By
            // echoing back whatever subscription.active is right now we
            // make the behaviour deterministic across vendors.
            let currentMasterEnable = false;
            try{
                let s:any = this.nmosState.senders?.[senderId];
                if(s && s.subscription){
                    currentMasterEnable = !!s.subscription.active;
                }
                // Also consult the cached IS-05 active snapshot — its
                // master_enable is authoritative when present.
                let active:any = (this.nmosState as any).senderActiveData?.[senderId];
                if(active && typeof active.master_enable === "boolean"){
                    currentMasterEnable = active.master_enable;
                }
            }catch(e){}

            let patch:any = {
                "receiver_id": null,
                "master_enable": currentMasterEnable,
                "activation": {
                    "mode": "activate_immediate",
                    "requested_time": null,
                },
                "transport_params": transportParams
            };

            let meaningfulChange = false;
            data.legs.forEach((l)=>{
                if(typeof l.index !== "number" || l.index < 0 || l.index >= legCount){
                    return;
                }
                let leg:any = {source_ip:"auto"};
                if(l.multicast !== undefined && l.multicast !== null && l.multicast !== ""){
                    leg.destination_ip = l.multicast;
                    meaningfulChange = true;
                }
                if(l.port !== undefined && l.port !== null && l.port !== ""){
                    let p = parseInt(""+l.port);
                    if(!isNaN(p) && p > 0 && p < 65536){
                        leg.destination_port = p;
                        meaningfulChange = true;
                    }
                }
                patch.transport_params[l.index] = leg;
            });

            // Last-line-of-defence: never send a PATCH that would only set
            // `source_ip: "auto"` on every leg. Such a no-op PATCH causes the
            // reconcile loop to fire forever because nothing on the device
            // changes.
            if(!meaningfulChange){
                SyncLog.log("warn", "nmos", "Refusing to send empty setFlowMulticast PATCH for " + senderId + " (no destination_ip / destination_port).");
                return;
            }

            

            for(let href of controlHrefs){
                // TODO, version specific things
                let fixSlash = ""
                if(href.href[href.href.length-1] == "/"){
                    fixSlash = ""
                }else{
                    fixSlash = "/"
                }
                let patchHref = href.href + fixSlash + "single/senders/" + senderId + "/staged";
                try{
                    await axios.patch(patchHref, patch, {timeout:30000});
                    SyncLog.log("success", "nmos", "Successfully set multicast: "+senderId, {href:patchHref, data:patch});


                    setTimeout(()=>{
                        this.getSenderActive("senders", {path:senderId, post:sender});
                        this.getSenderManifestData("senders", {path:senderId, post:sender});
                    },1000);

                    // The sender's destination IP/port just changed. Any
                    // receiver currently subscribed to it has the OLD
                    // multicast in its IS-05 active transport_params and
                    // would silently stop receiving. We can optionally
                    // reconnect them so they pick up the new manifest.
                    //
                    // Gated by `settings.reconnectReceiversOnSenderChange`
                    // (default true). The caller can force the reconnect by
                    // setting `data._forceReconnect = true` — used by the
                    // "Reallocate from pool" sweep when Auto-Allocation is
                    // toggled on, where receivers must follow no matter what.
                    let forceReconnect = !!(data && data._forceReconnect);
                    let cfg = (this.settings && this.settings.reconnectReceiversOnSenderChange !== false);
                    if(forceReconnect || cfg){
                        setTimeout(()=>{
                            try{
                                if(CrosspointAbstraction.instance){
                                    CrosspointAbstraction.instance.reconnectReceiversOfSender(senderId);
                                }
                            }catch(e){}
                        }, 2000);
                    }


                    return;
                }catch(e){
                    if (axios.isAxiosError(e)) {
                        if(e.code == "ETIMEDOUT"){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" timed out, trying next.");
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
        }catch(e){

        }

    }


    /**
     * Ensure the given sender has a Multicast Lease and that its active IS-05
     * transport_params reflect the lease's addresses. Called after every
     * senderActiveData refresh. Idempotent and safe to call repeatedly.
     *
     * `forceReconnect` propagates through to setFlowMulticast so any
     * resulting PATCH triggers receiver reconnects regardless of the
     * `reconnectReceiversOnSenderChange` setting.
     */
    /**
     * Force-refresh the IS-05 `single/senders/<id>/active` snapshot of one
     * sender. Used when the lease manager has a fresh lease for a sender
     * but the cached `senderActiveData` is missing or stale — without this
     * we'd silently wait for the next NMOS WS event to arrive, which may
     * never happen for senders that haven't changed any IS-04 field.
     *
     * Returns true if the active data was successfully updated.
     */
    private async refreshSenderActive(senderId:string): Promise<boolean> {
        try{
            let sender = this.nmosState.senders[senderId];
            if(!sender){ return false; }
            let device = this.nmosState.devices[sender.device_id];
            if(!device || !Array.isArray(device.controls)){ return false; }
            // Accept both supported IS-05 control versions — QSC and other
            // newer devices advertise v1.1 only. v1.1 wins when both are
            // present (newer schema, better field coverage).
            let preferred = ["urn:x-nmos:control:sr-ctrl/v1.1", "urn:x-nmos:control:sr-ctrl/v1.0"];
            for(let ctrlType of preferred){
                for(let c of device.controls){
                    if(c && c.type === ctrlType){
                        let href:string = c.href;
                        if(href[href.length-1] !== "/"){ href += "/"; }
                        href += "single/senders/" + senderId + "/active/";
                        try{
                            let response = await axios.get(href);
                            this.nmosState.senderActiveData[senderId] = response.data;
                            return true;
                        }catch(e:any){
                            SyncLog.log("warn", "Multicast Lease", "refreshSenderActive failed for " + senderId + " via " + ctrlType + ": " + (e?.message || e));
                            // Don't return — try the other version before giving up
                        }
                    }
                }
            }
        }catch(e){}
        return false;
    }

    private reconcileSenderWithLease(senderId:string, forceReconnect:boolean = false){
        let manager = MulticastLeaseManager.instance;
        if(!manager){ return; }

        // Hard guard: when Multicast DHCP is OFF the server must NEVER touch
        // any sender's multicast addresses, even for senders that still have
        // a lease in memory from a previous on-period. ensureLease() returns
        // existing leases regardless of the enabled flag (so the inventory
        // and stats stay readable), so we need this explicit check here.
        if(!manager.isEnabled()){ return; }

        let sender = this.nmosState.senders[senderId];
        if(!sender){ return; }
        let flow:any = this.nmosState.flows[sender.flow_id];
        if(!flow){ return; }
        let source:any = this.nmosState.sources[flow.source_id];

        let mediaType:string = flow.media_type || "";
        let channels:number = 0;
        try{
            if(source && Array.isArray(source.channels)){
                channels = source.channels.length;
            }
        }catch(e){}

        let deviceLabel = "";
        let nodeId = "";
        try{
            let dev = this.nmosState.devices[sender.device_id];
            if(dev){ deviceLabel = dev.label || ""; nodeId = dev.node_id || ""; }
        }catch(e){}

        // Reuse the active port if known (most senders default to 5004)
        let port = 5004;
        try{
            let active:any = (this.nmosState as any).senderActiveData?.[senderId];
            if(active && Array.isArray(active.transport_params) && active.transport_params.length > 0){
                let tp = active.transport_params[0];
                if(tp && typeof tp.destination_port === "number" && tp.destination_port > 0){
                    port = tp.destination_port;
                }
            }
        }catch(e){}

        let isActive = !!(sender.subscription && sender.subscription.active);
        let hadLeaseBefore = !!manager.getLease(senderId);
        let lease = manager.ensureLease({ senderId, mediaType, channels, deviceLabel, nodeId, port, isActive });
        if(!lease){ return; }

        // Compare lease against current active transport_params
        let active:any = (this.nmosState as any).senderActiveData?.[senderId];
        if(!active || !Array.isArray(active.transport_params)){
            // We have a (possibly fresh) lease but no IS-05 active snapshot
            // yet — common when a sender just transitioned to active and we
            // got the IS-04 event before the IS-05 GET landed, OR when an
            // earlier IS-05 fetch failed silently. Trigger a fresh fetch and
            // recurse so the PATCH actually goes out instead of getting
            // stuck waiting for the next external trigger.
            if(!hadLeaseBefore || forceReconnect){
                try{
                    this.refreshSenderActive(senderId).then((ok:boolean)=>{
                        if(ok){
                            try{ this.reconcileSenderWithLease(senderId, forceReconnect); }catch(e){}
                        }
                    }).catch(()=>{});
                }catch(e){}
            }
            return;
        }

        let legs:any[] = [];
        active.transport_params.forEach((tp:any, idx:number)=>{
            // Effective IP honours manual overrides — if the user set one,
            // we reconcile towards that; otherwise to the reserved address.
            let desiredIp = manager.getEffectiveIp(senderId, idx);
            // Skip the leg entirely when we have nothing valid to push —
            // prevents an infinite reconcile loop with empty destination_ip
            // PATCHes if a lease somehow ended up with an empty IP.
            if(!desiredIp || typeof desiredIp !== "string"){ return; }

            let needIp   = (tp && tp.destination_ip !== desiredIp);
            let needPort = (tp && typeof tp.destination_port === "number" && tp.destination_port !== lease.port);
            if(needIp || needPort){
                let legUpdate:any = { index: idx };
                if(needIp){   legUpdate.multicast = desiredIp; }
                if(needPort){ legUpdate.port = lease.port; }
                legs.push(legUpdate);
            }
        });

        if(legs.length > 0){
            SyncLog.log("info", "Multicast Lease", "Reconciling sender " + senderId + " to lease addresses.", {legs});
            // Fire-and-forget — the PATCH triggers another getSenderActive,
            // which lands here again but finds no diff and stops.
            this.setFlowMulticast(senderId, { legs, _forceReconnect: forceReconnect }).catch(()=>{});
        }
    }


    private getOne(hrefList: string[]) {
        return new Promise((resolve, reject) => {
            let promises = [];
            hrefList.forEach((href) => {
                promises.push(axios.get(href));
                axios.get(href).then(response=>{
                
                }).catch(e=>{
                    // TODO Logging
                    //console.log(e)
                });
            });
            
            Promise.any(promises)
                .then((response) => {
                    resolve(response);
                })
                .catch((error) => {
                    // TODO: Logging
                    //console.log(error);
                    reject(error);
                });
        });
    }
}

interface Connection {
    subscription: any;
    ws: WebSocket;
}

interface NmosRegistry {
    ip: string;
    port: number;
    domain: string;
    priority: number;
    source: "mdns" | "dnssd" | "static";
}

interface ConnectionList {
    [name: string]: Connection;
}

interface CrosspointList {
    [name: string]: any;
}
export interface CrosspointState {
    [name: string]: CrosspointList;
}



interface CrosspointSender {
    name:string;
    type:string;
    resolution:string;
}



