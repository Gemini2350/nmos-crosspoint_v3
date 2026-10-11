// IS-13 NMOS Annotation: discovery, paths and the label PATCH.
const test = require("node:test");
const assert = require("node:assert");
const a = require("../dist/lib/annotation.js");

test("the Annotation API is found in the Node's services, newest version first", () => {
    const node = { services: [
        { type: "urn:x-nmos:service:mqtt", href: "mqtt://x" },
        { type: "urn:x-nmos:service:annotation/v1.0", href: "http://10.0.0.5/x-nmos/annotation/v1.0" },
        { type: "urn:x-nmos:service:annotation/v1.1", href: "http://10.0.0.5/x-nmos/annotation/v1.1/" },
    ] };
    assert.equal(a.annotationHref(node), "http://10.0.0.5/x-nmos/annotation/v1.1/");
    assert.equal(a.annotationHref({ services: [{ type: "urn:x-nmos:service:annotation/v1.0", href: "http://h/x-nmos/annotation/v1.0" }] }),
        "http://h/x-nmos/annotation/v1.0/");
    assert.equal(a.annotationHref({ services: [] }), "");
    assert.equal(a.annotationHref(null), "");
});

test("paths follow the Annotation API", () => {
    assert.equal(a.annotationPath("node", "x"), "node/self");
    assert.equal(a.annotationPath("device", "d1"), "node/devices/d1");
    assert.equal(a.annotationPath("sender", "s1"), "node/senders/s1");
    assert.equal(a.annotationPath("receiver", "r1"), "node/receivers/r1");
});

test("a label PATCH carries only the label; null resets, empty is refused", () => {
    assert.deepEqual(a.buildLabelPatch("  Cam 1  "), { label: "Cam 1" });
    assert.deepEqual(a.buildLabelPatch(null), { label: null });
    assert.throws(() => a.buildLabelPatch("   "), /reset/);
});

test("the device's error field is what the user is told", () => {
    assert.equal(a.annotationErrorText(400, { code: 400, error: "label too long", debug: null }, "x"), "Device answered 400: label too long");
    assert.equal(a.annotationErrorText(500, { error: "boom", debug: "trace" }, "x"), "Device answered 500: boom (trace)");
    assert.equal(a.annotationErrorText(undefined, null, "unreachable"), "unreachable");
});
