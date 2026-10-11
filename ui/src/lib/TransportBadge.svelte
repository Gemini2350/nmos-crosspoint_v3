<script lang="ts">
    // One transport, one essence-glyph-sized square: red "2110" for the RTP
    // family (split diagonally in two tones when ST 2022-7 redundant), the
    // official MXL logo for MXL, red and blue split for a device using both.
    // Anything else keeps the slot empty, so a column or row is the same size
    // whether its transport is known or not.
    import OverlayMenuService from "./OverlayMenu/OverlayMenuService";

    export let family:string = "";
    export let redundant:boolean = false;
    export let tip:string = "";
    // No tooltip of its own, e.g. inside the legend where the text beside it
    // already says what it is.
    export let plain:boolean = false;

    $: text = tip || (family === "rtp" ? (redundant ? "ST 2110, ST 2022-7 redundant" : "ST 2110") :
                      family === "mxl" ? "MXL" : family === "mixed" ? "ST 2110 and MXL" : "");
</script>

{#if family === "rtp"}
<span class="cp-tb cp-tb-2110" class:cp-tb-dup={redundant} role="img" aria-label={text}
      use:OverlayMenuService.tooltip data-tooltip={plain ? "" : text}>2110</span>
{:else if family === "mxl"}
<img class="cp-tb cp-tb-mxl" src="/assets/mxl-on-blue-square.svg" alt={text} draggable="false"
     use:OverlayMenuService.tooltip data-tooltip={plain ? "" : text}/>
{:else if family === "mixed"}
<span class="cp-tb cp-tb-mixed" role="img" aria-label={text}
      use:OverlayMenuService.tooltip data-tooltip={plain ? "" : text}></span>
{:else}
<span class="cp-tb cp-tb-none" aria-hidden="true"></span>
{/if}
