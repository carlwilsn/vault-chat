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

// Two-lane mission chat: a message to a BUSY mission is answered immediately by
// the assistant-persona conversational front (reading a snapshot of the
// executor's live state) instead of silently queueing behind the executor's
// turn — while the executor keeps working and still receives the message for
// steering. One thread on the surface; two agents behind it. Default OFF: this
// introduces concurrent runs on one mission thread, so it stays dark in
// production until a live box self-test clears it, then flip on per-machine:
//   localStorage.setItem("vault_chat_two_lane_chat", "true")
const TWO_LANE_KEY = "vault_chat_two_lane_chat";

export function twoLaneMissionChatEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(TWO_LANE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setTwoLaneMissionChatEnabled(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(TWO_LANE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
}
