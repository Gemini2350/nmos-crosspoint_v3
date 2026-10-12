<script context="module" lang="ts">
    export type RenameKind = "sender" | "receiver" | "device" | "node";
    export type RenameTarget = {
        id: string;                 // crosspoint id ("node_<id>" for a node)
        kind: RenameKind;
        name: string;               // the name in NMOS
        alias: string;              // what is shown: the alias, else the name
        annotatable: boolean;       // its Node offers IS-13
        // A device row of a single-device node reads "<Node> - <Device>", so
        // the dialog also takes the node's alias there.
        node?: { id: string, name: string, alias: string };
    };
</script>

<script lang="ts">
    // Rename dialog of the Crosspoint and Details pages. The two ways to name
    // something sit side by side, so it is clear which one does what:
    //  - an alias in this crosspoint only ("changealias"), the device keeps
    //    its name;
    //  - with IS-13, the label on the device itself ("annotate"), which every
    //    controller then gets through the registry. The server drops the
    //    local alias then, so the device's own name is the one shown.
    import { tick } from "svelte";
    import { Icon, ComputerDesktop, ServerStack } from "svelte-hero-icons";
    import ServerConnector from "./ServerConnector/ServerConnectorService";

    let dialog: HTMLDialogElement;
    let input: HTMLInputElement;
    let t: RenameTarget = { id: "", kind: "device", name: "", alias: "", annotatable: false };
    let value = "";
    let nodeValue = "";
    let busy = false;
    let error = "";

    const kindNames: { [k in RenameKind]: string } = { sender: "sender", receiver: "receiver", device: "device", node: "node" };
    $: hasAlias = !!t.alias && t.alias !== t.name;

    export async function open(target: RenameTarget){
        t = target;
        value = target.alias || target.name;
        nodeValue = target.node ? (target.node.alias || target.node.name) : "";
        busy = false;
        error = "";
        dialog.showModal();
        await tick();
        input.focus();
        input.select();
    }

    // The NMOS name typed back in means "no alias".
    function saveAlias(){
        let v = value.trim();
        ServerConnector.post("changealias", { id: t.id, alias: v === t.name ? "" : v });
        if(t.node){
            let n = nodeValue.trim();
            if(n === t.node.name){ n = ""; }
            if(n !== (t.node.alias || "")){
                ServerConnector.post("changealias", { id: "node_" + t.node.id, alias: n });
            }
        }
        dialog.close();
    }
    function removeAlias(){
        ServerConnector.post("changealias", { id: t.id, alias: "" });
        dialog.close();
    }
    // A refusal stays in the dialog with the device's own words.
    function annotate(reset: boolean){
        error = "";
        const label = reset ? null : value.trim();
        if(!reset && !label){ error = "Type a name first, or reset the name on the device."; return; }
        busy = true;
        ServerConnector.post("annotate", { id: t.id, label }).then(()=>{
            busy = false;
            dialog.close();
            ServerConnector.addFeedback({ message: reset ? "Name reset on the device (IS-13)" : "Name set on the device (IS-13)", level: "success" });
        }).catch((e: any)=>{
            busy = false;
            error = (e && e.message) ? e.message : "IS-13 annotation failed";
        });
    }
    function enter(e: KeyboardEvent){
        if(e.key === "Enter"){ e.preventDefault(); saveAlias(); }
    }
</script>

<!-- A click beside the box lands on the dialog itself and closes it; Esc
     closes it natively, so no key handler is needed for that. -->
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<dialog bind:this={dialog} class="modal rename-dialog" on:click={(e)=>{ if(e.target === dialog){ dialog.close(); } }}>
  <div class="modal-box rename-box">
    <form method="dialog">
      <button class="btn btn-sm btn-circle btn-ghost rename-close" aria-label="Close">✕</button>
    </form>
    <h3 class="rename-title">Rename {kindNames[t.kind]}</h3>

    <dl class="rename-facts">
      <dt>NMOS name</dt><dd>{t.name || "—"}</dd>
      <dt>Alias here</dt><dd class:rename-none={!hasAlias}>{hasAlias ? t.alias : "none"}</dd>
    </dl>

    <label class="rename-field">
      <span>New name</span>
      <input bind:this={input} bind:value={value} on:keydown={enter} type="text"
             class="input input-bordered w-full" placeholder={t.name} />
    </label>
    {#if t.node}
      <label class="rename-field">
        <span>Node name <em>alias here for {t.node.name}</em></span>
        <input bind:value={nodeValue} on:keydown={enter} type="text"
               class="input input-bordered input-sm w-full" placeholder={t.node.name} />
      </label>
    {/if}

    <div class="rename-ways">
      <section class="rename-way">
        <header><Icon src={ComputerDesktop} size="16" /><b>This crosspoint</b></header>
        <p>Shown only here. The device keeps its name.</p>
        <div class="rename-buttons">
          <button class="btn btn-sm btn-ghost" disabled={!hasAlias} on:click={removeAlias}>Remove alias</button>
          <button class="btn btn-sm" class:btn-primary={!t.annotatable} on:click={saveAlias}>Save alias</button>
        </div>
      </section>
      <section class="rename-way" class:rename-way-off={!t.annotatable}>
        <header><Icon src={ServerStack} size="16" /><b>On the device</b><span class="rename-badge">IS-13</span></header>
        {#if t.annotatable}
          <p>Renamed on the device itself, every controller sees it.</p>
          <div class="rename-buttons">
            <button class="btn btn-sm btn-ghost" disabled={busy} on:click={()=>annotate(true)}>Reset on device</button>
            <button class="btn btn-sm btn-primary" disabled={busy} on:click={()=>annotate(false)}>{busy ? "Saving…" : "Save to device"}</button>
          </div>
        {:else}
          <p>This device does not offer IS-13 (NMOS Annotation), so its name can only be changed here.</p>
        {/if}
      </section>
    </div>

    {#if error}<p class="rename-error" role="alert">{error}</p>{/if}
  </div>
</dialog>
