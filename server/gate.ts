// The box's side of the one gate (src/gateResult.ts): every kind of change goes through `gate <part>`, and every end of
// it is one gate.result record in the vault's log plus the chat lines (server/changeNotices.ts gateOutcome).
//
//   landCore       the newest core bundle the box built: judged once (coreGate) and, passed, kept by "gate" (the
//                  laptop's loader follows the record once Carl presses OK; a bundle that does not boot falls back).
//   recordGate     the one result record: {type: "gate.result", ...GateResult}.
//   gateResults    the one place results are read (GET /api/v2/gate, the Plugins tool's status).
//   inBoxGate      migration drafts, judged here at once (POST /api/v2/gate).
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { CORE_PART_ID, GATE_RESULT, gateDecision, gateRecordOf, partKind, type GateResult } from "../src/gateResult";
import { gateOutcome } from "./changeNotices";
import { setPluginChange, supervisorOf } from "./supervisor";
import { readSetting } from "./settings";
import { migrationChange, migrationDraft, tryMigration } from "./migrations";
import { coreCommits, coreRepo, coreStateDir, coreVault, judgeCore, newestUndecidedCore, storedCores } from "./coreBundles";

// ---------------------------------------------------------------- the record, and the one place it is read

/** Write a gate's end as one record (never throws; null when the log could not be written). */
export function recordGate(vault: string, r: GateResult): number | null {
  const rec = signal(vault, { type: GATE_RESULT, ...r });
  return rec?.seq ?? null;
}

type Folded = { all: (GateResult & { seq: number })[] };
const folds = new WeakMap<ConvLog, Folded>();
const KEEP = 200;

function folded(log: ConvLog): Folded {
  let f = folds.get(log);
  if (f) return f;
  const all: (GateResult & { seq: number })[] = [];
  f = { all };
  folds.set(log, f);
  const add = (r: { seq: number; at?: number; type?: unknown; signal?: unknown; conv?: unknown }) => {
    if (r.conv !== null && r.conv !== undefined) return;
    const g = gateRecordOf(r);
    if (!g || all.some((x) => x.seq === g.seq)) return;
    all.push(g);
    if (all.length > KEEP) all.splice(0, all.length - KEEP);
  };
  for (const r of log.signals(0)) add(r);
  log.onRecord((r) => add(r as never));
  return f;
}

/** The gate results of a vault, newest first: every part's, or one part's (and one version's). */
export function gateResults(vault: string, part?: string | null, version?: string | null): (GateResult & { seq: number })[] {
  return folded(signalLog(vault))
    .all.filter((r) => (!part || r.part === part) && (!version || r.version === version))
    .slice()
    .reverse();
}

// ---------------------------------------------------------------- the gate the box runs itself: migrations

type Judged = { version: string; what: string; verdict: "pass" | "borderline" | "fail"; reasons: string[]; runner: string; data: string };

/** The in-box runner: a migration draft (its dry run on a copy of the plugin's real state, server/migrations.ts
 *  tryMigration: a throw, a timeout or a non-object fails it). */
async function judgeInBox(vault: string, part: string, version: string | null): Promise<Judged | { error: string }> {
  const kind = partKind(part);
  if (kind === "migration") {
    const d = migrationDraft(vault, part);
    if (!d) return { error: `${part} has no migration draft` };
    if (version && version !== d.version) return { error: `the draft of ${part} changed (now ${d.version})` };
    const r = await tryMigration(vault, part, d.version);
    const b = r.body as { error?: string; line?: string };
    const base = { version: d.version, what: d.what, runner: "migration-dry-run", data: `a copy of ${d.target ?? "its plugin"}'s real state` };
    if (r.status !== 200) return { ...base, verdict: "fail", reasons: [`the dry run failed: ${b.error ?? r.status}`] };
    return { ...base, verdict: "borderline", reasons: [`the dry run passed: ${b.line ?? "the state reshaped"}`] };
  }
  return { error: `${part}: not a gate the box runs itself` };
}

/**
 * A gate the box runs at once (migrations): the draft (or `version`) judged; with `land`, a fail is discarded by "gate"
 * and a pass is kept by "gate" (the migration run). A version the gate already landed is not
 * judged again (`again`: it is).
 */
export async function inBoxGate(vault: string, part: string, o: { asked?: boolean; land?: boolean; conv?: string | null; version?: string | null; again?: boolean } = {}): Promise<{ result: GateResult; fresh: boolean } | { error: string }> {
  const kind = partKind(part);
  if (kind !== "migration") return { error: `${part}: not a gate the box runs itself` };
  const j = await judgeInBox(vault, part, o.version ?? null);
  if ("error" in j) return { error: j.error };
  if (o.land && !o.again) {
    const done = gateResults(vault, part, j.version).find((r) => r.decision !== null);
    if (done) return { result: done, fresh: false };
  }
  const asked = o.asked === true;
  const result: GateResult = { part, kind, version: j.version, verdict: j.verdict, decision: null, reasons: j.reasons, runner: j.runner, data: j.data, what: j.what, asked, ...(o.conv ? { conv: o.conv } : {}), at: Date.now() };
  if (o.land) {
    const d = gateDecision(kind, { verdict: j.verdict, reasons: j.reasons }, asked);
    const body = { plugin: part, change: d.change, version: j.version, by: "gate", reason: d.reason, ...(j.what ? { what: j.what } : {}), ...(o.conv ? { conv: o.conv } : {}) };
    const w = kind === "migration" ? await migrationChange(vault, body, "gate") : setPluginChange(vault, body, "gate");
    let decision: "keep" | "discard" | null = d.change;
    if ("error" in w) {
      result.reasons = [...result.reasons, `(the ${d.change} was refused: ${w.error})`];
      // A keep that could not be written did not land: said as a gate that could not finish.
      if (d.change === "keep") decision = null;
    }
    result.decision = decision;
    recordGate(vault, result);
    await gateOutcome(vault, { plugin: part, version: j.version, what: j.what, asked, conv: o.conv ?? null, decision, reasons: result.reasons, runner: j.runner }).catch(() => {});
  }
  return { result, fresh: true };
}

// ---------------------------------------------------------------- the app's core bundle: judged in the box

/**
 * The core bundle's gate (server/coreBundles.ts judgeCore), on the box's stored bytes, once per version: run when a
 * built bundle is first seen (landCore) and on submit (`again`). A fail is a discard by "gate" (the bundle never lands);
 * a pass is kept by "gate" (landCore). The records are the core's vault's (one core for the box).
 */
export function coreGate(vault: string, stateDir: string, version: string, o: { again?: boolean; conv?: string | null } = {}): GateResult {
  if (!o.again) {
    const done = gateResults(vault, CORE_PART_ID, version)[0];
    if (done) return done;
  }
  const j = judgeCore(stateDir, version);
  const result: GateResult = { part: CORE_PART_ID, kind: "frontend-core", version, verdict: j.verdict, decision: j.verdict === "fail" ? "discard" : null, reasons: j.reasons, runner: "core-bundle", data: "the box's stored build", what: j.commit ? `the app's frontend from main ${j.commit.slice(0, 12)}` : "", asked: false, ...(o.conv ? { conv: o.conv } : {}), at: Date.now() };
  if (j.verdict === "fail") {
    const w = setPluginChange(vault, { plugin: CORE_PART_ID, change: "discard", version, by: "gate", reason: `the gate failed: ${j.reasons.join("; ").slice(0, 260)}` }, "gate");
    if ("error" in w) result.reasons = [...result.reasons, `(the discard was refused: ${w.error})`];
  }
  recordGate(vault, result);
  return result;
}

/** The core gate on its word (submit, POST /api/v2/gate): the newest stored bundle, or `version`, judged again. */
export function coreSubmit(version: string | null, conv: string | null = null): { result: GateResult } | { error: string } {
  const dir = coreStateDir();
  if (!dir) return { error: "this box keeps no core bundles" };
  const v = version ?? storedCores(dir)[0]?.version;
  if (!v) return { error: "no core bundle is stored" };
  return { result: coreGate(coreVault() ?? "", dir, v, { again: true, conv }) };
}

/**
 * The newest core bundle the box built that nobody decided on (server/coreBundles.ts newestUndecidedCore): judged once
 * and, passed, kept by "gate", so it becomes the laptop's current core (its loader takes it when Carl presses OK and falls
 * back by itself when it does not boot). Returns a line for the box's log, or null when nothing was to land.
 */
export function landCore(): string | null {
  const dir = coreStateDir();
  const vault = coreVault();
  if (!dir || !vault) return null;
  const c = newestUndecidedCore(dir, supervisorOf(vault).changes(CORE_PART_ID), readSetting("corePublish") === true, (commit) => coreCommits(coreRepo(), commit));
  if (!c) return null;
  const g = coreGate(vault, dir, c.version);
  if (g.verdict === "fail") return `core ${c.version}: the gate failed it (${g.reasons.join("; ").slice(0, 300)})`;
  const w = setPluginChange(vault, { plugin: CORE_PART_ID, change: "keep", version: c.version, by: "gate", reason: `the gate passed it: ${g.reasons.join("; ").slice(0, 260)}`, ...(c.what ? { what: c.what.slice(0, 160) } : {}) }, "gate");
  return "error" in w ? `core ${c.version}: passed the gate but the keep was refused (${w.error})` : `core ${c.version}: passed the gate and is current now (${c.what.slice(0, 200)})`;
}

/** GET /api/v2/gate?part=&version= (the results, newest first); POST {part, asked?, land?, conv?}: a gate the box runs
 *  itself (migrations, the core). */
export async function gateRoute(vault: string, method: string, query: URLSearchParams, body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
  if (method === "GET") return { status: 200, body: { results: gateResults(vault, query.get("part"), query.get("version")).slice(0, Math.max(1, Math.min(200, Number(query.get("limit")) || 20))) } };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const part = String(body?.part ?? "");
  if (partKind(part) === "frontend-core") {
    const r = coreSubmit(String(body?.version ?? "") || null, typeof body?.conv === "string" ? body.conv : null);
    return "error" in r ? { status: 409, body: { error: r.error } } : { status: 200, body: { result: r.result, fresh: true } };
  }
  if (partKind(part) !== "migration") return { status: 400, body: { error: `${part || "(no part)"}: only migrations and the core have a gate` } };
  const r = await inBoxGate(vault, part, { asked: body?.asked === true, land: body?.land !== false, conv: typeof body?.conv === "string" ? body.conv : null, again: true });
  return "error" in r ? { status: 409, body: { error: r.error } } : { status: 200, body: r };
}
