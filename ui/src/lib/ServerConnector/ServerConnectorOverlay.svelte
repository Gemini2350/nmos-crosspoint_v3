<script lang="ts">
    import { onMount, tick } from "svelte";
    import ServerConnector from "./ServerConnectorService";
    import { Icon, User, Key } from "svelte-hero-icons";


let feedbackList:any[]= [];
let loading = false;
let authRequestModal:any;
let authRequestModalUser:any;
let authRequestModalPassword:any;
let authUser = ""
let authPass = ""
let authDenied = false;
// The username/password inputs are only RENDERED while the dialog is
// actually open. With the fields permanently in the (closed) dialog,
// password-manager extensions re-scan the page on every DOM mutation —
// on the crosspoint matrix every BCP-008 status push — and kept
// prompting for a login although no login field was visible.
let authModalOpen = false;


onMount(async()=>{
    ServerConnector.overlayFeedback.subscribe((list)=>{
        feedbackList = list;
    })

    ServerConnector.overlayLoading.subscribe((load)=>{
        loading = load;
    })

    ServerConnector.authRequest.subscribe(async (data)=>{
        if(data.request == true){
            authUser = data.username;
            authDenied = data.denied;

            authModalOpen = true;
            authRequestModal.showModal();
            await tick();   // inputs render only now
            if(authUser != ""){
                authRequestModalPassword?.focus();
            }else{
                authRequestModalUser?.focus();
            }
        }else{
            if(data.authDone == true){
                authModalOpen = false;
                authRequestModal.close();
            }
        }
    })
});

// A click on a message runs its action (the connection feedback opens the
// log), otherwise it closes the message. The ✕ always closes it.
function click(feedback:any){
    if(feedback.click){
        feedback.click();
    }else{
        ServerConnector.dismissFeedback(feedback.id);
    }
}

function doLogin(){
    authRequestModal.close();
    ServerConnector.doAuth(authUser,authPass);
    authPass = "";
}



</script>




<dialog bind:this={authRequestModal} class="modal" on:close={()=>{ authModalOpen = false; }}>
    <div class="modal-box">
        {#if authModalOpen}
        <form method="dialog">
            <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
        </form>
        <h3 class="text-lg font-bold">Login</h3>
        <div class="form-control">
            <div class="pt-8">
            <label class="input input-bordered flex gap-2">
                <input bind:this={authRequestModalUser} bind:value={authUser} type="text" autocomplete="username" class="grow" placeholder="Username" />
                <Icon src={User}></Icon>
            </label>
        </div>
        <div class="pt-4">
            <label class="input input-bordered flex gap-2">
                <input on:keypress={(e)=>{if(e.keyCode == 13) doLogin()}} bind:this={authRequestModalPassword}  bind:value={authPass} type="password" autocomplete="current-password" class="grow" placeholder="Password" />
                <Icon src={Key}></Icon>
            </label>
        </div>


            {#if authDenied}
                <span class="text-error" >Login failed.</span>
            {/if}

        </div>

        <div class="modal-action">
            <form method="dialog">
                <button class="btn" on:click={()=>{doLogin()}}>Login</button>
            </form>
        </div>
        {/if}
    </div>
</dialog>



<div class="overlay-server-feedback toast toast-bottom toast-end">
    {#each feedbackList as feedback}
        {#if !feedback.hidden }
            <div class="alert alert-{feedback.level}" on:click={()=>{click(feedback);}}>
                <button class="alert-close btn btn-xs btn-circle btn-ghost" aria-label="Close"
                        on:click|stopPropagation={()=>ServerConnector.dismissFeedback(feedback.id)}>✕</button>
                {#if feedback.data.type == "connection" && (feedback.data.result.success || feedback.data.result.disconnect || feedback.data.result.failed)}
                    <!-- One line of counts ("1 connected · 1 failed"), then
                         the devices' own reasons, one per line. -->
                    <span class="alert-title alert-counts">
                        {#if feedback.data.result.success}<span class="text-success">{feedback.data.result.success} connected</span>{/if}
                        {#if feedback.data.result.disconnect}<span class="text-info">{feedback.data.result.disconnect} disconnected</span>{/if}
                        {#if feedback.data.result.failed}<span class="text-error">{feedback.data.result.failed} failed</span>{/if}
                    </span>
                    {#if feedback.data.result.failed}
                        <span class="alert-detail">
                            {#each feedback.data.result.reasons as r}<span>{r}</span>{/each}
                        </span>
                    {/if}
                {:else}
                    <span class="alert-title">{feedback.message}</span>
                {/if}
            </div>
        {/if}
    {/each}
</div>


{#if loading }
    <div class="overlay-server-loading">
        <progress class="progress"></progress>
    </div>
{/if}




  