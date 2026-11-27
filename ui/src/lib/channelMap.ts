// IS-08 Channel Map: one colour and one letter per input, in the order of
// the device's inputs, on the Details page and in the Crosspoint sender
// dialog alike.
export const CM_COLORS = ["#a78bfa", "#38bdf8", "#f59e0b", "#f472b6", "#34d399", "#fb923c", "#60a5fa", "#e879f9"];
export function cmTag(i: number): string { return i < 26 ? String.fromCharCode(65 + i) : "I" + (i + 1); }
export function cmColor(i: number): string { return CM_COLORS[i % CM_COLORS.length]; }
