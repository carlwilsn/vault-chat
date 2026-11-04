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

export type PipelineOptions = { stateDir: string; serverPort: number; port: number; log?: (s: string) => void };

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
  const want = createHash("sha256").update(REQUIREMENTS).digest("hex").slice(0, 16);
  const stamp = join(dir, "venv.stamp");
  const python = join(dir, "venv", "bin", "python");
  if (existsSync(python) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want) return dir;
  o.log?.("[voice] setting up the pipeline's Python environment (uv; a few minutes the first time)");
  const run = (args: string[]) =>
    new Promise<number>((res) => {
      const p = spawn("uv", args, { cwd: dir, env: { ...process.env, VIRTUAL_ENV: join(dir, "venv") }, stdio: ["ignore", "pipe", "pipe"] });
      const out = (b: Buffer) => appendFileSync(join(o.stateDir, "logs", "voice-pipeline.log"), b);
      p.stdout.on("data", out);
      p.stderr.on("data", out);
      p.on("exit", (c) => res(c ?? 1));
      p.on("error", () => res(127));
    });
  mkdirSync(join(o.stateDir, "logs"), { recursive: true });
  if (!existsSync(python) && (await run(["venv", "venv"])) !== 0) throw new Error("uv venv failed (is uv installed?)");
  if ((await run(["pip", "install", "-r", "requirements.txt"])) !== 0) throw new Error("Installing the pipeline’s packages failed (voice-pipeline.log)");
  writeFileSync(stamp, want);
  return dir;
}

function launch(o: PipelineOptions, dir: string, session: number): void {
  if (!wanted || child || session !== generation) return;
  const libs = nixLibs();
  const p = spawn(join(dir, "venv", "bin", "python"), ["bot.py"], {
    cwd: dir,
    env: {
      ...process.env,
      VC_VOICE_PORT: String(o.port),
      VC_VOICE_HTTP_PORT: String(o.serverPort),
      VC_VOICE_BRAIN_MODE: "pi",
      VC_VOICE_LOG: join(o.stateDir, "logs", "voice-turns.jsonl"),
      ...(libs.length ? { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  ready = false;
  lastError = null;
  let diagnostics = "";
  const out = (b: Buffer) => {
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
  wanted = false; generation++; ready = false;
  const owned = child; child = null;
  if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGTERM");
  failure = null; lastError = null;
}
