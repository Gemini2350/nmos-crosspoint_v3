/*
 * AMWA IS-13 NMOS Annotation — the pure parts, free of state and I/O so they
 * can be tested. A Node that supports it lists the Annotation API in its IS-04
 * `services`; a PATCH there changes a resource's label (description, tags) on
 * the device itself, and the device signals it through its IS-04 `version`,
 * so every Controller sees the new name via the registry — nothing is polled.
 */

export const ANNOTATION_SERVICE = "urn:x-nmos:service:annotation/";

/** Annotation API base href of an IS-04 Node, newest version first; "" when
 *  the Node does not offer one. Always ends with "/". */
export function annotationHref(node: any): string {
    const services: any[] = Array.isArray(node?.services) ? node.services : [];
    const found = services
        .filter((s: any) => s && typeof s.type === "string" && s.type.startsWith(ANNOTATION_SERVICE) && typeof s.href === "string" && s.href)
        .map((s: any) => ({ href: s.href as string, ver: s.type.substring(ANNOTATION_SERVICE.length) }))
        .sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
    if (found.length === 0) return "";
    const h = found[0].href;
    return h.endsWith("/") ? h : h + "/";
}

export type AnnotationKind = "node" | "device" | "sender" | "receiver";

/** Path below the Annotation API base: node/self, node/devices/{id}, … */
export function annotationPath(kind: AnnotationKind, id: string): string {
    if (kind === "node") return "node/self";
    return "node/" + kind + "s/" + id;
}

/**
 * The PATCH body for a new label. A string sets it (trimmed; empty is refused
 * because IS-13 reserves the reset for null), null asks the device to restore
 * its default label. Description and tags are left alone: a PATCH without
 * them changes nothing there.
 */
export function buildLabelPatch(label: string | null): { label: string | null } {
    if (label === null) return { label: null };
    const t = ("" + label).trim();
    if (t === "") throw new Error("An empty label is not set on a device — reset it instead.");
    return { label: t };
}

/** IS-13 asks clients to report the response's `error` field to the user. */
export function annotationErrorText(status: number | undefined, body: any, fallback: string): string {
    const e = body && typeof body === "object" ? (body.error || "") : "";
    const d = body && typeof body === "object" && body.debug ? " (" + body.debug + ")" : "";
    if (e) return "Device answered " + (status || "") + ": " + e + d;
    return fallback;
}
