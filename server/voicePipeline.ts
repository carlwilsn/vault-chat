// The New voice's pipeline (voice-pipeline/bot.py) as a child of this server, so the box needs nothing installed by
// hand: the server writes the pipeline's files from its own bundle into <state>/voice/, makes the Python environment
// once with uv from the pinned requirements (again only when they change), and keeps the pipeline running on
// loopback while the box's voice engine is "new" (server/voiceBrain.ts). It stops with the server and when the
// engine goes back to Classic. Its log: <state>/logs/voice-pipeline.log.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BOT_PY from "../voice-pipeline/bot.py?raw";
import REQUIREMENTS from "../voice-pipeline/requirements.txt?raw";

export type PipelineOptions = { stateDir: string; port: number; log?: (s: string) => void };

let child: ChildProcess | null = null;
let wanted = false;
let setup: Promise<string | null> | null = null;
let restarts: number[] = [];
let lastError: string | null = null;

/** What the pipeline is doing (health, Settings). */
export function pipelineState(): { wanted: boolean; running: boolean; settingUp: boolean; error: string | null } {
  return { wanted, running: !!child && child.exitCode === null, settingUp: !!setup, error: lastError };
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
async function prepare(o: PipelineOptions): Promise<string | null> {
  const dir = join(o.stateDir, "voice");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bot.py"), BOT_PY);
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
  if (!existsSync(python) && (await run(["venv", "venv"])) !== 0) return (lastError = "uv venv failed (is uv installed?)"), null;
  if ((await run(["pip", "install", "-r", "requirements.txt"])) !== 0) return (lastError = "installing the pipeline's packages failed (voice-pipeline.log)"), null;
  writeFileSync(stamp, want);
  return dir;
}

function launch(o: PipelineOptions, dir: string): void {
  if (!wanted || child) return;
  const logFile = join(o.stateDir, "logs", "voice-pipeline.log");
  const libs = nixLibs();
  const p = spawn(join(dir, "venv", "bin", "python"), ["bot.py"], {
    cwd: dir,
    env: {
      ...process.env,
      VC_VOICE_PORT: String(o.port),
      VC_VOICE_BRAIN_MODE: "pi",
      VC_VOICE_LOG: join(o.stateDir, "logs", "voice-turns.jsonl"),
      ...(libs.length ? { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  lastError = null;
  const out = (b: Buffer) => {
    try {
      appendFileSync(logFile, b);
    } catch {
      /* no log */
    }
  };
  p.stdout?.on("data", out);
  p.stderr?.on("data", out);
  p.on("exit", (code) => {
    if (child === p) child = null;
    if (!wanted) return;
    // Restarted, with a brake: more than 5 exits in 5 minutes waits a minute.
    const now = Date.now();
    restarts = [...restarts.filter((t) => now - t < 5 * 60_000), now];
    lastError = `the pipeline exited (${code})`;
    o.log?.(`[voice] pipeline exited (${code}); restarting`);
    setTimeout(() => launch(o, dir), restarts.length > 5 ? 60_000 : 2000).unref?.();
  });
}

/** Keep the pipeline running (true) or stop it (false). Safe to call again; setup runs once. */
export function wantPipeline(o: PipelineOptions, on: boolean): void {
  wanted = on;
  if (!on) {
    child?.kill("SIGTERM");
    child = null;
    return;
  }
  if (child) return;
  if (process.platform !== "linux") return; // the box; a laptop dev server runs it by hand
  if (!spawnSync("uv", ["--version"]).stdout) {
    lastError = "uv is not installed on the box";
    return;
  }
  setup ??= prepare(o).finally(() => {
    setup = null;
  });
  void setup.then((dir) => dir && launch(o, dir));
}

/** The server is going down: the pipeline goes with it. */
export function stopPipeline(): void {
  wanted = false;
  child?.kill("SIGTERM");
  child = null;
}
