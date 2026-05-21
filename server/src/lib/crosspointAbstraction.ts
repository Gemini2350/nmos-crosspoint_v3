import { SyncObject } from "./SyncServer/syncObject";
import { LoggedError, SyncLog } from "./syncLog";
import { error } from "console";
import { NmosRegistryConnector } from "./nmosConnector";
import { MulticastLeaseManager } from "./multicastLeaseManager";
import { DnsPushService } from "./dnsPushService";

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
            let data = JSON.parse(message);
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

        this.startWorker();

        


        if(CrosspointAbstraction.instance == null){
            CrosspointAbstraction.instance = this;
        }
        this.syncCrosspoint = new SyncObject("crosspoint", this.crosspointState);
        this.update();
    }

    nmosState : any = null;

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
                    if(MulticastLeaseManager.instance && Array.isArray(data?.legs)){
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
                            // If no lease exists (auto-allocation disabled), we
                            // leave the user's value untouched.
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
                            if(DnsPushService.instance && typeof dev.id === "string" && dev.id.startsWith("nmos_")){
                                let nmosDevId = dev.id.slice(5);
                                let nmosDev:any = this.nmosState?.devices?.[nmosDevId];
                                if(nmosDev && nmosDev.node_id){
                                    DnsPushService.instance.removeNode(nmosDev.node_id).catch(()=>{});
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


    changeAlias(id:string, alias:string){
        return new Promise((resolve, reject) => {
            this.worker.postMessage(JSON.stringify({
                changeAlias:{id:id, alias:alias}
            }));

            // DNS Push: re-push the affected node so its host_override on the
            // pfSense DNS forwarder picks up the new alias straight away,
            // without waiting for the next NMOS node update. Empty alias
            // falls back to the node label.
            try{
                if(DnsPushService.instance){
                    let targets = this.resolveDnsNodesForCrosspointId(id);
                    for(let t of targets){
                        let displayName = (alias && alias.trim()) ? alias.trim() : (t.nodeLabel || "");
                        if(t.nodeIp && displayName){
                            DnsPushService.instance.scheduleNodePush(t.nodeId, displayName, t.nodeIp);
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
        this.update();
    }

    update(){
        this.worker.postMessage(JSON.stringify({
            nmosState:this.nmosState,
        }))
    }

    updateReturn(data:any){
        if(data.hasOwnProperty("crosspointState")){
            this.crosspointState = data.crosspointState;
            this.syncCrosspoint.setState(this.crosspointState);
        }

        if(data.hasOwnProperty("log")){
            SyncLog.log(data.log.severity, data.log.topic, data.log.text, data.log.raw);
        }

        if(data.hasOwnProperty("nmosSetMulticast")){
            NmosRegistryConnector.instance.setFlowMulticast(data.nmosSetMulticast.nmosId,data.nmosSetMulticast.multicast);
        }
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
    bitrate:CrosspointFlowBitrate
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
    
  }
export interface CrosspointState {
    devices: CrosspointDevice[]
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


