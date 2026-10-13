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
import { deviceQueueKey, deviceRequest, markUnresponsive, neverConnected, noAnswer, withDevice } from "./deviceHttp";
import { isReceiving, receiverConnectionOf } from "./receiverConnection";

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
        this.queryDowngradeVersion = (typeof this.settings.nmos.queryDowngrade === "string")
            ? this.settings.nmos.queryDowngrade
            : "";

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
     *  otherwise the system resolver's search list.
     *
     *  /etc/resolv.conf is the normal source, but on a systemd-resolved host
     *  it is the 127.0.0.53 stub — and Docker, which refuses to hand a
     *  loopback resolver into a container, replaces the file with public
     *  nameservers AND DROPS the search list. The host then knows
     *  "search example.tv" (resolvectl domain) while the container sees
     *  nothing. So resolved's own files are read as well: they carry the real
     *  search list and are readable whenever /run/systemd/resolve is mounted
     *  in (or when running outside a container at all).
     *  Nothing found is a clean no-op — mDNS and the static registry stay. */
    private dnssdSearchDomains(): string[] {
        let cfg = "";
        try{ cfg = ("" + (this.settings?.registryDiscovery?.domain || "")).trim().replace(/\.+$/, ""); }catch(e){}
        if(cfg){ return [cfg]; }
        const domains: string[] = [];
        const files = [
            "/etc/resolv.conf",
            "/run/systemd/resolve/resolv.conf",        // resolved's uplink view
            "/run/systemd/resolve/stub-resolv.conf",   // stub, keeps the search list
        ];
        for(const file of files){
            let txt = "";
            try{ txt = fs.readFileSync(file, "utf8"); }catch(e){ continue; }
            for(const line of ("" + txt).split("\n")){
                const m = line.match(/^\s*(search|domain)\s+(.+)$/);
                if(!m) continue;
                for(const d of m[2].trim().split(/\s+/)){
                    const clean = d.trim().replace(/\.+$/, "");
                    if(clean && clean !== "local" && clean !== "." && !domains.includes(clean)){ domains.push(clean); }
                }
            }
        }
        return domains;
    }

    /** Unicast DNS-SD (RFC 6763 over normal DNS): PTR on
     *  _nmos-register._tcp.<domain> (v1.3; plus the deprecated
     *  _nmos-registration._tcp name) → SRV per instance → A record. */
    private async dnssdQuery() {
        // Resolve + remember the domains BEFORE the enabled check — the
        // Setup page shows them either way ("what would be searched").
        const domains = this.dnssdSearchDomains();
        let domainsChanged = domains.join(",") !== this.lastDnssdDomains.join(",");
        this.lastDnssdDomains = domains;
        // The Setup page shows the searched domains; they can change without
        // any registry event, and updateSyncConnectionState no longer polls.
        if(domainsChanged){ this.updateSyncConnectionState(); }
        try{
            if(this.settings?.registryDiscovery?.unicastDnssd === false) return;
        }catch(e){}
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
    // Domains the last DNS-SD pass would query (override or resolv.conf
    // search list) — shown on the Setup page next to the registry status.
    private lastDnssdDomains: string[] = [];
    private mdnsBrowser: any = null;
    private registryVersionList = ["v1.3","v1.2"];
    private connectVersionList = ["v1.1", "v1.0"];
    private channelmappingVersionList = ["v1.0"];

    // ----- IS-04 downgrade queries -----
    // The Query API only ever hands out resources that were registered
    // against the very version being queried: subscribe to v1.3 and every
    // device that registered at v1.2 is simply absent — it shows up nowhere
    // in the crosspoint and cannot be routed. `query.downgrade=<version>`
    // asks the registry to include those older resources as well, each in
    // its own (older) representation. The value is the OLDEST version we
    // still want; "" switches the parameter off.
    private queryDowngradeVersion:string = "";
    // "<registryUrl>_<version>" for every registry that answered the
    // subscription POST with an error status while query.downgrade was set.
    // Downgrade queries are an optional IS-04 feature, so we remember the
    // refusal and subscribe without the parameter instead of looping.
    private downgradeUnsupported:Set<string> = new Set<string>();

    // ----- Receivers that refuse a transport file -----
    // IS-05 lets a controller hand a receiver the sender's SDP so it learns
    // the media format. Not every device accepts one: a Riedel FusioN answers
    // 400 "Invalid parameter" to ANY transport_file on its v1.0 endpoint —
    // its own SDP, read from /active and sent straight back, included.
    //
    // Keyed by the IS-05 endpoint that refused it, not by the device: one
    // node can publish a whole row of devices behind a single connection API,
    // and they all behave the same. Keying by device made every one of them
    // burn its own failed PATCH before learning the same lesson.
    private transportFileUnsupported:Set<string> = new Set<string>();

    /** True when any of these control endpoints has already refused one. */
    private refusesTransportFile(controlHrefs:{href:string}[]):boolean{
        return controlHrefs.some((c) => this.transportFileUnsupported.has(c.href));
    }
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
        // Receivers whose registry entry names no sender: their IS-05
        // /active as read from the device (see readReceiverConnection).
        receiverActiveData:{},
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

    /**
     * A resource's `controls` list (IS-05 / IS-08 endpoints of a device).
     * `controls` only exists from IS-04 v1.1 onwards, so a device registered
     * against v1.0 — which a downgrade query can now surface — carries none
     * at all. Returning an empty list keeps every caller on its existing
     * "no control endpoint" path instead of throwing on `undefined.forEach`.
     */
    private static controlsOf(resource:any):any[]{
        return (resource && Array.isArray(resource.controls)) ? resource.controls : [];
    }

    /**
     * The name/MAC pairs for the interfaces a sender or receiver is bound to.
     * Both `interface_bindings` (sender/receiver) and `interfaces` (node)
     * arrived with IS-04 v1.2, so a resource from an older API version — which
     * a downgrade query can surface — simply yields an empty list instead of
     * throwing on `undefined.forEach`.
     */
    private static bindingInterfaces(resource:any, node:any):Array<{name:any, mac:any}>{
        const out:Array<{name:any, mac:any}> = [];
        const bindings       = (resource && Array.isArray(resource.interface_bindings)) ? resource.interface_bindings : [];
        const nodeInterfaces = (node     && Array.isArray(node.interfaces))             ? node.interfaces             : [];
        bindings.forEach((name:any)=>{
            nodeInterfaces.forEach((inter:any)=>{
                if(inter.name == name){
                    out.push({name:name, mac:inter.port_id});
                }
            });
        });
        return out;
    }

    /**
     * How many ST 2022-7 legs a sender or receiver has. Counted from
     * `interface_bindings`, which is an IS-04 v1.2 field: a pre-v1.2 resource
     * has none and could not have expressed more than one leg anyway, so one
     * is the right answer for it (and for the spec-violating empty array).
     */
    private static legCountOf(resource:any):number{
        return (resource && Array.isArray(resource.interface_bindings) && resource.interface_bindings.length > 0)
            ? resource.interface_bindings.length
            : 1;
    }

    /**
     * How many legs to address in an IS-05 PATCH.
     *
     * The device is the authority: its /active endpoint carries exactly one
     * transport_params entry per leg, and IS-05 requires a PATCH to carry the
     * same number — a shorter array is rejected outright ("Invalid
     * parameter"). IS-04's interface_bindings only counts the interfaces the
     * device actually BOUND, so a device that exposes a second leg over IS-05
     * without binding it (interface_ip 0.0.0.0) reports one there and two
     * here. The active snapshot therefore wins; interface_bindings is the
     * fallback for when we could not read one.
     */
    private static legCountFromActive(active:any, resource:any):number{
        try{
            if(active && Array.isArray(active.transport_params) && active.transport_params.length > 0){
                return active.transport_params.length;
            }
        }catch(e){}
        return NmosRegistryConnector.legCountOf(resource);
    }

    /**
     * A receiver's IS-05 active parameters, read straight from the device.
     * The registry does not carry them, and they are the only reliable
     * statement of how many legs a PATCH has to address. Returns null when no
     * control endpoint answers — the caller then falls back to IS-04.
     */
    private async getReceiverActive(receiverId:string, controlHrefs:{href:string}[], device:any):Promise<any|null>{
        for(const control of controlHrefs){
            let href = control.href;
            if(href[href.length-1] !== "/"){ href += "/"; }
            href += "single/receivers/" + receiverId + "/active";
            try{
                const response = await deviceRequest(deviceQueueKey(device, href), {method:"get", url:href, timeout:5000});
                if(response && response.data){ return response.data; }
            }catch(e){
                // Unreachable or wrong endpoint — the caller hands us every
                // control href the device advertises, so try the next one.
            }
        }
        return null;
    }

    /**
     * A sender's IS-05 active parameters, read straight from the device and
     * written back into the cache. The cached snapshot only moves when IS-04
     * reports a change, and switching a leg on or off need not touch IS-04.
     * Falls back to the cache when no control endpoint answers; `fresh`, when
     * given, collects the ids that WERE read from the device.
     */
    private async readSenderActive(senderId:string, device:any, fresh?:Set<string>):Promise<any|null>{
        let preferred = ["urn:x-nmos:control:sr-ctrl/v1.1", "urn:x-nmos:control:sr-ctrl/v1.0"];
        for(let ctrlType of preferred){
            for(let c of NmosRegistryConnector.controlsOf(device)){
                if(!c || c.type !== ctrlType){ continue; }
                let href:string = c.href;
                if(href[href.length-1] !== "/"){ href += "/"; }
                href += "single/senders/" + senderId + "/active/";
                try{
                    const response = await deviceRequest(deviceQueueKey(device, href), {method:"get", url:href, timeout:5000});
                    if(response && response.data){
                        this.nmosState.senderActiveData[senderId] = response.data;
                        if(fresh){ fresh.add(senderId); }
                        return response.data;
                    }
                }catch(e){}
            }
        }
        return (this.nmosState as any).senderActiveData?.[senderId] || null;
    }

    /**
     * The legs a sender lists in its SDP but does not transmit on.
     *
     * A sender may publish both ST 2022-7 media blocks while only the first
     * one is in use. The second then carries the device's factory defaults —
     * a multicast that every unit of that model shares, a placeholder source
     * address. Taken at face value it gets enabled on the receiver as well,
     * and a receiver that already joined the same default group on another
     * input refuses the whole PATCH ("cannot have differing redundant
     * information"), primary leg included.
     *
     * The sender says itself which legs are real, in three places:
     *  - IS-04 interface_bindings names one interface per leg in use. A leg
     *    past the end of that list is not wired to anything. Only v1.2+
     *    resources have the field; without it nothing is ruled out.
     *  - IS-05 /active resolves source_ip to the address the leg sends from.
     *    0.0.0.0 means its interface has none: nothing can leave it. A
     *    Blackmagic 2110 sender binds both QSFP ports, keeps both legs
     *    rtp_enabled — the second cannot be switched off — and reports
     *    exactly this on the unconfigured one. It only counts while another
     *    leg of the sender has a real address: 0.0.0.0 on EVERY leg says
     *    nothing about any of them — a device that resolves its addresses
     *    only once switched on, or a virtual sender of our own node whose
     *    SDP carries no source filter.
     *  - IS-05 /active has rtp_enabled per leg. That only counts while the
     *    sender as a whole is on: deactivating a sender switches every leg
     *    off, and a receiver routed to it now must still join all of them
     *    once it comes back.
     */
    static silentSenderLegs(sender:any, active:any, sdpLegCount:number):Array<{ index:number, reason:string }>{
        let out:Array<{ index:number, reason:string }> = [];
        let bindings = (sender && Array.isArray(sender.interface_bindings)) ? sender.interface_bindings : [];
        let resolved = (active && Array.isArray(active.transport_params)) ? active.transport_params : [];
        let params = (active && active.master_enable === true) ? resolved : [];
        let noAddress = (ip:any) => ip === "0.0.0.0" || ip === "::";
        let anyAddress = resolved.some((tp:any) => tp && typeof tp.source_ip === "string" && tp.source_ip !== "" && tp.source_ip !== "auto" && !noAddress(tp.source_ip));
        for(let i = 0; i < sdpLegCount; i++){
            let source = resolved[i] ? resolved[i].source_ip : undefined;
            if(bindings.length > 0 && i >= bindings.length){
                out.push({ index:i, reason:"the sender binds " + bindings.length + " interface(s) in IS-04, none for this leg" });
            }else if(anyAddress && noAddress(source)){
                out.push({ index:i, reason:"the sender has no source address on this leg (source_ip " + source + ")" });
            }else if(params[i] && params[i].rtp_enabled === false){
                out.push({ index:i, reason:"rtp_enabled is false on this leg of the active sender" });
            }
        }
        return out;
    }

    /**
     * The SDP without the media blocks at the given positions. Their mids are
     * taken out of any a=group line, and a group left with fewer than two
     * members goes entirely — a DUP group naming a stream that is not in the
     * file is no longer a valid ST 2022-7 description. Line-based on purpose:
     * every other line stays exactly what the sender published.
     */
    private static dropSdpMedia(sdp:string, indices:number[]):string{
        let eol = sdp.includes("\r\n") ? "\r\n" : "\n";
        // The final line break belongs to the file, not to whichever media
        // block happens to be last — RFC 4566 ends every line with one.
        let trailing = /\r?\n$/.test(sdp);
        let kept:string[] = [];
        let droppedMids:string[] = [];
        let media = -1;
        for(let line of sdp.replace(/\r?\n$/, "").split(/\r?\n/)){
            if(line.startsWith("m=")){ media++; }
            if(media >= 0 && indices.includes(media)){
                let mid = /^a=mid:(\S+)/.exec(line);
                if(mid){ droppedMids.push(mid[1]); }
                continue;
            }
            kept.push(line);
        }
        let out:string[] = [];
        for(let line of kept){
            if(line.startsWith("a=group:")){
                let parts = line.trim().split(/\s+/);
                let members = parts.slice(1).filter((m) => !droppedMids.includes(m));
                if(members.length < parts.length - 1){
                    if(members.length < 2){ continue; }
                    line = [parts[0], ...members].join(" ");
                }
            }
            out.push(line);
        }
        return out.join(eol) + (trailing ? eol : "");
    }

    /** Rank of an "vX.Y" API version string, -1 when it doesn't parse. */
    private static versionRank(version:string):number{
        let m = /^v(\d+)\.(\d+)$/.exec("" + version);
        if(!m) return -1;
        return (parseInt(m[1], 10) * 1000) + parseInt(m[2], 10);
    }

    /**
     * The value to send as `query.downgrade` when subscribing to `version` on
     * this registry — or "" when the parameter must not be sent at all:
     * downgrade switched off, this registry already refused it, or the target
     * is not actually OLDER than the version we subscribe to (a downgrade to
     * the queried version or newer is meaningless and gets rejected).
     */
    private downgradeParamFor(registryUrl:string, version:string):string{
        const target = this.queryDowngradeVersion;
        if(!target) return "";
        if(this.downgradeUnsupported.has(registryUrl + "_" + version)) return "";
        const targetRank  = NmosRegistryConnector.versionRank(target);
        const versionRank = NmosRegistryConnector.versionRank(version);
        if(targetRank < 0 || versionRank < 0) return "";
        if(targetRank >= versionRank) return "";
        return target;
    }

    /**
     * Live-apply a change of the downgrade setting (Setup page). The
     * parameter is fixed when a subscription is created, so the caller has to
     * re-subscribe afterwards — returns true when the value actually changed.
     */
    public setQueryDowngrade(version:string):boolean{
        const next = (typeof version === "string") ? version : "";
        if(next === this.queryDowngradeVersion) return false;
        this.queryDowngradeVersion = next;
        try{
            if(this.settings && this.settings.nmos){ this.settings.nmos.queryDowngrade = next; }
        }catch(e){}
        // A registry that refused the old value may well accept the new one.
        this.downgradeUnsupported.clear();
        SyncLog.log("info", "NMOS Settings", next
            ? "Query API downgrade set to " + next + " — devices registered from " + next + " upwards will be used."
            : "Query API downgrade switched off — only devices registered against the subscribed API version will be used.");
        return true;
    }

    private getVersionSubscription(nmosRegistryUrl: string, resource: string, versionIndex:number){
        const version = this.registryVersionList[versionIndex];
        if(!version) return;
        // Capture the generation at subscribe time. If reconnectStaticRegistries
        // is called mid-flight (live switch), this.registryGen advances and the
        // late-arriving response / reconnect timer skips itself.
        const myGen = this.registryGen;
        // Downgrade query — see queryDowngradeVersion. Empty means the
        // parameter is left out entirely, which is exactly the old behaviour.
        const downgrade = this.downgradeParamFor(nmosRegistryUrl, version);
        const params:any = {};
        if(downgrade){ params["query.downgrade"] = downgrade; }
        axios.post(nmosRegistryUrl + "/x-nmos/query/" + version + "/subscriptions", {
            resource_path: resource,
            params,
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
                downgrade,
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
                // A fresh subscription always starts with the registry's full
                // current state. Use that snapshot to reconcile: anything we
                // still hold that is NOT in it is gone — removed while we were
                // disconnected, or dropped by a registry that never sent (or
                // whose) removal grain we missed. Without this such resources
                // stay "online" in the crosspoint forever.
                this.startRegistryResync(fullResource, resource, nmosRegistryUrl);
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
                let parsed:any = JSON.parse(message.data);
                this.collectRegistryResync(fullResource, parsed);
                this.updateState(parsed,version,nmosRegistryUrl);
            };

            SyncLog.log("info",  "NMOS","Subscribed to Registry: " + nmosRegistryUrl + ", " + resource + ", " + version +
                (downgrade ? " (downgrade to " + downgrade + ")" : "") );
        }).catch((error) => {
            if(myGen !== this.registryGen) return;  // Switched registries while the POST was failing.
            // Downgrade queries are OPTIONAL in IS-04. A registry that does
            // not implement them answers the POST with 501 (unsupported query
            // syntax) or 400 / 422 (bad parameter) — note it down and retry
            // the SAME version without the parameter right away, so the
            // subscription still comes up. Every other status is about the
            // request as a whole, NOT about our parameter: a 404 in
            // particular just means the registry doesn't serve this Query API
            // version, which is what the version cascade below is for.
            const paramRefused = [400, 422, 501].includes(error?.response?.status);
            if(downgrade && paramRefused){
                const key = nmosRegistryUrl + "_" + version;
                if(!this.downgradeUnsupported.has(key)){
                    this.downgradeUnsupported.add(key);
                    SyncLog.log("warning", "NMOS", "Registry " + nmosRegistryUrl + " rejected query.downgrade=" + downgrade +
                        " on Query API " + version + " (HTTP " + error.response.status + "). Subscribing without it — devices " +
                        "registered against an older API version will not show up.");
                }
                this.getVersionSubscription(nmosRegistryUrl, resource, versionIndex);
                return;
            }
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
        this.clearPendingRemovals();
        // The next registry is a different implementation as far as we know —
        // probe its downgrade support again instead of carrying over a "no".
        this.downgradeUnsupported.clear();
        // Reset the in-memory NMOS state so the UI doesn't see stale devices
        // from the previous registry. setState emits a JSON-patch reset to
        // every subscribed client.
        this.receiverReadTimers.forEach((timer)=>{ clearTimeout(timer); });
        this.receiverReadTimers.clear();
        this.receiverReadsInFlight.clear();
        if(this.arrivedDevicesTimer){ clearTimeout(this.arrivedDevicesTimer); this.arrivedDevicesTimer = null; }
        this.arrivedDevices.clear();
        this.nmosState = {
            devices: {}, sources: {}, senders: {}, receivers: {},
            flows: {}, nodes: {}, senderActiveData: {}, receiverActiveData: {},
            channelmapping: {}, sendersManifestDetail: {}
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

    // ----- Registry re-sync -----
    // Everything the registry still has arrives right after a subscription
    // opens. We collect those ids for a short window and then drop whatever we
    // hold that did not show up: resources that disappeared while we were
    // disconnected produce no removal grain, so nothing else would ever clear
    // them and the crosspoint would keep showing them as online.
    private static RESYNC_WINDOW_MS = 4000;
    private startRegistryResync(fullResource:string, resource:string, registryUrl:string){
        let conn:any = this.connections[fullResource];
        if(!conn) return;
        try{ if(conn.resyncTimer){ clearTimeout(conn.resyncTimer); } }catch(e){}
        conn.resyncIds = new Set<string>();
        conn.resyncTimer = setTimeout(()=>{
            this.finishRegistryResync(fullResource, resource, registryUrl);
        }, NmosRegistryConnector.RESYNC_WINDOW_MS);
    }
    private collectRegistryResync(fullResource:string, message:any){
        let conn:any = this.connections[fullResource];
        if(!conn || !conn.resyncIds) return;
        try{
            message.grain.data.forEach((g:any)=>{
                if(typeof g.path === "string" && g.hasOwnProperty("post")){ conn.resyncIds.add(g.path); }
            });
        }catch(e){}
    }
    private finishRegistryResync(fullResource:string, resource:string, registryUrl:string){
        let conn:any = this.connections[fullResource];
        if(!conn || !conn.resyncIds) return;
        const seen:Set<string> = conn.resyncIds;
        conn.resyncIds  = null;
        conn.resyncTimer = null;

        const type = resource.replace(/^\//, "");
        if(!this.nmosState[type]) return;
        // With a single registry an entry that carries no source stamp is ours
        // too (it predates this build). With several registries connected we
        // only ever touch what we know came from THIS one.
        const soleRegistry = this.nmosRegistryList.length <= 1;
        let removed:string[] = [];
        for(const id of Object.keys(this.nmosState[type])){
            if(seen.has(id)) continue;
            const src = this.nmosState[type][id]?.["_sourceRegistry"];
            if(src === registryUrl || (!src && soleRegistry)){
                delete this.nmosState[type][id];
                this.dropFollowUps(type, id);
                removed.push(id);
            }
        }
        if(removed.length > 0){
            SyncLog.log("info", "NMOS", "Re-sync with " + registryUrl + ": dropped " + removed.length + " " + type +
                " the registry no longer has.", { ids: removed.slice(0, 20) });
            if(type === "nodes"){
                removed.forEach((id)=>{ try{ DdnsService.instance?.removeNode(id).catch(()=>{}); }catch(e){} });
            }
            this.scheduleSyncNmos();
            // Same follow-up as a removal grain: without this the crosspoint
            // keeps its last availability verdict and the entries stay green.
            this.updateCrosspoint();
        }
    }

    // ----- Removal grace -----
    // A device can drop its whole node from the registry and register it
    // again a moment later, same ids — the likely reason a Blackmagic DeckLink
    // IP 100G's devices left the matrix for a second on its first take.
    // Removals used to take effect at once while the re-add waited for the
    // 1 s new-item debounce, so every device of that node vanished for about
    // a second. A removal now takes effect only when the
    // resource is still gone after REMOVAL_GRACE_MS; a post within that time
    // cancels it. A device that is really gone shows offline that much later
    // — the registry itself already waits out a missed heartbeat (12 s by
    // default) before it removes one.
    private static REMOVAL_GRACE_MS = 3000;
    private pendingRemovals: Map<string, any> = new Map();
    private deferRemoval(type:string, id:string){
        const key = type + "/" + id;
        // A repeated removal keeps the first deadline.
        if(this.pendingRemovals.has(key)) return;
        const myGen = this.registryGen;
        this.pendingRemovals.set(key, setTimeout(()=>{
            this.pendingRemovals.delete(key);
            if(myGen !== this.registryGen) return;
            this.finishRemoval(type, id);
        }, NmosRegistryConnector.REMOVAL_GRACE_MS));
    }
    private cancelRemoval(type:string, id:string):boolean{
        const key = type + "/" + id;
        const timer = this.pendingRemovals.get(key);
        if(timer === undefined) return false;
        clearTimeout(timer);
        this.pendingRemovals.delete(key);
        if(type === "senders"){ this.reRegisteredSenders.set(id, Date.now() + NmosRegistryConnector.REREGISTERED_SDP_MS); }
        this.noteReRegistered(type, id);
        return true;
    }
    // Senders back within the grace, and until when their SDP answers are not
    // compared with the cached one (see getSenderManifestData). A window, not
    // a one-shot flag: an SDP fetch already in flight from before the
    // re-registration must not use it up, and a fetch that fails must not
    // leave it lying around to swallow a real change hours later.
    private reRegisteredSenders:Map<string, number> = new Map();
    private static REREGISTERED_SDP_MS = 15000;
    private clearPendingRemovals(){
        this.pendingRemovals.forEach((timer)=>{ clearTimeout(timer); });
        this.pendingRemovals.clear();
        this.reRegisteredSenders.clear();
    }
    private finishRemoval(type:string, id:string){
        if(!this.nmosState[type] || !this.nmosState[type][id]) return;
        delete this.nmosState[type][id];
        // DNS Push: a node that's gone from the registry should not keep a
        // stale DNS entry.
        if(type === "nodes"){
            try{
                if(DdnsService.instance){
                    DdnsService.instance.removeNode(id).catch(()=>{});
                }
            }catch(e){}
        }
        this.dropFollowUps(type, id);
        this.scheduleSyncNmos();
        this.updateCrosspoint();
    }
    /** What hangs off a sender or receiver besides its registry entry. Used
     *  when the entry goes, by a removal or by the re-sync. */
    private dropFollowUps(type:string, id:string){
        const pending = this.pendingRemovals.get(type + "/" + id);
        if(pending !== undefined){
            clearTimeout(pending);
            this.pendingRemovals.delete(type + "/" + id);
        }
        if(type === "senders"){
            const fetchTimer = this.manifestFetchTimers.get(id);
            if(fetchTimer){
                clearTimeout(fetchTimer);
                this.manifestFetchTimers.delete(id);
            }
            delete this.nmosState.sendersManifestDetail[id];
            delete this.nmosState.senderActiveData[id];
            this.reRegisteredSenders.delete(id);
        }
        if(type === "receivers"){
            this.cancelReceiverRead(id);
            delete this.nmosState.receiverActiveData[id];
        }
    }

    // One log line per burst, so a device that re-registers is visible in
    // the log instead of silently kept online.
    private reRegisteredCount: Map<string, number> = new Map();
    private reRegisteredNames: Set<string> = new Set();
    private reRegisteredLogTimer: any = null;
    private noteReRegistered(type:string, id:string){
        this.reRegisteredCount.set(type, (this.reRegisteredCount.get(type) || 0) + 1);
        try{
            const res:any = this.nmosState[type]?.[id];
            const devLabel = (type === "nodes" || type === "devices")
                ? res?.label
                : (this.nmosState.devices as any)?.[res?.device_id]?.label;
            if(devLabel && this.reRegisteredNames.size < 20){ this.reRegisteredNames.add(devLabel); }
        }catch(e){}
        if(this.reRegisteredLogTimer) return;
        this.reRegisteredLogTimer = setTimeout(()=>{
            this.reRegisteredLogTimer = null;
            const counts:any = {};
            let total = 0;
            this.reRegisteredCount.forEach((n, t)=>{ counts[t] = n; total += n; });
            const names = Array.from(this.reRegisteredNames);
            this.reRegisteredCount.clear();
            this.reRegisteredNames.clear();
            SyncLog.log("info", "NMOS", "Registry removed " + total + " resource(s) and registered them again within " +
                (NmosRegistryConnector.REMOVAL_GRACE_MS / 1000) + " s" + (names.length ? " (" + names.join(", ") + ")" : "") +
                " — kept online instead of showing them offline.", { counts, names });
        }, 2000);
    }

    updateNewNmosItemTimer:any|null = null;
    private updateState(message: any, version:string, registryUrl:string = "") {
        //console.log("updates from registry: " + message.type)
        let newItem = false;
        let type = "";
        let changes = false;
        let changesConnect = false;
        let newIds:Set<string> = new Set();
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
                            // Back inside the removal grace: the entry never
                            // left, so this is an update, not a new item. It
                            // takes the version guard's place too: in 4.44
                            // the entry was gone by now and the post came in
                            // as new, whatever version it carried.
                            let reRegistered = this.cancelRemoval(type, g.path);
                            if(!reRegistered && this.nmosState[type][g.path] && !this.versionIsPrefered(this.nmosState[type][g.path]["_sourceVersion"], version)){
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
                                    newIds.add(g.path);
                                }

                                postData["_sourceVersion"] = version;
                                if(registryUrl){ postData["_sourceRegistry"] = registryUrl; }

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
                        // Remove element. NO version guard here: the cascade
                        // keeps exactly ONE live subscription per resource, and
                        // after a reconnect it may sit on a different Query API
                        // version than the one that added the entry. Requiring a
                        // match meant such removals were dropped on the floor and
                        // the resource stayed "online" in the crosspoint forever.
                        // Takes effect after REMOVAL_GRACE_MS, see deferRemoval.
                        try {
                            if(this.nmosState[type][g.path]){
                                this.deferRemoval(type, g.path);
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
                    // A removal is followed up when it takes effect
                    // (finishRemoval), not when the grain arrives.
                    if (!g || !g.hasOwnProperty("post")) return;

                    if (type == "senders" || type == "flows") {
                        // One fetch per resource, coalesced. Every grain used
                        // to schedule TWO manifest fetches (200ms + a blind
                        // 5s repeat) with no dedup, so a registry restart or
                        // bulk re-registration hit every device with 2×N HTTP
                        // GETs. The 5s repeat exists because some devices
                        // publish a real SDP only shortly after registering —
                        // it is now conditional: it only runs when the first
                        // fetch produced no usable media section.
                        this.scheduleManifestFetch(type, g);
                    }

                    if(type == "senders"){
                        setTimeout(()=>{
                            this.getSenderActive(type, g);
                        },100);
                    }

                    if(type == "receivers"){
                        // No `pre`: added to the registry just now, not
                        // part of the snapshot a (re)subscription starts with.
                        this.receiverChanged(g.path, !g.hasOwnProperty("pre"));
                    }

                    if(type == "devices" && newIds.has(g.path)){
                        this.deviceArrived(g.path);
                    }
                });


        

    }

    // ----- Receivers the registry names no sender for -----
    // A device that keeps receiving across a reboot can come back with no
    // sender_id in its IS-04 subscription: the picture runs, the matrix shows
    // nothing. For such a receiver we ask the device itself (IS-05 /active)
    // and keep the answer in receiverActiveData; the worker works out the
    // sender from it (receiverConnection.ts). Event driven, no polling: a
    // read when the receiver's registry entry changes, after each of our own
    // takes on it, and when its device turns up late.
    private receiverReadTimers: Map<string, any> = new Map();
    // Receivers whose /active read has been sent and not answered yet.
    private receiverReadsInFlight: Set<string> = new Set();
    // A device that just (re)registered may restore its connection a little
    // later without touching IS-04 — ask again after these delays while it
    // shows no stream.
    private static RECEIVER_RETRY_MS = [10000, 30000];
    // A read that got no answer is tried once more after this.
    private static RECEIVER_FAIL_RETRY_MS = [30000];

    private receiverChanged(receiverId:string, justRegistered:boolean){
        let receiver:any = this.nmosState.receivers[receiverId];
        if(!receiver){ return; }
        let known:any = this.nmosState.receiverActiveData[receiverId];
        let sub = receiver.subscription;
        if(sub && sub.active && sub.sender_id){
            // The registry names the sender: nothing to work out.
            this.cancelReceiverRead(receiverId);
            if(known){
                delete this.nmosState.receiverActiveData[receiverId];
                this.scheduleSyncNmos();
            }
            return;
        }
        // Already read for exactly this state (a re-sync repeats it). Not
        // after a fresh registration: the device may have changed meanwhile
        // without its IS-04 version showing it.
        if(!justRegistered && known && known.is04Version === "" + receiver.version){ return; }
        if(known){
            // Stale from here on: nothing rather than an old answer.
            delete this.nmosState.receiverActiveData[receiverId];
            this.scheduleSyncNmos();
            this.updateCrosspoint();
        }
        this.scheduleReceiverRead(receiverId, 300, justRegistered ? NmosRegistryConnector.RECEIVER_RETRY_MS : []);
    }

    /** After a take, disconnect or enable/disable we sent: what was shown
     *  from the device is out of date, whatever IS-04 does next. */
    private receiverTaken(receiverId:string){
        let receiver:any = this.nmosState.receivers[receiverId];
        if(!receiver){ return; }
        if(this.nmosState.receiverActiveData[receiverId]){
            delete this.nmosState.receiverActiveData[receiverId];
            this.scheduleSyncNmos();
            this.updateCrosspoint();
        }
        // Read only if the registry does not name the sender — a device that
        // updates IS-04 on a take brings its own grain.
        this.readAfterTakes(receiverId, NmosRegistryConnector.TAKE_QUIET_MS);
    }

    // Takes running per node, and when the last one started or ended. The
    // read after a take waits until its node has been quiet for a moment: a
    // background read started in the gap between a take's GET and its PATCH
    // holds a slot of the node's lane, and on a slow device the next PATCH
    // of a device-level take waits behind it.
    private static TAKE_QUIET_MS = 1000;
    private nodeTakesRunning: Map<string, number> = new Map();
    private nodeTakeAt: Map<string, number> = new Map();
    private nodeOfReceiver(receiverId:string):string{
        let r:any = this.nmosState.receivers[receiverId];
        let d:any = r ? this.nmosState.devices[r.device_id] : null;
        return "" + (d?.node_id || r?.device_id || receiverId);
    }
    private takeStarted(receiverId:string):string{
        let node = this.nodeOfReceiver(receiverId);
        this.nodeTakesRunning.set(node, (this.nodeTakesRunning.get(node) || 0) + 1);
        this.nodeTakeAt.set(node, Date.now());
        return node;
    }
    private takeEnded(node:string){
        let n = (this.nodeTakesRunning.get(node) || 1) - 1;
        if(n > 0){ this.nodeTakesRunning.set(node, n); }else{ this.nodeTakesRunning.delete(node); }
        this.nodeTakeAt.set(node, Date.now());
    }
    private readAfterTakes(receiverId:string, delay:number){
        this.cancelReceiverRead(receiverId);
        this.receiverReadTimers.set(receiverId, setTimeout(()=>{
            this.receiverReadTimers.delete(receiverId);
            let node = this.nodeOfReceiver(receiverId);
            let quietFor = Date.now() - (this.nodeTakeAt.get(node) || 0);
            if(this.nodeTakesRunning.has(node) || quietFor < NmosRegistryConnector.TAKE_QUIET_MS){
                this.readAfterTakes(receiverId, Math.max(100, NmosRegistryConnector.TAKE_QUIET_MS - quietFor));
                return;
            }
            this.nodeTakeAt.delete(node);
            this.scheduleReceiverRead(receiverId, 0, []);
        }, delay));
    }

    // Devices that turned up after their receivers (a snapshot can deliver
    // them in either order): their receivers are read once they are there.
    private arrivedDevices:Set<string> = new Set();
    private arrivedDevicesTimer:any = null;
    private deviceArrived(deviceId:string){
        this.arrivedDevices.add(deviceId);
        if(this.arrivedDevicesTimer){ return; }
        this.arrivedDevicesTimer = setTimeout(()=>{
            this.arrivedDevicesTimer = null;
            let devices = this.arrivedDevices;
            this.arrivedDevices = new Set();
            for(let id of Object.keys(this.nmosState.receivers)){
                let r:any = this.nmosState.receivers[id];
                if(!r || !devices.has(r.device_id)){ continue; }
                if(this.nmosState.receiverActiveData[id] || this.receiverReadTimers.has(id) || this.receiverReadsInFlight.has(id)){ continue; }
                let sub = r.subscription;
                if(sub && sub.active && sub.sender_id){ continue; }
                this.scheduleReceiverRead(id, 0, []);
            }
        }, 500);
    }

    private scheduleReceiverRead(receiverId:string, delay:number, idleRetries:number[],
                                 failRetries:number[] = NmosRegistryConnector.RECEIVER_FAIL_RETRY_MS){
        this.cancelReceiverRead(receiverId);
        this.receiverReadTimers.set(receiverId, setTimeout(()=>{
            this.receiverReadTimers.delete(receiverId);
            this.receiverReadsInFlight.add(receiverId);
            this.readReceiverConnection(receiverId).then((result)=>{
                // A newer registry change has scheduled its own read.
                if(this.receiverReadTimers.has(receiverId)){ return; }
                // Anything but a stream (or a change that brings its own
                // read) walks on through the restore-later steps; an
                // unanswered read gets its own retry once those are used up.
                // A missing device is left to deviceArrived.
                let open = result === "idle" || result === "failed" || result === "nodevice";
                if(open && idleRetries.length > 0){
                    this.scheduleReceiverRead(receiverId, idleRetries[0], idleRetries.slice(1), failRetries);
                }else if(result === "failed" && failRetries.length > 0){
                    this.scheduleReceiverRead(receiverId, failRetries[0], [], failRetries.slice(1));
                }
            }).catch(()=>{}).finally(()=>{
                this.receiverReadsInFlight.delete(receiverId);
            });
        }, delay));
    }

    private cancelReceiverRead(receiverId:string){
        let timer = this.receiverReadTimers.get(receiverId);
        if(timer !== undefined){
            clearTimeout(timer);
            this.receiverReadTimers.delete(receiverId);
        }
    }

    /** Reads the receiver's IS-05 /active and stores it.
     *  "receiving": takes a stream (or the registry names its sender by now).
     *  "idle": the device answered, no stream. "failed": no answer.
     *  "nodevice": its device is not known yet (deviceArrived reads it).
     *  "stale": the receiver changed or went while we waited. */
    private async readReceiverConnection(receiverId:string):Promise<"receiving"|"idle"|"failed"|"nodevice"|"stale">{
        let receiver:any = this.nmosState.receivers[receiverId];
        if(!receiver){ return "stale"; }
        let sub = receiver.subscription;
        if(sub && sub.active && sub.sender_id){ return "receiving"; }
        let device:any = this.nmosState.devices[receiver.device_id];
        if(!device){ return "nodevice"; }
        let hrefs:string[] = [];
        for(let ctrlType of ["urn:x-nmos:control:sr-ctrl/v1.1", "urn:x-nmos:control:sr-ctrl/v1.0"]){
            for(let c of NmosRegistryConnector.controlsOf(device)){
                if(c.type === ctrlType && typeof c.href === "string"){ hrefs.push(c.href); }
            }
            if(hrefs.length > 0){ break; }
        }
        // No IS-05 control: nothing to ask, and asking again will not help.
        if(hrefs.length === 0){ return "idle"; }

        let version = "" + receiver.version;
        let active:any = null;
        for(let href of hrefs){
            active = await this.readReceiverActiveAt(receiverId, href, device, true);
            if(active){ break; }
        }
        // Changed or gone while we waited: that change brings its own read.
        let now:any = this.nmosState.receivers[receiverId];
        if(!now || ("" + now.version) !== version){ return "stale"; }
        if(!active){ return "failed"; }

        let conn = receiverConnectionOf(active, version);
        let before:any = this.nmosState.receiverActiveData[receiverId];
        this.nmosState.receiverActiveData[receiverId] = conn;
        let same = !!before && before.masterEnable === conn.masterEnable && before.senderId === conn.senderId &&
                   JSON.stringify(before.legs) === JSON.stringify(conn.legs);
        if(!same){
            this.scheduleSyncNmos();
            this.updateCrosspoint();
        }
        return isReceiving(conn) ? "receiving" : "idle";
    }

    async loadChannelMaping(postData:any){
        let cmLoaded = false;
        for(let c of NmosRegistryConnector.controlsOf(postData)){
            // TODO: other versions
            if(c.type=="urn:x-nmos:control:cm-ctrl/v1.0"){
                try{
                    let io = await deviceRequest(deviceQueueKey(postData, c.href), {method:"get", url:c.href + "/io", timeout:10000}, {background:true});
                    let map = await deviceRequest(deviceQueueKey(postData, c.href), {method:"get", url:c.href + "/map/active", timeout:10000}, {background:true});

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



    // Pending manifest fetches keyed by sender id — collapses the burst of
    // grains a registry restart produces into one fetch per sender.
    private manifestFetchTimers: Map<string, any> = new Map();

    /** Debounced manifest fetch. Retries ONCE after 5s when the first fetch
     *  left no usable SDP (some devices publish theirs a moment after
     *  registering); a successful fetch schedules nothing. */
    scheduleManifestFetch(type:string, g:any, delay = 200, retry = true){
        let key = "";
        try{
            key = (type == "flows") ? ("" + (g?.post?.source_id ?? g?.path)) : ("" + g?.path);
        }catch(e){ key = "" + (g && g.path); }
        if(!key || key === "undefined"){ return; }

        let existing = this.manifestFetchTimers.get(key);
        if(existing){ clearTimeout(existing); }

        this.manifestFetchTimers.set(key, setTimeout(()=>{
            this.manifestFetchTimers.delete(key);
            this.getSenderManifestData(type, g);
            if(retry){
                setTimeout(()=>{
                    let sdp:any = null;
                    try{ sdp = this.nmosState["sendersManifestDetail"][key]; }catch(e){}
                    let usable = !!(sdp && Array.isArray(sdp.media) && sdp.media.length > 0);
                    if(!usable){
                        this.scheduleManifestFetch(type, g, 0, false);
                    }
                }, 5000);
            }
        }, delay));
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
                        let manifestDevice = this.nmosState.devices?.[source?.device_id];
                        deviceRequest(deviceQueueKey(manifestDevice, g.post.manifest_href), {method:"get", url:g.post.manifest_href, timeout:10000}, {background:true}).then(response => {
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
                                    // First SDP after the sender re-registered
                                    // within the removal grace: 4.44 had
                                    // dropped the cached one by then, so a
                                    // re-registration never counted as an SDP
                                    // change (a new o= line alone would
                                    // re-take every receiver of it).
                                    let until = this.reRegisteredSenders.get(senderId);
                                    let afterReRegistration = until !== undefined && Date.now() < until;
                                    if(until !== undefined && !afterReRegistration){ this.reRegisteredSenders.delete(senderId); }
                                    if(!afterReRegistration && this.nmosState["sendersManifestDetail"][senderId] && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP.length > 10 ){
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
                            NmosRegistryConnector.controlsOf(device).forEach((c:any)=>{
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
                            let response = await deviceRequest(deviceQueueKey(device, href), {method:"get", url:href, timeout:5000}, {background:true});
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
                            // `downgrade` is what the subscription was actually
                            // created with — "" when the registry refused the
                            // parameter, which is what the Setup page shows.
                            const downgrade = this.connections[c].downgrade || "";
                            if (this.connections[c].ws.readyState == WebSocket.OPEN) {
                                entry.connected.push({endpoint:e, version:this.connections[c].version, downgrade, connected:true});
                            }else{
                                entry.connected.push({endpoint:e, version:this.connections[c].version, downgrade, connected:false});
                            }
                        }
                    })
                });
            } catch (e) {}
            list.push(entry);
        });
        let dnssdEnabled = true;
        let dnssdOverride = "";
        try{
            dnssdEnabled = this.settings?.registryDiscovery?.unicastDnssd !== false;
            dnssdOverride = "" + (this.settings?.registryDiscovery?.domain || "");
        }catch(e){}
        const next = {
            registries: list,
            dnssd: { enabled: dnssdEnabled, override: dnssdOverride, domains: this.lastDnssdDomains },
            // What the operator asked for. Each subscription above reports
            // what it actually got, which differs when a registry refused it.
            queryDowngrade: this.queryDowngradeVersion
        };

        // Publish only on an actual change. This used to re-arm itself every
        // 2 s forever — recomputing and re-publishing identical data (with a
        // structuredClone per registry) even with zero clients connected.
        // Everything that can change it already calls this method directly:
        // ws open/close, registry switch, discovery results.
        let serialized = "";
        try{ serialized = JSON.stringify(next); }catch(e){ serialized = ""; }
        if(serialized && serialized === this.lastConnectionStateJson){
            return;
        }
        this.lastConnectionStateJson = serialized;
        this.syncConnectionState.setState(next);
    }
    private lastConnectionStateJson = "";


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

    // Senders an auto-activation has cleared and is switching on right now,
    // with the time of the claim. Until the device and IS-04 report them on,
    // the check could not see them, and two siblings of one take would both
    // pass on the same stream. A claim that is never released (a take that
    // hung) expires, so it can't block its stream for good.
    private pendingActivations:Map<string, number> = new Map<string, number>();
    private static readonly CLAIM_TTL_MS = 60000;

    private isPending(senderId:string):boolean{
        let since = this.pendingActivations?.get(senderId);
        if(since === undefined){ return false; }
        if(Date.now() - since > NmosRegistryConnector.CLAIM_TTL_MS){
            this.pendingActivations.delete(senderId);
            return false;
        }
        return true;
    }

    private static portOf(tp:any):number|null{
        return (typeof tp?.destination_port === "number" && tp.destination_port > 0) ? tp.destination_port : null;
    }

    // An address that names something. "auto" (never resolved), empty or
    // unspecified does not: as a destination it is no stream and collides
    // with nothing, as a source it is no interface address.
    private static isResolved(ip:any):boolean{
        return typeof ip === "string" && ip !== "" && ip !== "auto" && ip !== "0.0.0.0" && ip !== "::";
    }

    /**
     * The legs of `senderId` that will transmit once it is switched on, with
     * their stream (group + port). Activation switches every leg on, so its
     * rtp_enabled does not count — only an interface binding and a source
     * address do. Should that leave nothing (bindings and addresses that
     * contradict each other), the bound legs are checked rather than none.
     */
    private legsToClaim(senderId:string):Array<{ index:number, ip:string, port:number|null }>{
        let active:any = (this.nmosState as any).senderActiveData?.[senderId];
        if(!active || !Array.isArray(active.transport_params)){ return []; }
        let sender = this.nmosState.senders[senderId];
        let candidates: Array<{ index:number, ip:string, port:number|null }> = [];
        active.transport_params.forEach((tp:any, index:number)=>{
            if(tp && NmosRegistryConnector.isResolved(tp.destination_ip)){
                candidates.push({ index, ip: tp.destination_ip, port: NmosRegistryConnector.portOf(tp) });
            }
        });
        let silent = NmosRegistryConnector.silentSenderLegs(sender, { ...active, master_enable: false }, active.transport_params.length).map((l) => l.index);
        let legs = candidates.filter((l) => !silent.includes(l.index));
        if(legs.length === 0){
            let bindings = (sender && Array.isArray(sender.interface_bindings)) ? sender.interface_bindings : [];
            legs = candidates.filter((l) => bindings.length === 0 || l.index < bindings.length);
        }
        return legs;
    }

    /**
     * The leg indices a sender that is being switched on right now counts
     * with. Its snapshot is from before the activation, so its legs are only
     * certain where it already shows a source address. A device that resolves
     * its addresses only once on shows none at all; then only its first leg
     * counts — the one every sender transmits on — and not a second leg that
     * may well stay unused on the factory default group its siblings share.
     */
    private pendingLegIndices(sender:any, active:any):number[]{
        let tps:any[] = Array.isArray(active?.transport_params) ? active.transport_params : [];
        let bindings = (sender && Array.isArray(sender.interface_bindings)) ? sender.interface_bindings : [];
        let bound = (i:number) => bindings.length === 0 || i < bindings.length;
        let withAddress = tps.map((tp:any, i:number) => i).filter((i) => bound(i) && NmosRegistryConnector.isResolved(tps[i]?.source_ip));
        return withAddress.length > 0 ? withAddress : (tps.length > 0 ? [0] : []);
    }

    /**
     * Find whether the given sender's streams collide with any *other* sender
     * that is on the wire, on the same leg index. Returns null if there's no
     * conflict, otherwise returns the offending sender's label, id, the
     * conflicting leg index, the multicast IP and the port.
     *
     * Same-sender legs do NOT conflict with each other (primary/secondary
     * failover is allowed to use the same multicast). Cross-leg comparison
     * is also allowed — only leg 0 of one sender vs leg 0 of another etc.
     *
     * A stream is a multicast group AND a UDP port: receivers that join one
     * group tell its streams apart by port, so a device may well put the
     * video, audio and ANC of one channel on one group. Comparing the
     * address alone made every such sibling essence of an already running
     * channel a "conflict", and auto-activate refused it. Where a port is
     * unknown, the address alone decides. "auto" or an unspecified address
     * is no stream at all.
     *
     * A leg that transmits nothing collides with nothing — on either side
     * (silentSenderLegs): no interface bound for it, no source address while
     * another leg has one, or, on a running sender, rtp_enabled off. Unused
     * legs often keep a factory default group that every unit of a model
     * shares (239.255.66.113 on each Blackmagic audio sender's second leg).
     *
     * On the wire: a sender another auto-activation is switching on right
     * now (pendingLegIndices); otherwise the device's own IS-05
     * master_enable when it was read just now (`fresh`), else IS-04's
     * subscription.active — a cached snapshot the device could not confirm
     * does not outrank the registry. Pre-v1.2 senders have no subscription;
     * for them the snapshot is all there is.
     *
     * claimActivation re-reads the devices and passes `fresh`.
     */
    findMulticastConflict(senderId:string, fresh?:Set<string>): { id:string, label:string, leg:number, multicast:string, port:number|null } | null {
        try{
            let ourLegs = this.legsToClaim(senderId);
            if(ourLegs.length === 0){
                return null;
            }
            for(let otherId in this.nmosState.senders){
                if(otherId === senderId){ continue; }
                let other = this.nmosState.senders[otherId];
                let otherActive:any = (this.nmosState as any).senderActiveData?.[otherId];
                if(!other || !otherActive || !Array.isArray(otherActive.transport_params)){
                    continue;
                }
                let pending = this.isPending(otherId);
                let is04:boolean|null = other.subscription ? !!other.subscription.active : null;
                let is05:boolean|null = (typeof otherActive.master_enable === "boolean") ? otherActive.master_enable : null;
                let onAir = pending
                    || ((fresh && fresh.has(otherId) && is05 !== null) ? is05
                    : (is04 !== null) ? is04
                    : is05 === true);
                if(!onAir){
                    continue;
                }
                let otherCounts:number[];
                if(pending){
                    otherCounts = this.pendingLegIndices(other, otherActive);
                }else{
                    let silent = NmosRegistryConnector.silentSenderLegs(other, otherActive, otherActive.transport_params.length).map((l) => l.index);
                    otherCounts = otherActive.transport_params.map((tp:any, i:number) => i).filter((i:number) => !silent.includes(i));
                }
                for(let leg of ourLegs){
                    if(!otherCounts.includes(leg.index)){ continue; }
                    let tp = otherActive.transport_params[leg.index];
                    if(!tp || !NmosRegistryConnector.isResolved(tp.destination_ip) || tp.destination_ip !== leg.ip){
                        continue;
                    }
                    // Different ports on one group are two streams. Only
                    // where a port is unknown does the address alone decide.
                    let otherPort = NmosRegistryConnector.portOf(tp);
                    if(leg.port !== null && otherPort !== null && leg.port !== otherPort){
                        continue;
                    }
                    let label = other.label || otherId;
                    // Add device label as prefix for context
                    try{
                        let dev = this.nmosState.devices[other.device_id];
                        if(dev && dev.label){
                            label = dev.label + " / " + label;
                        }
                    }catch(e){}
                    // Devices that give every sender the device's name (as
                    // Blackmagic does) only tell them apart in the
                    // description — "…: Audio" — or else by the format.
                    if(typeof other.description === "string" && other.description && !label.includes(other.description)){
                        label += " (" + other.description + ")";
                    }else{
                        let format = "" + (this.nmosState.flows?.[other.flow_id]?.format || "");
                        if(format){ label += " (" + format.split(":").pop() + ")"; }
                    }
                    return { id: otherId, label, leg: leg.index, multicast: leg.ip, port: leg.port ?? otherPort };
                }
            }
        }catch(e){}
        return null;
    }

    /**
     * The check before an auto-activation, on the devices' current state,
     * and the claim that makes it hold until the sender is on.
     *
     * The snapshots only move with IS-04 events, and a change made on the
     * device itself (a multicast, a leg or the whole sender switched off)
     * need not produce one. So our sender is re-read, and so is every sender
     * with one of our streams on the same leg — BEFORE any exemption (silent
     * leg, switched off) is judged, so none of them rests on a stale cache,
     * in either direction. A device that does not answer keeps
     * its cached snapshot, and then the registry decides whether it is on.
     *
     * When nothing collides, the sender is marked as being switched on in
     * the same synchronous step as the check, so a sibling checked a moment
     * later in the same take sees it. The caller must releaseActivation()
     * once the activation is through, successful or not; a claim that is
     * never released expires after CLAIM_TTL_MS.
     */
    async claimActivation(senderId:string): Promise<ReturnType<NmosRegistryConnector["findMulticastConflict"]>> {
        let fresh = new Set<string>();
        let readOne = async (id:string) => {
            try{
                let s = this.nmosState.senders[id];
                if(s){ await this.readSenderActive(id, this.nmosState.devices[s.device_id], fresh); }
            }catch(e){}
        };
        await readOne(senderId);
        let ours = this.legsToClaim(senderId);
        let sharing:string[] = [];
        for(let otherId in this.nmosState.senders){
            if(otherId === senderId){ continue; }
            let tps = (this.nmosState as any).senderActiveData?.[otherId]?.transport_params;
            if(!Array.isArray(tps)){ continue; }
            // Same group, and the same port where both are known: a factory
            // default group many units share must not cost a request per
            // unit on every activation. (A port changed on the device itself
            // without an IS-04 event is the one thing this does not see.)
            if(ours.some((l) => {
                let tp = tps[l.index];
                if(!tp || tp.destination_ip !== l.ip){ return false; }
                let port = NmosRegistryConnector.portOf(tp);
                return l.port === null || port === null || port === l.port;
            })){
                sharing.push(otherId);
            }
        }
        await Promise.all(sharing.map(readOne));
        let conflict = this.findMulticastConflict(senderId, fresh);
        if(!conflict){
            this.pendingActivations.set(senderId, Date.now());
        }
        return conflict;
    }

    /**
     * End of a claim. The sender's snapshot is re-read first, so that from
     * here on its own IS-05 says it is on even where IS-04 lags behind; only
     * then does the claim go. The take need not wait for it.
     */
    async releaseActivation(senderId:string):Promise<void>{
        try{
            let s = this.nmosState.senders[senderId];
            if(s){ await this.readSenderActive(senderId, this.nmosState.devices[s.device_id]); }
        }catch(e){}
        this.pendingActivations.delete(senderId);
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
                // Bounded: an auto-activation holds its claim until this
                // returns, and a device that accepts the connection but
                // never answers must not keep it forever.
                let sdp = await deviceRequest(deviceQueueKey(device, sender.manifest_href), {method:"get", url:sender.manifest_href, timeout:10000}, {noFallback:true})
                info.manifestFile = sdp.data;
            }catch(e){
                info.error = "Can not load Manifest from sender: " + e.code + (e.code === "ESKIPPED" ? " (" + e.message + ")" : "");
                return info;
            }
        //}

        info.interfaces = NmosRegistryConnector.bindingInterfaces(sender, node);

        // Which of the SDP's legs the sender actually transmits on. Read
        // fresh, like the manifest: it is the device's state right now. With
        // "primary leg only" set the answer changes nothing, so don't ask.
        if(typeof info.manifestFile === "string" && !this.settings?.primaryLegOnly){
            let sdpLegCount = (info.manifestFile.match(/^m=/gm) || []).length;
            if(sdpLegCount > 1){
                let senderActive = await this.readSenderActive(senderId, device);
                info.silentLegs = NmosRegistryConnector.silentSenderLegs(sender, senderActive, sdpLegCount);
            }
        }

        if(sender.transport == "urn:x-nmos:transport:rtp.mcast"){
            info.transport = "rtp.mcast"
        }
        if(sender.transport == "urn:x-nmos:transport:rtp"){
            info.transport = "rtp"
        } 

        // `subscription` on a Sender only exists from IS-04 v1.2 on — a
        // sender from an older API version reports no activity state.
        info.active = !!(sender.subscription && sender.subscription.active);

        return info
    }

    async makeConnection(receiverId:string, senderInfo: CrosspointConnectionSenderInfo){
        let node = this.takeStarted(receiverId);
        try{
            return await this.makeConnectionNow(receiverId, senderInfo);
        }finally{
            this.takeEnded(node);
            this.receiverTaken(receiverId);
        }
    }

    private async makeConnectionNow(receiverId:string, senderInfo: CrosspointConnectionSenderInfo){

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

        let interfaces = NmosRegistryConnector.bindingInterfaces(receiver, node);

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

        // Legs the sender lists but does not transmit on stay off on the
        // receiver. Never every leg: if nothing would be left, the sender's
        // statements contradict its own SDP, and the SDP decides as before.
        let primaryLegOnly = !!this.settings?.primaryLegOnly;
        let silentLegs = (senderInfo.silentLegs || []).filter((l) => l.index < sdpLegs.length && sdpLegs[l.index].multicast_ip);
        if(primaryLegOnly){
            // Setup says the plant runs on the primary leg only: every leg
            // after the first stays off whatever the sender says about it,
            // and the primary is never the one switched off.
            silentLegs = sdpLegs.map((l, i) => i).filter((i) => i > 0 && sdpLegs[i].multicast_ip)
                .map((i) => ({ index:i, reason:"\"Primary leg only\" is on in Setup" }));
        }
        let liveLegs = sdpLegs.map((l, i) => i).filter((i) => sdpLegs[i].multicast_ip && !silentLegs.some((l) => l.index === i));
        if(liveLegs.length === 0){
            silentLegs = [];
        }
        if(silentLegs.length > 0){
            // Under the switch this is every take, and expected — keep it
            // out of the default log view.
            SyncLog.log(primaryLegOnly ? "verbose" : "info", "NMOS Connect", "Receiver " + receiverId + ": " +
                silentLegs.map((l) => "leg " + (l.index + 1) + " of the sender's SDP left off (" + l.reason + ")").join("; ") +
                (primaryLegOnly ? " — the receiver joins the primary leg only." : " — the receiver joins only the leg(s) the sender transmits."));
        }

        // The IS-05 control endpoints of the receiver's device. Resolved here
        // rather than just before the PATCH because the number of legs has to
        // be read from the device before transport_params can be built.
        let versionFound = false;
        let controlHrefs = [];
        let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

        for(let type of controlTypes){
            NmosRegistryConnector.controlsOf(device).forEach((control)=>{
                if(control.type == type.type){
                    controlHrefs.push({href:control.href, version:type.version});
                    versionFound = true;
                }
            })
            if(versionFound){
                break;
            }
        }

        // transport_params is positional and its length is part of the
        // contract: IS-05 rejects a PATCH that addresses fewer legs than the
        // receiver has. Ask the device, don't count IS-04 interface_bindings
        // — a device may expose a leg it never bound to an interface, and
        // then the two disagree and every take fails with "Invalid
        // parameter".
        let receiverActive = await this.getReceiverActive(receiverId, controlHrefs, device);
        let receiverLegCount = NmosRegistryConnector.legCountFromActive(receiverActive, receiver);
        if(!receiverActive){
            SyncLog.log("warning", "NMOS Connect", "Could not read the IS-05 active parameters of receiver " + receiverId +
                " — addressing " + receiverLegCount + " leg(s) from its IS-04 interface_bindings instead.");
        }
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
                if(i < sdpLegs.length && sdpLegs[i].multicast_ip && !silentLegs.some((l) => l.index === i)){
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

            // The file loses the legs left off as well, so that it describes
            // the same stream as transport_params — a receiver may read the
            // redundancy pairing from the file's DUP group. Only legs behind
            // every live one: the receiver maps the file's streams onto its
            // legs by position, and a gap at the front would shift them.
            let trailingSilent = silentLegs.map((l) => l.index).filter((i) => i > Math.max(...liveLegs));
            if(manifest && trailingSilent.length > 0){
                manifest = NmosRegistryConnector.dropSdpMedia(manifest, trailingSilent);
            }

            // An empty manifest is not a transport file, it is a PATCH the
            // device has every right to reject.
            if(manifest && !this.refusesTransportFile(controlHrefs)){
                patch.transport_file = {
                    type: "application/sdp",
                    data: manifest,
                };
            }
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

        // A receiver given no transport file runs the format set on the
        // device itself, whatever the sender sends. Say so when they differ:
        // the picture just stays black and nothing else reports it.
        let patched = (sent:any, result:any, patchHref:string, controlHref:string) => {
            if(!sent.transport_file && senderInfo.senderId != "disconnect" && senderInfo.manifestFile){
                this.checkReceiverFormat(receiverId, controlHref, device, senderInfo.manifestFile, senderInfo.senderId);
            }
            // The device's own answer goes into the log line: what it
            // staged is the only way to see which of our parameters it
            // took, silently changed or ignored.
            return SyncLog.log("success", "nmos_connect", "Successfully patched: "+receiverId, {href:patchHref, data:sent, status:result?.status, response:result?.data});
        };

        // /active already showed what this PATCH asks for (the same route
        // taken again). Reading it back after an unanswered PATCH then proves
        // nothing about a transport file that may have changed.
        let showedBefore = !!receiverActive && NmosRegistryConnector.activeShowsPatch(receiverActive, patch);
        let notSent:string[] = [];

        for(let href of controlHrefs){
            // TODO, version specific things
            let fixSlash = ""
            if(href.href[href.href.length-1] == "/"){
                fixSlash = ""
            }else{
                fixSlash = "/"
            }
            let patchHref = href.href + fixSlash + "single/receivers/" + receiverId + "/staged"
            let activeHref = href.href + fixSlash + "single/receivers/" + receiverId + "/active"
            let queueKey = deviceQueueKey(device, patchHref);

            // The PATCH, the read that checks an unanswered one and the second
            // try run as one unit on the device: nothing of the device's other
            // receivers squeezes in between.
            let unit = () => withDevice(queueKey, async (send) => {
                let put = (body:any) => send({method:"patch", url:patchHref, data:body, timeout:30000});
                let readBack = async (wait:number) => {
                    await sleep(wait);
                    for(let i = 0; i < 2; i++){
                        try{
                            let r = await send({method:"get", url:activeHref, timeout:5000}, {force:true});
                            return (r && r.data && typeof r.data === "object") ? r.data : null;
                        }catch(e:any){
                            // Dropped while the device was busy with other
                            // requests: it takes one at a time now.
                            if(!e?.resend){ return null; }
                            await sleep(200);
                        }
                    }
                    return null;
                };

                // The device took the PATCH and closed the connection without
                // an answer ("socket hang up"), or did not answer in time.
                // Whether it applied it is open: a FusioN given six at once
                // dropped four and still showed all six receivers patched.
                // Ask the device what it runs before sending it again.
                let recover = async (sent:any, err:any):Promise<any> => {
                    let inconclusive = showedBefore && !!sent.transport_file;
                    let shows = (active:any) => !!active && !inconclusive && NmosRegistryConnector.activeShowsPatch(active, sent);
                    let howLost = (x:any) => x.code === "ECONNABORTED" ? "did not answer the PATCH in time" : "closed the connection without answering the PATCH";
                    let active = await readBack(300);
                    if(shows(active)){
                        SyncLog.log("warning", "nmos_connect", "Receiver " + receiverId + " " + howLost(err) + " (" +
                            err.message + "), but its /active shows the new parameters — taken as done.", {href:patchHref, data:sent});
                        return {sent, result:{status:"no answer", data:active}};
                    }
                    if(err.code === "ECONNABORTED"){
                        // 30 s without an answer. Not again: a device that
                        // hangs will hang again. Everything else queued for
                        // it is skipped instead of waiting out the same
                        // timeout: all of it when it does not answer the read
                        // either, its PATCHes when it still answers reads.
                        if(!active){
                            markUnresponsive(queueKey, "left a PATCH and the /active read after it unanswered");
                        }else{
                            markUnresponsive(queueKey, "left a PATCH unanswered and did not apply it", true);
                        }
                    }else{
                        try{
                            let result = await put(sent);
                            SyncLog.log("info", "nmos_connect", "Receiver " + receiverId + " closed the connection without answering the first PATCH (" +
                                err.message + ") — the second one went through.");
                            return {sent, result};
                        }catch(e2:any){
                            if(e2?.response){
                                return {error:e2};
                            }
                            if(e2?.resend){
                                // Refused while the device was busy: once
                                // more, in line with the rest.
                                return {next:e2};
                            }
                            err = e2;
                            if(noAnswer(e2)){
                                active = await readBack(1000);
                                if(shows(active)){
                                    SyncLog.log("warning", "nmos_connect", "Receiver " + receiverId + " answered neither PATCH (" + e2.message +
                                        "), but its /active shows the new parameters — taken as done.", {href:patchHref, data:sent});
                                    return {sent, result:{status:"no answer", data:active}};
                                }
                            }
                        }
                    }
                    let why = !active ? "its /active could not be read" :
                              inconclusive ? "its /active showed these parameters already before, so it cannot tell whether the PATCH landed" :
                              "its /active does not show the new parameters";
                    let id = SyncLog.log("error", "nmos_connect", "Receiver " + receiverId + " did not answer the PATCH (" + err.message + ") and " + why + ".",
                        {controlHrefs, failedControl:patchHref, patch:sent, code:err.code, message:err.message, active:active ?? undefined});
                    throw new LoggedError("Receiver did not answer: " + err.message, id);
                };

                try{
                    return {sent:patch, result:await put(patch)};
                }catch(first){
                    let e:any = first;
                    if(!axios.isAxiosError(e)){
                        throw new LoggedError("Patch Failed: " + e?.message);
                    }
                    if(neverConnected(e)){
                        // Never reached the device — its next control address
                        // may still answer.
                        return {next:e};
                    }
                    if(noAnswer(e)){
                        let r = await recover(patch, e);
                        if(!r.error){
                            return r;
                        }
                        e = r.error;
                    }
                    // A receiver that will not take a transport file at all
                    // rejects the whole PATCH over it. Everything the join
                    // needs — multicast address, port, SSM source, per leg —
                    // already rides in transport_params, so try again
                    // without the file before giving up. Only a success
                    // proves the file was the problem; anything else falls
                    // through to the original rejection below.
                    if(e.response?.status === 400 && patch.transport_file){
                        let retry:any = { ...patch };
                        delete retry.transport_file;
                        let refused = () => {
                            this.transportFileUnsupported.add(href.href);
                            SyncLog.log("warning", "nmos_connect", "Receiver " + receiverId + " refuses a transport file on its IS-05 " +
                                href.version + " endpoint — patched without it. The stream parameters are carried by transport_params; " +
                                "the device has to know the media format by itself. Every receiver behind " + href.href +
                                " now leaves the file out from the start.", {href:patchHref, status:e.response?.status, error:e.response?.data});
                        };
                        try{
                            let result = await put(retry);
                            refused();
                            return {sent:retry, result};
                        }catch(e2:any){
                            let answer = e2;
                            if(e2?.resend){
                                return {next:e2};
                            }
                            if(noAnswer(e2)){
                                let r = await recover(retry, e2);
                                if(r.next){
                                    return r;
                                }
                                if(!r.error){
                                    refused();
                                    return r;
                                }
                                answer = r.error;
                            }
                            // Not the transport file then. Say so with the
                            // device's answer — without this line the retry
                            // is invisible and the log looks as if it never
                            // happened, which is exactly the wrong hint
                            // when the real cause is somewhere else.
                            SyncLog.log("warning", "nmos_connect", "Receiver " + receiverId +
                                " rejected the PATCH without the transport file as well — the file is not the problem here.",
                                { href: patchHref, data: retry, status: answer?.response?.status, error: answer?.response?.data,
                                  message: answer?.message });
                        }
                    }
                    // TODO....
                    if(e.code == "ERR_BAD_REQUEST"){
                        let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data,});
                        throw new LoggedError("Patch failed: "+(e.response?.data?.error ?? e.response?.data) + " / " +e.response?.data?.debug , id);
                    }
                    let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data, message:e.message});
                    throw new LoggedError("Receiver returned Error: "+e.code, id);
                }
            });

            let outcome:any = await unit();
            if(outcome.next?.resend){
                // Refused while the device was busy with other requests. It
                // takes one at a time now: once more, in line with the rest.
                outcome = await unit();
            }
            if(outcome.next){
                SyncLog.log("info", "nmos_connect", "Patch on " + patchHref + " not sent (" + outcome.next.message + "), trying next.");
                notSent.push(href.href + ": " + outcome.next.message);
                continue;
            }
            return patched(outcome.sent, outcome.result, patchHref, href.href);
        }
        let id = SyncLog.log("error", "nmos_connect", "Receiver Control unreachable." + (notSent.length ? " " + notSent.join("; ") : ""), {controlHrefs, patch});
        throw new LoggedError("Receiver Control unreachable." + (notSent.length ? " " + notSent.join("; ") : ""), id);
    }



    /** A receiver's IS-05 /active, read on one control address. */
    private async readReceiverActiveAt(receiverId:string, controlHref:string, device:any, background = false):Promise<any|null>{
        let href = controlHref;
        if(href[href.length-1] !== "/"){ href += "/"; }
        href += "single/receivers/" + receiverId + "/active";
        try{
            const response = await deviceRequest(deviceQueueKey(device, href), {method:"get", url:href, timeout:5000}, {background});
            return (response && response.data && typeof response.data === "object") ? response.data : null;
        }catch(e){
            return null;
        }
    }

    /**
     * Whether a receiver's /active already holds what a connect or
     * disconnect PATCH asked for: the sender, master_enable and, per leg,
     * on/off and the stream it joins. Only what the PATCH set is compared.
     */
    static activeShowsPatch(active:any, patch:any):boolean{
        if(!active || !patch){ return false; }
        if(patch.master_enable !== undefined && active.master_enable !== patch.master_enable){ return false; }
        if(patch.sender_id !== undefined && patch.sender_id !== null && active.sender_id !== patch.sender_id){ return false; }
        let legs:any[] = Array.isArray(patch.transport_params) ? patch.transport_params : [];
        let have:any[] = Array.isArray(active.transport_params) ? active.transport_params : [];
        for(let i = 0; i < legs.length; i++){
            let want = legs[i] || {};
            let leg = have[i];
            if(!leg){ return false; }
            if(want.rtp_enabled !== undefined && leg.rtp_enabled !== want.rtp_enabled){ return false; }
            for(let key of ["multicast_ip", "destination_port", "source_ip"]){
                if(want[key] !== undefined && want[key] !== null && String(leg[key]) !== String(want[key])){ return false; }
            }
        }
        return true;
    }

    /**
     * The video format an SDP describes, named the way a monitor shows it
     * ("1920x1080p50", "1920x1080i59.94" — interlaced by field rate), from
     * its first fmtp line; null for anything without width, height and
     * frame rate.
     */
    static videoFormatOf(sdp:any):string|null{
        if(typeof sdp !== "string"){ return null; }
        let fmtp = sdp.match(/^a=fmtp:\S+ (.*)$/m);
        if(!fmtp){ return null; }
        let p = fmtp[1];
        let w = /(?:^|;)\s*width=(\d+)/.exec(p);
        let h = /(?:^|;)\s*height=(\d+)/.exec(p);
        let r = /(?:^|;)\s*exactframerate=(\d+(?:\.\d+)?)(?:\/(\d+))?/.exec(p);
        if(!w || !h || !r){ return null; }
        let interlaced = /(?:^|;)\s*interlace\b/.test(p);
        // PsF: progressive frames carried as two segments.
        let segmented = interlaced && /(?:^|;)\s*segmented\b/.test(p);
        let frames = Number(r[1]) / Number(r[2] || 1);
        if(segmented){
            return w[1] + "x" + h[1] + "psf" + Math.round(frames * 100) / 100;
        }
        let rate = Math.round(frames * (interlaced ? 2 : 1) * 100) / 100;
        return w[1] + "x" + h[1] + (interlaced ? "i" : "p") + rate;
    }

    private checkReceiverFormat(receiverId:string, controlHref:string, device:any, senderSdp:string, senderId:string|null){
        let wanted = NmosRegistryConnector.videoFormatOf(senderSdp);
        if(!wanted){ return; }
        // After the device has switched, not while it still runs the old stream.
        setTimeout(async () => {
            try{
                let active = await this.readReceiverActiveAt(receiverId, controlHref, device, true);
                // Taken over by another take in the meantime: not ours to judge.
                if(!active || active.master_enable === false || (senderId && active.sender_id && active.sender_id !== senderId)){ return; }
                let running = NmosRegistryConnector.videoFormatOf(active.transport_file?.data);
                if(running && running !== wanted){
                    let label = this.nmosState.receivers?.[receiverId]?.label;
                    let senderLabel = senderId ? this.nmosState.senders?.[senderId]?.label : null;
                    SyncLog.log("warning", "nmos_connect", "Receiver " + (label ? label + " (" + receiverId + ")" : receiverId) + " runs " + running +
                        " but sender " + (senderLabel || senderId || "?") + " sends " + wanted +
                        ". It does not take the format from the sender's SDP — set " + wanted + " on the device.");
                }
            }catch(e){}
        }, 3000);
    }


    async enableFlow(senderId:string, disable=false){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                NmosRegistryConnector.controlsOf(device).forEach((control)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                })
                if(versionFound){
                    break;
                }
            }

            // How many legs a PATCH has to address.
            let legCount = 1;
            try{
                // The cached IS-05 active snapshot decides, exactly as on the
                // receiver side — interface_bindings only counts the
                // interfaces the device bound and can report fewer legs than
                // the device actually exposes.
                let activeData = (this.nmosState as any).senderActiveData?.[senderId];
                legCount = NmosRegistryConnector.legCountFromActive(activeData, sender);
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


            let notSent:string[] = [];
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
                    let result = await deviceRequest(deviceQueueKey(device, patchHref), {method:"patch", url:patchHref, data:patch, timeout:30000}, {idempotent:true});
                    SyncLog.log("success", "nmos", "Successfully enabled: "+senderId, {href:patchHref, data:patch, status:result?.status, response:result?.data})
                    return;
                }catch(e){
                    if (axios.isAxiosError(e)) {
                        if(neverConnected(e)){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" not sent (" + e.message + "), trying next.");
                            notSent.push(href.href + ": " + e.message);
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
            SyncLog.log("error", "nmos", "Sender " + senderId + ": no control address took the PATCH." + (notSent.length ? " " + notSent.join("; ") : ""), {controlHrefs, patch});
        }catch(e){

        }

    }


    /**
     * Toggle a receiver's master_enable flag. Used by the Details page
     * to activate / deactivate a receiver without changing its current
     * sender subscription (sender_id and transport_file stay in place).
     */
    async enableReceiver(receiverId:string, disable=false){
        let node = this.takeStarted(receiverId);
        try{
            return await this.enableReceiverNow(receiverId, disable);
        }finally{
            this.takeEnded(node);
            this.receiverTaken(receiverId);
        }
    }

    private async enableReceiverNow(receiverId:string, disable=false){
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
                NmosRegistryConnector.controlsOf(device).forEach((control:any)=>{
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

            let notSent:string[] = [];
            for(let href of controlHrefs){
                let fixSlash = (href.href[href.href.length-1] == "/") ? "" : "/";
                let patchHref = href.href + fixSlash + "single/receivers/" + receiverId + "/staged";
                try{
                    let result = await deviceRequest(deviceQueueKey(device, patchHref), {method:"patch", url:patchHref, data:patch, timeout:30000}, {idempotent:true});
                    SyncLog.log("success", "nmos", "Successfully " + (disable?"disabled":"enabled") + " receiver: " + receiverId, {href:patchHref, data:patch, status:result?.status, response:result?.data});
                    return;
                }catch(e:any){
                    if(axios.isAxiosError(e)){
                        if(neverConnected(e)){
                            SyncLog.log("info", "nmos", "Patch on " + receiverId + " not sent (" + e.message + "), trying next.");
                            notSent.push(href.href + ": " + e.message);
                        }else{
                            let logBody:any = {controlHrefs, failedControl:patchHref, patch, status:e.response?.status};
                            if(e.response){
                                logBody.error = e.response.data;
                            }
                            if(e.code != "ERR_BAD_REQUEST"){
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
            SyncLog.log("error", "nmos", "Receiver " + receiverId + ": no control address took the PATCH." + (notSent.length ? " " + notSent.join("; ") : ""), {controlHrefs, patch});
        }catch(e){}
    }


    /** "Node - Device - TX Label" for an NMOS uuid, straight from the
     *  registry state — the fallback behind the crosspoint's own map (which
     *  knows the aliases). Covers flows and sources too, and anything that
     *  never made it into the crosspoint. Returns null for unknown ids. */
    public resourceName(id:string): string|null {
        if(!id) return null;
        try{
            let st:any = this.nmosState;
            if(!st) return null;
            let devPath = (deviceId:string):string => {
                let d = st.devices?.[deviceId];
                if(!d) return "";
                let n = st.nodes?.[d.node_id];
                return (n?.label ? n.label + " - " : "") + (d.label || d.id || "");
            };
            if(st.senders?.[id]){
                let x = st.senders[id];
                return (devPath(x.device_id) + " - TX " + (x.label || "")).trim();
            }
            if(st.receivers?.[id]){
                let x = st.receivers[id];
                return (devPath(x.device_id) + " - RX " + (x.label || "")).trim();
            }
            if(st.devices?.[id]){ return devPath(id) || null; }
            if(st.nodes?.[id]){ return st.nodes[id].label || null; }
            if(st.flows?.[id]){ return ("Flow " + (st.flows[id].label || "")).trim(); }
            if(st.sources?.[id]){ return ("Source " + (st.sources[id].label || "")).trim(); }
        }catch(e){}
        return null;
    }

    async setFlowMulticast(senderId:string, data:any){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                NmosRegistryConnector.controlsOf(device).forEach((control)=>{
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
                // The cached IS-05 active snapshot decides, exactly as on the
                // receiver side — interface_bindings only counts the
                // interfaces the device bound and can report fewer legs than
                // the device actually exposes.
                let activeData = (this.nmosState as any).senderActiveData?.[senderId];
                legCount = NmosRegistryConnector.legCountFromActive(activeData, sender);
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

            // transport_params is positional, so a PATCH that touches leg 0
            // must still carry an entry for leg 1. An empty object is legal
            // IS-05 ("leave this leg as it is"), but several devices choke on
            // it — they either reject the PATCH or wipe the leg. Send the
            // leg's CURRENT active parameters instead: same meaning, spelled
            // out in the device's own vocabulary. Only where no active
            // snapshot exists do we fall back to {}.
            let activeParams:any[] = [];
            try{
                let active:any = (this.nmosState as any).senderActiveData?.[senderId];
                if(active && Array.isArray(active.transport_params)){
                    activeParams = active.transport_params;
                }
            }catch(e){}

            let transportParams:any[] = [];
            let legsWithoutSnapshot = 0;
            for(let i=0;i<legCount;i++){
                let cur = activeParams[i];
                if(cur && typeof cur === "object" && !Array.isArray(cur)){
                    // Drop empty values while copying: an inactive sender can
                    // report destination_ip "" / null, and echoing that back
                    // is exactly the kind of thing a device rejects.
                    // source_ip is dropped as well: which local address a
                    // sender transmits from is the device's business — it maps
                    // each leg to its own interface_binding. We read it (the
                    // details page shows it), we never write it, not even by
                    // echoing the device's own value back at it.
                    let copy:any = {};
                    for(let k of Object.keys(cur)){
                        if(k === "source_ip"){ continue; }
                        let v = (cur as any)[k];
                        if(v === null || v === undefined || v === ""){ continue; }
                        copy[k] = v;
                    }
                    if(Object.keys(copy).length > 0){
                        transportParams.push(copy);
                    }else{
                        transportParams.push({});
                        legsWithoutSnapshot++;
                    }
                }else{
                    transportParams.push({});
                    legsWithoutSnapshot++;
                }
            }
            if(legsWithoutSnapshot > 0){
                SyncLog.log("verbose", "nmos", "setFlowMulticast " + senderId + ": " + legsWithoutSnapshot +
                    " of " + legCount + " leg(s) have no IS-05 active snapshot — sending an empty object for those.");
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

            // A touched leg always carries the COMPLETE destination pair, even
            // when the caller only changed one half. IS-05 says a missing
            // field means "leave it as it is", but several devices treat a
            // transport_params object as the whole truth and reset the field
            // that is not in it — a new multicast then arrives with the port
            // back at the device default. Whatever the caller does not set is
            // filled from the leg's own IS-05 ACTIVE values, so the PATCH
            // states what the device already has instead of staying silent.
            let meaningfulChange = false;
            let incompleteLegs:number[] = [];
            data.legs.forEach((l)=>{
                if(typeof l.index !== "number" || l.index < 0 || l.index >= legCount){
                    return;
                }
                // The leg's current parameters (copied from the active
                // snapshot above, empty values already dropped).
                let cur:any = transportParams[l.index] || {};
                // No source_ip here either — we used to send "auto", which is
                // still an instruction about the sender's own interface.
                let leg:any = {};
                if(l.multicast !== undefined && l.multicast !== null && l.multicast !== ""){
                    leg.destination_ip = l.multicast;
                    meaningfulChange = true;
                }else if(typeof cur.destination_ip === "string" && cur.destination_ip !== ""){
                    leg.destination_ip = cur.destination_ip;
                }
                if(l.port !== undefined && l.port !== null && l.port !== ""){
                    let p = parseInt(""+l.port);
                    if(!isNaN(p) && p > 0 && p < 65536){
                        leg.destination_port = p;
                        meaningfulChange = true;
                    }
                }
                if(leg.destination_port === undefined && typeof cur.destination_port === "number" && cur.destination_port > 0){
                    leg.destination_port = cur.destination_port;
                }
                // Only reachable when the device never gave us an active
                // snapshot for this leg — we cannot invent the missing half.
                if(leg.destination_ip === undefined || leg.destination_port === undefined){
                    incompleteLegs.push(l.index);
                }
                patch.transport_params[l.index] = leg;
            });
            if(incompleteLegs.length > 0){
                SyncLog.log("warn", "nmos", "setFlowMulticast " + senderId + ": leg(s) " + incompleteLegs.join(", ") +
                    " go out without the full destination_ip/destination_port pair — no IS-05 active snapshot to complete them from.");
            }

            // Last-line-of-defence: never send a PATCH that changes nothing.
            // Such a no-op causes the reconcile loop to fire forever because
            // nothing on the device changes.
            if(!meaningfulChange){
                SyncLog.log("warn", "nmos", "Refusing to send empty setFlowMulticast PATCH for " + senderId + " (no destination_ip / destination_port).");
                return;
            }

            

            let notSent:string[] = [];
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
                    let result = await deviceRequest(deviceQueueKey(device, patchHref), {method:"patch", url:patchHref, data:patch, timeout:30000}, {idempotent:true});
                    SyncLog.log("success", "nmos", "Successfully set multicast: "+senderId, {href:patchHref, data:patch, status:result?.status, response:result?.data});


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
                    // (false when missing). The caller can force the reconnect by
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
                        if(neverConnected(e)){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" not sent (" + e.message + "), trying next.");
                            notSent.push(href.href + ": " + e.message);
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, status:e.response?.status, error:e.response?.data, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
            SyncLog.log("error", "nmos", "Sender " + senderId + ": no control address took the PATCH." + (notSent.length ? " " + notSent.join("; ") : ""), {controlHrefs, patch});
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
                            let response = await deviceRequest(deviceQueueKey(device, href), {method:"get", url:href, timeout:5000}, {background:true});
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



