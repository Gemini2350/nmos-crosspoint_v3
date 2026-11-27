<script lang="ts">
  // BCP-008 status of one sender or receiver: overall counter and message,
  // the four status domains, the clock it is locked to, and the packet
  // counters (IS-12 methods, fetched by the parent; null = still reading).
  import OverlayMenuService from "./OverlayMenu/OverlayMenuService";
  import { monitorStateName, monitorClassVal, monitorMsg } from "./bcp008";
  export let monitor:any = null;
  export let counters:any[] | null = null;
</script>

{#if monitor}
  {@const m = monitor}
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
  <div class="cp-monitor-packets" class:cp-monitor-packets-grid={counters !== null}>
    {#if counters === null}
      <span class="cp-monitor-packets-loading">Reading packet counters…</span>
    {:else}
      <!-- One counter per line, and ONE grid for all groups: a device
           that reports four lost-packet and two late-packet counters
           wrote them into one run-on line before, and a grid per group
           left the numbers of the two groups a few pixels apart. Group
           label only on the group's first line. -->
      {#each counters as g, gi}
        {#if g.counters.length === 0}
          <span class="cp-monitor-packets-label" class:cp-monitor-packets-gap={gi > 0}>{g.label}</span><span class="cp-monitor-packets-name" class:cp-monitor-packets-gap={gi > 0}></span><span class="cp-monitor-packets-num" class:cp-monitor-packets-gap={gi > 0}>0</span>
        {:else}
          {#each g.counters as c, i}
            <span class="cp-monitor-packets-label" class:cp-monitor-packets-gap={gi > 0 && i === 0}>{i === 0 ? g.label : ""}</span><span class="cp-monitor-packets-name" class:cp-monitor-packets-gap={gi > 0 && i === 0}>{c.name}</span><span class="cp-monitor-packets-num" class:cp-monitor-packets-gap={gi > 0 && i === 0}>{c.value}</span>
          {/each}
        {/if}
      {/each}
    {/if}
  </div>
{/if}
