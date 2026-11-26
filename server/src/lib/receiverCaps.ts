/*
 * BCP-004-01 Receiver Capabilities, evaluated against a Sender's Flow — free
 * of state so it can be tested. BCP-007-03 requires a Controller to use this
 * mechanism to decide which MXL flows an MXL receiver can take;
 * CrosspointAbstraction applies it during enrichment and the matrix, the
 * matcher and the UI preview only compare the results (capSig / capOk).
 */
import * as crypto from "crypto";

const C = "urn:x-nmos:cap:format:";

/**
 * The Flow attributes Parameter Constraints test against, keyed by the
 * constraint's URN from the Capabilities register. Absent attributes stay
 * absent: a constraint whose target is unknown cannot be evaluated and is
 * ignored (BCP-004-01, Behaviour: Controllers). A video Flow's interlace_mode
 * is the exception: IS-04 gives it a default, so it is never unknown.
 */
/**
 * The Flow's grain rate, else its Source's: IS-04 makes the Flow's optional —
 * the Source's is the rate of the Flows derived from it, which a Flow "may
 * override". Normalised to { numerator, denominator } (denominator defaults
 * to 1). Null when neither gives a usable one.
 */
export function flowGrainRate(flow: any, source: any): { numerator: number, denominator: number } | null {
    for (const r of [flow?.grain_rate, source?.grain_rate]) {
        if (r && typeof r.numerator === "number" && r.numerator > 0) {
            const d = (typeof r.denominator === "number" && r.denominator > 0) ? r.denominator : 1;
            return { numerator: r.numerator, denominator: d };
        }
    }
    return null;
}

/** The format values the format string and bitrate switches read as video:
 *  the IS-04 URN and the legacy spellings some Nodes still publish. */
const VIDEO_FORMATS = ["urn:x-nmos:format:video", "video", "video/raw"];

/**
 * The Flow's interlace_mode, "progressive" where a video Flow omits it: IS-04
 * flow_video gives the attribute that default. Undefined for a Flow that is
 * not video, which has no scan.
 */
export function flowInterlaceMode(flow: any): string | undefined {
    if (!flow) return undefined;
    if (typeof flow.interlace_mode === "string" && flow.interlace_mode !== "") return flow.interlace_mode;
    const video = VIDEO_FORMATS.includes(flow.format) ||
        (flow.format === undefined && typeof flow.frame_width === "number");
    return video ? "progressive" : undefined;
}

/** The scan of a format string, "1920x1080p50": p, psf or i. */
export function scanLetter(flow: any): string {
    const m = flowInterlaceMode(flow);
    if (m === "progressive") return "p";
    if (m === "interlaced_psf") return "psf";
    return "i";
}

export function flowCapAttrs(flow: any, source: any): { [cap: string]: any } {
    const a: { [cap: string]: any } = {};
    if (!flow) return a;
    const set = (k: string, v: any) => { if (v !== undefined && v !== null && v !== "") { a[C + k] = v; } };
    set("media_type", flow.media_type);
    set("grain_rate", flowGrainRate(flow, source));
    set("frame_width", flow.frame_width);
    set("frame_height", flow.frame_height);
    set("interlace_mode", flowInterlaceMode(flow));
    set("colorspace", flow.colorspace);
    set("transfer_characteristic", flow.transfer_characteristic);
    set("sample_rate", flow.sample_rate);
    set("sample_depth", flow.bit_depth);
    set("event_type", flow.event_type);
    if (Array.isArray(flow.components) && flow.components.length > 0) {
        set("component_depth", flow.components[0]?.bit_depth);
        set("color_sampling", colorSampling(flow.components));
    }
    if (Array.isArray(source?.channels)) { set("channel_count", source.channels.length); }
    return a;
}

/** "YCbCr-4:2:2" etc. from IS-04 components (the Capabilities register
 *  values); "" when the layout is not one of the common ones. */
export function colorSampling(components: any[]): string {
    const by: any = {};
    for (const c of components || []) { if (c && c.name) { by[c.name] = c; } }
    if (by.R && by.G && by.B) return "RGB";
    if (by.Y && by.Cb && by.Cr) {
        const w = by.Cb.width / by.Y.width, h = by.Cb.height / by.Y.height;
        if (w === 1 && h === 1) return "YCbCr-4:4:4";
        if (w === 0.5 && h === 1) return "YCbCr-4:2:2";
        if (w === 0.5 && h === 0.5) return "YCbCr-4:2:0";
        if (w === 0.25 && h === 1) return "YCbCr-4:1:1";
    }
    return "";
}

/** Short, stable identity of a set of flow attributes. */
export function capSignature(attrs: { [cap: string]: any }): string {
    const keys = Object.keys(attrs).sort();
    return crypto.createHash("md5").update(JSON.stringify(keys.map((k) => [k, attrs[k]]))).digest("hex").substring(0, 12);
}

/**
 * The signatures (keys of `sigs`) whose attributes a Receiver's caps accept.
 * IS-04 `media_types` / `event_types` and BCP-004-01 `constraint_sets` must
 * ALL be satisfied; within each, ANY alternative. No caps accepts everything.
 */
export function acceptedSignatures(caps: any, sigs: { [sig: string]: { [cap: string]: any } }): string[] {
    const c = caps || {};
    const ok: string[] = [];
    for (const sig of Object.keys(sigs)) {
        const a = sigs[sig];
        if (Array.isArray(c.media_types) && a[C + "media_type"] !== undefined && !c.media_types.includes(a[C + "media_type"])) continue;
        if (Array.isArray(c.event_types) && a[C + "event_type"] !== undefined && !c.event_types.includes(a[C + "event_type"])) continue;
        if (Array.isArray(c.constraint_sets)) {
            // meta:enabled false: "A Controller MUST NOT take into consideration"
            const live = c.constraint_sets.filter((cs: any) => cs && cs["urn:x-nmos:cap:meta:enabled"] !== false);
            // "When the list is empty, or none of the Constraint Sets are
            // satisfied, the constraint_sets as a whole is not satisfied."
            if (!live.some((cs: any) => constraintSetSatisfied(cs, a))) continue;
        }
        ok.push(sig);
    }
    return ok;
}

/** All of its Parameter Constraints; metadata and constraints that cannot be
 *  evaluated are skipped, so a set with nothing evaluable is satisfied. */
export function constraintSetSatisfied(cs: any, attrs: { [cap: string]: any }): boolean {
    for (const key of Object.keys(cs || {})) {
        if (key.startsWith("urn:x-nmos:cap:meta:")) continue;
        if (!(key in attrs)) continue;
        if (!parameterConstraintSatisfied(cs[key], attrs[key])) return false;
    }
    return true;
}

/** enum / minimum / maximum; rationals compared by cross-multiplication, as
 *  BCP-004-01 asks, taking account of negative denominators. */
export function parameterConstraintSatisfied(c: any, value: any): boolean {
    if (!c || typeof c !== "object") return true;
    const isRational = (v: any) => v && typeof v === "object" && typeof v.numerator === "number";
    const cmp = (x: any, y: any): number => {
        if (isRational(x) || isRational(y)) {
            const xn = isRational(x) ? x.numerator : x, xd = isRational(x) ? (x.denominator || 1) : 1;
            const yn = isRational(y) ? y.numerator : y, yd = isRational(y) ? (y.denominator || 1) : 1;
            const sign = (xd * yd) < 0 ? -1 : 1;
            return sign * (xn * yd - yn * xd);
        }
        return (typeof x === "number" && typeof y === "number") ? (x - y) : (x === y ? 0 : NaN);
    };
    if (Array.isArray(c.enum) && !c.enum.some((e: any) => cmp(e, value) === 0)) return false;
    if (c.minimum !== undefined && !(cmp(value, c.minimum) >= 0)) return false;
    if (c.maximum !== undefined && !(cmp(value, c.maximum) <= 0)) return false;
    return true;
}

// ----- Receiver capabilities as text, for the matrix hover pill -----

/** Most lines capsSummary returns; more sets end in a "+n more" line. */
export const MAX_CAP_LINES = 10;

/** One Parameter Constraint as text: "a/b" for an enum, "a–b" ("a" when both
 *  ends are equal), "≤b", "≥a". */
export function capParamShort(cons: any, mapVal?: (v: any) => string): string {
    if (!cons || typeof cons !== "object") return "";
    const mv = mapVal || ((v: any) => "" + v);
    try {
        // Values that read the same once shortened show once ("i", not "i/i").
        if (Array.isArray(cons.enum) && cons.enum.length > 0) return [...new Set(cons.enum.map(mv))].join("/");
        const hasMin = cons.minimum !== undefined && cons.minimum !== null;
        const hasMax = cons.maximum !== undefined && cons.maximum !== null;
        if (hasMin && hasMax) {
            return cons.minimum === cons.maximum ? mv(cons.minimum) : mv(cons.minimum) + "–" + mv(cons.maximum);
        }
        if (hasMax) return "≤" + mv(cons.maximum);
        if (hasMin) return "≥" + mv(cons.minimum);
    } catch (e) {}
    return "";
}

/** BCP-004 rational: 48000 → "48k", frame rates stay plain ("50", "59.94"). */
export function ratShort(v: any): string {
    if (v && typeof v === "object" && typeof v.numerator === "number") {
        const d = (typeof v.denominator === "number" && v.denominator > 0) ? v.denominator : 1;
        const n = v.numerator / d;
        if (n >= 1000 && n % 1000 === 0) return (n / 1000) + "k";
        return (Math.round(n * 100) / 100) + "";
    }
    return "" + v;
}

/**
 * "audio/L24" → "L24", "video/jxsv" → "jxsv". The subtype alone is enough
 * everywhere except uncompressed media: "raw" says nothing, "raw video" does.
 */
export function mediaTypeShort(mt: any): string {
    const s = "" + mt;
    const i = s.indexOf("/");
    const sub = i >= 0 ? s.substring(i + 1) : s;
    if (sub === "raw") {
        const top = i >= 0 ? s.substring(0, i) : "";
        if (top === "video") return "raw video";
        if (top === "audio") return "raw audio";
        return "raw";
    }
    return sub;
}

/**
 * A constraint set's own label (urn:x-nmos:cap:meta:label), shortened, or ""
 * when it adds nothing to the line:
 *  - "Hardware maximum and minimum …" only announces the ranges the line
 *    shows anyway;
 *  - "packet time" becomes "ptime", "num channels" "channels",
 *    "millisecond(s)" "ms";
 *  - a label that then only states ptime and channel count is dropped when
 *    the line itself shows both (`shows`).
 */
export function shortCapLabel(label: any, shows: { ptime: boolean, channels: boolean } = { ptime: false, channels: false }): string {
    if (typeof label !== "string") return "";
    let s = label.trim();
    if (s === "" || /^hardware maximum and minimum\b/i.test(s)) return "";
    s = s.replace(/packet\s*time(\s+of)?/gi, "ptime")
         .replace(/num(ber\s+of)?\s*channels/gi, "channels")
         .replace(/\bmilliseconds?\b/gi, "ms");
    const onlyPtimeAndChannels = s.replace(/\b(ptime|channels?|ms|with|and)\b/gi, "").replace(/[\d.,:;\s]/g, "") === "";
    if (onlyPtimeAndChannels && shows.ptime && shows.channels) return "";
    return s;
}

/**
 * A receiver's caps as hover text: one line per enabled constraint set,
 * "\n"-separated, the set's label in front when it says something, e.g.
 *   "L24 · 48k · 16/24bit · 1–64ch · ptime 0.125ms"
 *   "1080i: raw video · 1920×1080 · 25fps · i"
 *   "raw video · 1280–5120×720–2880 · 4:2:2 · 10bit" (sampling and depth
 *   only where the receiver's sets differ in them)
 * Sets that read the same (they differ in something not shown) appear once.
 * Falls back to caps.media_types when no constraint sets are published.
 */
export function capsSummary(caps: any): string {
    if (!caps) return "";
    const T = "urn:x-nmos:cap:transport:";
    const sets: any[] = Array.isArray(caps.constraint_sets) ? caps.constraint_sets : [];
    const rows: { label: string, head: string[], look: string[], tail: string[] }[] = [];
    for (const set of sets) {
        if (!set || typeof set !== "object") continue;
        if (set["urn:x-nmos:cap:meta:enabled"] === false) continue;
        const p: string[] = [];
        const mt = capParamShort(set[C + "media_type"], mediaTypeShort);
        if (mt) p.push(mt);
        // Audio
        const rate = capParamShort(set[C + "sample_rate"], ratShort);
        if (rate) p.push(rate);
        const depth = capParamShort(set[C + "sample_depth"]);
        if (depth) p.push(depth + "bit");
        const ch = capParamShort(set[C + "channel_count"]);
        if (ch) p.push(ch + "ch");
        // Video
        const w = capParamShort(set[C + "frame_width"]);
        const h = capParamShort(set[C + "frame_height"]);
        if (w && h) p.push(w + "×" + h);
        else if (w) p.push(w + "px");
        const fr = capParamShort(set[C + "grain_rate"], ratShort);
        if (fr) p.push(fr + "fps");
        const il = capParamShort(set[C + "interlace_mode"], (v: any) => {
            const s = "" + v;
            if (s === "progressive") return "p";
            if (s.startsWith("interlaced")) return "i";
            return s;
        });
        if (il) p.push(il);
        // Sampling and depth ("4:2:2 · 10bit"): shown below only where the
        // sets of this receiver differ in them.
        const look: string[] = [];
        const cs = capParamShort(set[C + "color_sampling"], (v: any) => ("" + v).replace(/^YCbCr-/, ""));
        if (cs) look.push(cs);
        const cd = capParamShort(set[C + "component_depth"]);
        if (cd) look.push(cd + "bit");
        // Transport: always shown — a 1 ms receiver cannot take a 125 µs
        // stream, and two sets often differ in nothing else.
        const tail: string[] = [];
        const pt = capParamShort(set[T + "packet_time"]);
        if (pt) tail.push("ptime " + pt + "ms");
        if (p.length + look.length + tail.length === 0) continue;
        rows.push({ label: shortCapLabel(set["urn:x-nmos:cap:meta:label"], { ptime: !!pt, channels: !!ch }), head: p, look, tail });
    }
    const looksDiffer = new Set(rows.map(r => r.look.join(" · "))).size > 1;
    let lines = rows.map(r => (r.label ? r.label + ": " : "") + r.head.concat(looksDiffer ? r.look : [], r.tail).join(" · "));
    lines = lines.filter((l, i) => lines.indexOf(l) === i);
    if (lines.length > MAX_CAP_LINES) {
        const more = lines.length - (MAX_CAP_LINES - 1);
        lines = lines.slice(0, MAX_CAP_LINES - 1).concat(["+" + more + " more"]);
    }
    if (lines.length === 0 && Array.isArray(caps.media_types) && caps.media_types.length > 0) {
        return caps.media_types.map(mediaTypeShort).join("/");
    }
    return lines.join("\n");
}
