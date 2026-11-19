// A device that adds a sender or receiver after the controller walked its
// model announces it with a PropertyChanged on NcBlock.members. IS-04 v1.3
// leaves the Device resource unchanged then, so this notification is the
// only trigger for a re-walk; missing it leaves the new monitor unshown.
const test = require("node:test");
const assert = require("node:assert");
const { isBlockMembersChange } = require("../dist/lib/bcp008Monitor.js");

function propertyChanged(oid, level, index) {
    return { oid, eventId: { level: 1, index: 1 },
             eventData: { propertyId: { level, index }, changeType: 0, value: [], sequenceItemIndex: null } };
}

test("a change of NcBlock.members (2p2) is a members change", () => {
    assert.equal(isBlockMembersChange(propertyChanged(5, 2, 2)), true);
});

test("a change of NcBlock.enabled (2p1) is not", () => {
    assert.equal(isBlockMembersChange(propertyChanged(5, 2, 1)), false);
});

test("a status change of a monitor is not", () => {
    assert.equal(isBlockMembersChange(propertyChanged(7, 3, 1)), false);
    assert.equal(isBlockMembersChange({ oid: 5 }), false);
});
