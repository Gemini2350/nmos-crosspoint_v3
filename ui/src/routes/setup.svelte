<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService";
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";

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
    interface MulticastRanges {
      audioLow: string;
      audioHigh: string;
      video: string;
    }
    interface LeaseStat { used: number; total: number }
    interface SetupConfig {
      registry: { ip:string, port:number };
      acceptableGmid: string;
      vendorProfiles: VendorProfile[];
      multicastRanges: MulticastRanges;
      autoMulticast: { enabled: boolean };
      multicastStats: { audioLow: LeaseStat, audioHigh: LeaseStat, video: LeaseStat };
      restartRequired: boolean;
    }

    let serverState:SetupConfig = {
      registry: { ip: "", port: 80 },
      acceptableGmid: "",
      vendorProfiles: [],
      multicastRanges: { audioLow: "", audioHigh: "", video: "" },
      autoMulticast: { enabled: false },
      multicastStats: { audioLow:{used:0,total:0}, audioHigh:{used:0,total:0}, video:{used:0,total:0} },
      restartRequired: false
    };

    // Local edit buffer (so typing doesn't fight the sync)
    let formIp:string = "";
    let formPort:string = "80";
    let formGmid:string = "";
    let formProfiles:VendorProfile[] = [];
    let formAutoMulticastEnabled:boolean = false;
    let formRangeAudioLow:string  = "";
    let formRangeAudioHigh:string = "";
    let formRangeVideo:string     = "";

    // Live preview of detected devices for the vendor table
    let detectedDevices:Array<{ id:string, label:string, match:string }> = [];

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
            if(obj.multicastRanges){
              formRangeAudioLow  = obj.multicastRanges.audioLow  || "";
              formRangeAudioHigh = obj.multicastRanges.audioHigh || "";
              formRangeVideo     = obj.multicastRanges.video     || "";
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
      formRangeAudioLow  = serverState.multicastRanges?.audioLow  || "";
      formRangeAudioHigh = serverState.multicastRanges?.audioHigh || "";
      formRangeVideo     = serverState.multicastRanges?.video     || "";
      dirty = false;
      saveError = "";
      recomputeDetected();
    }

    function save(){
      saving = true;
      saveError = "";

      let port = parseInt(formPort);
      if(isNaN(port) || port <= 0 || port > 65535){
        saveError = "Port muss zwischen 1 und 65535 liegen.";
        saving = false;
        return;
      }

      // Sanity-check each profile
      for(let p of formProfiles){
        let pp = parseInt(""+p.port);
        if(isNaN(pp) || pp <= 0 || pp > 65535){
          saveError = "Vendor \""+(p.name||p.id)+"\": Port muss zwischen 1 und 65535 liegen.";
          saving = false;
          return;
        }
      }

      // Multicast ranges — basic CIDR sanity check
      let cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
      for(let [label, val] of [["Audio Low", formRangeAudioLow], ["Audio High", formRangeAudioHigh], ["Video", formRangeVideo]] as [string,string][]){
        if(val && !cidrRe.test(val.trim())){
          saveError = "Multicast Range „"+label+"\" muss CIDR-Notation sein, z.B. 239.120.0.0/16";
          saving = false;
          return;
        }
      }

      let payload = {
        registry: { ip: formIp.trim(), port: port },
        acceptableGmid: formGmid.trim(),
        vendorProfiles: formProfiles,
        multicastRanges: {
          audioLow:  formRangeAudioLow.trim(),
          audioHigh: formRangeAudioHigh.trim(),
          video:     formRangeVideo.trim()
        },
        autoMulticast: { enabled: formAutoMulticastEnabled }
      };

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
        saveError = (e && e.message) ? e.message : "Speichern fehlgeschlagen.";
      });
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
        let arr:Array<{ id:string, label:string, match:string }> = [];
        for(let nodeId in nodes){
          let n = nodes[nodeId];
          if(!n){ continue; }
          let label = n.label || nodeId;
          let description = n.description || "";

          let matchName = "";
          for(let p of formProfiles){
            if(matchProfile(p, label, description)){
              matchName = p.name || p.id;
              break;
            }
          }
          arr.push({ id: nodeId, label, match: matchName });
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
    }
    let leaseRows:LeaseRow[] = [];
    $: {
      let arr:LeaseRow[] = [];
      let raw = leaseSnapshot && leaseSnapshot.leases ? leaseSnapshot.leases : {};
      let needle = (inventoryFilter || "").toLowerCase();
      let catFilter = inventoryCategoryFilter || "";
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
          createdAt: l.createdAt || ""
        });
      }
      arr.sort((a,b) => {
        if(a.category !== b.category) return a.category.localeCompare(b.category);
        // sort by uint32 of primary IP within a category
        return ipCompare(a.primaryIp, b.primaryIp);
      });
      leaseRows = arr;
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
        <span>Registry-Verbindung neu aufbauen: Server-Restart erforderlich, damit die neue IP/Port aktiv wird.</span>
      </div>
    {/if}

    {#if savedFlash}
      <div class="alert alert-success setup-alert">
        <Icon src={CheckCircle} />
        <span>Gespeichert in settings.json.</span>
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
      <p class="setup-section-hint">Adresse der NMOS-Registry, die der Server beim Start kontaktiert.</p>

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
        Erwartete PTP Grand-Master ID. Devices, deren Node-Clock auf diese GMID gelocked sind,
        bekommen in der Details-Seite einen <span class="setup-dot setup-dot-success"></span>
        grünen, alle anderen einen <span class="setup-dot setup-dot-warning"></span> gelben Status-Punkt.
        Leer lassen, um den Vergleich zu deaktivieren.
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
      <h3>Multicast Auto-Allocation</h3>
      <p class="setup-section-hint">
        Wenn aktiviert vergibt der Server pro Sender ein Paar aufeinanderfolgender Multicast-Adressen
        (ungerade für Leg 1, gerade = ungerade + 1 für Leg 2). Die Lease bleibt für immer reserviert –
        auch wenn der Sender offline ist. Erst wenn das Device manuell gelöscht wird, werden die
        Adressen wieder freigegeben.
      </p>

      <div class="setup-form">
        <label class="label cursor-pointer gap-3" style="justify-content:flex-start;">
          <span class="label-text">Enable Auto-Allocation</span>
          <input type="checkbox" class="toggle" bind:checked={formAutoMulticastEnabled} on:change={markDirty} />
        </label>
      </div>

      <div class="setup-form" style="margin-top:14px;">
        <label class="setup-field">
          <span class="setup-label">Audio Low Range (≤2 Channels)</span>
          <div class="setup-range-row">
            <input type="text" class="input input-bordered vendor-mono" placeholder="239.130.0.0/16"
                   bind:value={formRangeAudioLow} on:input={markDirty} />
            <span class="setup-range-stat">{serverState.multicastStats.audioLow.used} / {serverState.multicastStats.audioLow.total} pairs used</span>
          </div>
        </label>
        <label class="setup-field">
          <span class="setup-label">Audio High Range (&gt;2 Channels)</span>
          <div class="setup-range-row">
            <input type="text" class="input input-bordered vendor-mono" placeholder="239.131.0.0/16"
                   bind:value={formRangeAudioHigh} on:input={markDirty} />
            <span class="setup-range-stat">{serverState.multicastStats.audioHigh.used} / {serverState.multicastStats.audioHigh.total} pairs used</span>
          </div>
        </label>
        <label class="setup-field">
          <span class="setup-label">Video Range</span>
          <div class="setup-range-row">
            <input type="text" class="input input-bordered vendor-mono" placeholder="239.120.0.0/16"
                   bind:value={formRangeVideo} on:input={markDirty} />
            <span class="setup-range-stat">{serverState.multicastStats.video.used} / {serverState.multicastStats.video.total} pairs used</span>
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
                <th>Category</th>
                <th>Device</th>
                <th>Sender ID</th>
                <th>Leg 1 (primary)</th>
                <th>Leg 2 (secondary)</th>
                <th>Port</th>
                <th>Allocated</th>
              </tr>
            </thead>
            <tbody>
              {#each leaseRows as r (r.senderId)}
                <tr>
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
                </tr>
              {/each}
              {#if leaseRows.length === 0}
                <tr><td colspan="7" class="vendor-empty">
                  {Object.keys(leaseSnapshot.leases || {}).length === 0
                    ? "Noch keine Leases vergeben."
                    : "Keine Treffer für den aktuellen Filter."}
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
        Wie das „Open device web UI"-Symbol auf der Details-Seite gebaut wird, hängt vom Hersteller ab.
        Profile werden in Reihenfolge geprüft, das <strong>erste</strong> passende gewinnt.
        Ein Profil matcht, wenn einer der Label-Einträge als Substring im Node-Label oder
        in der Description vorkommt. Mehrere Labels durch <code>,</code> trennen.
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
                  <select class="select select-bordered select-sm" bind:value={p.protocol} on:change={markDirty}>
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
              <tr><td colspan="6" class="vendor-empty">Keine Vendor-Profile definiert.</td></tr>
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
            <tr><th>Label</th><th>Matches profile</th></tr>
          </thead>
          <tbody>
            {#each detectedDevices as d (d.id)}
              <tr>
                <td>{d.label}</td>
                <td>{d.match || "—"}</td>
              </tr>
            {/each}
            {#if detectedDevices.length === 0}
              <tr><td colspan="2" class="vendor-empty">Keine Nodes von NMOS-Registry empfangen.</td></tr>
            {/if}
          </tbody>
        </table>
      </details>
    </section>


    <div class="setup-actions">
      <button class="btn" on:click={resetForm} disabled={!dirty}>Reset</button>
      <button class="btn btn-primary" on:click={save} disabled={!dirty || saving}>
        {#if saving}Saving…{:else}Save{/if}
      </button>
    </div>
  </div>
</div>


