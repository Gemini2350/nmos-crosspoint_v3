<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService";
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";
    import sha256 from "js-sha256";

    import { Icon, ExclamationTriangle, CheckCircle, Plus, Trash, ServerStack, ChevronRight } from "svelte-hero-icons";
    import HelpTip from "../lib/HelpTip.svelte";
    import Logo from "../lib/Logo.svelte";

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
      deviceId?: string;
      // Why the server could not publish the saved SDP, else "".
      error?: string;
    }
    // A virtual device as edited: `key` is its id, or "new:…" until saved.
    interface VirtualDeviceForm { key: string; name: string; }
    // A virtual sender as edited, on the device named by `deviceKey`.
    interface VirtualSenderForm { id: string; name: string; sdp: string; deviceKey: string; error: string; }
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
      registration?: { mode: "registry" | "custom", host: string, port: number };
      // What "the registry above" is, as host:port; "" while none.
      registryTarget?: string;
      status?: { target: string, state: "off" | "none" | "registered" | "error", error: string, devices: number, senders: number };
    }
    // One pool in the lease stats; key "default" or the limit as text.
    interface PoolStat { key:string, label:string, name?:string, maxMbps:number|null, cidr:string, used:number, total:number }
    interface SetupConfig {
      registry: { ip:string, port:number };
      acceptableGmid: string;
      vendorProfiles: VendorProfile[];
      virtualSenders: VirtualSender[];
      virtualDevices?: Array<{ id: string, name: string }>;
      virtualNode: VirtualNodeCfg;
      multicastRange: string;
      // Pools by bandwidth on top of the default pool (multicastRange).
      multicastPools?: Array<{ maxMbps:number, range:string, name?:string }>;
      multicastDefaultPoolName?: string;
      autoMulticast: { enabled: boolean, reconnectReceiversOnSenderChange?: boolean };
      autoActivateInactiveSender: boolean;
      audioMonitor: { enabled: boolean };
      bcp008: { enabled: boolean };
      // pool = the single-range counter; per-cat fields kept for back-compat
      multicastStats: { pool?: LeaseStat, pools?: PoolStat[], audio?: LeaseStat, video?: LeaseStat };
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
    let formVirtualDevices:VirtualDeviceForm[] = [];
    let formVirtualSenders:VirtualSenderForm[] = [];
    let formVirtualNodeEnabled:boolean = false;
    let formVirtualRegMode:"registry"|"custom" = "registry";
    let formVirtualRegHost:string = "";
    let formVirtualRegPort:string = "";
    let formAutoMulticastEnabled:boolean = false;
    let formReconnectReceivers:boolean = false;
    let formAutoActivateSender:boolean = false;
    let formAudioMonitorEnabled:boolean = false;
    let formBcp008Enabled:boolean = true;
    let formDnssdEnabled:boolean = true;
    let formDnssdDomain:string = "";
    let formMulticastRange:string = "";
    // Pools by bandwidth, as edited: the limit stays text while typing.
    let formMulticastPools: Array<{ id:string, maxMbps:string, range:string, name:string }> = [];
    let formMulticastDefaultPoolName:string = "";
    function poolRowsFrom(pools:any):Array<{ id:string, maxMbps:string, range:string, name:string }>{
      return (Array.isArray(pools) ? pools : []).map((p:any, i:number) => ({
        id: "pool-" + i + "-" + Math.random().toString(36).slice(2, 7),
        maxMbps: (typeof p.maxMbps === "number") ? String(p.maxMbps) : "",
        range: p.range || "",
        name: p.name || ""
      }));
    }
    function addPool(){
      formMulticastPools = [...formMulticastPools, { id: "pool-" + Math.random().toString(36).slice(2, 9), maxMbps: "", range: "", name: "" }];
      markDirty();
    }
    function removePool(id:string){
      formMulticastPools = formMulticastPools.filter(p => p.id !== id);
      markDirty();
    }
    // The form's pools as the server stores them: numbers, sorted, empty rows gone.
    function poolPayload(){
      return formMulticastPools
        .filter(p => (p.maxMbps || "").trim() !== "" || (p.range || "").trim() !== "" || (p.name || "").trim() !== "")
        .map(p => {
          const out:any = { maxMbps: Number((p.maxMbps || "").replace(",", ".").trim()), range: (p.range || "").trim() };
          if((p.name || "").trim()){ out.name = p.name.trim(); }
          return out;
        })
        .sort((a, b) => a.maxMbps - b.maxMbps);
    }
    // "used / total" of the pool a row shows, "–" while the row differs
    // from what is saved. The snapshot is passed in, not read inside, so the
    // template redraws when new stats arrive.
    function poolUsed(snap:any, key:string, cidr:string):string{
      const st:PoolStat|undefined = (snap?.stats?.pools || []).find((p:PoolStat) => p.key === key);
      return (st && st.cidr === (cidr || "").trim()) ? st.used + " / " + st.total : "–";
    }

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
    let syncConnState:Subject<any>;
    // One entry per registry the server currently knows: {ip, port, source,
    // priority, connected:[{endpoint, connected}]} — from the
    // nmosConnectionState sync, which also carries the DNS-SD domains the
    // discovery would query.
    let registryStatusList:any[] = [];
    let dnssdStatus:any = { enabled: true, override: "", domains: [] };
    let syncProbeState:Subject<any>;

    // ----- Single sign-on (OpenID Connect) -----
    // The server keeps and checks the settings (route "ssoConfig", admins
    // only; the client secret never comes back). Here only the form.
    let syncSso:Subject<any>;
    let ssoStatus:any = { enabled:false, label:"", issuer:"", sessions:0 };
    let ssoAdmin = false;          // the server let us read the settings
    let ssoLoaded:any = null;      // the settings as stored
    let ssoForm:any = null;        // the form
    let ssoDirty = false;
    let ssoTest:any = { busy:false, ok:false, text:"" };
    function ssoFromView(v:any){
      return {
        enabled: !!v.enabled, issuer: v.issuer || "", clientId: v.clientId || "",
        clientSecret: "", clearSecret: false, secretSet: !!v.secretSet,
        label: v.label || "", groupsClaim: v.groupsClaim || "",
        mappings: (v.mappings || []).map((m:any) => ({ value: m.value, groups: [...m.groups] })),
        everyone: [...(v.everyone || [])],
        redirectUri: v.redirectUri || "", scopes: v.scopes || "", sessionHours: "" + (v.sessionHours || 12),
        groupsAvailable: v.groupsAvailable || ["user", "admin"],
        callbackPath: v.callbackPath || "/auth/oidc/callback", logoutReturnPath: v.logoutReturnPath || "/",
      };
    }
    function loadSso(){
      ServerConnector.get("ssoConfig").then((resp:any)=>{
        ssoAdmin = true;
        ssoLoaded = resp?.data || null;
        if(ssoLoaded && !ssoDirty){ ssoForm = ssoFromView(ssoLoaded); }
      }).catch(()=>{ ssoAdmin = false; });
    }
    function ssoChanged(){ ssoDirty = true; markDirty(); }
    function ssoToggleGroup(list:string[], g:string){ return list.includes(g) ? list.filter((x) => x !== g) : [...list, g]; }
    function ssoAddMapping(){ ssoForm.mappings = [...ssoForm.mappings, { value: "", groups: [] }]; ssoChanged(); }
    function ssoRemoveMapping(i:number){ ssoForm.mappings = ssoForm.mappings.filter((_:any, k:number) => k !== i); ssoChanged(); }
    function ssoGroupLabel(g:string){ return g === "user" ? "Operate (user)" : g === "admin" ? "Admin (admin)" : g; }
    function ssoTestProvider(){
      ssoTest = { busy:true, ok:false, text:"" };
      ServerConnector.post("ssoTest", { issuer: ssoForm.issuer }).then((r:any)=>{
        ssoTest = { busy:false, ok:true, text: r?.data?.message || "Provider found." };
      }).catch((e:any)=>{
        ssoTest = { busy:false, ok:false, text: e?.message || "The provider did not answer." };
      });
    }
    // What to register at the provider: the configured redirect URI, or this
    // page's own address (which only the browser knows).
    function ssoRedirectUri(f:any){ return f.redirectUri || (window.location.origin + f.callbackPath); }
    function ssoLogoutUri(f:any){
      try{ return (f.redirectUri ? new URL(f.redirectUri).origin : window.location.origin) + f.logoutReturnPath; }
      catch(e){ return window.location.origin + f.logoutReturnPath; }
    }
    function copyText(t:string){ try{ navigator.clipboard.writeText(t); }catch(e){} }
    function ssoPayload(){
      const f = ssoForm;
      return { enabled: f.enabled, issuer: f.issuer, clientId: f.clientId, clientSecret: f.clientSecret, clearSecret: f.clearSecret,
               label: f.label, groupsClaim: f.groupsClaim, mappings: f.mappings, everyone: f.everyone,
               redirectUri: f.redirectUri, scopes: f.scopes, sessionHours: Number(f.sessionHours) };
    }
    // {token, probes:[{name,address,streams}]} from the probeState sync.
    let probeState:any = { token:"", probes:[] };

    // ----- Folding sections -----
    // Every section with settings below its title row folds. Which ones are
    // open is remembered per browser (a convenience, nothing on the server);
    // on a first visit they are all folded.
    const FOLD_KEY = "nmos_crosspoint_setup_open";
    const FOLD_IDS = ["registry", "gmid", "audio", "multicast", "virtual", "weblinks", "ddns", "sso", "login"];
    function readFolds():{[id:string]:boolean}{
      try{
        const v = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}");
        return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
      }catch(e){ return {}; }
    }
    let openSections:{[id:string]:boolean} = readFolds();
    function setOpen(ids:string[], open:boolean){
      const next = { ...openSections };
      for(const id of ids){
        if(open){ next[id] = true; }else{ delete next[id]; }
      }
      openSections = next;
      try{ localStorage.setItem(FOLD_KEY, JSON.stringify(openSections)); }catch(e){}
    }
    // A click anywhere on a title row folds it, except on what has a click
    // of its own there: the toggle, the "?" and its bubble. The arrow is a
    // button, so the keyboard gets there too.
    function foldHead(node:HTMLElement, id:string){
      let cur = id;
      const onClick = (e:MouseEvent) => {
        const t = e.target as HTMLElement;
        if(t.closest("input, select, textarea, a, label, .help-tip, .help-tip-pop, button:not(.setup-fold)")){ return; }
        setOpen([cur], !openSections[cur]);
      };
      node.addEventListener("click", onClick);
      return {
        update(v:string){ cur = v; },
        destroy(){ node.removeEventListener("click", onClick); },
      };
    }
    // Switching a section on opens it, so its settings are in view.
    function openIfOn(id:string, e:Event){
      if((e.currentTarget as HTMLInputElement).checked){ setOpen([id], true); }
    }
    // A save that is refused opens the section the reason is in.
    function fail(id:string, msg:string){
      saveError = msg;
      setOpen([id], true);
    }
    function regTotal(r:any):number{
      return Array.isArray(r?.connected) ? r.connected.length : 0;
    }
    function regUp(r:any):number{
      return Array.isArray(r?.connected) ? r.connected.filter((c:any)=>c && c.connected).length : 0;
    }
    // "IS-04 v1.3 + v1.2": which Query API version the subscriptions run on
    // and down to which version older registrations are included. Without the
    // second part, devices registering at an older version are not visible.
    function regVersions(r:any):string{
      const c = Array.isArray(r?.connected) ? r.connected.find((x:any)=>x && x.version) : null;
      if(!c) return "";
      return "IS-04 " + c.version + (c.downgrade ? " + " + c.downgrade : " only");
    }
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
            loadVirtualForm(obj);
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
            formDnssdEnabled         = !(obj.registryDiscovery && obj.registryDiscovery.unicastDnssd === false);
            formDnssdDomain          = (obj.registryDiscovery && typeof obj.registryDiscovery.domain === "string") ? obj.registryDiscovery.domain : "";
            formMulticastRange       = (typeof obj.multicastRange === "string") ? obj.multicastRange : "";
            formMulticastPools       = poolRowsFrom(obj.multicastPools);
            formMulticastDefaultPoolName = (typeof obj.multicastDefaultPoolName === "string") ? obj.multicastDefaultPoolName : "";
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
      // Live registry connection state: which registries the server knows
      // (static / unicast DNS-SD / mDNS) and how many of the six query-API
      // subscriptions are up. Refreshed by the server every 2 s.
      syncConnState = ServerConnector.sync("nmosConnectionState");
      syncConnState.subscribe((obj:any)=>{
        registryStatusList = (obj && Array.isArray(obj.registries)) ? obj.registries : [];
        dnssdStatus = (obj && obj.dnssd) ? obj.dnssd : { enabled: true, override: "", domains: [] };
      });
      // Connected multicast probes + the shared token for starting one.
      syncProbeState = ServerConnector.sync("probeState");
      syncProbeState.subscribe((obj:any)=>{
        if(obj){ probeState = obj; }
      });
      // Arrives once signed in; then also ask for the settings, which the
      // server only hands to admins.
      syncSso = ServerConnector.sync("ssoStatus");
      syncSso.subscribe((obj:any)=>{
        if(obj){ ssoStatus = obj; }
        if(!ssoAdmin){ loadSso(); }
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
      try{syncConnState && syncConnState.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("nmosConnectionState");}catch(e){}
      try{syncProbeState && syncProbeState.unsubscribe();}catch(e){}
      try{syncSso && syncSso.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("ssoStatus");}catch(e){}
      try{ServerConnector.unsync("probeState");}catch(e){}
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
      loadVirtualForm(serverState);
      formAutoMulticastEnabled = !!(serverState.autoMulticast && serverState.autoMulticast.enabled);
      formReconnectReceivers   = !!(serverState.autoMulticast && (
        (serverState.autoMulticast as any).reconnectReceiversOnSenderChange ??
        (serverState.autoMulticast as any).reconnectReceiversOnMulticastChange
      ));
      formAutoActivateSender   = !!serverState.autoActivateInactiveSender;
      formAudioMonitorEnabled  = !!(serverState.audioMonitor && serverState.audioMonitor.enabled);
      formBcp008Enabled        = !(serverState.bcp008 && serverState.bcp008.enabled === false);
      formDnssdEnabled         = !((serverState as any).registryDiscovery && (serverState as any).registryDiscovery.unicastDnssd === false);
      formDnssdDomain          = ((serverState as any).registryDiscovery && typeof (serverState as any).registryDiscovery.domain === "string") ? (serverState as any).registryDiscovery.domain : "";
      formMulticastRange       = serverState.multicastRange || "";
      formMulticastPools       = poolRowsFrom(serverState.multicastPools);
      formMulticastDefaultPoolName = serverState.multicastDefaultPoolName || "";
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
      if(ssoLoaded){ ssoForm = ssoFromView(ssoLoaded); }
      ssoDirty = false;
      ssoTest = { busy:false, ok:false, text:"" };
      dirty = false;
      saveError = "";
    }

    function save(){
      saveError = "";

      let port = parseInt(formPort);
      if(isNaN(port) || port <= 0 || port > 65535){
        fail("registry", "Port must be between 1 and 65535.");
        return;
      }

      // Sanity-check each profile
      for(let p of formProfiles){
        let pp = parseInt(""+p.port);
        if(isNaN(pp) || pp <= 0 || pp > 65535){
          fail("weblinks", "Vendor \""+(p.name||p.id)+"\": Port must be between 1 and 65535.");
          return;
        }
      }

      // Multicast range. Basic CIDR sanity check (single shared pool now)
      let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
      if(formMulticastRange && !cidrRe.test(formMulticastRange.trim())){
        fail("multicast", "Multicast DHCP: the default pool must use CIDR notation, e.g. 239.30.0.0/16");
        return;
      }
      // Pools by bandwidth: the obvious mistakes here; overlaps between
      // ranges are checked by the server, which refuses the save then.
      let poolsOut = poolPayload();
      let limitsSeen:number[] = [];
      let namesSeen:string[] = formMulticastDefaultPoolName.trim() ? [formMulticastDefaultPoolName.trim().toLowerCase()] : [];
      for(let p of poolsOut){
        if(p.name){
          if(namesSeen.includes(p.name.toLowerCase())){ fail("multicast", "Multicast DHCP: two pools are named \"" + p.name + "\"."); return; }
          namesSeen.push(p.name.toLowerCase());
        }
        if(!(p.maxMbps > 0) || !isFinite(p.maxMbps)){ fail("multicast", "Multicast DHCP: every pool needs a limit in Mbit/s above 0."); return; }
        if(limitsSeen.includes(p.maxMbps)){ fail("multicast", "Multicast DHCP: two pools have the limit " + p.maxMbps + " Mbit/s."); return; }
        limitsSeen.push(p.maxMbps);
        if(!cidrRe.test(p.range)){ fail("multicast", "Multicast DHCP: the pool up to " + p.maxMbps + " Mbit/s needs a CIDR range, e.g. 239.40.0.0/16"); return; }
      }

      // DDNS validation
      let ddnsPort = parseInt(formDdnsPort);
      if(isNaN(ddnsPort) || ddnsPort <= 0 || ddnsPort > 65535){
        fail("ddns", "DDNS: Port must be between 1 and 65535.");
        return;
      }
      let ddnsTtl = parseInt(formDdnsTtl);
      if(isNaN(ddnsTtl) || ddnsTtl <= 0){
        fail("ddns", "DDNS: TTL must be a positive number of seconds.");
        return;
      }
      if(formDdnsEnabled){
        if(!formDdnsServer.trim()){ fail("ddns", "DDNS: DNS server address is required when enabled."); return; }
        if(!formDdnsZone.trim()){ fail("ddns", "DDNS: Zone is required when enabled."); return; }
        // Unsigned mode ("none") needs no TSIG key at all.
        if(formDdnsKeyAlgorithm !== "none"){
          if(!formDdnsKeyName.trim()){ fail("ddns", "DDNS: TSIG key name is required when enabled."); return; }
          if(!formDdnsKeySecretSet && !formDdnsKeySecret){ fail("ddns", "DDNS: TSIG key secret is required when enabled."); return; }
        }
      }

      let payload:any = {
        registry: { ip: formIp.trim(), port: port },
        acceptableGmid: formGmid.trim(),
        vendorProfiles: formProfiles,
        virtualDevices: formVirtualDevices.map(d => ({ key: d.key, name: d.name })),
        virtualSenders: formVirtualSenders.map(v => ({ id: v.id, name: v.name, sdp: v.sdp, deviceKey: v.deviceKey })),
        virtualNode: {
          enabled: formVirtualNodeEnabled,
          registration: { mode: formVirtualRegMode, host: formVirtualRegHost, port: formVirtualRegPort }
        },
        multicastRange: formMulticastRange.trim(),
        multicastPools: poolsOut,
        multicastDefaultPoolName: formMulticastDefaultPoolName.trim(),
        autoMulticast: {
          enabled: formAutoMulticastEnabled,
          reconnectReceiversOnSenderChange: formReconnectReceivers
        },
        autoActivateInactiveSender: formAutoActivateSender,
        audioMonitor: { enabled: formAudioMonitorEnabled },
        bcp008: { enabled: formBcp008Enabled },
        registryDiscovery: { unicastDnssd: formDnssdEnabled, domain: formDnssdDomain.trim() },
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
      //   c) Auto-Allocation is on and the pools by bandwidth changed: keep
      //      every lease where it is, or re-sort everyone by bitrate.
      // Names do not move addresses: only limits and ranges count here.
      let poolsBefore  = JSON.stringify((serverState.multicastPools || []).map(p => ({ maxMbps: p.maxMbps, range: p.range })));
      let poolsAfter   = JSON.stringify(poolsOut.map((p:any) => ({ maxMbps: p.maxMbps, range: p.range })));
      let poolsChanged = nowEnabled && wasEnabled && poolsBefore !== poolsAfter;

      if(enabledNow || rangeChanged || poolsChanged){
        pendingPayload = payload;
        if(autoMulticastModal){ autoMulticastModal.showModal(); }
        return;
      }

      doSave(payload);
    }

    function doSave(payload:any){
      saving = true;
      saveError = "";
      // Single sign-on first: if the server refuses it, nothing is saved.
      const ssoStep = (ssoAdmin && ssoDirty && ssoForm)
        ? ServerConnector.post("ssoConfig", ssoPayload()).then((r:any)=>{
            ssoLoaded = r?.data || ssoLoaded;
            ssoForm = ssoFromView(ssoLoaded);
            ssoDirty = false;
          })
        : Promise.resolve();
      ssoStep.then(()=>ServerConnector.post("setupConfig", payload)).then((resp:any)=>{
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
        // The server names the section when the reason is in one.
        const section = e?.error?.section;
        if(typeof section === "string" && FOLD_IDS.includes(section)){ setOpen([section], true); }
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
    // The edit buffer, from what the server stored: devices by id, each
    // sender on the device the server put it on.
    function loadVirtualForm(obj:any){
      formVirtualDevices = Array.isArray(obj.virtualDevices) ? obj.virtualDevices.map((d:any) => ({ key: d.id, name: d.name || "" })) : [];
      formVirtualSenders = Array.isArray(obj.virtualSenders)
        ? obj.virtualSenders.map((v:any) => ({ id: v.id, name: v.name || "", sdp: v.sdp || "", deviceKey: v.deviceId || "", error: v.error || "" }))
        : [];
      formVirtualNodeEnabled = (obj.virtualNode && typeof obj.virtualNode.enabled === "boolean") ? obj.virtualNode.enabled : false;
      let reg = obj.virtualNode?.registration || {};
      formVirtualRegMode = reg.mode === "custom" ? "custom" : "registry";
      formVirtualRegHost = reg.host || "";
      formVirtualRegPort = reg.port ? ("" + reg.port) : "";
    }
    function addVirtualDevice(){
      formVirtualDevices = [...formVirtualDevices, { key: "new:" + Math.random().toString(36).slice(2,10), name: "" }];
      markDirty();
    }
    function removeVirtualDevice(key:string){
      let d = formVirtualDevices.find(x => x.key === key);
      let n = formVirtualSenders.filter(v => v.deviceKey === key).length;
      if(n > 0 && !window.confirm("Remove the device \"" + (d?.name || "unnamed") + "\" and its " + n + (n === 1 ? " sender" : " senders") + "? Nothing changes until you save.")) return;
      formVirtualDevices = formVirtualDevices.filter(x => x.key !== key);
      formVirtualSenders = formVirtualSenders.filter(v => v.deviceKey !== key);
      markDirty();
    }
    function addVirtualSender(deviceKey:string){
      formVirtualSenders = [...formVirtualSenders, {
        id:   "vs_" + Math.random().toString(36).slice(2,10),
        name: "",
        sdp:  "",
        deviceKey,
        error: ""
      }];
      markDirty();
    }
    function removeVirtualSender(id:string){
      formVirtualSenders = formVirtualSenders.filter(v => v.id !== id);
      markDirty();
    }
    $: virtualStatus = serverState.virtualNode?.status;


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
      pool: string;        // pool the lease lies in, by name or limit ("" = outside every pool)
      poolLimit: string;   // its limit ("≤ 2 Mbit/s", "∞"), shown on hover
      wantPool: string;    // pool its bitrate calls for
      misplaced: boolean;  // the two differ: "Renew from Pool" moves it
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
          liveStatus: l.liveStatus || "missing",
          pool: l.pool || "",
          poolLimit: l.poolLimit || "",
          wantPool: l.wantPool || "",
          misplaced: !!(l.wantPoolKey && l.poolKey !== l.wantPoolKey)
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
    <div class="setup-fold-all">
      <button type="button" on:click={()=>setOpen(FOLD_IDS, true)}>Expand all</button>
      <button type="button" on:click={()=>setOpen(FOLD_IDS, false)}>Collapse all</button>
    </div>

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
        <span>Unsaved changes. Click <strong>Save</strong> at the bottom of the page.</span>
      </div>
    {/if}


    <section class="setup-section" class:setup-folded={!openSections.registry}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"registry"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.registry}
                aria-label="Show or hide NMOS Registry"><Icon src={ChevronRight} /></button>
        <h3>NMOS Registry</h3>
        <HelpTip label="About the NMOS registry">
          <p>How the server finds the NMOS registry. With discovery enabled it first
          queries the DNS search domain for unicast DNS-SD records
          (<code>_nmos-register._tcp</code>) and falls back to mDNS when nothing is found.</p>
          <p>A static IP entered below always wins over any discovered registry.
          Leave the IP empty to rely on discovery alone.</p>
        </HelpTip>
        <span class="setup-summary">
          {#if registryStatusList.length === 0}
            <span class="setup-dot setup-dot-warning"></span><span>no registry</span>
          {:else}
            {#each registryStatusList.slice(0, 1) as r}
              <span class="setup-dot {regUp(r) > 0 && regUp(r) === regTotal(r) ? "setup-dot-success" : regUp(r) > 0 ? "setup-dot-warning" : "setup-dot-error"}"></span>
              <code>{r.ip}:{r.port}</code>
              <span>· {regUp(r)}/{regTotal(r) || 6} connected{registryStatusList.length > 1 ? " · +" + (registryStatusList.length - 1) : ""}</span>
            {/each}
          {/if}
        </span>
      </div>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Discover registry via unicast DNS-SD</span>
          <input type="checkbox" class="toggle" bind:checked={formDnssdEnabled} on:change={markDirty} />
        </label>
      </div>
      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">DNS-SD domain (optional)</span>
          <input type="text" class="input input-bordered" placeholder="uses the server DNS search domain"
                 bind:value={formDnssdDomain} on:input={markDirty} />
        </label>
      </div>
      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Registry IP (static, overrides discovery)</span>
          <input type="text" class="input input-bordered" placeholder="10.0.0.1"
                 bind:value={formIp} on:input={markDirty} />
        </label>
        <label class="setup-field setup-field-narrow">
          <span class="setup-label">Port</span>
          <input type="number" class="input input-bordered" min="1" max="65535"
                 bind:value={formPort} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-registry-status">
        <div class="setup-registry-row">
          <span class="setup-registry-source">DNS-SD</span>
          {#if !dnssdStatus.enabled}
            <span>discovery disabled</span>
          {:else if Array.isArray(dnssdStatus.domains) && dnssdStatus.domains.length > 0}
            <span>searching domain{dnssdStatus.domains.length === 1 ? "" : "s"}: <code>{dnssdStatus.domains.join(", ")}</code>{dnssdStatus.override ? " (configured above)" : " (from the server DNS search domain)"}</span>
          {:else}
            <!-- The usual cause is not a missing domain but Docker: on a host
                 running systemd-resolved, /etc/resolv.conf points at the
                 127.0.0.53 stub, and Docker replaces the file inside the
                 container WITHOUT the search list. `resolvectl domain` on the
                 host then shows a domain the container never sees. -->
            <span>no DNS search domain found, mDNS and the static IP take over</span>
            <HelpTip label="Why no search domain?">
              <p>The host may still have one: on a systemd-resolved host Docker hands the
              container its own <code>resolv.conf</code> without the search list.</p>
              <p>Either set the domain above, start the container with
              <code>--dns-search &lt;domain&gt;</code> (compose: <code>dns_search:</code>),
              or mount <code>/run/systemd/resolve</code> into it.</p>
            </HelpTip>
          {/if}
        </div>
        {#if registryStatusList.length === 0}
          <div class="setup-registry-row">
            <span class="setup-dot setup-dot-warning"></span>
            <span>No registry connected. Discovery keeps looking via unicast DNS-SD and mDNS.</span>
          </div>
        {:else}
          {#each registryStatusList as r}
            {@const total = regTotal(r)}
            {@const up = regUp(r)}
            <div class="setup-registry-row">
              <span class="setup-dot {up > 0 && up === total ? "setup-dot-success" : up > 0 ? "setup-dot-warning" : "setup-dot-error"}"></span>
              <code>{r.ip}:{r.port}</code>
              <span class="setup-registry-source">{r.source === "dnssd" ? "unicast DNS-SD" : r.source === "mdns" ? "mDNS" : "static"}{typeof r.priority === "number" ? " · priority " + r.priority : ""}</span>
              <span>{up}/{total || 6} query subscriptions connected</span>
              {#if regVersions(r)}<span class="setup-registry-source">{regVersions(r)}</span>{/if}
            </div>
          {/each}
        {/if}
      </div>
    </section>


    <section class="setup-section" class:setup-folded={!openSections.gmid}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"gmid"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.gmid}
                aria-label="Show or hide Acceptable PTP GMID"><Icon src={ChevronRight} /></button>
        <h3>Acceptable PTP GMID</h3>
        <HelpTip label="About the PTP GMID">
          <p>Expected PTP Grand-Master ID. Devices whose node clock is locked to this GMID
          get a <span class="setup-dot setup-dot-success"></span> green status dot on the
          Details page, all others get a <span class="setup-dot setup-dot-warning"></span> yellow one.
          Leave empty to disable the comparison.</p>
        </HelpTip>
        <span class="setup-summary">
          {#if formGmid.trim()}<code>{formGmid.trim()}</code>{:else}<span>not set</span>{/if}
        </span>
      </div>

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">GMID</span>
          <input type="text" class="input input-bordered" placeholder="00-00-00-FF-FE-00-00-00"
                 bind:value={formGmid} on:input={markDirty} />
        </label>
      </div>
    </section>


    <section class="setup-section">
      <div class="setup-section-head">
        <span class="setup-fold-spacer"></span>
        <h3>Receiver Auto-Reconnect</h3>
        <HelpTip label="About receiver auto-reconnect">
          <p>Whenever a sender's SDP changes (multicast IP / port, or e.g. channel count,
          video format, colorimetry), redo the connection of every receiver currently
          subscribed to it so they pick up the new manifest. Recommended on for production.</p>
          <p>The one-shot „Renew from Pool" sweep in <em>Multicast DHCP</em>
          ignores this setting and always reconnects.</p>
        </HelpTip>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Auto-reconnect receivers on sender SDP change"
               bind:checked={formReconnectReceivers} on:change={markDirty} />
      </div>
    </section>


    <section class="setup-section">
      <div class="setup-section-head">
        <span class="setup-fold-spacer"></span>
        <h3>Crosspoint: Auto-Activate Sender</h3>
        <HelpTip label="About auto-activating senders">
          <p>When a connection is made on the Crosspoint page whose source sender is
          currently <em>inactive</em> (<code>master_enable&nbsp;=&nbsp;false</code>), automatically
          PATCH that sender active first, wait for it to (re)publish its SDP,
          and only then patch the receiver.</p>
          <p>Off by default. Many control rooms activate senders through a separate
          workflow and don't want a stray click on the matrix to put a sender on air.</p>
        </HelpTip>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Auto-activate inactive sender on Crosspoint connect"
               bind:checked={formAutoActivateSender} on:change={markDirty} />
      </div>
    </section>


    <section class="setup-section">
      <div class="setup-section-head">
        <span class="setup-fold-spacer"></span>
        <h3>BCP-008 Status Monitoring</h3>
        <HelpTip label="About BCP-008 status monitoring">
          <p>Live health monitoring of senders and receivers via
          <strong>AMWA BCP-008</strong> (IS-12 control protocol): for every
          device that advertises an <code>ncp</code> control endpoint, the
          server subscribes to its NcSender-/NcReceiverMonitors and shows the
          health as the colour of each flow's essence glyph in the Crosspoint matrix.</p>
          <p>With the four status domains (Link / Connection / Sync / Stream resp.
          Transmission / Essence), transition counters, a counter reset and
          coloured crosspoints when an endpoint of an active connection degrades.</p>
          <p>Read-only on the network (it never changes device state).
          Devices without BCP-008 support show a greyed-out symbol.</p>
        </HelpTip>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable BCP-008 Status Monitoring"
               bind:checked={formBcp008Enabled} on:change={markDirty} />
      </div>
    </section>


    <section class="setup-section" class:setup-folded={!openSections.audio}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"audio"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.audio}
                aria-label="Show or hide Audio Monitor (experimental)"><Icon src={ChevronRight} /></button>
        <h3>Audio Monitor (experimental)</h3>
        <HelpTip label="About the audio monitor">
          <p>Adds a 🎧 button next to each audio sender on the Details page.
          Clicking it makes the server join that sender's multicast on
          demand, transcode the PCM to Opus 48 kHz stereo and stream it to
          your browser via WebRTC. One sender per browser tab; multi-channel
          streams (8 ch / 16 ch AES67) get a channel-pair selector in the player.</p>
          <p>Off by default, it costs CPU per active monitor. With the toggle off
          the 🎧 button is hidden.</p>
          <p><strong>Network requirement:</strong> the server must reach the
          media network to receive the streams (IGMP join on the ST&nbsp;2110 VLAN).
          In Docker this means <code>--network host</code> (or a macvlan/interface
          in the media VLAN); on the default bridge network the 🎧 button connects
          but stays silent. Alternatively use a probe (below).</p>
        </HelpTip>
        {#if formAudioMonitorEnabled}
          <span class="setup-summary">
            {#if !probeState.probes || probeState.probes.length === 0}
              <span class="setup-dot setup-dot-warning"></span><span>no probe</span>
            {:else if probeState.probes.length === 1}
              <span class="setup-dot setup-dot-success"></span><span>probe {probeState.probes[0].name}</span>
            {:else}
              <span class="setup-dot setup-dot-success"></span><span>{probeState.probes.length} probes</span>
            {/if}
          </span>
        {/if}
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable Audio Monitor"
               bind:checked={formAudioMonitorEnabled} on:change={(e)=>{ markDirty(); openIfOn("audio", e); }} />
      </div>

      <div class="setup-subhead">
        <h4>Multicast Probe</h4>
        <HelpTip label="About the multicast probe">
          <p>A helper container on a host attached to the media network: it
          receives the multicast there and forwards it to this server as
          unicast. When a probe is connected the Audio Monitor uses it
          automatically instead of a local IGMP join, so this server needs
          no multicast access at all. It is the same image started in probe
          mode, with the command below.</p>
          <p>The token is minted once and persisted in <code>settings.json</code>,
          so it survives updates and restarts as long as the config volume is
          mounted (container path <code>/nmos-crosspoint/server/config</code>).
          A probe therefore only needs to be configured once.</p>
        </HelpTip>
      </div>
      <div class="setup-probe-cmd">
        <code>docker run -d --name nmos_crosspoint_v3_probe --restart unless-stopped --network host -e MODE=probe -e CROSSPOINT_URL=ws://&lt;this server&gt; -e PROBE_TOKEN=&lt;token below&gt; -e PROBE_NAME="Studio A" gemini2350/nmos-crosspoint_v3</code>
      </div>
      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Probe token</span>
          <input type="text" class="input input-bordered setup-probe-token" readonly value={probeState.token || ""} on:focus={(e)=>e.currentTarget.select()} />
        </label>
      </div>
      <div class="setup-registry-status">
        {#if !probeState.probes || probeState.probes.length === 0}
          <div class="setup-registry-row">
            <span class="setup-dot setup-dot-warning"></span>
            <span>No probe connected. The Audio Monitor uses a local IGMP join.</span>
          </div>
        {:else}
          {#each probeState.probes as p}
            <div class="setup-registry-row">
              <span class="setup-dot setup-dot-success"></span>
              <code>{p.name}</code>
              <span class="setup-registry-source">{p.address}</span>
              <span>{p.streams} active stream{p.streams === 1 ? "" : "s"}</span>
            </div>
          {/each}
        {/if}
      </div>
    </section>


    <section class="setup-section" class:setup-folded={!openSections.multicast}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"multicast"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.multicast}
                aria-label="Show or hide Multicast DHCP"><Icon src={ChevronRight} /></button>
        <h3>Multicast DHCP</h3>
        <HelpTip label="About multicast DHCP">
          <p>The server reserves a pair of consecutive multicast addresses per <strong>active</strong> sender
          (odd for Leg 1, even = odd + 1 for Leg 2). The reservation is kept for the lifetime of the
          device, even while the sender is offline, and is only released when the device is
          <em>Forgotten</em> on the Details page or its lease is deleted in the inventory below.</p>
          <p><strong>An address is (re-)assigned in two cases:</strong></p>
          <ul>
            <li>when a sender becomes <em>active</em> (its NMOS subscription transitions to active) and has no lease yet;</li>
            <li>when the destination IP of an <em>active</em> sender is cleared: the field on the Details page is emptied or its lease is released here.</li>
          </ul>
          <p>Manual overrides on the Details page are respected: typing a different IP marks it as the
          effective address; clearing the field reverts to the reserved address.</p>
          <p><strong>Pools by bandwidth:</strong> a sender gets its pair from the smallest pool whose
          limit covers its bitrate per leg (the limit included). Higher bitrates, and senders whose
          bitrate is unknown, go into the <em>default</em> pool. A full pool hands out nothing: the
          sender keeps its address and the log says so. Leases stay where they are when you change the
          pools; <em>Renew from Pool</em> sorts every active sender in again.</p>
        </HelpTip>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable Multicast DHCP"
               bind:checked={formAutoMulticastEnabled} on:change={(e)=>{ markDirty(); openIfOn("multicast", e); }} />
      </div>

      <div class="setup-form">
        <div class="setup-field setup-pools">
          <span class="setup-label">Pools by bandwidth</span>
          <div class="vendor-table-wrap">
            <table class="vendor-table pool-table">
              <thead>
                <tr><th>Name</th><th>Bitrate per leg</th><th>Range</th><th>Pairs used</th><th></th></tr>
              </thead>
              <tbody>
                {#each formMulticastPools as p (p.id)}
                  <tr>
                    <td>
                      <input type="text" class="input input-bordered input-sm pool-name-input" maxlength="40"
                             placeholder="e.g. Audio" aria-label="Pool name" bind:value={p.name} on:input={markDirty} />
                    </td>
                    <td>
                      <span class="pool-limit">up to
                        <input type="text" inputmode="decimal" class="input input-bordered input-sm pool-limit-input"
                               placeholder="2" aria-label="Limit in Mbit/s" bind:value={p.maxMbps} on:input={markDirty} />
                        Mbit/s</span>
                    </td>
                    <td>
                      <input type="text" class="input input-bordered input-sm vendor-mono pool-range-input"
                             placeholder="239.40.0.0/16" aria-label="Range" bind:value={p.range} on:input={markDirty} />
                    </td>
                    <td class="vendor-mono pool-used">{poolUsed(leaseSnapshot, String(Number((p.maxMbps || "").replace(",", "."))), p.range)}</td>
                    <td>
                      <button class="btn btn-ghost btn-sm" on:click={()=>removePool(p.id)}
                              aria-label="Remove pool" title="Remove">
                        <Icon src={Trash} />
                      </button>
                    </td>
                  </tr>
                {/each}
                <tr class="pool-default">
                  <td>
                    <input type="text" class="input input-bordered input-sm pool-name-input" maxlength="40"
                           placeholder="default" aria-label="Default pool name" bind:value={formMulticastDefaultPoolName} on:input={markDirty} />
                  </td>
                  <td><span class="pool-inf">∞</span> <span class="pool-default-name">default</span></td>
                  <td>
                    <input type="text" class="input input-bordered input-sm vendor-mono pool-range-input"
                           placeholder="239.30.0.0/16" aria-label="Default range" bind:value={formMulticastRange} on:input={markDirty} />
                  </td>
                  <td class="vendor-mono pool-used">{poolUsed(leaseSnapshot, "default", formMulticastRange)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="vendor-actions-row">
            <button class="btn btn-sm" on:click={addPool}><Icon src={Plus} /> Add pool</button>
          </div>
        </div>
      </div>

      <div class="setup-form setup-form-buttons">
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
                <th>Pool</th>
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
                  <td class="lease-pool">
                    {#if r.pool}<span class="lease-pool-badge" title={r.pool !== r.poolLimit ? r.poolLimit : ""}>{r.pool}</span>{:else}<span class="lease-pool-none" title="The lease lies in none of the pools (e.g. an address kept with Keep current IPs)">outside</span>{/if}
                    {#if r.misplaced}
                      <span class="lease-pool-want" title="Its bitrate calls for {r.wantPool}. Renew from Pool moves it there.">→ {r.wantPool}</span>
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
                <tr><td colspan="11" class="vendor-empty">
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


    <section class="setup-section" class:setup-folded={!openSections.virtual}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"virtual"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.virtual}
                aria-label="Show or hide Virtual Senders"><Icon src={ChevronRight} /></button>
        <h3>Virtual Senders</h3>
        <HelpTip label="About virtual senders">
          <p>Operator-defined senders for devices that don't speak NMOS themselves: paste their SDPs
          below and NMOS Crosspoint exposes itself as an IS-04 <strong>Node</strong> and publishes each
          entry as a real NMOS sender (with full Source / Flow / Sender records and an IS-05
          <code>transport_file</code> endpoint). Once registered, the senders show up in <em>every</em>
          NMOS-aware controller on the network, not just here.</p>
          <p>The senders sit on <strong>devices</strong> of that Node; make as many as you like and
          move a sender to another device with its Device field.</p>
          <p>The Node registers at the registry above, or at a registration API of its own when the
          registry's query and registration API listen on different addresses or ports. Heartbeats keep
          it alive; switching registries deregisters at the old one cleanly. The toggle turns this Node
          on and off; switched off, the devices and senders stay saved.</p>
          <p>Each sender keeps the same UUID across restarts, so receivers stay bound. The destination IP
          comes from the SDP exactly as you typed it; virtual senders are read-only over IS-05,
          so the multicast-edit pencil is hidden for them on the Details page.</p>
        </HelpTip>
        {#if formVirtualNodeEnabled && serverState.virtualNode?.enabled && virtualStatus}
          <span class="setup-summary">
            {#if virtualStatus.state === "registered"}
              <span class="setup-dot setup-dot-success"></span>
              <span>registered · {virtualStatus.devices} {virtualStatus.devices === 1 ? "device" : "devices"}, {virtualStatus.senders} {virtualStatus.senders === 1 ? "sender" : "senders"}</span>
            {:else if virtualStatus.state === "error"}
              <span class="setup-dot setup-dot-error"></span><span>registration failed</span>
            {:else if virtualStatus.state === "none"}
              <span class="setup-dot setup-dot-warning"></span><span>no registry yet</span>
            {/if}
          </span>
        {/if}
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable Virtual NMOS Node"
               bind:checked={formVirtualNodeEnabled} on:change={(e)=>{ markDirty(); openIfOn("virtual", e); }} />
      </div>

      <div class="setup-subhead"><h4>Register at</h4></div>
      <div class="virtual-reg">
        <label>
          <input type="radio" class="radio radio-sm" value="registry" bind:group={formVirtualRegMode} on:change={markDirty} />
          <span>The registry above
            {#if serverState.virtualNode?.registryTarget}<code>{serverState.virtualNode.registryTarget}</code>{:else}(none connected yet){/if}</span>
        </label>
        <label>
          <input type="radio" class="radio radio-sm" value="custom" bind:group={formVirtualRegMode} on:change={markDirty} />
          <span>Another registration API (when the registry's query and registration API differ)</span>
        </label>
      </div>
      {#if formVirtualRegMode === "custom"}
        <div class="setup-form virtual-reg-form">
          <label class="setup-field">
            <span class="setup-label">Registration API IP / host</span>
            <input type="text" class="input input-bordered" placeholder="e.g. 10.0.100.112"
                   bind:value={formVirtualRegHost} on:input={markDirty} />
          </label>
          <label class="setup-field setup-field-narrow">
            <span class="setup-label">Port</span>
            <input type="number" class="input input-bordered" min="1" max="65535" placeholder="3210"
                   bind:value={formVirtualRegPort} on:input={markDirty} />
          </label>
        </div>
      {/if}
      {#if serverState.virtualNode?.enabled && virtualStatus}
        <div class="setup-registry-status">
          <div class="setup-registry-row">
            {#if virtualStatus.state === "registered"}
              <span class="setup-dot setup-dot-success"></span>
              <code>{virtualStatus.target}</code>
              <span>registered · {virtualStatus.devices} {virtualStatus.devices === 1 ? "device" : "devices"}, {virtualStatus.senders} {virtualStatus.senders === 1 ? "sender" : "senders"}</span>
            {:else if virtualStatus.state === "error"}
              <span class="setup-dot setup-dot-error"></span>
              <code>{virtualStatus.target}</code>
              <span>registration failed: {virtualStatus.error}</span>
            {:else if virtualStatus.state === "none"}
              <span class="setup-dot setup-dot-warning"></span>
              <span>No registry to register at yet — it registers as soon as one is connected.</span>
            {/if}
          </div>
        </div>
      {/if}

      <div class="setup-subhead"><h4>Devices</h4></div>
      {#each formVirtualDevices as d (d.key)}
        {@const devSenders = formVirtualSenders.filter(v => v.deviceKey === d.key)}
        <div class="virtual-device">
          <div class="virtual-device-head">
            <Icon src={ServerStack} class="virtual-device-icon" />
            <input type="text" class="input input-bordered input-sm virtual-device-name"
                   placeholder="Device name (e.g. Playout)" aria-label="Device name"
                   bind:value={d.name} on:input={markDirty} />
            <span class="virtual-device-count">{devSenders.length} {devSenders.length === 1 ? "sender" : "senders"}</span>
            <span class="virtual-device-gap"></span>
            <button class="btn btn-ghost btn-sm" on:click={()=>removeVirtualDevice(d.key)}
                    aria-label="Remove device" title="Remove device">
              <Icon src={Trash} />
            </button>
          </div>

          {#each devSenders as v (v.id)}
            <details class="virtual-sender-row">
              <summary class="virtual-sender-head">
                <span class="virtual-sender-summary-name">
                  {v.name || "(unnamed virtual sender)"}
                </span>
                <span class="virtual-sender-summary-meta" class:virtual-sender-summary-error={!!v.error}>
                  {v.error ? "SDP error" : v.sdp ? "SDP set" : "no SDP"}
                </span>
                <button class="btn btn-ghost btn-sm"
                        on:click|stopPropagation|preventDefault={()=>removeVirtualSender(v.id)}
                        aria-label="Remove virtual sender" title="Remove">
                  <Icon src={Trash} />
                </button>
              </summary>

              <div class="virtual-sender-body">
                <div class="setup-form virtual-sender-fields">
                  <label class="setup-field">
                    <span class="setup-label">Name</span>
                    <input type="text" class="input input-bordered input-sm virtual-sender-name"
                           placeholder="Sender name (e.g. PlayoutA)"
                           bind:value={v.name} on:input={markDirty} />
                  </label>
                  <label class="setup-field">
                    <span class="setup-label">Device</span>
                    <select class="select select-bordered select-sm virtual-sender-device"
                            bind:value={v.deviceKey} on:change={()=>{ formVirtualSenders = formVirtualSenders; markDirty(); }}>
                      {#each formVirtualDevices as o (o.key)}
                        <option value={o.key}>{o.name || "(unnamed device)"}</option>
                      {/each}
                    </select>
                  </label>
                </div>
                <label class="setup-field" style="margin-top:6px;">
                  <span class="setup-label">SDP</span>
                  <textarea class="textarea textarea-bordered vendor-mono virtual-sender-sdp"
                            rows="8" placeholder="Paste a full SDP here…&#10;v=0&#10;o=- 0 0 IN IP4 …&#10;s=…&#10;m=audio 5004 RTP/AVP 96&#10;c=IN IP4 239.x.x.x/32&#10;a=rtpmap:96 L24/48000/2"
                            bind:value={v.sdp} on:input={()=>{ v.error = ""; markDirty(); }}></textarea>
                </label>
                {#if v.error}
                  <p class="virtual-sender-error">Not published: {v.error}</p>
                {/if}
              </div>
            </details>
          {/each}

          <button class="btn btn-xs" on:click={()=>addVirtualSender(d.key)}>
            <Icon src={Plus} /> Add sender
          </button>
        </div>
      {/each}
      {#if formVirtualDevices.length === 0}
        <p class="vendor-empty">No virtual devices defined.</p>
      {/if}

      <div class="vendor-actions-row virtual-device-actions">
        <button class="btn btn-sm" on:click={addVirtualDevice}>
          <Icon src={Plus} /> Add device
        </button>
      </div>
    </section>


    <section class="setup-section" class:setup-folded={!openSections.weblinks}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"weblinks"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.weblinks}
                aria-label="Show or hide Device Web UI Link Setup"><Icon src={ChevronRight} /></button>
        <h3>Device Web UI Link Setup</h3>
        <HelpTip label="About device web UI links">
          <p>How the „Open device web UI" link on the Details page is built depends on the vendor.
          Profiles are checked top-to-bottom, the <strong>first</strong> match wins.</p>
          <p>A profile matches when one of its label entries appears as a substring in the node label
          or description. Separate multiple labels with <code>,</code>.</p>
        </HelpTip>
      </div>

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


    <section class="setup-section" class:setup-folded={!openSections.ddns}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"ddns"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.ddns}
                aria-label="Show or hide Push Names to DNS (DDNS)"><Icon src={ChevronRight} /></button>
        <h3>Push Names to DNS (DDNS)</h3>
        <HelpTip label="About DDNS">
          <p>Publishes each NMOS node as an <strong>A record</strong> via standard
          <strong>RFC&nbsp;2136 Dynamic Updates</strong>. Works with BIND9,
          Knot&nbsp;DNS, PowerDNS, Windows DNS Server and any other server that
          accepts <code>nsupdate</code>-style updates.</p>
          <p>Authentication is either a <strong>TSIG key</strong> (the zone allows updates
          signed with the key below, e.g. BIND:
          <code>update-policy &#123; grant &lt;keyname&gt; zonesub A; &#125;;</code>)
          or algorithm <strong>none&nbsp;(unsigned)</strong>: plain unauthenticated
          updates for zones that authorise by source IP (e.g. BIND:
          <code>allow-update &#123; &lt;server-ip&gt;; &#125;;</code>). Unsigned is fine on an
          isolated management network; prefer TSIG whenever the DNS server supports it.</p>
          <p>The hostname is the node label (or the device alias if you set one on the
          Crosspoint / Details page); the IP comes from the node's <code>href</code>.
          NMOS Crosspoint keeps a local inventory of the records it created, so it
          only ever updates or deletes its own. Deleting a device with the Forget
          button also removes its DNS record.</p>
        </HelpTip>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable DDNS"
               bind:checked={formDdnsEnabled} on:change={(e)=>{ markDirty(); openIfOn("ddns", e); }} />
      </div>

      <div class="setup-form">
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

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Zone</span>
          <input type="text" class="input input-bordered" placeholder="media.example.net"
                 bind:value={formDdnsZone} on:input={markDirty} />
        </label>
      </div>

      <div class="setup-form">
        <label class="setup-field setup-field-select">
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

      <div class="setup-form">
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


    {#if ssoAdmin && ssoForm}
    <section class="setup-section" class:setup-folded={!openSections.sso}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"sso"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.sso}
                aria-label="Show or hide Single sign-on (OpenID Connect)"><Icon src={ChevronRight} /></button>
        <h3>Single sign-on (OpenID Connect)</h3>
        <HelpTip label="About single sign-on">
          <p>Sign in with an OpenID Connect provider (Keycloak, Entra ID, Authentik, …)
          beside the local accounts, which keep working. Authorization code flow with PKCE;
          the ID token is checked against the provider's keys.</p>
          <p>The rights come from a claim of the ID token, its groups or roles: each value
          you list below gives the crosspoint groups ticked. An account that gets no group
          is not signed in.</p>
          <p>Saving a change ends all single sign-on sessions; everyone signs in again
          with the new settings. Only members of the admin group see and change this.</p>
        </HelpTip>
        <span class="sso-badge">ADMINS ONLY</span>
        <input type="checkbox" class="toggle setup-head-toggle" aria-label="Enable single sign-on"
               bind:checked={ssoForm.enabled} on:change={(e)=>{ ssoChanged(); openIfOn("sso", e); }} />
      </div>

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Issuer URL</span>
          <input type="text" class="input input-bordered" placeholder="https://sso.example.com/realms/media"
                 bind:value={ssoForm.issuer} on:input={ssoChanged} />
        </label>
      </div>
      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Client ID</span>
          <input type="text" class="input input-bordered" placeholder="nmos-crosspoint"
                 bind:value={ssoForm.clientId} on:input={ssoChanged} />
        </label>
        <label class="setup-field">
          <span class="setup-label">Client secret
            {#if ssoForm.secretSet && !ssoForm.clearSecret}
              <button class="sso-link" on:click|preventDefault={()=>{ ssoForm.clearSecret = true; ssoForm.clientSecret = ""; ssoChanged(); }}>remove</button>
            {/if}
          </span>
          <input type="password" class="input input-bordered" autocomplete="new-password"
                 placeholder={ssoForm.clearSecret ? "removed on save (public client)" : ssoForm.secretSet ? "stored, blank keeps it" : "confidential client only"}
                 bind:value={ssoForm.clientSecret} on:input={()=>{ ssoForm.clearSecret = false; ssoChanged(); }} />
        </label>
        <label class="setup-field">
          <span class="setup-label">Button text</span>
          <input type="text" class="input input-bordered sso-plain" placeholder="SSO" maxlength="40"
                 bind:value={ssoForm.label} on:input={ssoChanged} />
        </label>
      </div>
      <div class="setup-form setup-form-buttons">
        <button class="btn btn-sm" on:click={ssoTestProvider} disabled={ssoTest.busy || !ssoForm.issuer}>
          {ssoTest.busy ? "Testing…" : "Test provider"}
        </button>
        {#if ssoTest.text}
          <span class={"sso-test " + (ssoTest.ok ? "text-success" : "text-error")}>{ssoTest.ok ? "✓ " : ""}{ssoTest.text}</span>
        {/if}
      </div>

      <div class="setup-subhead"><h4>Rights</h4></div>
      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">Groups claim in the ID token</span>
          <input type="text" class="input input-bordered" placeholder="groups (or e.g. realm_access.roles)"
                 bind:value={ssoForm.groupsClaim} on:input={ssoChanged} />
        </label>
      </div>
      <div class="vendor-table-wrap sso-map-wrap">
        <table class="vendor-table sso-map">
          <thead>
            <tr>
              <th>Value at the provider</th>
              {#each ssoForm.groupsAvailable as g}<th class="sso-col">{ssoGroupLabel(g)}</th>{/each}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each ssoForm.mappings as m, i}
              <tr>
                <td>
                  <input type="text" class="input input-bordered input-sm vendor-mono" placeholder="e.g. crosspoint-operators"
                         aria-label="Value at the provider" bind:value={m.value} on:input={ssoChanged} />
                </td>
                {#each ssoForm.groupsAvailable as g}
                  <td class="sso-col">
                    <input type="checkbox" class="checkbox checkbox-sm" aria-label={ssoGroupLabel(g)}
                           checked={m.groups.includes(g)}
                           on:change={()=>{ m.groups = ssoToggleGroup(m.groups, g); ssoForm.mappings = ssoForm.mappings; ssoChanged(); }} />
                  </td>
                {/each}
                <td>
                  <button class="btn btn-ghost btn-sm" on:click={()=>ssoRemoveMapping(i)} aria-label="Remove mapping" title="Remove">
                    <Icon src={Trash} />
                  </button>
                </td>
              </tr>
            {/each}
            <tr>
              <td class="sso-everyone">Everyone who signs in</td>
              {#each ssoForm.groupsAvailable as g}
                <td class="sso-col">
                  <input type="checkbox" class="checkbox checkbox-sm" aria-label={"Everyone: " + ssoGroupLabel(g)}
                         checked={ssoForm.everyone.includes(g)}
                         on:change={()=>{ ssoForm.everyone = ssoToggleGroup(ssoForm.everyone, g); ssoChanged(); }} />
                </td>
              {/each}
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="vendor-actions-row">
        <button class="btn btn-sm" on:click={ssoAddMapping}><Icon src={Plus} /> Add mapping</button>
      </div>

      <div class="sso-register">
        <b>Register at your provider</b>
        <div><span>Redirect URI</span><code>{ssoRedirectUri(ssoForm)}</code>
          <button class="btn btn-ghost btn-xs" on:click={()=>copyText(ssoRedirectUri(ssoForm))}>Copy</button></div>
        <div><span>Post-logout redirect URI</span><code>{ssoLogoutUri(ssoForm)}</code>
          <button class="btn btn-ghost btn-xs" on:click={()=>copyText(ssoLogoutUri(ssoForm))}>Copy</button></div>
      </div>

      <details class="lease-inventory">
        <summary>Advanced</summary>
        <div class="setup-form">
          <label class="setup-field">
            <span class="setup-label">Redirect URI (only behind a proxy)</span>
            <input type="text" class="input input-bordered" placeholder={"taken from the browser's address, …" + ssoForm.callbackPath}
                   bind:value={ssoForm.redirectUri} on:input={ssoChanged} />
          </label>
        </div>
        <div class="setup-form">
          <label class="setup-field">
            <span class="setup-label">Scopes</span>
            <input type="text" class="input input-bordered" placeholder="openid profile email"
                   bind:value={ssoForm.scopes} on:input={ssoChanged} />
          </label>
          <label class="setup-field setup-field-narrow">
            <span class="setup-label">Session (h)</span>
            <input type="number" class="input input-bordered" min="1" max="168"
                   bind:value={ssoForm.sessionHours} on:input={ssoChanged} />
          </label>
        </div>
      </details>

      {#if ssoStatus.enabled}
        <div class="setup-registry-status">
          <div class="setup-registry-row">
            <span class="setup-dot setup-dot-success"></span>
            <span>Single sign-on is on · {ssoStatus.sessions} {ssoStatus.sessions === 1 ? "user" : "users"} signed in with it</span>
          </div>
        </div>
      {/if}
    </section>
    {:else if ssoStatus.enabled}
    <section class="setup-section" class:setup-folded={!openSections.sso}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"sso"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.sso}
                aria-label="Show or hide Single sign-on (OpenID Connect)"><Icon src={ChevronRight} /></button>
        <h3>Single sign-on (OpenID Connect)</h3>
        <span class="sso-badge">ADMINS ONLY</span>
      </div>
      <div class="setup-registry-status">
        <div class="setup-registry-row">
          <span class="setup-dot setup-dot-success"></span>
          <span>On, with {ssoStatus.label} ({ssoStatus.issuer}). Only members of the admin group can change it.</span>
        </div>
      </div>
    </section>
    {/if}


    <section class="setup-section" class:setup-folded={!openSections.login}>
      <div class="setup-section-head setup-head-fold" use:foldHead={"login"}>
        <button type="button" class="setup-fold" aria-expanded={!!openSections.login}
                aria-label="Show or hide Change Login and Password"><Icon src={ChevronRight} /></button>
        <h3>Change Login &amp; Password</h3>
        <HelpTip label="About login and password">
          <p>Updates the admin user stored in <code>./config/users.json</code>.
          You can only edit your own account, and you must know the current
          password. After a change, the server asks you to log in again
          with the new credentials.</p>
        </HelpTip>
      </div>

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

      <div class="setup-form">
        <label class="setup-field">
          <span class="setup-label">New username</span>
          <input type="text" class="input input-bordered" autocomplete="username"
                 bind:value={formCredNewUser} />
        </label>
      </div>

      <div class="setup-form">
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

      <div class="setup-form setup-form-buttons">
        <button class="btn btn-primary btn-sm" on:click={saveCredentials} disabled={credSaving}>
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


    <section class="setup-about">
      <h3>About</h3>
      <div class="about-brand">
        <Logo size={38} />
        <b>NMOS Crosspoint<span class="v3-badge">V3</span></b>
        {#if serverState.version}<span class="about-version">v{serverState.version}</span>{/if}
      </div>
      <dl>
        <dt>V3</dt><dd>Oliver Ettlin (Gemini2350), Simplexity</dd>
        <dt>Original</dt><dd>Johannes Grieb, 2021</dd>
        <dt>License</dt><dd><a href="https://github.com/Gemini2350/nmos-crosspoint_v3/blob/master/LICENSE.md" target="_blank" rel="noopener noreferrer">MIT</a></dd>
        <dt>Source</dt><dd><a href="https://github.com/Gemini2350/nmos-crosspoint_v3" target="_blank" rel="noopener noreferrer">github.com/Gemini2350/nmos-crosspoint_v3</a></dd>
      </dl>
    </section>
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



