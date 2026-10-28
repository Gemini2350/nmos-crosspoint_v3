// Sign-in with OpenID Connect: config, claim mapping, and the whole code flow
// against a fake provider.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");
const jose = require("jose");
const o = require("../dist/lib/oidc.js");
const { WebsocketSyncServer } = require("../dist/lib/SyncServer/websocketSyncServer.js");

test("sign-in is off without issuer and client id; the rest has defaults", () => {
    assert.equal(o.parseOidcConfig(undefined), null);
    assert.equal(o.parseOidcConfig({ issuer: "https://idp.example" }), null);
    const c = o.parseOidcConfig({ issuer: "https://idp.example", clientId: "crosspoint" });
    assert.deepEqual(c.scopes, ["openid", "profile", "email"]);
    assert.equal(c.groupsClaim, "groups");
    assert.equal(c.sessionHours, 12);
});

test("groups come from defaultGroups and the mapped claim values", () => {
    const c = o.parseOidcConfig({
        issuer: "https://idp.example", clientId: "crosspoint",
        groupsClaim: "realm_access.roles",
        groupMap: { "xp-operator": ["user"], "xp-admin": ["user", "admin"] },
        defaultGroups: ["viewer"],
    });
    assert.deepEqual(o.groupsFor({ realm_access: { roles: ["xp-admin", "other"] } }, c), ["viewer", "user", "admin"]);
    assert.deepEqual(o.groupsFor({}, c), ["viewer"]);
    // A claim value that is not mapped grants nothing, even when it is a group name.
    assert.deepEqual(o.groupsFor({ realm_access: { roles: ["admin"] } }, { ...c, defaultGroups: [] }), []);
    assert.deepEqual(o.claimValues({ groups: "one" }, "groups"), ["one"]);
});

test("only a local path is returned to after sign-in", () => {
    assert.equal(o.safeReturnPath("/details?x=1"), "/details?x=1");
    for (const p of ["//evil.example", "/\\evil.example", "https://evil.example", "", undefined]) {
        assert.equal(o.safeReturnPath(p), "/", String(p));
    }
});

test("the origin follows a reverse proxy's forwarded headers", () => {
    assert.equal(o.requestOrigin({ headers: { host: "xp:80" } }), "http://xp:80");
    assert.equal(o.requestOrigin({ headers: { host: "xp", "x-forwarded-proto": "https, http", "x-forwarded-host": "xp.example" } }),
        "https://xp.example");
});

test("a session user is matched by group only, never by a local user's name", () => {
    const authData = {
        users: { admin: { password: "", groups: ["user"] } },
        permissions: {
            global: {
                allowRead: { users: ["admin"], groups: ["user"] }, allowWrite: { users: ["admin"], groups: ["user"] },
                denyRead: { users: [], groups: [] }, denyWrite: { users: [], groups: [] },
            },
        },
    };
    const check = (...a) => WebsocketSyncServer.prototype.checkPermission.call({ authData }, ...a);
    assert.equal(check("admin", "global", true), true);
    assert.equal(check("admin", "global", true, []), false);
    assert.equal(check("someone", "global", true, ["user"]), true);
});

// ----- the code flow against a fake provider -----

function listen(app) {
    return new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
}

// `token` overrides what the ID token is minted with: aud, iss, exp, or a
// key the provider does not publish.
async function fakeProvider(claims, token = {}) {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const signingKey = token.foreignKey ? (await jose.generateKeyPair("RS256")).privateKey : privateKey;
    const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const codes = new Map();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    const idp = { requests: [] };
    app.get("/.well-known/openid-configuration", (req, res) => res.json({
        issuer: idp.url,
        authorization_endpoint: idp.url + "/auth",
        token_endpoint: idp.url + "/token",
        jwks_uri: idp.url + "/jwks",
        end_session_endpoint: idp.url + "/logout",
    }));
    app.get("/jwks", (req, res) => res.json({ keys: [jwk] }));
    app.post("/token", async (req, res) => {
        idp.requests.push({ body: req.body, authorization: req.headers.authorization });
        const c = codes.get(req.body.code);
        codes.delete(req.body.code);
        const challenge = crypto.createHash("sha256").update(req.body.code_verifier || "").digest("base64url");
        if (!c || challenge !== c.challenge || req.body.redirect_uri !== c.redirectUri) {
            res.status(400).json({ error: "invalid_grant" });
            return;
        }
        const idToken = await new jose.SignJWT({ nonce: c.nonce, ...claims })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(token.iss || idp.url).setAudience(token.aud || "crosspoint").setSubject("u-1")
            .setIssuedAt(token.exp ? token.exp - 600 : undefined).setExpirationTime(token.exp || "5m").sign(signingKey);
        res.json({ id_token: idToken, token_type: "Bearer" });
    });
    // What the provider does when the user has signed in: hands out a code.
    idp.authorize = (location) => {
        const u = new URL(location);
        const code = crypto.randomBytes(8).toString("hex");
        codes.set(code, {
            nonce: u.searchParams.get("nonce"),
            challenge: u.searchParams.get("code_challenge"),
            redirectUri: u.searchParams.get("redirect_uri"),
        });
        return { code, state: u.searchParams.get("state"), params: u.searchParams };
    };
    idp.server = await listen(app);
    idp.url = "http://127.0.0.1:" + idp.server.address().port;
    return idp;
}

async function crosspoint(idp, extra = {}) {
    const signIn = new o.OidcSignIn(o.parseOidcConfig({
        issuer: idp.url, clientId: "crosspoint", groupMap: { operators: ["user"] }, ...extra,
    }));
    const app = express();
    signIn.mount(app);
    const server = await listen(app);
    return { signIn, server, url: "http://127.0.0.1:" + server.address().port };
}

const get = (url, cookie) => fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
// The WebSocket upgrade as the browser sends it from the crosspoint's page.
const upgrade = (xp, cookie, origin = xp.url) => ({ headers: { host: new URL(xp.url).host, origin, cookie } });
const setCookies = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]);

async function signInFlow(idp, xp) {
    const login = await get(xp.url + "/auth/oidc/login?return=/details");
    assert.equal(login.status, 302);
    const stateCookie = setCookies(login)[0];
    const auth = idp.authorize(login.headers.get("location"));
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    return { login, auth, cb, stateCookie };
}

test("the code flow signs a user in with PKCE and a session cookie", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });

    const { auth, cb } = await signInFlow(idp, xp);
    assert.equal(auth.params.get("code_challenge_method"), "S256");
    assert.equal(auth.params.get("redirect_uri"), xp.url + "/auth/oidc/callback");
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/details");
    // A public client sends its id and no secret.
    assert.equal(idp.requests[0].body.client_id, "crosspoint");
    assert.equal(idp.requests[0].authorization, undefined);

    const session = setCookies(cb).find((c) => c.startsWith(o.SESSION_COOKIE + "="));
    const who = xp.signIn.identify(upgrade(xp, session));
    assert.equal(who.user, "alice");
    assert.deepEqual(who.groups, ["user"]);
    // A page of another origin, on the same site or not, gets no session.
    assert.equal(xp.signIn.identify(upgrade(xp, session, "http://127.0.0.1:1")), null);
    assert.equal(xp.signIn.identify(upgrade(xp, session, "")), null);
    // The session ends with its time.
    assert.equal(xp.signIn.isActive(who.sessionId), true);
    assert.equal(xp.signIn.isActive(who.sessionId, Date.now() + 12 * 3600 * 1000 + 1), false);

    // Logout ends the session here and at the provider.
    let ended = "";
    xp.signIn.onLogout = (id) => { ended = id; };
    const out = await get(xp.url + "/auth/oidc/logout", session);
    assert.equal(out.status, 302);
    assert.ok(out.headers.get("location").startsWith(idp.url + "/logout?"));
    assert.equal(ended, who.sessionId);
    assert.equal(xp.signIn.identify(upgrade(xp, session)), null);
});

test("a confidential client authenticates at the token endpoint", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp, { clientSecret: "s3cret" });
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 302);
    assert.equal(idp.requests[0].authorization, "Basic " + Buffer.from("crosspoint:s3cret").toString("base64"));
});

test("a callback without the browser's state cookie is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const auth = idp.authorize(login.headers.get("location"));
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state);
    assert.equal(cb.status, 400);
    assert.equal(idp.requests.length, 0);
});

test("an account with no mapped group gets no session", async (t) => {
    const idp = await fakeProvider({ preferred_username: "bob", groups: ["others"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 403);
    assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false);
});

test("an ID token minted for another sign-in is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"], nonce: "replayed" });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 502);
    assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false);
    assert.ok(setCookies(cb).includes("nmoscrosspoint_oidc_state="), "the state cookie is cleared on a failure too");
});

test("an ID token for another client, from another issuer, signed by another key or expired is refused", async (t) => {
    for (const token of [{ aud: "other" }, { iss: "https://other.example" }, { foreignKey: true },
        { exp: Math.floor(Date.now() / 1000) - 60 }]) {
        const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] }, token);
        const xp = await crosspoint(idp);
        t.after(() => { idp.server.close(); xp.server.close(); });
        const { cb } = await signInFlow(idp, xp);
        assert.equal(cb.status, 502, JSON.stringify(token));
        assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false, JSON.stringify(token));
    }
});

test("a callback is redeemed once", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { auth, cb, stateCookie } = await signInFlow(idp, xp);
    assert.equal(cb.status, 302);
    // The browser has dropped the cookie; one replayed by hand reaches the
    // provider, which takes a code once.
    const again = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    assert.notEqual(again.status, 302);
    assert.equal(setCookies(again).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false);
});

test("an ID token for several audiences has to name this client as azp", async (t) => {
    for (const [claims, status] of [
        [{}, 502],
        [{ azp: "other" }, 502],
        [{ azp: "crosspoint" }, 302],
    ]) {
        const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"], ...claims },
            { aud: ["crosspoint", "other"] });
        const xp = await crosspoint(idp);
        t.after(() => { idp.server.close(); xp.server.close(); });
        const { cb } = await signInFlow(idp, xp);
        assert.equal(cb.status, status, JSON.stringify(claims));
    }
    // One audience needs no azp.
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    assert.equal((await signInFlow(idp, xp)).cb.status, 302);
});

test("a sign-in left unfinished expires", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const stateCookie = setCookies(login)[0];
    const auth = idp.authorize(login.headers.get("location"));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 10 * 60 * 1000 + 1 });
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    t.mock.timers.reset();
    assert.equal(cb.status, 400);
    assert.equal(idp.requests.length, 0, "the code is never redeemed");
});

test("sign-ins in progress hold no server state, so none can be crowded out", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const first = await get(xp.url + "/auth/oidc/login");
    const stateCookie = setCookies(first)[0];
    const auth = idp.authorize(first.headers.get("location"));
    // More sign-ins than any bounded list of them would hold.
    for (let i = 0; i < 1500; i++) {
        assert.equal((await get(xp.url + "/auth/oidc/login")).status, 302);
    }
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    assert.equal(cb.status, 302, "the first sign-in still completes");
});

test("a forged, tampered or mismatched state cookie is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login?return=/details");
    const stateCookie = setCookies(login)[0];
    const auth = idp.authorize(login.headers.get("location"));
    const [name, value] = [stateCookie.slice(0, stateCookie.indexOf("=")), decodeURIComponent(stateCookie.slice(stateCookie.indexOf("=") + 1))];
    const [body, mac] = value.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const reseal = (c) => Buffer.from(JSON.stringify(c)).toString("base64url") + "." + mac;
    const forgedMac = body + "." + crypto.createHmac("sha256", crypto.randomBytes(32)).update(body).digest("base64url");
    for (const [what, v] of [
        ["another return path under the old signature", reseal({ ...claims, returnTo: "/evil" })],
        ["a later expiry under the old signature", reseal({ ...claims, expires: claims.expires + 3600e3 })],
        ["a signature by another key", forgedMac],
        ["no signature", body],
        ["garbage", "x.y"],
    ]) {
        const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state,
            name + "=" + encodeURIComponent(v));
        assert.equal(cb.status, 400, what);
    }
    // A genuine cookie for another sign-in does not answer this one.
    const other = setCookies(await get(xp.url + "/auth/oidc/login"))[0];
    assert.equal((await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, other)).status, 400);
    assert.equal(idp.requests.length, 0, "no code is redeemed for any of them");
    // The genuine one still works, and clears itself.
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/details");
    assert.ok(setCookies(cb).includes(name + "="), "the state cookie is cleared");
});

test("logout is refused from another site's page", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    const session = setCookies(cb).find((c) => c.startsWith(o.SESSION_COOKIE + "="));
    const logout = (site) => fetch(xp.url + "/auth/oidc/logout",
        { redirect: "manual", headers: { cookie: session, "sec-fetch-site": site } });
    for (const site of ["cross-site", "same-site"]) {
        assert.equal((await logout(site)).status, 403, site);
        assert.notEqual(xp.signIn.identify(upgrade(xp, session)), null, "still signed in after " + site);
    }
    // A browser that sends no Sec-Fetch-Site is judged by Origin, then Referer.
    const from = (headers) => fetch(xp.url + "/auth/oidc/logout", { redirect: "manual", headers: { cookie: session, ...headers } });
    assert.equal((await from({ origin: "https://evil.example" })).status, 403);
    assert.equal((await from({ referer: "https://evil.example/page" })).status, 403);
    assert.notEqual(xp.signIn.identify(upgrade(xp, session)), null);
    assert.equal((await logout("same-origin")).status, 302);
    assert.equal(xp.signIn.identify(upgrade(xp, session)), null);
});

test("a local login replaces the socket's identity, and a failed one signs it out", () => {
    const { WebsocketClient } = require("../dist/lib/SyncServer/websocketClient.js");
    const saved = WebsocketSyncServer.instance;
    WebsocketSyncServer.instance = { authData: { users: { bob: { password: "pw", groups: ["user"] } } } };
    try {
        const sent = [];
        const socket = { user: "alice", groups: ["admin"], sessionId: "s-1", authSeed: "seed", send: (m) => sent.push(m) };
        WebsocketClient.prototype.processAuth.call(socket, { user: "bob", password: "wrong" });
        assert.deepEqual([socket.user, socket.groups, socket.sessionId], ["__noAuth", null, ""]);
        assert.equal(sent.pop().type, "authfailed");

        const proof = crypto.createHash("sha256").update("pw" + "seed").digest("hex");
        Object.assign(socket, { groups: ["admin"], sessionId: "s-2" });
        WebsocketClient.prototype.processAuth.call(socket, { user: "bob", password: proof });
        assert.deepEqual([socket.user, socket.groups, socket.sessionId], ["bob", null, ""],
            "a local user's groups come from users.json, not from the session it replaced");
    } finally {
        WebsocketSyncServer.instance = saved;
    }
});

test("a return path longer than 1 KiB is not kept", () => {
    assert.equal(o.safeReturnPath("/" + "a".repeat(1023)), "/" + "a".repeat(1023));
    assert.equal(o.safeReturnPath("/" + "a".repeat(1024)), "/");
});

test("a refused callback clears the state cookie", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const auth = idp.authorize(login.headers.get("location"));
    // A state the cookie was not issued for.
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=other", setCookies(login)[0]);
    assert.equal(cb.status, 400);
    assert.ok(setCookies(cb).includes("nmoscrosspoint_oidc_state="));
});

test("a signed state cookie missing a field or with one of the wrong type is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const sc = setCookies(login)[0];
    const [name, value] = [sc.slice(0, sc.indexOf("=")), decodeURIComponent(sc.slice(sc.indexOf("=") + 1))];
    const claims = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString());
    const auth = idp.authorize(login.headers.get("location"));
    // Signed with the crosspoint's own key, so only the field check can refuse them.
    const sign = (c) => {
        const body = Buffer.from(JSON.stringify(c)).toString("base64url");
        return body + "." + crypto.createHmac("sha256", xp.signIn.stateKey).update(body).digest("base64url");
    };
    const { verifier, ...noVerifier } = claims;
    for (const [what, c] of [
        ["no verifier", noVerifier],
        ["a numeric nonce", { ...claims, nonce: 1 }],
        ["a string expiry", { ...claims, expires: String(claims.expires) }],
        ["an object return path", { ...claims, returnTo: { toString: "/" } }],
    ]) {
        const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state,
            name + "=" + encodeURIComponent(sign(c)));
        assert.equal(cb.status, 400, what);
    }
    assert.equal(idp.requests.length, 0);
    // The same signing, of the cookie as issued, is accepted.
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state,
        name + "=" + encodeURIComponent(sign(claims)));
    assert.equal(cb.status, 302);
});

test("over https both cookies take the __Host- prefix and only that name is read", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const https = { "x-forwarded-proto": "https" };
    const login = await fetch(xp.url + "/auth/oidc/login", { redirect: "manual", headers: https });
    const raw = login.headers.getSetCookie()[0];
    assert.match(raw, /^__Host-nmoscrosspoint_oidc_state=.*; Path=\/;.*; Secure$/);
    const stateCookie = raw.split(";")[0];
    const auth = idp.authorize(login.headers.get("location"));
    // The unprefixed name, which a sibling host could set, is not read.
    const plain = await fetch(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state,
        { redirect: "manual", headers: { ...https, cookie: stateCookie.replace(/^__Host-/, "") } });
    assert.equal(plain.status, 400);
    const cb = await fetch(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state,
        { redirect: "manual", headers: { ...https, cookie: stateCookie } });
    assert.equal(cb.status, 302);
    const session = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-" + o.SESSION_COOKIE + "="));
    assert.ok(session && session.endsWith("; Secure"), "the session cookie is prefixed and Secure");
    const host = new URL(xp.url).host;
    const req = (cookie) => ({ headers: { host, origin: "https://" + host, "x-forwarded-proto": "https", cookie } });
    assert.equal(xp.signIn.identify(req(session.split(";")[0])).user, "alice");
    assert.equal(xp.signIn.identify(req(session.split(";")[0].replace(/^__Host-/, ""))), null);
});

// Over https a clear has to name the __Host- cookie and carry Secure: a
// browser keeps a Secure cookie against a Set-Cookie without it, so a clear
// sent the http way leaves the cookie in place.
test("over https a refused callback and a logout clear the prefixed, Secure cookies", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const host = "xp.example";
    const xp = await crosspoint(idp, { redirectUri: "https://" + host + "/auth/oidc/callback" });
    t.after(() => { idp.server.close(); xp.server.close(); });
    const raw = (res) => res.headers.getSetCookie();
    const cleared = (name) => new RegExp("^__Host-" + name + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$");

    const refused = await get(xp.url + "/auth/oidc/callback?code=x&state=y", "__Host-nmoscrosspoint_oidc_state=garbage");
    assert.equal(refused.status, 400);
    assert.ok(raw(refused).some((c) => cleared("nmoscrosspoint_oidc_state").test(c)), raw(refused).join(" | "));

    const out = await fetch(xp.url + "/auth/oidc/logout", { redirect: "manual",
        headers: { cookie: "__Host-" + o.SESSION_COOKIE + "=gone", "sec-fetch-site": "same-origin" } });
    assert.equal(out.status, 302);
    assert.ok(raw(out).some((c) => cleared(o.SESSION_COOKIE).test(c)), raw(out).join(" | "));
});

test("over https login and logout clear the unprefixed cookies an older crosspoint set", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp, { redirectUri: "https://xp.example/auth/oidc/callback" });
    t.after(() => { idp.server.close(); xp.server.close(); });
    const legacy = "nmoscrosspoint_oidc_state=old; " + o.SESSION_COOKIE + "=old";
    const clears = (res) => res.headers.getSetCookie().filter((c) => /^nmoscrosspoint_[a-z_]+=; .*Max-Age=0; Secure$/.test(c))
        .map((c) => c.split("=")[0]).sort();
    const login = await get(xp.url + "/auth/oidc/login", legacy);
    assert.deepEqual(clears(login), ["nmoscrosspoint_oidc_state", "nmoscrosspoint_session"]);
    const out = await fetch(xp.url + "/auth/oidc/logout", { redirect: "manual", headers: { cookie: legacy } });
    assert.deepEqual(clears(out), ["nmoscrosspoint_oidc_state", "nmoscrosspoint_session"]);
    // Nothing to clear, nothing sent; and over http the names were never other.
    assert.deepEqual(clears(await get(xp.url + "/auth/oidc/login")), []);
    const plain = await crosspoint(idp);
    t.after(() => plain.server.close());
    assert.deepEqual(clears(await get(plain.url + "/auth/oidc/login", legacy)), []);
});
