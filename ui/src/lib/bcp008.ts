// BCP-008 status words and colours, shared by the receiver status modal and
// the sender dialog of the Crosspoint page.

export function monitorStateName(v: number): string {
  return v === 1 ? "Healthy" : v === 2 ? "Partially healthy" : v === 3 ? "Unhealthy" : "Inactive";
}

export function monitorClassVal(v: number): string {
  return v === 1 ? "cp-status-ok" : v === 2 ? "cp-status-warn" : v === 3 ? "cp-status-err" : "cp-status-inactive";
}

// A BCP-008 statusMessage / overallStatusMessage is retained by the device
// until the next counter reset, so on a recovered status it describes a
// PAST condition. Devices word that themselves ("Previously: no essence
// …"), so the message is shown verbatim — prefixing it here produced
// "previous: Previously: …".
export function monitorMsg(status: number, message: string): string {
  return message || "";
}
