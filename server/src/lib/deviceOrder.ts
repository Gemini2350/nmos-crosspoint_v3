// Device order in the crosspoint state, and so in the matrix: by crosspoint
// number, ascending. A device without one (-1) comes after every numbered
// device. Equal numbers and unnumbered devices follow their label in
// natural order ("Source 2" before "Source 10"), then their id, so the
// order never depends on the order the registry announced them in.

// Numeric collation is a total order; ComplexCompare is not ("a1", "a1a"
// and "a01b" compare in a cycle), which a sort must not be given.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface OrderedDevice {
    id: string;
    num: number;
    displayLabel?: string;
    alias?: string;
    name?: string;
}

function isNumbered(num: number): boolean {
    return Number.isFinite(num) && num > 0;
}

function orderLabel(d: OrderedDevice): string {
    return "" + (d.displayLabel || d.alias || d.name || "");
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDevices(a: OrderedDevice, b: OrderedDevice): number {
    let an = isNumbered(a.num), bn = isNumbered(b.num);
    if (an && bn && a.num != b.num) { return a.num - b.num; }
    if (an != bn) { return an ? -1 : 1; }
    let la = orderLabel(a), lb = orderLabel(b);
    // The collator reads "Sink" and "sink" as equal; the raw compare and
    // then the id break that tie.
    return collator.compare(la, lb) || cmp(la, lb) || cmp("" + a.id, "" + b.id);
}

/** Sorts in place and returns the same array. */
export function sortDevices<T extends OrderedDevice>(devices: T[]): T[] {
    return devices.sort(compareDevices);
}

/**
 * Gives device `devId` the sorting number `newNum`. A device already
 * holding `newNum` takes the moved device's old number, so two devices never
 * end up sharing one through a move; when the moved device had none, the
 * displaced one gets `freshNum()` instead of losing its number. -1 clears
 * the number. Returns whether anything changed; an unknown device, 0, a
 * number past Number.MAX_SAFE_INTEGER or a non-number changes nothing.
 */
export function moveDeviceNum(devices: { [id: string]: { num: number } }, devId: string, newNum: any, freshNum: () => number): boolean {
    let dev = devices[devId];
    if (!dev) { return false; }
    let num = Number.parseInt("" + newNum);
    if (!(num == -1 || (num > 0 && Number.isSafeInteger(num))) || num == dev.num) { return false; }
    let oldNum = dev.num;
    if (num > 0) {
        for (let id of Object.keys(devices)) {
            if (devices[id].num == num) { devices[id].num = oldNum > 0 ? oldNum : freshNum(); }
        }
    }
    dev.num = num;
    return true;
}

// ----- Flows within a device -----

interface OrderedFlow { id: string; alias?: string; name?: string; }

/** Flows of one type within a device: by the name shown (the alias), in
 *  natural order ("Ch 2" before "Ch 10"), then the raw name, then the id. */
export function compareFlows(a: OrderedFlow, b: OrderedFlow): number {
    const la = "" + (a.alias || a.name || ""), lb = "" + (b.alias || b.name || "");
    return collator.compare(la, lb) || cmp(la, lb) || cmp("" + a.id, "" + b.id);
}

/** Sorts every type list of a device's senders and receivers in place. The
 *  types themselves are listed in a fixed order by whoever shows them
 *  (video, audio, data, ...). */
export function sortDeviceFlows(dev: any): void {
    for (const side of ["senders", "receivers"]) {
        const byType = dev?.[side];
        if (!byType || typeof byType !== "object") continue;
        for (const t of Object.keys(byType)) {
            if (Array.isArray(byType[t])) byType[t].sort(compareFlows);
        }
    }
}

// ----- Other views of the device order -----

const TYPE_CLASS: { [t: string]: number } = { video: 0, audio: 1, audiochannel: 1, data: 2 };

/** The essence a device mainly carries: 0 video, 1 audio, 2 data, 3 other. */
function deviceTypeClass(dev: any): number {
    let best = 3;
    for (const side of ["senders", "receivers"]) {
        const byType = dev?.[side] || {};
        for (const t of Object.keys(byType)) {
            if (Array.isArray(byType[t]) && byType[t].length > 0 && t in TYPE_CLASS) best = Math.min(best, TYPE_CLASS[t]);
        }
    }
    return best;
}

/**
 * Ranks of the devices for the Crosspoint page's "Sort by": `name` by the
 * label shown, `type` by the essence they mainly carry (video, audio, data)
 * and within that the sorting number. `devices` is in sorting number order
 * (sortDevices). The page only orders by the rank it is given.
 */
export function viewRanks(devices: any[]): { [id: string]: { name: number, type: number } } {
    const out: { [id: string]: { name: number, type: number } } = {};
    const byName = devices.map((d, i) => ({ d, i })).sort((a, b) => {
        const la = orderLabel(a.d), lb = orderLabel(b.d);
        return collator.compare(la, lb) || cmp(la, lb) || a.i - b.i;
    });
    byName.forEach((x, r) => { out[x.d.id] = { name: r, type: 0 }; });
    const byType = devices.map((d, i) => ({ d, i, c: deviceTypeClass(d) })).sort((a, b) => a.c - b.c || a.i - b.i);
    byType.forEach((x, r) => { out[x.d.id].type = r; });
    return out;
}

// ----- Drag & drop -----

/**
 * Puts the devices `block` (kept in their order) in front of `beforeId`, or
 * at the end when it is null, and returns the sorting numbers that have to
 * change for that: as few as possible. The block takes free numbers after its
 * new predecessor when the gap allows; otherwise the devices behind it move
 * up one by one until a number is free again. A device without a number that
 * ends up in front of the block gets one, or it would sort behind it.
 * `seq` is every device in its current order (sortDevices). Returns null when
 * the move makes no sense (unknown ids, target inside the block).
 */
export function placeDevices(seq: Array<{ id: string, num: number }>, block: string[], beforeId: string | null): { [id: string]: number } | null {
    const inBlock = new Set(block);
    const blockSeq = seq.filter((d) => inBlock.has(d.id));
    if (blockSeq.length === 0 || blockSeq.length !== inBlock.size) return null;
    if (beforeId !== null && inBlock.has(beforeId)) return null;
    const rest = seq.filter((d) => !inBlock.has(d.id));
    let at = beforeId === null ? rest.length : rest.findIndex((d) => d.id === beforeId);
    if (at < 0) return null;
    const order = [...rest.slice(0, at), ...blockSeq, ...rest.slice(at)];
    const blockEnd = at + blockSeq.length;            // index after the block in `order`
    const next = order[blockEnd];                      // the first device behind the block
    const nextNum = next && isNumbered(next.num) ? next.num : Infinity;

    const changes: { [id: string]: number } = {};
    const set = (d: { id: string, num: number }, n: number) => { if (d.num !== n) changes[d.id] = n; };
    let cur = 0;
    for (let i = 0; i < order.length; i++) {
        const d = order[i];
        if (i < at) {
            // In front of the block: unchanged, but an unnumbered one gets a number.
            if (isNumbered(d.num) && d.num > cur) { cur = d.num; continue; }
            set(d, cur + 1); cur += 1;
        } else if (i < blockEnd) {
            // The block keeps its numbers when they already fit in the gap.
            const left = blockEnd - i - 1;             // block devices still to place after this one
            if (isNumbered(d.num) && d.num > cur && d.num + left < nextNum) { cur = d.num; continue; }
            set(d, cur + 1); cur += 1;
        } else {
            // Behind the block: only move up while a number is taken.
            if (!isNumbered(d.num) || d.num > cur) break;
            set(d, cur + 1); cur += 1;
        }
    }
    return changes;
}
