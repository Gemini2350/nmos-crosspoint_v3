<!--
  The NMOS Crosspoint logo: a 4x3 crosspoint matrix with three crosspoints
  switched, one per receiver row (from the explainer video). The unswitched
  cells take the text colour, so it works on light and dark backgrounds.
-->
<script lang="ts">
    export let size = 46;   // width in px
</script>

<svg class="cp-logo" viewBox="-8 -8 147 112" width={size} height={size * 0.7619} aria-hidden="true">
    <defs><filter id="cp-logo-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <rect x="0" y="0" width="26" height="26" rx="6" class="off"/>
    <rect x="35" y="0" width="26" height="26" rx="6" class="off"/>
    <rect x="70" y="0" width="26" height="26" rx="6" class="on" filter="url(#cp-logo-glow)"/>
    <rect x="105" y="0" width="26" height="26" rx="6" class="off"/>
    <rect x="0" y="35" width="26" height="26" rx="6" class="off"/>
    <rect x="35" y="35" width="26" height="26" rx="6" class="on" filter="url(#cp-logo-glow)"/>
    <rect x="70" y="35" width="26" height="26" rx="6" class="off"/>
    <rect x="105" y="35" width="26" height="26" rx="6" class="off"/>
    <rect x="0" y="70" width="26" height="26" rx="6" class="off"/>
    <rect x="35" y="70" width="26" height="26" rx="6" class="off"/>
    <rect x="70" y="70" width="26" height="26" rx="6" class="off"/>
    <rect x="105" y="70" width="26" height="26" rx="6" class="on" filter="url(#cp-logo-glow)"/>
</svg>

<style>
    .cp-logo { flex: none; overflow: visible; }
    .off { fill: currentColor; fill-opacity: 0.14; }
    .on { fill: #34d399; }
</style>
