// Single sign-on settings as the Setup page edits them.
const test = require("node:test");
const assert = require("node:assert");
const s = require("../dist/lib/ssoSettings.js");
const o = require("../dist/lib/oidc.js");

const users = {
    users: { admin: { password: "x", groups: ["user", "admin"] }, ops: { password: "y", groups: ["user", "operators"] } },
    permissions: { global: { allowRead: { users: [], groups: ["user"] }, allowWrite: { users: [], groups: ["user"] }, denyRead: { users: [], groups: [] }, denyWrite: { users: [], groups: [] } } },
};
const input = (over = {}) => ({
    enabled: true, issuer: "https://idp.example/realms/media/", clientId: "nmos-crosspoint", clientSecret: "",
    label: "Company SSO", groupsClaim: "realm_access.roles",
    mappings: [{ value: "crosspoint-operators", groups: ["user"] }, { value: "", groups: [] }],
    everyone: [], redirectUri: "", scopes: "openid profile email", sessionHours: 12, ...over,
});

test("the groups an SSO user can get: those users.json names, user first, admin always", () => {
    assert.deepEqual(s.knownGroups(users), ["user", "admin", "operators"]);
    assert.deepEqual(s.knownGroups(null), ["admin"]);
});

test("the page's input becomes a checked oidc block", () => {
    const b = s.ssoBlockFromInput(input(), null, users);
    assert.deepEqual(b, {
        enabled: true, issuer: "https://idp.example/realms/media", clientId: "nmos-crosspoint",
        label: "Company SSO", groupsClaim: "realm_access.roles",
        groupMap: { "crosspoint-operators": ["user"] }, scopes: ["openid", "profile", "email"], sessionHours: 12,
    });
    // oidc.ts reads it as before
    const cfg = o.parseOidcConfig(b);
    assert.equal(cfg.issuer, "https://idp.example/realms/media");
    assert.deepEqual(cfg.groupMap, { "crosspoint-operators": ["user"] });
});

test("switched off, the block stays and sign-in is off", () => {
    const b = s.ssoBlockFromInput(input({ enabled: false }), null, users);
    assert.equal(b.enabled, false);
    assert.equal(o.parseOidcConfig(b), null);
    // An old block without `enabled` still counts as on.
    assert.notEqual(o.parseOidcConfig({ issuer: "https://idp.example", clientId: "c" }), null);
    // Off with nothing filled in is fine.
    assert.equal(s.ssoBlockFromInput({ enabled: false, sessionHours: 12 }, null, users).enabled, false);
});

test("the secret: kept when left empty, replaced when typed, removed on request, never shown", () => {
    const prev = { issuer: "https://idp.example", clientId: "c", clientSecret: "s3cret" };
    assert.equal(s.ssoBlockFromInput(input(), prev, users).clientSecret, "s3cret");
    assert.equal(s.ssoBlockFromInput(input({ clientSecret: "new" }), prev, users).clientSecret, "new");
    assert.equal("clientSecret" in s.ssoBlockFromInput(input({ clearSecret: true }), prev, users), false);
    const v = s.ssoView(prev, users);
    assert.equal(v.secretSet, true);
    assert.equal(JSON.stringify(v).includes("s3cret"), false);
});

test("what the page is told about a stored block", () => {
    const v = s.ssoView({ enabled: true, issuer: "https://idp.example", clientId: "c", groupMap: { a: ["user"], b: ["user", "admin"] },
        defaultGroups: ["user"], scopes: ["openid"], sessionHours: 8 }, users);
    assert.equal(v.enabled, true);
    assert.deepEqual(v.mappings, [{ value: "a", groups: ["user"] }, { value: "b", groups: ["user", "admin"] }]);
    assert.deepEqual(v.everyone, ["user"]);
    assert.equal(v.scopes, "openid");
    assert.equal(v.sessionHours, 8);
    assert.equal(v.callbackPath, "/auth/oidc/callback");
    assert.deepEqual(s.ssoView(null, users).enabled, false);
    assert.deepEqual(s.ssoView({ enabled: false, issuer: "https://idp.example", clientId: "c" }, users).enabled, false);
});

test("refused, with a reason the page shows", () => {
    const refuse = (over, re) => assert.throws(() => s.ssoBlockFromInput(input(over), null, users), re);
    refuse({ issuer: "" }, /issuer URL is required/);
    refuse({ clientId: "" }, /client ID is required/);
    refuse({ issuer: "idp.example" }, /not a URL/);
    refuse({ issuer: "ftp://idp.example" }, /https:\/\/ or http:\/\//);
    refuse({ issuer: "https://idp.example/?x=1" }, /query/);
    refuse({ mappings: [{ value: "x", groups: ["superuser"] }] }, /Unknown group "superuser"/);
    refuse({ mappings: [{ value: "", groups: ["user"] }] }, /no value at the provider/);
    refuse({ mappings: [{ value: "x", groups: ["user"] }, { value: "x", groups: ["admin"] }] }, /mapped twice/);
    refuse({ mappings: [{ value: "x", groups: [] }], everyone: [] }, /nobody can sign in/);
    refuse({ redirectUri: "https://cp.example/elsewhere" }, /must end with \/auth\/oidc\/callback/);
    refuse({ scopes: "openid pro\"file" }, /Not a valid scope/);
    refuse({ sessionHours: 0 }, /between 1 and 168/);
    refuse({ sessionHours: 500 }, /between 1 and 168/);
    refuse({ label: "x".repeat(41) }, /40 characters/);
});

test("everyone who signs in may carry the rights alone", () => {
    const b = s.ssoBlockFromInput(input({ mappings: [], everyone: ["user"] }), null, users);
    assert.deepEqual(b.defaultGroups, ["user"]);
    assert.deepEqual(b.groupMap, {});
});

test("any change to the block counts, so sessions end", () => {
    const a = s.ssoBlockFromInput(input(), null, users);
    assert.equal(s.sameSignIn(a, s.ssoBlockFromInput(input(), null, users)), true);
    assert.equal(s.sameSignIn(a, s.ssoBlockFromInput(input({ label: "Other" }), null, users)), false);
    assert.equal(s.sameSignIn(undefined, null), true);
});
