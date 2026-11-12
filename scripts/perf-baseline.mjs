// Record and compare the laptop speed records the box already stores
// (server/laptopPerf.ts: <state>/logs/laptop-perf.jsonl and .1). Read-only on the
// records; it writes only the baseline file named by --out. See docs/perf-baseline.md.
//
//   node scripts/perf-baseline.mjs show    [filters]
//   node scripts/perf-baseline.mjs record  --out base.json [--merge] [filters]
//   node scripts/perf-baseline.mjs compare --baseline base.json [--now other.json]
//                                          (--margin-pct N | --margin-ms N) [filters]
//
// filters: --dir <state dir> (default $VC_STATE_DIR or ~/.local/state/vault-chat-server)
//          --file <jsonl> (repeatable, instead of --dir)  --surface <name|any> (default tauri-production)
//          --revision <hex prefix>  --since <ISO time>  --include-hidden
// There is no default margin: the allowed regression is Carl's number.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The five speeds that must not get worse, by the metric names laptopPerfProtocol.ts uses. */
export const REQUIRED = ["launch-interactive", "composer-key", "ctrl-k-key", "fullscreen-transition", "chat-panel-open"];

export function median(sorted) {
  const n = sorted.length;
  return n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
}
/** Nearest rank: the smallest value with at least p of the samples at or below it. */
export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null;
}

/** JSONL text -> the batches that parse (a torn line is skipped, as the box does). */
export function parseBatches(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const b = JSON.parse(line); if (b && Array.isArray(b.samples)) out.push(b); } catch { /* torn line */ }
  }
  return out;
}

/** Flat samples [{key, at, session, rev, ms}] from batches; key = "metric/method" (the two are never mixed). */
export function flatten(batches, { surface = "tauri-production", revision = "", since = 0, includeHidden = false } = {}) {
  const out = [];
  for (const b of batches) {
    if (surface !== "any" && b.surface !== surface) continue;
    if (revision && !String(b.revision).startsWith(revision)) continue;
    for (const s of b.samples) {
      if (!includeHidden && s.visibility === "hidden") continue;
      if (!(Date.parse(s.at) >= since) || !Number.isFinite(s.durationMs)) continue;
      out.push({ key: `${s.metric}/${s.method}`, at: s.at, session: b.session, rev: String(b.revision).slice(0, 8), ms: s.durationMs });
    }
  }
  return out;
}

/** The same sample seen twice (a later read, a merged baseline) counts once. */
export function dedupe(samples) {
  const seen = new Set();
  return samples.filter(s => { const k = `${s.key}|${s.session}|${s.at}|${s.ms}`; return seen.has(k) ? false : (seen.add(k), true); });
}

export function summarize(samples) {
  const by = {};
  for (const s of samples) (by[s.key] ||= []).push(s.ms);
  const out = {};
  for (const key of Object.keys(by).sort()) {
    const v = by[key].sort((a, b) => a - b);
    out[key] = { count: v.length, medianMs: median(v), p95Ms: percentile(v, 0.95), minMs: v[0], maxMs: v[v.length - 1] };
  }
  return out;
}

const f1 = n => (n === null || n === undefined ? "-" : (Math.round(n * 10) / 10).toFixed(1));
const metricOf = key => key.split("/")[0];
const rank = key => { const i = REQUIRED.indexOf(metricOf(key)); return i < 0 ? REQUIRED.length : i; };
const orderKeys = keys => [...keys].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));

export function table(stats) {
  const rows = ["| metric / method | count | median ms | p95 ms | min ms | max ms |", "|---|---:|---:|---:|---:|---:|"];
  for (const k of orderKeys(Object.keys(stats))) {
    const s = stats[k];
    rows.push(`| ${k} | ${s.count} | ${f1(s.medianMs)} | ${f1(s.p95Ms)} | ${f1(s.minMs)} | ${f1(s.maxMs)} |`);
  }
  return rows.join("\n");
}
/** Required metrics with no sample at all: said out loud, never filled with a number. */
export function missingRequired(stats) {
  return REQUIRED.filter(m => !Object.keys(stats).some(k => metricOf(k) === m));
}

/**
 * Baseline vs now. A value is worse when it is above the baseline by more than the margin
 * (percent of the baseline, or milliseconds; with both, either one exceeded counts).
 * Medians and p95 are both judged. A metric in only one side is listed, never flagged.
 */
export function compare(base, now, { marginPct = null, marginMs = null } = {}) {
  if (marginPct === null && marginMs === null) throw new Error("a margin is required (--margin-pct or --margin-ms); there is no default");
  const worse = (b, n) => b !== null && n !== null && ((marginPct !== null && n - b > (b * marginPct) / 100) || (marginMs !== null && n - b > marginMs));
  const rows = [];
  for (const key of orderKeys(new Set([...Object.keys(base), ...Object.keys(now)]))) {
    const b = base[key], n = now[key];
    const flags = b && n ? [worse(b.medianMs, n.medianMs) && "median", worse(b.p95Ms, n.p95Ms) && "p95"].filter(Boolean) : [];
    rows.push({ key, base: b ?? null, now: n ?? null, flags, note: !b ? "not in baseline" : !n ? "not in now" : "" });
  }
  return rows;
}
export function compareTable(rows) {
  const d = (b, n) => (b === null || n === null ? "-" : `${n - b >= 0 ? "+" : ""}${f1(n - b)}`);
  const out = ["| metric / method | n base | n now | median base | median now | Δ median | p95 base | p95 now | Δ p95 | verdict |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
  for (const r of rows) {
    const b = r.base, n = r.now;
    out.push(`| ${r.key} | ${b?.count ?? "-"} | ${n?.count ?? "-"} | ${f1(b?.medianMs)} | ${f1(n?.medianMs)} | ${d(b?.medianMs ?? null, n?.medianMs ?? null)} | ${f1(b?.p95Ms)} | ${f1(n?.p95Ms)} | ${d(b?.p95Ms ?? null, n?.p95Ms ?? null)} | ${r.flags.length ? `**WORSE (${r.flags.join(", ")})**` : r.note || "ok"} |`);
  }
  return out.join("\n");
}

function readBaseline(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j?.schema !== 1 || !Array.isArray(j.samples)) throw new Error(`${file} is not a perf baseline (schema 1)`);
  return j;
}

function parseArgs(argv) {
  const o = { files: [] }, valued = new Set(["dir", "file", "out", "baseline", "now", "surface", "revision", "since", "margin-pct", "margin-ms"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { (o._ ||= []).push(a); continue; }
    const k = a.slice(2);
    if (!valued.has(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
    if (k === "file") o.files.push(v); else o[k] = v;
  }
  return o;
}
const num = (o, k) => { if (o[k] === undefined) return null; const n = Number(o[k]); if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a number of at least 0`); return n; };

function liveSamples(o) {
  const logs = join(o.dir || process.env.VC_STATE_DIR || join(userInfo().homedir, ".local", "state", "vault-chat-server"), "logs");
  const files = o.files.length ? o.files : [join(logs, "laptop-perf.jsonl.1"), join(logs, "laptop-perf.jsonl")];
  const found = files.filter(existsSync);
  if (!found.length) throw new Error(`no laptop-perf records at ${files.join(", ")}`);
  const since = o.since ? Date.parse(o.since) : 0;
  if (!Number.isFinite(since)) throw new Error("--since must be an ISO time");
  const samples = dedupe(flatten(found.flatMap(f => parseBatches(readFileSync(f, "utf8"))), { surface: o.surface, revision: o.revision || "", since, includeHidden: !!o["include-hidden"] }));
  return { samples, files: found };
}

const span = samples => (samples.length ? `${samples.reduce((a, s) => (s.at < a ? s.at : a), samples[0].at)} .. ${samples.reduce((a, s) => (s.at > a ? s.at : a), samples[0].at)}` : "none");
const revs = samples => [...new Set(samples.map(s => s.rev))].sort();

export function main(argv, out = console.log) {
  const [cmd] = argv;
  const o = parseArgs(argv.slice(1));
  if (!cmd || !["show", "record", "compare"].includes(cmd)) throw new Error("usage: perf-baseline.mjs show|record|compare (see docs/perf-baseline.md)");
  if (o.surface === undefined) o.surface = "tauri-production";
  let flagged = false;
  if (cmd === "show" || cmd === "record") {
    const live = liveSamples(o);
    let samples = live.samples;
    if (cmd === "record") {
      if (!o.out) throw new Error("record needs --out <baseline.json>");
      if (o.merge && existsSync(o.out)) samples = dedupe([...readBaseline(o.out).samples, ...samples]);
    }
    const stats = summarize(samples);
    out(`Samples: ${samples.length}; times ${span(samples)}; revisions ${revs(samples).join(", ") || "none"}; surface ${o.surface}\n`);
    out(table(stats));
    const gone = missingRequired(stats);
    if (gone.length) out(`\nNo samples for: ${gone.join(", ")}.`);
    if (cmd === "record") {
      writeFileSync(o.out, JSON.stringify({ schema: 1, recordedAt: new Date().toISOString(), surface: o.surface, files: live.files, revisions: revs(samples), metrics: stats, samples }, null, 1) + "\n");
      out(`\nWrote ${o.out}`);
    }
  } else {
    if (!o.baseline) throw new Error("compare needs --baseline <baseline.json>");
    const margins = { marginPct: num(o, "margin-pct"), marginMs: num(o, "margin-ms") };
    if (margins.marginPct === null && margins.marginMs === null) throw new Error("compare needs --margin-pct or --margin-ms; there is no default margin");
    const base = readBaseline(o.baseline);
    const nowSamples = o.now ? readBaseline(o.now).samples : liveSamples(o).samples;
    const rows = compare(summarize(base.samples), summarize(nowSamples), margins);
    out(`Baseline ${o.baseline} (${base.samples.length} samples, revisions ${revs(base.samples).join(", ") || "none"}) vs ${o.now ?? "live records"} (${nowSamples.length} samples, revisions ${revs(nowSamples).join(", ") || "none"}). Margin: ${[margins.marginPct !== null && `${margins.marginPct}%`, margins.marginMs !== null && `${margins.marginMs} ms`].filter(Boolean).join(" or ")}.\n`);
    out(compareTable(rows));
    const gone = missingRequired(summarize(nowSamples));
    if (gone.length) out(`\nNo samples now for: ${gone.join(", ")}.`);
    flagged = rows.some(r => r.flags.length);
    out(flagged ? "\nWORSE than the margin: " + rows.filter(r => r.flags.length).map(r => r.key).join(", ") : "\nNo metric is worse than the margin.");
  }
  return flagged ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
