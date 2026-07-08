/*
 * NMOS Crosspoint — IS-04 Registration Client
 *
 * Pushes the virtual Node + Device + Sources + Flows + Senders (built by
 * NmosNodeApi) to the configured NMOS registry, then keeps the Node alive
 * with periodic heartbeats. Without this, the registry would never know
 * about virtual senders even though /x-nmos/... is being served — other
 * controllers can't query a Node they were never told about.
 *
 * Lifecycle:
 *
 *   start()           — POST node → device → sources → flows → senders,
 *                       then begin the heartbeat loop.
 *   syncResources()   — re-POST every resource (used after the operator
 *                       saves a settings change so renames/SDP updates land).
 *   stop()            — DELETE the node (registry deletes its children
 *                       automatically) and stop the heartbeat. Used when
 *                       the live-registry-switch tears the old registry
 *                       down before bringing the new one up.
 *
 * The registry URL is read from settings.staticNmosRegistries[0]. We only
 * publish to that one; the rest of NMOS Crosspoint already prefers the
 * static registry over anything mDNS discovers.
 *
 * On 404 from a heartbeat we treat the Node as forgotten by the registry
 * and re-POST everything from scratch.
 */

import { NmosNodeApi } from "./NmosNodeApi";
import { SyncLog } from "../syncLog";

const axios = require("axios");

export class NmosNodeRegistration {
    public static instance: NmosNodeRegistration | null = null;

    private settings:any;
    private heartbeatTimer:any = null;
    private heartbeatMs = 5000;
    // How many heartbeat ticks between safety re-syncs of all resources.
    // 12 ticks × 5 s = 60 s. The safety sync catches drift scenarios where
    // the heartbeat is healthy (node present) but the registry has lost or
    // never received some of our dependent resources — without this we'd
    // be stuck POSTing nothing because 404 is never returned on
    // /health/nodes/<id>.
    private safetyResyncEveryNTicks = 12;
    // Generation counter — bumped on stop() / settings change so a stray
    // re-POST after the registry was torn down doesn't undo the teardown.
    private gen = 0;
    private running = false;
    // Set while a syncResources() is mid-flight so concurrent triggers
    // (heartbeat 404 + safety re-sync + setupConfig POST) don't interleave
    // two POST sequences against the same registry.
    private syncInFlight = false;

    // IDs we last POSTed to the registry, so syncResources() can DELETE
    // entries that disappeared from settings.virtualSenders.
    private lastSenderIds: Set<string> = new Set();
    private lastFlowIds:   Set<string> = new Set();
    private lastSourceIds: Set<string> = new Set();

    constructor(settings:any){
        this.settings = settings;
        NmosNodeRegistration.instance = this;
    }

    public setSettings(settings:any){
        this.settings = settings;
    }

    /** Build the registry base URL ("http://ip:port") from settings, or "" if none. */
    private registryBase(): string {
        try{
            let list = this.settings?.staticNmosRegistries;
            if(!Array.isArray(list) || list.length === 0) return "";
            let r = list[0];
            if(!r || !r.ip || !r.port) return "";
            return "http://" + r.ip + ":" + r.port;
        }catch(e){}
        return "";
    }

    private apiBase(): string {
        let base = this.registryBase();
        return base ? (base + "/x-nmos/registration/v1.3") : "";
    }


    /** POST every resource (node first, then dependents). Idempotent — the
     *  registry treats a re-POST of an existing resource as an update.
     *
     *  Only runs when `settings.virtualNode.enabled` is explicitly true —
     *  the feature is opt-in (default off in parseSettings).
     */
    public async start(){
        if(this.running) return;
        if(this.settings?.virtualNode?.enabled !== true){
            SyncLog.log("info", "NMOS Node Registration", "Virtual Node feature disabled in settings — skipping registration.");
            return;
        }
        this.running = true;
        this.gen++;
        let myGen = this.gen;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url){
            SyncLog.log("warn", "NMOS Node Registration", "No registry configured / NmosNodeApi missing — not registering.");
            this.running = false;
            return;
        }
        let resources = api.getResources();
        if(!resources.node){
            SyncLog.log("warn", "NMOS Node Registration", "No node resource built — skipping registration.");
            this.running = false;
            return;
        }

        SyncLog.log("info", "NMOS Node Registration", "Registering virtual Node + " + resources.senders.length + " sender(s) on " + url);

        // POST the node first AND start the heartbeat right after — the
        // registry expires the node after ~12 s without a heartbeat, and
        // POSTing all dependent resources for a large virtualSenders list
        // can take longer than that on a slow link. Starting the heartbeat
        // before the dependent POSTs keeps the TTL fresh and prevents the
        // "node disappears mid-registration" failure mode.
        let nodePosted = false;
        try{
            await this.postResource(url, "node", resources.node);
            nodePosted = true;
        }catch(e:any){
            SyncLog.log("error", "NMOS Node Registration", "Initial node POST failed (heartbeat 404 path will retry): " + (e?.message || e));
        }

        if(myGen !== this.gen) return;   // stop() was called mid-flight
        this.scheduleHeartbeat(myGen);

        // Best-effort POST of the dependent resources. Individual failures
        // are logged but don't abort the rest — the periodic safety re-sync
        // inside the heartbeat will refill any gaps that the registry has.
        try{
            if(nodePosted){
                await this.postResource(url, "device", resources.device);
                for(let s of resources.sources) await this.postResource(url, "source", s);
                for(let f of resources.flows)   await this.postResource(url, "flow",   f);
                for(let s of resources.senders) await this.postResource(url, "sender", s);
                this.snapshotIds(resources);
            }
        }catch(e:any){
            SyncLog.log("warn", "NMOS Node Registration", "Dependent-resource POST failed during initial registration (safety re-sync will retry): " + (e?.message || e));
        }
    }


    /** Remember which IDs we last published, so the next syncResources()
     *  can DELETE the ones that have since disappeared from settings. */
    private snapshotIds(resources:any){
        this.lastSenderIds = new Set(resources.senders.map((s:any) => s.id));
        this.lastFlowIds   = new Set(resources.flows.map((f:any) => f.id));
        this.lastSourceIds = new Set(resources.sources.map((s:any) => s.id));
    }


    /** Re-POST every resource AND DELETE any whose id has since disappeared
     *  from settings. Cheaper than a stop()+start() round-trip and is what
     *  we want when the operator added/removed/renamed a virtual sender,
     *  or when the periodic safety re-sync inside the heartbeat fires.
     *
     *  Guarded by `syncInFlight` so the three callers (heartbeat 404,
     *  periodic safety re-sync, setupConfig POST) can't interleave two
     *  POST sequences against the same registry.
     */
    public async syncResources(){
        if(!this.running){
            return this.start();
        }
        if(this.syncInFlight) return;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url) return;
        let resources = api.getResources();
        if(!resources.node) return;

        this.syncInFlight = true;
        let myGen = this.gen;
        try{
            // 1) DELETE resources that vanished between this sync and the
            //    last successful publication. Order matters: senders before
            //    flows before sources (children before parents).
            let nowSenders = new Set(resources.senders.map((s:any) => s.id));
            let nowFlows   = new Set(resources.flows.map((f:any) => f.id));
            let nowSources = new Set(resources.sources.map((s:any) => s.id));
            for(let id of Array.from(this.lastSenderIds)){
                if(!nowSenders.has(id)) await this.deleteResource(url, "senders", id);
            }
            for(let id of Array.from(this.lastFlowIds)){
                if(!nowFlows.has(id)) await this.deleteResource(url, "flows", id);
            }
            for(let id of Array.from(this.lastSourceIds)){
                if(!nowSources.has(id)) await this.deleteResource(url, "sources", id);
            }

            // 2) POST every currently-known resource (idempotent → update).
            //    Node FIRST — if it's missing in the registry, every
            //    dependent POST below would return 404 otherwise.
            await this.postResource(url, "node", resources.node);
            await this.postResource(url, "device", resources.device);
            for(let s of resources.sources) await this.postResource(url, "source", s);
            for(let f of resources.flows)   await this.postResource(url, "flow",   f);
            for(let s of resources.senders) await this.postResource(url, "sender", s);

            this.snapshotIds(resources);
            if(myGen !== this.gen) return;
            SyncLog.log("info", "NMOS Node Registration", "Re-synchronised virtual sender resources to registry.");
        }catch(e:any){
            SyncLog.log("warn", "NMOS Node Registration", "Sync failed: " + (e?.message || e));
        }finally{
            this.syncInFlight = false;
        }
    }


    /** DELETE every resource and stop the heartbeat. Order matters: the
     *  registry rejects DELETEs of resources that still have dependents.
     *
     *  We clear the heartbeat interval BEFORE we begin DELETEing so an
     *  in-flight heartbeat tick can't 404 and re-register everything we're
     *  about to take down. The gen bump is a belt-and-braces extra check
     *  inside the timer callback.
     */
    public async stop(){
        if(!this.running) return;
        if(this.heartbeatTimer){
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.running = false;
        this.gen++;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url) return;
        let resources = api.getResources();

        try{
            for(let s of resources.senders) await this.deleteResource(url, "senders", s.id);
            for(let f of resources.flows)   await this.deleteResource(url, "flows",   f.id);
            for(let s of resources.sources) await this.deleteResource(url, "sources", s.id);
            if(resources.device)            await this.deleteResource(url, "devices", resources.device.id);
            if(resources.node)              await this.deleteResource(url, "nodes",   resources.node.id);
            SyncLog.log("info", "NMOS Node Registration", "Deregistered virtual Node + resources from registry.");
        }catch(e:any){
            // Most likely the registry is already gone — that's fine, the
            // resources expire on their own without a heartbeat anyway.
            SyncLog.log("verbose", "NMOS Node Registration", "Cleanup DELETE on tear-down: " + (e?.message || e));
        }
        this.lastSenderIds.clear();
        this.lastFlowIds.clear();
        this.lastSourceIds.clear();
    }


    private async postResource(url:string, type:string, data:any){
        let resp = await axios.post(url + "/resource", { type, data });
        if(resp.status !== 200 && resp.status !== 201){
            throw new Error("Unexpected status " + resp.status + " on POST /resource type=" + type);
        }
    }

    private async deleteResource(url:string, plural:string, id:string){
        try{
            await axios.delete(url + "/resource/" + plural + "/" + id);
        }catch(e:any){
            // 404 == not there, that's fine.
            if(e?.response?.status !== 404){
                throw e;
            }
        }
    }


    private scheduleHeartbeat(myGen:number){
        let tickCount = 0;
        if(this.heartbeatTimer){ clearInterval(this.heartbeatTimer); }
        this.heartbeatTimer = setInterval(async () => {
            if(myGen !== this.gen) return;
            let api = NmosNodeApi.instance;
            let url = this.apiBase();
            if(!api || !url) return;
            let node = api.getNode();
            if(!node) return;

            tickCount++;
            let triggeredResync = false;

            try{
                await axios.post(url + "/health/nodes/" + node.id);
            }catch(e:any){
                if(myGen !== this.gen) return;  // stop() raced us — drop it
                if(e?.response?.status === 404){
                    // Registry forgot the node entirely (restart,
                    // garbage-collect …). Re-publish everything from
                    // scratch — syncResources() itself rechecks this.gen so
                    // a stop() landing between the 404 and the POSTs still
                    // wins.
                    SyncLog.log("warn", "NMOS Node Registration", "Heartbeat returned 404 — re-registering.");
                    this.syncResources().catch(()=>{});
                    triggeredResync = true;
                }
                // Any other error: just try again next tick.
            }

            // Safety re-sync. Without this, if /health/nodes returns 200
            // (node is healthy) but the registry has lost or never
            // received one of our dependent resources (device, source,
            // flow, sender — happens when a partial registration was
            // interrupted, or the registry garbage-collected stale
            // resources), we would never notice. POSTs are idempotent, so
            // running syncResources every safetyResyncEveryNTicks ticks is
            // cheap and self-healing.
            if(!triggeredResync && tickCount % this.safetyResyncEveryNTicks === 0){
                SyncLog.log("verbose", "NMOS Node Registration", "Periodic safety re-sync of all resources.");
                this.syncResources().catch(()=>{});
            }
        }, this.heartbeatMs);
    }
}
