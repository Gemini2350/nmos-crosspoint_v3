// The virtual Node's devices and where it registers.
const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../dist/lib/virtualDevices.js");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let n = 0;
const mk = () => "aaaaaaaa-0000-4000-8000-" + String(++n).padStart(12, "0");

test("settings from before: the one device virtualNode.deviceId named holds the senders", () => {
    assert.deepEqual(v.normaliseVirtualDevices(undefined, U1, mk), [{ id: U1, name: "Virtual Senders" }]);
    // every device removed: none, unless senders are left without one
    assert.deepEqual(v.normaliseVirtualDevices([], U1, mk), []);
    assert.deepEqual(v.normaliseVirtualDevices([], U1, mk, 2), [{ id: U1, name: "Virtual Senders" }]);
});

test("devices are checked: ids unique and UUIDs, names given", () => {
    n = 0;
    const d = v.normaliseVirtualDevices([{ id: U1, name: " Playout " }, { id: U1, name: "Twin" }, { id: "nope", name: "" }, null], U2, mk);
    assert.deepEqual(d, [
        { id: U1, name: "Playout" },
        { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Twin" },
        { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Virtual Device 3" },
    ]);
});

test("a sender keeps its device, or goes to the first one", () => {
    const devs = [{ id: U1, name: "A" }, { id: U2, name: "B" }];
    assert.deepEqual(v.assignSenderDevices([{ name: "x", deviceId: U2 }, { name: "y" }, { name: "z", deviceId: "gone" }], devs).map((s) => s.deviceId), [U2, U1, U1]);
});

test("the page's devices: existing ones keep their id, new ones get one", () => {
    n = 0;
    const r = v.devicesFromInput([{ key: U1, name: "Playout" }, { key: "new:1", name: "SDI" }, { key: "new:1", name: "dup" }, { key: "", name: "x" }],
        [{ id: U1, name: "Old" }], mk);
    assert.deepEqual(r.devices, [{ id: U1, name: "Playout" }, { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "SDI" }]);
    assert.deepEqual(r.keyToId, { [U1]: U1, "new:1": "aaaaaaaa-0000-4000-8000-000000000001" });
    // a key that looks like an id but was never a device is new
    n = 0;
    assert.equal(v.devicesFromInput([{ key: U2, name: "X" }], [{ id: U1, name: "Old" }], mk).devices[0].id, "aaaaaaaa-0000-4000-8000-000000000001");
});

test("registration: the registry by default, or a registration API of its own", () => {
    assert.deepEqual(v.normaliseRegistration(undefined), { mode: "registry", host: "", port: 0 });
    assert.deepEqual(v.registrationFromInput({ mode: "custom", host: " 10.0.100.112 ", port: "3210" }), { mode: "custom", host: "10.0.100.112", port: 3210 });
    assert.deepEqual(v.registrationFromInput({ mode: "registry", host: "", port: "" }), { mode: "registry", host: "", port: 0 });
    assert.throws(() => v.registrationFromInput({ mode: "custom", host: "", port: 3210 }), /IP or host name/);
    assert.throws(() => v.registrationFromInput({ mode: "custom", host: "a b", port: 3210 }), /Not an IP/);
    assert.throws(() => v.registrationFromInput({ mode: "custom", host: "reg.example", port: 70000 }), /between 1 and 65535/);
});

test("the base URL, IPv6 in brackets", () => {
    assert.equal(v.httpBase("10.0.0.1", 3210), "http://10.0.0.1:3210");
    assert.equal(v.httpBase("fd00::1", 3210), "http://[fd00::1]:3210");
    assert.equal(v.httpBase("[fd00::1]", 3210), "http://[fd00::1]:3210");
});
