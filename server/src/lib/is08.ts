/*
 * AMWA IS-08 Audio Channel Mapping — the pure parts, free of state and I/O so
 * they can be tested.
 *
 * A device lists the Channel Mapping API among its IS-04 `controls`. The API
 * has inputs (channels from a receiver, a source or nothing NMOS at all, e.g.
 * an analogue input) and outputs (channels that make up a source, which a
 * sender transmits, or nothing NMOS, e.g. headphones). The active map says, per
 * output channel, which input channel feeds it, or none.
 *
 * buildChannelMapView turns /io and /map/active into what the Details page
 * shows: inputs and outputs with names resolved to the senders and receivers
 * the operator knows, and per output the runs of channels that come from one
 * input. checkOutputMap and mapAction check a change of one output against
 * the device's capabilities and build the body of its activation (step 3,
 * switching). Nothing here talks to a device.
 */

export const CM_CTRL_TYPE = "urn:x-nmos:control:cm-ctrl/v1.0";

/** Every Channel Mapping API href of a device, in the device's order. */
export function channelMapHrefs(controls: any): string[] {
    if (!Array.isArray(controls)) return [];
    return controls
        .filter((c: any) => c && c.type === CM_CTRL_TYPE && typeof c.href === "string" && c.href)
        .map((c: any) => c.href as string);
}

/** Names the view is resolved against: the crosspoint's own names, aliases
 *  included, so the Channel Map reads like the rest of the page. */
export interface ChannelMapLookup {
    /** Display name of a receiver, undefined when unknown. */
    receiverName(id: string): string | undefined;
    /** Senders that transmit this source (its flows), with their display names. */
    sourceSenders(sourceId: string): Array<{ id: string, name: string }>;
    /** Label of an IS-04 source, undefined when unknown. */
    sourceLabel(sourceId: string): string | undefined;
    /** A receiver of this device currently taking this source, if any. IS-08
     *  lets an input name the originating source instead of its receiver. */
    receiverOfSource(sourceId: string): { id: string, name: string } | undefined;
}

export interface ChannelMapInput {
    id: string;
    /** What the operator knows it by: the receiver, the source's sender, or
     *  the device's own name for a local input. */
    name: string;
    /** The device's own name for the input when that differs from `name`. */
    deviceName: string;
    kind: "receiver" | "source" | "local";
    /** The receiver whose channels these are, when known. */
    receiverId: string | null;
    channels: string[];
    /** caps.reordering: false = the channels keep their order and spacing
     *  within an output (one fixed offset). */
    reordering: boolean;
    /** caps.block_size: channels route in whole blocks of this size. */
    blockSize: number;
}

export interface ChannelMapChannel {
    /** The device's label for the output channel. */
    label: string;
    /** Input id feeding it; null when unrouted (muted). */
    input: string | null;
    /** 1-based channel of that input; null when unrouted. */
    inputChannel: number | null;
}

export interface ChannelMapOutput {
    id: string;
    name: string;
    deviceName: string;
    kind: "sender" | "source" | "local";
    sourceId: string | null;
    senderIds: string[];
    channels: ChannelMapChannel[];
    /** caps.routable_inputs without its null entry: the inputs that may feed
     *  this output; null = any input. */
    routable: string[] | null;
    /** Channels may be unrouted (silent): routable_inputs null, or listing null. */
    mayMute: boolean;
}

export interface ChannelMapView {
    inputs: ChannelMapInput[];
    outputs: ChannelMapOutput[];
}

/** A run of output channels fed by consecutive channels of one input. All
 *  numbers 1-based; `input` null with `from`/`to` null is a muted run. */
export interface ChannelMapSegment {
    input: string | null;
    name: string | null;
    from: number | null;
    to: number | null;
    outFrom: number;
    outTo: number;
}

/** For one input: the output channels it feeds, per output. */
export interface ChannelMapTarget {
    output: string;
    name: string;
    ranges: Array<[number, number]>;
}

function str(v: any): string {
    return typeof v === "string" ? v : "";
}

function channelLabels(entry: any): string[] {
    const ch = Array.isArray(entry?.channels) ? entry.channels : [];
    return ch.map((c: any) => str(c?.label));
}

/** Inputs and outputs of one Channel Mapping API, with names resolved. */
export function buildChannelMapView(io: any, active: any, lookup: ChannelMapLookup): ChannelMapView {
    const rawIn = (io && typeof io.inputs === "object" && io.inputs) || {};
    const rawOut = (io && typeof io.outputs === "object" && io.outputs) || {};
    const map = (active && typeof active.map === "object" && active.map) || {};

    const inputs: ChannelMapInput[] = Object.keys(rawIn).map((id) => {
        const e = rawIn[id] || {};
        const deviceName = str(e.properties?.name) || id;
        const parentId = str(e.parent?.id);
        const parentType = e.parent?.type;
        let name = "", kind: ChannelMapInput["kind"] = "local", receiverId: string | null = null;
        if (parentId && parentType === "receiver") {
            kind = "receiver";
            receiverId = parentId;
            name = lookup.receiverName(parentId) || "";
        } else if (parentId && parentType === "source") {
            const rx = lookup.receiverOfSource(parentId);
            if (rx) {
                kind = "receiver";
                receiverId = rx.id;
                name = rx.name;
            } else {
                kind = "source";
                const senders = lookup.sourceSenders(parentId);
                name = senders.length > 0 ? senders.map(s => s.name).join(" / ") : (lookup.sourceLabel(parentId) || "");
            }
        }
        if (!name) name = deviceName;
        const caps = (e.caps && typeof e.caps === "object") ? e.caps : {};
        const blockSize = Number.isInteger(caps.block_size) && caps.block_size >= 1 ? caps.block_size : 1;
        return { id, name, deviceName: deviceName === name ? "" : deviceName, kind, receiverId, channels: channelLabels(e),
                 reordering: caps.reordering !== false, blockSize };
    });
    const inputIds = new Set(inputs.map(i => i.id));

    const outputs: ChannelMapOutput[] = Object.keys(rawOut).map((id) => {
        const e = rawOut[id] || {};
        const deviceName = str(e.properties?.name) || id;
        const sourceId = str(e.source_id) || null;
        const senders = sourceId ? lookup.sourceSenders(sourceId) : [];
        let kind: ChannelMapOutput["kind"] = "local", name = "";
        if (senders.length > 0) {
            kind = "sender";
            name = senders.map(s => s.name).join(" / ");
        } else if (sourceId) {
            kind = "source";
            name = lookup.sourceLabel(sourceId) || "";
        }
        if (!name) name = deviceName;
        const entries = (map[id] && typeof map[id] === "object") ? map[id] : {};
        const channels: ChannelMapChannel[] = channelLabels(e).map((label, i) => {
            const m = entries[String(i)];
            const input = (m && typeof m.input === "string" && inputIds.has(m.input)) ? m.input : null;
            const idx = (input !== null && Number.isInteger(m.channel_index) && m.channel_index >= 0) ? m.channel_index + 1 : null;
            return { label, input: idx === null ? null : input, inputChannel: idx };
        });
        const ri = e.caps?.routable_inputs;
        const routable = Array.isArray(ri) ? ri.filter((x: any) => typeof x === "string") : null;
        const mayMute = !Array.isArray(ri) || ri.includes(null);
        return { id, name, deviceName: deviceName === name ? "" : deviceName, kind, sourceId, senderIds: senders.map(s => s.id), channels,
                 routable, mayMute };
    });

    return { inputs, outputs };
}

/** The runs of an output: consecutive output channels fed by consecutive
 *  channels of the same input, and runs of unrouted channels. */
export function outputSegments(view: ChannelMapView, output: ChannelMapOutput): ChannelMapSegment[] {
    const nameOf = new Map(view.inputs.map(i => [i.id, i.name] as [string, string]));
    const out: ChannelMapSegment[] = [];
    output.channels.forEach((c, i) => {
        const n = i + 1;
        const last = out[out.length - 1];
        if (last && last.outTo === n - 1 && last.input === c.input &&
            (c.input === null || (last.to !== null && c.inputChannel === last.to + 1))) {
            last.outTo = n;
            if (c.input !== null) last.to = c.inputChannel;
            return;
        }
        out.push({
            input: c.input,
            name: c.input === null ? null : (nameOf.get(c.input) || c.input),
            from: c.inputChannel, to: c.inputChannel, outFrom: n, outTo: n,
        });
    });
    return out;
}

/** Ascending numbers as closed ranges: [1,2,3,5] → [[1,3],[5,5]]. */
export function toRanges(nums: number[]): Array<[number, number]> {
    const sorted = Array.from(new Set(nums)).sort((a, b) => a - b);
    const out: Array<[number, number]> = [];
    for (const n of sorted) {
        const last = out[out.length - 1];
        if (last && n === last[1] + 1) last[1] = n;
        else out.push([n, n]);
    }
    return out;
}

/** Where the channels of the inputs fed by one receiver go: per output, the
 *  output channels (1-based ranges), in the order of the outputs. */
export function receiverTargets(view: ChannelMapView, receiverId: string): ChannelMapTarget[] {
    const ins = new Set(view.inputs.filter(i => i.receiverId === receiverId).map(i => i.id));
    if (ins.size === 0) return [];
    const out: ChannelMapTarget[] = [];
    for (const o of view.outputs) {
        const chans: number[] = [];
        o.channels.forEach((c, i) => { if (c.input !== null && ins.has(c.input)) chans.push(i + 1); });
        if (chans.length > 0) out.push({ output: o.id, name: o.name, ranges: toRanges(chans) });
    }
    return out;
}

/** One output channel as the operator wants it: an input and its channel
 *  (1-based), or both null for unrouted (silent). */
export interface WantedChannel {
    input: string | null;
    channel: number | null;
}

function ranges(nums: number[]): string {
    return toRanges(nums).map(([a, b]) => a === b ? "" + a : a + "–" + b).join(", ");
}

/**
 * What is wrong with this map for one output, measured against the device's
 * own capabilities (IS-08 v1.0, Behaviour): the inputs it may route
 * (routable_inputs), unrouted channels (null in routable_inputs), whole
 * blocks (block_size, aligned to multiples of it) and a fixed offset when an
 * input cannot reorder. Only channels that change are held against
 * routable_inputs, so a map the device reports itself never blocks a change
 * elsewhere. [] = fine; the device still has the last word.
 */
export function checkOutputMap(view: ChannelMapView, outputId: string, wanted: WantedChannel[]): string[] {
    const out = view.outputs.find(o => o.id === outputId);
    if (!out) return ["Output " + outputId + " is not in the Channel Map."];
    if (!Array.isArray(wanted) || wanted.length !== out.channels.length) {
        return [out.name + " has " + out.channels.length + " channels, " + (Array.isArray(wanted) ? wanted.length : 0) + " were given."];
    }
    const errors: string[] = [];
    const inputs = new Map(view.inputs.map(i => [i.id, i] as [string, ChannelMapInput]));
    const muted: number[] = [];
    wanted.forEach((w, i) => {
        const n = i + 1;
        const cur = out.channels[i];
        if ((w.input === null) !== (w.channel === null)) { errors.push("Channel " + n + ": an input needs a channel, and the other way round."); return; }
        const changed = w.input !== cur.input || w.channel !== cur.inputChannel;
        if (w.input === null) { if (changed && !out.mayMute) muted.push(n); return; }
        const inp = inputs.get(w.input);
        if (!inp) { errors.push("Channel " + n + ": input " + w.input + " is not in the Channel Map."); return; }
        if (!Number.isInteger(w.channel) || (w.channel as number) < 1 || (w.channel as number) > inp.channels.length) {
            errors.push("Channel " + n + ": " + inp.name + " has no channel " + w.channel + "."); return;
        }
        if (changed && out.routable && !out.routable.includes(inp.id)) {
            errors.push(inp.name + " cannot feed " + out.name + ": the device does not route that input to this output.");
        }
    });
    if (muted.length > 0) errors.push(out.name + " cannot have silent channels (" + ranges(muted) + "): the device needs an input on every channel.");
    if (errors.length > 0) return Array.from(new Set(errors));

    for (const inp of view.inputs) {
        const used = wanted.map((w, i) => ({ out: i, in: (w.channel as number) - 1, w })).filter(x => x.w.input === inp.id);
        if (used.length === 0) continue;
        if (inp.blockSize > 1) {
            const have = new Set(used.map(u => u.in));
            const blocks = new Set(used.map(u => Math.floor(u.in / inp.blockSize)));
            for (const b of Array.from(blocks).sort((x, y) => x - y)) {
                const from = b * inp.blockSize, to = Math.min(from + inp.blockSize, inp.channels.length) - 1;
                for (let c = from; c <= to; c++) {
                    if (!have.has(c)) {
                        errors.push(inp.name + " routes in blocks of " + inp.blockSize + ": channels " + (from + 1) + "–" + (to + 1) + " go to " + out.name + " together.");
                        break;
                    }
                }
            }
        }
        if (!inp.reordering) {
            const offsets = new Set(used.map(u => u.out - u.in));
            if (offsets.size > 1) errors.push(inp.name + " cannot reorder: its channels keep their order and spacing in " + out.name + ".");
        }
    }
    return errors;
}

/**
 * The `action` of a POST /map/activations for one output: only the channels
 * that change (IS-08: a client sends the subset to update), keyed by the
 * 0-based channel index as a string, unrouted as {input: null,
 * channel_index: null}. null when nothing changes.
 */
export function mapAction(view: ChannelMapView, outputId: string, wanted: WantedChannel[]): any | null {
    const out = view.outputs.find(o => o.id === outputId);
    if (!out) return null;
    const entries: any = {};
    out.channels.forEach((c, i) => {
        const w = wanted[i];
        if (!w || (w.input === c.input && w.channel === c.inputChannel)) return;
        entries[String(i)] = w.input === null ? { input: null, channel_index: null } : { input: w.input, channel_index: (w.channel as number) - 1 };
    });
    return Object.keys(entries).length > 0 ? { [out.id]: entries } : null;
}

/** The body of an immediate activation (IS-08 activation schema). */
export function activationBody(action: any): any {
    return { activation: { mode: "activate_immediate", requested_time: null }, action };
}
