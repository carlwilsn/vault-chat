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
import { CORE_PART_ID, GATE_RESULT, SETTINGS_PART, gateDecision, gateLineOf, gateRecordOf, partKind, type GateResult, type PartKind } from "../src/gateResult";
import { gateOutcome } from "./changeNotices";
import { startServiceJob, type JobEnv } from "./engine/jobs";
import { masterDir } from "./master";
import { killTree } from "./commands/proc";
import { settingsDraftGate } from "./settings";
import { setPluginChange } from "./supervisor";
import { migrationChange, migrationDraft, tryMigration } from "./migrations";
import { coreStateDir, coreVault, judgeCore, storedCores } from "./coreBundles";
import { askLaptop } from "./driveTool";
import { controlDown } from "./deviceLink";
import { checkSteps } from "../src/driveSteps";
import { cleanDriveTries } from "../src/driveGuard";

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

// ---------------------------------------------------------------- the gates the box runs itself: settings, migrations

type Judged = { version: string; what: string; verdict: "pass" | "borderline" | "fail"; reasons: string[]; runner: string; data: string };

type Render = (vault: string, version: string) => Promise<{ ok: string } | { fail: string } | { skip: string }>;

/**
 * A settings draft rendered in the real laptop app's hidden, read-only Drive copy (src/driveOnLaptop.ts) before Carl
 * sees it: the copy as it is, then a fresh copy showing the draft (tries {app/settings-values: version}; the page says
 * so: html[data-vc-settings-try]). Errors only with the draft fail it; a laptop that is away, busy, or whose app does not
 * show the draft yet is a skip (its values were checked; Carl's Try still shows it on his windows only).
 */
const driveRender: Render = async (vault, version) => {
  const live = (await gateDriveRoute(vault, { steps: [{ wait: 2000 }], timeoutMs: 60_000 })).body as { unavailable?: string; steps?: { errors: string[] } | null; error?: string | null };
  if (live.unavailable || !live.steps) return { skip: live.unavailable ?? live.error ?? "no result" };
  const draft = (await gateDriveRoute(vault, { steps: [{ waitFor: `html[data-vc-settings-try="${version}"]`, timeout: 20_000 }, { wait: 2000 }], tries: { [SETTINGS_PART]: version }, timeoutMs: 60_000 })).body as { unavailable?: string; tries?: Record<string, string> | null; steps?: { steps: { ok: boolean; error?: string }[]; errors: string[] } | null; error?: string | null };
  if (draft.unavailable) return { skip: draft.unavailable };
  if (draft.tries?.[SETTINGS_PART] !== version || !draft.steps?.steps[0]?.ok) return { skip: draft.tries?.[SETTINGS_PART] !== version ? "the laptop's app does not run a gate's tries yet" : `the draft never showed there (${draft.steps?.steps[0]?.error ?? draft.error ?? "no result"})` };
  const seen = new Set(live.steps.errors);
  const fresh = draft.steps.errors.filter((e) => !seen.has(e));
  return fresh.length ? { fail: `errors only with the draft shown in the real app: ${fresh.slice(0, 3).join(" | ").slice(0, 400)}` } : { ok: "rendered in the real app with no new errors" };
};
let renderSettings: Render = driveRender;
/** Tests: how a settings draft is rendered (null: in the Drive copy). */
export function _setSettingsRender(fn: Render | null): void {
  renderSettings = fn ?? driveRender;
}

/** The in-box runners: the settings draft (server/settings.ts settingsDraftGate) and a migration draft (its dry run on
 *  a copy of the plugin's real state, server/migrations.ts tryMigration: a throw, a timeout or a non-object fails it). */
async function judgeInBox(vault: string, part: string, version: string | null): Promise<Judged | { error: string }> {
  const kind = partKind(part);
  if (kind === "settings") {
    const j = settingsDraftGate(version);
    if ("error" in j) return j;
    // A draft Carl would see (a window setting): rendered in the real app's Drive copy first, when the laptop can.
    if (j.verdict === "borderline") {
      const r = await renderSettings(vault, j.version).catch((e) => ({ skip: String((e as Error)?.message ?? e) }));
      if ("fail" in r) return { ...j, verdict: "fail", reasons: [r.fail], runner: "settings+ui-drive", data: "Carl's real data in the laptop app's hidden Drive copy" };
      if ("ok" in r) return { ...j, reasons: [...j.reasons, r.ok], runner: "settings+ui-drive", data: "Carl's real data in the laptop app's hidden Drive copy" };
      return { ...j, reasons: [...j.reasons, `not rendered in the real app (${r.skip})`], runner: "settings", data: "the box's settings now" };
    }
    return { ...j, runner: "settings", data: "the box's settings now" };
  }
  if (kind === "migration") {
    const d = migrationDraft(vault, part);
    if (!d) return { error: `${part} has no migration draft` };
    if (version && version !== d.version) return { error: `the draft of ${part} changed (now ${d.version})` };
    const r = await tryMigration(vault, part, d.version);
    const b = r.body as { error?: string; line?: string };
    const base = { version: d.version, what: d.what, runner: "migration-dry-run", data: `a copy of ${d.target ?? "its plugin"}'s real state` };
    if (r.status !== 200) return { ...base, verdict: "fail", reasons: [`the dry run failed: ${b.error ?? r.status}`] };
    return { ...base, verdict: "borderline", reasons: [`the dry run passed: ${b.line ?? "the state reshaped"}; Carl keeps it himself`] };
  }
  return { error: `${part}: not a gate the box runs itself` };
}

/**
 * A gate the box runs at once (settings, migrations): the draft (or `version`) judged; with `land`, a fail is discarded
 * by "gate" and a pass waits for Carl (its "Try it?" line in Main; neither is ever kept without him). A version the gate
 * already landed is not judged again (`again`: it is).
 */
export async function inBoxGate(vault: string, part: string, o: { asked?: boolean; land?: boolean; conv?: string | null; version?: string | null; again?: boolean } = {}): Promise<{ result: GateResult; fresh: boolean } | { error: string }> {
  const kind = partKind(part);
  if (kind !== "settings" && kind !== "migration") return { error: `${part}: not a gate the box runs itself` };
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
    if (d.change === "discard") {
      const body = { plugin: part, change: "discard", version: j.version, by: "gate", reason: d.reason };
      const w = kind === "migration" ? await migrationChange(vault, body, "gate") : setPluginChange(vault, body, "gate");
      if ("error" in w) result.reasons = [...result.reasons, `(the discard was refused: ${w.error})`];
    }
    result.decision = d.change;
    recordGate(vault, result);
    await gateOutcome(vault, { plugin: part, version: j.version, what: j.what, asked, conv: o.conv ?? null, decision: d.change, reasons: j.reasons }).catch(() => {});
  }
  return { result, fresh: true };
}

/** The settings draft's gate (inBoxGate for app/settings-values). */
export const settingsGate = (vault: string, o: Parameters<typeof inBoxGate>[2] = {}) => inBoxGate(vault, SETTINGS_PART, o);

// ---------------------------------------------------------------- the app's core bundle: judged in the box

/**
 * The core bundle's gate (server/coreBundles.ts judgeCore), on the box's stored bytes, once per version: run when a
 * built bundle would first be listed for the laptops (server/changesPending.ts) and on submit (`again`). A fail is a
 * discard by "gate" (the bundle never lands, Try or quietly); a pass lets it go on as before (applied quietly when
 * nothing on Carl's screen changes, else "Try it?"). The records are the core's vault's (one core for the box).
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

/** GET /api/v2/gate?part=&version= (the results, newest first); POST {part, asked?, land?, conv?}: a gate the box runs
 *  itself (the settings draft; the others run as the Plugins tool's job). */
export async function gateRoute(vault: string, method: string, query: URLSearchParams, body: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> {
  if (method === "GET") return { status: 200, body: { results: gateResults(vault, query.get("part"), query.get("version")).slice(0, Math.max(1, Math.min(200, Number(query.get("limit")) || 20))) } };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const part = String(body?.part ?? "");
  if (partKind(part) === "frontend-core") {
    const r = coreSubmit(String(body?.version ?? "") || null, typeof body?.conv === "string" ? body.conv : null);
    return "error" in r ? { status: 409, body: { error: r.error } } : { status: 200, body: { result: r.result, fresh: true } };
  }
  if (partKind(part) !== "settings" && partKind(part) !== "migration") return { status: 400, body: { error: `${part || "(no part)"}: only the settings draft's and migrations' gates run in the box; the others run with the Plugins tool's submit (scripts/gate.ts)` } };
  const r = await inBoxGate(vault, part, { asked: body?.asked === true, land: body?.land !== false, conv: typeof body?.conv === "string" ? body.conv : null, again: true });
  return "error" in r ? { status: 409, body: { error: r.error } } : { status: 200, body: r };
}

// ---------------------------------------------------------------- the UI runner on the real app (Drive)

/**
 * POST /api/v2/gate/drive {steps, tries?, idleMs?, timeoutMs?}: one side of the UI runner in the real laptop app's hidden,
 * read-only Drive copy (src/driveOnLaptop.ts) on Carl's real data, with `tries` (the drafts that copy runs instead of
 * the copies in effect). Never while he uses the app (idle 5 min unless idleMs says less). Answers what the laptop
 * acked: {ok, tries (echoed: an app that knows tries), steps: {ok, steps, errors, text}} or {unavailable: why}.
 */
export async function gateDriveRoute(vault: string, body: Record<string, unknown> | null, emit: (ev: Record<string, unknown>) => void = (ev) => void signal(vault, ev)): Promise<{ status: number; body: unknown }> {
  const steps = checkSteps(body?.steps ?? []);
  if (typeof steps === "string") return { status: 400, body: { error: `bad steps: ${steps}` } };
  const tries = body?.tries === undefined ? null : cleanDriveTries(body.tries);
  if (body?.tries !== undefined && !tries) return { status: 400, body: { error: "tries: {app/<name> | .vault-chat/plugins/<file>: 8-hex version}" } };
  const down = controlDown("laptop");
  if (down) return { status: 200, body: { unavailable: down } };
  const idleMs = typeof body?.idleMs === "number" && body.idleMs >= 0 ? Math.min(body.idleMs, 3_600_000) : 5 * 60_000;
  const timeoutMs = typeof body?.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 180_000) : 90_000;
  const { ack } = await askLaptop({ emit }, "drive", { steps, ...(tries ? { tries } : {}), force: false, idleMs, timeoutMs }, timeoutMs + 75_000);
  if (!ack) return { status: 200, body: { unavailable: "the laptop did not answer" } };
  const data = (ack.data ?? {}) as { refused?: boolean; aborted?: string; tries?: unknown; steps?: { ok: boolean; steps: unknown[]; errors: string[]; text: string } };
  if (data.refused || data.aborted) return { status: 200, body: { unavailable: ack.error ?? data.aborted ?? "refused" } };
  return { status: 200, body: { ok: ack.ok, error: ack.error ?? null, tries: cleanDriveTries(data.tries), steps: data.steps ?? null } };
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

const RUNNER: Record<PartKind, string> = { "ui-plugin": "ui-harness", preset: "preset+ui-harness", "box-plugin": "box-copy", settings: "settings", migration: "migration-dry-run", "frontend-core": "core-bundle" };

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
