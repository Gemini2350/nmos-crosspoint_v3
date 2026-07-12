import { SyncObject } from "./SyncServer/syncObject";
import { LoggedError, SyncLog } from "./syncLog";
import { error } from "console";
import { NmosRegistryConnector } from "./nmosConnector";
import { MulticastLeaseManager } from "./multicastLeaseManager";
import { DdnsService } from "./ddnsService";
import { Bcp008Monitor } from "./bcp008Monitor";

import { setTimeout as sleep } from 'node:timers/promises'


const { Worker } = require('worker_threads');

const crypto = require('crypto');


const fs = require("fs");
const md5 = data => crypto.createHash('md5').update(data).digest("hex")

 export class CrosspointAbstraction {
    public static instance: CrosspointAbstraction | null;

    public syncCrosspoint: SyncObject;
    crosspointState: CrosspointState = {devices:[]};

    worker;

    startWorker(){
        SyncLog.info("crosspoint", "Starting Worker thread.");
        this.worker = new Worker(__dirname + '/crosspointUpdateThread.js');
        this.worker.on('message', (message)=>{
            // Hot-path messages (full crosspointState every tick) are posted
            // as plain objects and arrive via the worker's built-in
            // structured clone — no JSON round-trip. Legacy string messages
            // (small command acks) are still parsed for compatibility.
            let data = (typeof message === "string") ? JSON.parse(message) : message;
            this.updateReturn(data);
        });
        this.worker.on('error', (error)=>{
            SyncLog.error("crosspoint", "Error in Worker Thread: "+ error.message, error);
            // TODO crash on remote system "Error in Worker Thread: Cannot read properties of null (reading 'devices')" Analyze
        });

        this.worker.on('exit', (code)=>{
            if(code == 0){
                SyncLog.info("crosspoint", "Worker Thread exit with code: "+ code);
            }else{
                SyncLog.error("crosspoint", "Worker Thread exit with code: "+ code);
                setTimeout(()=>{this.startWorker()},1000);
            }
        });
    }
    settings:any = {};
    constructor(config:any){
        this.settings = config;
        // Seed the virtual-sender list from settings so the very first
        // worker tick already publishes the virtual device.
        try{
            if(Array.isArray(config?.virtualSenders)){
                this.virtualSenders = config.virtualSenders;
            }
        }catch(e){}

        this.startWorker();




        if(CrosspointAbstraction.instance == null){
            CrosspointAbstraction.instance = this;
        }

        // BCP-008 status monitoring (IS-12 client). A status change touches
        // ONLY enrichment-time fields (flow.monitor / device summaries) —
        // the NMOS state and the worker-built shadow are unchanged, so we
        // skip the full worker round-trip and just re-enrich + publish.
        new Bcp008Monitor();
        Bcp008Monitor.instance.onChange = () => { try{ this.republishEnriched(); }catch(e){} };
        try{ Bcp008Monitor.instance.setEnabled(this.settings?.bcp008?.enabled !== false); }catch(e){}

        this.syncCrosspoint = new SyncObject("crosspoint", this.crosspointState);
        this.update();
    }

    nmosState : any = null;
    // Operator-defined virtual senders (id / name / sdp). Pushed into the
    // worker thread alongside the NMOS state so the worker can build the
    // synthetic "Virtual Device" entry.
    virtualSenders:any[] = [];
    public setVirtualSenders(list:any[]){
        this.virtualSenders = Array.isArray(list) ? list : [];
        this.update();
    }

    // Notified when the virtual-sender LIST changed via an alias rename
    // (so server.ts can refresh setupConfigSync and the Setup page name
    // updates without the operator having to reload).
    public onVirtualSendersChange:(()=>void)|null = null;

    getFlowInfo(flowId:string){
        try{
            let manifest:any = null;
            if(flowId.startsWith("nmos_")){
                let id = flowId.slice(5);
                manifest = this.nmosState.sendersManifestDetail[id];
            }
            for(let dev of this.crosspointState.devices){
                for(let type of Object.keys(dev.senders)){
                    for( let flow of dev.senders[type]){
                        if(flow.id == flowId){
                            return {
                                flow: flow,
                                manifest: manifest
                            };
                        }
                    }
                }
            }
        }catch(e){}
        return null;
    }


    enableFlow(id:string, disable=false){
        return new Promise((resolve, reject) => {
            if(id.startsWith("nmos_")){
                let nmosId = id.slice(5);
                NmosRegistryConnector.instance.enableFlow(nmosId,disable);
            }
            resolve({});
        });
    }

    enableReceiver(id:string, disable=false){
        return new Promise((resolve, reject) => {
            if(id.startsWith("nmos_")){
                let nmosId = id.slice(5);
                NmosRegistryConnector.instance.enableReceiver(nmosId, disable);
            }
            resolve({});
        });
    }

    setMulticast(id:string, data:any){
        return new Promise((resolve, reject) => {
            if(id.startsWith("nmos_")){
                let nmosId = id.slice(5);

                // 1) Update the Lease Manager first so it knows about the
                //    manual override (or about an explicit "clear → reset").
                // 2) Then rewrite each leg's multicast field to the effective
                //    address so the actual PATCH always carries a destination.
                try{
                    // Only touch the Multicast Lease Manager when DHCP is ON.
                    // With DHCP off the user's typed IP must pass straight
                    // through to the device — substituting a reserved pool
                    // address would be a silent rewrite the user never asked
                    // for. Stale leases from a previous on-period stay in
                    // memory for inspection but no longer influence PATCHes.
                    if(MulticastLeaseManager.instance && MulticastLeaseManager.instance.isEnabled() && Array.isArray(data?.legs)){
                        let mgr = MulticastLeaseManager.instance;
                        data.legs.forEach((l:any) => {
                            if(typeof l.index !== "number") return;
                            const hasIpField = (typeof l.multicast === "string");
                            const rawIp = hasIpField ? l.multicast.trim() : undefined;
                            const port = (typeof l.port === "number" && l.port > 0) ? l.port : undefined;

                            // Update lease: pass undefined when caller didn't
                            // touch the IP, empty string for an explicit clear,
                            // or the typed IP for a new override.
                            mgr.recordManualEdit(nmosId, l.index, rawIp, port);

                            // Substitute leg.multicast with the now-effective IP
                            // so setFlowMulticast always has something to patch.
                            const eff = mgr.getEffectiveIp(nmosId, l.index);
                            if(eff){
                                l.multicast = eff;
                            }
                        });
                    }
                }catch(e){}

                NmosRegistryConnector.instance.setFlowMulticast(nmosId,data);
            }
            resolve({});
        });
    }

    
    crosspointApi(data:any){
        return new Promise((resolve, reject) => {
            // Intercept device-delete here so the Multicast Lease Manager can
            // release the freed senders' pairs back into the pool. The worker
            // thread doesn't have direct access to the lease manager singleton,
            // so we do it on the main thread before forwarding the command.
            try{
                if(data && data.action === "delete" && data.devId && !data.flowId){
                    let dev = this.crosspointState.devices.find((d:any) => d.id === data.devId);
                    if(dev){
                        let senderIds:string[] = [];
                        for(let type of Object.keys(dev.senders || {})){
                            (dev.senders[type] || []).forEach((s:any)=>{
                                if(s && s.id){ senderIds.push(s.id.startsWith("nmos_") ? s.id.slice(5) : s.id); }
                            });
                        }
                        if(senderIds.length > 0 && MulticastLeaseManager.instance){
                            MulticastLeaseManager.instance.releaseLeases(senderIds);
                        }

                        // DNS Push: also drop the DNS entry for the node that
                        // backs this device. Only valid for nmos_<deviceId>
                        // groups (grouphint-derived devices don't map 1:1 to a
                        // single node).
                        try{
                            if(DdnsService.instance && typeof dev.id === "string" && dev.id.startsWith("nmos_")){
                                let nmosDevId = dev.id.slice(5);
                                let nmosDev:any = this.nmosState?.devices?.[nmosDevId];
                                if(nmosDev && nmosDev.node_id){
                                    DdnsService.instance.removeNode(nmosDev.node_id).catch(()=>{});
                                }
                            }
                        }catch(e:any){
                            SyncLog.log("warn", "DNS Push", "Could not remove DNS entry on delete: " + e.message);
                        }
                    }
                }

                // Single sender/receiver delete: release its multicast lease
                // (sender only — receivers don't own a lease). The worker
                // thread does the actual removal from the crosspoint shadow.
                if(data && data.action === "delete" && data.devId && data.flowId){
                    try{
                        let dev = this.crosspointState.devices.find((d:any) => d.id === data.devId);
                        if(dev){
                            let isSender = false;
                            for(let type of Object.keys(dev.senders || {})){
                                if((dev.senders[type] || []).find((s:any) => s && s.id === data.flowId)){
                                    isSender = true; break;
                                }
                            }
                            if(isSender && MulticastLeaseManager.instance){
                                let nmosId = (typeof data.flowId === "string" && data.flowId.startsWith("nmos_"))
                                    ? data.flowId.slice(5) : data.flowId;
                                MulticastLeaseManager.instance.releaseLeases([nmosId]);
                            }
                        }
                    }catch(e:any){
                        SyncLog.log("warn", "Multicast Lease", "Could not release lease on sender delete: " + e.message);
                    }
                }
            }catch(e:any){
                SyncLog.log("warn", "Multicast Lease", "Could not release leases on delete: " + e.message);
            }

            this.worker.postMessage(JSON.stringify({
                crosspointChanges:data
            }));
            // TODO feedback.....
            resolve({});
        });
    }


    // Operator-set display names for whole NMOS nodes (the node band /
    // group header in the UI). Kept here — not in the worker — because the
    // node label is an enrichment-time concept. Persisted across restarts.
    private nodeAliases: { [nodeId:string]: string } = (() => {
        try{
            const fs = require("fs");
            let parsed = JSON.parse(fs.readFileSync("./state/nodeAliases.json"));
            if(parsed && typeof parsed === "object" && !Array.isArray(parsed)){ return parsed; }
        }catch(e){}
        return {};
    })();
    private persistNodeAliases(){
        try{
            const fs = require("fs");
            fs.writeFileSync("./state/nodeAliases.json", JSON.stringify(this.nodeAliases, null, 4));
        }catch(e:any){
            SyncLog.log("warn", "Crosspoint", "Could not persist node aliases: " + (e?.message || e));
        }
    }

    changeNodeAlias(nodeId:string, alias:string){
        return new Promise((resolve) => {
            let val = (alias && alias.trim()) ? alias.trim() : "";
            if(val){ this.nodeAliases[nodeId] = val; }
            else{ delete this.nodeAliases[nodeId]; }
            this.persistNodeAliases();
            // Worker round-trip → enrichment re-applies labels with the new
            // alias and the sync object broadcasts the change to every UI.
            this.update();
            // DDNS: re-publish the node under its new display name.
            try{
                if(DdnsService.instance){
                    let node:any = this.nmosState?.nodes?.[nodeId];
                    let ip = "";
                    try{
                        if(node && typeof node.href === "string" && node.href){
                            ip = new URL(node.href).hostname;
                        }
                    }catch(e){}
                    let displayName = val || node?.label || "";
                    if(ip && displayName){
                        DdnsService.instance.scheduleNodePush(nodeId, displayName, ip);
                    }
                }
            }catch(e){}
            resolve({});
        });
    }

    changeAlias(id:string, alias:string){
        // "node_<nodeId>" ids rename the NMOS node's display name (band /
        // group header) instead of a single crosspoint device.
        if(typeof id === "string" && id.startsWith("node_")){
            return this.changeNodeAlias(id.slice(5), alias);
        }
        return new Promise((resolve, reject) => {
            this.worker.postMessage(JSON.stringify({
                changeAlias:{id:id, alias:alias}
            }));

            // If this alias belongs to a virtual sender, also update
            // settings.virtualSenders[].name so the registered IS-04 sender
            // label tracks the operator's rename. Virtual senders show up as
            // nmos_<senderId> just like real ones, so we match by the UUID
            // portion of the id against the persisted senderId.
            if(id && id.startsWith("nmos_") && Array.isArray(this.settings?.virtualSenders)){
                try{
                    let nmosId = id.slice(5);
                    let entry = this.settings.virtualSenders.find((v:any) => v && v.senderId === nmosId);
                    if(entry){
                        let newName = (alias && alias.trim()) ? alias.trim() : "";
                        if(entry.name !== newName){
                            entry.name = newName;
                            this.virtualSenders = this.settings.virtualSenders;
                            this.update();
                            try{
                                const fs = require("fs");
                                fs.writeFileSync("./config/settings.json", JSON.stringify(this.settings, null, 4));
                                SyncLog.log("info", "Settings", "Updated virtualSenders[" + entry.id + "].name from alias change.");
                            }catch(e:any){
                                SyncLog.log("warn", "Settings", "Could not persist virtual sender rename: " + (e?.message || e));
                            }
                            try{ if(this.onVirtualSendersChange){ this.onVirtualSendersChange(); } }catch(e){}
                        }
                    }
                }catch(e){}
            }

            // DNS Push: re-push the affected node so its host_override on the
            // pfSense DNS forwarder picks up the new alias straight away,
            // without waiting for the next NMOS node update. Empty alias
            // falls back to the node label.
            try{
                if(DdnsService.instance){
                    let targets = this.resolveDnsNodesForCrosspointId(id);
                    for(let t of targets){
                        let displayName = (alias && alias.trim()) ? alias.trim() : (t.nodeLabel || "");
                        if(t.nodeIp && displayName){
                            DdnsService.instance.scheduleNodePush(t.nodeId, displayName, t.nodeIp);
                        }
                    }
                }
            }catch(e){}

            resolve({});
        });
    }

    /**
     * Map a crosspoint id (device, sender or receiver) to the NMOS node(s)
     * it belongs to, so the DNS Push hook can re-publish the right entries
     * on an alias change.
     *
     *   nmos_<deviceId>      → exactly one node
     *   nmosgrp_<hash>       → the node of any sender belonging to the group
     *   nmos_<senderId>      → the node behind the sender's device
     *   nmos_<receiverId>    → the node behind the receiver's device
     *
     * Returns an empty list when nothing can be resolved (e.g. shadow
     * devices, unknown ids, NMOS state not yet hydrated).
     */
    private resolveDnsNodesForCrosspointId(id:string): { nodeId:string, nodeIp:string, nodeLabel:string }[] {
        let out:{ nodeId:string, nodeIp:string, nodeLabel:string }[] = [];
        try{
            if(!this.nmosState) return out;

            // Helper: turn a deviceId into a {nodeId, nodeIp, nodeLabel} triple.
            const fromDevice = (devId:string) => {
                try{
                    let dev:any = this.nmosState.devices?.[devId];
                    let nodeId = dev?.node_id;
                    if(!nodeId) return null;
                    let node:any = this.nmosState.nodes?.[nodeId];
                    let ip = "";
                    try{
                        if(node && typeof node.href === "string" && node.href){
                            ip = new URL(node.href).hostname;
                        }
                    }catch(e){}
                    return { nodeId, nodeIp: ip, nodeLabel: node?.label || "" };
                }catch(e){ return null; }
            };
            const pushUnique = (t:{nodeId:string, nodeIp:string, nodeLabel:string} | null) => {
                if(!t || !t.nodeId) return;
                if(out.find(x => x.nodeId === t.nodeId)) return;
                out.push(t);
            };

            if(typeof id !== "string") return out;

            // Crosspoint device id
            if(id.startsWith("nmos_")){
                let raw = id.slice(5);
                // Could be a device id directly...
                if(this.nmosState.devices?.[raw]){
                    pushUnique(fromDevice(raw));
                }
                // ...or a sender / receiver id whose device we look up.
                else if(this.nmosState.senders?.[raw]){
                    pushUnique(fromDevice(this.nmosState.senders[raw].device_id));
                }
                else if(this.nmosState.receivers?.[raw]){
                    pushUnique(fromDevice(this.nmosState.receivers[raw].device_id));
                }
                return out;
            }

            // Grouphint group — look at one of its senders to find the device.
            if(id.startsWith("nmosgrp_")){
                let xpDev = this.crosspointState.devices.find((d:any) => d.id === id);
                if(!xpDev) return out;
                for(let type of Object.keys(xpDev.senders || {})){
                    for(let s of (xpDev.senders[type] || [])){
                        if(!s || typeof s.id !== "string") continue;
                        if(!s.id.startsWith("nmos_")) continue;
                        let senderId = s.id.slice(5);
                        let sender:any = this.nmosState.senders?.[senderId];
                        if(sender?.device_id){
                            pushUnique(fromDevice(sender.device_id));
                            // All senders in a grouphint group share one
                            // device → one node, so we're done.
                            return out;
                        }
                    }
                }
            }
        }catch(e){}
        return out;
    }

    toggleHidden(id:string){
        return new Promise((resolve, reject) => {
            this.worker.postMessage(JSON.stringify({
                toggleHidden:{id:id}
            }));
            resolve({});
        });
    }

    makeConnection(data:any){
        return new Promise(async(resolve, reject) => {

            let preview = true;
            let prepare = false;
            let list = [];
            if(data.hasOwnProperty("multiple")){
                list = data.multiple;
            }else{
                if(data.hasOwnProperty("source") && data.hasOwnProperty('destination')){
                    list = [{source:data.source+"", destination:data.destination+""}]
                }
            }

            if(data.hasOwnProperty("preview") && data.preview === false){
                preview = false;
            }
            if(data.hasOwnProperty("prepare") && data.prepare === true){
                prepare = true;
                preview = false;
            }


            let connections = [];


            list.forEach((c)=>{
                let source = c.source+""
                let destination = c.destination+""
                let disconnect = false
                if(source == "" || source =="__disconnect"){
                    // Disconnect
                    disconnect = true
                }

                let srcFlows:any[] = [];
                let dstFlows:any[] = [];

                // Select all source Flows
                let sourceDevice = null;
                let sourceDeviceOnly = false;
                let sourceFlowType = "";
                let sourceFlow = null;
                let sourceParts = source.split(".");
                let srcDev = null
                sourceDevice = sourceParts[0]
                if(sourceParts.length == 2){
                    sourceFlow = sourceParts[1].slice(1);
                    switch(sourceParts[1][0]){
                        case "v":
                            sourceFlowType = "video"
                            break;
                        case "a":
                            sourceFlowType = "audio"
                            break;
                        case "d":
                            sourceFlowType = "data"
                            break;
                        default:
                            sourceFlowType = "unknown"
                    }
                }else{
                    sourceDeviceOnly = true;
                }

                for(let dev of this.crosspointState.devices){
                    if(dev.num == sourceDevice){
                        srcDev = dev;
                        for(let type in dev.senders){
                            if(type == sourceFlowType || sourceDeviceOnly){
                                for(let flow of dev.senders[type]){
                                    if(flow.num == sourceFlow || sourceDeviceOnly){
                                        srcFlows.push(flow);
                                    }
                                }
                            }
                        }
                    }
                }


                // Select all destination Flows
                let destinationDevice = null;
                let destinationDeviceOnly = false;
                let destinationFlowType = "";
                let destinationFlow = null;
                let destinationParts = destination.split(".");
                let dstDev = null;
                destinationDevice = destinationParts[0]
                if(destinationParts.length == 2){
                    destinationFlow = destinationParts[1].slice(1);
                    switch(destinationParts[1][0]){
                        case "v":
                            destinationFlowType = "video"
                            break;
                        case "a":
                            destinationFlowType = "audio"
                            break;
                        case "d":
                            destinationFlowType = "data"
                            break;
                        default:
                            destinationFlowType = "unknown"
                    }
                }else{
                    destinationDeviceOnly = true;
                }

                for(let dev of this.crosspointState.devices){
                    if(dev.num == destinationDevice){

                        dstDev = dev;
                        for(let type in dev.receivers){
                            if(type == destinationFlowType || destinationDeviceOnly){
                                for(let flow of dev.receivers[type]){
                                    if(flow.num == destinationFlow || destinationDeviceOnly){
                                        dstFlows.push(flow);
                                    }
                                }
                            }
                        }
                    }
                }


                //console.log("Sources:", srcFlows)
                //console.log("Destiantions:", dstFlows)
                if((srcFlows.length > 0 || disconnect) && dstFlows.length > 0){
                    
                        // Connection Matcher

                        // For Each dstFlow
                        //      find suitable SrcFlow
                        //      Type
                        //      Capabilities
                        //      Lowest NUM

                        let usedSources = [];

                        for(let dstFlow of dstFlows){
                            let connection = {src:null,srcDev:srcDev, dst:dstFlow,dstDev:dstDev}

                            if(disconnect){
                                // src : null
                            }else{
                                for(let srcFlow of srcFlows){
                                    // TODO websocket/mqtt flwos interop
                                    let connect = false;
                                    if(dstFlow.type == "audio" && srcFlow.type == "audio"){
                                        // TODO check for capabilities
                                        connect = true;
                                    }else if(dstFlow.type == "video" && srcFlow.type == "video"){
                                        // TODO check for capabilities
                                        connect = true;
                                    }else if(dstFlow.type == "data"){
                                        if(srcFlow.type == "data"){
                                            // TODO check for capabilities
                                            connect = true;
                                        }
                                    }else{
                                        if(dstFlow.type == srcFlow.type){
                                            connect = true;
                                        }
                                    }

                                    if(connect && !usedSources.includes(srcFlow.id)){
                                        if(connection.src == null){
                                            connection.src = srcFlow;
                                            usedSources.push(srcFlow.id);
                                        }else if(connection.src.num > srcFlow.num){
                                            usedSources = usedSources.filter((s)=>{
                                                if(s.id == connection.src.id){
                                                    return false;
                                                }else{
                                                    return true;
                                                }
                                            })
                                            connection.src = srcFlow;
                                        }
                                    }
                                
                            }
                            }
 
                            connections.push(connection);
                        }
                }

            });



            if(preview){
                let connectionPreviews = [];
                connections.forEach((c)=>{
                    connectionPreviews.push({src:(c.src?c.src.id:null),dst:c.dst.id, status:"preview"});
                });
                resolve({connections:connectionPreviews});
            }else if(prepare){
                let connectionPreviews = [];
                connections.forEach((c)=>{
                    connectionPreviews.push({src:c.src,dst:c.dst,srcDev:(c.src ? c.srcDev : null), dstDev:c.dstDev, status:"prepare"});
                });
                resolve({connections:connectionPreviews});
            }else{
                let connectionPromises = [];
                let disconnectPromises = [];
                let connectionResponses = [];

                // Connects
                connections.forEach((c)=>{
                    if(c.src){
                        connectionPromises.push(this.executeConnection(c.src,c.dst));
                    }
                });
                
                let results = await Promise.allSettled(connectionPromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){
                        connectionResponses.push(r.value);
                    }else{
                        connectionResponses.push(r.reason);
                    }
                })


                // Dsiconnects
                connections.forEach((c)=>{
                    if(!c.src){
                        disconnectPromises.push(this.executeConnection(c.src,c.dst));
                    }
                });
                results = await Promise.allSettled(disconnectPromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){
                        connectionResponses.push(r.value);
                    }else{
                        connectionResponses.push(r.reason);
                    }
                })

                resolve({connections:connectionResponses});
            }

            // Further TODOs
            // Get Source Info
            // SDP
            // Bitrate
            // Interfaces

            // Transform

            // Check Network
            // Check other ???

            // Send to destiantion (if not preview)
           
            
        });

    }


    executeConnection(src:CrosspointFlow,dst:CrosspointFlow){
        return new Promise(async(resolve, reject) => {
            if(dst){
                let senderInfo:CrosspointConnectionSenderInfo|null = null;
                if(src){
                    SyncLog.log("info", "connect_crosspoint", "Make Connect: Receiver "+ dst.id + "    <   Sender " + src.id)
                    try{
                        if(src.id.startsWith("nmos_")){
                            // Virtual senders also live under nmos_<id> now —
                            // they are registered with the NMOS registry by
                            // NmosNodeRegistration and their manifest_href
                            // points back at our own /x-nmos endpoint, so
                            // connectionGetSenderInfo just works.
                            let nmosId = src.id.slice(5);
                            senderInfo = await NmosRegistryConnector.instance.connectionGetSenderInfo(nmosId);
                        }
                    }catch(e){
                        reject({src:src,dst:dst,status:"failed sender info"});
                    }
                }else{
                    SyncLog.log("info", "connect_crosspoint", "Make Connect: Receiver "+ dst.id + "    <   Disconnect")
                    senderInfo = {
                        senderId: "disconnect",
                        interfaces:[],
                        manifestFile:"",
                        active:false,
                        error:"",
                        transport:""
                    }
                }

                // If the source sender is currently inactive, we MAY try to
                // activate it on-the-fly. Only do so when the operator opted
                // into this behaviour via the Setup page — many control rooms
                // gate sender activation through a separate workflow and don't
                // want a stray click on the Crosspoint matrix to push a signal
                // on the wire. First make sure its multicast isn't already
                // claimed by another active sender on the same leg.
                let autoActivate = !!(this.settings && this.settings.autoActivateInactiveSender);
                if(autoActivate && src && src.id.startsWith("nmos_") && senderInfo && senderInfo.active === false){
                    let nmosId = src.id.slice(5);
                    let conflict = NmosRegistryConnector.instance.findMulticastConflict(nmosId);
                    if(conflict){
                        let msg = "Multicast " + conflict.multicast +
                                  " (Leg " + (conflict.leg + 1) + ") is already in use by sender: " +
                                  conflict.label;
                        SyncLog.log("warning", "connect_crosspoint", "Refusing to auto-activate " + src.id + " — " + msg);
                        reject({src:src,dst:dst,status:"failed", detail:{message: msg, log:""}});
                        return;
                    }
                    SyncLog.log("info", "connect_crosspoint", "Auto-activating inactive sender before connect: " + src.id);
                    try{
                        await NmosRegistryConnector.instance.enableFlow(nmosId, false);
                        // The SDP we fetched a moment ago belonged to the
                        // inactive sender — it has only session-level lines
                        // (`v=0`, `o=…`, `s=…`, `c=…`, …) but no `m=` media
                        // section yet, so the receiver would reject the
                        // transport_file with HTTP 400
                        // "Could not parse transport file". The device needs
                        // a moment to (re)publish a real SDP after activation.
                        // Poll the manifest until we see an `m=` line, with a
                        // safety timeout, then continue with the connect.
                        let freshInfo: CrosspointConnectionSenderInfo | null = null;
                        const deadline = Date.now() + 4000;
                        while(Date.now() < deadline){
                            await sleep(300);
                            try{
                                freshInfo = await NmosRegistryConnector.instance.connectionGetSenderInfo(nmosId);
                            }catch(e){ freshInfo = null; }
                            if(freshInfo && freshInfo.manifestFile && /\r?\nm=/.test(freshInfo.manifestFile)){
                                break;
                            }
                        }
                        if(freshInfo && freshInfo.manifestFile && /\r?\nm=/.test(freshInfo.manifestFile)){
                            senderInfo = freshInfo;
                        }else{
                            SyncLog.log("warning", "connect_crosspoint",
                                "Auto-activated sender " + src.id + " but its SDP still has no media section after 4s — patching with what we have.");
                            if(freshInfo){ senderInfo = freshInfo; }
                        }
                        // mark the locally-cached senderInfo as active so downstream
                        // code doesn't take another inactive-path.
                        senderInfo.active = true;
                    }catch(e:any){
                        let msg = "Could not auto-activate sender: " + (e && e.message ? e.message : "unknown");
                        reject({src:src,dst:dst,status:"failed", detail:{message: msg, log:""}});
                        return;
                    }
                }



                if(dst.id.startsWith("nmos_")){
                    try{
                        let nmosId = dst.id.slice(5);
                        let log = await NmosRegistryConnector.instance.makeConnection(nmosId,senderInfo);
                        if(senderInfo.senderId == "disconnect"){
                            resolve({src:src,dst:dst,status:"ok_dis", detail:{message:"Success",log:""+log}});
                        }else{
                            resolve({src:src,dst:dst,status:"ok", detail:{message:"Success",log:""+log}});
                        }
                    }catch(e){
                        if(e instanceof LoggedError){
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:e.logId}});
                        }else{
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:""}});
                        }
                        
                    }
                }
            }else{
                let id = SyncLog.log("warning", "connect_crosspoint", "Connect command without destination.")
                reject({src:src,dst:dst,status:"nc", detail:{message:"Destination missing",log:id}});
            }
        });
    }


    /**
     * Find every receiver currently connected to the given sender and
     * re-execute the connection. Used whenever the sender's multicast
     * (or any other SDP-relevant field) changes — without this, receivers
     * would keep listening to the old destination IP / port.
     *
     * Always runs (no settings gate). Caller is responsible for triggering
     * only when an actual change happened.
     */
    public reconnectReceiversOfSender( senderId:string ){
        let nmos_senderId = "nmos_"+senderId
        let src:CrosspointFlow = null;
        for(let dev of this.crosspointState.devices){
            for(let type of Object.keys(dev.senders)){
                for( let flow of dev.senders[type]){
                    if(flow.id == nmos_senderId){
                       src = flow;
                       break;
                    }
                }
            }
        }
        if(!src) return;

        for(let dev of this.crosspointState.devices){
            for(let type of Object.keys(dev.receivers)){
                for( let flow of dev.receivers[type]){
                    if(flow.connectedFlow == nmos_senderId){
                       let dst = flow;
                       this.executeConnection(src,dst).then(()=>{}).catch(()=>{});
                       SyncLog.log("info", "crosspoint", "Reconnecting receiver " + dst.id + " because sender " + src.id + " transport params changed.");
                    }
                }
            }
        }
    }

    /**
     * Called when the SDP of a sender changed (detected by manifest re-fetch
     * in nmosConnector — covers anything: multicast IP, port, channel count,
     * video format, colorimetry, transfer characteristic, …).
     *
     * Gated by `settings.reconnectReceiversOnSenderChange` (default true).
     * The legacy `settings.reconnectOnSdpChanges` flag is still respected for
     * back-compat: if it's explicitly set to true, reconnects fire even when
     * the new toggle is off.
     */
    reconnectOnChangesFromNmos( senderId:string ){
        let auto   = (this.settings && this.settings.reconnectReceiversOnSenderChange !== false);
        let legacy = !!(this.settings && this.settings.reconnectOnSdpChanges);
        if(!auto && !legacy){
            return;
        }
        this.reconnectReceiversOfSender(senderId);
    }

    updateFromNmos(state:any){
        this.nmosState = state;
        // Reconcile IS-12 monitoring connections against the registry
        // (new ncp devices get a WebSocket, vanished ones are torn down).
        try{ Bcp008Monitor.instance?.updateFromNmos(state); }catch(e){}
        this.update();
    }

    update(){
        // Post the object directly — worker_threads transfers it via V8
        // structured clone, which is both faster than JSON.stringify+parse
        // and avoids materialising a multi-megabyte intermediate string on
        // every tick (the nmosState of a large registry easily exceeds
        // several MB; this used to run up to 10×/second).
        this.worker.postMessage({
            nmosState:this.nmosState,
            virtualSenders:this.virtualSenders
        })
    }

    /** Re-run enrichment on the CURRENT crosspoint state and publish the
     *  diff — no worker round-trip. Used for changes that only affect
     *  enrichment-time data (BCP-008 monitor statuses): the worker's shadow
     *  depends solely on nmosState, which is untouched by those. */
    private republishEnriched(){
        if(!this.crosspointState || !Array.isArray((this.crosspointState as any).devices)) return;
        try{
            this.enrichCrosspointState();
            this.syncCrosspoint.setState(this.crosspointState);
        }catch(e){}
    }

    updateReturn(data:any){
        if(data.hasOwnProperty("crosspointState")){
            this.crosspointState = data.crosspointState;
            this.enrichCrosspointState();
            this.syncCrosspoint.setState(this.crosspointState);
            try{ if(this.onStateUpdated){ this.onStateUpdated(); } }catch(e){}
        }

        if(data.hasOwnProperty("log")){
            SyncLog.log(data.log.severity, data.log.topic, data.log.text, data.log.raw);
        }

        if(data.hasOwnProperty("nmosSetMulticast")){
            NmosRegistryConnector.instance.setFlowMulticast(data.nmosSetMulticast.nmosId,data.nmosSetMulticast.multicast);
        }
    }


    // Notified each time the enriched crosspoint state is republished. Used
    // by server.ts to refresh derived snapshots (multicast lease inventory)
    // whose live status depends on the current crosspoint / NMOS view.
    public onStateUpdated:(()=>void)|null = null;


    // ------------------------------------------------------------------
    // Enrichment: everything below was previously computed in the browser
    // (details.svelte / setup.svelte / App.svelte). Moving it here keeps
    // the rendering side dumb and avoids duplicating NMOS-parsing logic
    // across UI files.
    // ------------------------------------------------------------------

    private static MEDIA_TYPE_CODEC: { [mt:string]: string } = {
        "video/raw":      "RAW Video",
        "video/jxsv":     "JPEG-XS Video",
        "video/colibri":  "Colibri Video",
        "audio/L16":      "16 Bit LPCM",
        "audio/L24":      "24 Bit LPCM",
        // L32 carries 24-bit LPCM samples padded into a 32-bit container.
        "audio/L32":      "24 Bit LPCM",
        "audio/AM824":    "ST2110-31 AES3",
        "video/smpte291": "ANC"
    };

    private mediaTypesToCodec(types:string[]): string {
        if(!Array.isArray(types) || types.length === 0) return "";
        let out:string[] = [];
        for(let t of types){
            let pretty = CrosspointAbstraction.MEDIA_TYPE_CODEC[t] || t;
            if(pretty && !out.includes(pretty)) out.push(pretty);
        }
        return out.join(", ");
    }

    private buildCodecFromManifest(nmosSenderId:string): string {
        if(!nmosSenderId || !this.nmosState) return "";
        try{
            let manifest:any = this.nmosState.sendersManifestDetail?.[nmosSenderId];
            if(!manifest || !Array.isArray(manifest.media) || manifest.media.length === 0) return "";
            let labels:string[] = [];
            for(let m of manifest.media){
                if(!m || !Array.isArray(m.rtp) || m.rtp.length === 0) continue;
                let codec = ("" + (m.rtp[0].codec || "")).toUpperCase();
                let pretty = codec;
                switch(codec){
                    case "L16":      pretty = "16 Bit LPCM"; break;
                    case "L24":      pretty = "24 Bit LPCM"; break;
                    case "L32":      pretty = "24 Bit LPCM"; break;
                    case "AM824":    pretty = "ST2110-31 AES3"; break;
                    case "RAW":      pretty = "RAW Video"; break;
                    case "JXSV":     pretty = "JPEG-XS Video"; break;
                    case "SMPTE291": pretty = "ANC"; break;
                    case "VC2":      pretty = "VC-2"; break;
                    default:
                        if(!codec) pretty = "";
                }
                if(pretty && !labels.includes(pretty)) labels.push(pretty);
            }
            return labels.join(", ");
        }catch(e){}
        return "";
    }

    // IS-05 /active is authoritative for what a sender is currently
    // transmitting. The SDP may lag (or 404 for inactive senders) so we
    // only fall back to it when no transport_params exist.
    private buildLegsFromNmos(nmosSenderId:string): CrosspointFlowLeg[] {
        let legs:CrosspointFlowLeg[] = [];
        if(!nmosSenderId || !this.nmosState) return legs;

        try{
            let active:any = this.nmosState.senderActiveData?.[nmosSenderId];
            if(active && Array.isArray(active.transport_params) && active.transport_params.length > 0){
                active.transport_params.forEach((tp:any, index:number) => {
                    legs.push({
                        index,
                        dstIp:   tp?.destination_ip   ? ("" + tp.destination_ip)   : "",
                        dstPort: (tp?.destination_port !== undefined && tp?.destination_port !== null) ? tp.destination_port : "",
                        srcIp:   tp?.source_ip        ? ("" + tp.source_ip)        : ""
                    });
                });
            }
        }catch(e){}

        if(legs.length === 0){
            try{
                let manifest:any = this.nmosState.sendersManifestDetail?.[nmosSenderId];
                if(manifest && Array.isArray(manifest.media) && manifest.media.length > 0){
                    manifest.media.forEach((media:any, index:number) => {
                        let dstIp = "";
                        let srcIp = "";
                        let port:string|number = "";
                        try{
                            if(media.sourceFilter){
                                dstIp = media.sourceFilter.destAddress || "";
                                srcIp = media.sourceFilter.srcList || "";
                            }
                            if(!dstIp && media.connection?.ip){
                                dstIp = ("" + media.connection.ip).split("/")[0];
                            }
                            if(media.port !== undefined && media.port !== null){ port = media.port; }
                        }catch(e){}
                        legs.push({ index, dstIp, dstPort: port, srcIp });
                    });
                }
            }catch(e){}
        }

        legs.sort((a, b) => a.index - b.index);
        return legs;
    }

    private buildGmidFromNode(nodeId:string): { gmid:string, locked:boolean } {
        if(!nodeId || !this.nmosState) return { gmid:"", locked:false };
        try{
            let node:any = this.nmosState.nodes?.[nodeId];
            if(!node || !Array.isArray(node.clocks)) return { gmid:"", locked:false };
            let firstPtp:any = null;
            for(let clk of node.clocks){
                if(clk && clk.ref_type === "ptp"){
                    if(!firstPtp) firstPtp = clk;
                    if(clk.locked && clk.gmid){
                        return { gmid: ("" + clk.gmid).toUpperCase(), locked: true };
                    }
                }
            }
            if(firstPtp && firstPtp.gmid){
                return { gmid: ("" + firstPtp.gmid).toUpperCase(), locked: !!firstPtp.locked };
            }
        }catch(e){}
        return { gmid:"", locked:false };
    }

    private matchVendorProfile(profile:any, label:string, description:string): boolean {
        let raw:string = (profile && typeof profile.labels === "string") ? profile.labels : "";
        if(!raw) return false;
        let needles = raw.split(",").map(x => x.trim().toLowerCase()).filter(x => x.length > 0);
        if(needles.length === 0) return false;
        let hay = ((label || "") + " " + (description || "")).toLowerCase();
        for(let n of needles){
            if(hay.includes(n)) return true;
        }
        return false;
    }

    private buildDeviceUrl(nodeId:string): string {
        if(!nodeId || !this.nmosState) return "";
        try{
            let node:any = this.nmosState.nodes?.[nodeId];
            if(!node || !node.href) return "";
            let u = new URL("" + node.href);
            let host = u.hostname;

            let vendorProfiles:any[] = Array.isArray(this.settings?.vendorProfiles) ? this.settings.vendorProfiles : [];
            let label:string = node.label || "";
            let description:string = node.description || "";
            for(let profile of vendorProfiles){
                if(this.matchVendorProfile(profile, label, description)){
                    let proto = (profile.protocol === "https") ? "https" : "http";
                    let port = parseInt("" + profile.port);
                    if(isNaN(port) || port <= 0 || port > 65535){
                        port = (proto === "https") ? 443 : 80;
                    }
                    let path = (typeof profile.path === "string" && profile.path) ? profile.path : "/";
                    if(!path.startsWith("/")) path = "/" + path;
                    let portSuffix = ((proto === "http" && port === 80) || (proto === "https" && port === 443))
                        ? "" : (":" + port);
                    return proto + "://" + host + portSuffix + path;
                }
            }
            return u.protocol + "//" + u.host + "/";
        }catch(e){}
        return "";
    }

    // Last-known NMOS node label per crosspoint device id. Survives the
    // device going offline (the live node disappears from nmosState) so the
    // composed display name doesn't change when a device drops out. In-memory
    // only — after a server restart a device that's still offline shows just
    // its device name until it comes online once.
    private nodeLabelCache: { [devId:string]: string } = {};
    // Same idea for the node ID: keeps devices grouped under their node on
    // the Details page even while they are offline.
    private nodeIdCache: { [devId:string]: string } = {};

    /**
     * Compose the device's display name and tooltip from its NMOS node label,
     * NMOS device name and the operator alias. Single source of truth for
     * BOTH the Crosspoint matrix and the Details page — neither UI does any
     * label logic of its own.
     *
     * Rules:
     *   - If the operator set a custom alias (alias differs from the NMOS
     *     name), that alias is the WHOLE name — no "<Node> - " prefix. This
     *     matches the operator's intent: they renamed it, show their name.
     *   - Otherwise, if a node label exists and differs from the device
     *     name, show "<Node> - <Device>".
     *   - Otherwise just the device name.
     * Behaviour is identical whether the device is online or offline (the
     * node label is cached across offline transitions, see nodeLabelCache).
     */
    private composeDeviceLabel(nodeLabel:string, name:string, alias:string): { label:string, tooltip:string, short:string } {
        let nl   = (nodeLabel || "").trim();
        let nm   = (name || "").trim();
        let al   = (alias || "").trim();
        let hasUserAlias = !!al && al.toLowerCase() !== nm.toLowerCase();

        // Grouphint groups (BCP-002-01) arrive from the worker named
        // "<NMOS-Device> - <Group>". When that device part just repeats the
        // node label (the common one-device-per-node case), drop it — the
        // node name is already shown by the node band / "<Node> - " prefix,
        // so the entry reads "<Group>" instead of "<Node> - <Node> - <Group>".
        let nmShort = nm;
        if(nl && nm.toLowerCase().startsWith(nl.toLowerCase() + " - ")){
            let rest = nm.substring(nl.length + 3).trim();
            if(rest){ nmShort = rest; }
        }

        // `short` is the device-only name — used by the Details page and the
        // Crosspoint matrix inside a node group, where the node label
        // already sits in the group header.
        if(hasUserAlias){
            // Operator-chosen name wins outright. Tooltip keeps the origin
            // visible for reference.
            let tip = nl ? ("Node: " + nl + " | Device: " + nm) : nm;
            return { label: al, tooltip: tip, short: al };
        }

        let nodeDiffers = !!nl && nl.toLowerCase() !== nmShort.toLowerCase();
        if(nodeDiffers){
            return { label: nl + " - " + nmShort, tooltip: "Node: " + nl + " | Device: " + nm, short: nmShort };
        }
        return { label: nmShort, tooltip: nm, short: nmShort };
    }

    // Find the NMOS node behind a crosspoint device id (handles nmos_<devId>,
    // nmosgrp_<hash> and the virtual_node placeholder).
    private resolveDeviceNodeInfo(dev:CrosspointDevice): { nmosDevId:string, nodeId:string, nodeLabel:string, nmosDevLabel:string } {
        let nmosDevId = "";
        let nodeId = "";
        let nodeLabel = "";
        let nmosDevLabel = "";
        if(!this.nmosState || typeof dev.id !== "string") return { nmosDevId, nodeId, nodeLabel, nmosDevLabel };
        try{
            if(dev.id.startsWith("nmos_")){
                nmosDevId = dev.id.substring(5);
            }else if(dev.id.startsWith("nmosgrp_")){
                let allFlows:any[] = [];
                for(let type of Object.keys(dev.senders || {})) allFlows = allFlows.concat(dev.senders[type] || []);
                for(let type of Object.keys(dev.receivers || {})) allFlows = allFlows.concat(dev.receivers[type] || []);
                for(let f of allFlows){
                    if(typeof f.id !== "string" || !f.id.startsWith("nmos_")) continue;
                    let nid = f.id.substring(5);
                    let s:any = this.nmosState.senders?.[nid];
                    if(s?.device_id){ nmosDevId = s.device_id; break; }
                    let r:any = this.nmosState.receivers?.[nid];
                    if(r?.device_id){ nmosDevId = r.device_id; break; }
                }
            }
            if(nmosDevId && this.nmosState.devices?.[nmosDevId]){
                let nmosDev:any = this.nmosState.devices[nmosDevId];
                nmosDevLabel = nmosDev.label || "";
                nodeId = nmosDev.node_id || "";
                if(nodeId && this.nmosState.nodes?.[nodeId]){
                    nodeLabel = this.nmosState.nodes[nodeId].label || "";
                }
            }
        }catch(e){}
        return { nmosDevId, nodeId, nodeLabel, nmosDevLabel };
    }

    private buildConnectedSenderLabel(connectedFlowId:string): string {
        if(!connectedFlowId || !this.nmosState) return "";
        if(connectedFlowId.startsWith("nmos_")){
            let nmosId = connectedFlowId.substring(5);
            let nmosSender:any = this.nmosState.senders?.[nmosId];
            if(!nmosSender) return "";
            let label = nmosSender.label || nmosId;
            let nmosDev:any = this.nmosState.devices?.[nmosSender.device_id];
            if(nmosDev?.label){
                label = nmosDev.label + " / " + label;
            }
            return label;
        }
        return "";
    }

    // Detected-devices preview used by the Setup page (vendor profile table).
    // Lists every NMOS node with the profile that matched (if any) and the
    // resulting Web-UI URL.
    private buildDetectedDevices(): Array<{ id:string, label:string, match:string, url:string }> {
        let out:Array<{ id:string, label:string, match:string, url:string }> = [];
        try{
            let nodes:any = this.nmosState?.nodes || {};
            let vendorProfiles:any[] = Array.isArray(this.settings?.vendorProfiles) ? this.settings.vendorProfiles : [];
            for(let nodeId in nodes){
                let n:any = nodes[nodeId];
                if(!n) continue;
                let label = n.label || nodeId;
                let description = n.description || "";
                let matchName = "";
                for(let p of vendorProfiles){
                    if(this.matchVendorProfile(p, label, description)){
                        matchName = p.name || p.id;
                        break;
                    }
                }
                let url = this.buildDeviceUrl(nodeId);
                out.push({ id: nodeId, label, match: matchName, url });
            }
            out.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
        }catch(e){}
        return out;
    }

    private enrichCrosspointState(){
        if(!this.crosspointState || !Array.isArray(this.crosspointState.devices)) return;

        let totals:CrosspointTotals = {
            devices:   { avail: 0, total: 0 },
            senders:   { avail: 0, total: 0 },
            receivers: { avail: 0, total: 0 }
        };

        // Pass 1: device-level NMOS metadata
        // Compute the crosspoint device id that backs OUR virtual NMOS node
        // (settings.virtualNode.deviceId) once — the worker prefixes NMOS
        // device ids with "nmos_", so a match here means "every sender on
        // this device is a virtual sender we registered ourselves".
        let virtualDeviceCpId = "";
        try{
            if(this.settings?.virtualNode?.deviceId){
                virtualDeviceCpId = "nmos_" + this.settings.virtualNode.deviceId;
            }
        }catch(e){}

        let nodeLabelByDev:    { [devId:string]: string }  = {};
        let isVirtualByDev:    { [devId:string]: boolean } = {};
        for(let dev of this.crosspointState.devices){
            let info = this.resolveDeviceNodeInfo(dev);

            // Offline devices have no live NMOS node, so resolveDeviceNodeInfo
            // returns an empty nodeLabel. Cache the last-known node label per
            // device id and reuse it while the device is offline so the
            // displayed name stays "<Node> - <Device>" exactly as it was
            // online (instead of collapsing to just the device name).
            let nodeLabel = info.nodeLabel;
            if(nodeLabel){
                this.nodeLabelCache[dev.id] = nodeLabel;
            }else if(this.nodeLabelCache[dev.id]){
                nodeLabel = this.nodeLabelCache[dev.id];
            }
            nodeLabelByDev[dev.id] = nodeLabel;

            // Node id, cached across offline transitions just like the
            // label, so node grouping on the Details page stays stable.
            let nodeId = info.nodeId;
            if(nodeId){
                this.nodeIdCache[dev.id] = nodeId;
            }else if(this.nodeIdCache[dev.id]){
                nodeId = this.nodeIdCache[dev.id];
            }

            // Operator rename of the whole node: keep the raw registry label
            // around for the rename modal, then let the alias win everywhere.
            let nodeLabelRaw = nodeLabel;
            let nodeAlias = nodeId ? (this.nodeAliases[nodeId] || "") : "";
            if(nodeAlias){ nodeLabel = nodeAlias; }

            isVirtualByDev[dev.id] = !!virtualDeviceCpId && dev.id === virtualDeviceCpId;
            let gm = this.buildGmidFromNode(info.nodeId);
            let d = dev as CrosspointDevice;
            d.nodeLabel  = nodeLabel;
            d.nodeLabelRaw = nodeLabelRaw;
            d.nodeAlias  = nodeAlias;
            d.nodeId     = nodeId;
            d.gmid       = gm.gmid;
            d.gmidLocked = gm.locked;
            d.deviceUrl  = this.buildDeviceUrl(info.nodeId);
            d.isVirtual  = isVirtualByDev[dev.id];

            // Final display name + tooltip, computed once here so every UI
            // page renders the same string (no per-page label logic).
            let composed = this.composeDeviceLabel(d.nodeLabel, d.name, d.alias);
            d.displayLabel      = composed.label;
            d.displayTooltip    = composed.tooltip;
            d.displayLabelShort = composed.short;
        }

        // Pass 2: sender legs + codec, build {flowId → enriched-sender-info}
        // Also collects every ACTIVE sender per (leg index → multicast IP)
        // for duplicate detection. Primary and secondary legs are independent
        // failover paths, so the same group on leg 1 and leg 2 is fine —
        // only two active senders on the SAME leg index clash.
        let activeLegIps: { [legIndex:number]: { [ip:string]: Array<{id:string,label:string}> } } = {};
        let activeLegRefs: Array<{ leg:CrosspointFlowLeg, flowId:string }> = [];
        let senderInfoById: { [id:string]: { legs:CrosspointFlowLeg[], codec:string, format:string, bitrate:CrosspointFlowBitrate, label:string } } = {};
        for(let dev of this.crosspointState.devices){
            let nodeLabel = nodeLabelByDev[dev.id] || "";
            let devIsVirtual = isVirtualByDev[dev.id] === true;
            for(let type of Object.keys(dev.senders || {})){
                for(let s of (dev.senders as any)[type] || []){
                    if(!s) continue;
                    let nmosId = (typeof s.id === "string" && s.id.startsWith("nmos_")) ? s.id.substring(5) : "";
                    let legs = nmosId ? this.buildLegsFromNmos(nmosId) : [];
                    let codec = nmosId ? this.buildCodecFromManifest(nmosId) : "";
                    if(!codec && s.capabilities?.mediaTypes){
                        codec = this.mediaTypesToCodec(s.capabilities.mediaTypes);
                    }
                    let sf = s as CrosspointFlow;
                    sf.legs = legs;
                    sf.codec = codec;
                    // BCP-008-02 sender health (device-computed worst-of-all).
                    sf.monitor = this.buildMonitorStatus(nmosId);
                    // Mark virtual-sender flows so the Details page can skip
                    // the multicast / port edit and Forget controls — those
                    // would either be rejected (IS-05 returns 405 on /staged
                    // for virtual senders) or futile (the next re-register
                    // brings the sender back).
                    if(devIsVirtual) sf.isVirtual = true;

                    if(s.active){
                        let dLabel = (dev as CrosspointDevice).displayLabel || dev.alias || dev.name || "";
                        for(let l of legs){
                            if(!l.dstIp) continue;
                            if(!activeLegIps[l.index]) activeLegIps[l.index] = {};
                            if(!activeLegIps[l.index][l.dstIp]) activeLegIps[l.index][l.dstIp] = [];
                            activeLegIps[l.index][l.dstIp].push({ id: s.id, label: dLabel + " / " + (s.alias || s.name) });
                            activeLegRefs.push({ leg: l, flowId: s.id });
                        }
                    }

                    senderInfoById[s.id] = {
                        legs,
                        codec,
                        format:  s.format || "",
                        bitrate: s.bitrate,
                        label:   this.buildConnectedSenderLabel(s.id)
                    };
                }
            }
        }

        // Mark the clashing legs. dupText pre-composes the tooltip ("who
        // else transmits to this group") so the UI needs no owner lookup.
        // Legs are rebuilt from the NMOS state on every enrich, so stale
        // flags cannot survive a conflict being resolved.
        for(let ref of activeLegRefs){
            let owners = activeLegIps[ref.leg.index]?.[ref.leg.dstIp] || [];
            if(owners.length > 1){
                ref.leg.dup = true;
                let others = owners.filter(o => o.id !== ref.flowId).map(o => o.label);
                ref.leg.dupText = others.length ? others.join(", ") : "another active sender";
            }
        }

        // Pass 3: receivers + totals + per-device BCP-008 rollup
        for(let dev of this.crosspointState.devices){
            if(dev.available) totals.devices.avail++;
            totals.devices.total++;

            // Worst BCP-008 status across the device's flows + how many
            // flows are affected — the matrix shows this on the collapsed
            // device row/column ("⚠ 3"). Inactive (0) and Healthy (1) are
            // fine; only PartiallyHealthy (2) and Unhealthy (3) count.
            // Tracked separately per direction: the sender COLUMN badge
            // only counts sender flows, the receiver ROW badge receivers.
            let monTx = { worst: 0, count: 0 };
            let monRx = { worst: 0, count: 0 };
            const monTrack = (agg:{worst:number,count:number}, m:any) => {
                if(m && typeof m.status === "number" && m.status >= 2){
                    agg.count++;
                    if(m.status > agg.worst) agg.worst = m.status;
                }
            };

            for(let type of Object.keys(dev.senders || {})){
                for(let s of (dev.senders as any)[type] || []){
                    if(!s) continue;
                    if(s.available) totals.senders.avail++;
                    totals.senders.total++;
                    monTrack(monTx, (s as CrosspointFlow).monitor);
                }
            }

            for(let type of Object.keys(dev.receivers || {})){
                for(let r of (dev.receivers as any)[type] || []){
                    if(!r) continue;
                    let connected = r.connectedFlow ? senderInfoById[r.connectedFlow] : null;
                    let f = r as CrosspointFlow;
                    let nmosId = (typeof r.id === "string" && r.id.startsWith("nmos_")) ? r.id.substring(5) : "";
                    if(connected){
                        f.legs    = connected.legs;
                        f.codec   = connected.codec;
                        f.format  = connected.format;
                        f.bitrate = connected.bitrate;
                        f.connectedSenderId    = r.connectedFlow;
                        f.connectedSenderLabel = connected.label;
                    }else{
                        f.legs    = [];
                        f.codec   = "";
                        f.format  = "";
                        f.bitrate = { v: 0, hint: "unknown" };
                        f.connectedSenderId    = "";
                        f.connectedSenderLabel = "";
                    }
                    // BCP-008-01 receiver health + BCP-004-01 capability
                    // summary (shown in the matrix hover detail).
                    f.monitor   = this.buildMonitorStatus(nmosId);
                    f.capLimits = nmosId ? this.buildReceiverCapsSummary(nmosId) : "";
                    monTrack(monRx, f.monitor);
                    if(r.available) totals.receivers.avail++;
                    totals.receivers.total++;
                }
            }

            (dev as CrosspointDevice).monitorSummaryTx = monTx;
            (dev as CrosspointDevice).monitorSummaryRx = monRx;
        }

        (this.crosspointState as CrosspointState).totals = totals;
        (this.crosspointState as CrosspointState).detectedDevices = this.buildDetectedDevices();
        // Active multicast owners per (leg → IP) — the Details page checks
        // its live leg-edit input against this ("does this IP collide?").
        (this.crosspointState as CrosspointState).activeLegIps = activeLegIps;
        // Lets the matrix hide the status hearts entirely when the feature
        // is switched off (vs. grey "device doesn't support it" hearts).
        (this.crosspointState as any).bcp008Enabled = this.settings?.bcp008?.enabled !== false;
    }

    /** BCP-008 status for one flow, or undefined when nothing monitors it.
     *  `detail` breaks the four status domains down for the tooltip, e.g.
     *  "Link ✓ · Connection ⚠ · Sync ✓ · Stream ✗" (receiver) or
     *  "Link ✓ · Transmission ✓ · Sync ✓ · Essence ✓" (sender). */
    private buildMonitorStatus(nmosId:string): { status:number, message:string, detail:string, counter:number, domains:Array<{label:string,status:number,counter:number,message:string}> } | undefined {
        if(!nmosId) return undefined;
        try{
            let st = Bcp008Monitor.instance?.getStatus(nmosId);
            if(!st) return undefined;
            let labels:Array<[string,string]> = st.kind === "receiver"
                ? [["link","Link"],["path","Connection"],["sync","Sync"],["payload","Stream"]]
                : [["link","Link"],["path","Transmission"],["sync","Sync"],["payload","Essence"]];
            // Shared 0..3 scale (link: AllUp/SomeDown/AllDown maps the same):
            // 1 = fine, 2 = degraded, 3 = down, 0 = inactive/not used.
            const sym = (v:number) => v === 1 ? "✓" : v === 2 ? "⚠" : v === 3 ? "✗" : "–";
            let d:any = st.domains || {};
            let domains:Array<{label:string,status:number,counter:number,message:string}> = [];
            // "Overall counter" = MAX of the domain counters, not the sum: a
            // single incident typically bumps ALL four domains at once and
            // should read as 1, not 4.
            let counter = 0;
            let parts:string[] = [];
            for(let [k, l] of labels){
                let dv = d[k];
                if(!dv || typeof dv.s !== "number") continue;
                let c = (typeof dv.c === "number") ? dv.c : 0;
                counter = Math.max(counter, c);
                domains.push({ label: l, status: dv.s, counter: c, message: (typeof dv.m === "string") ? dv.m : "" });
                // Colour = CURRENT state; the counter in parens is history
                // (transitions since the last reset), not the state itself.
                parts.push(l + " " + sym(dv.s) + " (" + c + ")");
            }
            return { status: st.status, message: st.message || "", detail: parts.join(" · "), counter, domains };
        }catch(e){ return undefined; }
    }

    // ----- BCP-004-01 receiver capabilities → short human string -----
    //
    // Turns receiver.caps.constraint_sets into something that fits the
    // matrix hover detail, e.g.
    //   "L24/L16 · 48k · ≤16ch"  or  "raw · ≤1920×1080 · ≤p60"
    // Multiple enabled sets are joined with " | ". Falls back to the basic
    // caps.media_types list when no constraint sets are published.

    private capParamShort(cons:any, mapVal?: (v:any)=>string): string {
        if(!cons || typeof cons !== "object") return "";
        const mv = mapVal || ((v:any)=>(""+v));
        try{
            if(Array.isArray(cons.enum) && cons.enum.length > 0){
                return cons.enum.map(mv).join("/");
            }
            let hasMin = cons.minimum !== undefined && cons.minimum !== null;
            let hasMax = cons.maximum !== undefined && cons.maximum !== null;
            if(hasMin && hasMax) return mv(cons.minimum) + "–" + mv(cons.maximum);
            if(hasMax) return "≤" + mv(cons.maximum);
            if(hasMin) return "≥" + mv(cons.minimum);
        }catch(e){}
        return "";
    }

    private static ratShort(v:any): string {
        // BCP-004 rationals: {numerator, denominator?}. 48000 → "48k",
        // frame rates stay plain ("50", "59.94").
        try{
            if(v && typeof v === "object" && typeof v.numerator === "number"){
                let d = (typeof v.denominator === "number" && v.denominator > 0) ? v.denominator : 1;
                let n = v.numerator / d;
                if(n >= 1000 && n % 1000 === 0) return (n/1000) + "k";
                return (Math.round(n * 100) / 100) + "";
            }
        }catch(e){}
        return "" + v;
    }

    private static mediaTypeShort(mt:any): string {
        // "audio/L24" → "L24", "video/raw" → "raw", "video/jxsv" → "jxsv"
        let s = "" + mt;
        let i = s.indexOf("/");
        return i >= 0 ? s.substring(i+1) : s;
    }

    private buildReceiverCapsSummary(nmosId:string): string {
        try{
            let recv:any = this.nmosState?.receivers?.[nmosId];
            let caps:any = recv?.caps;
            if(!caps) return "";

            const CAP = "urn:x-nmos:cap:format:";
            let sets:any[] = Array.isArray(caps.constraint_sets) ? caps.constraint_sets : [];
            let parts:string[] = [];

            for(let set of sets){
                if(!set || typeof set !== "object") continue;
                if(set["urn:x-nmos:cap:meta:enabled"] === false) continue;

                let p:string[] = [];
                let mt = this.capParamShort(set[CAP+"media_type"], CrosspointAbstraction.mediaTypeShort);
                if(mt) p.push(mt);

                // Audio
                let rate = this.capParamShort(set[CAP+"sample_rate"], CrosspointAbstraction.ratShort);
                if(rate) p.push(rate);
                let depth = this.capParamShort(set[CAP+"sample_depth"]);
                if(depth) p.push(depth + "bit");
                let ch = this.capParamShort(set[CAP+"channel_count"]);
                if(ch) p.push(ch + "ch");

                // Video
                let w = this.capParamShort(set[CAP+"frame_width"]);
                let h = this.capParamShort(set[CAP+"frame_height"]);
                if(w && h) p.push(w + "×" + h);
                else if(w) p.push(w + "px");
                let fr = this.capParamShort(set[CAP+"grain_rate"], CrosspointAbstraction.ratShort);
                if(fr) p.push(fr + "fps");
                let il = this.capParamShort(set[CAP+"interlace_mode"], (v:any)=>{
                    let s = ""+v;
                    if(s === "progressive") return "p";
                    if(s.startsWith("interlaced")) return "i";
                    return s;
                });
                if(il) p.push(il);

                if(p.length > 0){
                    let label = set["urn:x-nmos:cap:meta:label"];
                    parts.push((typeof label === "string" && label ? label + ": " : "") + p.join(" · "));
                }
            }

            let out = parts.join(" | ");
            if(!out){
                // No constraint sets — fall back to the plain media_types list.
                if(Array.isArray(caps.media_types) && caps.media_types.length > 0){
                    out = caps.media_types.map(CrosspointAbstraction.mediaTypeShort).join("/");
                }
            }
            if(out.length > 120) out = out.substring(0, 117) + "…";
            return out;
        }catch(e){ return ""; }
    }

}


export interface CrosspointEndpoint {
    type: "flow" | "device" | "channel",
    id: string
};

export interface CrosspointCapabilities {
    mediaTypes:string[],
    transport:string,
    dash7:boolean
};

export interface CrosspointFlowBitrate {
    v:number,
    hint:string
}

export interface CrosspointFlowLeg {
    index:number,
    dstIp:string,
    dstPort:string|number,
    srcIp:string,
    // Duplicate-multicast detection (enrichCrosspointState): set when
    // another ACTIVE sender transmits to the same group on the same leg.
    // dupText names the other owner(s) for the DUP badge tooltip.
    dup?:boolean,
    dupText?:string
}


export interface CrosspointFlow {
    id:string,
    order : number,
    available:boolean,
    active:boolean,
    num:number,
    dynamic:boolean,
    name:string,

    alias:string,
    hidden:boolean,

    connectedFlow:string,

    type:"video" | "audio" | "data" | "mqtt" | "websocket" | "audiochannel" | "unknown",
    format: string,
    manifestOk:boolean,
    capabilities:CrosspointCapabilities,
    capLimits:string,
    channelNumber: number,
    sourceNumber: number,
    bitrate:CrosspointFlowBitrate,
    // Optional: raw SDP shipped with virtual senders so the Details page
    // can show it without a manifest fetch (there is no real device to
    // fetch from).
    sdp?:string,

    // Enrichment computed by CrosspointAbstraction.enrichCrosspointState.
    // The UI consumes these directly instead of re-deriving them from the
    // raw NMOS state.
    legs?:CrosspointFlowLeg[],
    codec?:string,
    // Receiver-only: identity + display label of the currently-connected
    // sender (mirrored from the sender side so the Details page can show
    // "← <Device> / <Sender>" without a second lookup).
    connectedSenderId?:string,
    connectedSenderLabel?:string,
    // True when this sender lives on our own virtual NMOS device. The
    // Details page uses this to hide leg / multicast edit controls that
    // would be rejected (IS-05 PATCH returns 405 on virtual senders).
    isVirtual?:boolean,
    // BCP-008 health as reported by the device's NcSender/ReceiverMonitor
    // via IS-12: 0 inactive, 1 healthy, 2 partially healthy, 3 unhealthy.
    // Absent when the device publishes no status monitor for this flow.
    // `detail` is the four-domain breakdown for the tooltip, `counter` the
    // summed transition counters (history, NOT current state), `domains`
    // the per-domain rows for the status modal.
    monitor?:{ status:number, message:string, detail?:string, counter?:number, domains?:Array<{label:string,status:number,counter:number,message:string}> }
};



export interface CrosspointDevice {
    id:string,
    order:number,
    available:boolean,
    num:number,
    dynamic:boolean,
    name:string,
    ip:string,
    alias:string,
    hidden:boolean,
    senderIds:string[],
    receiverIds:string[],
    connectedFlows:string[],

    senders:  {
        audio: CrosspointFlow[],
        audiochannel:CrosspointFlow[],
        video: CrosspointFlow[],
        data: CrosspointFlow[],
        websocket:CrosspointFlow[],
        mqtt: CrosspointFlow[],
        unknown: CrosspointFlow[],
    },
    receivers:  {
        audio: CrosspointFlow[],
        audiochannel:CrosspointFlow[],
        video: CrosspointFlow[],
        data: CrosspointFlow[],
        websocket:CrosspointFlow[],
        mqtt: CrosspointFlow[],
        unknown: CrosspointFlow[],
    },

    // Enrichment computed by CrosspointAbstraction.enrichCrosspointState.
    // Optional so the worker thread, which constructs the bare device
    // record, doesn't need to know about the post-enrichment fields.
    nodeLabel?:string,
    // Raw registry node label + operator node alias — the rename modal
    // shows the origin, nodeLabel above already has the alias applied.
    nodeLabelRaw?:string,
    nodeAlias?:string,
    // NMOS Node id backing this device (cached across offline transitions).
    // The Details page groups devices that share a node under one header.
    nodeId?:string,
    gmid?:string,
    gmidLocked?:boolean,
    deviceUrl?:string,
    isVirtual?:boolean,
    // Final display name + tooltip — single source of truth for every UI
    // page (see composeDeviceLabel). UI renders these verbatim.
    displayLabel?:string,
    displayTooltip?:string,
    // Device-only name (no "<Node> - " prefix) for use where the node
    // label is already shown as a group header on the Details page.
    displayLabelShort?:string,
    // BCP-008 rollup across the device's flows: worst status (0 = all
    // fine, 2 = partially healthy, 3 = unhealthy) and the number of flows
    // currently affected — the matrix badge shows "⚠ <count>". Tracked
    // per direction so the sender column only reports sender health.
    monitorSummaryTx?:{ worst:number, count:number },
    monitorSummaryRx?:{ worst:number, count:number }
  }
export interface CrosspointTotals {
    devices:   { avail:number, total:number },
    senders:   { avail:number, total:number },
    receivers: { avail:number, total:number }
}
export interface CrosspointState {
    devices: CrosspointDevice[],
    // Filled by enrichCrosspointState on the main thread. Optional because
    // the worker emits a bare state without these fields.
    totals?:CrosspointTotals,
    detectedDevices?:Array<{ id:string, label:string, match:string, url:string }>,
    // Every ACTIVE sender per (leg index → multicast IP). The Details page
    // live-edit conflict check looks typed-in addresses up here instead of
    // re-scanning all devices client-side.
    activeLegIps?:{ [legIndex:number]: { [ip:string]: Array<{id:string,label:string}> } }
}


export interface CrosspointShadowFlow {
    id:string,
    num:number,
    order : number,
    name:string,
    type:"video" | "audio" | "data" | "mqtt" | "websocket" | "audiochannel" | "unknown",
    channelNumber: number,
};

export interface CrosspointConnectionSenderInfo {
    senderId:string,
    manifestFile:string,
    interfaces:any[],
    active:boolean,
    error:string,
    transport:string
}

export interface CrosspointShadowDevice {
    id:string,
    num:number,
    order:number,
    name:string,
    senders:  {
        audio: { [name: string]: CrosspointShadowFlow },
        audiochannel: { [name: string]: CrosspointShadowFlow },
        video: { [name: string]: CrosspointShadowFlow },
        data: { [name: string]: CrosspointShadowFlow },
        websocket: { [name: string]: CrosspointShadowFlow },
        mqtt: { [name: string]: CrosspointShadowFlow },
        unknown: { [name: string]: CrosspointShadowFlow },
    },
    receivers:  {
        audio: { [name: string]: CrosspointShadowFlow },
        audiochannel: { [name: string]: CrosspointShadowFlow },
        video: { [name: string]: CrosspointShadowFlow },
        data: { [name: string]: CrosspointShadowFlow },
        websocket: { [name: string]: CrosspointShadowFlow },
        mqtt: { [name: string]: CrosspointShadowFlow },
        unknown: { [name: string]: CrosspointShadowFlow },
    },
    
  }
export interface CrosspointShadowState {
    devices: {
        [name: string]: CrosspointShadowDevice
    }

}


