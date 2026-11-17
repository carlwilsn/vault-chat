// The app's core bundles on the box (src/coreBundle.ts says what they are). The box builds the laptop app's frontend
// from accepted main itself, so a frontend fix reaches the laptop with no GitHub release, no Windows build and no
// installer; it serves the bundle over the box's own authenticated routes, and lands it with the existing plugin.change
// record for the part app/core.
//
//   store     <state>/core-bundles/<version>/manifest.json + files/<path> (outside every vault), written by
//             scripts/core-publish.ts; <state>/core-bundles/work/<commit12>/ is a build's scratch and its result.json.
//   publisher OFF unless Carl's setting corePublish is true (default false): while off nothing is built, no bundle
//             lands (a keep on app/core is refused) and none is offered as current; the laptop runs its installed core.
//             On: every minute, main of the vault-chat repo on this box (VC_CORE_REPO, default ~/vc/projects/vault-chat;
//             VC_CORE_PUBLISH=0 turns it off for good). A new main starts one build through the existing StartJob path
//             (server/engine/jobs.ts startJobWith: its memory ceiling, low CPU/IO share, outside this server's memory: a
//             vite build takes ~3.6 GB). Its result lands the bundle (a keep by "gate"), unless the bundle needs a newer
//             box API than this server serves (then it waits). Two failed builds of one commit: given up.
//   routes    GET /api/v2/core: the offer (the version in effect, its sha256, needs), this box's API, recent builds.
//             GET /api/v2/core/<version>/manifest.json, GET /api/v2/core/<version>/files/<path>: the bundle's bytes.
//             A switch (the laptop's loader fell back, or the agent's word) is a plugin.change through /api/v2/supervisor.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILT_IN, landing, type ChangeKind, type ChangeRecord } from "../src/pluginDrafts";
import { CORE_BOX_API, CORE_PART, CORE_VERSION_RE, manifestProblem, safeCorePath, type CoreManifest, type CoreOffer } from "../src/coreBundle";
import { probeJob, readJobs, startJobWith, type JobEnv } from "./engine/jobs";

export const coreRoot = (stateDir: string) => join(stateDir, "core-bundles");

let configured: { stateDir: string; vault: string } | null = null;
/** At boot: the box's state folder (the store's parent) and the main vault (whose log holds the app/core records).
 *  Unset (a test, a tool run alone): app/core has no bundles. */
export function configureCore(c: { stateDir: string; vault: string } | null): void {
  configured = c;
}
export const coreStateDir = (): string | null => configured?.stateDir ?? null;
export const coreVault = (): string | null => configured?.vault ?? null;
const workDir = (stateDir: string) => join(coreRoot(stateDir), "work");

export type StoredCore = { version: string; sha256: string; text: string; manifest: CoreManifest };

/** A stored bundle's manifest, checked (its bytes hash to its version). */
export function readCoreManifest(stateDir: string, version: string): StoredCore | null {
  if (!CORE_VERSION_RE.test(version)) return null;
  try {
    const text = readFileSync(join(coreRoot(stateDir), version, "manifest.json"), "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (!sha256.startsWith(version)) return null;
    const manifest = JSON.parse(text) as CoreManifest;
    return manifestProblem(manifest) ? null : { version, sha256, text, manifest };
  } catch {
    return null;
  }
}

/** One file of a stored bundle, or null (not in its manifest, or not there). */
export function readCoreFile(stateDir: string, version: string, path: string): Buffer | null {
  const m = readCoreManifest(stateDir, version);
  if (!m || !safeCorePath(path) || !m.manifest.files.some((f) => f.path === path)) return null;
  try {
    return readFileSync(join(coreRoot(stateDir), version, "files", path));
  } catch {
    return null;
  }
}

/** The stored bundles, newest build first. */
export function storedCores(stateDir: string): StoredCore[] {
  let names: string[] = [];
  try {
    names = readdirSync(coreRoot(stateDir)).filter((n) => CORE_VERSION_RE.test(n));
  } catch {
    /* none yet */
  }
  return names
    .map((n) => readCoreManifest(stateDir, n))
    .filter((m): m is StoredCore => !!m)
    .sort((a, b) => b.manifest.builtAt.localeCompare(a.manifest.builtAt));
}

/** The bundle in effect by the app/core records (null: the installed app's own, "built-in"). */
export function coreOffer(stateDir: string, changes: readonly ChangeRecord[], on = true): CoreOffer | null {
  if (!on) return null;
  const l = landing(changes);
  if (!l || l.version === BUILT_IN) return null;
  const m = readCoreManifest(stateDir, l.version);
  if (!m) return null;
  return { version: m.version, sha256: m.sha256, commit: m.manifest.commit, commitTime: m.manifest.commitTime, needs: m.manifest.needs, seq: l.seq };
}

/**
 * A change on app/core (supervisor.ts setPluginChange): which version it lands and what it replaced, or why not.
 * keep: a stored bundle (the gate, the agent). switch: to `version` (a stored one, or built-in), else back to what the
 * newest landing replaced. discard: a bundle that never lands (nothing moves).
 */
export function coreLanding(stateDir: string, changes: readonly ChangeRecord[], change: ChangeKind, version: string): { ok: true; version: string; from: string; text: string } | { ok: false; status: number; error: string } {
  const now = landing(changes)?.version ?? BUILT_IN;
  const known = (v: string) => v === BUILT_IN || !!readCoreManifest(stateDir, v);
  if (change === "switch") {
    const to = version || landing(changes)?.from || BUILT_IN;
    if (!known(to)) return { ok: false, status: 404, error: `no core bundle ${to} on this box` };
    if (to === now) return { ok: false, status: 409, error: `the core is ${now} already` };
    return { ok: true, version: to, from: now, text: `the core is ${to === BUILT_IN ? "the installed app's own" : to} now (was ${now})` };
  }
  if (!known(version) || version === BUILT_IN) return { ok: false, status: 404, error: `no core bundle ${version} on this box` };
  if (change === "keep") {
    if (version === now) return { ok: false, status: 409, error: `the core is ${now} already` };
    const need = readCoreManifest(stateDir, version)!.manifest.needs.boxApi;
    if (need > CORE_BOX_API) return { ok: false, status: 409, error: `${version} needs box API ${need}; this box serves ${CORE_BOX_API}` };
    return { ok: true, version, from: now, text: `the core is ${version} now (was ${now})` };
  }
  return { ok: true, version, from: now, text: `${version} will not land` };
}

// ---------------------------------------------------------------- the publisher

type Attempt = { commit: string; at: number; tries: number; state: "building" | "built" | "failed" | "waiting"; version?: string; error?: string; job?: string };
type PubState = { attempts: Attempt[] };
const pubFile = (stateDir: string) => join(coreRoot(stateDir), "publisher.json");

export function readPublisher(stateDir: string): PubState {
  try {
    const v = JSON.parse(readFileSync(pubFile(stateDir), "utf8")) as PubState;
    return Array.isArray(v?.attempts) ? v : { attempts: [] };
  } catch {
    return { attempts: [] };
  }
}
function writePublisher(stateDir: string, s: PubState): void {
  mkdirSync(coreRoot(stateDir), { recursive: true });
  const f = pubFile(stateDir);
  writeFileSync(f + ".tmp", JSON.stringify({ attempts: s.attempts.slice(-20) }, null, 1));
  renameSync(f + ".tmp", f);
}

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr || r.error?.message) ?? "" };
};

export type PublisherDeps = {
  stateDir: string;
  repo: string;
  /** The app/core change records now (the main vault's supervisor). */
  changes: () => readonly ChangeRecord[];
  /** Land a built bundle: a plugin.change keep by "gate" (supervisor.ts setPluginChange). */
  land: (version: string, reason: string) => { ok: boolean; error?: string };
  exec?: Exec;
  now?: () => number;
  /** How long one build may run (default 40 min). */
  buildMs?: number;
  /** Whether Carl turned publishing on (the corePublish setting). Off: the tick does nothing at all. */
  on: () => boolean;
  /** Start the build job (default: startJobWith, the StartJob path). Tests replace it. */
  startJob?: typeof startJobWith;
  /** A started job's state (default: probeJob). */
  probe?: typeof probeJob;
};

const MAX_TRIES = 2;

/** The shell a build job runs: a snapshot of the commit (git archive), the repo's node_modules, then its own script. */
export function buildShell(repo: string, commit: string, root: string): string {
  const w = join(root, "work", commit.slice(0, 12));
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "set -e",
    "(set -o pipefail) 2>/dev/null && set -o pipefail",
    `rm -rf ${q(w + "/src")} ${q(w + "/dist")} ${q(w + "/result.json")}`,
    `mkdir -p ${q(w + "/src")}`,
    `git -C ${q(repo)} archive ${commit} | tar -x -C ${q(w + "/src")}`,
    `ln -s ${q(repo + "/node_modules")} ${q(w + "/src/node_modules")}`,
    `cd ${q(w + "/src")}`,
    `exec nice -n 10 node --import tsx scripts/core-publish.ts --repo ${q(repo)} --commit ${commit} --root ${q(root)} --work ${q(w)}`,
  ].join("\n");
}

/** One look: start a build for a new main, or take a finished build's result. Returns what it did (for the log). */
export function publishTick(d: PublisherDeps): string {
  if (!d.on()) return "off";
  const exec = d.exec ?? realExec;
  const now = (d.now ?? Date.now)();
  const env: JobEnv = { logDir: workDir(d.stateDir), wrap: null, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), NODE_OPTIONS: "--max-old-space-size=4096", LANG: "C.UTF-8" }, memoryMax: "6G", max: 1 };
  const st = readPublisher(d.stateDir);
  const head = exec("git", ["-C", d.repo, "rev-parse", "--verify", "refs/heads/main^{commit}"]);
  const main = head.status === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(main)) return `no main in ${d.repo}`;
  // A build under way: its result, or its end without one.
  const running = st.attempts.find((a) => a.state === "building");
  if (running) {
    const result = join(workDir(d.stateDir), running.commit.slice(0, 12), "result.json");
    let r: { ok?: boolean; version?: string; error?: string } | null = null;
    try {
      r = JSON.parse(readFileSync(result, "utf8"));
    } catch {
      /* not finished */
    }
    if (!r) {
      const job = running.job ? readJobs(env).find((j) => j.id === running.job) : undefined;
      const alive = !!job && (d.probe ?? probeJob)(env, job).state === "running";
      if (alive && now - running.at < (d.buildMs ?? 40 * 60_000)) return `building ${running.commit.slice(0, 12)}`;
      if (alive && job) exec("systemctl", ["--user", "stop", `vc-job-${job.id}`]);
      running.state = "failed";
      running.error = alive ? "the build ran too long" : "the build ended without a result (see its log in core-bundles/work)";
      writePublisher(d.stateDir, st);
      return `build of ${running.commit.slice(0, 12)} failed: ${running.error}`;
    }
    if (!r.ok || !r.version) {
      running.state = "failed";
      running.error = String(r.error ?? "failed").slice(0, 300);
      writePublisher(d.stateDir, st);
      return `build of ${running.commit.slice(0, 12)} failed: ${running.error}`;
    }
    running.state = "built";
    running.version = r.version;
    writePublisher(d.stateDir, st);
  }
  // A built (or waiting) bundle of the newest commit lands, unless the box is too old for it.
  const last = [...st.attempts].reverse().find((a) => (a.state === "built" || a.state === "waiting") && a.version);
  if (last?.version && landing(d.changes())?.version !== last.version && !d.changes().some((c) => (c.version === last.version && c.change === "discard") || (c.change === "switch" && c.from === last.version))) {
    const m = readCoreManifest(d.stateDir, last.version);
    if (m && m.manifest.needs.boxApi > CORE_BOX_API) {
      if (last.state !== "waiting") {
        last.state = "waiting";
        writePublisher(d.stateDir, st);
      }
    } else if (m) {
      const w = d.land(last.version, `built from accepted main ${last.commit.slice(0, 12)} on the box`);
      last.state = w.ok ? "built" : last.state;
      if (!w.ok) last.error = w.error;
      writePublisher(d.stateDir, st);
      if (w.ok) return `landed core ${last.version} (main ${last.commit.slice(0, 12)})`;
    }
  }
  if (running && running.state === "building") return "building";
  // A new main: one build at a time, MAX_TRIES per commit.
  const tried = st.attempts.filter((a) => a.commit === main);
  if (tried.some((a) => a.state !== "failed") || tried.length >= MAX_TRIES) return "up to date";
  mkdirSync(workDir(d.stateDir), { recursive: true });
  const command = `${buildShell(d.repo, main, coreRoot(d.stateDir))}`;
  const started = (d.startJob ?? startJobWith)(env, d.repo, { command, name: `core-${main.slice(0, 8)}`, timeout: Math.round((d.buildMs ?? 40 * 60_000) / 1000) + 300 });
  if (!started.job) {
    st.attempts.push({ commit: main, at: now, tries: tried.length + 1, state: "failed", error: `could not start the build: ${started.text.slice(0, 200)}` });
    writePublisher(d.stateDir, st);
    return "could not start the build";
  }
  st.attempts.push({ commit: main, at: now, tries: tried.length + 1, state: "building", job: started.job.id });
  writePublisher(d.stateDir, st);
  pruneCores(d.stateDir, d.changes());
  return `building core from main ${main.slice(0, 12)}`;
}

/** Keep the bundle in effect, what it replaced, and the 4 newest; old work folders go. */
export function pruneCores(stateDir: string, changes: readonly ChangeRecord[]): void {
  const keep = new Set<string>();
  const l = landing(changes);
  if (l) keep.add(l.version).add(l.from ?? "");
  for (const c of storedCores(stateDir).slice(0, 4)) keep.add(c.version);
  for (const c of storedCores(stateDir)) if (!keep.has(c.version)) rmSync(join(coreRoot(stateDir), c.version), { recursive: true, force: true });
  try {
    const st = readPublisher(stateDir);
    const live = new Set(st.attempts.filter((a) => a.state === "building").map((a) => a.commit.slice(0, 12)));
    const dirs = readdirSync(workDir(stateDir)).filter((n) => statSync(join(workDir(stateDir), n)).isDirectory());
    for (const n of dirs.sort().slice(0, Math.max(0, dirs.length - 3))) if (!live.has(n)) rmSync(join(workDir(stateDir), n), { recursive: true, force: true });
  } catch {
    /* nothing to prune */
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** At boot (the box that owns the log): look every minute. Off with VC_CORE_PUBLISH=0, or with no repo. */
export function startCorePublisher(d: Omit<PublisherDeps, "repo"> & { repo?: string }): boolean {
  const repo = d.repo ?? process.env.VC_CORE_REPO ?? join(homedir(), "vc", "projects", "vault-chat");
  if (process.env.VC_CORE_PUBLISH === "0" || process.platform !== "linux" || !existsSync(join(repo, ".git")) || !existsSync(join(repo, "node_modules"))) return false;
  if (timer) clearInterval(timer);
  let lastLine = "";
  const look = () => {
    try {
      const line = publishTick({ ...d, repo });
      if (line !== lastLine && line !== "up to date" && !line.startsWith("building ")) console.log(`[core] ${line}`);
      lastLine = line;
    } catch (e) {
      console.error(`[core] ${(e as Error).message}`);
    }
  };
  timer = setInterval(look, 60_000);
  timer.unref?.();
  setTimeout(look, 20_000).unref?.();
  return true;
}

/** GET /api/v2/core and the bundle's bytes. */
export function coreRoute(stateDir: string, changes: readonly ChangeRecord[], sub: string, on = true): { status: number; json?: unknown; bytes?: Buffer; type?: string } {
  if (sub === "" || sub === "/") {
    const st = readPublisher(stateDir);
    return { status: 200, json: { part: CORE_PART, boxApi: CORE_BOX_API, publish: on, offer: coreOffer(stateDir, changes, on), builds: st.attempts.slice(-5).map(({ job: _j, ...a }) => a) } };
  }
  const m = /^\/([0-9a-f]{8})\/(manifest\.json|files\/(.+))$/.exec(sub);
  if (!m) return { status: 404, json: { error: "no such route" } };
  if (m[2] === "manifest.json") {
    const s = readCoreManifest(stateDir, m[1]!);
    return s ? { status: 200, bytes: Buffer.from(s.text), type: "application/json" } : { status: 404, json: { error: `no core bundle ${m[1]}` } };
  }
  let path: string;
  try {
    path = decodeURIComponent(m[3]!);
  } catch {
    return { status: 400, json: { error: "bad path" } };
  }
  const b = readCoreFile(stateDir, m[1]!, path);
  return b ? { status: 200, bytes: b, type: "application/octet-stream" } : { status: 404, json: { error: "not in that bundle" } };
}

/** For health: the core in effect and the newest build. */
export function coreHealth(stateDir: string, changes: readonly ChangeRecord[], on = true): Record<string, unknown> {
  const offer = coreOffer(stateDir, changes, on);
  const last = readPublisher(stateDir).attempts.at(-1);
  const l = landing(changes);
  return {
    boxApi: CORE_BOX_API,
    publish: on ? "on" : "off (setting corePublish)",
    version: offer?.version ?? BUILT_IN,
    commit: offer?.commit ?? null,
    ...(l ? { by: l.by, reason: l.reason, at: l.at } : {}),
    ...(last ? { lastBuild: { commit: last.commit.slice(0, 12), state: last.state, ...(last.version ? { version: last.version } : {}), ...(last.error ? { error: last.error } : {}) } } : {}),
  };
}
