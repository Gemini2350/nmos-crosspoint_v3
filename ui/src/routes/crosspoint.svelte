<script lang="ts">
    import type { Source } from "postcss";
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService"
      import type { Subject } from "rxjs";
      import { afterUpdate, onDestroy, onMount } from "svelte";
      import { createEventDispatcher } from 'svelte';

      import { Icon, ChevronRight, ChevronDoubleUp, VideoCamera, Microphone, CodeBracketSquare, MagnifyingGlass,  SpeakerWave, Tv,Pencil, Eye, EyeSlash, Link, InformationCircle, ExclamationTriangle, ExclamationCircle, Heart } from "svelte-hero-icons";
    import { getSearchTokens, tokenSearch } from "../lib/functions";
    import OverlayMenuService from "../lib/OverlayMenu/OverlayMenuService";
    
      interface CrosspointConnect {
        source:string,
        destination:string
      };
  
    let senders:any[] = [];
    let receivers:any[] = [];
    let sourceState:any = {}

    let trigerUpdate = "";

    export let autoTake = true;
    const dispatch = createEventDispatcher();
    


    let filter:any = {
      version:11338,
      showUnavailable:false,
      showHidden: false,
      searchReceivers:"",
      searchSenders:"",
      expanded: { senders :[], receivers :[]}
    };

    let searchExpandedReceivers:string[] = [];
    let searchExpandedSenders:string[] = [];
  
    let sync:Subject<any> ;

    let flowTypes = ["video", "audio", "data", "mqtt", "websocket", "audiochannel", "unknown"];


    // Display name is composed entirely on the server
    // (CrosspointAbstraction.composeDeviceLabel → dev.displayLabel): it
    // handles the "<Node> - <Device>" join, the operator-alias override and
    // the offline node-label cache, identically for every UI page. We just
    // render it; fall back to alias/name only if the field is missing.
    function deviceDisplayLabel(dev:any){
      return dev?.displayLabel || dev?.alias || dev?.name || "";
    }
    // Device-only name (no "<Node> - " prefix), used for the device rows
    // inside an open node strip, where the strip above already names the node.
    function deviceDisplayLabelShort(dev:any){
      return dev?.displayLabelShort || deviceDisplayLabel(dev);
    }

    /** Exactly one line per entry — never a node line stacked on a device line:
     *   node strip (node with several devices)  → the node name
     *   device row inside an open strip         → the device name alone
     *   node with a single device               → "<Node> - <Device>"
     *  The combined form is what the server already composes in displayLabel. */
    function deviceRowLabel(dev:any, inStrip:boolean){
      if(dev?.isNode || inStrip){ return deviceDisplayLabelShort(dev); }
      return deviceDisplayLabel(dev);
    }
    /** The node part of a row label, rendered underlined so the node is
     *  recognisable even where it shares the line with a device. Empty unless
     *  the label really is "<Node> - <Device>" — an operator alias replaces
     *  the whole name, and then there is no node part to mark. */
    function labelNodePart(dev:any, inStrip:boolean){
      if(dev?.isNode){ return deviceDisplayLabelShort(dev); }
      if(inStrip){ return ""; }
      let n = ("" + (dev?.nodeLabel || "")).trim();
      if(!n){ return ""; }
      return deviceDisplayLabel(dev) === n + " - " + deviceDisplayLabelShort(dev) ? n : "";
    }
    function labelRestPart(dev:any, inStrip:boolean){
      let n = labelNodePart(dev, inStrip);
      if(!n || dev?.isNode){ return ""; }
      return " - " + deviceDisplayLabelShort(dev);
    }

    // ----- Node grouping (same rule as the Details page) -----
    // Devices sharing an NMOS node are clustered next to each other and get
    // a slim node band (header row above the sender columns / separator row
    // before the receiver rows). Single-device nodes render exactly as
    // before with the combined "<Node> - <Device>" label.
    interface CpNodeGroup {
      key:string;
      label:string;
      grouped:boolean;
      devices:any[];
      // for the rename modal: the NMOS node id plus its registry name, so the
      // strip can be renamed exactly like the node header on the Details page
      nodeId:string;
      labelRaw:string;
      alias:string;
    }
    let senderGroups:CpNodeGroup[] = [];
    let receiverGroups:CpNodeGroup[] = [];

    function groupDevicesByNode(devs:any[]):CpNodeGroup[]{
      let byKey:{[k:string]:CpNodeGroup} = {};
      let groups:CpNodeGroup[] = [];
      devs.forEach((dev:any)=>{
        let key = dev.nodeId || dev.id;
        let g = byKey[key];
        if(!g){
          g = { key, label: dev.nodeLabel || deviceDisplayLabel(dev), grouped:false, devices:[],
                nodeId: dev.nodeId || "", labelRaw: dev.nodeLabelRaw || "", alias: dev.nodeAlias || "" };
          byKey[key] = g;
          groups.push(g);
        }
        if(dev.nodeLabel){ g.label = dev.nodeLabel; }
        if(dev.nodeId){ g.nodeId = dev.nodeId; }
        if(dev.nodeLabelRaw){ g.labelRaw = dev.nodeLabelRaw; }
        if(dev.nodeAlias){ g.alias = dev.nodeAlias; }
        g.devices.push(dev);
      });
      groups.forEach((g)=>{ g.grouped = g.devices.length > 1; });
      return groups;
    }
    function flattenGroups(groups:CpNodeGroup[]):any[]{
      let out:any[] = [];
      groups.forEach((g)=>{ out = out.concat(g.devices); });
      return out;
    }

    // ----- Node level -----
    // A node with SEVERAL devices can be folded into a single row/column.
    // Instead of a separate rendering path, the fold produces one synthetic
    // "device" whose flow lists are the merged flows of the whole node — so
    // the cell index, the aggregation and the geometry keep working exactly
    // as they do for a real device, one level up. A node with a single
    // device is never folded: there would be nothing to reveal, and the
    // extra click would only get in the way.
    let searchExpandedNodes:{[dir:string]:string[]} = { senders:[], receivers:[] };
    function isNodeExpanded(dir:string, key:string):boolean{
      if(searchExpandedNodes[dir] && searchExpandedNodes[dir].includes(key)){ return true; }
      let list = filter.expandedNodes ? filter.expandedNodes[dir] : null;
      return Array.isArray(list) && list.includes(key);
    }
    function toggleExpandNode(dir:string, key:string){
      if(!filter.expandedNodes){ filter.expandedNodes = { senders:[], receivers:[] }; }
      if(!Array.isArray(filter.expandedNodes[dir])){ filter.expandedNodes[dir] = []; }
      let idx = searchExpandedNodes[dir].indexOf(key);
      if(idx != -1){ searchExpandedNodes[dir].splice(idx,1); }
      idx = filter.expandedNodes[dir].indexOf(key);
      if(idx == -1){ filter.expandedNodes[dir].push(key); }
      else{ filter.expandedNodes[dir].splice(idx,1); }
      saveFilter();
      doFilter();
    }

    function mergeFlows(devices:any[], side:"senders"|"receivers"){
      let out:any = {};
      flowTypes.forEach((t)=>{
        let list:any[] = [];
        devices.forEach((d)=>{ if(d[side] && Array.isArray(d[side][t])){ list = list.concat(d[side][t]); } });
        out[t] = list;
      });
      return out;
    }
    function mergeMonitorSummary(devices:any[], key:string){
      let worst = 0, count = 0;
      devices.forEach((d)=>{
        let s = d[key];
        if(s && s.worst >= 2){ worst = Math.max(worst, s.worst); count += (s.count || 0); }
      });
      return worst >= 2 ? { worst, count } : null;
    }
    /** The node strip. Folded it stands in for the whole node and carries
     *  the merged flows, so cells, aggregation and geometry work exactly as
     *  for a real device one level up. Unfolded it stays on screen as the
     *  group header (otherwise there is no way to fold it again) but WITHOUT
     *  flows: the same flow must not map to both the strip and its device,
     *  or one of the two would lose its dots in the cell index. */
    function makeNodeEntry(g:CpNodeGroup, side:"senders"|"receivers", open = false){
      const noFlows = mergeFlows([], side);
      const flows = open ? noFlows : mergeFlows(g.devices, side);
      return {
        id: "cpnode_" + g.key,
        isNode: true,
        isOpen: open,
        nodeKey: g.key,
        name: g.label, alias: g.label,
        displayLabel: g.label, displayLabelShort: g.label,
        nodeLabel: "",              // the label IS the node — no second line
        // rename target: the NMOS node itself, not a device
        nodeId: g.nodeId,
        nodeLabelRaw: g.labelRaw || g.label,
        nodeAlias: g.alias,
        hidden: false,
        available: g.devices.some((d:any)=>d.available),
        senders: side === "senders" ? flows : noFlows,
        receivers: side === "receivers" ? flows : noFlows,
        // Rolled-up health, folded AND open: the node's overall status is what
        // you look at first, and losing it the moment you open the node is
        // exactly when you need it. The devices below repeat their own share
        // of it — that is a breakdown, not a double count.
        monitorSummaryTx: mergeMonitorSummary(g.devices, "monitorSummaryTx"),
        monitorSummaryRx: mergeMonitorSummary(g.devices, "monitorSummaryRx"),
      };
    }
    /** Replace the devices of every folded multi-device node with its
     *  synthetic entry — headers, rows and cells all read the group arrays,
     *  so doing it here keeps every axis consistent by construction. */
    function collapseNodes(groups:CpNodeGroup[], dir:"senders"|"receivers"):CpNodeGroup[]{
      return groups.map((g)=>{
        // A node with a single device is never folded: there would be
        // nothing to reveal and the extra click would only get in the way.
        if(g.devices.length <= 1){ return g; }
        if(!isNodeExpanded(dir, g.key)){
          return { ...g, devices: [ makeNodeEntry(g, dir, false) ] };
        }
        return { ...g, devices: [ makeNodeEntry(g, dir, true), ...g.devices ] };
      });
    }

    // NOTE the band/strip geometry helpers (senderDevCols, groupSenderCols,
    // receiverDevRows, groupReceiverRows, bandLabelVisible) went away with
    // the node bands: every device label carries its own node line now, so
    // there is no colspan/rowspan left that has to mirror the markup.

    // Force a matrix re-render. The template renders rows/columns from the
    // GROUP arrays and connect cells from the flat arrays — every state
    // change that must repaint cells (prepared / working / preview / active
    // / dashed disconnect markers) has to reassign ALL of them; reassigning
    // only `receivers` (the pre-grouping idiom) no longer reaches the rows.
    function refreshMatrix(){
      rebuildCellIndex();
      senders = [...senders];
      receivers = [...receivers];
      senderGroups = [...senderGroups];
      receiverGroups = [...receiverGroups];
    }

    function getFlowTypeIcon(type:any, source=true){
      if(source){
        switch(type){
          case "video":
            return VideoCamera;
            break;
          case "audio":
          case "audiochannel":
            return Microphone;
            break;
          case "data":
          case "mqtt":
          case "websocket":
            return CodeBracketSquare;
            break;
          default:
              return "";
              break;
        }
      }else{
        switch(type){
          case "video":
            return Tv;
            break;
          case "audio":
          case "audiochannel":
            return SpeakerWave;
            break;
          case "data":
          case "mqtt":
          case "websocket":
            return CodeBracketSquare;
            break;
          default:
              return "";
              break;
        }
      }
    }
  
    onMount(async () => {
      try{
        let f = localStorage.getItem("nmos_crosspoint_filter");
        if(f){
          let tempFilter = JSON.parse(f);
          if(tempFilter.version == filter.version){
            filter = tempFilter;
          }else{
            console.log("Resetting crosspoint filter localstorage.");
            saveFilter();
          }
        }
      }catch(e){}

      sync = ServerConnector.sync("crosspoint");
      sync.subscribe((obj:any)=>{
        sourceState = obj;
        scheduleFilter();
        refreshMonitorModalFlow();
      });
    });

    // Coalesce sync patches into one doFilter per animation frame — the
    // crosspoint SyncObject delivers a patch per upstream NMOS event, which
    // on a busy registry means bursts of them. doFilter walks + copies every
    // device, so running it once per frame instead of once per patch keeps
    // the matrix responsive (same pattern as details.svelte's rebuild).
    let filterScheduled = false;
    function scheduleFilter(){
      if(filterScheduled) return;
      filterScheduled = true;
      const run = () => {
        filterScheduled = false;
        try{ doFilter(); }catch(e){}
      };
      if(typeof requestAnimationFrame === "function"){
        requestAnimationFrame(run);
      }else{
        setTimeout(run, 16);
      }
    }

    function changeFilter(){
      setTimeout(()=>{
      doFilter();

      saveFilter();
    },10)
    }

    // Shallow-copy a device for the filter pipeline. The filters below only
    // ever REPLACE the per-type flow arrays (dev.senders[type] = [...].filter),
    // they never mutate the flow objects themselves — so copying the device
    // record, the senders/receivers dicts and the arrays is enough. The old
    // structuredClone(dev) deep-cloned every flow (legs, codecs, bitrates …)
    // on every sync patch, which was the single biggest UI cost on large
    // registries.
    function shallowDeviceCopy(dev:any, kind:"senders"|"receivers"){
      let d:any = {...dev};
      let src = dev[kind] || {};
      let copy:any = {};
      flowTypes.forEach((type)=>{ copy[type] = Array.isArray(src[type]) ? [...src[type]] : []; });
      d[kind] = copy;
      d[kind === "senders" ? "receivers" : "senders"] = undefined;
      return d;
    }

    function doFilter (){
      senders = [];
      receivers = [];
      searchExpandedReceivers = [];
      searchExpandedSenders = [];
      searchExpandedNodes = { senders:[], receivers:[] };

      if(sourceState.devices){
        sourceState.devices.forEach((dev:any)=>{
          let count = 0;
          flowTypes.forEach((type)=>{
            count+= dev.senders[type].length;
          })
          if(count > 0){
            senders.push(shallowDeviceCopy(dev, "senders"));
          }
        })

        sourceState.devices.forEach((dev:any)=>{
          let count = 0;
          flowTypes.forEach((type)=>{
            count+= dev.receivers[type].length;
          })
          if(count > 0){
            receivers.push(shallowDeviceCopy(dev, "receivers"));
          }
        })

        if(!filter.showUnavailable){
          receivers = receivers.filter((dev)=>{
            flowTypes.forEach((type)=>{
              dev.receivers[type] = dev.receivers[type].filter((flow:any)=>{
                if(flow.available){
                  return true;
                }
                return false;
              });
            });

            let count = 0;
            flowTypes.forEach((type)=>{
              count+= dev.receivers[type].length;
            })
            if(count > 0){
              return true;
            }
            return false;
          });

          senders = senders.filter((dev)=>{
            flowTypes.forEach((type)=>{
              dev.senders[type] = dev.senders[type].filter((flow:any)=>{
                if(flow.available){
                  return true;
                }
                return false;
              });
            });

            let count = 0;
            flowTypes.forEach((type)=>{
              count+= dev.senders[type].length;
            })
            if(count > 0){
              return true;
            }
            return false;
          });
        }

        if(!filter.showHidden){
          receivers = receivers.filter((dev)=>{
            if(dev.hidden){
              return false;
            }
            flowTypes.forEach((type)=>{
              dev.receivers[type] = dev.receivers[type].filter((flow:any)=>{
                if(flow.hidden){
                  return false;
                }
                return true;
              });
            });
            return true
          });

          senders = senders.filter((dev)=>{
            if(dev.hidden){
              return false;
            }
            flowTypes.forEach((type)=>{
              dev.senders[type] = dev.senders[type].filter((flow:any)=>{
                if(flow.hidden){
                  return false;
                }
                return true;
              });
            });
            return true;
          });
        }

        // Search
        if(filter.searchReceivers != ""){
          let searchTokens = getSearchTokens(filter.searchReceivers);
          receivers = receivers.filter((dev:any)=>{
            let flowFound = false;
            for(let type in dev.receivers){
              
              // TODO mybe add original Name to search fields?
              dev.receivers[type].filter((recv:any)=>{
                let found = tokenSearch(recv, searchTokens, ["alias", "name"]);
                if(found){
                  flowFound = true;
                }
                return found;
              });

              
            }
            let self = tokenSearch(dev, searchTokens, ["alias", "name"]);
            if(flowFound && !self){
              searchExpandedReceivers.push(dev.id);
            }
            if(flowFound || self){
              let nk = dev.nodeId || dev.id;
              if(!searchExpandedNodes.receivers.includes(nk)){ searchExpandedNodes.receivers.push(nk); }
            }

            
            if(flowFound || self ){
              return true;
            }
            return false;
          }); 
        }

        if(filter.searchSenders != ""){
          let searchTokens = getSearchTokens(filter.searchSenders);
          senders = senders.filter((dev:any)=>{
            let flowFound = false;
            for(let type in dev.senders){

              // TODO mybe add original Name to search fields?
              dev.senders[type].filter((send:any)=>{
                let found = tokenSearch(send, searchTokens, ["alias", "name"]);
                if(found){
                  flowFound = true;
                }
                return found;
              });


            }
            let self = tokenSearch(dev, searchTokens, ["alias", "name"]);
            if(flowFound && !self){
              searchExpandedSenders.push(dev.id);
            }
            if(flowFound || self){
              let nk = dev.nodeId || dev.id;
              if(!searchExpandedNodes.senders.includes(nk)){ searchExpandedNodes.senders.push(nk); }
            }


            if(flowFound || self ){
              return true;
            }
            return false;
          });
        }

        // Cluster devices of the same node next to each other and rebuild
        // the flat arrays in group order — the tbody connect-cell loops
        // iterate the flat arrays, so their column/row sequence must match
        // the grouped header markup exactly.
        senderGroups = collapseNodes(groupDevicesByNode(senders), "senders");
        senders = flattenGroups(senderGroups);
        receiverGroups = collapseNodes(groupDevicesByNode(receivers), "receivers");
        receivers = flattenGroups(receiverGroups);

        rebuildCellIndex();
    }

    }
    function isSenderExpanded(id:string){
      if(searchExpandedSenders.includes(id)){
        return true;
      }
      if(filter.expanded.senders.includes(id)){
        return true;
      }
      return false;
    }
    function isReceiverExpanded(id:string){
      if(searchExpandedReceivers.includes(id)){
        return true;
      }
      if(filter.expanded.receivers.includes(id)){
        return true;
      }
      return false;
    }

    // While the matrix scrolls, cells stream under the (stationary)
    // pointer: every one of them fired mouseover → hover style recalcs +
    // preview scheduling, which throttled wheel scrolling to a crawl on
    // large matrices. pointer-events are disabled during the scroll and
    // restored 150ms after the last scroll event.
    let isScrolling = false;
    let crossRowEl:any = null;
    let crossColEl:any = null;
    let crossFrame:any = null;
    /** Position the two crosshair strips over the cell under the pointer.
     *  Coordinates are taken in the container's CONTENT space (rect delta plus
     *  scroll offset), so the strips travel with the matrix while it scrolls. */
    function moveCrosshair(e:any){
      if(isScrolling || !crossRowEl || !crossColEl) return;
      if(crossFrame) return;                       // at most one update per frame
      crossFrame = requestAnimationFrame(()=>{
        crossFrame = null;
        try{
          let cell = e.target && e.target.closest ? e.target.closest("td,th") : null;
          let container = crossRowEl.parentElement;
          if(!cell || !container){ hideCrosshair(); return; }
          let cr = container.getBoundingClientRect();
          let br = cell.getBoundingClientRect();
          let x = br.left - cr.left + container.scrollLeft;
          let y = br.top  - cr.top  + container.scrollTop;
          // Bound the strips to the TABLE, not the container: past the last
          // column or row there is nothing to point at, and a stripe running
          // on into the empty area just looks broken. The table does not
          // start at the container's origin (the sticky corner sits above
          // it), so both edges come from its own rectangle.
          let table:any = container.querySelector("table.cp-table");
          let tr = table ? table.getBoundingClientRect() : br;
          let tx = tr.left - cr.left + container.scrollLeft;
          let ty = tr.top  - cr.top  + container.scrollTop;
          crossRowEl.style.transform = "translate(" + tx + "px," + y + "px)";
          crossRowEl.style.height    = br.height + "px";
          crossRowEl.style.width     = tr.width + "px";
          crossColEl.style.transform = "translate(" + x + "px," + ty + "px)";
          crossColEl.style.width     = br.width + "px";
          crossColEl.style.height    = tr.height + "px";
          crossRowEl.style.opacity = "1";
          crossColEl.style.opacity = "1";
        }catch(err){ hideCrosshair(); }
      });
    }
    function hideCrosshair(){
      if(crossRowEl) crossRowEl.style.opacity = "0";
      if(crossColEl) crossColEl.style.opacity = "0";
    }

    // ----- The open group keeps its name at the edge -----
    // Scroll into a long node and its name leaves the screen — upwards on the
    // receiver axis, to the left on the sender axis — exactly when you need to
    // know whose flows you are looking at. Table `position:sticky` cannot do
    // this (a sticky cell is bounded by its row group, and all sender columns
    // live in ONE row), so the name rides on two overlay chips.
    //
    // What is at the edge is ASKED, not remembered: one hit test per axis per
    // frame. Pre-measuring group bounds meant carrying numbers that a fold-out
    // had already invalidated — the column chip then named the wrong group.
    let pinRowEl:any = null;
    let pinColEl:any = null;
    let pinRow2El:any = null;      // second level: the device inside the node
    let pinCol2El:any = null;
    let pinFrame:any = null;

    function updatePins(){
      if(!pinRowEl || !pinColEl || !pinRow2El || !pinCol2El) return;
      if(pinFrame) return;
      pinFrame = requestAnimationFrame(()=>{
        pinFrame = null;
        try{
          let container:any = pinRowEl.parentElement;
          let table:any = container ? container.querySelector("table.cp-table") : null;
          let corner:any = table ? table.querySelector("thead th.cp-corner") : null;
          if(!container || !corner){ return; }
          const cr = container.getBoundingClientRect();
          const co = corner.getBoundingClientRect();
          const st = container.scrollTop, sl = container.scrollLeft;
          // The vertical edge comes from the header (sticky at top:0), the
          // horizontal one from the label column (sticky at left:0). NOT from
          // the corner cell: it is only pinned vertically, so its right edge
          // travels with the scroll — which is why the column chip stayed
          // hidden however far you scrolled.
          let stickCell:any = table.querySelector("tbody td.cp-line-stick");
          const edgeX = stickCell ? stickCell.getBoundingClientRect().right : co.right;
          const labelW = edgeX - cr.left;

          // A chip takes over the moment its row / column STARTS to slide
          // under the edge, not once it has fully gone: waiting for that left a
          // stretch where the real name was half swallowed and the chip was not
          // there yet — the name appeared to dissolve.
          const rowH = stickCell ? stickCell.getBoundingClientRect().height : 28;

          // --- receiver rows ---
          // Walked over the group boxes with FRESH rectangles. A hit test at
          // the edge lands on the header's own layout layer instead of a row,
          // and remembered bounds go stale as soon as a node is folded out.
          let groupTb:any = null;
          for(const tb of Array.from(table.querySelectorAll("tbody")) as any[]){
            const r = tb.getBoundingClientRect();
            if(r.top <= co.bottom + 1 && r.bottom > co.bottom + 6){ groupTb = tb; }
          }
          let headRow:any = groupTb ? groupTb.querySelector("tr") : null;
          let head:any = headRow ? headRow.querySelector(".cp-label") : null;
          let rowLevel1 = false;
          if(groupTb && head && groupTb.rows.length > 1 &&
             headRow.getBoundingClientRect().top < co.bottom - 1){
            pinRowEl.textContent = (head.textContent || "").replace(/\s+/g, " ").trim();
            pinRowEl.style.transform = "translate(" + sl + "px," + (st + co.height) + "px)";
            pinRowEl.style.opacity = "1";
            rowLevel1 = true;
          }else{
            pinRowEl.style.opacity = "0";
          }
          // ... and the device inside it, one step below
          let devRow:any = null;
          if(rowLevel1 && groupTb){
            let devs:any[] = Array.from(groupTb.querySelectorAll("tr.cp-device:not(.cp-top)"));
            for(let i = 0; i < devs.length; i++){
              const top = devs[i].getBoundingClientRect().top;
              const nextTop = devs[i+1] ? devs[i+1].getBoundingClientRect().top : Infinity;
              const isOpen = devs[i].nextElementSibling && devs[i].nextElementSibling.classList.contains("cp-flow");
              if(isOpen && top < co.bottom - 1 && nextTop > co.bottom + rowH){ devRow = devs[i]; break; }
            }
          }
          let devLab:any = devRow ? devRow.querySelector(".cp-label") : null;
          if(devLab){
            pinRow2El.textContent = (devLab.textContent || "").replace(/\s+/g, " ").trim();
            pinRow2El.style.transform = "translate(" + sl + "px," + (st + co.height + rowH) + "px)";
            pinRow2El.style.opacity = "1";
          }else{
            pinRow2El.style.opacity = "0";
          }

          // --- sender columns: the same two levels, one axis over ---
          let groupTh:any = null;
          let tops:any[] = Array.from(table.querySelectorAll("thead th.cp-device.cp-top"));
          for(let i = 0; i < tops.length; i++){
            const left = tops[i].getBoundingClientRect().left;
            const nextLeft = tops[i+1] ? tops[i+1].getBoundingClientRect().left : Infinity;
            if(left <= edgeX + 1 && nextLeft > edgeX + 1){ groupTh = tops[i]; break; }
          }
          let labC:any = groupTh ? groupTh.querySelector(".cp-label") : null;
          let nextTh:any = groupTh ? groupTh.nextElementSibling : null;
          let groupHasMore = !!(nextTh && nextTh.classList && !nextTh.classList.contains("cp-top"));
          let colLevel1 = false;
          if(groupTh && labC && groupHasMore &&
             groupTh.getBoundingClientRect().left < edgeX - 1){
            pinColEl.textContent = (labC.textContent || "").replace(/\s+/g, " ").trim();
            pinColEl.style.transform = "translate(" + (sl + labelW) + "px," + st + "px)";
            pinColEl.style.opacity = "1";
            colLevel1 = true;
          }else{
            pinColEl.style.opacity = "0";
          }
          let devTh:any = null;
          if(colLevel1 && groupTh){
            let th:any = groupTh.nextElementSibling;
            let devs:any[] = [];
            while(th && !(th.classList && th.classList.contains("cp-top"))){
              if(th.classList && th.classList.contains("cp-device")){ devs.push(th); }
              th = th.nextElementSibling;
            }
            for(let i = 0; i < devs.length; i++){
              const left = devs[i].getBoundingClientRect().left;
              const nextLeft = devs[i+1] ? devs[i+1].getBoundingClientRect().left : Infinity;
              const isOpen = devs[i].nextElementSibling && devs[i].nextElementSibling.classList.contains("cp-flow");
              if(isOpen && left < edgeX - 1 && nextLeft > edgeX + rowH){ devTh = devs[i]; break; }
            }
          }
          let devLabC:any = devTh ? devTh.querySelector(".cp-label") : null;
          if(devLabC){
            pinCol2El.textContent = (devLabC.textContent || "").replace(/\s+/g, " ").trim();
            pinCol2El.style.transform = "translate(" + (sl + labelW + rowH) + "px," + st + "px)";
            pinCol2El.style.opacity = "1";
          }else{
            pinCol2El.style.opacity = "0";
          }
        }catch(e){}
      });
    }

    let scrollIdleTimer:any = null;
    afterUpdate(()=>{ updatePins(); });

    function onMatrixScroll(){
      isScrolling = true;
      updatePins();
      if(scrollIdleTimer){ clearTimeout(scrollIdleTimer); }
      scrollIdleTimer = setTimeout(()=>{ isScrolling = false; }, 150);
    }

    // One click folds every expanded sender column and receiver row back
    // to the device level — after exploring a large matrix that beats
    // clicking every chevron again.
    function collapseAll(){
      filter.expanded.senders = [];
      filter.expanded.receivers = [];
      filter.expandedNodes = { senders:[], receivers:[] };
      searchExpandedNodes = { senders:[], receivers:[] };
      searchExpandedSenders = [];
      searchExpandedReceivers = [];
      saveFilter();
      // doFilter, not refreshMatrix: folding the NODE level happens while
      // the axes are built, so the rows/columns have to be rebuilt. Device
      // expansion alone is read in the template and would repaint fine.
      doFilter();
    }

    function toggleExpandSender(id:string){
      let index = searchExpandedSenders.indexOf(id);
      if(index != -1){
        searchExpandedSenders.splice(index,1);
      }
      index = filter.expanded.senders.indexOf(id);
      if(index == -1){
        filter.expanded.senders.push(id);
      }else{
        filter.expanded.senders.splice(index,1);
      }
      
      saveFilter();
      refreshMatrix();
    }

    function toggleExpandReceiver(id:string){

      let index = searchExpandedReceivers.indexOf(id);
      if(index != -1){
        searchExpandedReceivers.splice(index,1);
      }
      index = filter.expanded.receivers.indexOf(id);
      if(index == -1){
        filter.expanded.receivers.push(id);
      }else{
        filter.expanded.receivers.splice(index,1);
      }
      saveFilter();
      refreshMatrix();

    }


    function saveFilter(){
      localStorage.setItem("nmos_crosspoint_filter", JSON.stringify(filter));
    }
  
    onDestroy(() => {
      // Guard each step: if the component dies before onMount assigned
      // `sync`, the throw used to skip unsync() — the server-side refCount
      // never dropped and the server kept streaming crosspoint patches for
      // a page nobody was watching.
      try{ sync.unsubscribe(); }catch(e){}
      try{ ServerConnector.unsync("crosspoint"); }catch(e){}
    });

 


    function receiverCapable(dest:any, src:any){
      if(dest.type == src.type){
        return true;
      }
      return false;
    }


    function connect (srcDev:any,src:any,dstDev:any, dst:any, force = false) {

        // A folded node stands for every device behind it — switching from
        // there could change a dozen connections on one stray click. Such a
        // cell drills in instead: it unfolds the node(s) it belongs to.
        if((srcDev && srcDev.isNode) || (dstDev && dstDev.isNode)){
          if(srcDev && srcDev.isNode){ toggleExpandNode("senders", srcDev.nodeKey); }
          if(dstDev && dstDev.isNode){ toggleExpandNode("receivers", dstDev.nodeKey); }
          return;
        }


        if(src && dst){
          // Aktiver Punkt → Toggle Disconnect
          if(dst.connectedFlow === src.id){
            let idx = preparedConnectList.findIndex(c => !c.src && c.dst?.id === dst.id);
            if(idx !== -1){ preparedConnectList.splice(idx, 1); preparedConnectList = preparedConnectList; }
            else{
              cleanPreparedConnections([{ srcDev: null, src: null, dstDev, dst }]);
              if(autoTake) takeConnect();
            }
            refreshMatrix(); updateGlobalTake(); return;
          }
          // Prepared Punkt → Toggle Unprepare
          let idx = preparedConnectList.findIndex(c => c.src?.id === src.id && c.dst?.id === dst.id);
          if(idx !== -1){ preparedConnectList.splice(idx, 1); preparedConnectList = preparedConnectList; }
          else{
            cleanPreparedConnections([{ srcDev, src, dstDev, dst }]);
            if(autoTake) takeConnect();
          }
          refreshMatrix(); updateGlobalTake();
        }else{
          let srcString = getDevcieNameString(srcDev,src);
          let dstString = getDevcieNameString(dstDev,dst);
      
          ServerConnector.post("makeconnection", {
            prepare:true,
            source:srcString,
            destination:dstString
          }).then((response:any)=>{
            let newList:any[] = []
            response.data.connections.forEach((c:any)=>{
              newList.push({ srcDev: c.src ? c.srcDev : null, src: c.src || null, dstDev: c.dstDev, dst: c.dst })
            })
            // Already switched? Then this click means OFF. The flow level has
            // had that toggle all along (see dst.connectedFlow above), the
            // device level never did: with Autotake the prepared entries are
            // gone the instant they are taken, so `allPrepared` was false on
            // the second click and it simply prepared the same connections
            // again. Nothing ever came apart again from a device cell.
            // connectedFlow is read from OUR state, not from the response: the
            // response describes what a connect WOULD do.
            let allActive = newList.length > 0 && newList.every((n:any)=>{
              if(!n.src || !n.dst) return false;
              let live = findReceiverFlowById(n.dst.id);
              return !!live && live.connectedFlow === n.src.id;
            });
            if(allActive){
              cleanPreparedConnections(newList.map((n:any)=>({ srcDev: null, src: null, dstDev: n.dstDev, dst: n.dst })));
              if(autoTake) takeConnect();
              refreshMatrix(); updateGlobalTake();
              return;
            }
            let allPrepared = newList.length > 0 && newList.every(n =>
              preparedConnectList.some((c:any) => c.src?.id === n.src?.id && c.dst?.id === n.dst?.id)
            );
            if(allPrepared){
              preparedConnectList = preparedConnectList.filter((c:any) =>
                !newList.some(n => c.src?.id === n.src?.id && c.dst?.id === n.dst?.id)
              );
            }else{
              cleanPreparedConnections(newList);
              if(autoTake) takeConnect();
            }
            refreshMatrix(); updateGlobalTake();
          }).catch((e)=>{
            // TODO, error handling
            ServerConnector.addFeedback({
              message:"Can not connect: "+e.message,
              level:"error"
            })
            console.log(e)
          })
        }
    }


    export function takeConnect(){
      doConnect(preparedConnectList);
      workingConnectList = preparedConnectList;
      preparedConnectList = [];
      refreshMatrix();
      updateGlobalTake();
    }




    let preparedModal:any;
    export function openPreparedConnectModal(){
      preparedModal.showModal();
    }

    export function clearConnect( dstId : string = ""){
      if(dstId == ""){
        preparedConnectList = [];
        refreshMatrix();
      }else{
        preparedConnectList = preparedConnectList.filter((c)=>{
          if(dstId == c.dst.id){
            return false
          }else{
            return true
          }
        });
        refreshMatrix();
      }
      updateGlobalTake();
    }

    function cleanPreparedConnections(newList:any[]){
      preparedConnectList = preparedConnectList.filter((c)=>{
        for(let n of newList){
          if(n.dst.id == c.dst.id){
            return false;
          }else{

          }
        }
        return true;

      })
      newList.forEach((n:any)=>{
        // Freeze the wire strings NOW. The flow objects reference the live
        // sync state and incoming jsonpatch bursts rewrite their fields in
        // place (same failure class as the forget-all bug) — with AutoTake
        // off, TAKE can happen many patches later and must switch what the
        // operator prepared, not whatever the objects mutated into.
        n.srcString = getDevcieNameString(n.srcDev, n.src);
        n.dstString = getDevcieNameString(n.dstDev, n.dst);
        preparedConnectList.push(n);
      })

      updateGlobalTake();
    }

    let previewTimer:any = null;
    
    function getDeviceConnectionPreview(srcDev:any,src:any,dstDev:any, dst:any){
      // No preview across a folded node: the preview asks the server which
      // flows a click would connect, and a node cell doesn't connect.
      if((srcDev && srcDev.isNode) || (dstDev && dstDev.isNode)){ return; }
      // Cancel the pending preview first — moving the pointer quickly across
      // the matrix used to leave orphan timers that later fired a full
      // repaint for a cell the pointer had long left.
      if(previewTimer){ clearTimeout(previewTimer); }
      previewTimer = setTimeout(()=>{
        previewTimer = null;
        previewConnect(srcDev,src,dstDev,dst);
      },200)

    }
    function clearDeviceConnectionPreview(){
      if(previewTimer){
        clearTimeout(previewTimer);
        previewTimer = null;
        previewConnectList = []
        
      }else{
        if(previewConnectList.length > 0){
          previewConnectList = []
          refreshMatrix();
        }else{
          previewConnectList = []
        }
      }
      updateGlobalTake();
    }

    /** The receiver flow as WE currently know it — the connect response only
     *  says what a switch would produce, not what is switched right now. */
    function findReceiverFlowById(id:string):any{
      for(const d of receivers){
        for(const t of flowTypes){
          for(const f of (d.receivers[t] || [])){ if(f.id === id) return f; }
        }
      }
      return null;
    }

    function getDevcieNameString(dev:any,flow:any){
      let ret = "";

      if(dev){
        ret+=dev.num
        if(flow){
          ret+= "."+renderFlowTypeShort(flow.type) + "" +flow.num
        }
      }
      return ret;
    }

    function previewConnect(srcDev:any,src:any,dstDev:any, dst:any) {
      let srcString = getDevcieNameString(srcDev,src);
      let dstString = getDevcieNameString(dstDev,dst);

      let next = computePreviewConnections(srcString, dstString);
      // Same preview as before (hovering along the same row/column) — skip
      // the full matrix repaint entirely. Element-wise compare instead of
      // two JSON.stringify calls on the hottest interaction path.
      let same = next.length === previewConnectList.length;
      if(same){
        for(let i = 0; i < next.length; i++){
          if(next[i].src !== previewConnectList[i].src || next[i].dst !== previewConnectList[i].dst){ same = false; break; }
        }
      }
      if(same){ return; }
      previewConnectList = next;
      refreshMatrix();
      updateGlobalTake();
    }

    /**
     * Local port of CrosspointAbstraction.makeConnection's preview branch:
     * same source/destination string parsing, same type matching, same
     * usedSources / lowest-num preference. The hover preview must predict
     * exactly what TAKE (which runs the server version) will do, so any
     * change to the matcher has to land in BOTH places.
     */
    function computePreviewConnections(source:string, destination:string):any[]{
      let out:any[] = [];
      let devices:any[] = (sourceState && Array.isArray(sourceState.devices)) ? sourceState.devices : [];
      let disconnect = (source == "" || source == "__disconnect");

      const parseSel = (sel:string)=>{
        let parts = sel.split(".");
        let deviceNum = parts[0];
        let deviceOnly = true, flowType = "", flowNum:any = null;
        if(parts.length == 2){
          deviceOnly = false;
          flowNum = parts[1].slice(1);
          switch(parts[1][0]){
            case "v": flowType = "video"; break;
            case "a": flowType = "audio"; break;
            case "d": flowType = "data"; break;
            default:  flowType = "unknown";
          }
        }
        return { deviceNum, deviceOnly, flowType, flowNum };
      };

      let s = parseSel(source);
      let d = parseSel(destination);

      let srcFlows:any[] = [];
      for(let dev of devices){
        if(dev.num == s.deviceNum){
          for(let type in dev.senders){
            if(type == s.flowType || s.deviceOnly){
              for(let flow of dev.senders[type]){
                if(flow.num == s.flowNum || s.deviceOnly){ srcFlows.push(flow); }
              }
            }
          }
        }
      }

      let dstFlows:any[] = [];
      for(let dev of devices){
        if(dev.num == d.deviceNum){
          for(let type in dev.receivers){
            if(type == d.flowType || d.deviceOnly){
              for(let flow of dev.receivers[type]){
                if(flow.num == d.flowNum || d.deviceOnly){ dstFlows.push(flow); }
              }
            }
          }
        }
      }

      if((srcFlows.length > 0 || disconnect) && dstFlows.length > 0){
        let usedSources:any[] = [];
        for(let dstFlow of dstFlows){
          let picked:any = null;
          if(!disconnect){
            for(let srcFlow of srcFlows){
              let connect = false;
              if(dstFlow.type == "audio" && srcFlow.type == "audio"){ connect = true; }
              else if(dstFlow.type == "video" && srcFlow.type == "video"){ connect = true; }
              else if(dstFlow.type == "data"){ if(srcFlow.type == "data"){ connect = true; } }
              else if(dstFlow.type == srcFlow.type){ connect = true; }

              if(connect && !usedSources.includes(srcFlow.id)){
                if(picked == null){
                  picked = srcFlow;
                  usedSources.push(srcFlow.id);
                }else if(picked.num > srcFlow.num){
                  // Server behaviour: the earlier pick's id stays in
                  // usedSources and the replacement's id is not added.
                  picked = srcFlow;
                }
              }
            }
          }
          out.push({ src: picked ? picked.id : null, dst: dstFlow.id });
        }
      }
      return out;
    }

    
    function doConnect(list:any[]) {
      let reducedList:any[] = [];
      list.forEach((l)=>{
        // Prefer the strings frozen at prepare time (see
        // cleanPreparedConnections); recompute only as a fallback.
        reducedList.push({
          source: (l.srcString !== undefined) ? l.srcString : getDevcieNameString(l.srcDev,l.src),
          destination: (l.dstString !== undefined) ? l.dstString : getDevcieNameString(l.dstDev,l.dst)
        })
      });
      
      // TODO Activating....
      ServerConnector.post("makeconnection", {multiple:reducedList,preview:false}).then((response:any)=>{
        showConnectResponse(response.data);
        workingConnectList = [];
        refreshMatrix();
      }).catch((e)=>{
        workingConnectList = [];
        refreshMatrix();
      });
      // TODO error
    }

    let preparedConnectList :any[] = [];
    let previewConnectList:any[] = [];
    let workingConnectList:any[] = [];

    function updateGlobalTake(){
      dispatch("updateGlobalTake",{prepared:preparedConnectList, preview:previewConnectList});
    }

    function renderFlowTypeShort(type:string){
      switch(type){
          case "video":
            return "v";
            break;
          case "audio":
            return "a";
            break;
          case "data":
            return "d";
            break;
          default:
            return "u";
        }
    }
    
    function getDisconnectClass(dev:any,flow:any){
      for(let c of preparedConnectList){
        if(!c.src && c.dst){
            if( flow.id == c.dst?.id ){ return "prepareddisconnect" }
        }
      }
      for(let c of workingConnectList){
        if(!c.src && c.dst){
            if( flow.id == c.dst?.id ){ return "workingdisconnect" }
        }
      }
      for(let c of previewConnectList){
        if(!c.src && c.dst){
            if( flow.id == c.dst?.id ){ return "previewdisconnect" }
        }
      }
      return false
    }

    // Is a disconnect staged for this receiver flow? Clicking an ACTIVE
    // point with AutoTake off queues a {src:null, dst} entry — the wire
    // stays up until TAKE, so the cell keeps its active look but gets a
    // dashed orange ring in the matrix.
    function disconnectStageFor(dstFlowId:string): ""|"prepared"|"working"{
      for(let c of preparedConnectList){
        if(!c.src && c.dst && c.dst.id === dstFlowId){ return "prepared"; }
      }
      for(let c of workingConnectList){
        if(!c.src && c.dst && c.dst.id === dstFlowId){ return "working"; }
      }
      return "";
    }

    // ----- Sparse cell-class index -----
    // getConnectClass used to SCAN the staging lists and — for the
    // device-level aggregate dot — every sender×receiver pair PER CELL on
    // every render. With hundreds of senders that made each sync push,
    // each expand and each hover preview an O(cells × flows) full-matrix
    // pass. The index is rebuilt ONCE per data/staging change by walking
    // only the sparse facts (active connections + the short staging
    // lists); a cell render is then a single Map lookup.
    let cellClassFlow: Map<string,string> = new Map();
    let cellClassDevice: Map<string,string> = new Map();

    function rebuildCellIndex(){
      cellClassFlow = new Map();
      cellClassDevice = new Map();

      // flowId → {flow, dev} for both directions.
      const senderByFlowId: Map<string,{flow:any,dev:any}> = new Map();
      for(const d of senders){
        for(const t of flowTypes){ for(const f of (d.senders[t] || [])){ senderByFlowId.set(f.id, {flow:f, dev:d}); } }
      }
      const receiverByFlowId: Map<string,{flow:any,dev:any}> = new Map();
      for(const d of receivers){
        for(const t of flowTypes){ for(const f of (d.receivers[t] || [])){ receiverByFlowId.set(f.id, {flow:f, dev:d}); } }
      }

      // Staged disconnects by receiver flow id.
      const discPrepared = new Set<string>();
      const discWorking = new Set<string>();
      for(const c of preparedConnectList){ if(!c.src && c.dst){ discPrepared.add(c.dst.id); } }
      for(const c of workingConnectList){ if(!c.src && c.dst){ discWorking.add(c.dst.id); } }

      // Device-level aggregation per (srcDev|dstDev): dashed only when
      // EVERY active connection between the two devices is staged for
      // disconnect; health = solid fill in the WORST status of any
      // connection between the two devices (red beats orange beats green).
      const devAgg: Map<string,{anyUnstaged:boolean,sawPrepared:boolean,sawWorking:boolean,healths:number[],sawUnmon:boolean}> = new Map();

      // 1) ACTIVE connections — walk the receivers once.
      for(const [rid, rE] of receiverByFlowId){
        const cf = rE.flow.connectedFlow;
        if(!cf) continue;
        const sE = senderByFlowId.get(cf);
        if(!sE) continue;   // connected sender filtered out of the matrix
        const h = Math.max(flowHealth(sE.flow), flowHealth(rE.flow));
        // Nobody is watching this one: sender, receiver or both offer no
        // BCP-008 monitor. Light blue then — it is not a fault, it is a blind
        // spot, and a real fault still outranks it.
        const unmon = bcp008On && (!sE.flow.monitor || !rE.flow.monitor);
        let cls = "active";
        if(discPrepared.has(rid)){ cls += " cp-disc-prepared"; }
        else if(discWorking.has(rid)){ cls += " cp-disc-working"; }
        if(h === 3){ cls += " cp-health-err"; }
        else if(h === 2){ cls += " cp-health-warn"; }
        else if(unmon){ cls += " cp-health-none"; }
        cellClassFlow.set(cf + "|" + rid, cls);

        const k = sE.dev.id + "|" + rE.dev.id;
        let a = devAgg.get(k);
        if(!a){ a = {anyUnstaged:false, sawPrepared:false, sawWorking:false, healths:[], sawUnmon:false}; devAgg.set(k, a); }
        a.healths.push(h);
        if(unmon){ a.sawUnmon = true; }
        if(discPrepared.has(rid)){ a.sawPrepared = true; }
        else if(discWorking.has(rid)){ a.sawWorking = true; }
        else { a.anyUnstaged = true; }
      }
      for(const [k, a] of devAgg){
        let cls = "active";
        if(!a.anyUnstaged && (a.sawPrepared || a.sawWorking)){
          cls += a.sawPrepared ? " cp-disc-prepared" : " cp-disc-working";
        }
        // Worst status wins and FILLS the dot: one unhealthy connection
        // among many healthy ones must be as loud as a uniformly bad pair.
        // (This used to render a thin 2px ring for mixed states — easy to
        // miss on the small collapsed-device dot.)
        const worst = a.healths.length ? Math.max(...a.healths) : 0;
        if(worst >= 2){ cls += (worst === 3 ? " cp-health-err" : " cp-health-warn"); }
        else if(a.sawUnmon){ cls += " cp-health-none"; }
        cellClassDevice.set(k, cls);
      }

      // 2..4) Staging overlays in ASCENDING priority (each overwrites the
      // previous): preview beats active, working beats preview, prepared
      // beats everything — same order the old scan checked them in.
      for(const c of previewConnectList){
        if(c.src && c.dst){ cellClassFlow.set(c.src + "|" + c.dst, "preview"); }
      }
      for(const c of workingConnectList){
        if(c.src && c.dst){
          cellClassFlow.set(c.src.id + "|" + c.dst.id, "working");
          const sE = senderByFlowId.get(c.src.id), rE = receiverByFlowId.get(c.dst.id);
          if(sE && rE){ cellClassDevice.set(sE.dev.id + "|" + rE.dev.id, "working"); }
        }
      }
      for(const c of preparedConnectList){
        if(c.src && c.dst){
          cellClassFlow.set(c.src.id + "|" + c.dst.id, "prepared");
          const sE = senderByFlowId.get(c.src.id), rE = receiverByFlowId.get(c.dst.id);
          if(sE && rE){ cellClassDevice.set(sE.dev.id + "|" + rE.dev.id, "prepared"); }
        }
      }
    }

    function getConnectClass(srcDev:any,src:any,dstDev:any, dst:any){
      if(src && dst){ return cellClassFlow.get(src.id + "|" + dst.id) || ""; }
      if(!src && !dst){ return cellClassDevice.get(srcDev.id + "|" + dstDev.id) || ""; }
      return "";
    }

    function gotoLog(log:string){
      log = log.slice(5);
      let params = new URLSearchParams({filterIds: log});
      document.location.href = "/logging?" + params.toString();
    }

    
    function showConnectResponse(data:any){
      let result:any = {success:0, disconnect:0, failed:0, reasons:[], log:"ids"}
      data.connections.forEach((c:any)=>{
        if(c.status == "ok"){
          result.success ++;
        }else if(c.status == "ok_dis"){
          result.disconnect ++;
        }else{
          result.failed ++;

          if(!result.reasons.includes(c.detail.message)){
            result.reasons.push(c.detail.message);
          }

          if(c.detail.log != ""){
            result.log += "||" + c.detail.log
          }

        }
        
      })
      let feedback:any ={ level:"neutral",
        time:7000,
        message:"Connection Feedback",
        data:{
          type:"connection",
          result:result
        }
      }
      if(result.failed > 0 ){

        feedback.time = 15000
      }
      if(result.failed > 0 && result.success == 0){

        feedback.time = 15000
      }
      if(result.log != "ids"){
        feedback["click"] = ()=>{gotoLog(result.log);}
      }
      ServerConnector.addFeedback(feedback)
    }

    function activate(dev:any, flow:any, active:boolean){
      ServerConnector.post((active?"disableFlow":"enableFlow"), {
        id:flow.id,
      }).finally(()=>{})
    }

    function toggleHidden(id:string){
      ServerConnector.post("togglehidden", {
        id:id
      }).finally(()=>{})
    }

    // Receiver hover detail: the backend condenses the BCP-004-01
    // constraint sets into a short string (capLimits). Empty = the device
    // publishes no capability information.
    function shortCaps(caps:any){
      return (typeof caps === "string" && caps.length > 0) ? caps : "Limits: Unknown";
    }

    // Feature toggle from the crosspoint state: when BCP-008 monitoring is
    // switched off in Setup, the status hearts disappear entirely (instead
    // of showing grey "unsupported" symbols everywhere).
    $: bcp008On = !sourceState || sourceState.bcp008Enabled !== false;

    // BCP-008 status helpers. Colour always reflects the CURRENT state —
    // the transition counters are history and only shown as numbers.
    function monitorStateName(v:number){
      return v === 1 ? "Healthy" : v === 2 ? "Partially healthy" : v === 3 ? "Unhealthy" : "Inactive";
    }
    function monitorClassVal(v:number){
      return v === 1 ? "cp-status-ok" : v === 2 ? "cp-status-warn" : v === 3 ? "cp-status-err" : "cp-status-inactive";
    }
    function monitorClass(m:any){ return monitorClassVal(m.status); }

    /** BCP-008 state, carried by the COLOUR of the essence glyph (see the
     *  SCSS): green healthy, amber partially healthy, red unhealthy, plain
     *  black/white when the device offers no monitor at all — and grey
     *  whenever the flow is not running, whatever the monitor says.
     *  The shape keeps saying which essence it is; the separate heart is gone,
     *  it cost a slot in every flow row and every sender column.
     *  With BCP-008 switched off no class is set at all and the glyph falls
     *  back to the type colours. */
    function monitorRing(flow:any):string{
      if(!bcp008On) return "";
      if(!flow || !flow.monitor) return " cp-bcp-none";
      switch(flow.monitor.status){
        case 1:  return " cp-bcp-ok";
        case 2:  return " cp-bcp-warn";
        case 3:  return " cp-bcp-err";
        default: return " cp-bcp-none";
      }
    }
    /** The glyph carries the format AND the state now — the heart used to hold
     *  the state text. The full message and the counters stay in the modal
     *  behind the click. */
    function typeDetailState(flow:any):string{
      if(!bcp008On || !flow || !flow.monitor) return "";
      return monitorStateName(flow.monitor.status);
    }
    /** The device's own words for the current state, on the hover pill. Only
     *  while something IS wrong: a device keeps its overallStatusMessage until
     *  the next counter reset, so on a healthy flow it would describe a past
     *  problem. The full text and the history stay in the click modal. */
    function typeDetailMessage(flow:any):string{
      if(!bcp008On || !flow || !flow.monitor) return "";
      if(flow.monitor.status < 2) return "";
      return monitorMsg(flow.monitor.status, flow.monitor.message || "");
    }

    // BCP-008 problem level of a flow for the crosspoint cells: 0 = fine
    // (healthy, inactive or unmonitored), 2/3 = partially/unhealthy.
    function flowHealth(f:any):number{
      return (f && f.monitor && typeof f.monitor.status === "number" && f.monitor.status >= 2) ? f.monitor.status : 0;
    }

    // Tooltip on the status symbol: the CURRENT message only. The device
    // keeps overallStatusMessage until the next reset, so on a healthy flow
    // it would describe a PAST problem — show the plain state name instead.
    // History (message + counters) lives in the click modal.
    function monitorText(m:any){
      let t = (m.status >= 2 && m.message) ? m.message : monitorStateName(m.status);
      t += "\nClick for details";
      return t;
    }

    // A BCP-008 statusMessage / overallStatusMessage is retained by the device
    // until the next counter reset, so on a recovered status it describes a
    // PAST condition. Devices word that themselves ("Previously: no essence
    // …"), so we show the message verbatim — prefixing it here produced
    // "previous: Previously: …".
    function monitorMsg(status:number, message:string){
      return message || "";
    }

    // Status modal (click on the symbol): full breakdown + counter reset.
    let monitorModal:any;
    let monitorModalFlow:any = null;
    // Packet counters (lost/late resp. transmission errors) are IS-12
    // METHODS, not subscribable properties — fetched live on modal open.
    let monitorModalCounters:any = null;   // null = loading, [] = none
    // JSON snapshot of the monitor at open/refresh time — change detection
    // must not compare object references (the sync may patch in place).
    let monitorModalMonitorJson = "";
    function openMonitorModal(flow:any){
      monitorModalFlow = flow;
      monitorModalMonitorJson = JSON.stringify(flow.monitor);
      monitorModalCounters = null;
      monitorModal.showModal();
      ServerConnector.post("bcp008Counters", { id: flow.id }).then((r:any)=>{
        monitorModalCounters = (r && r.data && Array.isArray(r.data.groups)) ? r.data.groups : [];
      }).catch(()=>{ monitorModalCounters = []; });
    }
    function resetMonitorCounters(){
      if(!monitorModalFlow) return;
      ServerConnector.post("bcp008Reset", { id: monitorModalFlow.id }).then(()=>{
        monitorModal.close();
      }).catch((e:any)=>{
        ServerConnector.addFeedback({ message: "Counter reset failed: " + (e?.message || e), level: "error" });
      });
    }

    /**
     * The modal holds the flow object captured at click time, so without
     * this it kept showing that snapshot while the heart behind it updated.
     * Re-resolve the flow by id on every crosspoint sync push (no polling —
     * it rides the updates the page receives anyway). When the monitor
     * status actually changed, the packet counters are re-fetched once too:
     * a transition usually means those moved as well.
     */
    function refreshMonitorModalFlow(){
      if(!monitorModalFlow || !monitorModal || !monitorModal.open) return;
      let id = monitorModalFlow.id;
      try{
        for(let dev of (sourceState.devices || [])){
          for(let kind of ["senders", "receivers"]){
            for(let type of Object.keys(dev[kind] || {})){
              for(let f of (dev[kind][type] || [])){
                if(f && f.id === id){
                  let nowJson = JSON.stringify(f.monitor);
                  let changed = nowJson !== monitorModalMonitorJson;
                  monitorModalMonitorJson = nowJson;
                  monitorModalFlow = f;
                  if(changed){
                    ServerConnector.post("bcp008Counters", { id }).then((r:any)=>{
                      if(monitorModalFlow && monitorModalFlow.id === id){
                        monitorModalCounters = (r && r.data && Array.isArray(r.data.groups)) ? r.data.groups : [];
                      }
                    }).catch(()=>{});
                  }
                  return;
                }
              }
            }
          }
        }
      }catch(e){}
    }

    // The matrix pill is a quick glance, so the SDR/BT709 defaults are
    // dropped from video formats ("1920x1080i25 BT709 SDR YCbCr 8Bit" →
    // "1920x1080i25 YCbCr 8Bit"). Non-default colorimetry (BT2020, PQ,
    // HLG) stays visible on purpose; the Details page shows the full
    // string in its tooltip.
    function shortFormat(format:any){
      let f = "" + (format || "");
      f = f.replace(" BT709", "").replace(" SDR", "");
      return f.trim();
    }


    function editFlowLabel(flow:any){
      clearNodeField();
      openLabelEditor(flow.id, flow.name, flow.alias)
    }

    // A device row of a single-device node reads "<Node> - <Device>", so the
    // dialog offers BOTH names: the device alias and the node name itself
    // (the latter is stored per node id and shows up on every page).
    function editDevLabel(dev:any){
      labelModalNodeId    = dev.nodeId || "";
      labelModalNodeName  = dev.nodeLabelRaw || dev.nodeLabel || "";
      labelModalNodeOrig  = dev.nodeAlias || "";
      labelModalNodeValue = dev.nodeAlias || labelModalNodeName;
      openLabelEditor(dev.id, dev.name, dev.alias)
    }

    // Renaming a node strip renames the NMOS NODE, not a device: the server
    // keeps those aliases per node id ("node_<id>", state/nodeAliases.json)
    // and every page — Details included — picks the new name up from there.
    function editNodeLabel(dev:any){
      if(!dev || !dev.nodeId){ return; }
      clearNodeField();
      openLabelEditor("node_" + dev.nodeId, dev.nodeLabelRaw || dev.displayLabel, dev.nodeAlias || dev.nodeLabelRaw || dev.displayLabel);
    }
    function clearNodeField(){
      labelModalNodeId = "";
      labelModalNodeName = "";
      labelModalNodeValue = "";
      labelModalNodeOrig = "";
    }


    let labelModal:any;
      let labelModalInput:any;
      let labelModalId:string = "";
      let labelModalName:string = "";
      let labelModalAlias:string = "";
      let labelModalValue:string = "";
      let labelModalIsNode:boolean = false;
      // optional second field: the NMOS node behind the edited device
      let labelModalNodeId:string = "";
      let labelModalNodeName:string = "";
      let labelModalNodeValue:string = "";
      let labelModalNodeOrig:string = "";
      function openLabelEditor(id:string, name:string, alias:string){
        labelModalIsNode = id.startsWith("node_");
        labelModalId = id;
        labelModalName = name;
        labelModalAlias = alias;
        labelModalValue = alias;
        labelModal.showModal();
        labelModalInput.focus();
        setTimeout(()=>{
          labelModalInput.select();
        })
        
      }
      function changeLabelSend(){
        ServerConnector.post("changealias",{id:labelModalId, alias:labelModalValue})
        // second field, only when the device sits behind a known node and the
        // operator actually touched the node name
        if(labelModalNodeId){
          let v = (labelModalNodeValue || "").trim();
          if(v === labelModalNodeName){ v = ""; }        // back to the registry name = no alias
          if(v !== labelModalNodeOrig){
            ServerConnector.post("changealias",{id:"node_" + labelModalNodeId, alias:v})
          }
        }
        labelModal.close()
      }



    
  </script>
  <div class="content-container crosspoint">
    <ul class="menu bg-base-200 menu-horizontal rounded-box filter-nav">
      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.searchReceivers} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search Receivers" />
          <Icon src={MagnifyingGlass}></Icon>
        </label>
      </li> 

      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.searchSenders} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search Senders" />
          <Icon src={MagnifyingGlass}></Icon>
        </label>
      </li> 


      <li>
        <label class="label cursor-pointer gap-2">
          <span class="label-text">Show unavailable</span>
          <input on:input={()=>changeFilter()} bind:checked={filter.showUnavailable} type="checkbox" class="toggle toggle-info" />
        </label>
      </li>

      <li>
        <label class="label cursor-pointer gap-2">
          <span class="label-text">Show hidden</span>
          <input on:input={()=>changeFilter()} bind:checked={filter.showHidden} type="checkbox" class="toggle toggle-info" />
        </label>
      </li>

      <li>
        <button class="label gap-2" on:click={collapseAll}
                use:OverlayMenuService.tooltip data-tooltip="Fold every expanded sender and receiver back to the device level">
          <Icon src={ChevronDoubleUp} size="18"></Icon>
          <span class="label-text">Collapse all</span>
        </button>
      </li>
    </ul>


    <div class="cp-container" class:cp-scrolling={isScrolling} on:scroll={onMatrixScroll}
         on:mousemove={moveCrosshair} on:mouseleave={hideCrosshair}>
      <!-- Crosshair. Two strips laid over the matrix, positioned from the cell
           under the pointer — in a 40-column matrix that is what tells you
           which row belongs to which name. Deliberately NOT Svelte state:
           re-rendering the matrix on every mouse move is exactly what made
           hover expensive before. Two element styles, nothing else. -->
      <div class="cp-cross-row" bind:this={crossRowEl}></div>
      <div class="cp-cross-col" bind:this={crossColEl}></div>
      <!-- Name of the group currently at the top / left edge. Same reasoning
           as the crosshair: moved by style, never by state. -->
      <div class="cp-pin-row" bind:this={pinRowEl}></div>
      <div class="cp-pin-col" bind:this={pinColEl}></div>
      <div class="cp-pin-row2" bind:this={pinRow2El}></div>
      <div class="cp-pin-col2" bind:this={pinCol2El}></div>
      <div class="cp-limit-container">

      <!-- Axis legend in the (otherwise empty) sticky corner: senders run
           to the right along the header, receivers down the left edge. -->
      <div class="cp-header-cross">
        <span class="cp-axis cp-axis-senders">Senders <span class="cp-axis-arrow">→</span></span>
        <span class="cp-axis cp-axis-receivers">Receivers <span class="cp-axis-arrow">→</span></span>
      </div>
</div>
      <table class="cp-table">
        <thead>
                <tr>
                    <th class="cp-corner"></th>
                    {#each senderGroups as sg}
                    {@const inStrip = !!(sg.devices[0] && sg.devices[0].isNode)}
                    {#each sg.devices as dev}
                      <th class="cp-device" class:cp-grp={inStrip} class:cp-node-entry={dev.isNode} class:cp-node-open={dev.isNode && dev.isOpen} class:cp-top={dev.isNode || !inStrip}
                          class:expanded={dev.isNode ? dev.isOpen : isSenderExpanded(dev.id)}
                          on:click={()=>{ dev.isNode ? toggleExpandNode("senders", dev.nodeKey) : toggleExpandSender(dev.id); }}><!--
                        --><span class="cp-expand"><Icon src={ChevronRight}></Icon></span><!--
                        --><span class="cp-label {(dev.hidden?"hidden":"")}"><!--
                        -->{#if labelNodePart(dev, inStrip)}<span class="cp-node-name">{labelNodePart(dev, inStrip)}</span>{labelRestPart(dev, inStrip)}{:else}{deviceRowLabel(dev, inStrip)}{/if}<!--
                        -->{#if dev.monitorSummaryTx && dev.monitorSummaryTx.worst >= 2}<span class={"cp-mon " + (dev.monitorSummaryTx.worst === 3 ? "cp-mon-err" : "cp-mon-warn")}
                              use:OverlayMenuService.tooltip
                              data-tooltip={"BCP-008: " + dev.monitorSummaryTx.count + (dev.monitorSummaryTx.count === 1 ? " sender " : " senders ") + (dev.monitorSummaryTx.worst === 3 ? "unhealthy" : "partially healthy")}>{dev.monitorSummaryTx.count}</span>{/if}<!--
                        --><span class="cp-edit">
                          {#if dev.isNode}
                            {#if dev.nodeId}<span on:click={(e)=>{e.stopPropagation(); editNodeLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="rename node"><Icon src={Pencil}></Icon></span>{/if}
                          {:else}
                            <span on:click={(e)=>{e.stopPropagation(); editDevLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                            <span on:click={(e)=>{e.stopPropagation(); toggleHidden(dev.id);}} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(dev.hidden ? Eye : EyeSlash)}></Icon></span>
                          {/if}
                        </span></span><!--
                        --><span class="cp-type-spacer"></span><!--
                      --></th>
                      {#if isSenderExpanded(dev.id)}
                        {#each flowTypes as type}
                          {#each dev.senders[type] as flow}
                            <th class="cp-flow" class:cp-grp={inStrip}><!--
                              --><span class="cp-expand"></span><!--
                              --><span class="cp-label {(flow.hidden?"hidden":"")}">{flow.alias}<!--
                                --><span class="cp-edit">
                                  <span on:click={()=>editFlowLabel(flow)} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                                  <span on:click={()=>toggleHidden(flow.id)} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(flow.hidden ? Eye : EyeSlash)}></Icon></span>
                                  <span on:click={()=>activate(dev,flow, flow.active)} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip data-tooltip="toggle activate"><Icon src={Link}></Icon></span>
                                </span><!--
                                --></span><!--
                              --><span class={"cp-type cp-type-"+flow.type + " " + (flow.active ? "active" : "") + monitorRing(flow)}
                                    on:click|stopPropagation={()=>{ if(bcp008On && flow.monitor){ openMonitorModal(flow); } }}><Icon src={getFlowTypeIcon(flow.type)}></Icon>{#if bcp008On && flow.monitor && (flow.monitor.counter || 0) > 0}<span class="cp-status-count">{flow.monitor.counter}</span>{/if}<!--
                                --><span class="cp-detail"><span class="cp-detail-main">{flow.format ? shortFormat(flow.format) : (flow.available ? "Unknown format": "Unavailable")}</span>{#if typeDetailState(flow)}<span class="cp-detail-state">{typeDetailState(flow)}</span>{/if}{#if typeDetailMessage(flow)}<span class="cp-detail-msg">{typeDetailMessage(flow)}</span>{/if}</span><!--
                              --></span><!--
                              
                            --></th>
                          {/each}
                        {/each}
                      {/if}
                    {/each}
                    {/each}
                </tr>
            </thead>
            <!-- One tbody PER GROUP: a sticky <td> is constrained by its row
                 group, not by its row. In a single tbody every node label
                 could float to the same offset and they stacked on top of each
                 other; per group each name sticks exactly as long as its own
                 group is on screen, and the next group pushes it out. -->
              {#each receiverGroups as rg}
              {@const inStrip = !!(rg.devices[0] && rg.devices[0].isNode)}
              <tbody>
              {#each rg.devices as dev, devIdx}
                <tr class="cp-device" class:cp-grp={inStrip} class:cp-node-row={dev.isNode} class:cp-top={dev.isNode || !inStrip} class:expanded={dev.isNode ? dev.isOpen : isReceiverExpanded(dev.id)}>
                  <td class="cp-line-stick" class:cp-node-entry={dev.isNode} class:cp-node-open={dev.isNode && dev.isOpen}
                      on:click={()=>{ dev.isNode ? toggleExpandNode("receivers", dev.nodeKey) : toggleExpandReceiver(dev.id); }}><!--
                    --><span class="cp-expand"><Icon src={ChevronRight}></Icon></span><!--
                    --><span class="cp-label {(dev.hidden?"hidden":"")}"><!--
                    -->{#if labelNodePart(dev, inStrip)}<span class="cp-node-name">{labelNodePart(dev, inStrip)}</span>{labelRestPart(dev, inStrip)}{:else}{deviceRowLabel(dev, inStrip)}{/if}<!--
                    --><!--
                        --><span class="cp-edit">
                          {#if dev.isNode}
                            {#if dev.nodeId}<span on:click={(e)=>{e.stopPropagation(); editNodeLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="rename node"><Icon src={Pencil}></Icon></span>{/if}
                          {:else}
                            <span on:click={(e)=>{e.stopPropagation(); editDevLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip  data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                            <span on:click={(e)=>{e.stopPropagation(); toggleHidden(dev.id);}} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(dev.hidden ? Eye : EyeSlash)}></Icon></span>
                            <span on:click={(e)=>{e.stopPropagation(); connect(null, null, dev,null);}} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip data-tooltip="disconnect"><Icon src={Link}></Icon></span>
                          {/if}
                        </span><!--
                    --></span><!--
                    -->{#if dev.monitorSummaryRx && dev.monitorSummaryRx.worst >= 2}<span class={"cp-mon " + (dev.monitorSummaryRx.worst === 3 ? "cp-mon-err" : "cp-mon-warn")}
                          use:OverlayMenuService.tooltip
                          data-tooltip={"BCP-008: " + dev.monitorSummaryRx.count + (dev.monitorSummaryRx.count === 1 ? " receiver " : " receivers ") + (dev.monitorSummaryRx.worst === 3 ? "unhealthy" : "partially healthy")}>{dev.monitorSummaryRx.count}</span>{/if}<!--
                  --></td>

                  {#each senders as sourceDev}
                      <td class="cp-connect-device" class:cp-connect-expand={!!(sourceDev.isNode || dev.isNode)}><div><span class="{ getConnectClass(sourceDev, null, dev, null)}"
                                  on:click={()=>connect( sourceDev, null, dev, null)}
                                  on:mouseover={()=>getDeviceConnectionPreview(sourceDev, null, dev, null)} 
                                  on:mouseleave={()=>clearDeviceConnectionPreview()} ></span></div></td>
                      {#if isSenderExpanded(sourceDev.id)}
                        {#each flowTypes as type}
                          {#if type !== "audiochannel" }
                            {#each sourceDev.senders[type] as sourceFlow}
                              <td class="cp-connect-device" class:cp-connect-expand={!!(dev.isNode)}><div><span 
                                    on:click={()=>connect( sourceDev, sourceFlow, dev, null)}
                                    on:mouseover={()=>getDeviceConnectionPreview(sourceDev, sourceFlow, dev, null)}
                                    on:mouseleave={()=>clearDeviceConnectionPreview()}></span></div></td>
                            {/each}
                          {/if}
                        {/each}
                      {/if}
                    {/each}


                </tr>
                {#if isReceiverExpanded(dev.id)}

                {#each flowTypes as type}
                  {#each dev.receivers[type] as flow}
                    <tr class="cp-flow" class:cp-grp={inStrip}>
                      <td class="cp-line-stick">
                        <span class="cp-expand"></span><!--
                        --><span class="cp-label {(flow.hidden?"hidden":"")}">{flow.alias}<!--
                        --><span class="cp-edit">
                          <span on:click={()=>editFlowLabel(flow)} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip  data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                          <span on:click={()=>toggleHidden(flow.id)} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip  data-tooltip="toggle hidden"><Icon src={(flow.hidden ? Eye : EyeSlash)}></Icon></span>
                          <span on:click={()=>connect(null, null, dev,flow)} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip  data-tooltip="disconnect"><Icon src={Link}></Icon></span>
                        </span><!--
                        --></span><!--
                        --><span class={"cp-type cp-type-"+flow.type + " " + getDisconnectClass(dev,flow) + " " + (flow.active ? "active" : "") + monitorRing(flow)}
                              on:click|stopPropagation={()=>{ if(bcp008On && flow.monitor){ openMonitorModal(flow); } }}><Icon src={getFlowTypeIcon(flow.type, false)}></Icon>{#if bcp008On && flow.monitor && (flow.monitor.counter || 0) > 0}<span class="cp-status-count">{flow.monitor.counter}</span>{/if}<!--
                          --><span class="cp-detail"><span class="cp-detail-main">{shortCaps(flow.capLimits)}</span>{#if typeDetailState(flow)}<span class="cp-detail-state">{typeDetailState(flow)}</span>{/if}{#if typeDetailMessage(flow)}<span class="cp-detail-msg">{typeDetailMessage(flow)}</span>{/if}</span><!--
                        --></span><!--
                      --></td>



                      {#each senders as sourceDev}
                      <td class="cp-connect-device" class:cp-connect-expand={!!(sourceDev.isNode)}><div><span 
                              on:click={()=>connect( sourceDev, null, dev, flow) } 
                              on:mouseover={()=>getDeviceConnectionPreview(sourceDev, null, dev, flow) } 
                              on:mouseleave={()=>clearDeviceConnectionPreview()} ></span></div></td>
                      {#if isSenderExpanded(sourceDev.id)}
                        {#each flowTypes as type}
                          {#if type !== "audiochannel" }
                            {#each sourceDev.senders[type] as sourceFlow}
                              {#if receiverCapable(flow, sourceFlow) }
                              <td class="cp-connect-flow"><div><span class="{ getConnectClass(sourceDev, sourceFlow, dev, flow)}" 
                                on:click={()=>connect( sourceDev, sourceFlow, dev, flow) }></span></div></td>
                              {:else}
                              <td class="cp-connect-mismatch"><div></div></td>
                              {/if}
                            {/each}
                          {/if}
                        {/each}
                      {/if}
                    {/each}




                    </tr>
                  {/each}
                {/each}
                {/if}
              {/each}
              </tbody>
              {/each}
    </table>
    
    </div>

    </div>


    <dialog bind:this={labelModal} class="modal">
      <div class="modal-box">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
        </form>
        <h3 class="font-bold text-lg">{labelModalIsNode ? "Rename Node" : "Change Alias"}</h3>
        <span>{labelModalIsNode ? "Node Name" : "Source Name"}: {labelModalName}</span><br/>
        <span>Alias: {labelModalAlias}</span>
          <input on:keypress={(e)=>{if(e.keyCode == 13) changeLabelSend()}} bind:this={labelModalInput} bind:value={labelModalValue} type="text" placeholder="Type here" class="input input-bordered w-full max-w-xs" />
        {#if labelModalNodeId}
          <br/><span>Node Name: {labelModalNodeName}</span>
          <input on:keypress={(e)=>{if(e.keyCode == 13) changeLabelSend()}} bind:value={labelModalNodeValue} type="text" placeholder="Type here" class="input input-bordered w-full max-w-xs" />
        {/if}
        <div class="modal-action">
          <form method="dialog">
            <!-- if there is a button in form, it will close the modal -->
            <button on:click={()=>{labelModalValue = ""; changeLabelSend()}} class="btn" >Remove</button>
            <button on:click={()=>{changeLabelSend()}} class="btn" >Save</button>
            <button class="btn">Close</button>
          </form>
        </div>
      </div>
    </dialog>

    <dialog bind:this={monitorModal} class="modal">
      <div class="modal-box">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
        </form>
        {#if monitorModalFlow && monitorModalFlow.monitor}
          {@const m = monitorModalFlow.monitor}
          <h3 class="font-bold text-lg cp-monitor-title">Status – {monitorModalFlow.alias || monitorModalFlow.name || monitorModalFlow.id}
            <span class={"cp-monitor-state " + monitorClassVal(m.status)}>{monitorStateName(m.status)}</span></h3>
          <div class="cp-monitor-counter">Overall counter: {m.counter || 0}</div>
          {#if m.message}<p class="cp-monitor-message">{monitorMsg(m.status, m.message)}</p>{/if}
          <table class="cp-monitor-table">
            <thead><tr><td>Domain</td><td>State</td><td>Message</td><td>Transitions</td></tr></thead>
            <tbody>
              {#each (m.domains || []) as d}
                <tr>
                  <td>{d.label}</td>
                  <td><span class={"cp-monitor-dot " + monitorClassVal(d.status)}
                        use:OverlayMenuService.tooltip data-tooltip={monitorStateName(d.status)}></span></td>
                  <td class="cp-monitor-domain-message">{monitorMsg(d.status, d.message)}</td>
                  <td>{d.counter}</td>
                </tr>
                <!-- BCP-008 4p10 belongs to the sync domain, so it sits right
                     under it: the clock the device says it is locked to. Only
                     shown when the device reports one. -->
                {#if d.label === "Sync" && m.syncSource}
                  <tr class="cp-monitor-subrow">
                    <td></td>
                    <td></td>
                    <td colspan="2" class="cp-monitor-sync">Source: <span class="cp-monitor-sync-id">{m.syncSource}</span></td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
          <div class="cp-monitor-packets">
            {#if monitorModalCounters === null}
              <span class="cp-monitor-packets-loading">Reading packet counters…</span>
            {:else}
              {#each monitorModalCounters as g}
                <div class="cp-monitor-packets-row">
                  <span class="cp-monitor-packets-label">{g.label}</span>
                  <span class="cp-monitor-packets-values">
                    {#if g.counters.length === 0}0{:else}{#each g.counters as c, i}{i > 0 ? " · " : ""}{c.name ? c.name + ": " : ""}{c.value}{/each}{/if}
                  </span>
                </div>
              {/each}
            {/if}
          </div>
        {:else}
          <h3 class="font-bold text-lg">Status</h3>
        {/if}
        <div class="modal-action">
          <button class="btn" on:click={resetMonitorCounters}>Reset counters &amp; messages</button>
        </div>
      </div>
    </dialog>

    <dialog bind:this={preparedModal} class="modal">
      <div class="modal-box" style="max-width:80%;">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
        </form>
        <h3 class="font-bold text-lg">Prepared Connections</h3>
        
        <table>

          <thead>
            <tr>
              <td>Destination</td>
              <td></td>

              <td></td>

              <td>Source</td>
              <td></td>

              <td></td>
            </tr>
          </thead>

          <tbody>
            {#each preparedConnectList as prep}
              <tr>
                <td>{prep.dstDev?.alias}</td>
                <td>{prep.dst?.alias}</td>
                <td style="padding:0px 10px">{"<"}</td>
                <td>{(prep.srcDev ? prep.srcDev.alias:"Disconnect")}</td>
                <td>{(prep.src ? prep.src.alias:"")}</td>

                <td>
                  <button on:click={()=>{ clearConnect(prep.dst.id) }} class="btn" >Clear</button>
                </td>
              </tr>
            {/each}
          </tbody>

        </table>

        <div class="modal-action">
          <form method="dialog">
            <!-- if there is a button in form, it will close the modal -->
            <button class="btn bg-red-600 text-white" on:click={()=>{takeConnect()}} >Take</button>
            <button on:click={()=>{clearConnect()}} class="btn" >Clear All</button>
            <button class="btn">Close</button>
          </form>
        </div>
      </div>
    </dialog>