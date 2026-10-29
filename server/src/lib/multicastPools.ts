/*
 * Multicast DHCP pools by bandwidth — free of state so it can be tested.
 *
 * The default pool is settings.multicastRange: it takes every sender whose
 * bitrate no other pool covers, and every sender whose bitrate is unknown.
 * settings.multicastPools adds pools with an upper limit, e.g.
 *   [{ maxMbps: 2, range: "239.40.0.0/16" }, { maxMbps: 10, range: "239.41.0.0/24" }]
 * A sender goes into the smallest pool whose limit covers its bitrate per leg
 * (the limit included): 1.5 → "≤ 2", 2 → "≤ 2", 7 → "≤ 10", 3000 → default.
 * Pools never overlap each other or the default pool, so an address belongs
 * to exactly one of them. Every pool may carry a name ("Audio", "Video",
 * settings.multicastDefaultPoolName for the default pool); where a pool is
 * shown, the name stands for it and the limit is the fallback.
 */

/** Longest pool name kept. */
export const MAX_POOL_NAME = 40;

export type PoolDef = { maxMbps: number, range: string, name?: string };

export type Pool = {
    key: string;          // "default", or the limit as text ("2", "10")
    label: string;        // "≤ 2 Mbit/s", "∞"
    name: string;         // the operator's name, "" when none
    maxMbps: number;      // Infinity for the default pool
    cidr: string;
    start: number;        // first address, as uint32
    end: number;          // last address, as uint32
};

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** "239.30.0.0/16" → { start, end } as uint32; null when it is no IPv4 CIDR. */
export function parseCidr(cidr: any): { start: number, end: number } | null {
    const m = typeof cidr === "string" ? CIDR_RE.exec(cidr.trim()) : null;
    if (!m) return null;
    const o = m.slice(1, 5).map(Number);
    const bits = Number(m[5]);
    if (o.some((x) => x > 255) || bits > 32) return null;
    const base = (((o[0] << 24) >>> 0) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
    const start = (base & mask) >>> 0;
    return { start, end: (start | ((~mask) >>> 0)) >>> 0 };
}

/** Dotted IPv4 → uint32, or null. */
export function ipToUint32(ip: any): number | null {
    const p = typeof ip === "string" ? ip.split(".") : [];
    if (p.length !== 4) return null;
    let n = 0;
    for (const s of p) {
        if (!/^\d{1,3}$/.test(s) || Number(s) > 255) return null;
        n = (n * 256) + Number(s);
    }
    return n >>> 0;
}

/** "≤ 2 Mbit/s", "≤ 0.5 Mbit/s", "∞" */
export function poolLabel(maxMbps: number): string {
    return Number.isFinite(maxMbps) ? "≤ " + maxMbps + " Mbit/s" : "∞";
}

/** A pool's name cut to size, "" when none. */
export function poolName(name: any): string {
    return typeof name === "string" ? name.trim().slice(0, MAX_POOL_NAME) : "";
}

/** How a pool reads where it is shown: its name, else its limit. */
export function poolTitle(p: { name?: string, label: string } | null | undefined): string {
    return p ? (p.name || p.label) : "";
}

/** The pools in use: the limited ones by limit, the default pool last. Rows
 *  that do not parse are left out (validatePools reports them). */
export function buildPools(defaultCidr: any, defs: any, defaultName: any = ""): Pool[] {
    const pools: Pool[] = [];
    for (const d of Array.isArray(defs) ? defs : []) {
        const r = parseCidr(d?.range);
        const max = Number(d?.maxMbps);
        if (!r || !(max > 0) || !Number.isFinite(max)) continue;
        pools.push({ key: String(max), label: poolLabel(max), name: poolName(d.name), maxMbps: max, cidr: String(d.range).trim(), ...r });
    }
    pools.sort((a, b) => a.maxMbps - b.maxMbps);
    const r = parseCidr(defaultCidr);
    if (r) pools.push({ key: "default", label: poolLabel(Infinity), name: poolName(defaultName), maxMbps: Infinity, cidr: String(defaultCidr).trim(), ...r });
    return pools;
}

/** What is wrong with a pool configuration, as messages for the operator;
 *  empty when it is fine. Names, where given, must differ (case aside). */
export function validatePools(defaultCidr: any, defs: any, defaultName: any = ""): string[] {
    const errors: string[] = [];
    const names = new Map<string, { shown: string, count: number }>();
    for (const n of [poolName(defaultName), ...(Array.isArray(defs) ? defs : []).map((p: any) => poolName(p?.name))]) {
        if (!n) continue;
        const e = names.get(n.toLowerCase()) || { shown: n, count: 0 };
        e.count++;
        names.set(n.toLowerCase(), e);
    }
    for (const e of names.values()) {
        if (e.count > 1) errors.push("Two pools are named \"" + e.shown + "\".");
    }
    const all: { name: string, cidr: string, r: { start: number, end: number } }[] = [];
    const isMulticast = (r: { start: number, end: number }) => r.start >= 0xE0000000 && r.end <= 0xEFFFFFFF;
    const seen = new Set<number>();
    (Array.isArray(defs) ? defs : []).forEach((p: any) => {
        const max = Number(p?.maxMbps);
        const name = (max > 0 && Number.isFinite(max)) ? "Pool " + poolLabel(max) : "A pool";
        if (!(max > 0) || !Number.isFinite(max)) errors.push(name + ": the limit must be a number of Mbit/s above 0.");
        else if (seen.has(max)) errors.push("Two pools have the limit " + poolLabel(max) + ".");
        else seen.add(max);
        const r = parseCidr(p?.range);
        if (!r) errors.push(name + ": \"" + (p?.range ?? "") + "\" is no CIDR range, e.g. 239.40.0.0/16.");
        else if (!isMulticast(r)) errors.push(name + ": " + String(p.range).trim() + " is not a multicast range (224.0.0.0/4).");
        else all.push({ name: name.replace(/^Pool/, "pool"), cidr: String(p.range).trim(), r });
    });
    const d = parseCidr(defaultCidr);
    if (!d) errors.push("Default pool: \"" + (defaultCidr ?? "") + "\" is no CIDR range, e.g. 239.30.0.0/16.");
    else if (!isMulticast(d)) errors.push("Default pool: " + String(defaultCidr).trim() + " is not a multicast range (224.0.0.0/4).");
    else all.push({ name: "the default pool", cidr: String(defaultCidr).trim(), r: d });
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            const a = all[i], b = all[j];
            if (a.r.start <= b.r.end && b.r.start <= a.r.end) {
                errors.push(a.cidr + " (" + a.name + ") and " + b.cidr + " (" + b.name + ") overlap.");
            }
        }
    }
    return errors;
}

/**
 * The pool a sender belongs in. `mbps` is its bitrate per leg; null, 0 or
 * not a number means unknown, which goes into the default pool like any
 * bitrate above every limit. Null only when there is no default pool.
 */
export function poolForBitrate(pools: Pool[], mbps: number | null | undefined): Pool | null {
    const known = typeof mbps === "number" && Number.isFinite(mbps) && mbps > 0;
    for (const p of pools) {
        if (known && Number.isFinite(p.maxMbps) && mbps! <= p.maxMbps) return p;
    }
    return pools.find((p) => p.key === "default") || null;
}

/** The pool an address lies in, or null when it lies in none. */
export function poolOfIp(pools: Pool[], ip: string): Pool | null {
    const n = ipToUint32(ip);
    if (n === null) return null;
    return pools.find((p) => n >= p.start && n <= p.end) || null;
}

/** Pairs (odd address for leg 1, odd+1 for leg 2) a pool can hand out. */
export function pairCount(pool: Pool): number {
    return Math.floor((pool.end - pool.start + 1) / 2);
}

/** settings.multicastPools as stored: limits as numbers, ranges trimmed,
 *  sorted by limit. Rows left completely empty are dropped. */
export function normalisePoolDefs(defs: any): PoolDef[] {
    const out: PoolDef[] = [];
    for (const d of Array.isArray(defs) ? defs : []) {
        const range = typeof d?.range === "string" ? d.range.trim() : "";
        const raw = d?.maxMbps;
        const name = poolName(d?.name);
        if (range === "" && name === "" && (raw === "" || raw === null || raw === undefined)) continue;
        const def: PoolDef = { maxMbps: Number(typeof raw === "string" ? raw.replace(",", ".").trim() : raw), range };
        if (name) def.name = name;
        out.push(def);
    }
    return out.sort((a, b) => a.maxMbps - b.maxMbps);
}
