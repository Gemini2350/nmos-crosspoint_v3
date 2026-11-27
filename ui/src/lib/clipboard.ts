// Copy and save text (SDP files) from the Details page and the Crosspoint
// sender dialog.

// The helper textarea goes INTO the open dialog: a modal <dialog> makes
// everything outside it inert, so a textarea on <body> could not be
// focused or selected — execCommand still said true and copied nothing.
// Success is only claimed when the whole text really was selected.
export function legacyCopy(text: string): boolean {
  let ta: HTMLTextAreaElement | null = null;
  const back = document.activeElement as HTMLElement | null;
  try {
    const host = (back && back.closest("dialog[open]")) || document.querySelector("dialog[open]") || document.body;
    ta = document.createElement("textarea");
    ta.value = text;
    // Keep it off-screen but still selectable.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.setAttribute("readonly", "");
    host.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    if (document.activeElement !== ta || ta.selectionStart !== 0 || ta.selectionEnd !== text.length) { return false; }
    return document.execCommand("copy");
  } catch (e) { return false; }
  finally {
    if (ta && ta.parentNode) { ta.parentNode.removeChild(ta); }
    try { back?.focus(); } catch (e) {}
  }
}

/** navigator.clipboard only exists in a secure context (HTTPS or
 *  localhost); NMOS Crosspoint is mostly served over plain HTTP on a LAN
 *  address, so the textarea path is the fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  return legacyCopy(text);
}

/** "PGM Video 1" → "PGM_Video_1", never empty. */
export function fileSafe(name: string, fallback = "sender"): string {
  return (name || fallback).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

/** Save text as a file from a Blob URL: no server round trip, and it works
 *  on plain HTTP where the clipboard API is unavailable. */
export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke late: Safari needs the URL alive while the download starts.
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
}
