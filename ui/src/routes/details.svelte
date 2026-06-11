<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService"
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";

    import { Icon, MagnifyingGlass, RectangleGroup, Pencil, ChevronRight,
       VideoCamera, Microphone, DocumentText,
       CodeBracketSquare, ArrowTopRightOnSquare
     } from "svelte-hero-icons";

    import ScrollArea from "../lib/ScrollArea.svelte";
    import { getSearchTokens, tokenSearch } from "../lib/functions";
    import OverlayMenuService from "../lib/OverlayMenu/OverlayMenuService";


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
      search:"",
      searchFormat:"",
      searchIp:""
    };

    // ----- Source data -----
    // The crosspoint sync carries everything we need — devices, senders,
    // receivers, plus the server-side enrichment (legs, codecs, node label,
    // gmid, device URL, connected-sender label). The nmos sync is only used
    // for the raw SDP viewer (sendersManifestDetail._RAWSDP).
    let sourceState:any = { devices: [] };
    let nmosState:any = {
        sendersManifestDetail :{}
    };

    let sync:Subject<any>;
    let syncNmos:Subject<any>;
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
      legs: Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string }>;
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
      legs: Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string }>;
    }
    interface DeviceRow {
      id:string;
      // Display label, format: "Node - Device"
      label:string;
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
    // Per-leg duplicate set: duplicateIpsByLeg[legIndex] = Set of duplicate IPs
    // We track legs separately because primary and secondary network legs are
    // independent failover paths — using the same multicast on both is fine.
    let duplicateIpsByLeg:{[legIndex:number]:Set<string>} = {};
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
      // ipCount[legIndex][ip] = count
      let ipCount:{[legIndex:number]:{[ip:string]:number}} = {};
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
          let legs:Array<{ index:number, dstIp:string, dstPort:string|number, srcIp:string }> = Array.isArray(s.legs) ? s.legs : [];

          if(s.active){
            legs.forEach((l)=>{
              if(l.dstIp){
                if(!ipCount[l.index]){ ipCount[l.index] = {}; }
                ipCount[l.index][l.dstIp] = (ipCount[l.index][l.dstIp] || 0) + 1;
              }
            });
          }

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

      // duplicates per leg
      let newDups:{[legIndex:number]:Set<string>} = {};
      Object.keys(ipCount).forEach((legKey:any)=>{
        let leg = Number(legKey);
        let bucket = new Set<string>();
        Object.keys(ipCount[leg]).forEach((ip)=>{
          if(ipCount[leg][ip] > 1){ bucket.add(ip); }
        });
        if(bucket.size > 0){ newDups[leg] = bucket; }
      });

      // sort by combined label
      newList.sort((a,b)=>(a.label||"").localeCompare(b.label||""));

      // Reassign — this is what makes Svelte re-render
      deviceList = newList;
      duplicateIpsByLeg = newDups;

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
      // We still subscribe to the nmos sync purely for the raw SDP modal:
      // sendersManifestDetail[*]._RAWSDP is the only field we read directly.
      syncNmos = ServerConnector.sync("nmos")
      syncNmos.subscribe((obj:any)=>{
        if(obj){ nmosState = obj; }
      });
      syncSetup = ServerConnector.sync("setupConfig")
      syncSetup.subscribe((obj:any)=>{
        if(obj && typeof obj.acceptableGmid === "string"){
          acceptableGmid = obj.acceptableGmid;
          // Re-render so device dots reflect the new threshold without
          // waiting for the next crosspoint patch.
          deviceList = deviceList;
        }
      });
    });

    onDestroy(() => {
      try{sync && sync.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("crosspoint");}catch(e){}
      try{syncNmos && syncNmos.unsubscribe();}catch(e){}
      try{ServerConnector.unsync("nmos");}catch(e){}
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

    function toggleSendersSection(id:string){
      let list = filter.collapsedSenders || [];
      if(list.includes(id)){
        filter.collapsedSenders = list.filter((d:string) => d !== id);
      }else{
        filter.collapsedSenders = [...list, id];
      }
      filter = filter;
      saveFilter();
    }
    function toggleReceiversSection(id:string){
      let list = filter.collapsedReceivers || [];
      if(list.includes(id)){
        filter.collapsedReceivers = list.filter((d:string) => d !== id);
      }else{
        filter.collapsedReceivers = [...list, id];
      }
      filter = filter;
      saveFilter();
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
     */
    function findActiveLegConflict(currentFlowId:string, legIndex:number, ip:string){
      if(!ip || !ip.trim()){ return null; }
      let needle = ip.trim();
      for(let d of deviceList){
        for(let s of d.senders){
          if(!s.active){ continue; }
          if(s.id === currentFlowId){ continue; }
          for(let l of s.legs){
            if(l.index === legIndex && l.dstIp === needle){
              return s;
            }
          }
        }
      }
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
    function openSdpView(flow:SenderRow){
      sdpModalTitle = flow.alias || flow.name || flow.id;
      sdpModalContent = "";
      // Virtual senders carry the SDP directly on the flow — no NMOS
      // registry to fetch from. Check that first.
      try{
        if(typeof flow.sdp === "string" && flow.sdp.length > 0){
          sdpModalContent = flow.sdp;
        }
      }catch(e){}
      try{
        if(!sdpModalContent && flow.nmosId && nmosState.sendersManifestDetail && nmosState.sendersManifestDetail[flow.nmosId]){
          let raw = nmosState.sendersManifestDetail[flow.nmosId]._RAWSDP;
          if(typeof raw === "string" && raw.length > 0){
            sdpModalContent = raw;
          }
        }
      }catch(e){}
      if(!sdpModalContent){
        sdpModalContent = "No SDP file available for this sender.\n\n" +
          "Possible reasons:\n" +
          " - sender is inactive\n" +
          " - manifest could not be loaded from the device\n" +
          " - sender is not NMOS-based";
      }
      sdpModal.showModal();
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
      <li class="nav-spacer"></li>
    </ul>


    <ScrollArea autoHide={false}>
    <table class="data-table details-tree">
      <!-- Fixed column widths so opening the edit-form / Forget button etc.
           doesn't make columns jiggle. Hint cells use overflow:hidden + ellipsis
           in CSS (.det-flow td) for content that doesn't fit. -->
      <colgroup>
        <col style="width:40px;"/>
        <col style="width:220px;"/>
        <col style="width:60px;"/>
        <col style="width:130px;"/>
        <col style="width:160px;"/>
        <col style="width:100px;"/>
        <col style="width:280px;"/>
        <col style="width:130px;"/>
        <col style="width:80px;"/>
      </colgroup>
      <tbody>
        {#each deviceList as dev (dev.id)}
          {@const isExpanded = filter.expanded.devices.includes(dev.id)}
          {@const dotClass = deviceDotClass(dev)}
          <tr class="det-device" on:dblclick={()=>toggleDevice(dev.id)}>
            <td on:click={()=>toggleDevice(dev.id)}>
              <span class={"data-table-expand" + (isExpanded ? " data-table-expand-active" : "")}>
                <Icon src={ChevronRight}></Icon>
              </span>
            </td>
            <td on:click={()=>toggleDevice(dev.id)} class="det-device-label" colspan="8">
              <div class="det-device-label-inner">
                <div class="det-device-label-text">
                  <div class="det-device-name-row">
                    <span class={"det-device-dot det-device-dot-" + dotClass}
                          use:OverlayMenuService.tooltip
                          data-tooltip="{
                            dotClass === "error"   ? "Device unavailable" :
                            dotClass === "success" ? (acceptableGmid ? "PTP locked to accepted Grand-Master" : "Device available") :
                            (dev.gmid ? "PTP locked to "+dev.gmid+" — does not match accepted GMID" : "No PTP lock detected")
                          }"></span>
                    <span use:OverlayMenuService.tooltip data-tooltip="{dev.tooltip}"><strong>{dev.label}</strong></span>
                    <button on:click|stopPropagation={()=>openLabelEditor(dev.id, dev.name, dev.alias)} class="btn btn-round det-device-edit"
                            use:OverlayMenuService.tooltip data-tooltip="Change alias">
                      <Icon src={Pencil}></Icon>
                    </button>
                    {#if dev.deviceUrl}
                      <a href={dev.deviceUrl} target="_blank" rel="noopener noreferrer"
                         class="det-device-link"
                         on:click|stopPropagation
                         use:OverlayMenuService.tooltip data-tooltip="Open device web UI: {dev.deviceUrl}">
                        <Icon src={ArrowTopRightOnSquare}></Icon>
                      </a>
                    {/if}
                  </div>
                  {#if dev.gmid}
                    <span class="det-device-gmid {dev.gmidLocked ? "" : "det-device-gmid-warn"}"
                          use:OverlayMenuService.tooltip
                          data-tooltip="{dev.gmidLocked ? "PTP Grand-Master ID this node is locked to" : "PTP clock present but not locked!"}">
                      Locked to GMID {dev.gmid}{dev.gmidLocked ? "" : " (unlocked)"}
                    </span>
                  {/if}
                </div>
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
            </td>
          </tr>

          {#if isExpanded}

            {#if dev.senders.length > 0}
              {@const sendersExpanded = !filter.collapsedSenders.includes(dev.id)}
              <tr class="det-section det-section-senders" on:click={()=>toggleSendersSection(dev.id)}>
                <td>
                  <span class={"data-table-expand "+ (sendersExpanded ? "data-table-expand-active":"")}><Icon src={ChevronRight}></Icon></span>
                </td>
                <td><span class="det-section-title">SENDERS</span> <span class="det-section-count">({dev.senders.length})</span></td>
                <td>Type</td>
                <td>Codec</td>
                <td>Format</td>
                <td>Bitrate</td>
                <td>Destination IP : Port</td>
                <td>Source IP</td>
                <td>Manifest</td>
              </tr>
            {/if}

            {#if dev.senders.length > 0 && !filter.collapsedSenders.includes(dev.id)}
            {#each dev.senders as flow (flow.id)}
              <tr class={"det-flow det-flow-tx det-flow-"+flow.type + (flow.active ? " is-active" : " is-inactive") + (flow.available ? "" : " is-unavailable")}>
                <td></td>
                <td style="padding-left:32px;">
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
                    <button on:click={()=>openLabelEditor(flow.id, flow.name, flow.alias)} class="btn btn-round btn-hover">
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
                <td>
                  <span class={"cp-type det-toggle-active cp-type-"+flow.type + (flow.active ? " active" : "")}
                        on:click={()=>toggleSenderActive(flow)}
                        use:OverlayMenuService.tooltip
                        data-tooltip="{flow.type === "data" ? "ANC" : flow.type.toUpperCase()} {flow.active ? "active – click to disable":"inactive – click to enable"}">
                    <Icon src={getFlowTypeIcon(flow.type)}></Icon>
                  </span>
                </td>
                <td>{flow.codec}</td>
                <td>{flow.format}</td>
                <td>
                  {#if flow.active}
                    <span>{renderBitrate(flow.bitrate)}</span>
                  {:else}
                    <span class="text-warning">inactive</span>
                  {/if}
                </td>
                <td>
                  {#if flow.legs.length === 0}
                    <span class="text-info">—</span>
                  {:else}
                    {#each flow.legs as leg}
                      {@const isDup = flow.active && duplicateIpsByLeg[leg.index] && duplicateIpsByLeg[leg.index].has(leg.dstIp)}
                      {@const lKey = legKey(flow.id, leg.index)}
                      {@const isEditing = editingLeg === lKey}
                      <div class="det-leg {isDup ? "det-leg-duplicate" : ""}">
                        {#if isEditing}
                          {@const liveConflict = findActiveLegConflict(flow.id, leg.index, legEditIp)}
                          <span class="det-leg-label">Leg {leg.index+1}:</span>
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
                          <span class="det-leg-label">Leg {leg.index+1}:</span>
                          {#if !flow.isVirtual}
                            <button class="btn btn-round det-leg-edit" on:click={()=>startLegEdit(flow.id, leg.index, leg)}
                                    use:OverlayMenuService.tooltip data-tooltip="Edit Multicast / Port">
                              <Icon src={Pencil}></Icon>
                            </button>
                          {/if}
                          <span class="det-leg-value">{leg.dstIp || "—"}<span class="det-leg-colon">:</span>{leg.dstPort || "—"}</span>
                          {#if isDup}
                            <span class="text-error det-dup-hint" use:OverlayMenuService.tooltip data-tooltip="Multicast IP used by another active sender on the same leg!">DUP</span>
                          {/if}
                          {#if flow.isVirtual}
                            <span class="det-virtual-badge"
                                  use:OverlayMenuService.tooltip
                                  data-tooltip="Virtual sender — multicast comes from the SDP pasted on the Setup page. Edit it there, not here.">
                              Virtual
                            </span>
                          {/if}
                        {/if}
                      </div>
                    {/each}
                  {/if}
                </td>
                <td>
                  {#each flow.legs as leg}
                    <div class="det-leg">
                      <span>{leg.srcIp || "—"}</span>
                    </div>
                  {/each}
                </td>
                <td class="data-table-action-buttons">
                  <button class="btn" on:click={()=>openSdpView(flow)}
                          use:OverlayMenuService.tooltip data-tooltip="Show SDP file">
                    <Icon src={DocumentText}></Icon>
                    <span class="det-action-label">SDP</span>
                  </button>
                </td>
              </tr>
            {/each}
            {/if}


            {#if dev.receivers.length > 0}
              {@const receiversExpanded = !filter.collapsedReceivers.includes(dev.id)}
              <tr class="det-section det-section-receivers" on:click={()=>toggleReceiversSection(dev.id)}>
                <td>
                  <span class={"data-table-expand "+ (receiversExpanded ? "data-table-expand-active":"")}><Icon src={ChevronRight}></Icon></span>
                </td>
                <td><span class="det-section-title">RECEIVERS</span> <span class="det-section-count">({dev.receivers.length})</span></td>
                <td>Type</td>
                <td>Codec</td>
                <td>Format</td>
                <td>Bitrate</td>
                <td>Destination IP : Port</td>
                <td>Source IP</td>
                <td></td>
              </tr>
            {/if}

            {#if dev.receivers.length > 0 && !filter.collapsedReceivers.includes(dev.id)}
            {#each dev.receivers as recv (recv.id)}
              <tr class={"det-flow det-flow-rx det-flow-"+recv.type + (recv.active ? " is-active" : " is-inactive") + (recv.available ? "" : " is-unavailable")}>
                <td></td>
                <td style="padding-left:32px;">
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
                    <button on:click={()=>openLabelEditor(recv.id, recv.name, recv.alias)} class="btn btn-round btn-hover">
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
                  {#if recv.connectedSenderLabel}
                    <div class="det-recv-source" use:OverlayMenuService.tooltip data-tooltip="Connected sender">← {recv.connectedSenderLabel}</div>
                  {/if}
                </td>
                <td>
                  <span class={"cp-type det-toggle-active cp-type-"+recv.type + (recv.active ? " active" : "")}
                        on:click={()=>toggleReceiverActive(recv)}
                        use:OverlayMenuService.tooltip
                        data-tooltip="{recv.type === "data" ? "ANC" : recv.type.toUpperCase()} {recv.active ? "active – click to disable" : "inactive – click to enable"}">
                    <Icon src={getFlowTypeIcon(recv.type)}></Icon>
                  </span>
                </td>
                <td>{recv.codec}</td>
                <td>{recv.format}</td>
                <td>
                  {#if recv.active}
                    <span>{renderBitrate(recv.bitrate)}</span>
                  {:else}
                    <span class="text-warning">inactive</span>
                  {/if}
                </td>
                <td>
                  {#if recv.legs.length === 0}
                    <span class="text-info">—</span>
                  {:else}
                    {#each recv.legs as leg}
                      <div class="det-leg det-leg-readonly">
                        <span class="det-leg-label">Leg {leg.index+1}:</span>
                        <span>{leg.dstIp || "—"}{leg.dstPort ? ":"+leg.dstPort : ""}</span>
                      </div>
                    {/each}
                  {/if}
                </td>
                <td>
                  {#each recv.legs as leg}
                    <div class="det-leg">
                      <span>{leg.srcIp || "—"}</span>
                    </div>
                  {/each}
                </td>
                <td></td>
              </tr>
            {/each}
            {/if}

          {/if}
        {/each}

        {#if deviceList.length === 0}
          <tr>
            <td colspan="9" style="text-align:center; padding:24px;">
              <span class="text-info">No Devices available.</span>
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
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
