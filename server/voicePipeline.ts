// The New voice's pipeline (voice-pipeline/bot.py) as a child of this server, so the box needs nothing installed by
// hand: the server writes the pipeline's files from its own bundle into <state>/voice/, makes the Python environment
// once with uv from the pinned requirements (again only when they change), and keeps the pipeline running on
// loopback for the single voice brain (server/voiceBrain.ts). It stops with the server; VC_VOICE_PIPELINE=off
// disables startup without selecting another transport. Its log: <state>/logs/voice-pipeline.log.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
let localSetup: Promise<void> | null = null;
let localError: string | null = null;
const localStampWant = () => createHash("sha256").update(REQUIREMENTS).update(LOCAL_REQUIREMENTS).digest("hex").slice(0, 16);
const localInstalled = (dir: string) => {
  try { return readFileSync(join(dir, "venv-local.stamp"), "utf8").trim() === localStampWant(); } catch { return false; }
};

/** What the pipeline is doing (health, Settings). */
export function pipelineState() {
  return { wanted, running: ready && !!child && child.exitCode === null, settingUp: !!setup, error: lastError, failure };
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
  writeFileSync(join(dir, "bot.py"), BOT_PY);
  writeFileSync(join(dir, "listener.py"), LISTENER_PY);
  writeFileSync(join(dir, "requirements.txt"), REQUIREMENTS);
  writeFileSync(join(dir, "local_voice.py"), LOCAL_VOICE_PY);
  writeFileSync(join(dir, "requirements-local.txt"), LOCAL_REQUIREMENTS);
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

function launch(o: PipelineOptions, dir: string, session: number): void {
  if (!wanted || child || session !== generation) return;
  current = { o, dir };
  const libs = nixLibs();
  const p = spawn(join(dir, "venv", "bin", "python"), ["bot.py"], {
    cwd: dir,
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
    if (child === p && session === generation && diagnostics.includes("[voice ready]")) ready = true;
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
  wanted = false; generation++; ready = false; current = null;
  const owned = child; child = null;
  if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGTERM");
  failure = null; lastError = null;
}
