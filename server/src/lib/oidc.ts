/*
 * Sign-in with an OpenID Connect provider (authorization code flow with PKCE),
 * configured by an `oidc` block in users.json. The session id is an HttpOnly
 * cookie the browser also sends with the WebSocket upgrade, so the sync
 * connection is signed in from its first message.
 */

import * as crypto from "crypto";
import axios from "axios";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { SyncLog } from "./syncLog";

const LOGIN_PATH = "/auth/oidc/login";
const CALLBACK_PATH = "/auth/oidc/callback";
const LOGOUT_PATH = "/auth/oidc/logout";
export const SESSION_COOKIE = "nmoscrosspoint_session";
const STATE_COOKIE = "nmoscrosspoint_oidc_state";
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const HTTP_TIMEOUT = 10000;

export type OidcConfig = {
    issuer: string,
    clientId: string,
    clientSecret: string,       // "" for a public client
    redirectUri: string,        // "" derives it from the request
    scopes: string[],
    groupsClaim: string,
    groupMap: { [claimValue: string]: string[] },
    defaultGroups: string[],
    label: string,
    sessionHours: number,
};

export type Identity = { user: string, groups: string[], sessionId: string };

const str = (v: any): string => (typeof v === "string" ? v.trim() : "");
const strings = (v: any): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s !== "") : []);

/** The `oidc` block of users.json, normalised; null when sign-in is off. */
export function parseOidcConfig(raw: any): OidcConfig | null {
    if (!raw || typeof raw !== "object") return null;
    const issuer = str(raw.issuer);
    const clientId = str(raw.clientId);
    if (!issuer || !clientId) return null;
    const groupMap: { [v: string]: string[] } = {};
    if (raw.groupMap && typeof raw.groupMap === "object") {
        for (const k of Object.keys(raw.groupMap)) {
            groupMap[k] = strings(raw.groupMap[k]);
        }
    }
    const scopes = strings(raw.scopes);
    const hours = Number(raw.sessionHours);
    return {
        issuer,
        clientId,
        clientSecret: str(raw.clientSecret),
        redirectUri: str(raw.redirectUri),
        scopes: scopes.length ? scopes : ["openid", "profile", "email"],
        groupsClaim: str(raw.groupsClaim) || "groups",
        groupMap,
        defaultGroups: strings(raw.defaultGroups),
        label: str(raw.label) || "SSO",
        sessionHours: hours > 0 ? hours : 12,
    };
}

/** Values of a claim, a string or a list of strings. A name that is not a
 *  top-level claim is read as a dot-separated path, e.g. realm_access.roles. */
export function claimValues(claims: any, name: string): string[] {
    let v = claims?.[name];
    if (v === undefined && name.includes(".")) {
        v = name.split(".").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), claims);
    }
    if (typeof v === "string") return [v];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** Crosspoint groups of a signed-in user: `defaultGroups` and every group
 *  `groupMap` lists for a value of the groups claim. */
export function groupsFor(claims: any, config: OidcConfig): string[] {
    const groups = new Set(config.defaultGroups);
    for (const v of claimValues(claims, config.groupsClaim)) {
        for (const g of config.groupMap[v] || []) groups.add(g);
    }
    return [...groups];
}

function userName(claims: any): string {
    return str(claims?.preferred_username) || str(claims?.email) || str(claims?.sub);
}

/** A local path to return to after sign-in; anything else is "/". Capped at
 *  1 KiB, because it travels in the state cookie and a browser drops a
 *  cookie past 4 KiB. */
export function safeReturnPath(p: any): string {
    const s = str(p);
    return s.length <= 1024 && s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
}

function parseCookies(header: any): { [name: string]: string } {
    const out: { [name: string]: string } = {};
    for (const part of str(header).split(";")) {
        const i = part.indexOf("=");
        if (i < 1) continue;
        try { out[part.substring(0, i).trim()] = decodeURIComponent(part.substring(i + 1).trim()); } catch (e) {}
    }
    return out;
}

/** scheme://host the browser used, behind a reverse proxy too. */
export function requestOrigin(req: any): string {
    const first = (v: any) => str(Array.isArray(v) ? v[0] : v).split(",")[0].trim();
    const proto = first(req.headers?.["x-forwarded-proto"]) || (req.socket?.encrypted ? "https" : "http");
    const host = first(req.headers?.["x-forwarded-host"]) || first(req.headers?.host);
    return proto + "://" + host;
}

/** The name a cookie is set and read under. Over https it takes the
 *  __Host- prefix, so the browser holds only one this host set itself, with
 *  Secure and Path=/: a sibling host on the same site cannot plant one. */
function cookieName(name: string, secure: boolean): string {
    return (secure ? "__Host-" : "") + name;
}

function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
    return cookieName(name, secure) + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
        maxAgeSeconds + (secure ? "; Secure" : "");
}

const random = () => crypto.randomBytes(32).toString("base64url");

type Pending = { state: string, verifier: string, nonce: string, redirectUri: string, returnTo: string, expires: number };
type Session = { user: string, groups: string[], idToken: string, expires: number };

export class OidcSignIn {
    private meta: any = null;
    private jwks: any = null;
    // Signs the state cookie, which carries a sign-in in progress: nothing is
    // held here until the callback, so there is no capacity to fill. Per
    // process, so a restart ends the sign-ins in progress, as it ends the
    // sessions.
    private readonly stateKey = crypto.randomBytes(32);
    private sessions = new Map<string, Session>();

    /** Called with the id of every session that ends by logout. */
    public onLogout: (sessionId: string) => void = () => {};

    constructor(readonly config: OidcConfig) {}

    /** scheme://host users reach the crosspoint at. */
    origin(req: any): string {
        return this.config.redirectUri ? new URL(this.config.redirectUri).origin : requestOrigin(req);
    }

    /** Whether the crosspoint is reached over https, which decides the
     *  cookies' Secure flag and name. */
    private secure(req: any): boolean {
        return this.origin(req).startsWith("https:");
    }

    /** Clears of the unprefixed cookies a request still carries over https,
     *  set there by a crosspoint from before the __Host- prefix and no
     *  longer read. Secure, or the browser would not let them overwrite. */
    private legacyClears(req: any): string[] {
        if (!this.secure(req)) return [];
        const had = parseCookies(req?.headers?.cookie);
        return [STATE_COOKIE, SESSION_COOKIE].filter((n) => n in had)
            .map((n) => n + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    }

    private readCookie(req: any, name: string): string {
        return parseCookies(req?.headers?.cookie)[cookieName(name, this.secure(req))] || "";
    }

    /** Whether a request comes from the crosspoint's own pages, or from no
     *  page at all, as far as the browser says. */
    sameOriginRequest(req: any): boolean {
        const site = str(req.headers?.["sec-fetch-site"]);
        if (site) return site === "same-origin" || site === "none";
        const from = str(req.headers?.origin) || str(req.headers?.referer);
        if (!from) return true;
        try { return new URL(from).origin === this.origin(req); } catch (e) { return false; }
    }

    /** The signed-in user behind a WebSocket upgrade, if any. The cookie
     *  alone would also sign in a socket opened by a page of another origin
     *  on the same site, so the page has to be the crosspoint's own. */
    identify(req: any): Identity | null {
        if (str(req?.headers?.origin) !== this.origin(req)) return null;
        const id = this.readCookie(req, SESSION_COOKIE);
        if (!id || !this.isActive(id)) return null;
        const s = this.sessions.get(id)!;
        return { user: s.user, groups: s.groups, sessionId: id };
    }

    isActive(sessionId: string, now = Date.now()): boolean {
        const s = this.sessions.get(sessionId);
        return !!s && s.expires > now;
    }

    prune() {
        const now = Date.now();
        for (const [k, s] of this.sessions) if (s.expires <= now) this.sessions.delete(k);
    }

    mount(app: any) {
        const handle = (fn: (req: any, res: any) => Promise<void>) => (req: any, res: any) => {
            fn(req, res).catch((e: any) => {
                const detail = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || e;
                SyncLog.log("error", "OIDC", "Sign-in failed: " + detail);
                res.status(502).type("text/plain").send("Sign-in failed. The crosspoint's log has the reason.");
            });
        };
        app.get(LOGIN_PATH, handle((req, res) => this.login(req, res)));
        app.get(CALLBACK_PATH, handle((req, res) => this.callback(req, res)));
        app.get(LOGOUT_PATH, handle((req, res) => this.logout(req, res)));
    }

    private async discover() {
        if (this.meta) return this.meta;
        const url = this.config.issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
        const meta = (await axios.get(url, { timeout: HTTP_TIMEOUT })).data;
        if (str(meta?.issuer).replace(/\/+$/, "") !== this.config.issuer.replace(/\/+$/, "")) {
            throw new Error("the provider at " + url + " names another issuer: " + meta?.issuer);
        }
        this.jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
        this.meta = meta;
        return meta;
    }

    private async login(req: any, res: any) {
        const meta = await this.discover();
        this.prune();
        const state = random(), nonce = random(), verifier = random();
        const redirectUri = this.config.redirectUri || this.origin(req) + CALLBACK_PATH;
        const pending = this.sealState({
            state, verifier, nonce, redirectUri,
            returnTo: safeReturnPath(req.query?.return),
            expires: Date.now() + LOGIN_TIMEOUT,
        });
        const url = new URL(meta.authorization_endpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", this.config.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("scope", [...new Set(["openid", ...this.config.scopes])].join(" "));
        url.searchParams.set("state", state);
        url.searchParams.set("nonce", nonce);
        url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
        url.searchParams.set("code_challenge_method", "S256");
        res.setHeader("Set-Cookie", [cookie(STATE_COOKIE, pending, LOGIN_TIMEOUT / 1000, this.secure(req)), ...this.legacyClears(req)]);
        res.redirect(url.toString());
    }

    private async callback(req: any, res: any) {
        const state = str(req.query?.state);
        // The state cookie ties the answer to the browser that started the
        // sign-in, so nobody can sign a victim in with their own account. It
        // is cleared whatever the outcome; the code it was for is single-use
        // at the provider.
        const secure = this.secure(req);
        const p = this.openState(this.readCookie(req, STATE_COOKIE));
        if (!p || !state || p.state !== state || p.expires <= Date.now()) {
            res.setHeader("Set-Cookie", cookie(STATE_COOKIE, "", 0, secure));
            res.status(400).type("text/plain").send("Sign-in expired or was started in another browser. Try again.");
            return;
        }
        // Cleared now, so a failed exchange below clears it too; the answers
        // that follow set it again together with what else they set.
        res.setHeader("Set-Cookie", cookie(STATE_COOKIE, "", 0, secure));
        if (req.query?.error) {
            res.status(403).type("text/plain").send("The provider refused the sign-in: " +
                (str(req.query.error_description) || str(req.query.error)));
            return;
        }
        const meta = await this.discover();
        const idToken = await this.redeem(meta, str(req.query?.code), p);
        const { payload } = await jwtVerify(idToken, this.jwks, {
            issuer: meta.issuer, audience: this.config.clientId, requiredClaims: ["exp", "iat"],
        });
        if (payload.nonce !== p.nonce) throw new Error("ID token nonce does not match");
        // A token for several audiences names the party it was issued to;
        // without that it could have been issued to any of them.
        if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp === undefined) {
            throw new Error("ID token has several audiences and no azp");
        }
        if (payload.azp !== undefined && payload.azp !== this.config.clientId) {
            throw new Error("ID token was issued to " + payload.azp);
        }
        const user = userName(payload);
        const groups = groupsFor(payload, this.config);
        if (!user || groups.length === 0) {
            SyncLog.log("warn", "OIDC", "Sign-in refused for " + (user || "an account without a name") + ": no group mapped");
            res.setHeader("Set-Cookie", cookie(STATE_COOKIE, "", 0, secure));
            res.status(403).type("text/plain").send("Signed in as " + (user || "?") +
                ", but no crosspoint group is mapped to this account.");
            return;
        }
        this.sessions.delete(this.readCookie(req, SESSION_COOKIE));
        const id = random();
        this.sessions.set(id, { user, groups, idToken, expires: Date.now() + this.config.sessionHours * 3600 * 1000 });
        SyncLog.log("info", "OIDC", "Signed in " + user + " (" + groups.join(", ") + ")");
        res.setHeader("Set-Cookie", [
            cookie(SESSION_COOKIE, id, Math.round(this.config.sessionHours * 3600), secure),
            cookie(STATE_COOKIE, "", 0, secure),
        ]);
        res.redirect(p.returnTo);
    }

    /** A sign-in in progress as a cookie value: its JSON, then an HMAC of it. */
    private sealState(p: Pending): string {
        const body = Buffer.from(JSON.stringify(p)).toString("base64url");
        return body + "." + crypto.createHmac("sha256", this.stateKey).update(body).digest("base64url");
    }

    /** The sign-in a state cookie carries, null unless this process signed it. */
    private openState(value: any): Pending | null {
        const [body, mac, extra] = str(value).split(".");
        if (!body || !mac || extra !== undefined) return null;
        const want = crypto.createHmac("sha256", this.stateKey).update(body).digest();
        const got = Buffer.from(mac, "base64url");
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
        try {
            const p = JSON.parse(Buffer.from(body, "base64url").toString());
            const ok = ["state", "verifier", "nonce", "redirectUri", "returnTo"].every((k) => typeof p?.[k] === "string") &&
                typeof p.expires === "number";
            return ok ? p : null;
        } catch (e) {
            return null;
        }
    }

    private async redeem(meta: any, code: string, p: Pending): Promise<string> {
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: p.redirectUri,
            code_verifier: p.verifier,
        });
        const headers: any = { "Content-Type": "application/x-www-form-urlencoded" };
        const methods: any[] = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : [];
        if (!this.config.clientSecret) {
            body.set("client_id", this.config.clientId);
        } else if (methods.length && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
            body.set("client_id", this.config.clientId);
            body.set("client_secret", this.config.clientSecret);
        } else {
            headers.Authorization = "Basic " + Buffer.from(encodeURIComponent(this.config.clientId) + ":" +
                encodeURIComponent(this.config.clientSecret)).toString("base64");
        }
        const tokens = (await axios.post(meta.token_endpoint, body.toString(), { headers, timeout: HTTP_TIMEOUT })).data;
        if (typeof tokens?.id_token !== "string") throw new Error("the token endpoint returned no ID token");
        return tokens.id_token;
    }

    private async logout(req: any, res: any) {
        // A page of another site could otherwise sign a user out by linking
        // here. Without Sec-Fetch-Site an Origin or Referer of another origin
        // is refused; a request with neither, a typed URL, is let through.
        if (!this.sameOriginRequest(req)) {
            res.status(403).type("text/plain").send("Sign out from the crosspoint's own page.");
            return;
        }
        const id = this.readCookie(req, SESSION_COOKIE);
        const s = this.sessions.get(id);
        this.sessions.delete(id);
        if (s) this.onLogout(id);
        const origin = this.origin(req);
        res.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, "", 0, this.secure(req)), ...this.legacyClears(req)]);
        const end = this.meta?.end_session_endpoint;
        if (!s || !end) {
            res.redirect("/");
            return;
        }
        // Ends the session at the provider too, or the next sign-in would
        // pass straight through without asking.
        const url = new URL(end);
        url.searchParams.set("id_token_hint", s.idToken);
        url.searchParams.set("client_id", this.config.clientId);
        url.searchParams.set("post_logout_redirect_uri", origin + "/");
        res.redirect(url.toString());
    }
}
