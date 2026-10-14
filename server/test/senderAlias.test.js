// Senders declaring themselves the same stream (NMOS Federation pass-through copies).
const test = require("node:test");
const assert = require("node:assert");
const { aliasIds, sameStream, clashingOwners, ALIAS_TAG } = require("../dist/lib/senderAlias.js");

const original = { id: "orig", tags: {} };
const copy = { id: "copy", tags: { [ALIAS_TAG]: ["orig"] } };
const routedBack = { id: "back", tags: { [ALIAS_TAG]: ["copy", "orig"] } };
const otherCopy = { id: "copy2", tags: { [ALIAS_TAG]: ["orig"] } };
const stranger = { id: "x", tags: {} };

test("a copy and its original are one stream, in either order", () => {
    assert.equal(sameStream(copy, original), true);
    assert.equal(sameStream(original, copy), true);
});

test("a chain and two copies of one original are one stream", () => {
    assert.equal(sameStream(routedBack, original), true);
    assert.equal(sameStream(routedBack, copy), true);
    assert.equal(sameStream(copy, otherCopy), true);
});

test("a different sender on the same multicast is still a conflict", () => {
    assert.equal(sameStream(copy, stranger), false);
    assert.equal(sameStream(original, stranger), false);
    assert.equal(sameStream(null, copy), false);
});

test("the tag is read defensively", () => {
    assert.deepEqual(aliasIds({ tags: { [ALIAS_TAG]: ["a", 3, "", "b"] } }), ["a", "b"]);
    assert.deepEqual(aliasIds({ tags: { [ALIAS_TAG]: "a" } }), []);
    assert.deepEqual(aliasIds({}), []);
});

test("the DUP badge counts only owners that are a different stream", () => {
    const senders = { orig: original, copy, back: routedBack, x: stranger };
    const same = (a, b) => sameStream(senders[a], senders[b]);
    const owners = [
        { id: "nmos_orig", nmosId: "orig", label: "Arkona / REF TX 1" },
        { id: "nmos_back", nmosId: "back", label: "Studio1 / REF TX 1" },
    ];
    // An original and its copy routed back: one stream, no badge on either.
    assert.deepEqual(clashingOwners("nmos_orig", "orig", owners, same), []);
    assert.deepEqual(clashingOwners("nmos_back", "back", owners, same), []);
    // A stranger on the same group still clashes with both.
    const withStranger = [...owners, { id: "nmos_x", nmosId: "x", label: "Other / X" }];
    assert.deepEqual(clashingOwners("nmos_orig", "orig", withStranger, same).map((o) => o.label), ["Other / X"]);
    assert.deepEqual(clashingOwners("nmos_x", "x", withStranger, same).length, 2);
});
