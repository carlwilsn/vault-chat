// The models a chat runs on, and how hard it thinks.
//
// Claude Code names a model by what it is for — opus, sonnet, haiku — and
// resolves the alias itself. What Carl must never see is a raw id: the picker
// shows "Opus 5.5", not "opus" or "claude-opus-5-5", and the names are the
// runtime's own (`supportedModels()` ModelInfo.displayName), not a list in here
// that goes stale the next time Anthropic ships a model. This module only says
// which families the picker offers, in which order, and what effort means.
import type { Effort, ModelChoice } from "../backend";
export type { Effort, ModelChoice };

/**
 * The families the picker lists FIRST, most capable first. Not a filter: a
 * family Anthropic ships tomorrow (claude-zephyr-6-0) is read from the
 * runtime's own rows and appended after these, so the picker needs no code
 * change for a new model.
 */
export const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
export type ModelFamily = string;

/**
 * The levels the control offers. The SDK's own (`EffortLevel`) are low, medium,
 * high, xhigh and max; Carl asked for four, so xhigh is folded away rather than
 * shown as a fifth step nobody can tell from high.
 */
export const EFFORTS = ["low", "medium", "high", "max"] as const;
export const isEffort = (e: unknown): e is Effort => typeof e === "string" && (EFFORTS as readonly string[]).includes(e);

/**
 * Which family a model belongs to, read from its id and its name: a bare alias
 * ("opus"), claude-<family>-<version> ("claude-zephyr-6-0"), a known family
 * named anywhere in the id/name (older "claude-3-5-sonnet"), or a display name
 * that starts with a word and a version ("Zephyr 6"). Null when none fits —
 * "claude-something-else" has no version, so it is not a model family.
 */
export function familyOf(m: { id: string; name?: string }): ModelFamily | null {
  const id = m.id.replace(/\[.*?\]/g, "").toLowerCase().trim();
  if (/^[a-z]+$/.test(id) && id !== "claude" && id !== "default") return id;
  const fromId = id.match(/^claude-([a-z]+)-\d/);
  if (fromId) return fromId[1]!;
  const hay = `${id} ${m.name ?? ""}`.toLowerCase();
  const known = MODEL_FAMILIES.find((f) => hay.includes(f));
  if (known) return known;
  const fromName = (m.name ?? "").trim().toLowerCase().match(/^([a-z]+)\s+\d/);
  return fromName ? fromName[1]! : null;
}

/** The version numbers in an id or name ("claude-opus-4-6" → [4,6]); dates ignored. */
function versionOf(m: { id: string; name?: string }): number[] {
  const fromId = m.id.replace(/\[.*?\]/g, "").split("-").slice(2);
  const nums: number[] = [];
  for (const p of fromId) {
    if (!/^\d{1,2}$/.test(p)) break;
    nums.push(Number(p));
  }
  if (nums.length) return nums;
  const n = (m.name ?? "").match(/\d+(?:\.\d+)*/);
  return n ? n[0].split(".").map(Number) : [];
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * The runtime's model list as the picker shows it: one row per family. Known
 * families come first in MODEL_FAMILIES order, then any family the runtime
 * lists that this file has never heard of, in the order the runtime gave them.
 *
 * Within a family the row to keep is the one whose id is the bare ALIAS —
 * `opus` is whatever Opus is now, and stays right when the next one ships.
 * Failing that (a family with no alias, like Fable), the newest by version;
 * on a tie, the first row the runtime listed.
 */
export function pickerModels(rows: readonly ModelChoice[]): ModelChoice[] {
  const out = new Map<ModelFamily, ModelChoice>();
  for (const row of rows) {
    const f = familyOf(row);
    if (!f) continue;
    const have = out.get(f);
    if (!have) out.set(f, row);
    else if (have.id !== f && (row.id === f || newer(versionOf(row), versionOf(have)))) out.set(f, row);
  }
  const known = MODEL_FAMILIES.filter((f) => out.has(f));
  const extra = [...out.keys()].filter((f) => !(MODEL_FAMILIES as readonly string[]).includes(f));
  return [...known, ...extra].map((f) => out.get(f)!);
}

/** "claude-opus-5-5" → "Opus 5.5"; null when the id carries no version. */
export function versionedName(id: string): string | null {
  // Strip "[1m]"-style tags; a version is the short numbers after the family,
  // stopping at a release date ("claude-haiku-4-5-20251001" → "4.5").
  const parts = id.replace(/\[.*?\]/g, "").replace(/^claude-/, "").split("-").filter(Boolean);
  const family = parts.shift();
  if (!family || !/^[a-z]+$/i.test(family)) return null;
  const nums: string[] = [];
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p)) break;
    nums.push(p);
  }
  const version = nums.join(".");
  return version ? `${family[0]!.toUpperCase()}${family.slice(1)} ${version}` : null;
}

/**
 * A model's name as Carl reads it, with its version: "Opus 5.5", never a bare
 * "Opus". The runtime's displayName for an alias row is the bare family, so the
 * version is read from what the alias resolves to (`resolvedModel`), then from
 * the row's own id, then from its description ("Opus 5.5 · …"), and only then
 * is the displayName kept as it is.
 */
export function modelName(r: { value?: string; resolvedModel?: string; displayName?: string; description?: string }): string {
  const shown = String(r.displayName ?? r.value ?? "").trim();
  if (/(^|\s)\d+(\.\d+)?(?![\w.])/.test(shown)) return shown; // "Sonnet 5.5", not "Opus (1M context)"
  const fam = familyOf({ id: String(r.value ?? ""), name: shown });
  const fits = (n: string | null) => (n && (!fam || n.toLowerCase().startsWith(fam)) ? n : null);
  const fromDesc = fam ? String(r.description ?? "").match(new RegExp(`\\b(${fam})\\s+(\\d+(?:\\.\\d+)?)\\b`, "i")) : null;
  return (
    fits(versionedName(String(r.resolvedModel ?? ""))) ??
    fits(versionedName(String(r.value ?? ""))) ??
    fits(fromDesc ? `${fromDesc[1]![0]!.toUpperCase()}${fromDesc[1]!.slice(1).toLowerCase()} ${fromDesc[2]}` : null) ??
    shown
  );
}

/**
 * What the picker shows before the runtime has told us its models: the three
 * aliases Claude Code resolves itself, under the only names that cannot be
 * wrong. The real names ("Opus 5.5") and any fourth family (Fable) come from
 * `supportedModels()` the moment a session has run — this list never guesses a
 * version number, and never offers a model the runtime might not have.
 */
export const FALLBACK_MODELS: ModelChoice[] = [
  { id: "opus", name: "Opus", efforts: [...EFFORTS] },
  { id: "sonnet", name: "Sonnet", efforts: [...EFFORTS] },
  { id: "haiku", name: "Haiku", efforts: [...EFFORTS] },
];

/** The aliases Claude Code resolves itself, which are what a box falls back to. */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

/** A Claude Code model: one of its aliases, or a pinned id like claude-opus-5. */
export function isClaudeModel(m: string): boolean {
  return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(m) || /^claude[A-Za-z0-9_.-]*$/.test(m);
}

/** A model id vault-chat will set. Claude's own, and nothing else: pi is gone. */
export function validModel(m: string): boolean {
  return isClaudeModel(m);
}
