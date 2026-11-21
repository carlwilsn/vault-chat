// How a change reaches Carl: no card, no glow, no Try step. Everything is a line in a chat.
//
// - Every gated change (Plugins submit, asked for or not; a settings draft; a migration; the app's core): nothing reaches
//   the laptop until the one gate (src/gateResult.ts) has passed it. Then it applies at once (a keep by "gate") and the
//   chat that submitted it gets "Done: <what> (what was checked)" with Undo. A fail, or a gate that could not run, is one
//   plain line there when Carl asked for it.
// - Safety outside the part changed: Undo of the last applied change in the native shell (Ctrl+Alt+Z, the tray menu),
//   and a dead-man's switch: for DEADMAN_MS after a change applied, the app must keep reporting healthy (the chat pane
//   renders and answers a ping); when it does not, the change reverts by itself and the chat says so
//   (src/changeSafety.ts, src-tauri/src/safety.rs). A kept copy that throws or slows typing switches back by itself too.
//
// The words Carl reads are plain: no hashes, no version numbers, no internal notes.
//
// Shared by the box, the app, the gate script and the preview harness: imports only src/pluginDrafts.ts (none).

import { landing, type ChangeRecord } from "./pluginDrafts";

/** What a chat line offers for a change: Undo of an applied one, or nothing (a plain line). Lines written before the
 *  Try step was removed may still say "try": they draw nothing. */
export type ChangeOffer = "undo" | "try";
/** The change a chat line is about (a notice's `change`). */
/** `vault`: the vault (its name) whose records the change is in, for a part that is one per vault (an app or vault plugin). */
export type ChangeRef = { plugin: string; version: string; offer?: ChangeOffer; vault?: string };

/** How long after a change applied the app must keep reporting healthy (else it reverts by itself). */
export const DEADMAN_MS = 10 * 60_000;
/** How often the app checks itself while a change is watched. */
export const HEALTH_EVERY_MS = 4_000;
/** Checks in a row that must fail before the change reverts (about 12 s). */
export const HEALTH_MISSES = 3;
/** The native shell's side: no healthy word from the app for this long while watching, and it reverts the change. */
export const NATIVE_SILENCE_MS = 30_000;
/** The fixed native shortcut that undoes the last applied change (src-tauri/src/safety.rs). */
export const UNDO_CHORD = "Ctrl+Alt+Z";

/** A chat line's id for a change (one line per change and kind, so writing it twice writes it once). */
export const changeLineId = (kind: "done" | "failed" | "auto", plugin: string, version: string) => `change-${kind}:${plugin}@${version}`;

/** Carl's words for what a change does: no hashes, no "(main …)" notes, no tags; the plugin's name when there are none. */
export function plainWhat(what: string | null | undefined, name?: string | null): string {
  let w = String(what ?? "")
    .replace(/@vc-change\s*/gi, "")
    .replace(/\((?:main|commit|core|version|v)\s+[^)]*\)/gi, "")
    .replace(/\(\d{4}-\d{2}-\d{2}[^)]*\)/g, "")
    .replace(/\b[0-9a-f]{7,64}\b/gi, (m) => ((/[a-f]/i.test(m) && /\d/.test(m)) || m.length >= 12 ? "" : m))
    .replace(/\bfrom main\b/gi, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,;:-]+$/, "");
  if (/^the app's (?:frontend|core)$/i.test(w)) w = "an update to the app";
  if (!w) w = name ? `${name} updated` : "a change";
  return w.length > 140 ? `${w.slice(0, 139)}…` : w;
}

/** Why a change did not apply, in one plain line (the gate's reasons, without file names, versions or ms figures). */
export function plainWhy(reasons: readonly string[] | string | null | undefined): string {
  const list = (Array.isArray(reasons) ? reasons : [String(reasons ?? "")]).map((r) => String(r));
  const first = list.find((r) => r.trim()) ?? "";
  if (/capture|real data|dataset|copy of/i.test(first)) return "I couldn't get a fresh copy of your data to check it on";
  if (/chat stopped|not healthy|stopped responding|\bping\b/i.test(first)) return "the chat stopped responding";
  if (/could not run|gave no result/i.test(first)) return "the check could not run";
  if (/did not run|failed to load|mount|did not say ready|fell back/i.test(first)) return "it would not start";
  if (/\bit stopped\b|threw|broke|crash/i.test(first)) return "it stopped working";
  if (/typing/i.test(first)) return "it made typing slow";
  if (/errors only with the draft|threw|error/i.test(first)) return "it caused errors";
  return plainWhat(first.split(/[:(]/)[0], null).toLowerCase() || "the check failed";
}

/** What the gate checked, in Carl's words, by its runner (src/gateResult.ts GateResult.runner), or null. */
export function checkedText(runner: string | null | undefined): string | null {
  const r = String(runner ?? "");
  if (r === "ui-drive" || r === "settings+ui-drive") return "checked in a hidden copy of the app on your real data";
  if (r.includes("ui-harness")) return "checked side by side with the current version on a copy of your data";
  if (r === "box-copy") return "checked beside the running copy on a copy of your vault";
  if (r === "settings") return "checked that the box takes every value";
  if (r === "migration-dry-run") return "checked by a dry run on a copy of its data";
  if (r === "core-bundle") return "checked its files and that it starts";
  return null;
}

export const doneText = (what: string, checked?: string | null) => `Done: ${what}${checked ? ` (${checked})` : ""}`;
export const failedText = (what: string, why: string) => `Didn't apply ${what}: ${why}.`;
export const notYetText = (what: string, why: string) => `Didn't apply ${what} yet: ${why}. It's kept as a draft; ask again to retry.`;
export const autoUndoText = (what: string, why: string) => `Undid ${what} by itself: ${why}.`;

/** Where a chat line's change stands now, from the records. */
export type LineState =
  | { state: "applied" } // an applied change: Undo
  | { state: "undone"; auto: boolean; why: string | null }
  | { state: "dropped" }
  | { state: "gone" }; // replaced by a later change, or the draft is gone

/** A chat line's state. */
export function lineState(ref: ChangeRef, changes: readonly ChangeRecord[]): LineState {
  const v = ref.version;
  const land = landing(changes);
  const kept = [...changes].reverse().find((c) => c.change === "keep" && c.version === v) ?? null;
  if (kept) {
    if (land && land.version === v && land.seq >= kept.seq) return { state: "applied" };
    // The switch that took this version away (its `from`), when it is still the newest word: undone.
    const back = changes.find((c) => c.change === "switch" && c.seq > kept.seq);
    if (back && land && land.seq === back.seq && (back.from === v || back.from === null)) return { state: "undone", auto: back.by === "auto", why: back.reason };
    return { state: "gone" };
  }
  const dropped = [...changes].reverse().find((c) => c.change === "discard" && c.version === v) ?? null;
  if (dropped) return dropped.by === "auto" ? { state: "undone", auto: true, why: dropped.reason } : { state: "dropped" };
  return { state: "gone" };
}

/** The words a line shows after its text for a state (null: none, its buttons say it). */
export function stateWords(s: LineState): string | null {
  // By itself: the chat's own line right after says why (server/changeNotices.ts autoUndone).
  if (s.state === "undone") return s.auto ? "Undone by itself." : "Undone.";
  if (s.state === "dropped") return "Not applied.";
  return null;
}
