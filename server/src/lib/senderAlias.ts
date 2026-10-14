// Senders that are the same stream as another one.
//
// A gateway that passes a stream through unchanged — NMOS Federation without NAT, its
// copies and the streams it routes back — publishes a sender carrying the very same
// multicast as the sender it came from. Seen side by side, that read as a duplicate:
// the connect refused to auto-activate ("Multicast … is already in use by sender …")
// and the Multicast DHCP tried to re-address it. Such a sender names the senders it is
// the same stream as in the tag below; those pairs are not conflicts. A different
// sender on the same multicast still is.

export const ALIAS_TAG = "urn:x-nmos-federation:alias-of";

/** The sender ids a sender declares itself the same stream as. */
export function aliasIds(sender: any): string[] {
    const v = sender?.tags?.[ALIAS_TAG];
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string" && x !== "") : [];
}

/**
 * Two senders are one stream when either names the other, or both name a common one
 * (two copies of the same original).
 */
export function sameStream(a: any, b: any): boolean {
    if(!a || !b) return false;
    const mine = new Set<string>([a.id, ...aliasIds(a)].filter(Boolean));
    return [b.id, ...aliasIds(b)].some((id) => !!id && mine.has(id));
}
