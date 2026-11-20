// The New voice's pipeline (voice-pipeline/bot.py) as a child of this server, so the box needs nothing installed by
// hand: the server writes the pipeline's files from its own bundle into <state>/voice/, makes the Python environment
// once with uv from the pinned requirements (again only when they change), and keeps the pipeline running on
// loopback for the single voice brain (server/voiceBrain.ts). It stops with the server; VC_VOICE_PIPELINE=off
// disables startup without selecting another transport. Its log: <state>/logs/voice-pipeline.log.
//
// The pipeline is a versioned part of the box, like the box server: each set of its files (bot.py, listener.py,
// local_voice.py, the requirements) is a version (the first 8 hex of their sha256) kept in <state>/voice/versions/<v>/,
// and <state>/voice/part.json says which runs (current), which ran before (previous), which came up at least once
// (proven) and which failed here (bad). A new version is taken when this server brings one (its handover is the
// server's: the updater waits for no live call before a new server takes over, and the old server's pipeline stops with
// it). A version not yet proven that exits or does not say "[voice ready]" within READY_WAIT_MS is marked bad and the
// previous one starts in its place, when it runs on the same Python environment (same requirements). A port conflict
// is never the version's fault. Each take and switch back is a line in <state>/voice/switches.jsonl, written to the log
// as a `box.voice.switch` record (server/serverSwitches.ts).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { voicePort } from "./voicePorts";
import LISTENER_PY from "../voice-pipeline/listener.py?raw";
import BOT_PY from "../voice-pipeline/bot.py?raw";
import REQUIREMENTS from "../voice-pipeline/requirements.txt?raw";
import LOCAL_VOICE_PY from "../voice-pipeline/local_voice.py?raw";
import LOCAL_REQUIREMENTS from "../voice-pipeline/requirements-local.txt?raw";

export type PipelineOptions = {
  stateDir: string; serverPort: number; port: number; log?: (s: string) => void;
  /** Calls speak with the local voice now (server/voiceProvider.ts): its packages are installed before the first
   * launch and its models fetched at startup. An install on the ElevenLabs voice never installs them. */
  wantsLocal?: () => boolean;
  /** Tests: how long a version not yet proven has to say ready (default READY_WAIT_MS). */
  readyWaitMs?: number;
};

let child: ChildProcess | null = null;
let wanted = false;
let setup: Promise<string> | null = null;
let generation = 0;
let ready = false;
let failure: PipelineFailure | null = null;
export type PipelineFailure = { code: "VOICE_PORT_CONFLICT" | "VOICE_START_FAILED"; host: "127.0.0.1"; port: number; message: string };
export class VoiceStartupError extends Error {
  constructor(readonly reason: PipelineFailure) { super(reason.message); }
}
function fail(o: PipelineOptions, code: PipelineFailure["code"], message: string): void {
  ready = false; failure = { code, host: "127.0.0.1", port: o.port, message }; lastError = message;
  o.log?.(`[voice] ${message}`);
}
const conflictMessage = (o: PipelineOptions) => `Voice port 127.0.0.1:${o.port} is already in use. Choose an unused VC_VOICE_PORT or stop that instance. No existing listener was stopped or adopted.`;
const conflict = (o: PipelineOptions) => fail(o, "VOICE_PORT_CONFLICT", conflictMessage(o));
/** OS bind is the authority; no connection/probe of an unknown listener. The child binds again and retains its socket. */
export async function checkVoicePort(o: PipelineOptions): Promise<void> {
  voicePort(o.serverPort, String(o.port));
  await new Promise<void>((resolve, reject) => {
    const socket = createServer();
    socket.once("error", (e: NodeJS.ErrnoException) => {
      const inUse = e.code === "EADDRINUSE";
      reject(new VoiceStartupError({ code: inUse ? "VOICE_PORT_CONFLICT" : "VOICE_START_FAILED", host: "127.0.0.1", port: o.port,
        message: inUse ? conflictMessage(o) : `Voice port 127.0.0.1:${o.port}: bind failed (${e.code ?? "unknown"}).` }));
    });
    socket.listen({ host: "127.0.0.1", port: o.port, exclusive: true }, () => socket.close(() => resolve()));
  });
}
let lastError: string | null = null;
let current: { o: PipelineOptions; dir: string } | null = null;

/** How long a version not yet proven has to say "[voice ready]" (after its environment is made) before it is dropped. */
export const READY_WAIT_MS = 180_000;
/** The pipeline's files, by name. */
const PIPELINE_FILES: [string, string][] = [["bot.py", BOT_PY], ["listener.py", LISTENER_PY], ["local_voice.py", LOCAL_VOICE_PY], ["requirements.txt", REQUIREMENTS], ["requirements-local.txt", LOCAL_REQUIREMENTS]];
/** This server's pipeline version: the first 8 hex of the sha256 over its files (names and bytes). */
export function pipelineVersion(files: [string, string][] = PIPELINE_FILES): string {
  const h = createHash("sha256");
  for (const [n, b] of files) h.update(n).update("\0").update(b).update("\0");
  return h.digest("hex").slice(0, 8);
}
export type VoicePart = { current: string | null; previous: string | null; proven: string[]; bad: string[] };
const partFile = (root: string) => join(root, "part.json");
export function readVoicePart(root: string): VoicePart {
  try {
    const o = JSON.parse(readFileSync(partFile(root), "utf8"));
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && /^[0-9a-f]{8}$/.test(v)).slice(-50) : []);
    const one = (x: unknown) => (typeof x === "string" && /^[0-9a-f]{8}$/.test(x) ? x : null);
    return { current: one(o.current), previous: one(o.previous), proven: list(o.proven), bad: list(o.bad) };
  } catch {
    return { current: null, previous: null, proven: [], bad: [] };
  }
}
function writeVoicePart(root: string, p: VoicePart): void {
  writeFileSync(partFile(root) + ".tmp", JSON.stringify(p) + "\n");
  renameSync(partFile(root) + ".tmp", partFile(root));
}
/** One take ("keep") or switch back ("switch") for the log (server/serverSwitches.ts startVoiceSwitches). */
function noteSwitch(root: string, change: "keep" | "switch", to: string, from: string | null, reason?: string): void {
  try {
    appendFileSync(join(root, "switches.jsonl"), JSON.stringify({ change, at: Date.now(), to: { slot: to, version: to, rev: null, source: "box" }, from: from ? { slot: from, version: from, rev: null, source: "box" } : null, ...(reason ? { reason } : {}) }) + "\n");
  } catch { /* the log line is best effort; the part file is the truth */ }
}
const reqOf = (dir: string) => { try { return createHash("sha256").update(readFileSync(join(dir, "requirements.txt"))).digest("hex").slice(0, 16); } catch { return null; } };
/** Whether version `v` is kept on disk whole and runs on the environment made for `want` (its requirements' hash). */
const runnableOn = (root: string, v: string | null, want: string): v is string =>
  !!v && existsSync(join(root, "versions", v, "bot.py")) && reqOf(join(root, "versions", v)) === want;
/** The version to run now, from this server's own (`mine`) and the part file; records a take of `mine`. */
export function chooseVersion(root: string, mine: string, want: string): string {
  const p = readVoicePart(root);
  if (p.bad.includes(mine)) return runnableOn(root, p.current, want) && !p.bad.includes(p.current) ? p.current : runnableOn(root, p.previous, want) && !p.bad.includes(p.previous) ? p.previous : mine;
  if (p.current !== mine) {
    const from = p.current;
    writeVoicePart(root, { ...p, current: mine, previous: from ?? p.previous });
    noteSwitch(root, "keep", mine, from);
  }
  return mine;
}
/** `v` failed here: never again; back to the previous version when it runs on the same environment. */
export function dropVersion(root: string, v: string, want: string, reason: string): string | null {
  const p = readVoicePart(root);
  const bad = p.bad.includes(v) ? p.bad : [...p.bad, v];
  const back = [p.previous, p.current].find((x) => x !== v && runnableOn(root, x, want) && !bad.includes(x!)) ?? null;
  writeVoicePart(root, { current: back ?? p.current, previous: back ? v : p.previous, proven: p.proven, bad });
  if (back) noteSwitch(root, "switch", back, v, reason);
  return back;
}
function markProven(root: string, v: string): void {
  const p = readVoicePart(root);
  if (!p.proven.includes(v)) writeVoicePart(root, { ...p, proven: [...p.proven, v] });
}
let localSetup: Promise<void> | null = null;
let localError: string | null = null;
const localStampWant = () => createHash("sha256").update(REQUIREMENTS).update(LOCAL_REQUIREMENTS).digest("hex").slice(0, 16);
const localInstalled = (dir: string) => {
  try { return readFileSync(join(dir, "venv-local.stamp"), "utf8").trim() === localStampWant(); } catch { return false; }
};

/** What the pipeline is doing (health, Settings). */
export function pipelineState() {
  return { wanted, running: ready && !!child && child.exitCode === null, settingUp: !!setup, error: lastError, failure, version: runningVersion };
}

/** The Nix store's libstdc++ and zlib (the wheels' native code needs them; NixOS has no /usr/lib): newest first. */
function nixLibs(): string[] {
  try {
    const names = readdirSync("/nix/store");
    const pick = (re: RegExp, file: string) =>
      names
        .filter((n) => re.test(n))
        .map((n) => join("/nix/store", n, "lib"))
        .filter((d) => existsSync(join(d, file)))
        .sort()
        .reverse()[0];
    return [pick(/-gcc-[\d.]+-lib$/, "libstdc++.so.6"), pick(/-zlib-[\d.]+$/, "libz.so.1")].filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/** The pipeline's directory with its files written, and its Python environment made (once per requirements). Null: failed. */
async function prepare(o: PipelineOptions): Promise<string> {
  const dir = join(o.stateDir, "voice");
  mkdirSync(dir, { recursive: true });
  // The environment is made from the requirements at the voice folder's top (as before); each version's files are
  // kept in versions/<v>/ beside it.
  writeFileSync(join(dir, "requirements.txt"), REQUIREMENTS);
  writeFileSync(join(dir, "requirements-local.txt"), LOCAL_REQUIREMENTS);
  const vdir = join(dir, "versions", pipelineVersion());
  if (!existsSync(join(vdir, "bot.py"))) {
    mkdirSync(vdir, { recursive: true });
    for (const [n, b] of PIPELINE_FILES) writeFileSync(join(vdir, n), b);
  }
  // Keep this version and the two the part file names (the one to go back to); older ones go.
  const part = readVoicePart(dir);
  const keep = new Set([pipelineVersion(), part.current, part.previous].filter(Boolean));
  for (const v of readdirSync(join(dir, "versions"))) if (!keep.has(v)) rmSync(join(dir, "versions", v), { recursive: true, force: true });
  const want = createHash("sha256").update(REQUIREMENTS).digest("hex").slice(0, 16);
  const stamp = join(dir, "venv.stamp");
  const python = join(dir, "venv", "bin", "python");
  const envReady = existsSync(python) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want;
  if (!envReady) {
    o.log?.("[voice] setting up the pipeline's Python environment (uv; a few minutes the first time)");
    mkdirSync(join(o.stateDir, "logs"), { recursive: true });
    if (!existsSync(python) && (await uv(o, dir, ["venv", "venv"])) !== 0) throw new Error("uv venv failed (is uv installed?)");
    if ((await uv(o, dir, ["pip", "install", "-r", "requirements.txt"])) !== 0) throw new Error("Installing the pipeline’s packages failed (voice-pipeline.log)");
    writeFileSync(stamp, want);
  }
  if (o.wantsLocal?.() && !localInstalled(dir)) await installLocal(o, dir);
  return dir;
}

function uv(o: PipelineOptions, dir: string, args: string[]): Promise<number> {
  return new Promise<number>((res) => {
    const p = spawn("uv", args, { cwd: dir, env: { ...process.env, VIRTUAL_ENV: join(dir, "venv") }, stdio: ["ignore", "pipe", "pipe"] });
    const out = (b: Buffer) => appendFileSync(join(o.stateDir, "logs", "voice-pipeline.log"), b);
    p.stdout.on("data", out);
    p.stderr.on("data", out);
    p.on("exit", (c) => res(c ?? 1));
    p.on("error", () => res(127));
  });
}

/** The local voice's packages (requirements-local.txt) into the pipeline's environment, resolved with its own. */
async function installLocal(o: PipelineOptions, dir: string): Promise<void> {
  o.log?.("[voice] installing the local voice (Kokoro + Whisper; a few minutes the first time)");
  mkdirSync(join(o.stateDir, "logs"), { recursive: true });
  if ((await uv(o, dir, ["pip", "install", "-r", "requirements.txt", "-r", "requirements-local.txt"])) !== 0) {
    throw new Error("Installing the local voice failed (voice-pipeline.log)");
  }
  writeFileSync(join(dir, "venv-local.stamp"), localStampWant());
}

/** Whether a call can speak locally now. Not yet: the packages install in the background (once) and the pipeline
 * restarts on them (only then, never during an ElevenLabs call: nothing local is installed while those run). */
export function localVoiceReady(): { ready: boolean; error: string | null } {
  const cur = current;
  if (!cur) return { ready: false, error: lastError ?? "The voice pipeline is still starting" };
  if (localInstalled(cur.dir)) return { ready: true, error: null };
  if (!localSetup) {
    localError = null;
    const task = installLocal(cur.o, cur.dir).then(() => {
      // The running child imported its packages before these: start it again on the new environment.
      const old = child;
      if (!old || !wanted || current !== cur) return;
      const session = generation;
      child = null; ready = false;
      old.once("exit", () => launch(cur.o, cur.dir, session));
      old.kill("SIGTERM");
    }).catch((e: Error) => { localError = e.message; cur.o.log?.(`[voice] ${e.message}`); })
      .finally(() => { if (localSetup === task) localSetup = null; });
    localSetup = task;
  }
  return { ready: false, error: localError ?? "Setting up the local voice (the first time takes a few minutes)" };
}

const envWant = () => createHash("sha256").update(REQUIREMENTS).digest("hex").slice(0, 16);
let watch: ReturnType<typeof setTimeout> | null = null;
let runningVersion: string | null = null;

function launch(o: PipelineOptions, dir: string, session: number, forced?: string): void {
  if (!wanted || child || session !== generation) return;
  current = { o, dir };
  const libs = nixLibs();
  const version = forced ?? chooseVersion(dir, pipelineVersion(), envWant());
  runningVersion = version;
  const proven = readVoicePart(dir).proven.includes(version);
  const wait = o.readyWaitMs ?? READY_WAIT_MS;
  // A version not proven here that does not come up: dropped, and the previous one starts in its place.
  const giveUp = (reason: string) => {
    if (watch) { clearTimeout(watch); watch = null; }
    if (readVoicePart(dir).proven.includes(version) || !wanted || session !== generation) return false;
    const back = dropVersion(dir, version, envWant(), reason);
    o.log?.(`[voice] pipeline ${version} ${reason}; ${back ? `back to ${back}` : "no earlier version to go back to"}`);
    if (!back) return false;
    const old = child;
    child = null; ready = false; failure = null; lastError = null;
    if (old && old.exitCode === null && old.signalCode === null) { old.once("exit", () => launch(o, dir, session, back)); old.kill("SIGTERM"); }
    else launch(o, dir, session, back);
    return true;
  };
  if (watch) clearTimeout(watch);
  watch = proven ? null : setTimeout(() => { if (child && runningVersion === version) giveUp(`did not say ready in ${Math.round(wait / 1000)} s`); }, wait);
  watch?.unref?.();
  const p = spawn(join(dir, "venv", "bin", "python"), ["bot.py"], {
    cwd: join(dir, "versions", version),
    env: {
      ...process.env,
      VC_VOICE_PORT: String(o.port),
      VC_VOICE_HTTP_PORT: String(o.serverPort),
      VC_VOICE_BRAIN_MODE: "pi",
      VC_VOICE_LOG: join(o.stateDir, "logs", "voice-turns.jsonl"),
      VC_VOICE_MODELS: join(dir, "models"),
      ...(o.wantsLocal?.() && localInstalled(dir) ? { VC_VOICE_LOCAL_PREFETCH: "1" } : {}),
      ...(libs.length ? { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  ready = false;
  lastError = null;
  let diagnostics = "";
  let modelLine = "";
  const out = (b: Buffer) => {
    // The local models' download progress (local_voice.py "[voice models]" lines: names, sizes, percentages only).
    modelLine += b.toString("utf8");
    const lines = modelLine.split("\n");
    modelLine = lines.pop()!.slice(-4096);
    for (const l of lines) if (l.startsWith("[voice models] ")) {
      try { appendFileSync(join(o.stateDir, "logs", "voice-pipeline.log"), `${new Date().toISOString()} ${l}\n`); } catch { /* logs dir gone */ }
    }
    // Bounded startup markers only: provider exceptions can contain credentials.
    diagnostics = (diagnostics + b.toString("utf8")).slice(-4096);
    if (child === p && session === generation && !ready && diagnostics.includes("[voice ready]")) {
      ready = true;
      if (watch) { clearTimeout(watch); watch = null; }
      markProven(dir, version);
    }
    const bind = /\[voice bind\] port=\d+ errno=(\d+)/.exec(diagnostics);
    if (child === p && session === generation && bind) {
      if (bind[1] === "98") conflict(o);
      else fail(o, "VOICE_START_FAILED", `Voice port 127.0.0.1:${o.port}: exclusive bind failed (errno ${bind[1]}).`);
    }
  };
  p.stdout?.on("data", out);
  p.stderr?.on("data", out);
  p.once("error", () => {
    if (child !== p || session !== generation) return;
    child = null;
    fail(o, "VOICE_START_FAILED", "Voice child could not start; check the Python environment.");
  });
  p.once("exit", (code) => {
    if (child !== p || session !== generation) return;
    child = null; ready = false;
    if (!wanted) return;
    if (code === 98) conflict(o);
    else if (giveUp(`exited (${code}) before it was ready`)) return;
    else if (!failure) fail(o, "VOICE_START_FAILED", `Voice pipeline exited (${code}); check the Python environment.`);
    // A failed bind/start is terminal until an explicit off/on. Never try a fallback port.
  });
}

/** Keep the pipeline running (true) or stop it (false). Safe to call again; setup runs once. */
export async function wantPipeline(o: PipelineOptions, on: boolean): Promise<void> {
  if (!on) { stopPipeline(); return; }
  voicePort(o.serverPort, String(o.port));
  if (wanted) {
    if (failure) throw new VoiceStartupError(failure);
    return;
  }
  wanted = true; failure = null; lastError = null;
  const session = ++generation;
  try {
    await checkVoicePort(o); // BEFORE any package/model setup or HTTP probe
    if (!wanted || session !== generation) return;
    if (process.platform !== "linux") throw new Error("Managed voice requires the Linux box");
    if (spawnSync("uv", ["--version"]).status !== 0) throw new Error("uv is not installed on the box");
    const task = prepare(o);
    setup = task;
    // Setup is asynchronous as before: engine selection must not block an HTTP caller for minutes.
    void task.then((dir) => {
      if (wanted && session === generation) launch(o, dir, session);
    }).catch((e: Error) => {
      if (session === generation) fail(o, "VOICE_START_FAILED", e.message);
    }).finally(() => { if (setup === task) setup = null; });
  } catch (e) {
    if (session !== generation) return;
    if (!failure) fail(o, e instanceof VoiceStartupError ? e.reason.code : "VOICE_START_FAILED", (e as Error).message);
    throw new VoiceStartupError(failure!);
  }
}

/** Release only the ChildProcess spawned by this controller; never search/kill port occupants. */
export function stopPipeline(): void {
  if (watch) { clearTimeout(watch); watch = null; }
  wanted = false; generation++; ready = false; current = null;
  const owned = child; child = null;
  if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGTERM");
  failure = null; lastError = null;
}
