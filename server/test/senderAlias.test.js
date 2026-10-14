// Senders declaring themselves the same stream (NMOS Federation pass-through copies).
const test = require("node:test");
const assert = require("node:assert");
const { aliasIds, sameStream, ALIAS_TAG } = require("../dist/lib/senderAlias.js");

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
