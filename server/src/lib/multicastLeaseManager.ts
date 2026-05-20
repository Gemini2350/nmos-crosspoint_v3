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
 * Categorisation:
 *   - video      → media_type starts with "video/"
 *   - audioLow   → audio with channels <= 2
 *   - audioHigh  → audio with channels >  2
 *   - other      → not auto-allocated (no range, no lease)
 *
 * Duplicate protection: we maintain a *global* IP→sender index across all
 * categories. The allocator checks both the primary and the secondary slot
 * against this index, so overlapping CIDR ranges between categories or
 * manual edits cannot produce a duplicate Multicast.
 *
 * Persistence: ./state/multicastLeases.json (atomic write).
 */

import { SyncLog } from "./syncLog";

const fs = require("fs");
const path = require("path");

export type MulticastCategory = "audioLow" | "audioHigh" | "video";

export interface MulticastLease {
    createdAt: string;
    deviceLabel: string;
    nodeId: string;
    category: MulticastCategory;
    channels: number;
    primaryIp: string;       // odd, used for Leg 1
    secondaryIp: string;     // odd+1, used for Leg 2 (reserved even for single-leg senders)
    port: number;
}

export interface LeaseStats {
    used: number;
    total: number;
}

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

    // Round-robin cursor per category (uint32, odd-aligned).
    private cursor: { [cat in MulticastCategory]: number } = {
        audioLow: 0, audioHigh: 0, video: 0,
    };

    private onChange: (() => void) | null = null;

    constructor(settings: any) {
        MulticastLeaseManager._instance = this;
        this.settings = settings;
        this.load();
    }

    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    private notifyChange() {
        if (this.onChange) {
            try { this.onChange(); } catch { /* swallow */ }
        }
    }

    isEnabled(): boolean {
        return !!(this.settings && this.settings.autoMulticast && this.settings.autoMulticast.enabled);
    }

    setSettings(settings: any) { this.settings = settings; }


    // ----- Public API -----

    /**
     * Make sure a sender has a lease. If one already exists, returns it. If
     * not, attempts to allocate from the appropriate pool (only when the
     * manager is enabled).
     */
    ensureLease(args: {
        senderId: string;
        mediaType: string;
        channels: number;
        deviceLabel?: string;
        nodeId?: string;
        port?: number;
    }): MulticastLease | null {
        if (this.leases[args.senderId]) {
            return this.leases[args.senderId];
        }
        if (!this.isEnabled()) {
            return null;
        }

        const category = this.categorise(args.mediaType, args.channels);
        if (!category) {
            return null;
        }

        const pair = this.allocatePair(category);
        if (!pair) {
            SyncLog.log("warn", "Multicast Lease", "Pool exhausted in category " + category + " — cannot allocate for " + args.senderId);
            return null;
        }

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
        SyncLog.log("info", "Multicast Lease", "Allocated " + pair.primary + " / " + pair.secondary + " for sender " + args.senderId + " (" + category + ")");
        return lease;
    }

    /**
     * Get the desired addresses for a sender (i.e. what the IS-05 active
     * transport_params should look like). Returns null if no lease exists.
     */
    getDesiredAddresses(senderId: string): { primaryIp: string; secondaryIp: string; port: number } | null {
        const l = this.leases[senderId];
        if (!l) return null;
        return { primaryIp: l.primaryIp, secondaryIp: l.secondaryIp, port: l.port };
    }

    getLease(senderId: string): MulticastLease | null {
        return this.leases[senderId] || null;
    }

    /**
     * Apply a manual edit from the user. Updates the lease's leg IP and
     * adjusts the global IP index. If the new IP is already claimed by
     * *another* lease, that conflicting lease is fully released — the
     * conflicted sender will reallocate fresh on the next reconcile cycle.
     */
    recordManualEdit(senderId: string, legIndex: number, ip: string, port?: number) {
        let lease = this.leases[senderId];
        if (!lease) {
            // No existing lease — we can't classify the sender from here
            // (we have no media-type info). Just ignore. The reconcile path
            // will create a lease the next time it sees this sender.
            return;
        }

        // Kick out any lease that currently holds the new IP
        if (ip) {
            this.evictConflict(ip, senderId);
        }

        if (legIndex === 0) {
            // Release the lease's previous primary
            if (lease.primaryIp){ this.releaseIp(lease.primaryIp, senderId); }
            lease.primaryIp = ip;
            this.claimIp(ip, senderId);

            // If the new primary is odd, also slide the secondary along to
            // keep the +1 pair invariant. We only do this if the user hasn't
            // separately put the secondary somewhere far away.
            try{
                if (this.ipIsValid(ip) && (this.ipToUint32(ip) % 2 === 1)) {
                    let expectedSec = this.uint32ToIp(this.ipToUint32(ip) + 1);
                    if (lease.secondaryIp && lease.secondaryIp !== expectedSec) {
                        this.releaseIp(lease.secondaryIp, senderId);
                    }
                    // Don't auto-claim if it's owned by someone else
                    if (!this.ipToSender.has(expectedSec) || this.ipToSender.get(expectedSec) === senderId) {
                        lease.secondaryIp = expectedSec;
                        this.claimIp(expectedSec, senderId);
                    }
                }
            }catch(e){}
        } else if (legIndex === 1) {
            if (lease.secondaryIp){ this.releaseIp(lease.secondaryIp, senderId); }
            lease.secondaryIp = ip;
            this.claimIp(ip, senderId);
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

    getStats(): { [cat in MulticastCategory]: LeaseStats } {
        const counts: { [cat in MulticastCategory]: number } = {
            audioLow: 0, audioHigh: 0, video: 0,
        };
        for (const id in this.leases) {
            const l = this.leases[id];
            if (l && (l.category in counts)) counts[l.category]++;
        }
        const result: any = {};
        for (const cat of ["audioLow", "audioHigh", "video"] as MulticastCategory[]) {
            const range = this.getRangeFor(cat);
            let total = 0;
            if (range) total = Math.floor((range.end - range.start + 1) / 2);
            result[cat] = { used: counts[cat], total };
        }
        return result;
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
            if (!raw || !raw.category || !["audioLow","audioHigh","video"].includes(raw.category)) { dropped++; continue; }
            if (typeof raw.primaryIp !== "string" || typeof raw.secondaryIp !== "string") { dropped++; continue; }
            if (newIndex.has(raw.primaryIp) || newIndex.has(raw.secondaryIp)) {
                SyncLog.log("warn", "Multicast Lease", "Import dropping duplicate lease for " + id + " — IP already claimed.");
                dropped++;
                continue;
            }
            newLeases[id] = {
                createdAt:   typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
                deviceLabel: typeof raw.deviceLabel === "string" ? raw.deviceLabel : "",
                nodeId:      typeof raw.nodeId === "string" ? raw.nodeId : "",
                category:    raw.category,
                channels:    typeof raw.channels === "number" ? raw.channels : 0,
                primaryIp:   raw.primaryIp,
                secondaryIp: raw.secondaryIp,
                port:        typeof raw.port === "number" && raw.port > 0 ? raw.port : 5004,
            };
            newIndex.set(raw.primaryIp,   id);
            newIndex.set(raw.secondaryIp, id);
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
                    if (!l || !["audioLow","audioHigh","video"].includes(l.category)) continue;

                    // Skip on collision — first lease loaded wins. Avoids
                    // re-importing duplicates that a buggy older version may
                    // have written.
                    if (this.ipToSender.has(l.primaryIp) || this.ipToSender.has(l.secondaryIp)) {
                        SyncLog.log("warn", "Multicast Lease", "Skipping duplicate lease on load for sender " + id);
                        dropped++;
                        continue;
                    }
                    this.leases[id] = l;
                    if (l.primaryIp)   this.ipToSender.set(l.primaryIp,   id);
                    if (l.secondaryIp) this.ipToSender.set(l.secondaryIp, id);
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

    private categorise(mediaType: string, channels: number): MulticastCategory | null {
        if (!mediaType) return null;
        if (mediaType.startsWith("video/")) return "video";
        if (mediaType.startsWith("audio/")) {
            return (channels <= 2) ? "audioLow" : "audioHigh";
        }
        return null;
    }

    private getRangeFor(category: MulticastCategory): { start: number; end: number } | null {
        try {
            const cidr = this.settings?.multicastRanges?.[category];
            if (typeof cidr !== "string" || !cidr) return null;
            return this.parseCidr(cidr);
        } catch { return null; }
    }

    /**
     * Find a free odd/even pair in the configured range. Both addresses must
     * be unclaimed globally — guards against overlapping CIDR ranges between
     * categories. Returns null if the pool is exhausted.
     */
    private allocatePair(category: MulticastCategory): { primary: string; secondary: string } | null {
        const range = this.getRangeFor(category);
        if (!range) return null;

        let firstOdd = (range.start | 1) >>> 0;
        if (firstOdd < range.start) firstOdd = (firstOdd + 2) >>> 0;

        let cursor = this.cursor[category];
        if (!cursor || cursor < firstOdd || cursor > range.end) {
            cursor = firstOdd;
        }
        // Ensure cursor is odd
        if ((cursor & 1) === 0) cursor = (cursor + 1) >>> 0;

        const pairCount = Math.floor((range.end - range.start + 1) / 2);
        let scanned = 0;
        let ip = cursor;
        while (scanned < pairCount) {
            if (ip + 1 > range.end) {
                ip = firstOdd;
            }
            const primStr = this.uint32ToIp(ip);
            const secStr  = this.uint32ToIp(ip + 1);
            if (!this.ipToSender.has(primStr) && !this.ipToSender.has(secStr)) {
                this.cursor[category] = (ip + 2) >>> 0;
                return { primary: primStr, secondary: secStr };
            }
            ip = (ip + 2) >>> 0;
            scanned += 1;
        }
        return null;
    }


    // ----- Internal: IP helpers -----

    private parseCidr(cidr: string): { start: number; end: number } {
        const [ipStr, bitsStr] = cidr.split("/");
        const bits = parseInt(bitsStr, 10);
        const base = this.ipToUint32(ipStr);
        const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
        const start = (base & mask) >>> 0;
        const end = (start | ((~mask) >>> 0)) >>> 0;
        return { start, end };
    }
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
