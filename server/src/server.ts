/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/


const fs = require("fs");

import {MdnsService} from "./lib/mdnsService"

import { SyncLog } from "./lib/syncLog";


import { NmosRegistryConnector } from "./lib/nmosConnector";
import { WebsocketClient } from "./lib/SyncServer/websocketClient";

import { WebsocketSyncServer } from "./lib/SyncServer/websocketSyncServer";
import { CrosspointAbstraction } from "./lib/crosspointAbstraction";
import { Topology } from "./lib/topology";
import { MediaDevices } from "./lib/mediaDevices";
import { SyncObject } from "./lib/SyncServer/syncObject";
import { parseSettings } from "./lib/parseSettings";
import { MulticastLeaseManager } from "./lib/multicastLeaseManager";




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

WebsocketSyncServer.init(serverAddress, serverPort);
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


// TODO.... load dynamic....
const mediaDevices = new MediaDevices(settings);

const crosspoint = new CrosspointAbstraction(settings);
const nmosConnector = new NmosRegistryConnector(settings);
const multicastLeaseManager = new MulticastLeaseManager(settings);

function getMulticastLeaseSnapshot() {
    return {
        leases: multicastLeaseManager.getAllLeases(),
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




server.addSyncObject("log","global",log);

server.addSyncObject("nmos","global",nmosConnector.syncNmos);
server.addSyncObject("nmosConnectionState","global",nmosConnector.syncConnectionState);

server.addSyncObject("crosspoint","global",crosspoint.syncCrosspoint);


let topology = null;
if(modDisabled.includes["topology"]){
    SyncLog.info("server", "disabling module topology");
}else{
    topology = new Topology();
}


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
    let multicastRanges = {
        audioLow:  (settings.multicastRanges && typeof settings.multicastRanges.audioLow  === "string") ? settings.multicastRanges.audioLow  : "",
        audioHigh: (settings.multicastRanges && typeof settings.multicastRanges.audioHigh === "string") ? settings.multicastRanges.audioHigh : "",
        video:     (settings.multicastRanges && typeof settings.multicastRanges.video     === "string") ? settings.multicastRanges.video     : "",
    };
    let autoMulticast = {
        enabled: !!(settings.autoMulticast && settings.autoMulticast.enabled)
    };
    let multicastStats = (MulticastLeaseManager.instance ? MulticastLeaseManager.instance.getStats() : { audioLow:{used:0,total:0}, audioHigh:{used:0,total:0}, video:{used:0,total:0} });

    return {
        registry,
        acceptableGmid: (typeof settings.acceptableGmid === "string") ? settings.acceptableGmid : "",
        vendorProfiles,
        multicastRanges,
        autoMulticast,
        multicastStats,
        restartRequired: false
    };
}
const setupConfigSync: SyncObject = new SyncObject("setupConfig", getSetupConfigState());
server.addSyncObject("setupConfig","public",setupConfigSync);

server.addSyncObject("multicastLeases","global",multicastLeasesSync);

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
                if(postData.multicastRanges && typeof postData.multicastRanges === "object"){
                    let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
                    for(let cat of ["audioLow","audioHigh","video"]){
                        let v = postData.multicastRanges[cat];
                        if(typeof v === "string" && cidrRe.test(v.trim())){
                            next.multicastRanges[cat] = v.trim();
                        }
                    }
                }
                if(postData.autoMulticast && typeof postData.autoMulticast === "object"){
                    if(typeof postData.autoMulticast.enabled === "boolean"){
                        next.autoMulticast.enabled = postData.autoMulticast.enabled;
                    }
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
            settings.acceptableGmid = next.acceptableGmid;
            settings.vendorProfiles = next.vendorProfiles;
            settings.multicastRanges = { ...settings.multicastRanges, ...next.multicastRanges };
            settings.autoMulticast = { enabled: !!next.autoMulticast.enabled };
            try{
                if(MulticastLeaseManager.instance){
                    MulticastLeaseManager.instance.setSettings(settings);
                }
            }catch(e){}

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

            // Publish new state. We can hot-apply the acceptableGmid (cosmetic),
            // but a registry change needs a restart to actually re-open subscriptions.
            next.restartRequired = firstChanged;
            setupConfigSync.setState(next);

            resolve({message:200, data:next});
        }catch(e:any){
            reject({message: "setupConfig failed: " + e.message});
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


