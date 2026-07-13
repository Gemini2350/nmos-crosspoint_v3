<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService"
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";

    import { Icon, MagnifyingGlass, RectangleGroup, Pencil, ChevronRight,
       VideoCamera, Microphone, DocumentText,
       CodeBracketSquare, ArrowTopRightOnSquare,
       Clock, ChevronDoubleDown, ChevronDoubleUp
     } from "svelte-hero-icons";

    import ScrollArea from "../lib/ScrollArea.svelte";
    import { getSearchTokens, tokenSearch } from "../lib/functions";
    import OverlayMenuService from "../lib/OverlayMenu/OverlayMenuService";
    import AudioMonitorPlayer from "../lib/AudioMonitor/AudioMonitorPlayer.svelte";


    // Same icon set as Crosspoint sender side
    function getFlowTypeIcon(type:string){
      switch(type){
        case "video":
          return VideoCamera;
        case "audio":
        case "audiochannel":
          return Microphone;
        case "data":
        case "mqtt":
        case "websocket":
          return CodeBracketSquare;
        default:
          return CodeBracketSquare;
      }
    }


    // ----- Filter state (persisted to localStorage) -----
    let filter:any = {
      version:"21005",
      expanded: { devices:[] },
      // Per-device collapse state for sub-sections. Default is "expanded";
      // a device id in these lists means the section is COLLAPSED.
      collapsedSenders: [],
      collapsedReceivers: [],
      // Node groups folded down to their single header line (keyed by
      // nodeId). Guarded after the localStorage load because older saved
      // filters of the same version don't have the field yet.
      collapsedNodes: [],
      search:"",
      searchFormat:"",
      searchIp:""
    };

    // ----- Source data -----
    // The crosspoint sync carries everything we need — devices, senders,
    // receivers, plus the server-side enrichment (legs, codecs, node label,
    // gmid, device URL, connected-sender label). Raw SDPs are fetched on
    // demand via the getSenderSdp route — the multi-MB nmos sync object is
    // no longer subscribed here.
    let sourceState:any = { devices: [] };

    let sync:Subject<any>;
    let syncSetup:Subject<any>;


    // ----- Build & render flat device list -----
    interface SenderRow {
      id:string;
      nmosId:string;
      type:string;
      name:string;
      alias:string;
      active:boolean;
      available:boolean;
      manifestOk:boolean;
      format:string;
      codec:string;
      bitrate:any;
      legs: Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string, dup?:boolean, dupText?:string }>;
      // Raw SDP carried directly on the flow for virtual senders (no NMOS
      // manifest fetch available). Empty string for normal NMOS senders.
      sdp:string;
      // True when this sender lives on our own virtual NMOS device. The
      // multicast / port edit pencil is suppressed because PATCH /staged
      // returns 405 for virtual senders (their address comes from the
      // pasted SDP, not from IS-05).
      isVirtual:boolean;
    }
    interface ReceiverRow {
      id:string;
      nmosId:string;
      type:string;
      name:string;
      alias:string;
      active:boolean;
      available:boolean;
      codec:string;
      // Info copied from the currently connected sender (if any)
      connectedSenderId:string;
      connectedSenderLabel:string;
      format:string;
      bitrate:any;
      legs: Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string, dup?:boolean, dupText?:string }>;
    }
    interface DeviceRow {
      id:string;
      // Display label, format: "Node - Device"
      label:string;
      // Device-only label (no node prefix) — used inside a node group where
      // the node name already sits in the group header. Backend-computed.
      shortLabel:string;
      // NMOS Node backing this device (backend-resolved, offline-cached).
      nodeId:string;
      nodeLabel:string;
      // Raw registry node label + operator node alias (for the rename modal).
      nodeLabelRaw:string;
      nodeAlias:string;
      // Tooltip with original NMOS labels
      tooltip:string;
      // The crosspoint device's alias (used for the change-alias modal)
      alias:string;
      name:string;
      available:boolean;
      // PTP Grand-Master ID the node clock is locked to (or "" if none / not PTP).
      gmid:string;
      // Whether that clock currently reports "locked:true"
      gmidLocked:boolean;
      // Link to the device's web UI (derived from the NMOS Node's href). "" if unknown.
      deviceUrl:string;
      // True for our own virtual NMOS device (settings.virtualNode.deviceId).
      // Used by the template to skip controls that don't make sense here
      // (Forget would just trigger an immediate re-register; multicast
      // editing is rejected with 405).
      isVirtual:boolean;
      senders:SenderRow[];
      receivers:ReceiverRow[];
    }

    let deviceList:DeviceRow[] = [];
    // Devices sharing an NMOS node are rendered under one node header —
    // but only when the node actually has MORE than one device; a
    // single-device node renders as a plain card exactly as before.
    interface NodeGroup {
      key:string;          // nodeId (or dev.id for standalone devices)
      label:string;        // node label shown in the group header
      grouped:boolean;     // true = render header + nested cards
      tx:number;           // aggregate sender count (header badge)
      rx:number;           // aggregate receiver count
      devices:DeviceRow[];
    }
    let nodeGroups:NodeGroup[] = [];
    // Duplicate-multicast detection lives in the backend now: the server
    // marks conflicting legs (leg.dup + leg.dupText with the other owners)
    // and publishes crosspointState.activeLegIps for the live-edit check.
    // (Per-page counter removed — moved to the global widget at the top of
    // the right-hand nav so the Dev/TX/RX numbers are visible everywhere.)

    // Acceptable PTP GMID — comes from the Setup page via the `setupConfig` sync.
    // Used to colour the device status dot green (match) vs. yellow (mismatch).
    let acceptableGmid:string = "";

    // Normalise GMIDs so different separator / case styles compare cleanly.
    function normaliseGmid(v:string){
      if(!v){return "";}
      return v.toUpperCase().replace(/[^0-9A-F]/g,"");
    }

    function deviceDotClass(dev:DeviceRow){
      if(!dev.available){ return "error"; }
      let want = normaliseGmid(acceptableGmid);
      // If no acceptable GMID is configured, stay on the previous behaviour (green).
      if(!want){ return "success"; }
      let have = normaliseGmid(dev.gmid);
      if(have && have === want && dev.gmidLocked){
        return "success";
      }
      // PTP not locked or wrong GM → yellow / warning
      return "warning";
    }


    function renderBitrate(bitrate:any){
      // bitrate may be number (legacy) or { v:number, hint:string }
      let v:number = 0;
      let hint:string = "ok";
      if(typeof bitrate === "number"){
        v = bitrate;
      }else if(bitrate && typeof bitrate === "object"){
        v = Number(bitrate.v) || 0;
        hint = bitrate.hint || "ok";
      }
      // One decimal place
      v = Math.round(v*10)/10;
      if(hint === "unknown" || v <= 0){
        return "—";
      }
      if(v < 1){
        return "< 1 Mbit/s";
      }
      // toFixed(1) so 1000 prints as "1000.0" — keeps the column visually consistent.
      // No "ca." / "max " prefix anymore — the hint is available via tooltip if needed.
      return v.toFixed(1) + " Mbit/s";
    }

    function rebuild(){
      let newList:DeviceRow[] = [];

      let cpDevices:any[] = (sourceState && Array.isArray(sourceState.devices)) ? sourceState.devices : [];

      let searchTokens = filter.search ? getSearchTokens(filter.search) : [];
      let formatTokens = filter.searchFormat ? getSearchTokens(filter.searchFormat) : [];
      let ipTokens = filter.searchIp ? getSearchTokens(filter.searchIp) : [];

      cpDevices.forEach((dev:any)=>{
        let flowTypeList = ["video","audio","data","audiochannel","mqtt","websocket","unknown"];
        let allSenders:any[] = [];
        flowTypeList.forEach((t)=>{
          if(dev.senders && Array.isArray(dev.senders[t])){
            allSenders = allSenders.concat(dev.senders[t]);
          }
        });
        let allReceivers:any[] = [];
        flowTypeList.forEach((t)=>{
          if(dev.receivers && Array.isArray(dev.receivers[t])){
            allReceivers = allReceivers.concat(dev.receivers[t]);
          }
        });
        if(allSenders.length === 0 && allReceivers.length === 0){
          return;
        }

        // Server-side enrichment (CrosspointAbstraction.enrichCrosspointState)
        // already attaches the final display name + tooltip (displayLabel /
        // displayTooltip), plus nodeLabel / gmid / deviceUrl per device and
        // legs / codec / connectedSenderLabel per flow. No label logic or raw
        // NMOS parsing happens in the UI any more. nodeLabel is still read
        // for the token-search (operators search by node name too).
        let nodeLabel:string = dev.nodeLabel || "";
        let deviceAlias = dev.alias || dev.name || "";
        let combinedLabel = dev.displayLabel || deviceAlias;
        let tooltipStr = dev.displayTooltip || combinedLabel;


        // Build sender rows
        let senderRows:SenderRow[] = [];
        allSenders.forEach((s:any)=>{
          let legs:Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string, dup?:boolean, dupText?:string }> = Array.isArray(s.legs) ? s.legs : [];

          let row:SenderRow = {
            id: s.id,
            nmosId: (typeof s.id === "string" && s.id.startsWith("nmos_")) ? s.id.substring(5) : "",
            type: s.type,
            name: s.name,
            alias: s.alias || s.name,
            active: !!s.active,
            available: !!s.available,
            manifestOk: !!s.manifestOk,
            format: s.format || "",
            codec: s.codec || "",
            bitrate: s.bitrate,
            legs,
            sdp: (typeof s.sdp === "string") ? s.sdp : "",
            isVirtual: !!s.isVirtual
          };

          if(searchTokens.length > 0){
            if(!tokenSearch({alias:row.alias, name:row.name}, searchTokens, ["alias","name"]) &&
               !tokenSearch({alias:deviceAlias, name:dev.name||""}, searchTokens, ["alias","name"]) &&
               !tokenSearch({alias:nodeLabel, name:nodeLabel}, searchTokens, ["alias","name"])){
              return;
            }
          }
          if(formatTokens.length > 0){
            if(!tokenSearch({format:row.format, codec:row.codec}, formatTokens, ["format","codec"])){
              return;
            }
          }
          if(ipTokens.length > 0){
            let ipStr = row.legs.map(l=>l.dstIp+" "+l.srcIp).join(" ");
            if(!tokenSearch(ipStr, ipTokens)){
              return;
            }
          }
          senderRows.push(row);
        });

        senderRows.sort((a,b)=>{
          if(a.type === b.type){
            return (a.alias||"").localeCompare(b.alias||"");
          }
          return (a.type||"").localeCompare(b.type||"");
        });


        // ----- Receivers for this device -----
        let receiverRows:ReceiverRow[] = [];
        allReceivers.forEach((r:any)=>{
          let row:ReceiverRow = {
            id: r.id,
            nmosId: (typeof r.id === "string" && r.id.startsWith("nmos_")) ? r.id.substring(5) : "",
            type: r.type,
            name: r.name,
            alias: r.alias || r.name,
            active: !!r.active,
            available: !!r.available,
            codec: r.codec || "",
            connectedSenderId: r.connectedSenderId || "",
            connectedSenderLabel: r.connectedSenderLabel || "",
            format: r.format || "",
            bitrate: r.bitrate,
            legs: Array.isArray(r.legs) ? r.legs : []
          };

          if(searchTokens.length > 0){
            if(!tokenSearch({alias:row.alias, name:row.name}, searchTokens, ["alias","name"]) &&
               !tokenSearch({alias:deviceAlias, name:dev.name||""}, searchTokens, ["alias","name"]) &&
               !tokenSearch({alias:nodeLabel, name:nodeLabel}, searchTokens, ["alias","name"])){
              return;
            }
          }
          if(formatTokens.length > 0){
            if(!tokenSearch({format:row.format, codec:row.codec}, formatTokens, ["format","codec"])){
              return;
            }
          }
          if(ipTokens.length > 0){
            let ipStr = row.legs.map(l=>l.dstIp+" "+l.srcIp).join(" ");
            if(!tokenSearch(ipStr, ipTokens)){
              return;
            }
          }
          receiverRows.push(row);
        });

        receiverRows.sort((a,b)=>{
          if(a.type === b.type){
            return (a.alias||"").localeCompare(b.alias||"");
          }
          return (a.type||"").localeCompare(b.type||"");
        });

        if(senderRows.length === 0 && receiverRows.length === 0){
          return;
        }

        newList.push({
          id: dev.id,
          label: combinedLabel,
          shortLabel: dev.displayLabelShort || combinedLabel,
          nodeId: dev.nodeId || "",
          nodeLabel: nodeLabel,
          nodeLabelRaw: dev.nodeLabelRaw || nodeLabel,
          nodeAlias: dev.nodeAlias || "",
          tooltip: tooltipStr,
          alias: deviceAlias,
          name: dev.name || "",
          available: !!dev.available,
          gmid: dev.gmid || "",
          gmidLocked: !!dev.gmidLocked,
          deviceUrl: dev.deviceUrl || "",
          isVirtual: !!dev.isVirtual,
          senders: senderRows,
          receivers: receiverRows
        });
      });

      // sort by combined label
      newList.sort((a,b)=>(a.label||"").localeCompare(b.label||""));

      // Group devices by their NMOS node. Groups keep the position of their
      // first device in the sorted list; only nodes with 2+ devices get the
      // header treatment, single-device nodes render as plain cards.
      let groupByKey:{[key:string]:NodeGroup} = {};
      let newGroups:NodeGroup[] = [];
      newList.forEach((row)=>{
        let key = row.nodeId || row.id;
        let grp = groupByKey[key];
        if(!grp){
          grp = { key, label: row.nodeLabel || row.label, grouped:false, tx:0, rx:0, devices: [] };
          groupByKey[key] = grp;
          newGroups.push(grp);
        }
        if(row.nodeLabel){ grp.label = row.nodeLabel; }
        grp.devices.push(row);
        grp.tx += row.senders.length;
        grp.rx += row.receivers.length;
      });
      newGroups.forEach((g)=>{ g.grouped = g.devices.length > 1; });

      // Reassign — this is what makes Svelte re-render
      deviceList = newList;
      nodeGroups = newGroups;
    }


    function saveFilter(){
      try{
        localStorage.setItem("nmos_details_filter", JSON.stringify(filter));
      }catch(e){}
    }

    let filterTimeout:any = null;
    function changeFilter(immediate=false){
      if(immediate){
        if(filterTimeout){clearTimeout(filterTimeout);filterTimeout=null;}
        rebuild();
        saveFilter();
        return;
      }
      if(filterTimeout){clearTimeout(filterTimeout);}
      filterTimeout = setTimeout(()=>{
        rebuild();
        saveFilter();
      },200);
    }


    // ----- Coalesce rapid sync patches into one rebuild per animation frame -----
    // The crosspoint and nmos SyncObjects each push a JSON-patch on every
    // upstream change. When the registry has lots of senders these arrive in
    // bursts (one per IS-04 event). rebuild() does a full O(devices*flows)
    // walk plus DOM regeneration, so running it once per patch is the
    // dominant cost on slow machines. requestAnimationFrame coalesces every
    // patch that lands inside the same frame into a single rebuild() — the
    // user never sees intermediate states anyway. Falls back to setTimeout
    // when rAF isn't available (e.g. SSR-style environments).
    let rebuildScheduled = false;
    function scheduleRebuild(){
      if(rebuildScheduled) return;
      rebuildScheduled = true;
      const run = () => {
        rebuildScheduled = false;
        try{ rebuild(); }catch(e){}
      };
      if(typeof requestAnimationFrame === "function"){
        requestAnimationFrame(run);
      }else{
        setTimeout(run, 16);
      }
    }


    onMount(async () => {
      try{
        let f = localStorage.getItem("nmos_details_filter");
        if(f){
          let tempFilter = JSON.parse(f);
          if(tempFilter.version == filter.version){
            filter = tempFilter;
            // Same-version filters saved before the node-collapse feature
            // lack this field — backfill instead of bumping the version
            // (which would wipe the user's expand state).
            if(!Array.isArray(filter.collapsedNodes)){ filter.collapsedNodes = []; }
          }else{
            saveFilter();
          }
        }
      }catch(e){}

      sync = ServerConnector.sync("crosspoint")
      sync.subscribe((obj:any)=>{
        sourceState = obj;
        scheduleRebuild();
      });
      syncSetup = ServerConnector.sync("setupConfig")
      syncSetup.subscribe((obj:any)=>{
        if(obj && typeof obj.acceptableGmid === "string"){
          acceptableGmid = obj.acceptableGmid;
          // Re-render so device dots reflect the new threshold without
          // waiting for the next crosspoint patch.
          deviceList = deviceList;
          nodeGroups = nodeGroups;
        }
        if(obj && obj.audioMonitor && typeof obj.audioMonitor.enabled === "boolean"){
          audioMonitorEnabled = obj.audioMonitor.enabled;
          // If the feature was just turned off and a player is still
          // open, close it — its WebRTC session is already torn down
          // server-side.
          if(!audioMonitorEnabled){
            monitorActiveId = "";
            monitorActiveSdp = "";
          }
        }
      });
    });

    onDestroy(() => {
      try{sync && sync.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("crosspoint");}catch(e){}
      try{syncSetup && syncSetup.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("setupConfig");}catch(e){}
    });


    // ----- Expand / collapse: use array reassignment so Svelte detects the change -----
    function toggleDevice(id:string){
      let list = filter.expanded.devices || [];
      if(list.includes(id)){
        filter.expanded.devices = list.filter((d:string) => d !== id);
      }else{
        filter.expanded.devices = [...list, id];
      }
      // Reassign filter itself too, to be safe with nested-object reactivity
      filter = filter;
      saveFilter();
    }

    // Expand / collapse every device at once (button next to the filters).
    // "Expand all" also unfolds collapsed node groups; "Collapse all" folds
    // every group down to its header line.
    $: allExpanded = deviceList.length > 0
      && deviceList.every(d => filter.expanded.devices.includes(d.id))
      && (filter.collapsedNodes || []).length === 0;
    function toggleExpandAll(){
      if(allExpanded){
        filter.expanded.devices = [];
        filter.collapsedNodes = nodeGroups.filter(g => g.grouped).map(g => g.key);
      }else{
        filter.expanded.devices = deviceList.map(d => d.id);
        filter.collapsedNodes = [];
      }
      filter = filter;
      saveFilter();
    }

    // Status dot for the node header: red when the whole node is gone,
    // otherwise the PTP-aware state of a representative online device
    // (GMID / lock are node-level properties anyway).
    function nodeGroupDotClass(grp:NodeGroup){
      if(grp.devices.every(d => !d.available)){ return "error"; }
      let rep = grp.devices.find(d => d.available) || grp.devices[0];
      return deviceDotClass(rep);
    }

    // Node-group header click: fold the whole group down to its single
    // header line (device cards hidden entirely) — or bring it back.
    function toggleNodeGroup(grp:NodeGroup){
      let list = filter.collapsedNodes || [];
      if(list.includes(grp.key)){
        filter.collapsedNodes = list.filter((k:string) => k !== grp.key);
      }else{
        filter.collapsedNodes = [...list, grp.key];
      }
      filter = filter;
      saveFilter();
    }

    // Merged media description for the combined column:
    // "24 Bit LPCM · 48kHz·2ch" — codec and format joined, empty parts dropped.
    function mediaText(row:{codec:string, format:string}){
      let parts:string[] = [];
      if(row.codec)  parts.push(row.codec);
      if(row.format) parts.push(row.format);
      return parts.join(" · ");
    }

    // PTP state for the small clock icon in the card header. "ok" = locked
    // (and matching the accepted GMID when one is configured), otherwise warn.
    function ptpOk(dev:DeviceRow){
      if(!dev.gmid || !dev.gmidLocked) return false;
      let want = normaliseGmid(acceptableGmid);
      if(!want) return true;
      return normaliseGmid(dev.gmid) === want;
    }


    // ----- Toggle sender activation (same as Crosspoint page) -----
    function toggleSenderActive(flow:SenderRow){
      // Same endpoint logic as crosspoint.svelte: enable when currently inactive, disable when active.
      let endpoint = flow.active ? "disableFlow" : "enableFlow";
      ServerConnector.post(endpoint, { id: flow.id }).catch(()=>{});
    }

    // ----- Toggle receiver activation -----
    // For receivers we only toggle master_enable. If the receiver still has a
    // sender_id staged from a previous connection, re-enabling will resume
    // reception. Disabling stops the stream but keeps the subscription.
    function toggleReceiverActive(recv:ReceiverRow){
      let endpoint = recv.active ? "disableReceiver" : "enableReceiver";
      ServerConnector.post(endpoint, { id: recv.id }).catch(()=>{});
    }


    // ----- Edit dst-IP / dst-Port (send to sender) -----
    // Edit is explicit: user clicks the pencil for a specific leg, the row
    // morphs into IP / Port inputs, then Save or Cancel.
    let editingLeg:string = "";            // key: "<flowId>:<legIndex>"  ("" = none)
    let legEditIp:string = "";
    let legEditPort:string = "";
    let legEditError:string = "";

    function legKey(flowId:string, legIndex:number){
      return flowId + ":" + legIndex;
    }
    function startLegEdit(flowId:string, legIndex:number, leg:any){
      editingLeg = legKey(flowId, legIndex);
      legEditIp = leg.dstIp || "";
      legEditPort = (leg.dstPort === undefined || leg.dstPort === null) ? "" : (""+leg.dstPort);
      legEditError = "";
      // Focus the IP input shortly after render
      setTimeout(()=>{
        try{
          let el = document.querySelector(".det-leg-input-ip-"+editingLeg.replace(/[:]/g,"_")) as HTMLInputElement;
          if(el){ el.focus(); el.select(); }
        }catch(e){}
      }, 30);
    }
    function cancelLegEdit(){
      editingLeg = "";
      legEditIp = "";
      legEditPort = "";
      legEditError = "";
    }
    function commitLegEdit(flowId:string, legIndex:number){
      // Validate port
      let p:number|null = null;
      if(legEditPort !== ""){
        let parsed = parseInt(legEditPort);
        if(isNaN(parsed) || parsed <= 0 || parsed > 65535){
          legEditError = "Invalid Port (1-65535)";
          return;
        }
        p = parsed;
      }
      // Always include the multicast field so the server can distinguish
      // "user cleared the IP, please reset to the reserved lease address"
      // (multicast === "") from "user only changed the port" (multicast field
      // missing — not used here, kept for future protocol compatibility).
      let payload:any = {
        index: legIndex,
        multicast: legEditIp.trim()
      };
      if(p !== null){ payload.port = p; }
      ServerConnector.post("setMulticast", {
        id: flowId,
        data: { legs:[ payload ] }
      }).catch(()=>{});
      cancelLegEdit();
    }
    function legEditKey(e:KeyboardEvent, flowId:string, legIndex:number){
      if(e.keyCode === 13){ commitLegEdit(flowId, legIndex); }
      if(e.keyCode === 27){ cancelLegEdit(); }
    }

    /**
     * Live check while the user is editing a leg's destination IP. Returns
     * the conflicting active sender (any device, same leg index) or null.
     * The currently edited sender itself is excluded.
     *
     * Looks the typed address up in crosspointState.activeLegIps — the same
     * server-built map behind the DUP badges, covering ALL active senders
     * (before the page's search filters), so a conflict is caught even when
     * the other sender is currently filtered out of view.
     */
    function findActiveLegConflict(currentFlowId:string, legIndex:number, ip:string){
      if(!ip || !ip.trim()){ return null; }
      let owners:Array<{id:string,label:string}> = sourceState?.activeLegIps?.[legIndex]?.[ip.trim()] || [];
      let other = owners.find(o => o.id !== currentFlowId);
      if(other){ return { alias: other.label }; }
      return null;
    }


    // ----- Forget device (only for offline devices) -----
    let forgetModal:any;
    let forgetDevice:DeviceRow | null = null;
    function openForgetDialog(dev:DeviceRow){
      forgetDevice = dev;
      if(forgetModal){ forgetModal.showModal(); }
    }
    function confirmForget(){
      if(!forgetDevice){ return; }
      let devId = forgetDevice.id;
      ServerConnector.post("crosspoint", { action:"delete", devId: devId, flowId:"" })
        .catch(()=>{});
      forgetDevice = null;
      if(forgetModal){ forgetModal.close(); }
    }
    function cancelForget(){
      forgetDevice = null;
      if(forgetModal){ forgetModal.close(); }
    }

    // ----- Forget individual sender / receiver (only for unavailable flows) -----
    // Per user request the confirmation dialog is skipped — the Forget button
    // only ever appears for offline flows anyway (the rendered button is
    // gated behind `!flow.available` / `!recv.available`), so an extra click
    // to confirm "yes, remove this thing that's not there anymore" was
    // pure friction. The server still releases the multicast lease for
    // sender deletes (see crosspointAbstraction.crosspointApi).
    // `kind` is kept in the signature for log/future use even though we no
    // longer pop a kind-specific modal.
    function openForgetFlowDialog(devId:string, _kind:"sender"|"receiver", row:SenderRow | ReceiverRow){
      if(!devId || !row || !row.id){ return; }
      ServerConnector.post("crosspoint", { action:"delete", devId: devId, flowId: row.id })
        .catch(()=>{});
    }


    // ----- Alias / Setup modals -----
    let labelModal:any;
    let labelModalInput:any;
    let labelModalId:string = "";
    let labelModalName:string = "";
    let labelModalAlias:string = "";
    let labelModalValue:string = "";
    function openLabelEditor(id:string, name:string, alias:string){
      labelModalId = id;
      labelModalName = name;
      labelModalAlias = alias;
      labelModalValue = alias;
      labelModal.showModal();
      labelModalInput.focus();
      setTimeout(()=>{labelModalInput.select();});
    }
    function changeLabelSend(){
      ServerConnector.post("changealias",{id:labelModalId, alias:labelModalValue});
      labelModal.close();
    }

    // ----- SDP viewer modal -----
    let sdpModal:any;
    let sdpModalTitle:string = "";
    let sdpModalContent:string = "";

    // ----- Audio Monitor -----
    // Single-active widget: clicking 🎧 on a different sender swaps the
    // player. Click again on the same sender closes it. Only one stream
    // playing at a time, simpler UX (and bandwidth). `audioMonitorEnabled`
    // mirrors settings.audioMonitor.enabled — when false the button is
    // hidden everywhere and active widgets get auto-closed.
    let audioMonitorEnabled:boolean = false;
    let monitorActiveId:string = "";
    let monitorActiveSdp:string = "";
    // SDP on demand: virtual senders carry it on the flow, real senders are
    // fetched from the server's manifest cache via getSenderSdp (the raw
    // SDPs are deliberately NOT part of any sync object any more).
    async function resolveSdpForFlow(flow:SenderRow):Promise<string> {
      if(flow.sdp) return flow.sdp;
      if(!flow.nmosId) return "";
      try{
        const r:any = await ServerConnector.post("getSenderSdp", { id: flow.nmosId });
        return (r && r.data && typeof r.data.sdp === "string") ? r.data.sdp : "";
      }catch(e){ return ""; }
    }
    async function toggleMonitor(flow:SenderRow){
      if(monitorActiveId === flow.id){
        monitorActiveId = "";
        monitorActiveSdp = "";
        return;
      }
      const sdp = await resolveSdpForFlow(flow);
      if(!sdp){
        alert("No SDP available for this sender yet — wait for the manifest fetch to complete or click SDP first.");
        return;
      }
      monitorActiveId = flow.id;
      monitorActiveSdp = sdp;
    }

    const SDP_UNAVAILABLE = "No SDP file available for this sender.\n\n" +
      "Possible reasons:\n" +
      " - sender is inactive\n" +
      " - manifest could not be loaded from the device\n" +
      " - sender is not NMOS-based";
    function openSdpView(flow:SenderRow){
      sdpModalTitle = flow.alias || flow.name || flow.id;
      sdpModalContent = "Loading SDP…";
      sdpModal.showModal();
      resolveSdpForFlow(flow).then((sdp)=>{
        sdpModalContent = sdp || SDP_UNAVAILABLE;
      }).catch(()=>{ sdpModalContent = SDP_UNAVAILABLE; });
    }
    // Feedback state for the Copy button — flips to "Copied!" briefly.
    let sdpCopied:boolean = false;
    function copySdp(){
      let ok = false;
      // navigator.clipboard only exists in a secure context (HTTPS or
      // localhost). NMOS Crosspoint is typically served over plain HTTP on
      // a LAN IP, where navigator.clipboard is undefined — so we fall back
      // to the legacy execCommand("copy") path via a hidden textarea, which
      // works in non-secure contexts too.
      try{
        if(navigator.clipboard && typeof navigator.clipboard.writeText === "function"){
          navigator.clipboard.writeText(sdpModalContent)
            .then(()=>{ flashCopied(); })
            .catch(()=>{ ok = legacyCopy(sdpModalContent); if(ok) flashCopied(); });
          return;
        }
      }catch(e){}
      ok = legacyCopy(sdpModalContent);
      if(ok) flashCopied();
    }
    function legacyCopy(text:string):boolean{
      try{
        let ta = document.createElement("textarea");
        ta.value = text;
        // Keep it off-screen but still selectable.
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.left = "-1000px";
        ta.setAttribute("readonly", "");
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      }catch(e){ return false; }
    }
    let sdpCopiedTimer:any = null;
    function flashCopied(){
      sdpCopied = true;
      if(sdpCopiedTimer){ clearTimeout(sdpCopiedTimer); }
      sdpCopiedTimer = setTimeout(()=>{ sdpCopied = false; }, 1500);
    }

  </script>


  <div class="content-container details-page">

    <ul class="menu bg-base-200 menu-horizontal rounded-box filter-nav">
      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.search} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search Names" />
          <Icon src={MagnifyingGlass}></Icon>
        </label>
      </li>
      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.searchFormat} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search Codec / Format" />
          <Icon src={RectangleGroup}></Icon>
        </label>
      </li>
      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.searchIp} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search IP" />
          <Icon src={RectangleGroup}></Icon>
        </label>
      </li>
      <li>
        <button class="det-expand-all" on:click={toggleExpandAll}
                use:OverlayMenuService.tooltip data-tooltip="{allExpanded ? "Collapse all devices" : "Expand all devices"}">
          <Icon src={allExpanded ? ChevronDoubleUp : ChevronDoubleDown}></Icon>
          <span>{allExpanded ? "Collapse all" : "Expand all"}</span>
        </button>
      </li>
      <li class="nav-spacer"></li>
    </ul>


    <ScrollArea autoHide={false}>
    <div class="det-cards">
      {#each nodeGroups as grp (grp.key)}
      {@const nodeOpen = !grp.grouped || !(filter.collapsedNodes || []).includes(grp.key)}
      <div class={grp.grouped ? "det-node-group" : "det-node-single"}>
      {#if grp.grouped}
        {@const nodeDot = nodeGroupDotClass(grp)}
        {@const ptpDev = grp.devices.find(d => d.gmid)}
        {@const nodeUrl = (grp.devices.find(d => d.deviceUrl) || {deviceUrl:""}).deviceUrl}
        {@const nodeDev = grp.devices[0]}
        <!-- Tooltip sits on the NAME span, not the container — a container
             tooltip would fire on bubbled mouseover and override the dot /
             clock tooltips (GMID would never show). -->
        <div class="det-node-head" on:click={()=>toggleNodeGroup(grp)}>
          <span class={"det-chevron" + (nodeOpen ? " det-chevron-open" : "")}>
            <Icon src={ChevronRight}></Icon>
          </span>
          <span class={"det-device-dot det-device-dot-" + nodeDot}
                use:OverlayMenuService.tooltip
                data-tooltip="{
                  nodeDot === "error"   ? "Node unavailable" :
                  nodeDot === "success" ? (acceptableGmid ? "PTP locked to accepted Grand-Master" : "Node available") :
                  (ptpDev ? "PTP locked to "+ptpDev.gmid+" — does not match accepted GMID" : "No PTP lock detected")
                }"></span>
          <span class="det-node-name"
                use:OverlayMenuService.tooltip
                data-tooltip="NMOS Node with {grp.devices.length} devices — click to {nodeOpen ? "collapse" : "expand"}">{grp.label}</span>
          {#if ptpDev}
            <span class={"det-ptp " + (ptpOk(ptpDev) ? "det-ptp-ok" : "det-ptp-warn")}
                  use:OverlayMenuService.tooltip
                  data-tooltip="{ptpDev.gmidLocked ? "PTP locked to GMID " + ptpDev.gmid : "PTP clock present but not locked — GMID " + ptpDev.gmid}">
              <Icon src={Clock}></Icon>
            </span>
          {/if}
          <span class="det-head-actions det-hover">
            <button on:click|stopPropagation={()=>openLabelEditor("node_" + grp.key, nodeDev.nodeLabelRaw, nodeDev.nodeAlias || nodeDev.nodeLabelRaw)}
                    class="det-icon-btn"
                    use:OverlayMenuService.tooltip data-tooltip="Rename node">
              <Icon src={Pencil}></Icon>
            </button>
            {#if nodeUrl}
              <a href={nodeUrl} target="_blank" rel="noopener noreferrer"
                 class="det-icon-btn det-icon-link"
                 on:click|stopPropagation
                 use:OverlayMenuService.tooltip data-tooltip="Open device web UI: {nodeUrl}">
                <Icon src={ArrowTopRightOnSquare}></Icon>
              </a>
            {/if}
          </span>
          <span class="det-head-spacer"></span>
          <span class="det-device-counts">{grp.devices.length} Devices · {grp.tx} TX · {grp.rx} RX</span>
        </div>
      {/if}
      {#if nodeOpen}
      {#each grp.devices as dev (dev.id)}
        {@const isExpanded = filter.expanded.devices.includes(dev.id)}
        {@const dotClass = deviceDotClass(dev)}
        <div class="det-card {dev.available ? "" : "det-card-offline"} {grp.grouped ? "det-card-in-group" : ""}">

          <div class="det-card-head" on:click={()=>toggleDevice(dev.id)}>
            <span class={"det-chevron" + (isExpanded ? " det-chevron-open" : "")}>
              <Icon src={ChevronRight}></Icon>
            </span>
            {#if !grp.grouped}
              <!-- Status dot / PTP clock / web-UI link are node-level facts;
                   inside a node group they live once in the group header. -->
              <span class={"det-device-dot det-device-dot-" + dotClass}
                    use:OverlayMenuService.tooltip
                    data-tooltip="{
                      dotClass === "error"   ? "Device unavailable" :
                      dotClass === "success" ? (acceptableGmid ? "PTP locked to accepted Grand-Master" : "Device available") :
                      (dev.gmid ? "PTP locked to "+dev.gmid+" — does not match accepted GMID" : "No PTP lock detected")
                    }"></span>
            {/if}
            <span class="det-card-title" use:OverlayMenuService.tooltip data-tooltip="{dev.tooltip}">{grp.grouped ? dev.shortLabel : dev.label}</span>
            {#if dev.gmid && !grp.grouped}
              <span class={"det-ptp " + (ptpOk(dev) ? "det-ptp-ok" : "det-ptp-warn")}
                    use:OverlayMenuService.tooltip
                    data-tooltip="{dev.gmidLocked ? "PTP locked to GMID " + dev.gmid : "PTP clock present but not locked — GMID " + dev.gmid}">
                <Icon src={Clock}></Icon>
              </span>
            {/if}
            <span class="det-head-actions det-hover">
              <button on:click|stopPropagation={()=>openLabelEditor(dev.id, dev.name, dev.alias)} class="det-icon-btn"
                      use:OverlayMenuService.tooltip data-tooltip="Change alias">
                <Icon src={Pencil}></Icon>
              </button>
              {#if dev.deviceUrl && !grp.grouped}
                <a href={dev.deviceUrl} target="_blank" rel="noopener noreferrer"
                   class="det-icon-btn det-icon-link"
                   on:click|stopPropagation
                   use:OverlayMenuService.tooltip data-tooltip="Open device web UI: {dev.deviceUrl}">
                  <Icon src={ArrowTopRightOnSquare}></Icon>
                </a>
              {/if}
            </span>
            <span class="det-head-spacer"></span>
            <span class="det-device-counts">{dev.senders.length} TX · {dev.receivers.length} RX</span>
            {#if !dev.available}
              <button class="btn btn-sm det-device-forget"
                      on:click|stopPropagation={()=>openForgetDialog(dev)}
                      use:OverlayMenuService.tooltip
                      data-tooltip="Remove this offline device — releases its multicast leases and clears cached state.">
                Forget
              </button>
            {/if}
          </div>

          {#if isExpanded}

            {#if dev.senders.length > 0}
              <div class="det-sec det-sec-tx">Senders · {dev.senders.length}</div>
              <table class="det-rows">
                <colgroup>
                  <col style="width:44px;"/>
                  <col style="width:30%;"/>
                  <col style="width:27%;"/>
                  <col/>
                  <col style="width:84px;"/>
                </colgroup>
                <tbody>
                {#each dev.senders as flow (flow.id)}
                  <tr class={"det-flow det-flow-tx det-flow-"+flow.type + (flow.active ? " is-active" : " is-inactive") + (flow.available ? "" : " is-unavailable")}>
                    <td class="det-cell-type">
                      <span class={"cp-type det-toggle-active cp-type-"+flow.type + (flow.active ? " active" : "")}
                            on:click={()=>toggleSenderActive(flow)}
                            use:OverlayMenuService.tooltip
                            data-tooltip="{flow.type === "data" ? "ANC" : flow.type.toUpperCase()} {flow.active ? "active – click to disable":"inactive – click to enable"}">
                        <Icon src={getFlowTypeIcon(flow.type)}></Icon>
                      </span>
                    </td>
                    <td class="det-cell-name">
                      <div class="det-flow-name">
                        {#if !flow.available}
                          <span class="det-flow-dot det-flow-dot-error"
                                use:OverlayMenuService.tooltip
                                data-tooltip="Sender no longer present in the NMOS registry"></span>
                        {/if}
                        {#if flow.name === flow.alias}
                          <span class="det-flow-name-text">{flow.alias}</span>
                        {:else}
                          <span class="det-flow-name-text" use:OverlayMenuService.tooltip data-tooltip="{flow.name}">{flow.alias}</span>
                        {/if}
                        {#if flow.isVirtual}
                          <span class="det-virtual-badge"
                                use:OverlayMenuService.tooltip
                                data-tooltip="Virtual sender — multicast comes from the SDP pasted on the Setup page. Edit it there, not here.">
                            Virtual
                          </span>
                        {/if}
                        <button on:click={()=>openLabelEditor(flow.id, flow.name, flow.alias)} class="det-icon-btn det-hover"
                                use:OverlayMenuService.tooltip data-tooltip="Change alias">
                          <Icon src={Pencil}></Icon>
                        </button>
                        {#if !flow.available && !flow.isVirtual}
                          <button class="btn btn-sm det-flow-forget"
                                  on:click|stopPropagation={()=>openForgetFlowDialog(dev.id, "sender", flow)}
                                  use:OverlayMenuService.tooltip
                                  data-tooltip="Remove this orphan sender — releases its multicast lease and clears the cached state.">
                            Forget
                          </button>
                        {/if}
                      </div>
                    </td>
                    <td class="det-cell-media">
                      <div class="det-media-line">
                        <span class="det-media-text" use:OverlayMenuService.tooltip data-tooltip={mediaText(flow)}>{mediaText(flow)}</span>
                        {#if flow.active}
                          <span class="det-media-bitrate">· {renderBitrate(flow.bitrate)}</span>
                        {:else}
                          <span class="det-media-inactive">· inactive</span>
                        {/if}
                      </div>
                    </td>
                    <td class="det-cell-legs">
                      {#if flow.legs.length === 0}
                        <span class="det-media-muted">—</span>
                      {:else}
                        <div class="det-legs">
                        {#each flow.legs as leg}
                          {@const isDup = flow.active && !!leg.dup}
                          {@const lKey = legKey(flow.id, leg.index)}
                          {@const isEditing = editingLeg === lKey}
                          <div class="det-leg {isDup ? "det-leg-duplicate" : ""}">
                            {#if isEditing}
                              {@const liveConflict = findActiveLegConflict(flow.id, leg.index, legEditIp)}
                              <span class="det-leg-label">Leg {leg.index+1}</span>
                              <input type="text" class="det-leg-input det-leg-input-ip-{lKey.replace(/[:]/g,"_")} {liveConflict ? "det-leg-input-warn" : ""}"
                                     bind:value={legEditIp}
                                     on:keydown={(e)=>legEditKey(e, flow.id, leg.index)}
                                     placeholder="239.x.x.x" size="14" />
                              <span class="det-leg-colon">:</span>
                              <input type="number" class="det-leg-input det-leg-input-port"
                                     bind:value={legEditPort}
                                     on:keydown={(e)=>legEditKey(e, flow.id, leg.index)}
                                     placeholder="5004" min="1" max="65535" />
                              <button class="btn btn-xs btn-success det-leg-btn" on:click={()=>commitLegEdit(flow.id, leg.index)}>Save</button>
                              <button class="btn btn-xs btn-ghost det-leg-btn" on:click={cancelLegEdit}>Cancel</button>
                              {#if legEditError}
                                <span class="text-error det-leg-error">{legEditError}</span>
                              {/if}
                              {#if liveConflict && !legEditError}
                                <span class="text-warning det-leg-warning"
                                      use:OverlayMenuService.tooltip
                                      data-tooltip="Multicast {legEditIp} is already used on Leg {leg.index+1} by another active sender.">
                                  ⚠ Already used by {liveConflict.alias}
                                </span>
                              {/if}
                            {:else}
                              {#if !flow.isVirtual}
                                <button class="det-icon-btn det-hover" on:click={()=>startLegEdit(flow.id, leg.index, leg)}
                                        use:OverlayMenuService.tooltip data-tooltip="Edit Multicast / Port (Leg {leg.index+1})">
                                  <Icon src={Pencil}></Icon>
                                </button>
                              {:else}
                                <!-- Same footprint as the pencil so virtual-sender
                                     legs line up with everything else. -->
                                <span class="det-icon-btn" style="visibility:hidden;"></span>
                              {/if}
                              <!-- SSM source IP lives in the tooltip so revealing
                                   it never widens the leg and reflows the row. -->
                              <span class="det-leg-value" use:OverlayMenuService.tooltip data-tooltip={leg.srcIp ? "Source IP (SSM filter): " + leg.srcIp : ""}>{leg.dstIp || "—"}<span class="det-leg-colon">:</span>{leg.dstPort || "—"}</span>
                              {#if isDup}
                                <span class="text-error det-dup-hint" use:OverlayMenuService.tooltip data-tooltip="Multicast {leg.dstIp} (Leg {leg.index+1}) is also used by: {leg.dupText || "another active sender"}">DUP</span>
                              {/if}
                            {/if}
                          </div>
                        {/each}
                        </div>
                      {/if}
                    </td>
                    <td class="det-cell-actions">
                      {#if monitorActiveId === flow.id}
                        <AudioMonitorPlayer
                          senderId={flow.id}
                          sdp={monitorActiveSdp} />
                      {/if}
                      {#if audioMonitorEnabled && flow.type === "audio"}
                        <button class={"det-icon-btn det-listen-btn" + (monitorActiveId === flow.id ? " is-active" : " det-hover")}
                                on:click={()=>toggleMonitor(flow)}
                                use:OverlayMenuService.tooltip
                                data-tooltip={monitorActiveId === flow.id ? "Stop listening" : "Listen (audio monitor)"}>
                          🎧
                        </button>
                      {/if}
                      <button class="det-icon-btn det-hover" on:click={()=>openSdpView(flow)}
                              use:OverlayMenuService.tooltip data-tooltip="Show SDP file">
                        <Icon src={DocumentText}></Icon>
                      </button>
                    </td>
                  </tr>
                {/each}
                </tbody>
              </table>
            {/if}


            {#if dev.receivers.length > 0}
              <div class="det-sec det-sec-rx">Receivers · {dev.receivers.length}</div>
              <table class="det-rows">
                <colgroup>
                  <col style="width:44px;"/>
                  <col style="width:30%;"/>
                  <col style="width:27%;"/>
                  <col/>
                  <col style="width:52px;"/>
                </colgroup>
                <tbody>
                {#each dev.receivers as recv (recv.id)}
                  <tr class={"det-flow det-flow-rx det-flow-"+recv.type + (recv.active ? " is-active" : " is-inactive") + (recv.available ? "" : " is-unavailable")}>
                    <td class="det-cell-type">
                      <span class={"cp-type det-toggle-active cp-type-"+recv.type + (recv.active ? " active" : "")}
                            on:click={()=>toggleReceiverActive(recv)}
                            use:OverlayMenuService.tooltip
                            data-tooltip={(recv.type === "data" ? "ANC" : recv.type.toUpperCase())
                              + " " + (recv.active ? "active – click to disable" : "inactive – click to enable")
                              + (recv.connectedSenderLabel ? "\nConnected sender: " + recv.connectedSenderLabel : "")}>
                        <Icon src={getFlowTypeIcon(recv.type)}></Icon>
                      </span>
                    </td>
                    <td class="det-cell-name">
                      <div class="det-flow-name">
                        {#if !recv.available}
                          <span class="det-flow-dot det-flow-dot-error"
                                use:OverlayMenuService.tooltip
                                data-tooltip="Receiver no longer present in the NMOS registry"></span>
                        {/if}
                        {#if recv.name === recv.alias}
                          <span class="det-flow-name-text">{recv.alias}</span>
                        {:else}
                          <span class="det-flow-name-text" use:OverlayMenuService.tooltip data-tooltip="{recv.name}">{recv.alias}</span>
                        {/if}
                        <button on:click={()=>openLabelEditor(recv.id, recv.name, recv.alias)} class="det-icon-btn det-hover"
                                use:OverlayMenuService.tooltip data-tooltip="Change alias">
                          <Icon src={Pencil}></Icon>
                        </button>
                        {#if !recv.available}
                          <button class="btn btn-sm det-flow-forget"
                                  on:click|stopPropagation={()=>openForgetFlowDialog(dev.id, "receiver", recv)}
                                  use:OverlayMenuService.tooltip
                                  data-tooltip="Remove this orphan receiver — clears the cached state.">
                            Forget
                          </button>
                        {/if}
                      </div>
                    </td>
                    <td class="det-cell-media">
                      <div class="det-media-line">
                        <span class="det-media-text" use:OverlayMenuService.tooltip data-tooltip={mediaText(recv)}>{mediaText(recv)}</span>
                        {#if recv.active}
                          <span class="det-media-bitrate">· {renderBitrate(recv.bitrate)}</span>
                        {:else}
                          <span class="det-media-inactive">· inactive</span>
                        {/if}
                      </div>
                    </td>
                    <td class="det-cell-legs">
                      {#if recv.legs.length === 0}
                        <span class="det-media-muted">—</span>
                      {:else}
                        <div class="det-legs">
                        {#each recv.legs as leg}
                          <div class="det-leg det-leg-readonly">
                            <span class="det-leg-value" use:OverlayMenuService.tooltip data-tooltip={leg.srcIp ? "Source IP (SSM filter): " + leg.srcIp : ""}>{leg.dstIp || "—"}{leg.dstPort ? ":"+leg.dstPort : ""}</span>
                          </div>
                        {/each}
                        </div>
                      {/if}
                    </td>
                    <td class="det-cell-actions"></td>
                  </tr>
                {/each}
                </tbody>
              </table>
            {/if}

          {/if}
        </div>
      {/each}
      {/if}
      </div>
      {/each}

      {#if deviceList.length === 0}
        <div class="det-empty">No devices available.</div>
      {/if}
    </div>
    </ScrollArea>
  </div>


  <dialog bind:this={sdpModal} class="modal">
    <div class="modal-box det-sdp-modal">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3 class="font-bold text-lg">SDP – {sdpModalTitle}</h3>
      <pre class="det-sdp-content">{sdpModalContent}</pre>
      <div class="modal-action">
        <button on:click={copySdp} class="btn {sdpCopied ? "btn-success" : ""}">{sdpCopied ? "Copied!" : "Copy"}</button>
        <form method="dialog">
          <button class="btn">Close</button>
        </form>
      </div>
    </div>
  </dialog>


  <dialog bind:this={forgetModal} class="modal">
    <div class="modal-box">
      <form method="dialog">
        <button on:click={cancelForget} class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3 class="font-bold text-lg">Forget device?</h3>
      {#if forgetDevice}
        <p class="det-forget-text">
          <strong>{forgetDevice.label}</strong> is offline. Forgetting will:
        </p>
        <ul class="det-forget-list">
          <li>release its multicast leases ({forgetDevice.senders.length} TX) back into the pool</li>
          <li>remove the cached crosspoint state (aliases, sort numbers, …)</li>
          <li>if the device comes back online later, it will be treated as a fresh device</li>
        </ul>
      {/if}
      <div class="modal-action">
        <button on:click={cancelForget} class="btn">Cancel</button>
        <button on:click={confirmForget} class="btn btn-error">Forget</button>
      </div>
    </div>
  </dialog>


  <dialog bind:this={labelModal} class="modal">
    <div class="modal-box">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3 class="font-bold text-lg">Change Alias</h3>
      <span>Source Name: {labelModalName}</span><br/>
      <span>Alias: {labelModalAlias}</span>
      <input on:keypress={(e)=>{if(e.keyCode == 13) changeLabelSend()}} bind:this={labelModalInput} bind:value={labelModalValue} type="text" placeholder="Type here" class="input input-bordered w-full max-w-xs" />
      <div class="modal-action">
        <form method="dialog">
          <button on:click={()=>{labelModalValue = ""; changeLabelSend()}} class="btn">Remove</button>
          <button on:click={()=>{changeLabelSend()}} class="btn">Save</button>
          <button class="btn">Close</button>
        </form>
      </div>
    </div>
  </dialog>
