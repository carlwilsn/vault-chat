// Change by asking (reports/07 corrected model, point 4): a plugin edit is a draft first. A draft runs nowhere on its
// own until the one gate (src/gateResult.ts) lands it: a pass is a keep (live at once), a fail a discard. Each word is
// one record in the log, so the copy in effect is a fold of records, and undo is the switch back.
//
// A plugin with drafts has a slot of three files in one folder:
//   vault plugins (src/vaultPlugins.ts)  .vault-chat/plugins/<name>.js, <name>.draft.js, <name>.prev.js
// The live file runs; the draft waits for the gate; prev is what the last Keep replaced (absent: the built-in one, or for a
// vault plugin nothing), so Switch back swaps live and prev.
//
// Records (vault-level signals, folded by the supervisor with plugin.desired: src/pluginSupervisor.ts):
//   {type: "plugin.change", plugin, change: "keep" | "discard" | "switch", version, from?, at, by?, reason?}
// `version` is the copy's version (versionOf its code, or "built-in"); a keep and a switch also name `from`, the version
// they replaced. The box writes the record and moves the files (server/pluginDrafts.ts); a host trusts the record
// before the files have synced (a kept draft runs as the live copy at once).
//
// Shared by the app, the box, the builder script and the preview harness: no imports.

export const PLUGIN_CHANGE = "plugin.change";
export const CHANGE_KINDS = ["keep", "discard", "switch"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const BUILT_IN = "built-in";

export type ChangeSignal = { type: typeof PLUGIN_CHANGE; plugin: string; change: ChangeKind; version: string; from?: string; at: number; by?: string; reason?: string; what?: string; conv?: string };
/** A change record as a host folds it. `what`: the change in Carl's words (a keep names it); `conv`: the chat that asked. */
export type ChangeRecord = { seq: number; plugin: string; change: ChangeKind; version: string; from: string | null; at: number; by: string | null; reason: string | null; what?: string; conv?: string };

const CONV_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const cleanWhat = (w: unknown): string | undefined => (typeof w === "string" && w.trim() ? w.replace(/\s+/g, " ").trim().slice(0, 160) : undefined);
const cleanConv = (c: unknown): string | undefined => (typeof c === "string" && CONV_RE.test(c) ? c : undefined);

/** A copy's version: FNV-1a over its code, 8 hex digits (the same on the box and every host). */
export function versionOf(code: string): string {
  let h = 0x811c9dc5;
  const s = String(code ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const VERSION_RE = /^(?:[0-9a-f]{8}|built-in)$/;

// ---------------------------------------------------------------- slots

const VAULT_DIR = ".vault-chat/plugins";

/** Where a plugin's three files are (vault-relative), or null when the plugin has no slot. */
export type DraftSlot = { plugin: string; dir: string; live: string; draft: string; prev: string };


/** The slot of a vault plugin by its base name (pen-cursor for .vault-chat/plugins/pen-cursor.js). */
export const vaultSlot = (base: string, ext = ".js"): DraftSlot => ({ plugin: `${VAULT_DIR}/${base}${ext}`, dir: VAULT_DIR, live: `${base}${ext}`, draft: `${base}.draft${ext}`, prev: `${base}.prev${ext}` });

/** A file name in a plugin folder: its base and which file of the slot it is. */
export function slotFileOf(name: string): { base: string; ext: string; kind: "live" | "draft" | "prev" } | null {
  const m = /^([^.\/\\][^\/\\]*?)(\.draft|\.prev)?(\.m?js)$/i.exec(String(name ?? ""));
  if (!m) return null;
  return { base: m[1]!, ext: m[3]!, kind: m[2] ? (m[2].toLowerCase() === ".draft" ? "draft" : "prev") : "live" };
}

// ---------------------------------------------------------------- records

const WHO_RE = /^[a-z][a-z0-9_.-]{0,39}$/;

/** A change record from a request body ({plugin, change, version, reason?}), or why not. `from` is the box's to add. */
export function changeSignal(b: Record<string, unknown> | null, by: string, now: number): Omit<ChangeSignal, "from"> | { status: number; error: string } {
  const plugin = typeof b?.plugin === "string" ? b.plugin.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "") : "";
  if (!plugin || plugin.length > 400 || plugin.split("/").includes("..")) return { status: 400, error: "name the plugin: app/<name> or its vault path" };
  const change = b?.change;
  if (!CHANGE_KINDS.includes(change as ChangeKind)) return { status: 400, error: 'change is "keep", "discard" or "switch"' };
  const version = typeof b?.version === "string" ? b.version : change === "switch" ? "" : null;
  if (version === null || (version !== "" && !VERSION_RE.test(version))) return { status: 400, error: "version: the copy's version (8 hex digits) or built-in" };
  const reason = typeof b?.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 300) : undefined;
  const what = cleanWhat(b?.what);
  const conv = cleanConv(b?.conv);
  return { type: PLUGIN_CHANGE, plugin, change: change as ChangeKind, version, at: now, ...(WHO_RE.test(by) ? { by } : {}), ...(reason ? { reason } : {}), ...(what ? { what } : {}), ...(conv ? { conv } : {}) };
}

/** A log record's change, or null when it is not one. */
export function changeOf(rec: { seq: number; at?: number; type?: unknown; signal?: unknown }): ChangeRecord | null {
  const s = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
  if (!s || s.type !== PLUGIN_CHANGE || typeof s.plugin !== "string" || !CHANGE_KINDS.includes(s.change as ChangeKind) || typeof s.version !== "string") return null;
  return {
    seq: rec.seq,
    plugin: s.plugin,
    change: s.change as ChangeKind,
    version: s.version,
    from: typeof s.from === "string" ? s.from : null,
    at: Number(s.at ?? rec.at) || 0,
    by: typeof s.by === "string" ? s.by : null,
    reason: typeof s.reason === "string" ? s.reason : null,
    ...(typeof s.what === "string" ? { what: s.what } : {}),
    ...(typeof s.conv === "string" ? { conv: s.conv } : {}),
  };
}

// ---------------------------------------------------------------- which copy runs

export type SlotCode = { draft?: string; live?: string; prev?: string };
export type CopyKind = "draft" | "live" | "prev";
/** What runs for a slot: a copy (and why), or none (the built-in module; for a vault plugin, nothing). */
export type Choice = { kind: CopyKind | null; why: "kept" | "landed" | "live" | "built-in" };

/** The newest keep or switch: the version in effect, by the records. */
export function landing(changes: readonly ChangeRecord[]): ChangeRecord | null {
  let out: ChangeRecord | null = null;
  for (const c of changes) if ((c.change === "keep" || c.change === "switch") && (!out || c.seq > out.seq)) out = c;
  return out;
}

/** The word on one version of a draft: kept, discarded, or none yet. */
export function decision(changes: readonly ChangeRecord[], version: string): ChangeKind | null {
  let out: ChangeRecord | null = null;
  for (const c of changes) if (c.version === version && c.change !== "switch" && (!out || c.seq > out.seq)) out = c;
  return out?.change ?? null;
}

/** Whether the slot's draft waits (it exists and nobody decided on this version). */
export function draftPending(slot: SlotCode, changes: readonly ChangeRecord[]): string | null {
  if (slot.draft === undefined) return null;
  const v = versionOf(slot.draft);
  if (decision(changes, v) !== null) return null;
  if (landing(changes)?.version === v) return null;
  return v;
}

/**
 * Which copy of a slot runs. The draft only when kept by a record whose files have not moved yet; the version the newest keep/switch names when its file is here; else the live
 * copy (a live copy written since the switch, outside the records, runs too); else none.
 */
export function chooseCopy(slot: SlotCode, changes: readonly ChangeRecord[]): Choice {
  const dv = slot.draft !== undefined ? versionOf(slot.draft) : null;
  const lv = slot.live !== undefined ? versionOf(slot.live) : null;
  const pv = slot.prev !== undefined ? versionOf(slot.prev) : null;
  const land = landing(changes);
  if (land) {
    if (dv && land.version === dv) return { kind: "draft", why: "kept" };
    if (lv && land.version === lv) return { kind: "live", why: "landed" };
    if (pv && land.version === pv && lv === land.from) return { kind: "prev", why: "landed" };
    if (land.version === BUILT_IN && (!lv || lv === land.from)) return { kind: null, why: "built-in" };
  }
  return lv ? { kind: "live", why: "live" } : { kind: null, why: "built-in" };
}

// ---------------------------------------------------------------- what a draft is

/** The one line a draft says it is: an app plugin's header `what`, a vault plugin's `// @vc-change ...` line or meta `change`. */
export function draftWhat(code: string): string {
  const s = String(code ?? "");
  const first = s.split("\n", 1)[0]!;
  if (first.startsWith("// @vc-app-plugin ")) {
    try {
      const h = JSON.parse(first.slice("// @vc-app-plugin ".length));
      if (typeof h?.what === "string" && h.what.trim()) return h.what.trim().slice(0, 160);
    } catch {
      /* no header: the plugin's name is said instead */
    }
  }
  const line = /^\s*\/\/\s*@vc-change\s+(.+)$/m.exec(s.slice(0, 4000));
  if (line) return line[1]!.trim().slice(0, 160);
  const meta = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bchange\s*:\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(s.slice(0, 8000));
  return meta ? meta[2]!.replace(/\\(.)/g, "$1").trim().slice(0, 160) : "";
}

// ---------------------------------------------------------------- the typing limit

/** A draft that makes composer typing slower than this (median keystroke-to-paint, ms) fails the gate; a kept one
 *  switches back by itself. */
export const TRY_SLOW_MS = 50;
/** Keystrokes measured before the median counts. */
export const TRY_SLOW_KEYS = 8;
/** The window of keystrokes the median is over. */
export const TRY_SLOW_WINDOW = 12;

/** The median of the last keystrokes, or null when too few. */
export function slowMedian(samples: readonly number[]): number | null {
  if (samples.length < TRY_SLOW_KEYS) return null;
  const v = samples.slice(-TRY_SLOW_WINDOW).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

// ---------------------------------------------------------------- auto-revert after Keep

/** How long after a Keep the kept copy is watched: when it throws, fails to load or slows typing past TRY_SLOW_MS in
 *  that time, it switches back by itself (a switch record by "auto", with the reason). */
export const KEEP_WATCH_MS = 24 * 3600_000;

/** Typing speed is judged against a kept change only this long after it applied (src/changeFlow.ts DEADMAN_MS): a
 *  slowdown hours later is something else (a big PDF opened), never the change. */
export const KEEP_TYPING_MS = 10 * 60_000;

/** The keep under watch: the newest keep / switch is a keep (of a copy that replaced another), at most KEEP_WATCH_MS
 *  old. Null: nothing to switch back to on its own (no keep, already switched, or long enough ago). */
export function watchedKeep(changes: readonly ChangeRecord[], now: number): ChangeRecord | null {
  const l = landing(changes);
  if (!l || l.change !== "keep" || (l.from ?? BUILT_IN) === l.version) return null;
  return now - l.at <= KEEP_WATCH_MS && now >= l.at - 60_000 ? l : null;
}
