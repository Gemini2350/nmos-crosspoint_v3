<script lang="ts">
  /*
   * AudioMonitorPlayer
   *
   * Tiny widget that opens a WebRTC peer connection to the server, fetches
   * a sender's audio stream over the server's IGMP-joined multicast,
   * decodes it client-side (the server already encoded to Opus stereo),
   * and plays it via <audio>. Includes mute + volume.
   *
   * Driven by props:
   *   senderId  — flow id from the crosspoint state
   *   sdp       — full SDP of the sender (server uses it to bind + decode)
   *   onClose   — close handler (parent removes the widget)
   */

  import { onDestroy, onMount } from "svelte";
  import ServerConnector from "../ServerConnector/ServerConnectorService";

  export let senderId: string;
  export let sdp: string;
  export let onClose: (()=>void) | null = null;

  let audioEl: HTMLAudioElement;
  let wrapEl: HTMLDivElement;
  let overlayEl: HTMLDivElement;
  let overlayStyle: string = "";
  let pc: RTCPeerConnection | null = null;
  let listenerId: string = "";
  let status: "connecting"|"playing"|"error"|"closed" = "connecting";
  let errorMsg: string = "";
  let muted: boolean = false;
  let volume: number = 1.0;

  // Channel pair: which two source channels feed the stereo monitor.
  // 0-indexed. For a 2-ch source we just send [0,1] regardless.
  let channelPairs:Array<{ label:string, ch:[number,number] }> = [];
  let chPair:[number,number] = [0,1];
  let sourceChannels:number = 2;

  // Parse the SDP for a=rtpmap encoding count so we can offer channel
  // pair selection. (Best-effort — falls back to "1+2" only.)
  try{
    const m = (sdp || "").match(/a=rtpmap:\d+\s+\w+\/\d+\/(\d+)/);
    if(m){ sourceChannels = parseInt(m[1],10) || 2; }
    channelPairs = [];
    for(let i=0; i+1<sourceChannels; i+=2){
      channelPairs.push({ label: (i+1)+"+"+(i+2), ch: [i, i+1] });
    }
    if(channelPairs.length === 0) channelPairs.push({ label:"1+2", ch:[0,1] });
  }catch(e){}

  // The overlay is position:fixed — the table cells (`.det-rows td`) have
  // overflow:hidden and would clip an absolutely positioned popup. Anchored
  // left of the 🎧 button, vertically centered on the row, clamped so it
  // never sticks out of the viewport. Repositioned on scroll/resize.
  function positionOverlay(){
    if(!wrapEl) return;
    const r = wrapEl.getBoundingClientRect();
    const h = overlayEl ? overlayEl.offsetHeight : 120;
    const half = h / 2 + 8;
    const cy = Math.max(half, Math.min(window.innerHeight - half, r.top));
    const right = Math.max(8, window.innerWidth - r.left + 8);
    overlayStyle = "top:" + cy + "px; right:" + right + "px;";
  }

  onMount(async () => {
    requestAnimationFrame(positionOverlay);
    window.addEventListener("scroll", positionOverlay, true);
    window.addEventListener("resize", positionOverlay);
    listenerId = "lst_" + Math.random().toString(36).slice(2,10);
    try{
      pc = new RTCPeerConnection({ iceServers: [] });

      pc.addTransceiver("audio", { direction: "recvonly" });

      pc.ontrack = (ev) => {
        if(audioEl && ev.streams && ev.streams[0]){
          audioEl.srcObject = ev.streams[0];
          audioEl.play().catch(()=>{ /* user gesture may be required */ });
          status = "playing";
        }
      };

      pc.onicecandidate = (ev) => {
        if(ev.candidate){
          ServerConnector.post("audioMonitorIce", {
            listenerId,
            candidate: ev.candidate.toJSON()
          }).catch(()=>{});
        }
      };

      pc.onconnectionstatechange = () => {
        if(pc?.connectionState === "failed" || pc?.connectionState === "closed"){
          status = "error";
          errorMsg = "WebRTC connection " + pc.connectionState;
        }
      };

      // Ask the server to bring the producer up. We pass our local
      // ICE candidates with `pc.onicecandidate` after the answer comes
      // back; for now we exchange the SDP via WS.
      const subRes:any = await ServerConnector.post("audioMonitorSubscribe", {
        senderId, listenerId, sdp,
        channels: chPair
      });
      if(!subRes?.data?.offer) throw new Error("server returned no offer");
      await pc.setRemoteDescription(subRes.data.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await ServerConnector.post("audioMonitorAnswer", {
        listenerId,
        answer: { type: answer.type, sdp: answer.sdp }
      });
    }catch(e:any){
      status = "error";
      errorMsg = e?.message || String(e);
    }
  });

  onDestroy(() => {
    window.removeEventListener("scroll", positionOverlay, true);
    window.removeEventListener("resize", positionOverlay);
    try{ if(pc) pc.close(); }catch(e){}
    if(listenerId){
      ServerConnector.post("audioMonitorUnsubscribe", { listenerId }).catch(()=>{});
    }
  });

  function toggleMute(){
    muted = !muted;
    if(audioEl) audioEl.muted = muted;
  }
  function setVolume(){
    if(audioEl) audioEl.volume = volume;
  }
  function onPairSelect(ev:Event){
    const target = ev.target as HTMLSelectElement;
    const idx = parseInt(target.value, 10);
    if(!isNaN(idx) && channelPairs[idx]){
      changePair(channelPairs[idx].ch);
    }
  }
  async function changePair(p:[number,number]){
    if(p[0] === chPair[0] && p[1] === chPair[1]) return;
    chPair = p;
    // In-place server-side switch — keeps the PeerConnection + UDP
    // socket alive, just swaps the channel pick. Avoids the brief
    // outage (and the bind-race that broke the stream after a few
    // seconds in the unsub/resub variant).
    try{
      await ServerConnector.post("audioMonitorSetChannels", {
        listenerId, channels: chPair
      });
    }catch(e){}
  }
</script>

<!--
  Player rendert nur das Overlay + das <audio>-Element. Der äußere 🎧-Button
  in der Tabellen-Zeile dient als Toggle (start/stop) — wir kommen erst hier
  rein, wenn der bereits geklickt wurde. Beim erneuten Click auf den
  äußeren Button wird die Komponente unmountet → onDestroy schickt
  audioMonitorUnsubscribe.
-->
<div class="audio-monitor-player" bind:this={wrapEl} class:is-error={status === "error"} role="dialog" aria-label="Audio monitor controls">
  <div class="amp-overlay" bind:this={overlayEl} style={overlayStyle || "visibility:hidden;"}>
    <div class="amp-statusline">
      {#if status === "connecting"}Connecting…{/if}
      {#if status === "playing"}🎧 Listening{/if}
      {#if status === "error"}❌ {errorMsg}{/if}
    </div>
    {#if channelPairs.length > 1}
      <label class="amp-row">
        <span class="amp-label">Channels</span>
        <select class="select select-bordered select-xs amp-pair" on:change={onPairSelect}>
          {#each channelPairs as p, i}
            <option value={i} selected={p.ch[0]===chPair[0] && p.ch[1]===chPair[1]}>Ch {p.label}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="amp-row">
      <span class="amp-label">Volume</span>
      <button class="btn btn-ghost btn-xs amp-mute" on:click={toggleMute} title={muted?"Unmute":"Mute"}>
        {muted ? "🔇" : "🔊"}
      </button>
      <input type="range" min="0" max="1" step="0.05" bind:value={volume} on:input={setVolume} class="amp-volume" />
    </label>
  </div>
  <audio bind:this={audioEl} autoplay></audio>
</div>

<style>
  .audio-monitor-player{
    display: inline-block;
    position: relative;
    width: 0;     /* overlay schwebt — nimmt keinen Platz in der Tabelle */
    height: 0;
  }
  .amp-overlay{
    /* fixed + JS-Koordinaten (siehe positionOverlay): die Tabellenzellen
       haben overflow:hidden und würden ein absolute-Overlay abschneiden. */
    position: fixed;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 220px;
    padding: 10px 12px;
    background-color: var(--fallback-b1, oklch(var(--b1)));
    border: 1px solid var(--fallback-b3, oklch(var(--b3)));
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0,0,0,0.18);
    z-index: 50;
    font-size: 0.85rem;
  }
  .amp-statusline{
    font-size: 0.75rem;
    color: theme('colors.slate.500');
    font-family: 'Roboto Mono', monospace;
  }
  .audio-monitor-player.is-error .amp-statusline{
    color: theme('colors.error');
  }
  .amp-row{
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .amp-label{
    width: 64px;
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .amp-volume{
    flex: 1 1 auto;
  }
  .amp-pair{
    flex: 1 1 auto;
    height: 24px;
    min-height: 24px;
    font-size: 0.75rem;
  }
</style>
