// BCP-004-01 evaluation behind the MXL crosspoint (BCP-007-03).
const test = require("node:test");
const assert = require("node:assert");
const rc = require("../dist/lib/receiverCaps.js");

const C = "urn:x-nmos:cap:format:";
const v210_1080p60 = rc.flowCapAttrs({
    media_type: "video/v210", frame_width: 1920, frame_height: 1080, interlace_mode: "progressive",
    grain_rate: { numerator: 60, denominator: 1 },
    components: [{ name: "Y", width: 1920, height: 1080, bit_depth: 10 }, { name: "Cb", width: 960, height: 1080, bit_depth: 10 }, { name: "Cr", width: 960, height: 1080, bit_depth: 10 }],
}, null);
const sigs = { v: v210_1080p60 };

test("flow attributes are keyed by Capabilities register URNs", () => {
    assert.equal(v210_1080p60[C + "media_type"], "video/v210");
    assert.equal(v210_1080p60[C + "color_sampling"], "YCbCr-4:2:2");
    assert.equal(v210_1080p60[C + "component_depth"], 10);
    assert.equal(C + "colorspace" in v210_1080p60, false);   // absent stays absent
});

test("media_types alone decide when there are no constraint sets", () => {
    assert.deepEqual(rc.acceptedSignatures({ media_types: ["video/v210"] }, sigs), ["v"]);
    assert.deepEqual(rc.acceptedSignatures({ media_types: ["video/v210a"] }, sigs), []);
    assert.deepEqual(rc.acceptedSignatures(undefined, sigs), ["v"]);   // no caps, no limits
});

test("a constraint set needs all its constraints, the list any of its sets", () => {
    const fits = { [C + "frame_width"]: { enum: [1920] }, [C + "grain_rate"]: { enum: [{ numerator: 60, denominator: 1 }] } };
    const wrongRate = { [C + "grain_rate"]: { enum: [{ numerator: 50, denominator: 1 }] } };
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [fits] }, sigs), ["v"]);
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [wrongRate] }, sigs), []);
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [wrongRate, fits] }, sigs), ["v"]);
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [] }, sigs), []);   // empty list: not satisfied
});

test("disabled sets are ignored, unknown constraints too", () => {
    const fitsButOff = { [C + "frame_width"]: { enum: [1920] }, "urn:x-nmos:cap:meta:enabled": false };
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [fitsButOff] }, sigs), []);
    const onlyUnknown = { "urn:x-acme:cap:secret_sauce": { enum: ["yes"] }, [C + "colorspace"]: { enum: ["BT2020"] } };
    assert.deepEqual(rc.acceptedSignatures({ constraint_sets: [onlyUnknown] }, sigs), ["v"]);   // nothing evaluable: satisfied
});

test("rationals compare by cross-multiplication, ranges are inclusive", () => {
    const rate = { numerator: 60000, denominator: 1001 };
    assert.equal(rc.parameterConstraintSatisfied({ enum: [{ numerator: 60000, denominator: 1001 }] }, rate), true);
    assert.equal(rc.parameterConstraintSatisfied({ minimum: { numerator: 50 }, maximum: { numerator: 60 } }, rate), true);
    assert.equal(rc.parameterConstraintSatisfied({ maximum: { numerator: 59 } }, rate), false);   // 59.94 > 59
    assert.equal(rc.parameterConstraintSatisfied({ maximum: { numerator: 60 } }, rate), true);
    assert.equal(rc.parameterConstraintSatisfied({ minimum: 1920 }, 1920), true);
    assert.equal(rc.parameterConstraintSatisfied({ enum: [3840] }, 1920), false);
});
