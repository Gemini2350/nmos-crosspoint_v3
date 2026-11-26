/*
 * Single sign-on settings as the Setup page edits them — the pure parts, free
 * of state and I/O so they can be tested. They live as the `oidc` block of
 * users.json (oidc.ts reads it); here the block is turned into what the page
 * shows (never the client secret) and the page's input back into a block,
 * checked.
 */

import { CALLBACK_PATH } from "./oidc";

export const LOGOUT_RETURN_PATH = "/";

/** The crosspoint groups an SSO user can be given: every group users.json
 *  names, for a user or in a permission. */
export function knownGroups(users: any): string[] {
    const out = new Set<string>();
    for (const u of Object.values(users?.users || {}) as any[]) {
        for (const g of Array.isArray(u?.groups) ? u.groups : []) if (typeof g === "string" && g) out.add(g);
    }
    for (const p of Object.values(users?.permissions || {}) as any[]) {
        for (const k of ["allowRead", "allowWrite", "denyRead", "denyWrite"]) {
            for (const g of Array.isArray(p?.[k]?.groups) ? p[k].groups : []) if (typeof g === "string" && g) out.add(g);
        }
    }
    out.add("admin");
    return Array.from(out).sort((a, b) => (a === "user" ? -1 : b === "user" ? 1 : a.localeCompare(b)));
}

export interface SsoView {
    enabled: boolean;
    issuer: string;
    clientId: string;
    secretSet: boolean;
    label: string;
    groupsClaim: string;
    mappings: Array<{ value: string, groups: string[] }>;
    everyone: string[];
    redirectUri: string;
    scopes: string;
    sessionHours: number;
    groupsAvailable: string[];
    callbackPath: string;
    logoutReturnPath: string;
}

const str = (v: any): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: any): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s !== "") : []);

/** The `oidc` block for the Setup page; the secret only as "is set". */
export function ssoView(block: any, users: any): SsoView {
    const b = (block && typeof block === "object") ? block : {};
    const map = (b.groupMap && typeof b.groupMap === "object") ? b.groupMap : {};
    const hours = Number(b.sessionHours);
    return {
        enabled: !!(str(b.issuer) && str(b.clientId)) && b.enabled !== false,
        issuer: str(b.issuer),
        clientId: str(b.clientId),
        secretSet: str(b.clientSecret) !== "",
        label: str(b.label),
        groupsClaim: str(b.groupsClaim),
        mappings: Object.keys(map).map((value) => ({ value, groups: strs(map[value]) })),
        everyone: strs(b.defaultGroups),
        redirectUri: str(b.redirectUri),
        scopes: strs(b.scopes).join(" "),
        sessionHours: hours > 0 ? hours : 12,
        groupsAvailable: knownGroups(users),
        callbackPath: CALLBACK_PATH,
        logoutReturnPath: LOGOUT_RETURN_PATH,
    };
}

function httpUrl(v: string, what: string): URL {
    let u: URL;
    try { u = new URL(v); } catch (e) { throw new Error(what + " is not a URL: " + v); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(what + " must start with https:// or http://");
    if (u.search || u.hash) throw new Error(what + " must not carry ?query or #fragment");
    return u;
}

/**
 * The page's input as an `oidc` block, checked. `prev` is the block stored
 * now: an empty secret keeps its secret, `clearSecret` removes it. Throws an
 * Error whose message the page shows.
 */
export function ssoBlockFromInput(input: any, prev: any, users: any): any {
    const groups = new Set(knownGroups(users));
    const pickGroups = (list: any, where: string): string[] => {
        const out = strs(list);
        for (const g of out) if (!groups.has(g)) throw new Error("Unknown group \"" + g + "\" in " + where);
        return Array.from(new Set(out));
    };
    const enabled = input?.enabled === true;
    const issuer = str(input?.issuer).replace(/\/+$/, "");
    const clientId = str(input?.clientId);
    if (enabled) {
        if (!issuer) throw new Error("The issuer URL is required to switch single sign-on on.");
        if (!clientId) throw new Error("The client ID is required to switch single sign-on on.");
    }
    if (issuer) httpUrl(issuer, "The issuer URL");

    const label = str(input?.label);
    if (label.length > 40) throw new Error("The button text is longer than 40 characters.");
    const groupsClaim = str(input?.groupsClaim);
    if (groupsClaim.length > 200) throw new Error("The groups claim is longer than 200 characters.");

    const groupMap: { [value: string]: string[] } = {};
    for (const m of Array.isArray(input?.mappings) ? input.mappings : []) {
        const value = str(m?.value);
        const g = pickGroups(m?.groups, "the mapping for \"" + value + "\"");
        if (!value && g.length === 0) continue;   // an empty row
        if (!value) throw new Error("A mapping has rights but no value at the provider.");
        if (groupMap[value]) throw new Error("\"" + value + "\" is mapped twice.");
        groupMap[value] = g;
    }
    const defaultGroups = pickGroups(input?.everyone, "\"Everyone who signs in\"");
    if (enabled && defaultGroups.length === 0 && !Object.values(groupMap).some((g) => g.length > 0)) {
        throw new Error("Give at least one value at the provider, or everyone who signs in, a right: otherwise nobody can sign in.");
    }

    const redirectUri = str(input?.redirectUri);
    if (redirectUri) {
        const u = httpUrl(redirectUri, "The redirect URI");
        if (u.pathname !== CALLBACK_PATH) throw new Error("The redirect URI must end with " + CALLBACK_PATH);
    }
    const scopes = str(input?.scopes).split(/[\s,]+/).filter((s) => s !== "");
    for (const sc of scopes) if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(sc)) throw new Error("Not a valid scope: " + sc);
    const hours = Number(input?.sessionHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("The session must last between 1 and 168 hours.");

    const prevSecret = str(prev?.clientSecret);
    const newSecret = str(input?.clientSecret);
    const clientSecret = input?.clearSecret === true ? "" : (newSecret || prevSecret);

    const block: any = { enabled, issuer, clientId };
    if (clientSecret) block.clientSecret = clientSecret;
    if (label) block.label = label;
    if (groupsClaim) block.groupsClaim = groupsClaim;
    block.groupMap = groupMap;
    if (defaultGroups.length) block.defaultGroups = defaultGroups;
    if (redirectUri) block.redirectUri = redirectUri;
    if (scopes.length) block.scopes = scopes;
    block.sessionHours = Math.round(hours);
    return block;
}

/** Whether two blocks sign in alike: any difference ends the SSO sessions,
 *  so a right taken away does not live on in a session. */
export function sameSignIn(a: any, b: any): boolean {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
}
