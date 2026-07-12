<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService";
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";
    import sha256 from "js-sha256";

    import { Icon, ExclamationTriangle, CheckCircle, Plus, Trash } from "svelte-hero-icons";

    interface VendorProfile {
      id: string;
      name: string;
      // Comma-separated list of case-insensitive substrings.
      // Any one matching the node label or description triggers a hit.
      labels: string;
      protocol: string;   // "http" | "https"
      port: number;
      path: string;
    }
    interface VirtualSender {
      id: string;
      name: string;
      sdp: string;
    }
    interface LeaseStat { used: number; total: number }
    interface Ddns {
      enabled: boolean;
      server: string;
      port: number;
      zone: string;
      ttl: number;
      keyName: string;
      keySecret: string;      // server NEVER returns the real value
      keySecretSet: boolean;  // server flag: a secret is configured
      keyAlgorithm: string;
    }
    interface VirtualNodeCfg {
      enabled: boolean;
      deviceId?: string;
      nodeId?: string;
    }
    interface SetupConfig {
      registry: { ip:string, port:number };
      acceptableGmid: string;
      vendorProfiles: VendorProfile[];
      virtualSenders: VirtualSender[];
      virtualNode: VirtualNodeCfg;
      multicastRange: string;
      autoMulticast: { enabled: boolean, reconnectReceiversOnSenderChange?: boolean };
      autoActivateInactiveSender: boolean;
      audioMonitor: { enabled: boolean };
      bcp008: { enabled: boolean };
      // pool = the single-range counter; per-cat fields kept for back-compat
      multicastStats: { pool?: LeaseStat, audio?: LeaseStat, video?: LeaseStat };
      ddns: Ddns;
      auth: { users: string[] };
      restartRequired: boolean;
      version?: string;
    }

    let serverState:SetupConfig = {
      registry: { ip: "", port: 80 },
      acceptableGmid: "",
      vendorProfiles: [],
      virtualSenders: [],
      virtualNode: { enabled: false },
      multicastRange: "",
      autoMulticast: { enabled: false, reconnectReceiversOnSenderChange: false },
      autoActivateInactiveSender: false,
      audioMonitor: { enabled: false },
      bcp008: { enabled: true },
      multicastStats: { pool:{used:0,total:0} },
      ddns: { enabled:false, server:"", port:53, zone:"", ttl:300, keyName:"", keySecret:"", keySecretSet:false, keyAlgorithm:"hmac-sha256" },
      auth: { users: [] },
      restartRequired: false
    };

    // Local edit buffer (so typing doesn't fight the sync)
    let formIp:string = "";
    let formPort:string = "80";
    let formGmid:string = "";
    let formProfiles:VendorProfile[] = [];
    let formVirtualSenders:VirtualSender[] = [];
    let formVirtualNodeEnabled:boolean = false;
    let formAutoMulticastEnabled:boolean = false;
    let formReconnectReceivers:boolean = false;
    let formAutoActivateSender:boolean = false;
    let formAudioMonitorEnabled:boolean = false;
    let formBcp008Enabled:boolean = true;
    let formMulticastRange:string = "";

    // Credentials form (independent of the main Save flow. Saved via its own
    // route). The sha256 hashes are computed at submit time so the plaintext
    // never round-trips through the dirty/save buffer.
    let formCredCurrentUser:string = "";
    let formCredCurrentPass:string = "";
    let formCredNewUser:string     = "";
    let formCredNewPass:string     = "";
    let formCredNewPass2:string    = "";
    let credSaving:boolean = false;
    let credError:string   = "";
    let credSuccess:string = "";

    // DDNS (RFC 2136) form state
    let formDdnsEnabled:boolean     = false;
    let formDdnsServer:string       = "";
    let formDdnsPort:string         = "53";
    let formDdnsZone:string         = "";
    let formDdnsTtl:string          = "300";
    let formDdnsKeyName:string      = "";
    let formDdnsKeySecret:string    = "";
    let formDdnsKeySecretSet:boolean = false;
    let formDdnsKeyAlgorithm:string = "hmac-sha256";

    // Live preview of detected devices for the vendor table. The actual
    // list (label / match / url per node) is now built server-side and shipped
    // as crosspointState.detectedDevices. The UI just renders what arrives.
    let detectedDevices:Array<{ id:string, label:string, match:string, url:string }> = [];

    let dirty = false;
    let saving = false;
    let savedFlash = false;
    let saveError = "";

    let sync:Subject<any>;
    let syncLeases:Subject<any>;
    let syncCrosspoint:Subject<any>;
    let syncDnsPushed:Subject<any>;
    // Live inventory of DNS entries currently published to pfSense
    let dnsPushedSnapshot:any = { entries: [], updatedAt: "" };

    // Live lease inventory snapshot: { leases:{[id]:Lease}, stats:..., updatedAt:string }
    // The server enriches each lease with `liveStatus` ("active" / "inactive" /
    // "missing") and `bitrate`, so the UI does not need to walk the NMOS state
    // or the crosspoint state any more.
    let leaseSnapshot:any = { leases:{}, stats:{}, updatedAt:"" };
    let inventoryFilter:string = "";
    let inventoryCategoryFilter:string = "";  // "" / "audio" / "video"

    onMount(() => {
      sync = ServerConnector.sync("setupConfig");
      sync.subscribe((obj:any)=>{
        if(obj && obj.registry){
          serverState = obj;
          // Only overwrite the form when the user hasn't started editing.
          if(!dirty){
            formIp   = obj.registry.ip || "";
            formPort = ""+(obj.registry.port || 80);
            formGmid = obj.acceptableGmid || "";
            formProfiles = Array.isArray(obj.vendorProfiles) ? obj.vendorProfiles.map((p:any) => ({...p})) : [];
            formVirtualSenders = Array.isArray(obj.virtualSenders) ? obj.virtualSenders.map((v:any) => ({...v})) : [];
            formVirtualNodeEnabled = (obj.virtualNode && typeof obj.virtualNode.enabled === "boolean") ? obj.virtualNode.enabled : false;
            formAutoMulticastEnabled = !!(obj.autoMulticast && obj.autoMulticast.enabled);
            // `reconnectReceiversOnSenderChange` default is now FALSE, so we
            // take the stored value as-is (no "!== false" magic).
            formReconnectReceivers   = !!(obj.autoMulticast && (
              obj.autoMulticast.reconnectReceiversOnSenderChange ??
              obj.autoMulticast.reconnectReceiversOnMulticastChange
            ));
            formAutoActivateSender   = !!obj.autoActivateInactiveSender;
            formAudioMonitorEnabled  = !!(obj.audioMonitor && obj.audioMonitor.enabled);
            formBcp008Enabled        = !(obj.bcp008 && obj.bcp008.enabled === false);
            formMulticastRange       = (typeof obj.multicastRange === "string") ? obj.multicastRange : "";
            // Pre-fill the credentials form with the first configured user
            // so the operator doesn't have to type their own username.
            if(obj.auth && Array.isArray(obj.auth.users) && obj.auth.users.length > 0){
              formCredCurrentUser = obj.auth.users[0];
              if(!formCredNewUser){ formCredNewUser = obj.auth.users[0]; }
            }
            if(obj.ddns){
              formDdnsEnabled      = !!obj.ddns.enabled;
              formDdnsServer       = obj.ddns.server || "";
              formDdnsPort         = ""+(obj.ddns.port || 53);
              formDdnsZone         = obj.ddns.zone || "";
              formDdnsTtl          = ""+(obj.ddns.ttl || 300);
              formDdnsKeyName      = obj.ddns.keyName || "";
              formDdnsKeySecret    = "";   // never round-trip the secret
              formDdnsKeySecretSet = !!obj.ddns.keySecretSet;
              formDdnsKeyAlgorithm = obj.ddns.keyAlgorithm || "hmac-sha256";
            }
          }
        }
      });
      syncLeases = ServerConnector.sync("multicastLeases");
      syncLeases.subscribe((obj:any)=>{
        if(obj){ leaseSnapshot = obj; }
      });
      // The crosspoint sync carries the precomputed detectedDevices preview
      // (label / matched-profile / Web-UI URL per NMOS node). Every other
      // derived field the Setup page used to compute on the fly is now
      // attached server-side, so the UI only has to render.
      syncCrosspoint = ServerConnector.sync("crosspoint");
      syncCrosspoint.subscribe((obj:any)=>{
        if(obj){
          detectedDevices = Array.isArray(obj.detectedDevices) ? obj.detectedDevices : [];
        }
      });
      // Inventory of currently-pushed DNS entries (updated by the
      // DnsPushService whenever a push, update or remove succeeds).
      syncDnsPushed = ServerConnector.sync("dnsPushed");
      syncDnsPushed.subscribe((obj:any)=>{
        if(obj){ dnsPushedSnapshot = obj; }
      });
    });

    onDestroy(() => {
      try{sync && sync.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("setupConfig");}catch(e){}
      try{syncLeases && syncLeases.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("multicastLeases");}catch(e){}
      try{syncCrosspoint && syncCrosspoint.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("crosspoint");}catch(e){}
      try{syncDnsPushed && syncDnsPushed.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("dnsPushed");}catch(e){}
    });

    function markDirty(){
      dirty = true;
      savedFlash = false;
      saveError = "";
    }

    function resetForm(){
      formIp   = serverState.registry.ip || "";
      formPort = ""+(serverState.registry.port || 80);
      formGmid = serverState.acceptableGmid || "";
      formProfiles = Array.isArray(serverState.vendorProfiles) ? serverState.vendorProfiles.map((p:any)=>({...p})) : [];
      formVirtualSenders = Array.isArray((serverState as any).virtualSenders) ? (serverState as any).virtualSenders.map((v:any)=>({...v})) : [];
      formVirtualNodeEnabled = (serverState.virtualNode && typeof serverState.virtualNode.enabled === "boolean") ? serverState.virtualNode.enabled : false;
      formAutoMulticastEnabled = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      formReconnectReceivers   = !!(serverState.autoMulticast && (
        (serverState.autoMulticast as any).reconnectReceiversOnSenderChange ??
        (serverState.autoMulticast as any).reconnectReceiversOnMulticastChange
      ));
      formAutoActivateSender   = !!serverState.autoActivateInactiveSender;
      formAudioMonitorEnabled  = !!(serverState.audioMonitor && serverState.audioMonitor.enabled);
      formBcp008Enabled        = !(serverState.bcp008 && serverState.bcp008.enabled === false);
      formMulticastRange       = serverState.multicastRange || "";
      if(serverState.ddns){
        formDdnsEnabled      = !!serverState.ddns.enabled;
        formDdnsServer       = serverState.ddns.server || "";
        formDdnsPort         = ""+(serverState.ddns.port || 53);
        formDdnsZone         = serverState.ddns.zone || "";
        formDdnsTtl          = ""+(serverState.ddns.ttl || 300);
        formDdnsKeyName      = serverState.ddns.keyName || "";
        formDdnsKeySecret    = "";
        formDdnsKeySecretSet = !!serverState.ddns.keySecretSet;
        formDdnsKeyAlgorithm = serverState.ddns.keyAlgorithm || "hmac-sha256";
      }
      dirty = false;
      saveError = "";
    }

    function save(){
      saveError = "";

      let port = parseInt(formPort);
      if(isNaN(port) || port <= 0 || port > 65535){
        saveError = "Port must be between 1 and 65535.";
        return;
      }

      // Sanity-check each profile
      for(let p of formProfiles){
        let pp = parseInt(""+p.port);
        if(isNaN(pp) || pp <= 0 || pp > 65535){
          saveError = "Vendor \""+(p.name||p.id)+"\": Port must be between 1 and 65535.";
          return;
        }
      }

      // Multicast range. Basic CIDR sanity check (single shared pool now)
      let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
      if(formMulticastRange && !cidrRe.test(formMulticastRange.trim())){
        saveError = "Multicast Range must use CIDR notation, e.g. 239.30.0.0/16";
        return;
      }

      // DDNS validation
      let ddnsPort = parseInt(formDdnsPort);
      if(isNaN(ddnsPort) || ddnsPort <= 0 || ddnsPort > 65535){
        saveError = "DDNS: Port must be between 1 and 65535.";
        return;
      }
      let ddnsTtl = parseInt(formDdnsTtl);
      if(isNaN(ddnsTtl) || ddnsTtl <= 0){
        saveError = "DDNS: TTL must be a positive number of seconds.";
        return;
      }
      if(formDdnsEnabled){
        if(!formDdnsServer.trim()){ saveError = "DDNS: DNS server address is required when enabled."; return; }
        if(!formDdnsZone.trim()){ saveError = "DDNS: Zone is required when enabled."; return; }
        // Unsigned mode ("none") needs no TSIG key at all.
        if(formDdnsKeyAlgorithm !== "none"){
          if(!formDdnsKeyName.trim()){ saveError = "DDNS: TSIG key name is required when enabled."; return; }
          if(!formDdnsKeySecretSet && !formDdnsKeySecret){ saveError = "DDNS: TSIG key secret is required when enabled."; return; }
        }
      }

      let payload:any = {
        registry: { ip: formIp.trim(), port: port },
        acceptableGmid: formGmid.trim(),
        vendorProfiles: formProfiles,
        virtualSenders: formVirtualSenders.map(v => ({ id: v.id, name: v.name, sdp: v.sdp })),
        virtualNode: { enabled: formVirtualNodeEnabled },
        multicastRange: formMulticastRange.trim(),
        autoMulticast: {
          enabled: formAutoMulticastEnabled,
          reconnectReceiversOnSenderChange: formReconnectReceivers
        },
        autoActivateInactiveSender: formAutoActivateSender,
        audioMonitor: { enabled: formAudioMonitorEnabled },
        bcp008: { enabled: formBcp008Enabled },
        ddns: {
          enabled:      formDdnsEnabled,
          server:       formDdnsServer.trim(),
          port:         ddnsPort,
          zone:         formDdnsZone.trim(),
          ttl:          ddnsTtl,
          keyName:      formDdnsKeyName.trim(),
          // Empty string means "keep the existing secret" on the server.
          keySecret:    formDdnsKeySecret,
          keyAlgorithm: formDdnsKeyAlgorithm
        }
      };

      // Open the Adopt-vs-Renew modal in two situations:
      //   a) Auto-Allocation just got switched ON for the first time.
      //   b) Auto-Allocation is still on but the operator changed the
      //      multicast CIDR. The current leases may sit outside the new
      //      pool, so the operator must decide whether to keep existing
      //      IPs (adopt) or to re-allocate everyone into the new range.
      let wasEnabled  = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      let nowEnabled  = !!formAutoMulticastEnabled;
      let rangeBefore = (serverState.multicastRange || "").trim();
      let rangeAfter  = formMulticastRange.trim();
      let rangeChanged = nowEnabled && wasEnabled && rangeBefore && rangeAfter && rangeBefore !== rangeAfter;
      let enabledNow   = !wasEnabled && nowEnabled;

      if(enabledNow || rangeChanged){
        pendingPayload = payload;
        if(autoMulticastModal){ autoMulticastModal.showModal(); }
        return;
      }

      doSave(payload);
    }

    function doSave(payload:any){
      saving = true;
      saveError = "";
      ServerConnector.post("setupConfig", payload).then((resp:any)=>{
        saving = false;
        dirty = false;
        savedFlash = true;
        if(resp && resp.data){
          serverState = resp.data;
        }
        setTimeout(()=>{ savedFlash = false; }, 2500);
      }).catch((e:any)=>{
        saving = false;
        saveError = (e && e.message) ? e.message : "Save failed.";
      });
    }


    // ----- Credentials change (independent of the main Save) -----
    // Hashes plaintext locally (sha256), then posts to /changeCredentials.
    // The server validates the current hash against ./config/users.json,
    // renames the user / updates the password as requested, persists,
    // hot-reloads the auth table, and returns the new username.
    function saveCredentials(){
      credError = ""; credSuccess = "";
      if(!formCredCurrentUser.trim()){ credError = "Current username is required."; return; }
      if(!formCredCurrentPass){       credError = "Current password is required."; return; }
      let newUser = formCredNewUser.trim();
      let wantPass = !!formCredNewPass || !!formCredNewPass2;
      if(wantPass){
        if(formCredNewPass !== formCredNewPass2){ credError = "New passwords do not match."; return; }
        if(formCredNewPass.length < 4){ credError = "New password must be at least 4 characters."; return; }
      }
      if(!newUser && !wantPass){ credError = "Nothing to change. Set a new username or a new password."; return; }

      let payload:any = {
        currentUsername:     formCredCurrentUser.trim(),
        currentPasswordHash: sha256.sha256(formCredCurrentPass),
        newUsername:         newUser,
        newPasswordHash:     wantPass ? sha256.sha256(formCredNewPass) : ""
      };
      credSaving = true;
      ServerConnector.post("changeCredentials", payload).then((resp:any)=>{
        credSaving = false;
        credSuccess = "Saved. You will need to log in again with the new credentials.";
        // Wipe the entered passwords from memory.
        formCredCurrentPass = "";
        formCredNewPass     = "";
        formCredNewPass2    = "";
        if(resp?.data?.username){
          formCredCurrentUser = resp.data.username;
          formCredNewUser     = resp.data.username;
        }
        setTimeout(()=>{ credSuccess = ""; }, 6000);
      }).catch((e:any)=>{
        credSaving = false;
        credError = (e && e.message) ? e.message : "Could not change credentials.";
      });
    }


    // ----- Auto-Allocation: Adopt-vs-Reallocate choice -----
    let autoMulticastModal:any;
    let pendingPayload:any = null;
    function autoMcChoose(adopt:boolean){
      if(!pendingPayload){ return; }
      pendingPayload.autoMulticast.adoptOnEnable = adopt;
      let p = pendingPayload;
      pendingPayload = null;
      if(autoMulticastModal){ autoMulticastModal.close(); }
      doSave(p);
    }
    function autoMcCancel(){
      pendingPayload = null;
      if(autoMulticastModal){ autoMulticastModal.close(); }
      // Revert the toggle so the form reflects the actual server state
      formAutoMulticastEnabled = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      saving = false;
    }


    // ----- Vendor table editing -----
    function addProfile(){
      formProfiles = [...formProfiles, {
        id: "v_" + Math.random().toString(36).slice(2,8),
        name: "",
        labels: "",
        protocol: "http",
        port: 80,
        path: "/"
      }];
      markDirty();
    }
    function removeProfile(id:string){
      formProfiles = formProfiles.filter(p => p.id !== id);
      markDirty();
    }


    // ----- Virtual Senders -----
    function addVirtualSender(){
      formVirtualSenders = [...formVirtualSenders, {
        id:   "vs_" + Math.random().toString(36).slice(2,10),
        name: "",
        sdp:  ""
      }];
      markDirty();
    }
    function removeVirtualSender(id:string){
      formVirtualSenders = formVirtualSenders.filter(v => v.id !== id);
      markDirty();
    }


    // ----- Lease inventory derived state -----
    // Each lease is already enriched server-side with liveStatus + bitrate
    // (see server.ts:getMulticastLeaseSnapshot), so the UI just filters and
    // sorts the snapshot. No NMOS / crosspoint walks happen on the client.
    interface LeaseRow {
      senderId: string;
      deviceLabel: string;
      category: string;
      channels: number;
      primaryIp: string;
      secondaryIp: string;
      port: number;
      createdAt: string;
      bitrate: any;
      liveStatus: "active" | "inactive" | "missing";
    }
    let leaseRows:LeaseRow[] = [];
    $: leaseRows = recomputeLeaseRows(leaseSnapshot, inventoryFilter, inventoryCategoryFilter);

    function recomputeLeaseRows(snap:any, filterStr:string, catFilterStr:string):LeaseRow[]{
      let arr:LeaseRow[] = [];
      let raw = snap && snap.leases ? snap.leases : {};
      let needle = (filterStr || "").toLowerCase();
      let catFilter = catFilterStr || "";
      for(let id in raw){
        let l = raw[id];
        if(!l) continue;
        if(catFilter && l.category !== catFilter) continue;
        if(needle){
          let hay = ((l.deviceLabel||"") + " " + id + " " + (l.primaryIp||"") + " " + (l.secondaryIp||"")).toLowerCase();
          if(!hay.includes(needle)) continue;
        }
        arr.push({
          senderId: id,
          deviceLabel: l.deviceLabel || "",
          category: l.category || "",
          channels: l.channels || 0,
          primaryIp: l.primaryIp || "",
          secondaryIp: l.secondaryIp || "",
          port: l.port || 0,
          createdAt: l.createdAt || "",
          bitrate: l.bitrate,
          liveStatus: l.liveStatus || "missing"
        });
      }
      arr.sort((a,b) => {
        if(a.category !== b.category) return a.category.localeCompare(b.category);
        return ipCompare(a.primaryIp, b.primaryIp);
      });
      return arr;
    }

    // Same format as the Details page: "<v>.x Mbit/s" or "-" if unknown.
    function renderBitrate(bitrate:any):string {
      let v:number = 0;
      let hint:string = "ok";
      if(typeof bitrate === "number"){
        v = bitrate;
      }else if(bitrate && typeof bitrate === "object"){
        v = Number(bitrate.v) || 0;
        hint = bitrate.hint || "ok";
      }
      v = Math.round(v*10)/10;
      if(hint === "unknown" || v <= 0){ return "-"; }
      if(v < 1){ return "< 1 Mbit/s"; }
      return v.toFixed(1) + " Mbit/s";
    }
    function ipCompare(a:string, b:string){
      let pa = a.split(".").map(x=>parseInt(x));
      let pb = b.split(".").map(x=>parseInt(x));
      for(let i=0;i<4;i++){
        let av = pa[i]||0, bv = pb[i]||0;
        if(av !== bv) return av - bv;
      }
      return 0;
    }
    function categoryLabel(c:string){
      switch(c){
        case "audio": return "Audio";
        case "video": return "Video";
        default: return c || "-";
      }
    }
    function shortId(id:string){
      if(id.length <= 12) return id;
      return id.slice(0,4) + "…" + id.slice(-6);
    }
    function fmtDate(iso:string){
      if(!iso) return "";
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }


    // ----- Release a single lease from the inventory -----
    // Per user request the confirmation modal is gone. Clicking the trash
    // icon releases the lease immediately. The lease list updates within
    // a tick via the multicastLeases SyncObject.
    let releaseInventoryError:string = "";
    function askReleaseLease(row:LeaseRow){
      if(!row || !row.senderId) return;
      releaseInventoryError = "";
      ServerConnector.post("releaseLease", { senderId: row.senderId })
        .catch((e:any)=>{
          releaseInventoryError = (e && e.message) ? e.message : "Release failed.";
        });
    }

    // ----- Release every lease at once -----
    // No modal. A single click clears the whole pool. The server logs the
    // batch and active senders will be re-allocated on the next reconcile
    // if auto-allocation is enabled.
    let releaseAllBusy:boolean = false;
    let releaseAllStatus:string = "";
    function releaseAllLeases(){
      if(releaseAllBusy) return;
      releaseAllBusy = true;
      releaseAllStatus = "";
      releaseInventoryError = "";
      ServerConnector.post("releaseAllLeases", {}).then((resp:any)=>{
        releaseAllBusy = false;
        let n = (resp?.data?.released ?? 0) | 0;
        releaseAllStatus = (n === 0)
          ? "No leases to release."
          : ("Released " + n + " lease" + (n === 1 ? "" : "s") + ".");
        setTimeout(()=>{ releaseAllStatus = ""; }, 4000);
      }).catch((e:any)=>{
        releaseAllBusy = false;
        releaseInventoryError = (e && e.message) ? e.message : "Release-all failed.";
      });
    }


    // ----- Lease Export / Import -----
    let importError:string = "";
    let importSuccess:string = "";
    function downloadJson(data:any, filename:string){
      try{
        let blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        let url = URL.createObjectURL(blob);
        let a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(()=>URL.revokeObjectURL(url), 1000);
      }catch(e){}
    }
    function exportLeases(){
      importError = ""; importSuccess = "";
      ServerConnector.get("exportLeases").then((resp:any)=>{
        let data = (resp && resp.data) ? resp.data : { version:1, leases:{} };
        let ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(data, "multicast-leases-"+ts+".json");
      }).catch((e:any)=>{
        importError = "Export failed: " + (e?.message || e);
      });
    }
    let importFileInput:any;
    function pickImportFile(){
      importError = ""; importSuccess = "";
      if(importFileInput){ importFileInput.value = ""; importFileInput.click(); }
    }
    function onImportFile(e:any){
      let file:File = e?.target?.files?.[0];
      if(!file) return;
      let reader = new FileReader();
      reader.onload = (ev:any) => {
        try{
          let data = JSON.parse(ev.target.result);
          ServerConnector.post("importLeases", data).then((resp:any)=>{
            let imp = resp?.data?.imported ?? 0;
            let drp = resp?.data?.dropped ?? 0;
            importSuccess = "Imported " + imp + " leases" + (drp > 0 ? " (" + drp + " dropped as duplicates)" : "") + ".";
            setTimeout(()=>{ importSuccess = ""; }, 5000);
          }).catch((err:any)=>{
            importError = "Import failed: " + (err?.message || err);
          });
        }catch(parseErr:any){
          importError = "Invalid JSON: " + parseErr.message;
        }
      };
      reader.readAsText(file);
    }


    // ----- Vendor Profile Export / Import -----
    let vendorImportError:string = "";
    let vendorImportSuccess:string = "";
    let vendorImportFileInput:any;
    function exportVendorProfiles(){
      vendorImportError = ""; vendorImportSuccess = "";
      let payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        vendorProfiles: formProfiles
      };
      let ts = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(payload, "vendor-profiles-"+ts+".json");
    }
    function pickVendorImportFile(){
      vendorImportError = ""; vendorImportSuccess = "";
      if(vendorImportFileInput){ vendorImportFileInput.value = ""; vendorImportFileInput.click(); }
    }
    function onVendorImportFile(e:any){
      let file:File = e?.target?.files?.[0];
      if(!file) return;
      let reader = new FileReader();
      reader.onload = (ev:any) => {
        try{
          let data = JSON.parse(ev.target.result);
          // Accept either { vendorProfiles:[...] } or a raw array
          let arr:any[] = Array.isArray(data) ? data : (Array.isArray(data?.vendorProfiles) ? data.vendorProfiles : null);
          if(!arr){ vendorImportError = "No 'vendorProfiles' array found in file."; return; }

          // Sanitise. Same rules as the server. Generate fresh IDs to avoid
          // accidental collisions with existing entries.
          let cleaned = arr
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
                id: "v_" + Math.random().toString(36).slice(2,8),
                name: (typeof v.name === "string") ? v.name : "",
                labels,
                protocol,
                port,
                path
              };
            });

          formProfiles = cleaned;
          markDirty();
          vendorImportSuccess = "Loaded " + cleaned.length + " profile(s). Press Save to apply.";
          setTimeout(()=>{ vendorImportSuccess = ""; }, 5000);
        }catch(parseErr:any){
          vendorImportError = "Invalid JSON: " + parseErr.message;
        }
      };
      reader.readAsText(file);
    }
</script>


<div class="content-container setup-page">
  <div class="setup-card">
    <h2 class="setup-title">
      Setup
      {#if serverState.version}
        <span class="setup-version">v{serverState.version}</span>
      {/if}
    </h2>
    <p class="setup-subtitle">Edit the most-used NMOS Crosspoint settings. Persists to <code>./config/settings.json</code>.</p>

    {#if serverState.restartRequired}
      <div class="alert alert-warning setup-alert">
        <Icon src={ExclamationTriangle} />
        <span>Registry change pending. Restart the server for the new IP/port to take effect.</span>
      </div>
    {/if}

    {#if savedFlash}
      <div class="alert alert-success setup-alert">
        <Icon src={CheckCircle} />
        <span>Saved to settings.json.</span>
      </div>
    {/if}

    {#if saveError}
      <div class="alert alert-error setup-alert">
        <Icon src={ExclamationTriangle} />
        <span>{saveError}</span>
      </div>
    {/if}

    {#if dirty}
      <div class="alert alert-warning setup-alert">
        <Icon src={ExclamationTriangle} />
        <span>You have unsaved changes. Click the <strong>Save</strong> button at the bottom of the page to persist them to <code>./config/settings.json</code>.</span>
      </div>
    {/if}


    <h2 class="setup-group">Connection</h2>

    <section class="setup-section">
      <h3>NMOS Registry</h3>
      <p class="setup-section-hint">Address of the NMOS registry the server contacts at startup.</p>

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Registry IP</span>
          <input type="text" class="input input-bordered" placeholder="10.0.0.1"
                 bind:value={formIp} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Port</span>
          <input type="number" class="input input-bordered" min="1" max="65535"
                 bind:value={formPort} on:input={markDirty} />
        </label>
      </div>
    </section>


    <section class="setup-section">
      <h3>Acceptable PTP GMID</h3>
      <p class="setup-section-hint">
        Expected PTP Grand-Master ID. Devices whose node clock is locked to this GMID
        get a <span class="setup-dot setup-dot-success"></span> green status dot on the
        Details page, all others get a <span class="setup-dot setup-dot-warning"></span> yellow one.
        Leave empty to disable the comparison.
      </p>

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">GMID</span>
          <input type="text" class="input input-bordered" placeholder="00-00-00-FF-FE-00-00-00"
                 bind:value={formGmid} on:input={markDirty} />
        </label>
      </div>
    </section>


    <h2 class="setup-group">Switching</h2>

    <section class="setup-section">
      <h3>Receiver Auto-Reconnect</h3>
      <p class="setup-section-hint">
        Whenever a sender's SDP changes (Multicast IP / port or like channel count,
        video format, colorimetry) redo the connection of every receiver currently
        subscribed to it so they pick up the new manifest. Recommended ON for
        production. The one-shot „Renew from Pool" sweep in <em>Multicast DHCP</em>
        ignores this setting and always reconnects.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Auto-reconnect receivers on sender SDP change</span>
          <input type="checkbox" class="toggle" bind:checked={formReconnectReceivers} on:change={markDirty} />
        </label>
      </div>
    </section>


    <section class="setup-section">
      <h3>Crosspoint: Auto-Activate Sender</h3>
      <p class="setup-section-hint">
        When a connection is made on the Crosspoint page whose source sender is
        currently <em>inactive</em> (master_enable&nbsp;=&nbsp;false), automatically
        PATCH that sender active first, wait for it to (re)publish its SDP,
        and only then patch the receiver. Off by default. Many control rooms
        have sender activation through a separate workflow and don't want a
        stray click on the matrix to push a sender in transmitting state.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Auto-activate inactive sender on Crosspoint connect</span>
          <input type="checkbox" class="toggle" bind:checked={formAutoActivateSender} on:change={markDirty} />
        </label>
      </div>
    </section>


    <h2 class="setup-group">Monitoring</h2>

    <section class="setup-section">
      <h3>BCP-008 Status Monitoring</h3>
      <p class="setup-section-hint">
        Live health monitoring of senders and receivers via
        <strong>AMWA BCP-008</strong> (IS-12 control protocol): for every
        device that advertises an <code>ncp</code> control endpoint, the
        server subscribes to its NcSender-/NcReceiverMonitors and shows the
        health as a heart symbol per flow in the Crosspoint matrix. With
        the four status domains (Link / Connection / Sync / Stream resp.
        Transmission / Essence), transition counters, a counter reset and
        coloured crosspoints when an endpoint of an active connection
        degrades. Read-only on the network (it never changes device state).
        Devices without BCP-008 support simply show a greyed-out symbol.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable BCP-008 Status Monitoring</span>
          <input type="checkbox" class="toggle" bind:checked={formBcp008Enabled} on:change={markDirty} />
        </label>
      </div>
    </section>


    <section class="setup-section">
      <h3>Audio Monitor (experimental)</h3>
      <p class="setup-section-hint">
        Adds a 🎧 button next to each audio sender on the Details page.
        Clicking it makes the server join that sender's multicast on
        demand, transcode the PCM to Opus 48 kHz stereo and stream it to
        your browser via WebRTC. Useful for quick monitoring without
        needing a dedicated probe receiver. Only one sender is monitored
        at a time per browser tab; multi-channel streams (8 ch / 16 ch
        AES67) expose a channel-pair selector in the player overlay.
        Off by default. The feature costs CPU per active monitor.
        With this toggle off the 🎧 button is hidden entirely.
      </p>
      <details class="setup-more"><summary>More details</summary>
      <p class="setup-section-hint">
        <strong>Network requirement:</strong> the server must have access to
        the multicast / media network to receive the streams (IGMP join on
        the ST&nbsp;2110 VLAN). When running in Docker this means
        <code>--network host</code> (or a macvlan/interface in the media
        VLAN). With the default bridge network the 🎧 button will connect
        but stay silent.
      </p>
      </details>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable Audio Monitor</span>
          <input type="checkbox" class="toggle" bind:checked={formAudioMonitorEnabled} on:change={markDirty} />
        </label>
      </div>
    </section>


    <h2 class="setup-group">Addressing &amp; Integration</h2>

    <section class="setup-section">
      <h3>Multicast DHCP</h3>
      <p class="setup-section-hint">
        When enabled, the server reserves a pair of consecutive multicast addresses per <strong>active</strong> sender
        (odd for Leg 1, even = odd + 1 for Leg 2). The reservation is kept for the lifetime of the
        device. Even if the sender goes offline. And is only released when the device is
        explicitly <em>Forgotten</em> on the Details page or its lease is deleted in the inventory below.
      </p>
      <details class="setup-more"><summary>More details</summary>
      <p class="setup-section-hint">
        <strong>An address is (re-)assigned in two cases:</strong>
      </p>
      </details>
      <ul class="setup-section-bullets">
        <li>when a sender becomes <em>active</em> (its NMOS subscription transitions to active) and has no lease yet;</li>
        <li>when the destination IP of an <em>active</em> sender is cleared. The field on the Details page is emptied or its lease is released here.</li>
      </ul>
      <p class="setup-section-hint">
        Manual overrides on the Details page are respected: typing a different IP marks it as the
        effective address; clearing the field reverts to the reserved address.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable Multicast DHCP</span>
          <input type="checkbox" class="toggle" bind:checked={formAutoMulticastEnabled} on:change={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:14px;">
        <label class="setup-field">
          <span class="setup-label">Multicast Range (single pool for all senders)</span>
          <div class="setup-range-row">
            <input type="text" class="input input-bordered vendor-mono" placeholder="239.30.0.0/16"
                   bind:value={formMulticastRange} on:input={markDirty} />
            <span class="setup-range-stat">{leaseSnapshot.stats?.pool?.used ?? 0} / {leaseSnapshot.stats?.pool?.total ?? 0} pairs used</span>
          </div>
        </label>
      </div>

      <div class="setup-form" style="margin-top:14px; align-items:center;">
        <button class="btn btn-sm" on:click={exportLeases}>Export Leases</button>
        <button class="btn btn-sm" on:click={pickImportFile}>Import Leases…</button>
        <input type="file" accept="application/json,.json" style="display:none;" bind:this={importFileInput} on:change={onImportFile} />
        {#if importSuccess}
          <span class="text-success">{importSuccess}</span>
        {/if}
        {#if importError}
          <span class="text-error">{importError}</span>
        {/if}
      </div>


      <!-- Lease Inventory -->
      <details class="lease-inventory">
        <summary>Lease Inventory ({Object.keys(leaseSnapshot.leases || {}).length})</summary>

        <div class="lease-toolbar">
          <input type="text" class="input input-bordered input-sm" placeholder="Filter by label, sender id, IP…"
                 bind:value={inventoryFilter} />
          <select class="select select-bordered select-sm" bind:value={inventoryCategoryFilter}>
            <option value="">All categories</option>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
          </select>
          <span class="lease-count">{leaseRows.length} shown</span>
          <button class="btn btn-sm btn-error"
                  on:click={releaseAllLeases}
                  disabled={releaseAllBusy || Object.keys(leaseSnapshot.leases || {}).length === 0}
                  title="Release every lease in the pool. Active senders with auto-allocation enabled will receive a fresh pair on the next reconcile.">
            {#if releaseAllBusy}Releasing…{:else}Release all leases{/if}
          </button>
          {#if releaseAllStatus}
            <span class="text-success">{releaseAllStatus}</span>
          {/if}
          {#if releaseInventoryError}
            <span class="text-error">{releaseInventoryError}</span>
          {/if}
        </div>

        <div class="lease-table-wrap">
          <table class="lease-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Category</th>
                <th>Device</th>
                <th>Sender ID</th>
                <th>Leg 1 (primary)</th>
                <th>Leg 2 (secondary)</th>
                <th>Port</th>
                <th>Bitrate</th>
                <th>Allocated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each leaseRows as r (r.senderId)}
                <tr>
                  <td>
                    <span class="lease-status-badge lease-status-{r.liveStatus}"
                          title="{r.liveStatus === 'active' ? 'Sender is registered and currently transmitting' :
                                  r.liveStatus === 'inactive' ? 'Sender is registered but master_enable is false' :
                                                                'Sender is no longer present in the NMOS registry'}">
                      {r.liveStatus === 'active'   ? 'Active'   :
                       r.liveStatus === 'inactive' ? 'Inactive' :
                                                     'Missing'}
                    </span>
                  </td>
                  <td>
                    <span class="lease-cat-badge lease-cat-{r.category}">{categoryLabel(r.category)}</span>
                    {#if r.channels > 0 && r.category !== "video"}
                      <span class="lease-channels">{r.channels}ch</span>
                    {/if}
                  </td>
                  <td>{r.deviceLabel || "-"}</td>
                  <td><span class="vendor-mono" title={r.senderId}>{shortId(r.senderId)}</span></td>
                  <td class="vendor-mono">{r.primaryIp || "-"}</td>
                  <td class="vendor-mono">{r.secondaryIp || "-"}</td>
                  <td class="vendor-mono">{r.port || "-"}</td>
                  <td class="vendor-mono">{renderBitrate(r.bitrate)}</td>
                  <td><span class="lease-date">{fmtDate(r.createdAt)}</span></td>
                  <td>
                    <button class="btn btn-ghost btn-xs lease-release-btn"
                            on:click={()=>askReleaseLease(r)}
                            aria-label="Release lease" title="Release lease">
                      <Icon src={Trash} />
                    </button>
                  </td>
                </tr>
              {/each}
              {#if leaseRows.length === 0}
                <tr><td colspan="10" class="vendor-empty">
                  {Object.keys(leaseSnapshot.leases || {}).length === 0
                    ? "No leases allocated yet."
                    : "No leases match the current filter."}
                </td></tr>
              {/if}
            </tbody>
          </table>
        </div>
      </details>
    </section>


    <section class="setup-section">
      <h3>Virtual Senders</h3>
      <p class="setup-section-hint">
        Operator-defined senders for devices that don't speak NMOS themselves &mdash; paste their SDPs
        below and NMOS Crosspoint exposes itself as an IS-04 <strong>Node</strong> and publishes each
        entry as a real NMOS sender (with full Source / Flow / Sender records and an IS-05
        <code>transport_file</code> endpoint). Once registered, the senders show up in <em>every</em>
        NMOS-aware controller on the network, not just here. Heartbeats keep the Node alive against
        the configured registry; switching registries deregisters the old one cleanly.
      </p>
      <details class="setup-more"><summary>More details</summary>
      <p class="setup-section-hint">
        Each sender keeps the same UUID across restarts, so receivers stay bound. The destination IP
        comes from the SDP exactly as you typed it &mdash; virtual senders are read-only over IS-05,
        so the multicast-edit pencil is hidden for them on the Details page.
      </p>
      </details>

      <div class="setup-form" style="margin-bottom:14px;">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable Virtual NMOS Node</span>
          <input type="checkbox" class="toggle" bind:checked={formVirtualNodeEnabled} on:change={markDirty} />
        </label>
      </div>

      {#if !formVirtualNodeEnabled}
        <div class="alert alert-warning setup-alert" style="margin-bottom:12px;">
          <Icon src={ExclamationTriangle} />
          <span>
            Virtual Node disabled &mdash; the senders listed below stay in <code>settings.json</code>
            but are NOT registered with the NMOS registry. Re-enable to make them visible to
            controllers and receivers again.
          </span>
        </div>
      {/if}

      {#each formVirtualSenders as v (v.id)}
        <details class="virtual-sender-row">
          <summary class="virtual-sender-head">
            <span class="virtual-sender-summary-name">
              {v.name || "(unnamed virtual sender)"}
            </span>
            <span class="virtual-sender-summary-meta">
              {v.sdp ? "SDP set" : "no SDP"}
            </span>
            <button class="btn btn-ghost btn-sm"
                    on:click|stopPropagation|preventDefault={()=>removeVirtualSender(v.id)}
                    aria-label="Remove virtual sender" title="Remove">
              <Icon src={Trash} />
            </button>
          </summary>

          <div class="virtual-sender-body">
            <label class="setup-field">
              <span class="setup-label">Name</span>
              <input type="text" class="input input-bordered input-sm virtual-sender-name"
                     placeholder="Sender name (e.g. PlayoutA)"
                     bind:value={v.name} on:input={markDirty} />
            </label>
            <label class="setup-field" style="margin-top:8px;">
              <span class="setup-label">SDP</span>
              <textarea class="textarea textarea-bordered vendor-mono virtual-sender-sdp"
                        rows="8" placeholder="Paste a full SDP here…&#10;v=0&#10;o=- 0 0 IN IP4 …&#10;s=…&#10;m=audio 5004 RTP/AVP 96&#10;c=IN IP4 239.x.x.x/32&#10;a=rtpmap:96 L24/48000/2"
                        bind:value={v.sdp} on:input={markDirty}></textarea>
            </label>
          </div>
        </details>
      {/each}
      {#if formVirtualSenders.length === 0}
        <p class="vendor-empty" style="margin:8px 0 12px 0;">No virtual senders defined.</p>
      {/if}

      <div class="vendor-actions-row" style="margin-top:8px;">
        <button class="btn btn-sm" on:click={addVirtualSender}>
          <Icon src={Plus} /> Add virtual sender
        </button>
      </div>
    </section>


    <section class="setup-section">
      <h3>Device Web UI Link Setup</h3>
      <p class="setup-section-hint">
        How the „Open device web UI" link on the Details page is built depends on the vendor.
        Profiles are checked top-to-bottom, the <strong>first</strong> match wins.
        A profile matches when one of its label entries appears as a substring in the node label
        or description. Separate multiple labels with <code>,</code>.
      </p>

      <div class="vendor-table-wrap">
        <table class="vendor-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Labels (comma separated)</th>
              <th>Proto</th>
              <th>Port</th>
              <th>Path</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each formProfiles as p (p.id)}
              <tr>
                <td>
                  <input type="text" class="input input-bordered input-sm" placeholder="Vendor name"
                         bind:value={p.name} on:input={markDirty} />
                </td>
                <td>
                  <input type="text" class="input input-bordered input-sm"
                         placeholder="Matrox, ConvertIP, X1"
                         bind:value={p.labels} on:input={markDirty} />
                </td>
                <td>
                  <select class="select select-bordered select-sm vendor-proto" bind:value={p.protocol} on:change={markDirty}>
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </td>
                <td>
                  <input type="text"
                         class="input input-bordered input-sm vendor-port"
                         placeholder="80"
                         bind:value={p.port} on:input={markDirty} />
                </td>
                <td>
                  <input type="text" class="input input-bordered input-sm vendor-mono"
                         placeholder="/"
                         bind:value={p.path} on:input={markDirty} />
                </td>
                <td>
                  <button class="btn btn-ghost btn-sm" on:click={()=>removeProfile(p.id)}
                          aria-label="Remove vendor profile" title="Remove">
                    <Icon src={Trash} />
                  </button>
                </td>
              </tr>
            {/each}
            {#if formProfiles.length === 0}
              <tr><td colspan="6" class="vendor-empty">No vendor profiles defined.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>

      <div class="vendor-actions-row">
        <button class="btn btn-sm" on:click={addProfile}>
          <Icon src={Plus} /> Add profile
        </button>
        <button class="btn btn-sm" on:click={exportVendorProfiles} disabled={formProfiles.length === 0}>
          Export Profiles
        </button>
        <button class="btn btn-sm" on:click={pickVendorImportFile}>
          Import Profiles…
        </button>
        <input type="file" accept="application/json,.json" style="display:none;"
               bind:this={vendorImportFileInput} on:change={onVendorImportFile} />
        {#if vendorImportSuccess}
          <span class="text-success">{vendorImportSuccess}</span>
        {/if}
        {#if vendorImportError}
          <span class="text-error">{vendorImportError}</span>
        {/if}
      </div>


      <details class="vendor-detected">
        <summary>Detected devices ({detectedDevices.length})</summary>
        <table class="vendor-detected-table">
          <thead>
            <tr><th>Label</th><th>Matches profile</th><th>Web-UI link</th></tr>
          </thead>
          <tbody>
            {#each detectedDevices as d (d.id)}
              <tr>
                <td>{d.label}</td>
                <td>{d.match || "-"}</td>
                <td class="vendor-mono">
                  {#if d.url}
                    <a href={d.url} target="_blank" rel="noopener noreferrer">{d.url}</a>
                  {:else}. {/if}
                </td>
              </tr>
            {/each}
            {#if detectedDevices.length === 0}
              <tr><td colspan="3" class="vendor-empty">No nodes received from the NMOS registry.</td></tr>
            {/if}
          </tbody>
        </table>
      </details>
    </section>


    <section class="setup-section">
      <h3>Push Names to DNS (DDNS)</h3>
      <p class="setup-section-hint">
        Publishes each NMOS node as an <strong>A record</strong> via standard
        <strong>RFC&nbsp;2136 Dynamic Updates</strong>. Works with BIND9,
        Knot&nbsp;DNS, PowerDNS, Windows DNS Server and any other server that
        accepts <code>nsupdate</code>-style updates. Authentication is either a
        <strong>TSIG key</strong> (the zone allows updates signed with the key
        below, e.g. BIND: <code>update-policy &#123; grant &lt;keyname&gt; zonesub A; &#125;;</code>)
        or. Algorithm <strong>none&nbsp;(unsigned)</strong>. Plain unauthenticated
        updates for zones that authorise by source IP (e.g. BIND:
        <code>allow-update &#123; &lt;server-ip&gt;; &#125;;</code>). Unsigned is fine on an
        isolated management network; prefer TSIG whenever the DNS server supports it.
      </p>
      <details class="setup-more"><summary>More details</summary>
      <p class="setup-section-hint">
        The hostname is the node label (or the device alias if you set one on the
        Crosspoint / Details page); the IP comes from the node's <code>href</code>.
        NMOS Crosspoint keeps a local inventory of the records it created, so it
        only ever updates or deletes its own. Deleting a device with the Forget
        button also removes its DNS record.
      </p>
      </details>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable DDNS</span>
          <input type="checkbox" class="toggle" bind:checked={formDdnsEnabled} on:change={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">DNS Server IP / Host</span>
          <input type="text" class="input input-bordered" placeholder="10.0.0.1"
                 bind:value={formDdnsServer} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Port</span>
          <input type="number" class="input input-bordered" min="1" max="65535"
                 bind:value={formDdnsPort} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">TTL (s)</span>
          <input type="number" class="input input-bordered" min="1"
                 bind:value={formDdnsTtl} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">Zone</span>
          <input type="text" class="input input-bordered" placeholder="media.example.net"
                 bind:value={formDdnsZone} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Authentication</span>
          <select class="select select-bordered" bind:value={formDdnsKeyAlgorithm} on:change={markDirty}>
            <option value="hmac-sha256">hmac-sha256</option>
            <option value="hmac-sha512">hmac-sha512</option>
            <option value="hmac-sha1">hmac-sha1</option>
            <option value="hmac-md5">hmac-md5</option>
            <option value="none">none (unsigned)</option>
          </select>
        </label>
        <label class="setup-field">
          <span class="setup-label">TSIG Key Name</span>
          <input type="text" class="input input-bordered" placeholder="nmos-crosspoint"
                 disabled={formDdnsKeyAlgorithm === "none"}
                 bind:value={formDdnsKeyName} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">TSIG Key Secret (base64)</span>
          <input type="password" class="input input-bordered"
                 placeholder={formDdnsKeyAlgorithm === "none" ? "not needed for unsigned updates" : (formDdnsKeySecretSet ? "•••••••• (stored. Leave blank to keep)" : "Paste the base64 TSIG secret")}
                 autocomplete="new-password"
                 disabled={formDdnsKeyAlgorithm === "none"}
                 bind:value={formDdnsKeySecret} on:input={markDirty} />
        </label>
      </div>


      <!-- Pushed Records Inventory. Mirrors the Multicast Lease inventory.
           Lists every A record the server has successfully published via
           RFC 2136. Updated live as new pushes / updates / removes happen. -->
      <details class="lease-inventory">
        <summary>Pushed DNS Records ({(dnsPushedSnapshot.entries || []).length})</summary>

        <div class="lease-table-wrap">
          <table class="lease-table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>IP</th>
                <th>Node ID</th>
                <th>Pushed at</th>
              </tr>
            </thead>
            <tbody>
              {#each (dnsPushedSnapshot.entries || []) as e (e.nodeId)}
                <tr>
                  <td class="vendor-mono">{e.host}.{e.domain}</td>
                  <td class="vendor-mono">{e.ip}</td>
                  <td><span class="vendor-mono" title={e.nodeId}>{shortId(e.nodeId)}</span></td>
                  <td><span class="lease-date">{fmtDate(e.ts)}</span></td>
                </tr>
              {/each}
              {#if (dnsPushedSnapshot.entries || []).length === 0}
                <tr><td colspan="4" class="vendor-empty">
                  No DNS records pushed yet. Enable DDNS above and save.
                </td></tr>
              {/if}
            </tbody>
          </table>
        </div>
      </details>
    </section>


    <h2 class="setup-group">Access</h2>

    <section class="setup-section">
      <h3>Change Login &amp; Password</h3>
      <p class="setup-section-hint">
        Updates the admin user stored in <code>./config/users.json</code>.
        You can only edit your own account, and you must know the current
        password. After a change, the server will ask you to log in again
        with the new credentials.
      </p>

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Current username</span>
          <input type="text" class="input input-bordered"
                 bind:value={formCredCurrentUser} autocomplete="username" />
        </label>
        <label class="setup-field">
          <span class="setup-label">Current password</span>
          <input type="password" class="input input-bordered" autocomplete="current-password"
                 bind:value={formCredCurrentPass} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">New username</span>
          <input type="text" class="input input-bordered" autocomplete="username"
                 bind:value={formCredNewUser} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">New password</span>
          <input type="password" class="input input-bordered" autocomplete="new-password"
                 placeholder="(leave blank to keep current)"
                 bind:value={formCredNewPass} />
        </label>
        <label class="setup-field">
          <span class="setup-label">Repeat new password</span>
          <input type="password" class="input input-bordered" autocomplete="new-password"
                 bind:value={formCredNewPass2} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:14px; align-items:center;">
        <button class="btn btn-primary" on:click={saveCredentials} disabled={credSaving}>
          {#if credSaving}Saving…{:else}Update credentials{/if}
        </button>
        {#if credSuccess}
          <span class="text-success">{credSuccess}</span>
        {/if}
        {#if credError}
          <span class="text-error">{credError}</span>
        {/if}
      </div>
    </section>


    <div class="setup-actions">
      <button class="btn" on:click={resetForm} disabled={!dirty}>Reset</button>
      <button class="btn btn-primary" on:click={save} disabled={!dirty || saving}>
        {#if saving}Saving…{:else}Save{/if}
      </button>
    </div>
  </div>
</div>


<dialog bind:this={autoMulticastModal} class="modal">
  <div class="modal-box" style="max-width: 640px;">
    <h3 class="font-bold text-lg">Enable Multicast DHCP</h3>
    <p style="margin-top:8px;">
      Multicast DHCP will now manage multicast addresses for every new active sender.
      What should happen with senders that are <strong>currently active</strong>?
    </p>
    <div class="auto-mc-choice">
      <button class="btn btn-primary auto-mc-btn" on:click={()=>autoMcChoose(true)}>
        <span class="auto-mc-title">Keep current IPs</span>
        <span class="auto-mc-hint">Adopt each sender's existing destination IP as its lease. No PATCH is sent, no stream is interrupted. Recommended for live systems.</span>
      </button>
      <button class="btn auto-mc-btn" on:click={()=>autoMcChoose(false)}>
        <span class="auto-mc-title">Renew from Pool</span>
        <span class="auto-mc-hint">Every active sender is assigned a fresh multicast from the pool. Existing connections are re-executed. Disabled senders receive a multicast as soon as they become active.</span>
      </button>
    </div>
    <div class="modal-action">
      <button on:click={autoMcCancel} class="btn btn-ghost">Cancel</button>
    </div>
  </div>
</dialog>



