<script lang="ts">
    // The current value of an IS-07 sender (or of the sender a receiver
    // takes), as the server worded it (server/src/lib/crosspointAbstraction.ts,
    // publishEventState): a dot for on/off, the text, greyed when stale. The
    // tooltip adds the time of the last change in the browser's local time.
    import OverlayMenuService from "./OverlayMenu/OverlayMenuService";
    export let ev:any = null;

    function tip(e:any):string{
        let t = e.tip || "";
        if(e.since){
            try{ t += "\nSince " + new Date(e.since).toLocaleTimeString(); }catch(x){}
        }
        return t;
    }
</script>

{#if ev}
  <span class={"ev-chip ev-" + ev.kind + (ev.stale ? " ev-stale" : "")} use:OverlayMenuService.tooltip data-tooltip={tip(ev)}>{#if ev.kind === "on" || ev.kind === "off"}<span class="ev-dot"></span>{/if}<span class="ev-text">{ev.text}</span></span>
{/if}
