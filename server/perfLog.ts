// Speed per build, kept from Carl's own use (the app's perf probe, src/laptopPerf.ts → POST /api/v1/laptop-perf).
// The raw probe log rotates within hours (server/laptopPerf.ts), so each batch is also folded here, per build
// revision: for every metric/method key (docs/perf-baseline.md) the newest KEEP_SAMPLES durations, for the newest
// KEEP_BUILDS builds, in <state>/perf-builds.json. The agent reads it as box:perf (server/boxOffers.ts): each build's
// median/p95 per key, the last launch the app reported, and a compare of two builds (or a perf-baseline.mjs record)
// with scripts/perf-baseline.mjs's margin rule. This replaced the Timing tool's synthetic runs in a hidden window.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no declarations
import { summarize, compare, compareTable, flatten, REQUIRED } from "../scripts/perf-baseline.mjs";
import { readLaptopPerf } from "./laptopPerf";
import { lastHostBuild } from "./hostBuild";

const KEEP_SAMPLES = 300;
const KEEP_BUILDS = 20;

type Build = { revision: string; version: string; first: string; last: string; keys: Record<string, number[]> };
type Store = { schema: 1; builds: Build[] };
type Stats = Record<string, { count: number; medianMs: number; p95Ms: number; minMs: number; maxMs: number }>;
type Batch = { surface?: string; revision?: unknown; version?: unknown; samples?: unknown[] };

const file = (stateDir: string) => join(stateDir, "perf-builds.json");

function load(stateDir: string): Store {
  try {
    const s = JSON.parse(readFileSync(file(stateDir), "utf8")) as Store;
    if (s.schema === 1 && Array.isArray(s.builds)) return s;
  } catch { /* missing or unreadable: start over from what the raw log still holds */ }
  const fresh: Store = { schema: 1, builds: [] };
  try {
    for (const b of readLaptopPerf(stateDir) as Batch[]) fold(fresh, b, (b as { at?: string }).at ?? new Date().toISOString());
  } catch { /* no raw log yet */ }
  return fresh;
}

const perfFns = new Set<() => void>();
/** Hear a build's speeds change (a probe batch folded in): box:perf's watch. */
export function onPerfChanged(fn: () => void): () => void {
  perfFns.add(fn);
  return () => void perfFns.delete(fn);
}
function save(stateDir: string, s: Store): void {
  const tmp = `${file(stateDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file(stateDir));
  perfChanged();
}

/** Tell box:perf's watchers its state changed (a fold here; a launch report, server/hostBuild.ts). */
export function perfChanged(): void {
  for (const fn of [...perfFns]) queueMicrotask(() => {
    try {
      fn();
    } catch {
      /* a listener's own error */
    }
  });
}

function fold(s: Store, batch: Batch, at: string): void {
  const samples = flatten([batch]) as { key: string; ms: number }[];
  if (!samples.length) return;
  const revision = String(batch.revision ?? "unknown");
  let b = s.builds.find((x) => x.revision === revision);
  if (!b) {
    b = { revision, version: String(batch.version ?? "unknown"), first: at, last: at, keys: {} };
    s.builds.push(b);
  }
  b.last = at;
  for (const x of samples) {
    const v = (b.keys[x.key] ||= []);
    v.push(Math.round(x.ms * 10) / 10);
    if (v.length > KEEP_SAMPLES) v.splice(0, v.length - KEEP_SAMPLES);
  }
  s.builds.sort((x, y) => (x.last < y.last ? -1 : 1));
  if (s.builds.length > KEEP_BUILDS) s.builds.splice(0, s.builds.length - KEEP_BUILDS);
}

/** Fold one accepted probe batch into the per-build record (called after server/laptopPerf.ts logs it). */
export function foldPerfBatch(stateDir: string, batch: unknown, at = new Date().toISOString()): void {
  try {
    const s = existsSync(file(stateDir)) ? load(stateDir) : { schema: 1 as const, builds: [] };
    fold(s, batch as Batch, at);
    save(stateDir, s);
  } catch { /* the raw log keeps it; a failed fold never fails the probe's POST */ }
}

const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);
const statsOf = (b: Build): Stats => summarize(Object.entries(b.keys).flatMap(([key, v]) => v.map((ms) => ({ key, ms })))) as Stats;

/** Each build's speeds, newest first: revision, version, when seen, and median/p95 (count) per metric/method. */
export function perfBuilds(stateDir: string): { revision: string; version: string; first: string; last: string; speeds: Record<string, string>; missing: string[] }[] {
  return load(stateDir).builds.slice().reverse().map((b) => {
    const st = statsOf(b);
    return {
      revision: short(b.revision),
      version: b.version,
      first: b.first,
      last: b.last,
      speeds: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, `median ${v.medianMs} ms, p95 ${v.p95Ms} ms (${v.count})`])),
      missing: (REQUIRED as string[]).filter((m) => !Object.keys(st).some((k) => k.startsWith(`${m}/`))),
    };
  });
}

/** The last launch the laptop app reported (server/hostBuild.ts). */
export function perfLaunch(stateDir: string): string {
  const b = lastHostBuild(stateDir, "laptop");
  if (b?.launchMs === undefined) return "no launch report from the laptop yet";
  return `${b.launchMs} ms (${b.launchMethod ?? "method unknown"}) at ${b.at}, v${b.version} (${short(b.revision)})`;
}

/**
 * Compare two builds (revision prefixes; default: the newest against the one before it), or the newest build against
 * a perf-baseline.mjs record file, with a margin (marginPct or marginMs; no default, as the script).
 */
export function perfCompare(stateDir: string, a: { from?: string; to?: string; baseline?: string; marginPct?: number; marginMs?: number }): { ok: boolean; text: string } {
  const marginPct = typeof a.marginPct === "number" ? a.marginPct : null;
  const marginMs = typeof a.marginMs === "number" ? a.marginMs : null;
  if (marginPct === null && marginMs === null) return { ok: false, text: "give marginPct or marginMs (there is no default margin)" };
  const builds = load(stateDir).builds.slice().reverse();
  const pick = (p: string | undefined, i: number) => (p ? builds.find((b) => b.revision.startsWith(p.trim())) : builds[i]);
  const to = pick(a.to, 0);
  if (!to) return { ok: false, text: a.to ? `no build ${a.to} in the record` : "no builds recorded yet" };
  let base: Stats;
  let baseName: string;
  if (a.baseline?.trim()) {
    try {
      const rec = JSON.parse(readFileSync(a.baseline.trim(), "utf8")) as { schema?: number; samples?: unknown[] };
      if (rec.schema !== 1 || !Array.isArray(rec.samples)) throw new Error("not a perf-baseline.mjs record (schema 1)");
      base = summarize(rec.samples) as Stats;
      baseName = a.baseline.trim();
    } catch (e) {
      return { ok: false, text: `baseline: ${(e as Error).message}` };
    }
  } else {
    const from = pick(a.from, 1);
    if (!from || from === to) return { ok: false, text: a.from ? `no build ${a.from} in the record` : "only one build recorded: nothing to compare with" };
    base = statsOf(from);
    baseName = `${short(from.revision)} (v${from.version})`;
  }
  const rows = compare(base, statsOf(to), { marginPct, marginMs }) as { key: string; flags: string[] }[];
  const worse = rows.filter((r) => r.flags.length);
  return {
    ok: true,
    text: [`${short(to.revision)} (v${to.version}) against ${baseName}; margin ${[marginPct !== null && `${marginPct}%`, marginMs !== null && `${marginMs} ms`].filter(Boolean).join(" or ")}:`, compareTable(rows), worse.length ? `WORSE than the margin: ${worse.map((r) => r.key).join(", ")}` : "Nothing worse than the margin."].join("\n"),
  };
}
