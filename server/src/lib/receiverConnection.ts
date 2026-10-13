/*
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import * as sdpTransform from 'sdp-transform';

// ----- What a receiver is connected to, in the device's own words -----
// The matrix draws a connection from the receiver's IS-04 subscription:
// active, and the sender it names. Some devices keep receiving after a
// reboot (they restore their IS-05 transport parameters) but come back with
// no sender_id in the registry, so the picture runs and the matrix shows
// nothing. For a receiver whose registry entry names no sender we read its
// IS-05 /active from the device and work out what it receives:
//
//  - master_enable true and a sender_id: connected to that sender (the
//    registry has not caught up, or the device does not report it there) —
//    unless a leg it receives is positively another sender's stream.
//  - master_enable true, no sender_id, but multicast groups: connected to the
//    one ACTIVE known sender that sends exactly these (group, port, source).
//    Several, none, or only inactive ones: no connection is drawn, the note
//    says what it receives.
//  - master_enable false: nothing.
//
// What is worked out here is shown, never acted on: the server re-takes only
// connections the registry names (CrosspointAbstraction.reconnectReceiversOfSender).
//
// Nothing here is remembered across restarts: what is shown is what the
// device says now, so a route made outside the crosspoint shows up as such.

export interface ReceiverLeg {
    group: string|null,
    port: number|null,
    source: string|null,
    enabled: boolean
}

export interface ReceiverConnection {
    // The IS-04 version of the receiver this was read for. A newer version
    // means the receiver changed since, and the reading is dropped.
    is04Version: string,
    readAt: number,
    masterEnable: boolean,
    senderId: string|null,
    legs: ReceiverLeg[]
}

export interface DerivedConnection {
    // "device": the device's IS-05 names the sender. "stream": matched by the
    // multicast it receives. "": receiving, but no single sender matches.
    via: "device"|"stream"|"",
    senderId: string,
    note: string,
    // Changes whenever what is shown changes — for the log.
    key: string
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IP address from an IS-05 field or an SDP c= line ("239.1.1.1/64"),
 *  or null for "auto", null, 0.0.0.0 and anything else that names none. */
export function cleanIp(v:any):string|null{
    if(typeof v !== "string"){ return null; }
    let s = v.trim().split(/[\s/]/)[0];
    if(IPV4.test(s)){
        return (s === "0.0.0.0") ? null : s;
    }
    if(s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s)){
        return s.toLowerCase();
    }
    return null;
}

export function isMulticast(ip:string|null):boolean{
    if(!ip){ return false; }
    let m = IPV4.exec(ip);
    if(m){
        let first = Number(m[1]);
        return first >= 224 && first <= 239;
    }
    return ip.startsWith("ff");
}

function cleanPort(v:any):number|null{
    return (typeof v === "number" && v > 0) ? v : null;
}

function sdpMedia(sdp:any, index:number):{ group:string|null, port:number|null, source:string|null }{
    let m = sdp && Array.isArray(sdp.media) ? sdp.media[index] : null;
    if(!m){ return { group: null, port: null, source: null }; }
    let group = cleanIp(m.connection?.ip ?? sdp.connection?.ip);
    let source = cleanIp(m.sourceFilter?.srcList ?? sdp.sourceFilter?.srcList);
    return {
        group: isMulticast(group) ? group : null,
        port: cleanPort(m.port),
        source
    };
}

/** "auto", or not there at all: the device leaves it open. null is a value
 *  ("no multicast", "any source") and is not filled in. */
function leftOpen(v:any):boolean{
    return v === undefined || v === "auto";
}

/** The receiver's IS-05 /active, boiled down to what matching needs. Each
 *  leg takes its values from transport_params. The transport file — which a
 *  device keeps from its last activation, whatever came after — only fills
 *  fields they leave open, and port and source only from an SDP leg on the
 *  same group. */
export function receiverConnectionOf(active:any, is04Version:string, now = Date.now()):ReceiverConnection{
    let tps:any[] = (active && Array.isArray(active.transport_params)) ? active.transport_params : [];
    let sdp:any = null;
    try{
        let data = active?.transport_file?.data;
        if(typeof data === "string" && data.length > 10){ sdp = sdpTransform.parse(data); }
    }catch(e){ sdp = null; }
    let count = tps.length > 0 ? tps.length : (sdp && Array.isArray(sdp.media) ? sdp.media.length : 0);
    let legs:ReceiverLeg[] = [];
    for(let i = 0; i < count; i++){
        let tp = tps[i] || {};
        let fromSdp = sdpMedia(sdp, i);
        let group = cleanIp(tp.multicast_ip);
        if(!isMulticast(group)){
            group = leftOpen(tp.multicast_ip) ? fromSdp.group : null;
        }
        let sdpAgrees = group !== null && fromSdp.group === group;
        legs.push({
            group,
            port: cleanPort(tp.destination_port) ?? (sdpAgrees ? fromSdp.port : null),
            source: cleanIp(tp.source_ip) ?? (sdpAgrees && leftOpen(tp.source_ip) ? fromSdp.source : null),
            enabled: tp.rtp_enabled !== false
        });
    }
    return {
        is04Version: "" + (is04Version ?? ""),
        readAt: now,
        masterEnable: !!(active && active.master_enable === true),
        senderId: (active && typeof active.sender_id === "string" && active.sender_id) ? active.sender_id : null,
        legs
    };
}

/** Whether the reading shows the receiver taking a stream at all. */
export function isReceiving(conn:ReceiverConnection|null|undefined):boolean{
    return !!conn && conn.masterEnable && (!!conn.senderId || conn.legs.some((l) => l.enabled && !!l.group));
}

export interface SenderStream {
    senderId: string,
    port: number|null,
    source: string|null,
    // The sender is on. True also when nothing says either way (no IS-04
    // subscription below v1.2, no /active read): unknown is not "off".
    active: boolean,
    // The leg itself is on (rtp_enabled). An off leg still says where the
    // sender is set to send — enough to back a sender_id the device names,
    // not enough to match a stream.
    enabled: boolean
}

export interface SenderStreams {
    byGroup: Map<string, SenderStream[]>
}

/** Every known sender's multicast legs, by group. From the sender's IS-05
 *  /active where we have it — a leg it leaves at "auto" from its SDP — and
 *  from its SDP otherwise. */
export function senderStreamIndex(nmosState:any):SenderStreams{
    let byGroup:Map<string, SenderStream[]> = new Map();
    let senders = nmosState?.senders || {};
    for(let senderId of Object.keys(senders)){
        let s = senders[senderId];
        let act = nmosState.senderActiveData?.[senderId];
        let sdp = nmosState.sendersManifestDetail?.[senderId];
        // Either side saying "on" counts: the cached /active can lag behind
        // an activation the registry already shows, and the other way round.
        let is04 = s?.subscription?.active;
        let is05 = act ? act.master_enable : undefined;
        let active = is04 === true || is05 === true || (typeof is04 !== "boolean" && typeof is05 !== "boolean");
        let legs:Array<{ group:string|null, port:number|null, source:string|null, enabled:boolean }> = [];
        if(act && Array.isArray(act.transport_params)){
            act.transport_params.forEach((tp:any, i:number)=>{
                if(!tp){ return; }
                let enabled = tp.rtp_enabled !== false;
                let group = cleanIp(tp.destination_ip);
                if(isMulticast(group)){
                    legs.push({ group, port: cleanPort(tp.destination_port), source: cleanIp(tp.source_ip), enabled });
                }else if(leftOpen(tp.destination_ip)){
                    legs.push({ ...sdpMedia(sdp, i), enabled });
                }
            });
        }else{
            let n = (sdp && Array.isArray(sdp.media)) ? sdp.media.length : 0;
            for(let i = 0; i < n; i++){ legs.push({ ...sdpMedia(sdp, i), enabled: true }); }
        }
        for(let leg of legs){
            if(!leg.group){ continue; }
            if(!byGroup.has(leg.group)){ byGroup.set(leg.group, []); }
            byGroup.get(leg.group)!.push({ senderId, port: leg.port, source: leg.source, active, enabled: leg.enabled });
        }
    }
    return { byGroup };
}

function legMatches(leg:ReceiverLeg, e:SenderStream):boolean{
    if(leg.port !== null && e.port !== null && e.port !== leg.port){ return false; }
    if(leg.source && e.source && e.source !== leg.source){ return false; }
    return true;
}

/** What to show for a receiver whose registry entry names no sender. */
export function deriveReceiverConnection(conn:ReceiverConnection|null|undefined, streams:SenderStreams,
                                         labelOf:(senderId:string) => string = (id) => id):DerivedConnection|null{
    if(!conn || !conn.masterEnable){ return null; }
    let legs = conn.legs.filter((l) => l.enabled && !!l.group);
    let where = legs.map((l) => l.group + (l.port !== null ? ":" + l.port : "")).join(" + ");

    if(conn.senderId){
        // The device names its sender. Believed unless a leg it receives is
        // positively someone else's: another sender sends exactly that
        // stream, and the named one is not set to it (not even on a leg it
        // has switched off). Then the sender_id is a leftover and the stream
        // decides. A group nobody is known to send proves nothing.
        let named = conn.senderId;
        let contradicts = legs.some((leg) => {
            let here = (streams.byGroup.get(leg.group as string) || []).filter((e) => legMatches(leg, e));
            return !here.some((e) => e.senderId === named) && here.some((e) => e.enabled && e.senderId !== named);
        });
        if(!contradicts){
            return {
                via: "device",
                senderId: named,
                note: "Read from the device: the registry does not name the sender.",
                key: "device:" + named
            };
        }
    }
    if(legs.length === 0){ return null; }

    // A sender matches when it sends every leg the receiver takes.
    let candidates:Set<string>|null = null;
    let activeOf:Map<string, boolean> = new Map();
    for(let leg of legs){
        let ids:Set<string> = new Set();
        for(let e of streams.byGroup.get(leg.group as string) || []){
            if(!e.enabled || !legMatches(leg, e)){ continue; }
            ids.add(e.senderId);
            activeOf.set(e.senderId, e.active || !!activeOf.get(e.senderId));
        }
        candidates = (candidates === null) ? ids : new Set(Array.from(candidates).filter((id) => ids.has(id)));
    }
    let list = Array.from(candidates || []);
    // Only a sender that is on can be what the receiver gets.
    let on = list.filter((id) => activeOf.get(id));
    let names = (ids:string[]) => ids.slice(0, 5).map((id) => "\"" + labelOf(id) + "\"").join(", ") + (ids.length > 5 ? ", …" : "");
    let named = conn.senderId ? " The device names \"" + labelOf(conn.senderId) + "\", which does not send this." : "";
    if(on.length === 1){
        return {
            via: "stream",
            senderId: on[0],
            note: "Matched by stream " + where + ": the device does not name its sender." + named,
            key: "stream:" + on[0] + "@" + where
        };
    }
    if(on.length > 1){
        return {
            via: "",
            senderId: "",
            note: "Receives " + where + ": sent by " + on.length + " senders (" + names(on) + ")." + named,
            key: "ambiguous@" + where + ":" + on.sort().join(",")
        };
    }
    if(list.length > 0){
        return {
            via: "",
            senderId: "",
            note: "Receives " + where + ": only inactive senders are set to it (" + names(list) + ")." + named,
            key: "inactive@" + where + ":" + list.sort().join(",")
        };
    }
    return { via: "", senderId: "", note: "Receives " + where + ": no known sender sends this." + named, key: "unknown@" + where };
}
