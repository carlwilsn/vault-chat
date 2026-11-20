// One gate for every swappable part (src/gateResult.ts; reports/10-hot-swap next change 6): `gate <part>` checks the
// part's candidate on a safe copy of real data with the runner suited to it, gives one verdict, lands it by one rule
// and prints one result line. The box runs it for the Plugins tool's submit (server/gate.ts); by hand:
//
//   node --import tsx scripts/gate.ts <part> --vault <vault> [--asked | --unasked] [--conv <id>] [--box <url>]
//        [--synthetic | --data <dir>] [--scenario conv-a] [--steps steps.json] [--keys 24] [--runs 2] [--out result.json]
//
// <part> and its candidate:
//   an app plugin (composer, app/composer) or a vault plugin (pen-cursor, .vault-chat/plugins/pen-cursor.js): its
//       <name>.draft.js; runner ui-drive for an app plugin when the laptop can run it (the real app's hidden, read-only
//       Drive copy on Carl's real data: the copy in effect, then a fresh copy running the draft; POST /api/v2/gate/drive),
//       else (or --harness) ui-harness (scripts/draft-check.ts: the live copy and the draft side by side in the harness)
//   preset (app/preset): .vault-chat/app-plugins/preset.draft.json; runner preset (src/gateChecks.ts presetGate: a preset,
//       every mount an app plugin this app has), then ui-harness with the draft preset tried
//   box/<name>: .vault-chat/box-plugins/<name>.draft.js; runner box-copy (server/gateBox.ts: live copy and draft loaded
//       apart from the box on a scratch copy of the vault, the same GET routes asked of both)
//   settings (app/settings-values): the waiting settings draft; runner settings, in the box (POST /api/v2/gate): every
//       value one the box takes, it still waits and changes something
//   core (app/core): the newest core bundle the box built; runner core-bundle, in the box: every file as its manifest
//       says, index.html loads only its own files, no newer box API (server/coreBundles.ts judgeCore)
//   migrate/<name>: .vault-chat/migrations/<name>.draft.js; runner migration-dry-run, in the box: migrate on a copy of
//       the plugin's real state (a throw, a timeout or a non-object fails it); a pass waits for Carl's Keep
// The data: a fresh secret-filtered copy of the box's real data (the ship gate's capture helper, as draft-check), never
// the vault itself; --synthetic: the harness's synthetic vault (box plugins: an empty scratch vault); --data <dir>: a
// copy you name (copied again into scratch for a box plugin).
//
// Without --asked / --unasked it only judges (exit 0 pass, 3 borderline, 1 fail, 2 could not run). With one, it lands the
// verdict through the box by "gate" (src/gateResult.ts gateDecision): a fail is dropped; asked for: it applies (the
// asking chat gets "Done: <what>" + Undo); not asked for: a clear pass applies silently, borderline is staged for Carl's
// Try ("<what> — Try it?" in Main; a settings draft is always staged). The last line is `VC-GATE {GateResult}`: the box
// writes the gate.result record and the chat lines from it.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PLUGIN_LIVE_DIR } from "../src/appPluginLive.ts";
import { PRESET_DRAFT_FILE } from "../src/appPreset.ts";
import { boxPluginName, boxSlot, draftWhat, versionOf, type DraftSlot } from "../src/pluginDrafts.ts";
import { GATE_LINE, PRESET_PART, SETTINGS_PART, gateDecision, partKind, type GateResult, type GateVerdict, type PartKind } from "../src/gateResult.ts";
import { PRESET_SKIPPED_RE, presetGate } from "../src/gateChecks.ts";
import { captureRealData, draftCheck, judge, slotFor, type Side, type Step } from "./draft-check.ts";
import { boxUrl, postBoxChange } from "./boxChange.ts";

/** The part a word names: preset, settings, box/<name>, else an app or vault plugin (draft-check's slotFor). */
export function partOf(word: string): { part: string; kind: PartKind; slot: DraftSlot | null } {
  const w = word.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^(?:app\/)?preset$/i.test(w)) return { part: PRESET_PART, kind: "preset", slot: { plugin: PRESET_PART, dir: APP_PLUGIN_LIVE_DIR, live: "preset.json", draft: PRESET_DRAFT_FILE, prev: "preset.prev.json" } };
  if (/^(?:app\/)?settings(?:-values)?$/i.test(w) && w !== "app/settings") return { part: SETTINGS_PART, kind: "settings", slot: null };
  if (partKind(w) === "migration") return { part: w, kind: "migration", slot: null };
  if (/^(?:app\/)?core$/i.test(w)) return { part: "app/core", kind: "frontend-core", slot: null };
  const box = /^box\/(.+)$/.exec(w) ?? /^\.vault-chat\/box-plugins\/([^/]+?)(?:\.draft)?\.js$/.exec(w);
  if (box) {
    const name = boxPluginName(`box/${box[1]}`);
    if (!name) throw new Error(`${word}: a box plugin is box/<name> (lowercase letters, digits, -)`);
    return { part: `box/${name}`, kind: "box-plugin", slot: boxSlot(name) };
  }
  const slot = slotFor(w);
  const kind = partKind(slot.plugin);
  if (kind !== "ui-plugin") throw new Error(`${word}: not a part the gate knows`);
  return { part: slot.plugin, kind, slot };
}

export type RunOpts = { vault: string; data?: string; synthetic?: boolean; harness?: boolean; scenario?: string; steps?: Step[]; keys?: number; runs?: number; port?: number; box?: string };
export type Judged = { verdict: GateVerdict; reasons: string[]; version: string; what: string; runner: string; data?: string; detail?: unknown };

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);

/** A scratch copy of the vault for a runner that runs code against it (never the vault itself). */
async function scratchVault(o: RunOpts, scratch: string): Promise<{ dir: string; data: string }> {
  if (o.data) {
    const dir = join(scratch, "data-copy");
    cpSync(resolve(o.data), dir, { recursive: true, filter: (src) => !/[\\/]\.vault-chat[\\/]events(?:[\\/]|$)/.test(src) && !/[\\/]\.git(?:[\\/]|$)/.test(src) });
    return { dir, data: `the copy ${o.data}` };
  }
  if (o.synthetic) {
    const dir = join(scratch, "synthetic");
    mkdirSync(dir, { recursive: true });
    return { dir, data: "an empty scratch vault" };
  }
  return { dir: await captureRealData(o.vault, scratch), data: "a fresh copy of the box's real data" };
}

// ---------------------------------------------------------------- the UI runner on the real app (Drive)

type DriveSide = { unavailable?: string; ok?: boolean; error?: string | null; tries?: Record<string, string> | null; steps?: { ok: boolean; steps: { ok: boolean; error?: string }[]; errors: string[]; text: string } | null };

async function driveSide(o: RunOpts, steps: Step[], tries?: Record<string, string>): Promise<DriveSide> {
  const url = `${boxUrl(o.box)}/api/v2/gate/drive?vault=${encodeURIComponent(o.vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!)}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ steps, ...(tries ? { tries } : {}) }), signal: AbortSignal.timeout(300_000) });
  const body = (await r.json().catch(() => ({}))) as DriveSide & { error?: string };
  if (!r.ok) return { unavailable: body.error ?? `the box refused it (${r.status})` };
  return body;
}

/**
 * An app plugin's draft judged in the real laptop app's hidden, read-only Drive copy on Carl's real data (the copy in
 * effect, then a fresh copy running the draft), instead of the preview harness. Null (with why) when that can't be
 * relied on: the laptop is off, busy or refuses, its app knows no tries yet, or the draft's copy never mounted there
 * (not synced yet, or it failed: the harness then judges it).
 */
export async function judgeOnLaptop(part: string, version: string, o: RunOpts): Promise<{ v: ReturnType<typeof judge> } | { skip: string }> {
  if (!/^app\/[a-z][a-z0-9-]*$/.test(part)) return { skip: "only app plugins carry a draft mark the Drive copy can see" };
  const mark = `[data-vc-plugin="${part}"][data-vc-copy="draft"]`;
  const live = await driveSide(o, [{ wait: 3000 }]);
  if (live.unavailable || !live.steps) return { skip: live.unavailable ?? live.error ?? "the laptop gave no result" };
  const draft = await driveSide(o, [{ waitFor: mark, timeout: 30_000 }, { wait: 3000 }], { [part]: version });
  if (draft.unavailable) return { skip: draft.unavailable };
  if (!draft.tries || draft.tries[part] !== version) return { skip: "the laptop's app does not run a gate's tries yet (an older core)" };
  if (!draft.steps || !draft.steps.steps[0]?.ok) return { skip: `the draft's copy never mounted on the laptop (${draft.steps?.steps[0]?.error ?? draft.error ?? "no result"})` };
  const side = (d: DriveSide): Side => ({ errors: d.steps!.errors, text: d.steps!.text.split("\n"), ran: true, typingMs: [] });
  const v = judge(part, version, side(live), side(draft));
  v.data = "Carl's real data in the laptop app's hidden Drive copy";
  return { v };
}

/** Run the runner for one part's candidate. Throws when it can't run (no candidate, no data). */
export async function judgePart(p: ReturnType<typeof partOf>, o: RunOpts): Promise<Judged> {
  if (p.kind === "ui-plugin") {
    const draft = read(join(o.vault, p.slot!.dir, p.slot!.draft));
    // The real app first (Drive), where it can be relied on; the preview harness on a copy of real data otherwise.
    if (draft !== undefined && !o.data && !o.synthetic && !o.harness) {
      const d = await judgeOnLaptop(p.part, versionOf(draft), o).catch((e) => ({ skip: String((e as Error)?.message ?? e) }));
      if ("v" in d) return { verdict: d.v.verdict, reasons: d.v.reasons, version: d.v.version, what: draftWhat(draft), runner: "ui-drive", data: d.v.data, detail: { textAdded: d.v.textAdded.slice(0, 40), textRemoved: d.v.textRemoved.slice(0, 40) } };
      console.log(`the real app's Drive copy can't judge it now (${d.skip}): the preview harness does`);
    }
    const v = await draftCheck({ plugin: p.part, vault: o.vault, data: o.data, synthetic: o.synthetic, scenario: o.scenario, steps: o.steps, keys: o.keys, runs: o.runs, port: o.port });
    return { verdict: v.verdict, reasons: v.reasons, version: v.version, what: draft ? draftWhat(draft) : "", runner: "ui-harness", data: v.data, detail: { typing: v.typing, textAdded: v.textAdded.slice(0, 40), textRemoved: v.textRemoved.slice(0, 40) } };
  }
  if (p.kind === "preset") {
    const text = read(join(o.vault, p.slot!.dir, p.slot!.draft));
    if (text === undefined) throw new Error(`no draft: ${p.slot!.dir}/${p.slot!.draft}`);
    const g = presetGate(text);
    const version = versionOf(text);
    if (g.fail.length) return { verdict: "fail", reasons: g.fail, version, what: g.what, runner: "preset" };
    const v = await draftCheck({ plugin: p.part, vault: o.vault, data: o.data, synthetic: o.synthetic, scenario: o.scenario, steps: o.steps, keys: o.keys, runs: o.runs, port: o.port, slot: p.slot!, ranBy: "page", failText: PRESET_SKIPPED_RE });
    const verdict: GateVerdict = v.verdict === "fail" ? "fail" : v.verdict === "borderline" || g.seen.length ? "borderline" : "pass";
    const reasons = v.verdict === "fail" ? v.reasons : [...g.seen, ...v.reasons.filter((r) => !(g.seen.length && r.startsWith("no new errors")))];
    return { verdict, reasons, version, what: g.what, runner: "preset+ui-harness", data: v.data, detail: { textAdded: v.textAdded.slice(0, 40), textRemoved: v.textRemoved.slice(0, 40) } };
  }
  if (p.kind === "box-plugin") {
    const dir = join(o.vault, p.slot!.dir);
    const draft = read(join(dir, p.slot!.draft));
    if (draft === undefined) throw new Error(`no draft: ${p.slot!.dir}/${p.slot!.draft}`);
    const live = read(join(dir, p.slot!.live));
    const scratch = mkdtempSync(join(tmpdir(), "vc-gate-box-"));
    const before = process.env.VC_STATE_DIR;
    try {
      const copy = await scratchVault(o, scratch);
      // The copy's own box-plugin files are not the candidate's: the two copies are handed over as code.
      rmSync(join(copy.dir, p.slot!.dir), { recursive: true, force: true });
      process.env.VC_STATE_DIR = join(scratch, "state"); // where the loaded modules are written (server/boxPlugins.ts)
      const { boxGate } = await import("../server/gateBox.ts");
      const v = await boxGate({ copy: copy.dir, name: p.part.slice(4), live, draft });
      return { verdict: v.verdict, reasons: v.reasons, version: v.version, what: draftWhat(draft), runner: "box-copy", data: copy.data, detail: { live: v.live && { routes: v.live.routes, tools: v.live.tools.map((t) => t.name) }, draft: { routes: v.draft.routes, tools: v.draft.tools.map((t) => t.name), error: v.draft.error } } };
    } finally {
      if (before === undefined) delete process.env.VC_STATE_DIR;
      else process.env.VC_STATE_DIR = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  throw new Error(`${p.part}: the ${p.kind} gate runs in the box (POST /api/v2/gate)`);
}

/** The settings and migration gates run in the box (they read its log and its own checks): ask it there. */
async function boxGateRoute(vault: string, part: string, o: { asked: boolean; land: boolean; conv?: string; box?: string }): Promise<GateResult> {
  const url = `${boxUrl(o.box)}/api/v2/gate?vault=${encodeURIComponent(vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!)}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ part, asked: o.asked, land: o.land, ...(o.conv ? { conv: o.conv } : {}) }), signal: AbortSignal.timeout(30_000) });
  const body = (await r.json().catch(() => ({}))) as { result?: GateResult; error?: string };
  if (!r.ok || !body.result) throw new Error(body.error ?? `the box refused it (${r.status})`);
  return body.result;
}

async function main(argv: string[]): Promise<number> {
  const value = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const takes = new Set(["--vault", "--data", "--scenario", "--steps", "--keys", "--runs", "--port", "--out", "--box", "--conv"]);
  const word = argv.find((a, i) => !a.startsWith("--") && !takes.has(argv[i - 1] ?? ""));
  const vault = value("--vault");
  if (!word || !vault) {
    console.error("usage: gate.ts <part> --vault <vault> [--asked | --unasked] [--conv <id>] [--box <url>] [--synthetic | --data <dir>] [--scenario conv-a] [--steps steps.json] [--keys 24] [--runs 2] [--out result.json]");
    return 2;
  }
  const land = argv.includes("--asked") || argv.includes("--unasked");
  const asked = argv.includes("--asked");
  const conv = value("--conv");
  const p = partOf(word);
  let result: GateResult;
  if (p.kind === "settings" || p.kind === "migration" || p.kind === "frontend-core") {
    result = await boxGateRoute(vault, p.part, { asked, land, conv, box: value("--box") });
  } else {
    const num = (f: string) => (value(f) !== undefined ? Number(value(f)) : undefined);
    const steps = value("--steps") ? (JSON.parse(readFileSync(value("--steps")!, "utf8")) as Step[]) : undefined;
    const j = await judgePart(p, { vault, data: value("--data"), synthetic: argv.includes("--synthetic"), harness: argv.includes("--harness"), scenario: value("--scenario"), steps, keys: num("--keys"), runs: num("--runs"), port: num("--port"), box: value("--box") });
    result = { part: p.part, kind: p.kind, version: j.version, verdict: j.verdict, decision: null, reasons: j.reasons, runner: j.runner, ...(j.data ? { data: j.data } : {}), what: j.what, asked, ...(conv ? { conv } : {}), at: Date.now() };
    console.log(`${j.verdict.toUpperCase()}: ${p.part} ${j.version} (${j.runner}${j.data ? ` on ${j.data}` : ""})`);
    for (const r of j.reasons) console.log(`- ${r}`);
    if (j.detail) console.log(JSON.stringify(j.detail).slice(0, 4000));
    if (land) {
      const d = gateDecision(p.kind, { verdict: j.verdict, reasons: j.reasons }, asked);
      const r = await postBoxChange(vault, { plugin: p.part, change: d.change, version: j.version, reason: d.reason, by: "gate", ...(j.what ? { what: j.what } : {}), ...(conv ? { conv } : {}) }, value("--box"));
      result.decision = d.change;
      console.log(`${d.change === "keep" ? "applied" : d.change === "stage" ? "staged for Carl's Try" : "dropped"}: ${r.text} (record ${r.seq})`);
    }
  }
  const out = value("--out");
  if (out) writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  console.log(GATE_LINE + JSON.stringify(result));
  return result.verdict === "pass" ? 0 : result.verdict === "borderline" ? 3 : result.verdict === "fail" ? 1 : 2;
}

export { main as gateMain };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(2);
    },
  );
}
