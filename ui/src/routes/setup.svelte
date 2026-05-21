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
    interface LeaseStat { used: number; total: number }
    interface DnsPush {
      enabled: boolean;
      serverIp: string;
      serverPort: number;
      protocol: "http" | "https";
      apiKey: string;       // server NEVER returns the real value
      apiKeySet: boolean;   // server flag: an API key is configured
      domain: string;
      insecureTLS: boolean;
    }
    interface SetupConfig {
      registry: { ip:string, port:number };
      acceptableGmid: string;
      vendorProfiles: VendorProfile[];
      multicastRange: string;
      autoMulticast: { enabled: boolean, reconnectReceiversOnSenderChange?: boolean };
      autoActivateInactiveSender: boolean;
      // pool = the single-range counter; per-cat fields kept for back-compat
      multicastStats: { pool?: LeaseStat, audioLow?: LeaseStat, audioHigh?: LeaseStat, video?: LeaseStat };
      dnsPush: DnsPush;
      auth: { users: string[] };
      restartRequired: boolean;
    }

    let serverState:SetupConfig = {
      registry: { ip: "", port: 80 },
      acceptableGmid: "",
      vendorProfiles: [],
      multicastRange: "",
      autoMulticast: { enabled: false, reconnectReceiversOnSenderChange: false },
      autoActivateInactiveSender: false,
      multicastStats: { pool:{used:0,total:0} },
      dnsPush: { enabled:false, serverIp:"", serverPort:443, protocol:"https", apiKey:"", apiKeySet:false, domain:"local", insecureTLS:true },
      auth: { users: [] },
      restartRequired: false
    };

    // Local edit buffer (so typing doesn't fight the sync)
    let formIp:string = "";
    let formPort:string = "80";
    let formGmid:string = "";
    let formProfiles:VendorProfile[] = [];
    let formAutoMulticastEnabled:boolean = false;
    let formReconnectReceivers:boolean = false;
    let formAutoActivateSender:boolean = false;
    let formMulticastRange:string = "";

    // Credentials form (independent of the main Save flow — saved via its own
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

    // DNS Push form state
    let formDnsEnabled:boolean    = false;
    let formDnsServerIp:string    = "";
    let formDnsServerPort:string  = "443";
    let formDnsProtocol:"http"|"https" = "https";
    let formDnsApiKey:string      = "";
    let formDnsApiKeySet:boolean  = false;
    let formDnsDomain:string      = "local";
    let formDnsInsecureTLS:boolean = true;

    // Live preview of detected devices for the vendor table — includes the
    // resulting Web-UI link so the operator can verify the profile's
    // protocol/port/path produce the URL they actually expect.
    let detectedDevices:Array<{ id:string, label:string, match:string, url:string }> = [];

    function buildDeviceUrl(profile:VendorProfile | null, hrefStr:string):string {
      try{
        if(!hrefStr){ return ""; }
        let u = new URL(hrefStr);
        let host = u.hostname;
        if(profile){
          let proto = (profile.protocol === "https") ? "https" : "http";
          let port = parseInt(""+profile.port);
          if(isNaN(port) || port <= 0 || port > 65535){
            port = (proto === "https") ? 443 : 80;
          }
          let path = (typeof profile.path === "string" && profile.path) ? profile.path : "/";
          if(!path.startsWith("/")){ path = "/" + path; }
          let portSuffix = ((proto === "http" && port === 80) || (proto === "https" && port === 443))
              ? "" : (":" + port);
          return proto + "://" + host + portSuffix + path;
        }
        // No profile matched — fall back to whatever the NMOS node advertises.
        return u.protocol + "//" + u.host + "/";
      }catch(e){}
      return "";
    }

    let dirty = false;
    let saving = false;
    let savedFlash = false;
    let saveError = "";

    let sync:Subject<any>;
    let syncNmos:Subject<any>;
    let syncLeases:Subject<any>;
    let nmosState:any = { nodes:{}, devices:{}, senders:{}, receivers:{} };

    // Live lease inventory snapshot: { leases:{[id]:Lease}, stats:..., updatedAt:string }
    let leaseSnapshot:any = { leases:{}, stats:{}, updatedAt:"" };
    let inventoryFilter:string = "";
    let inventoryCategoryFilter:string = "";  // "" / "audioLow" / "audioHigh" / "video"

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
            formAutoMulticastEnabled = !!(obj.autoMulticast && obj.autoMulticast.enabled);
            // `reconnectReceiversOnSenderChange` default is now FALSE, so we
            // take the stored value as-is (no "!== false" magic).
            formReconnectReceivers   = !!(obj.autoMulticast && (
              obj.autoMulticast.reconnectReceiversOnSenderChange ??
              obj.autoMulticast.reconnectReceiversOnMulticastChange
            ));
            formAutoActivateSender   = !!obj.autoActivateInactiveSender;
            formMulticastRange       = (typeof obj.multicastRange === "string") ? obj.multicastRange : "";
            // Pre-fill the credentials form with the first configured user
            // so the operator doesn't have to type their own username.
            if(obj.auth && Array.isArray(obj.auth.users) && obj.auth.users.length > 0){
              formCredCurrentUser = obj.auth.users[0];
              if(!formCredNewUser){ formCredNewUser = obj.auth.users[0]; }
            }
            if(obj.dnsPush){
              formDnsEnabled     = !!obj.dnsPush.enabled;
              formDnsServerIp    = obj.dnsPush.serverIp || "";
              formDnsServerPort  = ""+(obj.dnsPush.serverPort || 443);
              formDnsProtocol    = obj.dnsPush.protocol === "http" ? "http" : "https";
              formDnsApiKey      = "";   // never round-trip the secret
              formDnsApiKeySet   = !!obj.dnsPush.apiKeySet;
              formDnsDomain      = obj.dnsPush.domain || "local";
              formDnsInsecureTLS = obj.dnsPush.insecureTLS !== false;
            }
          }
          recomputeDetected();
        }
      });
      syncNmos = ServerConnector.sync("nmos");
      syncNmos.subscribe((obj:any)=>{
        if(obj){
          nmosState = obj;
          recomputeDetected();
        }
      });
      syncLeases = ServerConnector.sync("multicastLeases");
      syncLeases.subscribe((obj:any)=>{
        if(obj){ leaseSnapshot = obj; }
      });
    });

    onDestroy(() => {
      try{sync && sync.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("setupConfig");}catch(e){}
      try{syncNmos && syncNmos.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("nmos");}catch(e){}
      try{syncLeases && syncLeases.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("multicastLeases");}catch(e){}
    });

    function markDirty(){
      dirty = true;
      savedFlash = false;
      saveError = "";
      recomputeDetected();
    }

    function resetForm(){
      formIp   = serverState.registry.ip || "";
      formPort = ""+(serverState.registry.port || 80);
      formGmid = serverState.acceptableGmid || "";
      formProfiles = Array.isArray(serverState.vendorProfiles) ? serverState.vendorProfiles.map((p:any)=>({...p})) : [];
      formAutoMulticastEnabled = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      formReconnectReceivers   = !!(serverState.autoMulticast && (
        (serverState.autoMulticast as any).reconnectReceiversOnSenderChange ??
        (serverState.autoMulticast as any).reconnectReceiversOnMulticastChange
      ));
      formAutoActivateSender   = !!serverState.autoActivateInactiveSender;
      formMulticastRange       = serverState.multicastRange || "";
      if(serverState.dnsPush){
        formDnsEnabled     = !!serverState.dnsPush.enabled;
        formDnsServerIp    = serverState.dnsPush.serverIp || "";
        formDnsServerPort  = ""+(serverState.dnsPush.serverPort || 443);
        formDnsProtocol    = serverState.dnsPush.protocol === "http" ? "http" : "https";
        formDnsApiKey      = "";
        formDnsApiKeySet   = !!serverState.dnsPush.apiKeySet;
        formDnsDomain      = serverState.dnsPush.domain || "local";
        formDnsInsecureTLS = serverState.dnsPush.insecureTLS !== false;
      }
      dirty = false;
      saveError = "";
      recomputeDetected();
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

      // Multicast range — basic CIDR sanity check (single shared pool now)
      let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
      if(formMulticastRange && !cidrRe.test(formMulticastRange.trim())){
        saveError = "Multicast Range must use CIDR notation, e.g. 239.30.0.0/16";
        return;
      }

      // DNS Push validation
      let dnsPort = parseInt(formDnsServerPort);
      if(isNaN(dnsPort) || dnsPort <= 0 || dnsPort > 65535){
        saveError = "DNS Push: Port must be between 1 and 65535.";
        return;
      }
      if(formDnsEnabled){
        if(!formDnsServerIp.trim()){ saveError = "DNS Push: Server address is required when enabled."; return; }
        if(!formDnsApiKeySet && !formDnsApiKey){ saveError = "DNS Push: API Key is required when enabled."; return; }
        if(!formDnsDomain.trim()){ saveError = "DNS Push: Domain (hostname suffix) is required."; return; }
      }

      let payload:any = {
        registry: { ip: formIp.trim(), port: port },
        acceptableGmid: formGmid.trim(),
        vendorProfiles: formProfiles,
        multicastRange: formMulticastRange.trim(),
        autoMulticast: {
          enabled: formAutoMulticastEnabled,
          reconnectReceiversOnSenderChange: formReconnectReceivers
        },
        autoActivateInactiveSender: formAutoActivateSender,
        dnsPush: {
          enabled:     formDnsEnabled,
          serverIp:    formDnsServerIp.trim(),
          serverPort:  dnsPort,
          protocol:    formDnsProtocol,
          // Empty string means "keep the existing key" on the server.
          apiKey:      formDnsApiKey,
          domain:      formDnsDomain.trim(),
          insecureTLS: formDnsInsecureTLS
        }
      };

      // If the user is switching Auto-Allocation ON for the first time
      // (it was off before), ask what should happen with currently online
      // senders: adopt their existing IPs, or force fresh pool addresses.
      let wasEnabled = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      let nowEnabled = !!formAutoMulticastEnabled;
      if(!wasEnabled && nowEnabled){
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
      if(!newUser && !wantPass){ credError = "Nothing to change — set a new username or a new password."; return; }

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


    // ----- Detected-device preview helpers -----
    function splitLabels(s:string):string[] {
      if(!s){ return []; }
      return s.split(",").map(x => x.trim().toLowerCase()).filter(x => x.length > 0);
    }
    function matchProfile(profile:VendorProfile, label:string, description:string):boolean {
      let needles = splitLabels(profile.labels);
      if(needles.length === 0){ return false; }
      let hay = (label + " " + description).toLowerCase();
      for(let n of needles){
        if(hay.includes(n)) return true;
      }
      return false;
    }

    function recomputeDetected(){
      try{
        let nodes = nmosState && nmosState.nodes ? nmosState.nodes : {};
        let arr:Array<{ id:string, label:string, match:string, url:string }> = [];
        for(let nodeId in nodes){
          let n = nodes[nodeId];
          if(!n){ continue; }
          let label = n.label || nodeId;
          let description = n.description || "";

          let matched:VendorProfile | null = null;
          let matchName = "";
          for(let p of formProfiles){
            if(matchProfile(p, label, description)){
              matched = p;
              matchName = p.name || p.id;
              break;
            }
          }
          let url = buildDeviceUrl(matched, n.href || "");
          arr.push({ id: nodeId, label, match: matchName, url });
        }
        arr.sort((a,b)=>(a.label||"").localeCompare(b.label||""));
        detectedDevices = arr;
      }catch(e){
        detectedDevices = [];
      }
    }

    // recompute on profile/state changes
    $: { formProfiles; nmosState; recomputeDetected(); }


    // ----- Lease inventory derived state -----
    interface LeaseRow {
      senderId: string;
      deviceLabel: string;
      category: string;
      channels: number;
      primaryIp: string;
      secondaryIp: string;
      port: number;
      createdAt: string;
      // Live state from NMOS, looked up on every recompute.
      // "active":   sender is in the NMOS registry and master_enable=true
      // "inactive": sender is in the NMOS registry but master_enable=false
      // "missing":  sender ID isn't present in the NMOS registry at all
      liveStatus: "active" | "inactive" | "missing";
    }
    let leaseRows:LeaseRow[] = [];
    // Recompute whenever leases, filter, or NMOS state change.
    $: leaseRows = recomputeLeaseRows(leaseSnapshot, inventoryFilter, inventoryCategoryFilter, nmosState);
    function recomputeLeaseRows(snap:any, filterStr:string, catFilterStr:string, nmos:any):LeaseRow[]{
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
        // Look up the live state in the NMOS sender table (keyed by raw UUID).
        let liveStatus:"active"|"inactive"|"missing" = "missing";
        try{
          let nmosSender = nmos?.senders?.[id];
          if(nmosSender){
            liveStatus = (nmosSender.subscription && nmosSender.subscription.active) ? "active" : "inactive";
          }
        }catch(e){}
        arr.push({
          senderId: id,
          deviceLabel: l.deviceLabel || "",
          category: l.category || "",
          channels: l.channels || 0,
          primaryIp: l.primaryIp || "",
          secondaryIp: l.secondaryIp || "",
          port: l.port || 0,
          createdAt: l.createdAt || "",
          liveStatus
        });
      }
      arr.sort((a,b) => {
        if(a.category !== b.category) return a.category.localeCompare(b.category);
        // sort by uint32 of primary IP within a category
        return ipCompare(a.primaryIp, b.primaryIp);
      });
      return arr;
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
        case "audioLow":  return "Audio Low";
        case "audioHigh": return "Audio High";
        case "video":     return "Video";
        default: return c || "—";
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
    let releaseModal:any;
    let releaseTarget:LeaseRow | null = null;
    let releaseError:string = "";
    function askReleaseLease(row:LeaseRow){
      releaseTarget = row;
      releaseError = "";
      if(releaseModal){ releaseModal.showModal(); }
    }
    function cancelReleaseLease(){
      releaseTarget = null;
      releaseError = "";
      if(releaseModal){ releaseModal.close(); }
    }
    function confirmReleaseLease(){
      if(!releaseTarget) return;
      let sid = releaseTarget.senderId;
      ServerConnector.post("releaseLease", { senderId: sid })
        .then(()=>{
          releaseTarget = null;
          if(releaseModal){ releaseModal.close(); }
        })
        .catch((e:any)=>{
          releaseError = (e && e.message) ? e.message : "Release failed.";
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

          // Sanitise — same rules as the server. Generate fresh IDs to avoid
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
    <h2 class="setup-title">Setup</h2>
    <p class="setup-subtitle">Edit the most-used NMOS Crosspoint settings. Persists to <code>./config/settings.json</code>.</p>

    {#if serverState.restartRequired}
      <div class="alert alert-warning setup-alert">
        <Icon src={ExclamationTriangle} />
        <span>Registry change pending — restart the server for the new IP/port to take effect.</span>
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


    <section class="setup-section">
      <h3>Receiver Auto-Reconnect</h3>
      <p class="setup-section-hint">
        Whenever a sender's SDP changes — destination IP / port (reconcile, manual edit,
        lease release) <em>or</em> any other field like channel count, video format,
        colorimetry — re-execute the connection of every receiver currently subscribed to
        it so they pick up the new manifest. Recommended ON for production. The one-shot
        „Reallocate from pool" sweep in <em>Multicast DHCP</em> ignores this setting and
        always reconnects.
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
        and only then patch the receiver. Off by default — many control rooms
        gate sender activation through a separate workflow and don't want a
        stray click on the matrix to push a signal on the wire.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Auto-activate inactive sender on Crosspoint connect</span>
          <input type="checkbox" class="toggle" bind:checked={formAutoActivateSender} on:change={markDirty} />
        </label>
      </div>
    </section>


    <section class="setup-section">
      <h3>Multicast DHCP</h3>
      <p class="setup-section-hint">
        When enabled, the server reserves a pair of consecutive multicast addresses per sender
        (odd for Leg 1, even = odd + 1 for Leg 2). The reservation is kept for the lifetime of the
        device — even if the sender goes offline — and is only released when the device is
        explicitly <em>Forget</em>en on the Details page or its lease is deleted in the inventory below.
      </p>
      <p class="setup-section-hint">
        <strong>An address is (re-)assigned in two cases:</strong>
      </p>
      <ul class="setup-section-bullets">
        <li>when a sender becomes <em>active</em> (its NMOS subscription transitions to active) and has no lease yet;</li>
        <li>when the destination IP of an <em>active</em> sender is cleared — the field on the Details page is emptied or its lease is released here.</li>
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
            <option value="audioLow">Audio Low</option>
            <option value="audioHigh">Audio High</option>
            <option value="video">Video</option>
          </select>
          <span class="lease-count">{leaseRows.length} shown</span>
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
                  <td>{r.deviceLabel || "—"}</td>
                  <td><span class="vendor-mono" title={r.senderId}>{shortId(r.senderId)}</span></td>
                  <td class="vendor-mono">{r.primaryIp || "—"}</td>
                  <td class="vendor-mono">{r.secondaryIp || "—"}</td>
                  <td class="vendor-mono">{r.port || "—"}</td>
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
                <tr><td colspan="9" class="vendor-empty">
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
      <h3>Vendor Profiles</h3>
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
                <td>{d.match || "—"}</td>
                <td class="vendor-mono">
                  {#if d.url}
                    <a href={d.url} target="_blank" rel="noopener noreferrer">{d.url}</a>
                  {:else}
                    —
                  {/if}
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
      <h3>Push Names to DNS</h3>
      <p class="setup-section-hint">
        Publishes each NMOS node as a host_override on the pfSense
        <strong>DNS Resolver</strong> (Unbound) via the
        <a href="https://pfrest.org/api-docs/" target="_blank" rel="noopener">pfRest</a> API.
        After every batch <code>/api/v2/services/dns_resolver/apply</code> is called so
        changes go live immediately.
      </p>
      <p class="setup-section-hint">
        The hostname is the node label (or the device alias if you set one on the
        Crosspoint / Details page); the IP comes from the node's <code>href</code>.
        Entries are tagged <code>NMOS-Crosspoint:&lt;nodeId&gt;</code> in their description so
        the service only ever touches the entries it owns — manually-configured
        overrides are left untouched. Deleting a device with the Forget button also
        removes its DNS entry.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable DNS Push</span>
          <input type="checkbox" class="toggle" bind:checked={formDnsEnabled} on:change={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">DNS Server IP / Host</span>
          <input type="text" class="input input-bordered" placeholder="10.0.0.1"
                 bind:value={formDnsServerIp} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Port</span>
          <input type="number" class="input input-bordered" min="1" max="65535"
                 bind:value={formDnsServerPort} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Protocol</span>
          <select class="select select-bordered" bind:value={formDnsProtocol} on:change={markDirty}>
            <option value="https">https</option>
            <option value="http">http</option>
          </select>
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">API Key</span>
          <input type="password" class="input input-bordered"
                 placeholder={formDnsApiKeySet ? "•••••••• (stored — leave blank to keep)" : "Paste the pfRest API key"}
                 autocomplete="new-password"
                 bind:value={formDnsApiKey} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="setup-field">
          <span class="setup-label">Domain (hostname suffix)</span>
          <input type="text" class="input input-bordered" placeholder="local"
                 bind:value={formDnsDomain} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:8px;">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Allow self-signed / invalid TLS certificate</span>
          <input type="checkbox" class="toggle" bind:checked={formDnsInsecureTLS} on:change={markDirty} />
        </label>
      </div>
    </section>


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
        <span class="auto-mc-title">Reallocate from pool</span>
        <span class="auto-mc-hint">Force every active sender onto a fresh pool address and re-execute every existing receiver subscription so they follow the new IPs. Brief stream interruption per sender while the PATCH lands.</span>
      </button>
    </div>
    <div class="modal-action">
      <button on:click={autoMcCancel} class="btn btn-ghost">Cancel</button>
    </div>
  </div>
</dialog>


<dialog bind:this={releaseModal} class="modal">
  <div class="modal-box">
    <form method="dialog">
      <button on:click={cancelReleaseLease} class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
    </form>
    <h3 class="font-bold text-lg">Release multicast lease?</h3>
    {#if releaseTarget}
      <p style="margin-top:6px;">
        <strong>{releaseTarget.deviceLabel || releaseTarget.senderId}</strong> —
        <span class="vendor-mono">{releaseTarget.primaryIp} / {releaseTarget.secondaryIp}</span>
        ({categoryLabel(releaseTarget.category)})
      </p>
      <p style="margin-top:10px; color: var(--fallback-bc, oklch(var(--bc) / 0.7));">
        The allocated pair will return to the pool. If the sender is still
        online and Multicast DHCP is enabled, it will receive a fresh pair
        on the next reconcile cycle.
      </p>
    {/if}
    {#if releaseError}
      <p class="text-error" style="margin-top:8px;">{releaseError}</p>
    {/if}
    <div class="modal-action">
      <button on:click={cancelReleaseLease} class="btn">Cancel</button>
      <button on:click={confirmReleaseLease} class="btn btn-error">Release</button>
    </div>
  </div>
</dialog>

