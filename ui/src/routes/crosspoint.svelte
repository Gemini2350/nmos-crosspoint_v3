<script lang="ts">
    import type { Source } from "postcss";
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService"
      import type { Subject } from "rxjs";
      import { onDestroy, onMount } from "svelte";
      import { createEventDispatcher } from 'svelte';

      import { Icon, ChevronRight, VideoCamera, Microphone, CodeBracketSquare, MagnifyingGlass,  SpeakerWave, Tv,Pencil, Eye, EyeSlash, Link, InformationCircle } from "svelte-hero-icons";
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
    // Device-only name (no "<Node> - " prefix) — used when the device sits
    // inside a node band, where the node name is already shown in the band.
    function deviceDisplayLabelShort(dev:any){
      return dev?.displayLabelShort || deviceDisplayLabel(dev);
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
          g = { key, label: dev.nodeLabel || deviceDisplayLabel(dev), grouped:false, devices:[] };
          byKey[key] = g;
          groups.push(g);
        }
        if(dev.nodeLabel){ g.label = dev.nodeLabel; }
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

    // Number of matrix columns a sender device currently occupies — must
    // mirror the thead markup exactly (1 device column + one column per
    // flow while expanded).
    function senderDevCols(dev:any):number{
      let cols = 1;
      if(isSenderExpanded(dev.id)){
        flowTypes.forEach((t)=>{ cols += (dev.senders && Array.isArray(dev.senders[t])) ? dev.senders[t].length : 0; });
      }
      return cols;
    }
    function groupSenderCols(g:CpNodeGroup):number{
      let cols = 0;
      g.devices.forEach((d)=>{ cols += senderDevCols(d); });
      return cols;
    }
    // Only render the band header row (and shift the sticky header down)
    // when at least one node actually has multiple devices.
    $: hasSenderBands = senderGroups.some(g => g.grouped);
    // Same for the vertical node strip left of the receiver rows.
    $: hasReceiverBands = receiverGroups.some(g => g.grouped);

    // Row count of a receiver device (device row + one row per flow while
    // expanded) — the vertical node strip spans the whole group via rowspan,
    // so this must mirror the tbody markup exactly.
    function receiverDevRows(dev:any):number{
      let rows = 1;
      if(isReceiverExpanded(dev.id)){
        flowTypes.forEach((t)=>{ rows += (dev.receivers && Array.isArray(dev.receivers[t])) ? dev.receivers[t].length : 0; });
      }
      return rows;
    }
    function groupReceiverRows(g:CpNodeGroup):number{
      let rows = 0;
      g.devices.forEach((d)=>{ rows += receiverDevRows(d); });
      return rows;
    }

    // Force a matrix re-render. The template renders rows/columns from the
    // GROUP arrays and connect cells from the flat arrays — every state
    // change that must repaint cells (prepared / working / preview / active
    // / dashed disconnect markers) has to reassign ALL of them; reassigning
    // only `receivers` (the pre-grouping idiom) no longer reaches the rows.
    function refreshMatrix(){
      senders = [...senders];
      receivers = [...receivers];
      senderGroups = [...senderGroups];
      receiverGroups = [...receiverGroups];
    }

    // Single-device node whose band text would just repeat the device label
    // right next to it → leave the band empty (geometry stays uniform, no
    // duplicated name). Grouped nodes always show their label.
    function bandLabelVisible(g:CpNodeGroup):boolean{
      if(g.grouped){ return true; }
      let d = g.devices[0];
      return !!d && g.label.toLowerCase() !== deviceDisplayLabelShort(d).toLowerCase();
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
        senderGroups = groupDevicesByNode(senders);
        senders = flattenGroups(senderGroups);
        receiverGroups = groupDevicesByNode(receivers);
        receivers = flattenGroups(receiverGroups);
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
      sync.unsubscribe();
      ServerConnector.unsync("crosspoint");
    });

 


    function receiverCapable(dest:any, src:any){
      if(dest.type == src.type){
        return true;
      }
      return false;
    }


    function connect (srcDev:any,src:any,dstDev:any, dst:any, force = false) {
     


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
        preparedConnectList.push(n);
      })

      updateGlobalTake();
    }

    let previewTimer:any = null;
    
    function getDeviceConnectionPreview(srcDev:any,src:any,dstDev:any, dst:any){
      
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
      
      ServerConnector.post("makeconnection", {
        preview:true,
        source:srcString,
        destination:dstString
      }).then((response:any)=>{
        previewConnectList = [];
        response.data.connections.forEach((c:any)=>{
          previewConnectList.push({src:c.src, dst:c.dst})

        })
        refreshMatrix();
        updateGlobalTake();
      }).catch((e)=>{
        console.log(e)
      })
    }

    
    function doConnect(list:any[]) {
      let reducedList:any[] = [];
      list.forEach((l)=>{
        let srcString = getDevcieNameString(l.srcDev,l.src);
        let dstString = getDevcieNameString(l.dstDev,l.dst);
        reducedList.push({
          source:srcString,
          destination:dstString
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
    // dashed ring (violet = prepared, orange = working after TAKE).
    function disconnectStageFor(dstFlowId:string): ""|"prepared"|"working"{
      for(let c of preparedConnectList){
        if(!c.src && c.dst && c.dst.id === dstFlowId){ return "prepared"; }
      }
      for(let c of workingConnectList){
        if(!c.src && c.dst && c.dst.id === dstFlowId){ return "working"; }
      }
      return "";
    }

    function getConnectClass(srcDev:any,src:any,dstDev:any, dst:any){
      for(let c of preparedConnectList){
        if(c.src && c.dst){


          if(src && dst){
              if( src.id == c.src.id && dst.id == c.dst.id ){
                return "prepared"
              }
          }


          if(!src && !dst){
            for(let r of dstDev.receiverIds){
              for(let s of srcDev.senderIds){
                if(r == c.dst.id && s == c.src.id){
                  return "prepared"
                }
              }
            }
          }

           
        }
      }

      for(let c of workingConnectList){
        if(c.src && c.dst){


          if(src && dst){
              if( src.id == c.src.id && dst.id == c.dst.id ){
                return "working"
              }
          }


          if(!src && !dst){
            for(let r of dstDev.receiverIds){
              for(let s of srcDev.senderIds){
                if(r == c.dst.id && s == c.src.id){
                  return "working"
                }
              }
            }
          }

           
        }
      }

      for(let c of previewConnectList){
        if(src && dst && c.src && c.dst){
            if( src.id == c.src && dst.id == c.dst ){
              return "preview"
            }
        }
      }

      if(src && dst){
        if(src.id == dst.connectedFlow){
          let stage = disconnectStageFor(dst.id);
          if(stage === "prepared"){ return "active cp-disc-prepared"; }
          if(stage === "working"){ return "active cp-disc-working"; }
          return "active"
        }
      }else{
        // Device-level cell: dashed only when EVERY active connection
        // between the two devices is staged for disconnect — if some stay
        // up after TAKE, the aggregate dot keeps its solid active look.
        let anyActive = false;
        let anyUnstaged = false;
        let sawPrepared = false;
        let sawWorking = false;
        for(let type in srcDev.senders){
          for(let flow of srcDev.senders[type]){
            if(dstDev.connectedFlows.includes(flow.id)){
              anyActive = true;
              let matched = false;
              for(let rtype in dstDev.receivers){
                for(let r of dstDev.receivers[rtype] || []){
                  if(r.connectedFlow === flow.id){
                    matched = true;
                    let st = disconnectStageFor(r.id);
                    if(st === "prepared"){ sawPrepared = true; }
                    else if(st === "working"){ sawWorking = true; }
                    else { anyUnstaged = true; }
                  }
                }
              }
              if(!matched){ anyUnstaged = true; }
            }
          }
        }
        if(anyActive){
          if(!anyUnstaged && (sawPrepared || sawWorking)){
            return sawPrepared ? "active cp-disc-prepared" : "active cp-disc-working";
          }
          return "active"
        }
      }

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

    function shortCaps(caps:any){
      return "Limits: Unknown";
    }

    function shortFormat(format:any){
      return format;
    }


    function editFlowLabel(flow:any){
      openLabelEditor(flow.id, flow.name, flow.alias)
    }

    function editDevLabel(dev:any){
      openLabelEditor(dev.id, dev.name, dev.alias)
    }


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
        setTimeout(()=>{
          labelModalInput.select();
        })
        
      }
      function changeLabelSend(){
        ServerConnector.post("changealias",{id:labelModalId, alias:labelModalValue})
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
    </ul>


    <div class="cp-container" class:cp-has-node-bands={hasSenderBands} class:cp-has-node-vbands={hasReceiverBands}>
      <div class="cp-limit-container">

      <div class="cp-header-cross"></div>
</div>
      <table class="cp-table">
        <thead>
                {#if hasSenderBands}
                <tr class="cp-node-band-row">
                    {#if hasReceiverBands}<th class="cp-node-vcol"></th>{/if}
                    <th class="cp-node-band-corner"></th>
                    {#each senderGroups as sg}
                      <th class="cp-node-band" colspan={groupSenderCols(sg)}>
                        {#if bandLabelVisible(sg)}
                          <span class="cp-node-band-label" use:OverlayMenuService.tooltip data-tooltip="NMOS Node: {sg.label}">{sg.label}</span>
                        {/if}
                      </th>
                    {/each}
                </tr>
                {/if}
                <tr>
                    {#if hasReceiverBands}<th class="cp-node-vcol"></th>{/if}
                    <th class="cp-corner"></th>
                    {#each senderGroups as sg}
                    {#each sg.devices as dev}
                      <th class="cp-device" class:expanded={isSenderExpanded(dev.id)} on:click={()=>toggleExpandSender(dev.id)}><!--
                        --><span class="cp-expand"><Icon src={ChevronRight}></Icon></span><!--
                        --><span class="cp-label {(dev.hidden?"hidden":"")}">{hasSenderBands ? deviceDisplayLabelShort(dev) : deviceDisplayLabel(dev)}<!--
                        --><span class="cp-edit">
                          <span on:click={(e)=>{e.stopPropagation(); editDevLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                          <span on:click={(e)=>{e.stopPropagation(); toggleHidden(dev.id);}} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(dev.hidden ? Eye : EyeSlash)}></Icon></span>
                          
                        </span></span><!--
                        --><span class="cp-type-spacer"></span><!--
                      --></th>
                      {#if isSenderExpanded(dev.id)}
                        {#each flowTypes as type}
                          {#each dev.senders[type] as flow}
                            <th class="cp-flow"><!--
                              --><span class="cp-expand"></span><!--
                              --><span class="cp-label {(flow.hidden?"hidden":"")}">{flow.alias}<!--
                                --><span class="cp-edit">
                                  <span on:click={()=>editFlowLabel(flow)} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                                  <span on:click={()=>toggleHidden(flow.id)} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(flow.hidden ? Eye : EyeSlash)}></Icon></span>
                                  <span on:click={()=>activate(dev,flow, flow.active)} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip data-tooltip="toggle activate"><Icon src={Link}></Icon></span>
                                </span><!--
                                --></span><!--
                              --><span class={"cp-type cp-type-"+flow.type + " " + (flow.active ? "active" : "") }><Icon src={getFlowTypeIcon(flow.type)}></Icon><!--
                                --><span class="cp-detail">{flow.format ? shortFormat(flow.format) : (flow.available ? "Unknown format": "Unavailable")}</span><!--
                              --></span><!--
                              
                            --></th>
                          {/each}
                        {/each}
                      {/if}
                    {/each}
                    {/each}
                </tr>
            </thead>
            <tbody>
              {#each receiverGroups as rg}
              {#each rg.devices as dev, devIdx}
                <tr class="cp-device" class:expanded={isReceiverExpanded(dev.id)}>
                  {#if hasReceiverBands && devIdx === 0}
                    <!-- Every node group gets its vertical strip — including
                         single-device nodes, so the left edge looks uniform. -->
                    <td class="cp-node-vband" rowspan={groupReceiverRows(rg)}>
                      {#if bandLabelVisible(rg)}
                        <span class="cp-node-vband-label" use:OverlayMenuService.tooltip data-tooltip="NMOS Node: {rg.label}">{rg.label}</span>
                      {/if}
                    </td>
                  {/if}
                  <td class="cp-line-stick" on:click={()=>toggleExpandReceiver(dev.id)}><!--
                    --><span class="cp-expand"><Icon src={ChevronRight}></Icon></span><!--
                    --><span class="cp-label {(dev.hidden?"hidden":"")}">{hasReceiverBands ? deviceDisplayLabelShort(dev) : deviceDisplayLabel(dev)}<!--
                        --><span class="cp-edit">
                          <span on:click={(e)=>{e.stopPropagation(); editDevLabel(dev);}} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip  data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                          <span on:click={(e)=>{e.stopPropagation(); toggleHidden(dev.id);}} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip data-tooltip="toggle hidden"><Icon src={(dev.hidden ? Eye : EyeSlash)}></Icon></span>
                          <span on:click={(e)=>{e.stopPropagation(); connect(null, null, dev,null);}} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip data-tooltip="disconnect"><Icon src={Link}></Icon></span>
                        </span><!--
                    --></span><!--
                  --></td>

                  {#each senders as sourceDev}
                      <td class="cp-connect-device"><div><span class="{ getConnectClass(sourceDev, null, dev, null)}"
                                  on:click={()=>connect( sourceDev, null, dev, null)}
                                  on:mouseover={()=>getDeviceConnectionPreview(sourceDev, null, dev, null)} 
                                  on:mouseleave={()=>clearDeviceConnectionPreview()} ></span></div></td>
                      {#if isSenderExpanded(sourceDev.id)}
                        {#each flowTypes as type}
                          {#if type !== "audiochannel" }
                            {#each sourceDev.senders[type] as sourceFlow}
                              <td class="cp-connect-device"><div><span 
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
                    <tr class="cp-flow">
                      <td class="cp-line-stick">
                        <span class="cp-expand"></span><!--
                        --><span class="cp-label {(flow.hidden?"hidden":"")}">{flow.alias}<!--
                        --><span class="cp-edit">
                          <span on:click={()=>editFlowLabel(flow)} class="cp-button cp-button-edit" use:OverlayMenuService.tooltip  data-tooltip="change alias"><Icon src={Pencil}></Icon></span>
                          <span on:click={()=>toggleHidden(flow.id)} class="cp-button cp-button-visible" use:OverlayMenuService.tooltip  data-tooltip="toggle hidden"><Icon src={(flow.hidden ? Eye : EyeSlash)}></Icon></span>
                          <span on:click={()=>connect(null, null, dev,flow)} class="cp-button cp-button-disconnect" use:OverlayMenuService.tooltip  data-tooltip="disconnect"><Icon src={Link}></Icon></span>
                        </span><!--
                        --></span><!--
                        --><span class={"cp-type cp-type-"+flow.type + " " + getDisconnectClass(dev,flow) + " " + (flow.active ? "active" : "")}><Icon src={getFlowTypeIcon(flow.type, false)}></Icon><!--
                          --><span class="cp-detail">{shortCaps(flow.capLimits)}</span><!--
                        --></span><!--
                      --></td>



                      {#each senders as sourceDev}
                      <td class="cp-connect-device"><div><span 
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
              {/each}
            </tbody>
    </table>
    
    </div>

    </div>


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
            <!-- if there is a button in form, it will close the modal -->
            <button on:click={()=>{labelModalValue = ""; changeLabelSend()}} class="btn" >Remove</button>
            <button on:click={()=>{changeLabelSend()}} class="btn" >Save</button>
            <button class="btn">Close</button>
          </form>
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
            <button class="btn bg-violet-500 text-white" on:click={()=>{takeConnect()}} >Take</button>
            <button on:click={()=>{clearConnect()}} class="btn" >Clear All</button>
            <button class="btn">Close</button>
          </form>
        </div>
      </div>
    </dialog>