// Kill-switch for the v2 mission harness — the fresh-context supervisor loop,
// the deterministic mission state machine + off-LLM cost/liveness guard, the
// independent verifier gate, and the money/irreversible-only escalation rule.
//
// Landed as ONE redesign but gated behind this single flag so a regression in
// production (this ships via the auto-updater) is a one-flag rollback, not an
// emergency ship. Default ON. To fall back to legacy behavior, in the app's
// devtools/console:
//   localStorage.setItem("vault_chat_harness_v2", "false")
//
// Read through this gate at every branch point where v2 behavior diverges from
// legacy, so the fallback is total and instant. Per-install (localStorage), like
// fireSchedulesOnThisMachine — it is a machine-local operational switch, not a
// git-synced setting, so one machine can be rolled back independently.
const KEY = "vault_chat_harness_v2";

export function harnessV2Enabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export function setHarnessV2Enabled(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
}
