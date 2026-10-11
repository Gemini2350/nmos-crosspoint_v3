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
 * Gives device `devId` the crosspoint number `newNum`. A device already
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
