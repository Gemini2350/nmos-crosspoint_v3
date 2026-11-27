<script lang="ts">
  // A sender of the Crosspoint matrix, on click: BCP-008 status (first, when
  // the sender has a monitor), its stream (activation, multicast and port per
  // leg), its SDP file and -- when the sender is an output of an IS-08 Channel
  // Map -- which input channels feed its channels, switchable.
  //
  // Everything shown comes from the crosspoint state (the backend computes
  // it); the dialog follows that state while it is open, so a change made
  // here, or anywhere else, shows up without reopening.
  import ServerConnector from "./ServerConnector/ServerConnectorService";
  import OverlayMenuService from "./OverlayMenu/OverlayMenuService";
  import Bcp008Panel from "./Bcp008Panel.svelte";
  import { monitorStateName, monitorClassVal } from "./bcp008";
  import { copyText, downloadText, fileSafe } from "./clipboard";
  import { cmColor } from "./channelMap";

  export let state:any = null;          // the "crosspoint" sync object
  export let bcp008On:boolean = true;

  let dialog:HTMLDialogElement;
  let isOpen = false;
  let flowId = "";
  let tab = "";
  let flow:any = null;
  let dev:any = null;

  function findSender(st:any, id:string){
    for(const d of (st?.devices || [])){
      for(const t of Object.keys(d?.senders || {})){
        for(const f of (d.senders[t] || [])){
          if(f && f.id === id) return { dev: d, flow: f };
        }
      }
    }
    return null;
  }
  // Follows the state; a sender that vanished keeps its last picture.
  $: hit = (isOpen && flowId) ? findSender(state, flowId) : null;
  $: if(hit){ flow = hit.flow; dev = hit.dev; }

  $: nmosId = (flow && typeof flow.id === "string" && flow.id.startsWith("nmos_")) ? flow.id.substring(5) : "";
  $: family = flow?.capabilities?.transport || "";
  $: hasBcp = bcp008On && !!flow?.monitor;
  $: hasSdp = !!flow && (family === "rtp" || family === "");
  $: cm = dev?.channelMap || null;
  $: cmOut = (cm && nmosId) ? ((cm.outputs || []).find((o:any) => (o.senderIds || []).includes(nmosId)) || null) : null;
  $: tabs = [hasBcp ? "BCP-008" : "", "Stream", hasSdp ? "SDP" : "", cmOut ? "IS-08" : ""].filter((t) => !!t);
  $: if(isOpen && tabs.length > 0 && !tabs.includes(tab)){ tab = tabs[0]; }
  $: formatRow = (flow?.card?.rows || []).find((r:any) => r.k === "Format");
  $: subLine = [dev?.displayLabel || dev?.alias || dev?.name || "", formatRow ? formatRow.v : (flow?.format || "")].filter((x) => !!x).join(" · ");

  /** Open on a sender: BCP-008 first when the sender has a monitor. */
  export function open(f:any){
    flowId = f.id;
    flow = f;
    const h = findSender(state, f.id);
    dev = h ? h.dev : null;
    tab = (bcp008On && f.monitor) ? "BCP-008" : "Stream";
    legsKey = ""; legsTouched = false; streamError = "";
    sdpText = ""; sdpFor = ""; sdpCopied = false;
    counters = null; countersKey = "";
    cmKey = ""; cmTouched = false; cmError = ""; cmBusy = false;
    isOpen = true;
    dialog.showModal();
  }
  function onClose(){ isOpen = false; flowId = ""; }

  // ----- Header: activation -----
  // The switch does not flip on its own: it shows what the state says, and
  // the state follows once the device has answered.
  function toggleActive(){
    if(!flow) return;
    ServerConnector.post(flow.active ? "disableFlow" : "enableFlow", { id: flow.id }).catch(()=>{});
  }

  // ----- BCP-008 -----
  let counters:any[] | null = null;
  let countersKey = "";
  function fetchCounters(){
    counters = null;
    ServerConnector.post("bcp008Counters", { id: flowId }).then((r:any)=>{
      counters = (r && r.data && Array.isArray(r.data.groups)) ? r.data.groups : [];
    }).catch(()=>{ counters = []; });
  }
  // Read on opening the tab and again when the state moves: a transition
  // usually means the packet counters moved as well. No polling.
  $: if(isOpen && tab === "BCP-008" && flow?.monitor){
    const k = flowId + "|" + flow.monitor.status + "|" + flow.monitor.counter;
    if(k !== countersKey){ countersKey = k; fetchCounters(); }
  }
  function resetCounters(){
    ServerConnector.post("bcp008Reset", { id: flowId }).then(()=>{ countersKey = ""; }).catch((e:any)=>{
      ServerConnector.addFeedback({ message: "Counter reset failed: " + (e?.message || e), level: "error" });
    });
  }

  // ----- Stream: multicast and port per leg -----
  let ips:string[] = [];
  let ports:string[] = [];
  let orig:Array<{ip:string, port:string}> = [];
  let legsKey = "";
  let legsTouched = false;
  let streamError = "";
  $: legs = (flow?.legs || []) as any[];
  $: editable = !!flow && !flow.isVirtual && family === "rtp" && legs.length > 0;
  function syncLegs(list:any[]){
    const k = JSON.stringify(list.map((l) => [l.index, l.dstIp, l.dstPort]));
    if(k === legsKey) return;
    legsKey = k;
    if(legsTouched) return;
    ips = []; ports = []; orig = [];
    for(const l of list){
      const ip = l.dstIp || "";
      const port = (l.dstPort === undefined || l.dstPort === null) ? "" : ("" + l.dstPort);
      ips[l.index] = ip; ports[l.index] = port; orig[l.index] = { ip, port };
    }
  }
  $: syncLegs(legs);
  $: legsChanged = legs.some((l) => (ips[l.index] || "").trim() !== (orig[l.index]?.ip || "") || ("" + (ports[l.index] ?? "")).trim() !== (orig[l.index]?.port || ""));
  function conflict(index:number, ip:string){
    if(!ip || !ip.trim()) return "";
    const owners:any[] = state?.activeLegIps?.[index]?.[ip.trim()] || [];
    const other = owners.find((o) => o.id !== flowId);
    return other ? other.label : "";
  }
  function resetLegs(){ legsTouched = false; legsKey = ""; streamError = ""; syncLegs(legs); }
  // Untouched legs stay out of the payload: sending their address back would
  // turn a pool-allocated leg into a manual override. All changed legs go
  // in ONE request, so the device gets one PATCH and one activation.
  function applyLegs(){
    const out:any[] = [];
    for(const l of legs){
      const i = l.index;
      const ip = (ips[i] || "").trim();
      const portStr = ("" + (ports[i] ?? "")).trim();
      const o = orig[i] || { ip: "", port: "" };
      if(ip === o.ip && portStr === o.port) continue;
      const leg:any = { index: i, multicast: ip };
      if(portStr !== ""){
        const p = parseInt(portStr);
        if(isNaN(p) || p <= 0 || p > 65535){ streamError = "Leg " + (i + 1) + ": invalid port (1–65535)."; return; }
        leg.port = p;
      }
      out.push(leg);
    }
    streamError = "";
    if(out.length === 0) return;
    ServerConnector.post("setMulticast", { id: flowId, data: { legs: out } }).catch((e:any)=>{
      streamError = e?.message || "The change was not accepted.";
    });
    // Back to what the sender reports: its new /active arrives through the
    // state, and a refusal leaves the old address standing (as on Details).
    legsTouched = false; legsKey = ""; syncLegs(legs);
  }
  function legKey(e:KeyboardEvent){
    if(e.key === "Enter") applyLegs();
  }
  // The card's other facts (receivers, warnings, endpoints) under the legs;
  // the format sits in the header, editable addresses in the inputs.
  $: infoRows = (flow?.card?.rows || []).filter((r:any) => r.k !== "Format" &&
      !(editable && (r.k === "Multicast" || r.k === "Unicast" || /^Leg \d+$/.test(r.k))));

  // ----- SDP -----
  const SDP_UNAVAILABLE = "No SDP file available for this sender.\n\nPossible reasons:\n - sender is inactive\n - manifest could not be loaded from the device\n - sender is not NMOS-based";
  let sdpText = "";
  let sdpFor = "";
  let sdpCopied = false;
  let sdpCopiedTimer:any = null;
  $: if(isOpen && tab === "SDP" && sdpFor !== flowId){ loadSdp(); }
  function loadSdp(){
    sdpFor = flowId;
    if(flow?.sdp){ sdpText = flow.sdp; return; }
    sdpText = "Loading SDP…";
    ServerConnector.post("getSenderSdp", { id: nmosId }).then((r:any)=>{
      sdpText = (r && r.data && typeof r.data.sdp === "string" && r.data.sdp) ? r.data.sdp : SDP_UNAVAILABLE;
    }).catch(()=>{ sdpText = SDP_UNAVAILABLE; });
  }
  async function copySdp(){
    if(await copyText(sdpText)){
      sdpCopied = true;
      if(sdpCopiedTimer) clearTimeout(sdpCopiedTimer);
      sdpCopiedTimer = setTimeout(()=>{ sdpCopied = false; }, 1500);
      return;
    }
    ServerConnector.addFeedback({ level: "warning", message: "The browser did not allow copying here. Select the SDP and press Ctrl+C (Cmd+C on a Mac), or use Download." });
  }
  function saveSdp(){
    try{ downloadText(fileSafe(flow?.alias || flow?.name || "sender") + ".sdp", sdpText, "application/sdp"); }
    catch(e:any){ ServerConnector.addFeedback({ level: "error", message: "Could not save the SDP: " + (e?.message || e) }); }
  }

  // ----- IS-08: the channels of this sender's output -----
  type Want = { input:string|null, channel:number|null };
  let wanted:Want[] = [];
  let cmKey = "";
  let cmTouched = false;
  let cmError = "";
  let cmBusy = false;
  $: activeMap = (cmOut?.channels || []).map((c:any) => ({ input: c.input, channel: c.inputChannel })) as Want[];
  function syncWanted(list:Want[]){
    const k = JSON.stringify(list);
    if(k === cmKey) return;
    cmKey = k;
    if(!cmTouched) wanted = list.map((w) => ({ ...w }));
  }
  $: syncWanted(activeMap);
  // The colour follows the input's place among ALL inputs of the device, as
  // on the Details page; an input without channels has no column.
  $: inputs = ((cm?.inputs || []) as any[]).map((inp, k) => ({ ...inp, k })).filter((inp) => (inp.channels || []).length > 0);
  $: staged = wanted.filter((w, i) => activeMap[i] && (w.input !== activeMap[i].input || w.channel !== activeMap[i].channel)).length;
  function routable(out:any, inputId:string){ return !out?.routable || out.routable.includes(inputId); }
  function cellClass(out:any, w:Want[], a:Want[], row:number, inputId:string, ch:number){
    if(!routable(out, inputId)) return "sd-cell sd-cell-no";
    const isW = w[row]?.input === inputId && w[row]?.channel === ch;
    const isA = a[row]?.input === inputId && a[row]?.channel === ch;
    if(isW && isA) return "sd-cell sd-cell-on";
    if(isW) return "sd-cell sd-cell-new";
    if(isA) return "sd-cell sd-cell-old";
    return "sd-cell";
  }
  function pick(row:number, inputId:string, ch:number){
    if(!routable(cmOut, inputId) || cmBusy) return;
    const w = wanted[row];
    wanted[row] = (w && w.input === inputId && w.channel === ch) ? { input: null, channel: null } : { input: inputId, channel: ch };
    wanted = wanted;
    cmTouched = true;
    cmError = "";
  }
  function fromInput(e:Event){
    const sel = e.currentTarget as HTMLSelectElement;
    const inp = inputs.find((i) => i.id === sel.value);
    sel.value = "";
    if(!inp) return;
    wanted = wanted.map((w, i) => i < inp.channels.length ? { input: inp.id, channel: i + 1 } : w);
    cmTouched = true; cmError = "";
  }
  function muteAll(){ wanted = wanted.map(() => ({ input: null, channel: null })); cmTouched = true; cmError = ""; }
  function resetMap(){ cmTouched = false; cmKey = ""; cmError = ""; syncWanted(activeMap); }
  function rereadMap(){
    if(!dev) return;
    ServerConnector.post("channelMapRead", { id: dev.id }).catch((e:any)=>{ cmError = e?.message || "Re-read failed."; });
  }
  function takeMap(){
    if(!dev || !cmOut || staged === 0) return;
    cmBusy = true; cmError = "";
    ServerConnector.post("channelMapTake", { id: dev.id, output: cmOut.id, channels: wanted }).then(()=>{
      // The device's own map comes back through the state (read again
      // after the activation) and replaces what was staged.
      cmTouched = false; cmKey = "";
    }).catch((e:any)=>{
      cmError = e?.message || "The device did not take the Channel Map.";
    }).finally(()=>{ cmBusy = false; });
  }
  // "1 L", "2 R"; a label that only repeats the number ("Ch 1") is left
  // out, a long one lives in the tooltip.
  function rowLabel(i:number){
    const l = (cmOut?.channels?.[i]?.label || "").trim();
    const plain = new RegExp("^(ch(annel)?\\s*)?0*" + (i + 1) + "$", "i").test(l);
    return l && !plain && l.length <= 6 ? (i + 1) + " " + l : "" + (i + 1);
  }
</script>

<dialog bind:this={dialog} class="modal" on:close={onClose}>
  <div class="modal-box sd-box">
    <form method="dialog">
      <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
    </form>
    {#if flow}
      <div class="sd-head">
        <h3>{flow.alias || flow.name}</h3>
        {#if hasBcp}<span class={"cp-monitor-state " + monitorClassVal(flow.monitor.status)}>{monitorStateName(flow.monitor.status)}</span>{/if}
        {#if !flow.available}<span class="cp-monitor-state">Unavailable</span>{/if}
        <label class="sd-active" use:OverlayMenuService.tooltip data-tooltip={flow.active ? "Active – switch off to deactivate (master_enable)" : "Inactive – switch on to activate (master_enable)"}>
          Active <input type="checkbox" class="toggle toggle-sm" checked={!!flow.active} disabled={!flow.available} on:click|preventDefault={toggleActive} />
        </label>
      </div>
      {#if subLine}<div class="sd-sub">{subLine}</div>{/if}

      <div class="sd-tabs" role="tablist">
        {#each tabs as t}
          <button role="tab" aria-selected={tab === t} class:on={tab === t} on:click={()=>{ tab = t; if(t === "SDP"){ sdpFor = ""; } }}>{t}{#if t === "BCP-008" && hasBcp && flow.monitor.status >= 2}<i class={"cp-monitor-dot " + monitorClassVal(flow.monitor.status)}></i>{/if}{#if t === "IS-08" && staged > 0}<i class="sd-tab-staged"></i>{/if}</button>
        {/each}
      </div>

      {#if tab === "BCP-008" && hasBcp}
        <Bcp008Panel monitor={flow.monitor} {counters} />
        <div class="sd-actions">
          <button class="btn" on:click={resetCounters}>Reset counters &amp; messages</button>
        </div>

      {:else if tab === "Stream"}
        {#if editable}
          <div class="sd-legs">
            <span class="sd-h">Leg</span><span class="sd-h">Multicast</span><span class="sd-h">Port</span><span class="sd-h">Source</span>
            {#each legs as l}
              {@const other = conflict(l.index, ips[l.index] || "")}
              <span>{l.index + 1}</span>
              <input type="text" class:sd-warn={!!other} bind:value={ips[l.index]} on:input={()=>{ legsTouched = true; }} on:keydown={legKey} placeholder="239.x.x.x" spellcheck="false" />
              <input type="text" inputmode="numeric" bind:value={ports[l.index]} on:input={()=>{ legsTouched = true; }} on:keydown={legKey} placeholder="5004" />
              <span class="sd-src">{l.srcIp || "—"}</span>
              {#if other}<span></span><span class="sd-conflict" style="grid-column: span 3">Already used on leg {l.index + 1} by {other}</span>{/if}
            {/each}
          </div>
          <div class="sd-note">
            {legs.length > 1 ? "All legs go to the device in one IS-05 PATCH." : "Sent to the device as one IS-05 PATCH."}
            {#if state?.multicastDhcp} Empty = the address reserved for this sender in the multicast pool.{/if}
          </div>
          {#if streamError}<div class="sd-error">{streamError}</div>{/if}
        {:else if flow.isVirtual}
          <div class="sd-note">Virtual sender: its multicast comes from the SDP pasted on the Setup page. Edit it there.</div>
        {/if}
        {#if infoRows.length > 0}
          <div class="sd-info">
            {#each infoRows as r}<span class="sd-h">{r.k}</span><span class={"sd-v" + (r.tone ? " sd-v-" + r.tone : "")}>{r.v}</span>{/each}
          </div>
        {/if}
        {#if editable}
          <div class="sd-actions">
            <button class="btn" on:click={resetLegs} disabled={!legsChanged}>Reset</button>
            <button class="btn btn-primary" on:click={applyLegs} disabled={!legsChanged}>Apply</button>
          </div>
        {/if}

      {:else if tab === "SDP"}
        <pre class="sd-pre">{sdpText}</pre>
        <div class="sd-actions">
          <button class="btn" class:sd-copied={sdpCopied} on:click={copySdp}>{sdpCopied ? "Copied!" : "Copy"}</button>
          <button class="btn" on:click={saveSdp}>Download</button>
        </div>

      {:else if tab === "IS-08" && cmOut}
        {#if cm.error}<div class="sd-error">Last read failed: {cm.error}</div>{/if}
        <div class="sd-cm-scroll">
          <div class="sd-cm" style={"grid-template-columns: auto " + inputs.map((inp) => "repeat(" + inp.channels.length + ", 22px)").join(" 8px ")}>
            <span></span>
            {#each inputs as inp, k}
              {#if k > 0}<span></span>{/if}
              <span class="sd-cm-in" style={"grid-column: span " + inp.channels.length + "; --c:" + cmColor(inp.k)}
                    use:OverlayMenuService.tooltip data-tooltip={(inp.deviceName ? "On the device: " + inp.deviceName + "\n" : "") + inp.channels.length + " ch" + (inp.blockSize > 1 ? ", routes in blocks of " + inp.blockSize : "") + (inp.reordering ? "" : ", keeps channel order") + (routable(cmOut, inp.id) ? "" : "\nNot routable to this sender")}>{inp.name}</span>
            {/each}
            <span></span>
            {#each inputs as inp, k}
              {#if k > 0}<span></span>{/if}
              {#each inp.channels as label, c}
                <span class="sd-cm-num" use:OverlayMenuService.tooltip data-tooltip={label || ""}>{c + 1}</span>
              {/each}
            {/each}
            {#each cmOut.channels as och, row}
              <span class="sd-cm-row" use:OverlayMenuService.tooltip data-tooltip={och.label || ""}>{rowLabel(row)}</span>
              {#each inputs as inp, k}
                {#if k > 0}<span></span>{/if}
                {#each inp.channels as label, c}
                  <button class={cellClass(cmOut, wanted, activeMap, row, inp.id, c + 1)} style={"--c:" + cmColor(inp.k)}
                          disabled={!routable(cmOut, inp.id)} aria-label={"Channel " + (row + 1) + " from " + inp.name + " " + (c + 1)}
                          on:click={()=>pick(row, inp.id, c + 1)}></button>
                {/each}
              {/each}
            {/each}
          </div>
        </div>
        <div class="sd-cm-foot">
          {#if staged > 0}<span class="sd-cm-staged">{staged} {staged === 1 ? "change" : "changes"} staged</span>{:else}<span class="sd-cm-staged sd-cm-none">No changes</span>{/if}
          <button class="btn btn-sm" on:click={rereadMap} use:OverlayMenuService.tooltip data-tooltip="Read the device's Channel Map again (IS-08 sends no notifications)">Re-read</button>
          <select class="sd-cm-select" on:change={fromInput} aria-label="Route 1:1 from an input">
            <option value="">1:1 from…</option>
            {#each inputs as inp}{#if routable(cmOut, inp.id)}<option value={inp.id}>{inp.name}</option>{/if}{/each}
          </select>
          <button class="btn btn-sm" on:click={muteAll} disabled={!cmOut.mayMute}
                  use:OverlayMenuService.tooltip data-tooltip={cmOut.mayMute ? "Unroute every channel (silence)" : "The device does not allow silent channels on this output"}>Mute all</button>
          <button class="btn btn-sm" on:click={resetMap} disabled={staged === 0}>Reset</button>
          <button class="btn btn-sm sd-take" on:click={takeMap} disabled={staged === 0 || cmBusy}>{cmBusy ? "Taking…" : "Take"}</button>
        </div>
        {#if cmError}<div class="sd-error">{cmError}</div>{/if}
        <div class="sd-note">One crosspoint per channel; click it again to unroute. Hatched: the device does not route that input to this sender. Take writes all staged changes in one IS-08 activation.</div>
      {/if}
    {/if}
  </div>
</dialog>
