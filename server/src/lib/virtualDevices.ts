/*
 * The virtual NMOS Node's devices, which hold the virtual senders, and where
 * the Node registers — the pure parts, free of state and I/O so they can be
 * tested. parseSettings and the Setup save route use them.
 */

export interface VirtualDevice { id: string; name: string; }

/** "registry": the registry the crosspoint uses. "custom": a registration
 *  API of its own, for a registry whose query and registration API differ. */
export interface VirtualRegistration { mode: "registry" | "custom"; host: string; port: number; }

const uuidRe = /^[a-f0-9-]{36}$/i;
const str = (v: any): string => (typeof v === "string" ? v.trim() : "");

/**
 * settings.virtualDevices, checked. Settings from before there were several
 * get the one device virtualNode.deviceId has named, so the senders saved
 * then keep their device. Empty is fine, unless senders need a device.
 */
export function normaliseVirtualDevices(raw: any, firstId: string, mkUuid: () => string, senderCount = 0): VirtualDevice[] {
    const out: VirtualDevice[] = [];
    const seen = new Set<string>();
    for (const d of Array.isArray(raw) ? raw : []) {
        if (!d || typeof d !== "object") continue;
        let id = (typeof d.id === "string" && uuidRe.test(d.id) && !seen.has(d.id)) ? d.id : mkUuid();
        seen.add(id);
        out.push({ id, name: str(d.name).slice(0, 64) || ("Virtual Device " + (out.length + 1)) });
    }
    if (out.length === 0 && (!Array.isArray(raw) || senderCount > 0)) out.push({ id: firstId, name: "Virtual Senders" });
    return out;
}

/** Each sender's device: its own when that still exists, else the first. */
export function assignSenderDevices<T extends { deviceId?: any }>(senders: T[], devices: VirtualDevice[]): Array<T & { deviceId: string }> {
    const ids = new Set(devices.map((d) => d.id));
    return senders.map((s) => ({ ...s, deviceId: (typeof s.deviceId === "string" && ids.has(s.deviceId)) ? s.deviceId : devices[0].id }));
}

/**
 * The Setup page's devices. The page names a device by `key`: an existing
 * device's id, or anything else for a new one, which gets a fresh id here.
 * Returns the devices and how the page's keys map to ids, so the senders,
 * which name their device by key, can follow.
 */
export function devicesFromInput(input: any, prev: VirtualDevice[], mkUuid: () => string): { devices: VirtualDevice[], keyToId: { [key: string]: string } } {
    const prevIds = new Set(prev.map((d) => d.id));
    const keyToId: { [key: string]: string } = {};
    const devices: VirtualDevice[] = [];
    for (const d of Array.isArray(input) ? input : []) {
        const key = str(d?.key);
        if (!key || keyToId[key]) continue;
        const id = prevIds.has(key) ? key : mkUuid();
        keyToId[key] = id;
        devices.push({ id, name: str(d?.name).slice(0, 64) || ("Virtual Device " + (devices.length + 1)) });
    }
    return { devices, keyToId };
}

export function normaliseRegistration(raw: any): VirtualRegistration {
    const port = Number(raw?.port);
    return {
        mode: raw?.mode === "custom" ? "custom" : "registry",
        host: str(raw?.host),
        port: (Number.isInteger(port) && port > 0 && port < 65536) ? port : 0,
    };
}

/** The page's registration choice, checked. Throws an Error whose message
 *  the page shows. */
export function registrationFromInput(raw: any): VirtualRegistration {
    const r = normaliseRegistration(raw);
    if (r.mode === "custom") {
        if (!r.host) throw new Error("Enter the IP or host name of the registration API.");
        if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(r.host)) throw new Error("Not an IP or host name: " + r.host);
        if (!r.port) throw new Error("The registration API port must be between 1 and 65535.");
    }
    return r;
}

/** "http://host:port", an IPv6 address in brackets. */
export function httpBase(host: string, port: number): string {
    const h = (host.includes(":") && !host.startsWith("[")) ? "[" + host + "]" : host;
    return "http://" + h + ":" + port;
}
