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
 * ignored (BCP-004-01, Behaviour: Controllers).
 */
export function flowCapAttrs(flow: any, source: any): { [cap: string]: any } {
    const a: { [cap: string]: any } = {};
    if (!flow) return a;
    const set = (k: string, v: any) => { if (v !== undefined && v !== null && v !== "") { a[C + k] = v; } };
    set("media_type", flow.media_type);
    set("grain_rate", flow.grain_rate);
    set("frame_width", flow.frame_width);
    set("frame_height", flow.frame_height);
    set("interlace_mode", flow.interlace_mode);
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
