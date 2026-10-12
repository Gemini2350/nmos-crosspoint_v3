<script lang="ts">
    // A small "?" beside a heading. The explanation behind it shows on hover
    // and on keyboard focus; a click pins it open, which is also the way in
    // on a touch screen. Esc, a click elsewhere or a second click close a
    // pinned one. The text is the slot, so <code>, <strong> and lists keep
    // their formatting, and the pointer may move into the bubble to select
    // a snippet out of it.
    import { tick, onDestroy } from "svelte";

    export let label:string = "Help";

    let btn:HTMLButtonElement;
    let pop:HTMLDivElement;
    let open = false;
    let pinned = false;
    let placed = false;
    let hideTimer:any = null;
    let x = 0;
    let y = 0;
    const id = "help-tip-" + Math.random().toString(36).slice(2, 9);

    async function show(){
        clearTimeout(hideTimer);
        if(open){ return; }
        open = true;
        placed = false;
        await tick();
        place();
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
    }
    function hideSoon(){
        if(pinned){ return; }
        clearTimeout(hideTimer);
        // Grace period: the pointer can travel from the "?" into the bubble.
        hideTimer = setTimeout(hide, 150);
    }
    function hide(){
        clearTimeout(hideTimer);
        open = false;
        pinned = false;
        window.removeEventListener("scroll", place, true);
        window.removeEventListener("resize", place);
    }
    function toggle(){
        if(pinned){ hide(); return; }
        pinned = true;
        show();
    }
    // Below the "?", left edges aligned, kept inside the viewport; above it
    // when there is no room below.
    function place(){
        if(!btn || !pop){ return; }
        const r = btn.getBoundingClientRect();
        const m = 8;
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        x = Math.max(m, Math.min(r.left - 6, window.innerWidth - w - m));
        y = r.bottom + 6;
        if(y + h > window.innerHeight - m && r.top - 6 - h >= m){
            y = r.top - 6 - h;
        }
        placed = true;
    }
    function onKey(e:KeyboardEvent){
        if(e.key === "Escape" && open){ hide(); }
    }
    function onWindowClick(e:MouseEvent){
        if(!pinned){ return; }
        const t = e.target as Node;
        if(btn?.contains(t) || pop?.contains(t)){ return; }
        hide();
    }
    onDestroy(hide);
</script>

<svelte:window on:keydown={onKey} on:click={onWindowClick}/>

<button type="button" class="help-tip" class:help-tip-open={open} bind:this={btn}
        aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
        on:mouseenter={show} on:mouseleave={hideSoon}
        on:focus={show} on:blur={hideSoon}
        on:click|stopPropagation={toggle}>?</button>
{#if open}
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="help-tip-pop" role="tooltip" {id} bind:this={pop}
     style="left:{x}px; top:{y}px; visibility:{placed ? 'visible' : 'hidden'};"
     on:mouseenter={show} on:mouseleave={hideSoon}>
    <slot/>
</div>
{/if}
