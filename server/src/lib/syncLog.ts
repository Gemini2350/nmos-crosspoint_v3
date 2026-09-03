/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import * as WebSocket from "ws";
import axios from "axios";
import { SyncObject } from "./SyncServer/syncObject";
import { Subject } from "rxjs";
import { WebsocketClient } from "./SyncServer/websocketClient";

export class SyncLog extends SyncObject {
    static instance: SyncLog;


    static error(topic: string,text: string, raw: any= null) {
        return SyncLog.log("error",  topic,text, raw);
    }
    static warning(topic: string,text: string, raw: any= null) {
        return SyncLog.log("warning",  topic,text, raw);
    }
    static info(topic: string,text: string, raw: any= null) {
        return SyncLog.log("info",  topic,text, raw);
    }
    static debug(topic: string,text: string, raw: any= null) {
        return SyncLog.log("debug",  topic,text, raw);
    }
    static verbose(topic: string,text: string, raw: any= null) {
        return SyncLog.log("verbose",  topic,text, raw);
    }

    
    // Canonical severity names as the UI knows them. Call sites across the
    // codebase are inconsistent ("warn" vs "warning") — normalising HERE
    // means the log stream only ever carries the canonical set, so the UI
    // filter and badge logic can rely on exact matches. Anything unknown
    // falls back to "info" instead of shipping an unfilterable category.
    private static normaliseSeverity(severity: string): string {
        switch (("" + severity).toLowerCase().trim()) {
            case "error":    return "error";
            case "warn":
            case "warning":  return "warning";
            case "success":  return "success";
            case "info":     return "info";
            case "verbose":  return "verbose";
            case "debug":    return "debug";
            default:         return "info";
        }
    }

    // Resolves an NMOS uuid to something a human reads ("Node - Device - TX
    // Cam 1"). Registered by CrosspointAbstraction, which owns the labels
    // (including the aliases set in the UI). Every log line in the process
    // funnels through log(), the worker's included, so this one hook names
    // the ids everywhere.
    static idResolver: ((id:string)=>string|null) | null = null;

    private static resolveIds(text: string): string {
        if(!SyncLog.idResolver || !text){ return text; }
        try{
            const re = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
            let appended: string[] = [];
            let out = text.replace(re, (m: string, offset: number) => {
                let name = SyncLog.idResolver(m);
                if(!name){ return m; }
                // Inside a URL the name would break the path, so those ids
                // keep their place and the name is appended to the line.
                let before = offset > 0 ? text[offset - 1] : "";
                let after  = text[offset + m.length] || "";
                if(before === "/" || after === "/"){
                    if(!appended.includes(name)){ appended.push(name); }
                    return m;
                }
                return m + " (" + name + ")";
            });
            return appended.length > 0 ? (out + " · " + appended.join(" · ")) : out;
        }catch(e){
            return text;
        }
    }

    static log(severity: string,  topic: string,text: string, raw: any= null) {
        severity = SyncLog.normaliseSeverity(severity);
        text = SyncLog.resolveIds(text);
        let time = new Date().getTime();
        let date = new Date(time).toISOString();

        
        if(SyncLog.consoleDebug || severity == "error"){
            console.log(date + "  -  " +severity + " " + topic +"  -  " + text);
            if(raw){
                console.log(JSON.stringify(raw,null,2));
            }
            
        }

        
        if (SyncLog.instance) {
            let id = SyncLog.instance.lastLogId++;
            SyncLog.instance.pushMessage(id, time, severity,topic, text,  raw);
            return id;
        } else {
            return -1;
        }
    }

    constructor() {
        super("log");
        this.setState({logList:[],lastLogId:0})
        SyncLog.consoleDebug = true;
        SyncLog.instance = this;

    }

    setOutput(active:boolean){
        SyncLog.consoleDebug = active;
    }

    private static logFile = "";
    private static consoleDebug = false;
    

    limitHistory = 200;
    limitHistoryMem = 20000;
    logHistory = [];
    lastLogId = 0;
    

    readState(objectId) {
        objectId = "" + objectId;
        if (!this.startReadState(objectId)) {
            return;
        }
        this.endReadState(objectId, { logList: [], lastLogId: 0 });
    }
    pushMessage(id:number, time:number, severity: string, topic: string, text: string,  raw: any) {
            let message = {
                id:id,
                time: time,
                severity,
                text,
                topic,
                raw,
            };

            this.logHistory.push(message);
            if (this.logHistory.length > this.limitHistoryMem) {
                this.logHistory.shift();
            }

            // Explicit patch instead of setState(). setState deep-cloned the
            // whole buffer, diffed it against the previous copy and cloned it
            // again — and once the buffer was full the shift() re-indexed the
            // array, so EVERY line produced a ~200-operation patch to every
            // client. The two ops below describe the same change exactly.
            let live: any = this.getState();
            if(!live || !Array.isArray(live.logList)){
                // First message before readState ran — fall back to a full set.
                this.setState({ logList: [message], lastLogId: message.id });
                return;
            }
            let patch: any[] = [{ op: "add", path: "/logList/-", value: message }];
            if (live.logList.length + 1 > this.limitHistory) {
                patch.push({ op: "remove", path: "/logList/0" });
            }
            // "add" on an object member replaces an existing value and
            // creates a missing one — readState() seeds logList only.
            patch.push({ op: "add", path: "/lastLogId", value: message.id });
            this.patchState(patch);
    }
}

export class LoggedError extends Error {
    constructor(msg: string, logId:number|string = "") {
        super(msg);

        this.logId = ""+logId
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, LoggedError.prototype);
    }
    logId:string = "";
}
