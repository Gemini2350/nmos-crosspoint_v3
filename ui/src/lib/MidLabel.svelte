<script lang="ts">
    import { midSplit } from "./functions";

    // A crosspoint name, shortened in the middle when it does not fit (see
    // .cp-mid in crosspoint.scss). `nodePart` is the optional "<Node>" prefix
    // of a device row: it keeps its own span, gives way first, and takes the
    // " - " separator with it when it goes — a row starting with a stray
    // dash looked like a bullet point.
    export let text:string = "";
    export let nodePart:string = "";

    let prefix = "";
    let body = "";
    let nodeOnly = false;
    $: {
        const n = "" + (nodePart || "");
        const r = "" + (text || "");
        nodeOnly = !!n && !r;
        if(n && r){
            const m = r.match(/^(\s*-\s*)([\s\S]*)$/);
            prefix = n + (m ? m[1] : " ");
            body   = m ? m[2] : r;
        }else{
            prefix = "";
            body   = r || n;
        }
    }
    $: parts = midSplit(body);
</script><!--
--><span class="cp-mid" class:cp-node-name={nodeOnly}><!--
    -->{#if prefix}<span class="cp-node-name cp-mid-node">{prefix}</span>{/if}<!--
    --><span class="cp-mid-head">{parts.head}</span><!--
    -->{#if parts.tail}<span class="cp-mid-tail">{parts.tail}</span>{/if}<!--
--></span>
