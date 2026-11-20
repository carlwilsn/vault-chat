// The box's side of the one gate (src/gateResult.ts): every kind of change goes through `gate <part>`, and every end of
// it is one gate.result record in the vault's log plus the chat lines (server/changeNotices.ts gateOutcome).
//
//   submitGate     the Plugins tool's submit for any part: plugins, the preset and box plugins run scripts/gate.ts as a
//                  background job of the conversation (it copies the real data, runs the part's runner and lands the
//                  verdict through this box); the settings draft is judged here, at once (settingsGate).
//   settingsGate   the settings draft's runner and landing (server/settings.ts settingsDraftGate): a fail is a discard by
//                  "gate", otherwise it waits for Carl (its "Try it?" line in Main). Also run before a settings draft is
//                  offered (server/changesPending.ts offerRoute), so a bad one never reaches him.
//   recordGate     the one result record: {type: "gate.result", ...GateResult}.
//   gateResults    the one place results are read (GET /api/v2/gate, the Plugins tool's status).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { GATE_RESULT, SETTINGS_PART, gateDecision, gateLineOf, gateRecordOf, partKind, type GateResult, type PartKind } from "../src/gateResult";
import { gateOutcome } from "./changeNotices";
import { startServiceJob, type JobEnv } from "./engine/jobs";
import { masterDir } from "./master";
import { killTree } from "./commands/proc";
import { settingsDraftGate } from "./settings";
import { setPluginChange } from "./supervisor";

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

// ---------------------------------------------------------------- the settings draft: judged in the box

/**
 * The settings gate: the waiting draft (or `version`) judged; with `land`, a fail is discarded by "gate" and a pass
 * waits for Carl (its "Try it?" line in Main). A version the gate already landed is not judged again (`again`: it is).
 */
export async function settingsGate(vault: string, o: { asked?: boolean; land?: boolean; conv?: string | null; version?: string | null; again?: boolean } = {}): Promise<{ result: GateResult; fresh: boolean } | { error: string }> {
  const j = settingsDraftGate(o.version ?? null);
  if ("error" in j) return { error: j.error };
  if (o.land && !o.again) {
    const done = gateResults(vault, SETTINGS_PART, j.version).find((r) => r.decision !== null);
    if (done) return { result: done, fresh: false };
  }
  const asked = o.asked === true;
  const result: GateResult = { part: SETTINGS_PART, kind: "settings", version: j.version, verdict: j.verdict, decision: null, reasons: j.reasons, runner: "settings", data: "the box's settings now", what: j.what, asked, ...(o.conv ? { conv: o.conv } : {}), at: Date.now() };
  if (o.land) {
    const d = gateDecision("settings", { verdict: j.verdict, reasons: j.reasons }, asked);
    if (d.change === "discard") {
      const w = setPluginChange(vault, { plugin: SETTINGS_PART, change: "discard", version: j.version, by: "gate", reason: d.reason }, "gate");
      if ("error" in w) result.reasons = [...result.reasons, `(the discard was refused: ${w.error})`];
    }
    result.decision = d.change;
    recordGate(vault, result);
    await gateOutcome(vault, { plugin: SETTINGS_PART, version: j.version, what: j.what, asked, conv: o.conv ?? null, decision: d.change, reasons: j.reasons }).catch(() => {});
  }
  return { result, fresh: true };
}

/** GET /api/v2/gate?part=&version= (the results, newest first); POST {part, asked?, land?, conv?}: a gate the box runs
 *  itself (the settings draft; the others run as the Plugins tool's job). */
export async function gateRoute(vault: string, method: string, query: URLSearchParams, body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
  if (method === "GET") return { status: 200, body: { results: gateResults(vault, query.get("part"), query.get("version")).slice(0, Math.max(1, Math.min(200, Number(query.get("limit")) || 20))) } };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const part = String(body?.part ?? "");
  if (partKind(part) !== "settings") return { status: 400, body: { error: `${part || "(no part)"}: only the settings draft's gate runs in the box; the others run with the Plugins tool's submit (scripts/gate.ts)` } };
  const r = await settingsGate(vault, { asked: body?.asked === true, land: body?.land !== false, conv: typeof body?.conv === "string" ? body.conv : null, again: true });
  return "error" in r ? { status: 409, body: { error: r.error } } : { status: 200, body: r };
}

// ---------------------------------------------------------------- the job: scripts/gate.ts

/** What submit needs from the engine: the vault's jobs, and the conversation that is woken when the gate ends. */
export type GateCtx = { jobs: JobEnv; convId: string; byCarl: boolean; repo?: string; box?: string };

/** The checkout the gate runs from: the vault-chat project in the vault-chat folder. */
export function gateRepo(): string | null {
  const m = masterDir();
  const repo = m ? join(m, "projects", "vault-chat") : null;
  return repo && existsSync(join(repo, "scripts", "gate.ts")) ? repo : null;
}

/** Run scripts/gate.ts (it lands the verdict through this box, by "gate"). */
function runGateScript(repo: string, args: string[], signal: AbortSignal, log: (t: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { HOME: process.env.HOME ?? homedir(), PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ...(process.env.CHROMIUM ? { CHROMIUM: process.env.CHROMIUM } : {}) };
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/gate.ts", ...args], { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const stop = () => killTree(child.pid);
    signal.addEventListener("abort", stop, { once: true });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => ((out = (out + d).slice(-20_000)), log(String(d).trimEnd())));
    child.on("error", (e) => (signal.removeEventListener("abort", stop), reject(e)));
    // 0 pass, 3 borderline, 1 fail: each a verdict (landed by the script); 2: it could not run.
    child.on("close", (code) => (signal.removeEventListener("abort", stop), code === 0 || code === 1 || code === 3 ? resolve(out.trim()) : reject(new Error(`the gate could not run (${code}): ${out.slice(-1200)}`))));
  });
}

const RUNNER: Record<PartKind, string> = { "ui-plugin": "ui-harness", preset: "preset+ui-harness", "box-plugin": "box-copy", settings: "settings", migration: "migration", "frontend-core": "frontend-core" };

/**
 * Hand one part's candidate to the gate as a background job of the conversation (plugins, the preset, box plugins).
 * Its end is a gate.result record and the chat lines. `version` / `what`: the candidate's, for the lines.
 */
export function submitGate(vault: string, c: { part: string; version: string; what: string; asked: boolean }, ctx: GateCtx, box: string): { ok: boolean; text: string } {
  const kind = partKind(c.part);
  if (!kind || kind === "settings" || kind === "migration" || kind === "frontend-core") return { ok: false, text: `${c.part}: no job gate for this part` };
  const repo = ctx.repo ?? gateRepo();
  if (!repo) return { ok: false, text: "no vault-chat checkout to run the gate from (VC_MASTER/projects/vault-chat)" };
  const args = [c.part, "--vault", vault, c.asked ? "--asked" : "--unasked", "--box", box, "--conv", ctx.convId];
  const end = (r: GateResult) => {
    recordGate(vault, r);
    void gateOutcome(vault, { plugin: c.part, version: r.version || c.version, what: r.what || c.what, asked: c.asked, conv: ctx.convId, decision: r.decision, reasons: r.reasons }).catch(() => {});
  };
  const couldNot = (why: string): GateResult => ({ part: c.part, kind, version: c.version, verdict: null, decision: null, reasons: [why], runner: RUNNER[kind], what: c.what, asked: c.asked, conv: ctx.convId, at: Date.now() });
  const r = startServiceJob(ctx.jobs, { name: "gate", command: `Gate of ${c.part} ${c.version} (${c.asked ? "asked for" : "not asked for"})`, conv: ctx.convId, byCarl: ctx.byCarl, timeout: "30m" }, (signal, log) =>
    runGateScript(repo, args, signal, log).then(
      (out) => {
        const g = gateLineOf(out);
        end(g ? { ...g, asked: c.asked, conv: ctx.convId } : couldNot("the gate gave no result"));
        return out;
      },
      (e) => {
        if (!signal.aborted) end(couldNot(String((e as Error)?.message ?? e)));
        throw e;
      },
    ),
  );
  if (!r.job) return { ok: false, text: r.text };
  return {
    ok: true,
    text: `Gating ${c.part} draft ${c.version} on a copy of real data (job ${r.job.id}; JobStatus follows it). Nothing reaches Carl until it passes. ${c.asked ? "Passed: it applies and this chat gets \"Done: …\" with Undo; failed: one plain line here says it didn't apply and why." : "A clear pass applies it silently, a clear fail drops it; if something Carl sees changes, Main gets \"… — Try it?\"."}`,
  };
}
