<script lang="ts">

  import { Router, Link, Route } from "svelte-routing";

  
  import { onDestroy, onMount } from 'svelte';

  import ServerConnector from "./lib/ServerConnector/ServerConnectorService";
  import OverlayMenuService from "./lib/OverlayMenu/OverlayMenuService";

  import { Icon, Squares2x2, ListBullet, WrenchScrewdriver, LockOpen, LockClosed  } from "svelte-hero-icons";


  import Crosspoint from './routes/crosspoint.svelte';
  import Details from './routes/details.svelte';
  import Setup from './routes/setup.svelte';
  import Logging from './routes/logging.svelte';

  import Debug from './routes/debug.svelte';
    import OverlayMenu from "./lib/OverlayMenu/OverlayMenu.svelte";
    import ServerConnectorOverlay from "./lib/ServerConnector/ServerConnectorOverlay.svelte";
    import type { Subject } from "rxjs";

    let menu = OverlayMenuService;

  let routes = [
        {label:"Crosspoint", icon:Squares2x2, link:"/crosspoint"},
        {label:"Details", icon:ListBullet, link:"/details"},

        {label:"Setup",  icon:WrenchScrewdriver, link:"/setup"},
    ];

    let current_url = "/";
    let update_url=()=>{
      setTimeout(()=>{
        current_url = window.location.pathname;
      },50);
    };
    function doGlobalTake(){
      if(crosspointComponent){
        crosspointComponent.takeConnect()
      }
    };

    function openGlobalTakeModal(){
      if(crosspointComponent){
        crosspointComponent.openPreparedConnectModal();
      }
    }

    function updateGlobalTake(e:any){
      globalTakePreparedList = e.detail.prepared;
      globalTakePreparedListCount = globalTakePreparedList.length

      globalTakePreviewList = e.detail.preview;
      globalTakePreviewListCount = globalTakePreviewList.length
    }
    let globalTakePreparedListCount = 0;
    let globalTakePreparedList:any[] = [];
    let globalTakePreviewListCount = 0;
    let globalTakePreviewList:any[] = [];

    let connectionState = "connecting"

    let authUser = "";
    let authDone = false;

    let uiConfig = {
        "disabledModules":{
            "core":[""]
        }
    };
    function isDisabledModule(module:string){
      let search:string = module.slice(1)
      if(uiConfig.disabledModules.core.includes(search)){
        return true;
      }
      return false;
    }

    let uiConfigSync:Subject<any> ;

    // ----- Global Dev / TX / RX availability counter -----
    // Subscribes to the `crosspoint` sync object so the numbers update in
    // real-time as devices come and go from the NMOS registry. The counter
    // sits at the very top of the right-hand nav so it's visible from every
    // page (Crosspoint, Details, Setup, …).
    let crosspointSync:Subject<any>;
    let countAvailDev = 0, countTotalDev = 0;
    let countAvailTx  = 0, countTotalTx  = 0;
    let countAvailRx  = 0, countTotalRx  = 0;
    // Heaviest part of this counter is the O(devices*flows) walk. With lots
    // of senders the crosspoint SyncObject can deliver many patches in quick
    // succession — coalesce them into a single recompute per animation
    // frame so we don't burn CPU on every tiny patch.
    let _pendingCrosspoint:any = null;
    let _availScheduled = false;
    function scheduleRecomputeAvailability(state:any){
      _pendingCrosspoint = state;
      if(_availScheduled) return;
      _availScheduled = true;
      const run = () => {
        _availScheduled = false;
        const s = _pendingCrosspoint;
        _pendingCrosspoint = null;
        recomputeAvailabilityNow(s);
      };
      if(typeof requestAnimationFrame === "function"){
        requestAnimationFrame(run);
      }else{
        setTimeout(run, 16);
      }
    }
    function recomputeAvailabilityNow(state:any){
      let aDev = 0, tDev = 0;
      let aTx  = 0, tTx  = 0;
      let aRx  = 0, tRx  = 0;
      try{
        let devs = (state && Array.isArray(state.devices)) ? state.devices : [];
        for(let d of devs){
          if(!d) continue;
          tDev++;
          if(d.available) aDev++;
          for(let type of Object.keys(d.senders || {})){
            for(let s of (d.senders[type] || [])){
              if(!s) continue;
              tTx++;
              if(s.available) aTx++;
            }
          }
          for(let type of Object.keys(d.receivers || {})){
            for(let r of (d.receivers[type] || [])){
              if(!r) continue;
              tRx++;
              if(r.available) aRx++;
            }
          }
        }
      }catch(e){}
      countAvailDev = aDev; countTotalDev = tDev;
      countAvailTx  = aTx;  countTotalTx  = tTx;
      countAvailRx  = aRx;  countTotalRx  = tRx;
    }
    function counterStateClass(avail:number, total:number){
      if(total === 0) return "nav-counter-row-neutral";
      if(avail >= total) return "nav-counter-row-success";
      if(avail === 0)    return "nav-counter-row-error";
      return "nav-counter-row-warn";
    }

    onDestroy(() => {
      uiConfigSync.unsubscribe();
      ServerConnector.unsync("uiconfig");
      try{ crosspointSync && crosspointSync.unsubscribe(); }catch(e){}
      try{ ServerConnector.unsync("crosspoint"); }catch(e){}
    });
    onMount(()=>{

      uiConfigSync = ServerConnector.sync("uiconfig")
      uiConfigSync.subscribe((obj:any)=>{
        uiConfig = obj;
        routes = [...routes]
      });

      crosspointSync = ServerConnector.sync("crosspoint");
      crosspointSync.subscribe((obj:any)=>{
        scheduleRecomputeAvailability(obj);
      });
      
      ServerConnector.connectionState.subscribe((state)=>{
        connectionState = ""+state;
      })

      ServerConnector.authRequest.subscribe((data)=>{
          authDone = data.authDone;
          authUser = data.username;    
      })

      setTimeout(()=>{
        ServerConnector.connectionStateTrigger();
      },1)
      update_url();

      autoTake = ServerConnector.autoTake;
      
      let mode = localStorage.getItem("nmos_crosspoint_dark_mode")
      if(mode == null){
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          dark_mode = true;
        }
      }else if(mode == "dark"){
        dark_mode = true;
        
      }
      set_theme();
    })

    let autoTake = true;
    function toggleAutotake(){
      ServerConnector.setAutoTake(autoTake);
    }

    let dark_mode = false;

    function set_theme() {
      setTimeout(()=>{
        if(dark_mode){
          document.documentElement.setAttribute('data-theme', 'dark')
        }else{
          document.documentElement.setAttribute('data-theme', 'light')
        }
      },10);
    }

    function save_theme() {
      setTimeout(()=>{
        if(dark_mode){
          localStorage.setItem("nmos_crosspoint_dark_mode", "dark")
        }else{
          localStorage.setItem("nmos_crosspoint_dark_mode", "light")
        }
      },10);
    }

    let crosspointComponent:any = null

    function doLogout(){
      ServerConnector.doLogout();
    }
    function doLogin(){
      ServerConnector.requestAuth();
    }


    function checkCurrentUrl(url:string, route:string){
      return url == route
    }

    

</script>

<Router>
  <div class="browser-layout">

    <div class="browser-work-area">
    <Route path="/"          ><Crosspoint bind:this="{crosspointComponent}" autoTake={autoTake} on:updateGlobalTake={(e)=>{updateGlobalTake(e)}}></Crosspoint></Route>
    <Route path="/crosspoint"><Crosspoint bind:this="{crosspointComponent}" autoTake={autoTake} on:updateGlobalTake={(e)=>{updateGlobalTake(e)}}></Crosspoint></Route>

    <Route path="/details" component={Details}/>

    <Route path="/debug" component={Debug}/>
    <Route path="/logging" component={Logging}/>

    <Route path="/setup" component={Setup}/>

    <Route><h2>404 : Not found</h2></Route>




    </div>
    <nav class="browser-nav menu bg-base-200">
      <!-- Global availability counter — sits above the Crosspoint icon so the
           current online/total numbers are visible from every page. The
           tooltip anchors to the LEFT edge of the counter so it doesn't
           fly off the right side of the browser. -->
      <div class="nav-counter"
           use:menu.tooltip
           data-tooltip-position="left,middle"
           data-tooltip="Online / total known — Devices · Senders · Receivers">
        <div class="nav-counter-row {counterStateClass(countAvailDev, countTotalDev)}">
          <span class="nav-counter-label">Dev</span>
          <span class="nav-counter-value">{countAvailDev}/{countTotalDev}</span>
        </div>
        <div class="nav-counter-row {counterStateClass(countAvailTx, countTotalTx)}">
          <span class="nav-counter-label">TX</span>
          <span class="nav-counter-value">{countAvailTx}/{countTotalTx}</span>
        </div>
        <div class="nav-counter-row {counterStateClass(countAvailRx, countTotalRx)}">
          <span class="nav-counter-label">RX</span>
          <span class="nav-counter-value">{countAvailRx}/{countTotalRx}</span>
        </div>
      </div>
      <ul class="browser-nav-full">
        {#each routes as route}
          {#if !isDisabledModule(route.link)}
            {#if route.label == "Setup"}
              <li class=""></li>
            {/if}
            <li>
              <Link class={ ( checkCurrentUrl(current_url,route.link) ? "active" : "")} on:click={update_url} to={route.link}>
                <Icon src={route.icon} />
                <span>{route.label}</span>
              </Link>
            </li>
          {/if}
        {/each}

        
        <li class="">
          <label class="swap swap-rotate">
            <input type="checkbox" class="theme-controller" bind:checked={dark_mode} on:change={()=>{set_theme();save_theme();}} />
            <svg class="swap-on fill-current w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"/></svg>
            <svg class="swap-off fill-current w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z"/></svg>
          </label>
        </li>

        <li class="">
          {#if authDone}
            <div class="login-status" on:click={(evt)=>{menu.open({entry:[
              { label:authUser,callback:()=>{} },
              { label:"Logout",callback:()=>{doLogout()} },
              ]},evt)}}>
              <Icon size="24" src={LockOpen} />
            </div>
          {:else}
          <div class="login-status" on:click={(evt)=>{menu.open({entry:[
            { label:"Login",callback:()=>{doLogin()} },
            ]},evt)}}>
              <Icon size="24" src={LockClosed} />
            </div>
          {/if}


        </li>
        <li>
          {#if connectionState != "connected"}
            <div class="disconnected-status">
              <span class="loading loading-ring loading-lg text-error"></span>
              <span class="text-error">Connecting</span>
            </div>
          {/if}
        </li>
      </ul>

      {#if current_url == "/" || current_url == "/crosspoint"}
      <ul class="global-take">
        {#if autoTake}
        <li>
          <span class="text-small text-red-600">{(globalTakePreviewListCount > 0 ? "Affected: "+globalTakePreviewListCount : "")}</span>
        </li>
        {:else}
        <li>
          <span on:click={()=>{openGlobalTakeModal()}} class="text-small text-red-600">{(globalTakePreparedListCount > 0 ? "Prepared: "+globalTakePreparedListCount : "")}</span>
        </li>
        {/if}
        <li>
          <label><span>Autotake</span>
            <input type="checkbox" class="toggle" bind:checked={autoTake} on:change={toggleAutotake} />
          </label>
        </li>
        <li>
          {#if !autoTake }
            <a class="bg-red-600 text-white" on:click={()=>{doGlobalTake()}}><span>TAKE</span></a>
          {:else}
            <a class="bg-red-300 text-white" ><span>TAKE</span></a>
          {/if}
        </li>
      </ul>
      {/if}
    </nav>
  </div>
</Router>

<ServerConnectorOverlay></ServerConnectorOverlay>
<OverlayMenu></OverlayMenu>


