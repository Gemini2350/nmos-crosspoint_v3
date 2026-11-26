<script lang="ts">
    // Total bandwidth of a device or a node, as the server computed it
    // (server/src/lib/bandwidth.ts): ↑ what it sends, ↓ what it receives,
    // per leg ("2 ×" with ST 2022-7). The tooltip has each leg, both
    // networks together and what is not counted. Nothing known: nothing shown.
    import OverlayMenuService from "./OverlayMenu/OverlayMenuService";
    export let bw:any = null;
</script>

{#if bw && (bw.tx || bw.rx)}
  <span class="det-bw">
    {#if bw.tx}
      <span class="det-bw-item" use:OverlayMenuService.tooltip data-tooltip={bw.tx.tooltip}><span class="det-bw-arrow" aria-label="Sending">↑</span>{bw.tx.label}</span>
    {/if}
    {#if bw.rx}
      <span class="det-bw-item" use:OverlayMenuService.tooltip data-tooltip={bw.rx.tooltip}><span class="det-bw-arrow" aria-label="Receiving">↓</span>{bw.rx.label}</span>
    {/if}
  </span>
{/if}
