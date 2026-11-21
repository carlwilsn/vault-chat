// The box's side of migration drafts (src/migrations.ts): the dry run (the gate's runner) runs a draft's migrate on a copy
// of a plugin's real state and answers the before / after summary; Keep (the gate's, once the dry run passed) backs up,
// runs it on the state in effect and writes the epoch switch and the plugin.change record; Discard removes the draft;
// Switch back writes the epoch switch back. Never a forced migration: nothing runs at boot, only a keep does, and the old
// records are never rewritten or deleted.
//
// migrate runs in a worker_thread of its own (like a box plugin, server/boxPluginWorker.ts): an endless loop is
// terminated after MIGRATION_LIMITS.ms, its heap is capped, a process.exit ends only its thread; each is an error and
// nothing is written.
import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signalLog, type ConvLog } from "./convlog/log";
import { otherEpochState, readPluginState, writeEpoch } from "./pluginState";
import { supervisorOf } from "./supervisor";
import { BUILT_IN, changeSignal, draftWhat, landing, versionOf, type ChangeRecord } from "../src/pluginDrafts";
import { PLUGIN_EPOCH, isStateSignalType } from "../src/pluginRecords";
import {
  MIGRATION_DIR,
  MIGRATION_LIMITS,
  checkMigrated,
  epochName,
  migrationDraftFile,
  migrationId,
  migrationKeptFile,
  migrationName,
  migrationTarget,
  summarize,
  summaryLine,
  type MigrationSummary,
} from "../src/migrations";

// ---------------------------------------------------------------- running migrate apart from the box

const WORKER = String.raw`"use strict";
const { parentPort, workerData: W } = require("node:worker_threads");
const msg = (e) => String((e && e.message) != null ? e.message : e).split("\n")[0].slice(0, 300);
(async () => {
  let mod;
  try {
    mod = await import("data:text/javascript;base64," + Buffer.from(W.code, "utf8").toString("base64"));
  } catch (e) {
    return parentPort.postMessage({ ok: false, error: "the draft does not load: " + msg(e) });
  }
  if (typeof mod.migrate !== "function") return parentPort.postMessage({ ok: false, error: "the draft exports no migrate(oldState) function" });
  try {
    const out = await mod.migrate(W.state);
    parentPort.postMessage({ ok: true, json: JSON.stringify(out === undefined ? null : out) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: "migrate threw: " + msg(e) });
  }
})();
`;

/** Run a draft's migrate on a copy of `state`, apart from the box. The new state, or why not. */
export function runMigrate(code: string, state: Record<string, unknown>, ms: number = MIGRATION_LIMITS.ms): Promise<{ state: Record<string, unknown> } | { error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const end = (v: { state: Record<string, unknown> } | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      void w.terminate();
      resolve(v);
    };
    let w: Worker;
    try {
      w = new Worker(WORKER, {
        eval: true,
        name: "migration",
        workerData: { code, state: JSON.parse(JSON.stringify(state)) },
        resourceLimits: { maxOldGenerationSizeMb: MIGRATION_LIMITS.memMb, maxYoungGenerationSizeMb: 16 },
        stdout: true,
        stderr: true,
      });
    } catch (e) {
      return resolve({ error: `migrate could not start: ${(e as Error).message}` });
    }
    const t = setTimeout(() => end({ error: `migrate ran over ${ms} ms and was stopped` }), ms);
    w.on("message", (m: { ok: boolean; json?: string; error?: string }) => {
      if (!m.ok) return end({ error: m.error ?? "migrate failed" });
      try {
        end(checkMigrated(JSON.parse(m.json ?? "null")));
      } catch (e) {
        end({ error: `migrate's answer is not JSON: ${(e as Error).message}` });
      }
    });
    w.on("error", (e: Error) => end({ error: `migrate failed: ${String(e?.message ?? e).split("\n")[0]}` }));
    w.on("exit", (code) => end({ error: `migrate's thread ended (${code}) without an answer` }));
  });
}

// ---------------------------------------------------------------- the drafts

const read = (f: string): string | undefined => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
};

export type MigrationDraft = { id: string; name: string; code: string; version: string; target: string | null; what: string };

/** A migration's draft on disk, or null. */
export function migrationDraft(vault: string, id: string): MigrationDraft | null {
  const name = migrationName(id);
  if (!name) return null;
  const code = read(join(vault, MIGRATION_DIR, migrationDraftFile(name)));
  if (code === undefined) return null;
  return { id: migrationId(name), name, code, version: versionOf(code), target: migrationTarget(code), what: draftWhat(code) };
}

// ---------------------------------------------------------------- the dry run: on a copy

/** The dry run (the gate's runner): migrate on a copy of the plugin's real state; nothing is written. */
export async function tryMigration(vault: string, id: string, version: string | null, log: ConvLog = signalLog(vault)): Promise<{ status: number; body: unknown }> {
  const d = migrationDraft(vault, id);
  if (!d) return { status: 404, body: { error: `${id} has no migration draft (${MIGRATION_DIR}/<name>.draft.js)` } };
  if (version && version !== d.version) return { status: 409, body: { error: `the draft changed since it was shown (now ${d.version}); look again` } };
  if (!d.target) return { status: 400, body: { error: 'the draft names no plugin (export const plugin = "app/<name>" or a page\'s vault path)' } };
  const now = readPluginState(vault, d.target, log);
  const copy = JSON.parse(JSON.stringify(now.state)) as Record<string, unknown>;
  const r = await runMigrate(d.code, copy);
  if ("error" in r) return { status: 422, body: { error: r.error, version: d.version } };
  const summary = summarize(d.target, now.epoch ?? "", now.state, r.state);
  return { status: 200, body: { ok: true, version: d.version, summary, line: summaryLine(summary) } };
}

// ---------------------------------------------------------------- Keep / Discard / Switch back

/** Where a Keep's backup goes: outside the vault (the box's state folder). */
export function migrationBackupDir(): string {
  return process.env.VC_MIGRATION_BACKUP_DIR || join(process.env.VC_STATE_DIR || join(homedir(), ".local", "state", "vault-chat-server"), "backups", "migrations");
}

/** The plugin's records (plain, epoch and switches) as the log has them: what a backup holds. */
function recordsOf(log: ConvLog, plugin: string): unknown[] {
  const out: unknown[] = [];
  for (const r of log.signals(0)) {
    const s = (r as { signal?: { type?: unknown; plugin?: unknown } }).signal;
    if (s && s.plugin === plugin && isStateSignalType(s.type)) out.push(r);
  }
  return out;
}

/** The epoch switch a keep of this migration wrote (the newest), with the epoch it left. */
function keptEpoch(log: ConvLog, id: string, version: string): { plugin: string; epoch: string; from: string } | null {
  let out: { plugin: string; epoch: string; from: string } | null = null;
  for (const r of log.signals(0)) {
    const s = (r as { signal?: Record<string, unknown> }).signal;
    if (s?.type === PLUGIN_EPOCH && s.migration === id && s.version === version && typeof s.plugin === "string" && typeof s.epoch === "string" && typeof s.from === "string" && s.kept === true)
      out = { plugin: s.plugin, epoch: s.epoch, from: s.from };
  }
  return out;
}

export type MigrationLanded = { status: 200; seq: number; text: string; backup?: string; summary?: MigrationSummary } | { status: number; error: string };

/**
 * The word on a migration draft ({plugin: migrate/<name>, change, version, reason?}), as `by` (the gate, the agent). Keep: the backup
 * first (no backup, no keep), then migrate on the state in effect, then the epoch switch and the change record.
 */
export async function migrationChange(vault: string, b: Record<string, unknown> | null, by: string, log: ConvLog = signalLog(vault), now = Date.now()): Promise<MigrationLanded> {
  const sig = changeSignal(b, by, now);
  if ("error" in sig) return sig;
  const name = migrationName(sig.plugin);
  if (!name) return { status: 400, error: "name the migration: migrate/<name>" };
  const id = migrationId(name);
  const dir = join(vault, MIGRATION_DIR);
  const sup = supervisorOf(vault);
  const changes = sup.changes(id);
  const record = (extra: Partial<ChangeRecord> & { version: string }, text: string, more: Partial<Extract<MigrationLanded, { status: 200 }>> = {}): MigrationLanded => {
    const rec = log.emit(null, { type: "signal", signal: { ...sig, plugin: id, ...extra } });
    return { status: 200, seq: rec.seq, text, ...more };
  };
  if (sig.change === "discard") {
    const d = migrationDraft(vault, id);
    if (d && d.version === sig.version) rmSync(join(dir, migrationDraftFile(name)), { force: true });
    return record({ version: sig.version }, `discarded the migration draft ${sig.version} of ${name}`);
  }
  if (sig.change === "keep") {
    const d = migrationDraft(vault, id);
    if (!d) return { status: 409, error: `${id} has no draft (already kept or discarded?)` };
    if (d.version !== sig.version) return { status: 409, error: `the draft of ${id} changed since it was shown (now ${d.version}); look again` };
    if (!d.target) return { status: 400, error: "the draft names no plugin (export const plugin = ...)" };
    const cur = readPluginState(vault, d.target, log);
    const from = cur.epoch ?? "";
    const r = await runMigrate(d.code, cur.state);
    if ("error" in r) return { status: 422, error: `${r.error}: nothing was migrated` };
    // The state may have moved while migrate ran: then Carl looks again (nothing written).
    if (readPluginState(vault, d.target, log).seq !== cur.seq) return { status: 409, error: `${d.target}'s state changed while the migration ran; keep again` };
    // The backup: this plugin's state now and every record of it, outside the vault, before anything is written (no
    // backup, no keep).
    const backupDir = migrationBackupDir();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const backup = join(backupDir, `${name}-${d.version}-${stamp}.json`);
    try {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(backup, JSON.stringify({ migration: id, version: d.version, plugin: d.target, vault, at: new Date(now).toISOString(), epoch: from, seq: cur.seq, state: cur.state, records: recordsOf(log, d.target), draft: d.code }, null, 1) + "\n", { mode: 0o600 });
    } catch (e) {
      return { status: 500, error: `no backup could be written (${(e as Error).message}): nothing was migrated` };
    }
    const epoch = epochName(name, d.version, now);
    const w = writeEpoch(vault, { type: PLUGIN_EPOCH, plugin: d.target, epoch, from, state: r.state, migration: id, version: d.version, by: sig.by ?? by, kept: true }, log);
    if ("error" in w) return { status: w.status, error: `${w.error}: nothing was migrated` };
    try {
      renameSync(join(dir, migrationDraftFile(name)), join(dir, migrationKeptFile(name, d.version)));
    } catch {
      /* the draft stays; the record says it was kept, so it waits no more */
    }
    const summary = summarize(d.target, from, cur.state, r.state);
    return record({ version: d.version, from: BUILT_IN }, `kept: ${d.target}'s state is migrated (${summaryLine(summary)}); the old records stay and Switch back reads them again; backup ${backup}`, { backup, summary });
  }
  // switch: the epoch in effect goes back to the one the keep left, or forward again.
  const land = landing(changes);
  if (!land) return { status: 409, error: `${id} has nothing to switch back to` };
  const keptVersion = land.version !== BUILT_IN ? land.version : land.from;
  if (!keptVersion || keptVersion === BUILT_IN) return { status: 409, error: `${id} has nothing to switch back to` };
  if (sig.version && sig.version !== land.version) return { status: 409, error: `${id} is no longer at ${sig.version} (now ${land.version}): already switched` };
  const k = keptEpoch(log, id, keptVersion);
  if (!k) return { status: 409, error: `${id}: the epoch its keep wrote is not in the log` };
  const back = land.version !== BUILT_IN;
  const [want, leave] = back ? [k.from, k.epoch] : [k.epoch, k.from];
  const active = readPluginState(vault, k.plugin, log).epoch ?? "";
  if (active !== leave) return { status: 409, error: `${k.plugin} is in another epoch now (${active || "unmigrated"}): a later migration is in effect; switch that one first` };
  const target = otherEpochState(vault, k.plugin, want, log);
  if (!target) return { status: 409, error: `${k.plugin}: the box has no state of the epoch ${want || "(unmigrated)"}` };
  const w = writeEpoch(vault, { type: PLUGIN_EPOCH, plugin: k.plugin, epoch: want, from: leave, state: target.state, migration: id, version: keptVersion, by: sig.by ?? by }, log);
  if ("error" in w) return { status: w.status, error: w.error };
  return back
    ? record({ version: BUILT_IN, from: keptVersion }, `switched ${k.plugin} back to its state before the migration (the migrated records stay; another switch goes forward again)`)
    : record({ version: keptVersion, from: BUILT_IN }, `switched ${k.plugin} forward to its migrated state again`);
}
