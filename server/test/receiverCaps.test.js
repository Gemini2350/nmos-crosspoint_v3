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

// ----- hover text (capsSummary) -----
const T = "urn:x-nmos:cap:transport:";
const L = "urn:x-nmos:cap:meta:label";

test("device labels are shortened, or dropped when they add nothing", () => {
    const shows = { ptime: true, channels: true };
    assert.equal(rc.shortCapLabel("Hardware maximum and minimum resolution", shows), "");
    assert.equal(rc.shortCapLabel("packet time: 1 ms; num channels: 2", shows), "");
    assert.equal(rc.shortCapLabel("Packet time of 0.125 milliseconds with 8 channels", shows), "");
    // the line lacks one of them: keep the label, shortened
    assert.equal(rc.shortCapLabel("packet time: 1 ms; num channels: 2", { ptime: true, channels: false }), "ptime: 1 ms; channels: 2");
    assert.equal(rc.shortCapLabel("Packet time of 1 millisecond with 4 channels", { ptime: false, channels: true }), "ptime 1 ms with 4 channels");
    assert.equal(rc.shortCapLabel("Custom resolutions", shows), "Custom resolutions");
    assert.equal(rc.shortCapLabel("1080i", shows), "1080i");
    assert.equal(rc.shortCapLabel(undefined, shows), "");
});

test("ptime tells apart sets that differ in nothing else", () => {
    const set = (pt) => ({ [C + "sample_rate"]: { enum: [{ numerator: 48000 }] }, [C + "sample_depth"]: { enum: [16, 24] },
        [C + "channel_count"]: { minimum: 1, maximum: 64 }, [T + "packet_time"]: { enum: [pt] } });
    assert.equal(rc.capsSummary({ constraint_sets: [set(0.125), set(1)] }),
        "48k · 16/24bit · 1–64ch · ptime 0.125ms\n48k · 16/24bit · 1–64ch · ptime 1ms");
});

test("a Q-SYS style label goes, an equal range reads as one value", () => {
    const caps = { constraint_sets: [{ [C + "channel_count"]: { maximum: 2, minimum: 2 }, [C + "sample_depth"]: { enum: [16, 24] },
        [C + "sample_rate"]: { enum: [{ denominator: 1, numerator: 48000 }] }, [L]: "packet time: 1 ms; num channels: 2", [T + "packet_time"]: { enum: [1] } }] };
    assert.equal(rc.capsSummary(caps), "48k · 16/24bit · 2ch · ptime 1ms");
});

test("sampling and depth show where the sets differ in them; sets that still read the same appear once", () => {
    const set = (cs, cd, extra) => Object.assign({ [C + "media_type"]: { enum: ["video/raw"] }, [C + "frame_width"]: { minimum: 1280, maximum: 5120 },
        [C + "frame_height"]: { minimum: 720, maximum: 2880 }, [C + "color_sampling"]: { enum: cs }, [C + "component_depth"]: { enum: cd },
        [L]: "Hardware maximum and minimum resolution" }, extra || {});
    const caps = { constraint_sets: [set(["RGB", "YCbCr-4:4:4"], [8, 10]), set(["YCbCr-4:2:2"], [10]),
        set(["YCbCr-4:2:2"], [10], { [T + "hkep"]: { enum: [true] } })] };
    assert.equal(rc.capsSummary(caps),
        "raw video · 1280–5120×720–2880 · RGB/4:4:4 · 8/10bit\nraw video · 1280–5120×720–2880 · 4:2:2 · 10bit");
});

test("disabled sets are skipped, many sets end in +n more, no sets fall back to media_types", () => {
    const one = (w) => ({ [C + "media_type"]: { enum: ["video/raw"] }, [C + "frame_width"]: { enum: [w] } });
    const many = { constraint_sets: Array.from({ length: 14 }, (_, i) => one(100 + i)) };
    const lines = rc.capsSummary(many).split("\n");
    assert.equal(lines.length, rc.MAX_CAP_LINES);
    assert.equal(lines[lines.length - 1], "+5 more");
    assert.equal(rc.capsSummary({ constraint_sets: [Object.assign(one(1), { "urn:x-nmos:cap:meta:enabled": false }), one(2)] }), "raw video · 2px");
    assert.equal(rc.capsSummary({ media_types: ["audio/L24", "video/raw"] }), "L24/raw video");
    assert.equal(rc.capsSummary(null), "");
});

test("sampling and depth all sets share stay out; i and i read once", () => {
    const set = (h, il) => ({ [C + "frame_width"]: { enum: [1920] }, [C + "frame_height"]: { enum: [h] }, [C + "interlace_mode"]: { enum: il },
        [C + "color_sampling"]: { enum: ["YCbCr-4:2:2"] }, [C + "component_depth"]: { enum: [10] } });
    assert.equal(rc.capsSummary({ constraint_sets: [set(1080, ["interlaced_tff", "interlaced_bff"]), set(1080, ["progressive"])] }),
        "1920×1080 · i\n1920×1080 · p");
});

// ----- grain rate (IS-04: optional on the Flow, then the Source's) -----

test("the grain rate is the Flow's, else its Source's", () => {
    assert.deepEqual(rc.flowGrainRate({ grain_rate: { numerator: 50, denominator: 1 } }, { grain_rate: { numerator: 25 } }), { numerator: 50, denominator: 1 });
    // an AJA flow without grain_rate, the Source has 25/1
    assert.deepEqual(rc.flowGrainRate({}, { grain_rate: { numerator: 25, denominator: 1 } }), { numerator: 25, denominator: 1 });
    assert.deepEqual(rc.flowGrainRate({ grain_rate: { numerator: 30000, denominator: 1001 } }, null), { numerator: 30000, denominator: 1001 });
    assert.deepEqual(rc.flowGrainRate({ grain_rate: { numerator: 25 } }, null), { numerator: 25, denominator: 1 });
    assert.equal(rc.flowGrainRate({}, {}), null);
    assert.equal(rc.flowGrainRate({ grain_rate: { numerator: 0 } }, null), null);
    assert.equal(rc.flowGrainRate(null, null), null);
});

test("a receiver's grain_rate constraint is checked against the Source's rate when the Flow has none", () => {
    const flow = { media_type: "video/raw", frame_width: 1920, frame_height: 1080, interlace_mode: "progressive" };
    const attrs = rc.flowCapAttrs(flow, { grain_rate: { numerator: 25, denominator: 1 } });
    assert.deepEqual(attrs[C + "grain_rate"], { numerator: 25, denominator: 1 });
    const only50 = { constraint_sets: [{ [C + "grain_rate"]: { enum: [{ numerator: 50, denominator: 1 }] } }] };
    assert.equal(rc.constraintSetSatisfied(only50.constraint_sets[0], attrs), false);
});

test("a video Flow without interlace_mode is progressive, the IS-04 default", () => {
    const flow = { format: "urn:x-nmos:format:video", media_type: "video/v210", frame_width: 1920, frame_height: 1080,
        grain_rate: { numerator: 50, denominator: 1 } };
    // A receiver that takes progressive only accepts it, and refuses the interlaced one.
    const progressiveOnly = { [C + "interlace_mode"]: { enum: ["progressive"] } };
    const tff = { ...flow, interlace_mode: "interlaced_tff" };
    assert.equal(rc.constraintSetSatisfied(progressiveOnly, rc.flowCapAttrs(tff, null)), false);
    assert.equal(rc.flowCapAttrs(flow, null)[C + "interlace_mode"], "progressive");
    assert.equal(rc.constraintSetSatisfied(progressiveOnly, rc.flowCapAttrs(flow, null)), true);
    // The matrix shows it as p, not i.
    assert.equal(rc.flowInterlaceMode(flow), "progressive");
    assert.equal(rc.scanLetter(flow), "p");
});

test("a stated interlace_mode is kept, and only video has one", () => {
    const flow = { media_type: "video/raw", frame_width: 1920, frame_height: 1080 };
    assert.equal(rc.scanLetter({ ...flow, interlace_mode: "progressive" }), "p");
    assert.equal(rc.scanLetter({ ...flow, interlace_mode: "interlaced_tff" }), "i");
    assert.equal(rc.scanLetter({ ...flow, interlace_mode: "interlaced_bff" }), "i");
    assert.equal(rc.scanLetter({ ...flow, interlace_mode: "interlaced_psf" }), "psf");
    assert.equal(rc.flowInterlaceMode({ format: "urn:x-nmos:format:audio", media_type: "audio/L24" }), undefined);
    assert.equal(rc.flowInterlaceMode({ format: "urn:x-nmos:format:data", media_type: "video/smpte291" }), undefined);
    assert.equal(C + "interlace_mode" in rc.flowCapAttrs({ media_type: "audio/L24" }, null), false);
    assert.equal(rc.flowInterlaceMode(null), undefined);
    // The legacy format spellings the format string and bitrate read as video.
    assert.equal(rc.flowInterlaceMode({ format: "video", frame_width: 1920 }), "progressive");
    assert.equal(rc.flowInterlaceMode({ format: "video/raw", frame_width: 1920 }), "progressive");
});
