/*
 * NMOS Crosspoint — Multicast Lease Manager
 *
 * Acts like a tiny "DHCP for multicasts":
 *   - One lease per NMOS sender, keyed by senderId.
 *   - Each lease occupies a *pair* of consecutive addresses in the configured
 *     CIDR pool: an odd address for Leg 1 (primary), and odd+1 (even) for
 *     Leg 2 (secondary). Single-leg senders still reserve both, so a future
 *     switch to dual-leg doesn't get a different secondary.
 *   - Leases live forever until the device is explicitly deleted by the user.
 *
 * Pools by bandwidth (multicastPools.ts): settings.multicastRange is the
 * default pool; settings.multicastPools adds pools with an upper bitrate
 * limit per leg. A sender gets its pair from the smallest pool whose limit
 * covers its bitrate, else — and when the bitrate is unknown — from the
 * default pool. A full pool hands out nothing (no spill into another pool),
 * and a lease stays where it is when pools or bitrates change; "Renew from
 * Pool" re-sorts.
 *
 * Categorisation (UI badge only — pools go by bitrate, not by category):
 *   - video → media_type starts with "video/"
 *   - audio → media_type starts with "audio/"
 *   - other → not auto-allocated (no range, no lease)
 *
 * Duplicate protection: a *global* IP→sender index is maintained. The
 * allocator checks both the primary and the secondary slot against this
 * index, so manual edits cannot produce a duplicate Multicast.
 *
 * Persistence: ./state/multicastLeases.json (atomic write).
 */

import { SyncLog } from "./syncLog";
import { Pool, buildPools, poolForBitrate, poolOfIp, pairCount, validatePools, poolTitle } from "./multicastPools";

const fs = require("fs");
const path = require("path");

// `category` is kept on the lease purely for the inventory UI badge
// (audio/video colour-coding). All allocations share the SAME pool;
// the categorisation does not influence which range is used.
export type MulticastCategory = "audio" | "video";

export interface MulticastLease {
    createdAt: string;
    deviceLabel: string;
    nodeId: string;
    category: MulticastCategory;
    channels: number;
    // RESERVED addresses: allocated from the pool and immutable until the
    // lease is released. Even when the user manually overrides a leg with a
    // different address, these stay locked in the pool — clearing the field
    // restores the leg back to its reserved value.
    primaryIp: string;       // odd, reserved for Leg 1
    secondaryIp: string;     // odd+1, reserved for Leg 2 (also held for single-leg senders)
    // Optional per-leg manual overrides. Keys: "0" for Leg 1, "1" for Leg 2.
    // When unset (or empty string), the effective IP for that leg is the
    // reserved address. When set, the override "wins" over the reservation.
    overrideIp?: { [leg: string]: string };
    port: number;
}

export interface LeaseStats {
    used: number;
    total: number;
}

/** One pool in getStats(): used = leases whose Leg 1 address lies in it. */
export interface PoolStats extends LeaseStats {
    key: string;
    label: string;
    name: string;
    maxMbps: number | null;    // null for the default pool (JSON has no Infinity)
    cidr: string;
}

/** A sender's bitrate as the crosspoint computed it (Mbit/s per leg). */
export type SenderBitrate = { v: number, hint: string } | undefined;

// How long a fresh lease waits for a sender's bitrate when limited pools
// exist (the crosspoint state may not hold the sender yet); after that it
// goes into the default pool like a sender of unknown bitrate.
const BITRATE_WAIT_MS = 60_000;

const STATE_PATH = "./state/multicastLeases.json";

export class MulticastLeaseManager {
    private static _instance: MulticastLeaseManager | null = null;
    public static get instance(): MulticastLeaseManager | null { return this._instance; }

    private settings: any;
    private leases: { [senderId: string]: MulticastLease } = {};

    // Global IP claim index. Maps IP → senderId. Includes BOTH primary and
    // secondary IPs of every lease. The allocator and manual-edit paths use
    // this to detect collisions cleanly, regardless of category overlap.
    private ipToSender: Map<string, string> = new Map();

    // Round-robin cursor per pool key (uint32, odd-aligned).
    private cursors: Map<string, number> = new Map();

    // The crosspoint's bitrate per sender (server.ts wires it up). undefined
    // = the sender is not in the crosspoint state yet.
    private bitrateProvider: ((senderId: string) => SenderBitrate) | null = null;
    // Senders whose lease waits for their bitrate: id → first try (ms).
    private waitingForBitrate: Map<string, number> = new Map();
    // "<sender>|<pool>" already warned about a full pool — once, not on
    // every reconcile.
    private fullWarned: Set<string> = new Set();

    private onChange: (() => void) | null = null;

    // Optional callback returning the set of destination IPs that are already
    // used by any other live NMOS sender (whether or not it has a lease).
    // Wired up at startup with NmosRegistryConnector.getActiveSenderIps so the
    // allocator can avoid handing out an address that's in use on the wire.
    private externalIpsProvider: ((excludeSenderId: string) => Set<string>) | null = null;

    constructor(settings: any) {
        MulticastLeaseManager._instance = this;
        this.settings = settings;
        this.load();
    }

    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    setExternalIpsProvider(cb: ((excludeSenderId: string) => Set<string>) | null) { this.externalIpsProvider = cb; }
    setBitrateProvider(cb: ((senderId: string) => SenderBitrate) | null) { this.bitrateProvider = cb; }
    private notifyChange() {
        if (this.onChange) {
            try { this.onChange(); } catch { /* swallow */ }
        }
    }

    isEnabled(): boolean {
        return !!(this.settings && this.settings.autoMulticast && this.settings.autoMulticast.enabled);
    }

    setSettings(settings: any) { this.settings = settings; this.fullWarned.clear(); }

    /** The pools in use, limited ones by limit, the default pool last. A
     *  configuration that does not validate (hand-edited settings.json)
     *  leaves the default pool alone, with one warning per configuration. */
    getPools(): Pool[] {
        const def = this.settings?.multicastRange, defs = this.settings?.multicastPools;
        const defName = this.settings?.multicastDefaultPoolName;
        const sig = JSON.stringify([def, defs, defName]);
        if (sig !== this.poolsSig) {
            this.poolsSig = sig;
            const errs = validatePools(def, defs, defName);
            this.poolsBad = errs.length > 0 && Array.isArray(defs) && defs.length > 0;
            if (this.poolsBad) {
                SyncLog.log("warn", "Multicast Lease", "Ignoring settings.multicastPools, only the default pool is used: " + errs.join(" "));
            }
        }
        return buildPools(def, this.poolsBad ? [] : defs, defName);
    }
    private poolsSig = "";
    private poolsBad = false;

    /** Senders whose lease is waiting for their bitrate; the server retries
     *  them when the crosspoint state changes. */
    getSendersWaitingForBitrate(): string[] { return Array.from(this.waitingForBitrate.keys()); }

    /** Bitrate per leg in Mbit/s, null when unknown. */
    private bitrateOf(senderId: string): { mbps: number | null, known: boolean } {
        let b: SenderBitrate = undefined;
        try { b = this.bitrateProvider ? this.bitrateProvider(senderId) : undefined; } catch (e) {}
        if (b === undefined) return { mbps: null, known: false };
        const v = Number(b.v);
        return { mbps: (b.hint !== "unknown" && v > 0) ? v : null, known: true };
    }

    /** Where a sender's lease lies and where its bitrate says it belongs —
     *  for the inventory ("→ ≤ 2 Mbit/s" when the two differ). */
    poolInfo(senderId: string): { pool: string, poolLimit: string, poolKey: string, wantPool: string, wantPoolKey: string } | null {
        const lease = this.leases[senderId];
        if (!lease) return null;
        const pools = this.getPools();
        const at = poolOfIp(pools, lease.primaryIp);
        const want = poolForBitrate(pools, this.bitrateOf(senderId).mbps);
        return { pool: poolTitle(at), poolLimit: at ? at.label : "", poolKey: at ? at.key : "",
                 wantPool: poolTitle(want), wantPoolKey: want ? want.key : "" };
    }


    // ----- Public API -----

    /**
     * Make sure a sender has a lease. If one already exists, returns it. If
     * not, attempts to allocate from the appropriate pool — but only when the
     * manager is enabled AND the sender is currently active. Inactive senders
     * are deliberately not given a lease; their address is allocated the
     * moment they transition to active (see reconcileSenderWithLease and the
     * periodic sweep in server.ts).
     */
    ensureLease(args: {
        senderId: string;
        mediaType: string;
        channels: number;
        deviceLabel?: string;
        nodeId?: string;
        port?: number;
        isActive?: boolean;
    }): MulticastLease | null {
        if (this.leases[args.senderId]) {
            return this.leases[args.senderId];
        }
        if (!this.isEnabled()) {
            return null;
        }
        // Only allocate for active senders. Inactive ones get their lease
        // the first time they actually go active.
        if (args.isActive === false) {
            return null;
        }

        const category = this.categorise(args.mediaType, args.channels);
        if (!category) {
            return null;
        }

        const pools = this.getPools();
        let { mbps, known } = this.bitrateOf(args.senderId);
        if (!known && pools.length > 1) {
            // Limited pools exist and the bitrate is not computed yet: wait
            // for it rather than parking the sender in the default pool for
            // good. The server retries on the next crosspoint state change.
            const now = Date.now();
            const since = this.waitingForBitrate.get(args.senderId) ?? now;
            this.waitingForBitrate.set(args.senderId, since);
            if (now - since < BITRATE_WAIT_MS) return null;
        }
        this.waitingForBitrate.delete(args.senderId);
        const pool = poolForBitrate(pools, mbps);
        if (!pool) return null;

        const pair = this.allocatePair(pool, args.senderId);
        if (!pair) {
            const k = args.senderId + "|" + pool.key;
            if (!this.fullWarned.has(k)) {
                this.fullWarned.add(k);
                SyncLog.log("warn", "Multicast Lease", "Pool " + poolTitle(pool) + " (" + (pool.name ? pool.label + ", " : "") + pool.cidr + ") is full — sender " + args.senderId +
                    (mbps ? " (" + (Math.round(mbps * 100) / 100) + " Mbit/s)" : "") + " gets no address and keeps the one it has.");
            }
            return null;
        }
        for (const k of Array.from(this.fullWarned)) { if (k.startsWith(args.senderId + "|")) this.fullWarned.delete(k); }

        const lease: MulticastLease = {
            createdAt: new Date().toISOString(),
            deviceLabel: args.deviceLabel || "",
            nodeId: args.nodeId || "",
            category,
            channels: args.channels,
            primaryIp: pair.primary,
            secondaryIp: pair.secondary,
            port: args.port && args.port > 0 ? args.port : 5004,
        };
        this.leases[args.senderId] = lease;
        this.claimIp(pair.primary,   args.senderId);
        this.claimIp(pair.secondary, args.senderId);

        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Allocated " + pair.primary + " / " + pair.secondary + " for sender " + args.senderId + " (" + category +
            ", pool " + poolTitle(pool) + (mbps ? ", " + (Math.round(mbps * 100) / 100) + " Mbit/s" : "") + ")");
        return lease;
    }

    /**
     * Adopt the sender's *current* IS-05 addresses as its lease. Used when
     * the user enables Auto-Allocation but chooses to keep existing
     * configurations rather than force everyone onto fresh pool addresses.
     *
     * The reserved primary/secondary are set to whatever the sender is
     * currently using — even if that's outside the configured pool. The
     * addresses are claimed in the global IP index so the allocator won't
     * re-hand them out.
     *
     * Returns null and skips on collision with another lease (the caller
     * can then fall back to a fresh ensureLease allocation).
     */
    adoptLease(args: {
        senderId: string;
        mediaType: string;
        channels: number;
        deviceLabel?: string;
        nodeId?: string;
        port?: number;
        primaryIp: string;
        secondaryIp?: string;
    }): MulticastLease | null {
        if (this.leases[args.senderId]) {
            return this.leases[args.senderId];
        }
        if (!this.isEnabled()) {
            return null;
        }
        if (!this.ipIsValid(args.primaryIp)) {
            return null;
        }
        const category = this.categorise(args.mediaType, args.channels);
        if (!category) {
            return null;
        }

        // Derive a secondary if the caller didn't pass one. Standard ST 2022-7
        // convention: secondary = primary + 1 when primary is odd.
        let secondary = "";
        if (args.secondaryIp && this.ipIsValid(args.secondaryIp)) {
            secondary = args.secondaryIp;
        } else if (this.ipToUint32(args.primaryIp) % 2 === 1) {
            secondary = this.uint32ToIp(this.ipToUint32(args.primaryIp) + 1);
        } else {
            // No usable secondary — single-leg sender; we use primary as both
            // so the index still reserves it from future fresh allocations.
            secondary = args.primaryIp;
        }

        // Collision check: never overwrite another sender's claim.
        const primOwner = this.ipToSender.get(args.primaryIp);
        if (primOwner && primOwner !== args.senderId) {
            SyncLog.log("warn", "Multicast Lease", "Cannot adopt " + args.primaryIp + " for " + args.senderId + " — already claimed by " + primOwner);
            return null;
        }
        if (secondary !== args.primaryIp) {
            const secOwner = this.ipToSender.get(secondary);
            if (secOwner && secOwner !== args.senderId) {
                SyncLog.log("warn", "Multicast Lease", "Cannot adopt secondary " + secondary + " for " + args.senderId + " — already claimed by " + secOwner);
                return null;
            }
        }

        const lease: MulticastLease = {
            createdAt: new Date().toISOString(),
            deviceLabel: args.deviceLabel || "",
            nodeId: args.nodeId || "",
            category,
            channels: args.channels,
            primaryIp: args.primaryIp,
            secondaryIp: secondary,
            port: args.port && args.port > 0 ? args.port : 5004,
        };
        this.leases[args.senderId] = lease;
        this.claimIp(args.primaryIp, args.senderId);
        if (secondary !== args.primaryIp) this.claimIp(secondary, args.senderId);
        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Adopted existing addresses " + args.primaryIp + " / " + secondary + " for sender " + args.senderId + " (" + category + ")");
        return lease;
    }


    /**
     * Get the desired addresses for a sender (i.e. what the IS-05 active
     * transport_params should look like). Returns the effective IPs which
     * may be either the reserved or a manual override. Returns null if no
     * lease exists.
     */
    getDesiredAddresses(senderId: string): { primaryIp: string; secondaryIp: string; port: number } | null {
        const l = this.leases[senderId];
        if (!l) return null;
        return {
            primaryIp:   this.effectiveIpForLeg(l, 0),
            secondaryIp: this.effectiveIpForLeg(l, 1),
            port:        l.port
        };
    }

    getLease(senderId: string): MulticastLease | null {
        return this.leases[senderId] || null;
    }

    /** Effective IP for a given leg — override if set, otherwise reserved. */
    private effectiveIpForLeg(lease: MulticastLease, legIndex: number): string {
        if (lease.overrideIp){
            const o = lease.overrideIp["" + legIndex];
            if (o && this.ipIsValid(o)) return o;
        }
        return legIndex === 0 ? lease.primaryIp : lease.secondaryIp;
    }
    /** Effective IP for a given senderId+leg. Public API for outside callers. */
    getEffectiveIp(senderId: string, legIndex: number): string {
        const l = this.leases[senderId];
        if (!l) return "";
        return this.effectiveIpForLeg(l, legIndex);
    }
    /** Reserved (assigned) IP for a leg — the address the user goes back to on "clear". */
    getReservedIp(senderId: string, legIndex: number): string {
        const l = this.leases[senderId];
        if (!l) return "";
        return legIndex === 0 ? l.primaryIp : l.secondaryIp;
    }

    /**
     * Apply a manual edit from the user. Updates the lease's leg IP and
     * adjusts the global IP index. If the new IP is already claimed by
     * *another* lease, that conflicting lease is fully released — the
     * conflicted sender will reallocate fresh on the next reconcile cycle.
     */
    /**
     * Record a user-driven edit of a leg.
     *
     *   ip = ""           → clear any existing override; effective IP falls
     *                       back to the reserved address.
     *   ip = <valid IP>   → set override for this leg; the reserved address
     *                       stays untouched (still locked in the pool).
     *   ip = undefined    → no IP change; only port is updated (if given).
     */
    recordManualEdit(senderId: string, legIndex: number, ip: string | undefined, port?: number) {
        let lease = this.leases[senderId];
        if (!lease) {
            // No existing lease — we can't classify the sender from here.
            // Reconcile will create one next time we see this sender.
            return;
        }
        if (!lease.overrideIp) lease.overrideIp = {};
        const key = "" + legIndex;
        const reserved = legIndex === 0 ? lease.primaryIp : lease.secondaryIp;
        const previousOverride = lease.overrideIp[key];

        if (ip === undefined) {
            // Caller didn't touch the IP — leave override / reserved as-is.
        } else if (ip === "" || (typeof ip === "string" && ip.trim() === "")) {
            // Explicit clear: remove the override. Effective IP becomes
            // the reserved address again.
            if (previousOverride){
                this.releaseIp(previousOverride, senderId);
                delete lease.overrideIp[key];
            }
            // Make sure the reserved address is still claimed for us
            if (reserved) this.claimIp(reserved, senderId);
        } else {
            const validIp = ip.trim();
            if (!this.ipIsValid(validIp)) {
                SyncLog.log("warn", "Multicast Lease", "recordManualEdit ignored invalid IP: " + validIp);
            } else if (validIp === reserved) {
                // Override matches the reserved value → no actual override.
                if (previousOverride){
                    this.releaseIp(previousOverride, senderId);
                    delete lease.overrideIp[key];
                }
                if (reserved) this.claimIp(reserved, senderId);
            } else {
                // Real override. Evict any other lease that currently holds it.
                this.evictConflict(validIp, senderId);
                if (previousOverride && previousOverride !== validIp){
                    this.releaseIp(previousOverride, senderId);
                }
                lease.overrideIp[key] = validIp;
                this.claimIp(validIp, senderId);
            }
        }

        if (port !== undefined && port > 0) lease.port = port;

        this.persist();
        this.notifyChange();
    }

    /** Release all leases for the given sender IDs (used on device delete). */
    releaseLeases(senderIds: string[]) {
        let changed = false;
        for (const id of senderIds) {
            const l = this.leases[id];
            if (!l) continue;
            this.releaseIp(l.primaryIp,   id);
            this.releaseIp(l.secondaryIp, id);
            // Also release any manual overrides
            if (l.overrideIp){
                for (const k of Object.keys(l.overrideIp)){
                    this.releaseIp(l.overrideIp[k], id);
                }
            }
            delete this.leases[id];
            changed = true;
            SyncLog.log("info", "Multicast Lease", "Released lease for sender " + id);
        }
        if (changed) {
            this.persist();
            this.notifyChange();
        }
    }


    // ----- Stats / Inventory -----

    /**
     * Pool stats. Single shared pool: one `total` (pair count in the
     * configured CIDR) and one `used` (number of leases — each lease
     * occupies exactly one pair). The per-category counts (audio / video)
     * are surfaced for the inventory filter UI.
     */
    getStats(): { pool: LeaseStats, pools: PoolStats[] } & { [cat in MulticastCategory]?: LeaseStats } {
        const pools = this.getPools();
        const usedBy: { [key: string]: number } = {};
        for (const id in this.leases) {
            const p = poolOfIp(pools, this.leases[id]?.primaryIp);
            if (p) usedBy[p.key] = (usedBy[p.key] || 0) + 1;
        }
        const poolStats: PoolStats[] = pools.map((p) => ({
            key: p.key, label: p.label, name: p.name, maxMbps: Number.isFinite(p.maxMbps) ? p.maxMbps : null,
            cidr: p.cidr, used: usedBy[p.key] || 0, total: pairCount(p),
        }));
        // `pool` (the default pool) stays for older UIs.
        const def = poolStats.find((p) => p.key === "default");
        const total = def ? def.total : 0;
        const used = Object.keys(this.leases).length;

        const perCat: { [cat in MulticastCategory]: number } = { audio: 0, video: 0 };
        for (const id in this.leases) {
            const l = this.leases[id];
            if (l && (l.category in perCat)) perCat[l.category]++;
        }
        return {
            pool:  { used: def ? def.used : used, total },
            pools: poolStats,
            audio: { used: perCat.audio, total },
            video: { used: perCat.video, total },
        };
    }

    getAllLeases(): { [senderId: string]: MulticastLease } { return this.leases; }

    exportLeases(): any {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            leases: this.leases,
        };
    }

    /**
     * Replace the current leases with the imported set. Re-builds the IP
     * index from scratch and silently drops entries that collide (first one
     * wins) to avoid bringing duplicates back in.
     */
    importLeases(data: any): { imported: number; dropped: number } {
        if (!data || typeof data !== "object" || !data.leases || typeof data.leases !== "object") {
            throw new Error("Invalid leases payload");
        }
        const newLeases: { [id: string]: MulticastLease } = {};
        const newIndex: Map<string, string> = new Map();
        let dropped = 0;

        for (const id in data.leases) {
            const raw = data.leases[id];
            if (!raw || !["audio","video"].includes(raw.category)) { dropped++; continue; }
            if (typeof raw.primaryIp !== "string" || typeof raw.secondaryIp !== "string") { dropped++; continue; }
            if (newIndex.has(raw.primaryIp) || newIndex.has(raw.secondaryIp)) {
                SyncLog.log("warn", "Multicast Lease", "Import dropping duplicate lease for " + id + " — IP already claimed.");
                dropped++;
                continue;
            }
            let cleanedOverrides: { [k:string]: string } | undefined;
            if (raw.overrideIp && typeof raw.overrideIp === "object"){
                cleanedOverrides = {};
                for (const k of Object.keys(raw.overrideIp)){
                    const v = raw.overrideIp[k];
                    if (!v || typeof v !== "string" || !this.ipIsValid(v)) continue;
                    const reserved = (k === "0") ? raw.primaryIp : (k === "1" ? raw.secondaryIp : "");
                    if (v === reserved) continue;
                    if (newIndex.has(v)) continue;
                    cleanedOverrides[k] = v;
                }
                if (Object.keys(cleanedOverrides).length === 0) cleanedOverrides = undefined;
            }
            newLeases[id] = {
                createdAt:   typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
                deviceLabel: typeof raw.deviceLabel === "string" ? raw.deviceLabel : "",
                nodeId:      typeof raw.nodeId === "string" ? raw.nodeId : "",
                category:    raw.category,
                channels:    typeof raw.channels === "number" ? raw.channels : 0,
                primaryIp:   raw.primaryIp,
                secondaryIp: raw.secondaryIp,
                overrideIp:  cleanedOverrides,
                port:        typeof raw.port === "number" && raw.port > 0 ? raw.port : 5004,
            };
            newIndex.set(raw.primaryIp,   id);
            newIndex.set(raw.secondaryIp, id);
            if (cleanedOverrides){
                for (const k of Object.keys(cleanedOverrides)){
                    newIndex.set(cleanedOverrides[k], id);
                }
            }
        }
        this.leases = newLeases;
        this.ipToSender = newIndex;
        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Imported " + Object.keys(newLeases).length + " leases, dropped " + dropped + ".");
        return { imported: Object.keys(newLeases).length, dropped };
    }


    // ----- Internal: index helpers -----

    private claimIp(ip: string, senderId: string) {
        if (!ip) return;
        const owner = this.ipToSender.get(ip);
        if (owner && owner !== senderId) {
            SyncLog.log("warn", "Multicast Lease", "claimIp overwrote owner for " + ip + ": " + owner + " → " + senderId);
        }
        this.ipToSender.set(ip, senderId);
    }
    private releaseIp(ip: string, senderId: string) {
        if (!ip) return;
        if (this.ipToSender.get(ip) === senderId) {
            this.ipToSender.delete(ip);
        }
    }
    private evictConflict(ip: string, exceptSenderId: string) {
        const owner = this.ipToSender.get(ip);
        if (!owner || owner === exceptSenderId) return;
        SyncLog.log("warn", "Multicast Lease", "Manual edit claims " + ip + " — releasing conflicting lease of " + owner);
        // Drop the whole conflicting lease; it'll be re-allocated on next reconcile.
        const l = this.leases[owner];
        if (l) {
            this.releaseIp(l.primaryIp,   owner);
            this.releaseIp(l.secondaryIp, owner);
            delete this.leases[owner];
        }else{
            this.ipToSender.delete(ip);
        }
    }


    // ----- Internal: persistence -----

    private load() {
        try {
            if (!fs.existsSync(STATE_PATH)) return;
            const raw = fs.readFileSync(STATE_PATH, "utf8");
            const data = JSON.parse(raw);
            if (data && data.leases && typeof data.leases === "object") {
                let dropped = 0;
                for (const id in data.leases) {
                    const l = data.leases[id];
                    if (!l || !["audio","video"].includes(l.category)) { dropped++; continue; }

                    // Drop leases with empty / invalid IPs — older bugs could
                    // produce these and they cause an infinite reconcile loop.
                    if (!this.ipIsValid(l.primaryIp) || !this.ipIsValid(l.secondaryIp)) {
                        SyncLog.log("warn", "Multicast Lease", "Dropping lease with invalid IPs on load: " + id + " (primary='" + l.primaryIp + "', secondary='" + l.secondaryIp + "')");
                        dropped++;
                        continue;
                    }

                    // Skip on collision — first lease loaded wins.
                    if (this.ipToSender.has(l.primaryIp) || this.ipToSender.has(l.secondaryIp)) {
                        SyncLog.log("warn", "Multicast Lease", "Skipping duplicate lease on load for sender " + id);
                        dropped++;
                        continue;
                    }
                    // Sanitise overrideIp: drop invalid entries, skip claims
                    // that collide with other leases or with the reserved pair.
                    let cleanedOverrides: { [k: string]: string } | undefined;
                    if (l.overrideIp && typeof l.overrideIp === "object"){
                        cleanedOverrides = {};
                        for (const k of Object.keys(l.overrideIp)){
                            const v = l.overrideIp[k];
                            if (!v || typeof v !== "string" || !this.ipIsValid(v)) continue;
                            // If override matches the reserved IP, just drop it
                            const reserved = (k === "0") ? l.primaryIp : (k === "1" ? l.secondaryIp : "");
                            if (v === reserved) continue;
                            if (this.ipToSender.has(v)) continue;
                            cleanedOverrides[k] = v;
                        }
                        if (Object.keys(cleanedOverrides).length === 0) cleanedOverrides = undefined;
                    }
                    l.overrideIp = cleanedOverrides;

                    this.leases[id] = l;
                    this.ipToSender.set(l.primaryIp,   id);
                    this.ipToSender.set(l.secondaryIp, id);
                    if (cleanedOverrides){
                        for (const k of Object.keys(cleanedOverrides)){
                            this.ipToSender.set(cleanedOverrides[k], id);
                        }
                    }
                }
                SyncLog.log("info", "Multicast Lease", "Loaded " + Object.keys(this.leases).length + " leases from " + STATE_PATH + (dropped > 0 ? " (" + dropped + " dropped)" : ""));
                if (dropped > 0) {
                    // Rewrite a clean file
                    this.persist();
                }
            }
        } catch (e: any) {
            SyncLog.log("warn", "Multicast Lease", "Could not load " + STATE_PATH + ": " + e.message);
        }
    }

    private persist() {
        try {
            const dir = path.dirname(STATE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = STATE_PATH + ".tmp";
            const data = { version: 1, leases: this.leases };
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, STATE_PATH);
        } catch (e: any) {
            SyncLog.log("error", "Multicast Lease", "Could not persist " + STATE_PATH + ": " + e.message);
        }
    }


    // ----- Internal: classification & pair allocation -----

    private categorise(mediaType: string, _channels: number): MulticastCategory | null {
        if (!mediaType) return null;
        if (mediaType.startsWith("video/")) return "video";
        if (mediaType.startsWith("audio/")) return "audio";
        return null;
    }

    /**
     * Find a free odd/even pair in `pool`. Both addresses must be unclaimed
     * globally, and neither may be on the wire already: the external-IPs
     * provider (live `senderActiveData` snapshot) keeps the allocator off an
     * address any other NMOS sender transmits to.
     *
     * Returns null if the pool is exhausted.
     */
    private allocatePair(pool: Pool, forSenderId: string): { primary: string; secondary: string } | null {
        let firstOdd = (pool.start | 1) >>> 0;
        if (firstOdd < pool.start) firstOdd = (firstOdd + 2) >>> 0;

        let cursor = this.cursors.get(pool.key) || 0;
        if (!cursor || cursor < firstOdd || cursor > pool.end) {
            cursor = firstOdd;
        }
        // Ensure cursor is odd
        if ((cursor & 1) === 0) cursor = (cursor + 1) >>> 0;

        // External IPs are the ones currently advertised on the wire by any
        // OTHER sender. Polled once per allocate-call (snapshot).
        let externalIps: Set<string> = new Set<string>();
        try{
            if (this.externalIpsProvider){
                externalIps = this.externalIpsProvider(forSenderId) || new Set<string>();
            }
        }catch(e){}

        const pairs = pairCount(pool);
        let scanned = 0;
        let ip = cursor;
        while (scanned < pairs) {
            if (ip + 1 > pool.end) {
                ip = firstOdd;
            }
            const primStr = this.uint32ToIp(ip);
            const secStr  = this.uint32ToIp(ip + 1);
            const taken =
                this.ipToSender.has(primStr) || this.ipToSender.has(secStr) ||
                externalIps.has(primStr)     || externalIps.has(secStr);
            if (!taken) {
                this.cursors.set(pool.key, (ip + 2) >>> 0);
                return { primary: primStr, secondary: secStr };
            }
            ip = (ip + 2) >>> 0;
            scanned += 1;
        }
        return null;
    }


    // ----- Internal: IP helpers -----

    private ipToUint32(ip: string): number {
        const parts = (ip || "").split(".").map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return 0;
        return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
    private uint32ToIp(n: number): string {
        return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
    private ipIsValid(ip: string): boolean {
        const parts = (ip || "").split(".");
        if (parts.length !== 4) return false;
        for (const p of parts) {
            const n = parseInt(p, 10);
            if (isNaN(n) || n < 0 || n > 255) return false;
        }
        return true;
    }
}
