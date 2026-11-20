// One gate for every swappable part (reports/10-hot-swap section 1 and next change 6): `gate <part> <candidate>` checks
// a candidate on a safe copy of real data with a runner suited to the part, gives one verdict, and lands it by one rule.
// This module is the shared vocabulary: which kind a part is, the verdict -> decision rule, and the one result record.
//
//   kind           parts                                       runner (scripts/gate.ts, server/gate.ts)
//   ui-plugin      app/<name> live copies, vault plugins       the live copy and the draft side by side in the app
//                                                              (scripts/draft-check.ts): errors, visible text, typing
//   preset         app/preset (preset.draft.json)              a preset at all, every mount an app plugin this app has,
//                                                              then the UI runner with the draft preset tried
//   box-plugin     box/<name>                                  live copy and draft loaded apart from the box on a copy
//                                                              of the vault (server/gateBox.ts): load, routes, tools
//   settings       app/settings-values (setting.draft)         every value one the box takes, it still waits, it changes
//                                                              something (server/settings.ts settingsDraftGate)
//   migration      migrate/<name>                              its dry run on a copy of the plugin's real state, in the
//                                                              box (server/gate.ts inBoxGate); Keep stays Carl's
//   frontend-core  app/core (a core bundle the box built)      its stored bytes: every file as the manifest says,
//                                                              index.html loads only its own files, no newer box API
//                                                              (server/coreBundles.ts judgeCore), once per bundle
//
// The verdict (Kayenta's success / marginal / failure): pass (nothing Carl can see changes, nothing new breaks),
// borderline (something he can see changes: is it what was asked for?), fail (it breaks: dropped). null: the gate could
// not run (the draft waits).
//
// The record: {type: "gate.result", part, kind, version, verdict, decision, reasons, runner, data?, what?, asked, conv?,
// at}, a vault-level signal the box writes when a gate ends (server/gate.ts recordGate); GET /api/v2/gate reads them.
//
// Shared by the app, the box and the scripts: imports only shared modules.
import { isMigrationId } from "./migrations";

export const GATE_RESULT = "gate.result";
export const PART_KINDS = ["ui-plugin", "preset", "box-plugin", "settings", "migration", "frontend-core"] as const;
export type PartKind = (typeof PART_KINDS)[number];
export type GateVerdict = "pass" | "borderline" | "fail";
export type GateDecision = "keep" | "discard" | "stage";

/** The ids of the parts that are not plugins' slots. */
export const PRESET_PART = "app/preset";
export const SETTINGS_PART = "app/settings-values";
export const CORE_PART_ID = "app/core";

export type GateResult = {
  part: string;
  kind: PartKind;
  /** The candidate's version (versionOf its code, a settings draft's version). */
  version: string;
  /** null: the gate could not run (the candidate waits). */
  verdict: GateVerdict | null;
  /** What it wrote: keep (applied), discard (dropped), stage (waits for Carl's Try), null: nothing (not landed). */
  decision: GateDecision | null;
  reasons: string[];
  /** Which runner judged it (ui-harness, preset, box-copy, settings). */
  runner: string;
  /** The data it ran on ("a fresh copy of the box's real data", "the synthetic vault" …). */
  data?: string;
  /** The candidate's own line (its @vc-change), or "". */
  what: string;
  asked: boolean;
  conv?: string | null;
  at: number;
};

/** Which kind of part an id is (a plugin id as the supervisor writes it), or null when no part. */
export function partKind(part: string): PartKind | null {
  const p = String(part ?? "");
  if (p === PRESET_PART) return "preset";
  if (p === SETTINGS_PART) return "settings";
  if (p === CORE_PART_ID) return "frontend-core";
  if (isMigrationId(p)) return "migration";
  if (/^box\/[a-z][a-z0-9-]{0,40}$/.test(p)) return "box-plugin";
  if (/^app\/[a-z][a-z0-9-]{0,40}$/.test(p) || /^\.vault-chat\/plugins\/[^/]+\.m?js$/i.test(p)) return "ui-plugin";
  return null;
}

/**
 * What the gate writes for a verdict (src/changeFlow.ts): a fail is dropped; what Carl asked for applies otherwise; a
 * change he did not ask for applies on a clear pass (nothing on screen changes) and is staged for his Try when something
 * on screen changes (borderline). A settings draft (the agent's own idea) and a migration (it reshapes Carl's data) are
 * never landed without Carl: staged (their "Try it?" line) unless they fail. Pure.
 */
export function gateDecision(kind: PartKind, v: { verdict: GateVerdict; reasons: string[] }, asked: boolean): { change: GateDecision; reason: string } {
  const why = v.reasons.join("; ").slice(0, 280);
  if (v.verdict === "fail") return { change: "discard", reason: `the gate failed: ${why}` };
  if (kind === "settings" || kind === "migration") return { change: "stage", reason: `the gate passed it; it waits for Carl: ${why}` };
  if (asked) return { change: "keep", reason: `asked for; the gate passed it: ${why}` };
  if (v.verdict === "pass") return { change: "keep", reason: `not asked for; the gate passed it: ${why}` };
  return { change: "stage", reason: `not asked for; something on screen changes: ${why}` };
}

/** The machine-readable last line a gate run prints (scripts/gate.ts): `VC-GATE {GateResult}`. */
export const GATE_LINE = "VC-GATE ";

const VERDICTS = new Set(["pass", "borderline", "fail"]);
const DECISIONS = new Set(["keep", "discard", "stage"]);

/** A gate result from loose JSON (a VC-GATE line, a record), or null when it is not one. */
export function cleanGateResult(j: unknown, at = Date.now()): GateResult | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  // Older gate lines name the part `plugin`.
  const part = typeof o.part === "string" ? o.part : typeof o.plugin === "string" ? o.plugin : "";
  const kind = (typeof o.kind === "string" && (PART_KINDS as readonly string[]).includes(o.kind) ? o.kind : partKind(part)) as PartKind | null;
  if (!part || !kind) return null;
  const verdict = typeof o.verdict === "string" && VERDICTS.has(o.verdict) ? (o.verdict as GateVerdict) : null;
  const decision = typeof o.decision === "string" && DECISIONS.has(o.decision) ? (o.decision as GateDecision) : null;
  return {
    part,
    kind,
    version: typeof o.version === "string" ? o.version.slice(0, 40) : "",
    verdict,
    decision,
    reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => String(r).slice(0, 600)).slice(0, 20) : [],
    runner: typeof o.runner === "string" ? o.runner.slice(0, 40) : kind,
    ...(typeof o.data === "string" ? { data: o.data.slice(0, 200) } : {}),
    what: typeof o.what === "string" ? o.what.slice(0, 160) : "",
    asked: o.asked === true,
    ...(typeof o.conv === "string" ? { conv: o.conv.slice(0, 120) } : {}),
    at: Number(o.at) || at,
  };
}

/** The last VC-GATE line of a gate run's output, or null. */
export function gateLineOf(out: string): GateResult | null {
  const line = String(out ?? "").split("\n").reverse().find((l) => l.startsWith(GATE_LINE));
  if (!line) return null;
  try {
    return cleanGateResult(JSON.parse(line.slice(GATE_LINE.length)));
  } catch {
    return null;
  }
}

/** A log record's gate result, or null when it is not one. */
export function gateRecordOf(rec: { seq: number; at?: number; type?: unknown; signal?: unknown }): (GateResult & { seq: number }) | null {
  const s = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
  if (!s || s.type !== GATE_RESULT) return null;
  const r = cleanGateResult(s, Number(rec.at) || 0);
  return r ? { ...r, seq: rec.seq } : null;
}

/** One line about a gate result, in plain words (the Plugins tool's status, the agent). */
export function gateLine(r: GateResult): string {
  const when = new Date(r.at).toISOString().slice(0, 16).replace("T", " ");
  const did = r.decision === "keep" ? "applied" : r.decision === "discard" ? "dropped" : r.decision === "stage" ? "waits for Carl's Try" : "not landed";
  return `gate ${when} UTC: ${r.verdict ?? "could not run"} (${r.runner}${r.data ? ` on ${r.data}` : ""}), ${did}${r.reasons.length ? `: ${r.reasons.join("; ").slice(0, 300)}` : ""}`;
}
