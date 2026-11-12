/**
 * The text a device sends with an error response. NMOS APIs answer an error
 * with {code, error, debug}, and IS-05 and IS-13 ask clients to show `error`
 * to the user, for a 500 as much as for a 400. "" when the body has none.
 */
export function deviceErrorText(body: any): string {
    if (!body || typeof body !== "object") return "";
    const error = typeof body.error === "string" ? body.error.trim() : "";
    const debug = typeof body.debug === "string" ? body.debug.trim() : "";
    if (error && debug) return error + " (" + debug + ")";
    return error || debug;
}

/** How a request failed, for "Receiver <id> …": the device's own text when it sent one. */
export function failedBecause(status: number | undefined, body: any, code: string | undefined): string {
    const text = deviceErrorText(body);
    if (text) return "answered" + (status ? " " + status : "") + ": " + text;
    return "returned Error: " + code;
}
