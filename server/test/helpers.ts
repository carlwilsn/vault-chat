// Test rig: temp vaults and git repos, a fake key store (canary values only),
// a scripted fake OpenRouter, and the built server bundle as a real child
// process.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Encrypter } from "age-encryption";

export const ROOT = resolve(__dirname, "..", "..");
export const BUNDLE = join(ROOT, "dist-server", "vault-chat-server.mjs");

export function tmp(prefix = "vcs-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file locks: best effort */
  }
}

export function sh(cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr}${r.stdout}`);
  return r.stdout;
}

export function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
}

/** A small vault: a few notes, git on branch `box`, one commit. */
export function makeVault(dir: string): string {
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Test vault\n");
  writeFileSync(join(dir, "notes", "ideas.md"), "- an idea\n");
  writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n*.jsonl merge=union\n");
  git(dir, "init", "-q", "-b", "box");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** secrets.age + fallback.key in vault-chat's fallback format, canary values. */
export async function makeKeyStore(dir: string, map: Record<string, string>): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const pass = "test-passphrase-not-a-secret";
  const e = new Encrypter();
  e.setPassphrase(pass);
  e.setScryptWorkFactor(10);
  const ct = await e.encrypt(JSON.stringify(map));
  writeFileSync(join(dir, "fallback.key"), pass);
  writeFileSync(join(dir, "secrets.age"), Buffer.from(ct).toString("base64"));
  return dir;
}

export type FakeOpenRouter = {
  url: string;
  calls: any[];
  close: () => Promise<void>;
  /** Text the next completions reply with. */
  reply: string;
};

/** Scripted OpenRouter: every chat completion answers `reply`, streamed or
 * not, with a usage block. /models returns a tiny catalog. */
export async function fakeOpenRouter(reply = "Acknowledged. Mission started."): Promise<FakeOpenRouter> {
  const state: FakeOpenRouter = { url: "", calls: [], close: async () => {}, reply };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/\?.*$/, "");
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" }] }));
        return;
      }
      if (!path.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep {} */
      }
      state.calls.push(parsed);
      const id = `gen-${state.calls.length}`;
      const model = parsed.model ?? "openai/gpt-5.6-sol";
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta: any, finish: string | null, extra: any = {}) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
        res.write(chunk({ role: "assistant", content: "" }, null));
        res.write(chunk({ content: state.reply }, null));
        res.write(chunk({}, "stop", { usage }));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: 1,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: state.reply }, finish_reason: "stop" }],
            usage,
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  state.url = `http://127.0.0.1:${port}/api/v1`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });
}

export type Running = {
  base: string;
  port: number;
  proc: ChildProcess;
  logs: () => string;
  stop: () => Promise<number | null>;
  exited: Promise<number | null>;
};

export type ServerEnv = {
  home: string;
  vault: string;
  bare?: string;
  secrets: string;
  openrouter?: string;
  token?: string;
  extra?: Record<string, string>;
};

/** Spawn the built bundle; resolves once it is listening (or exited). */
export async function startServer(e: ServerEnv): Promise<Running> {
  if (!existsSync(BUNDLE)) throw new Error("bundle missing — run `npm run build:server`");
  const port = await freePort();
  const tokenFile = join(e.home, "phone-token");
  if (e.token) writeFileSync(tokenFile, e.token);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: e.home,
    USERPROFILE: e.home,
    VC_HOST: "127.0.0.1",
    VC_PORT: String(port),
    VC_VAULT: e.vault,
    VC_BARE_REPO: e.bare ?? join(e.home, "none.git"),
    VC_SECRETS_DIR: e.secrets,
    VC_LOCALSTORAGE: join(e.home, "mission-engine.localstorage"),
    VC_PUSH_SUBS: join(e.home, "phone-push-subs.json"),
    VC_TOKEN_FILE: tokenFile,
    VC_STATE_DIR: join(e.home, "state"),
    VC_SYNC: e.bare ? "1" : "0",
    ...(e.openrouter ? { VC_OPENROUTER_BASE: e.openrouter } : {}),
    ...(e.extra ?? {}),
  };
  const proc = spawn(process.execPath, [BUNDLE], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60_000);
    const check = setInterval(() => {
      if (out.includes("listening on")) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 50);
    void exited.then(() => {
      clearTimeout(t);
      clearInterval(check);
      resolve();
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    proc,
    logs: () => out,
    exited,
    stop: async () => {
      if (proc.exitCode !== null) return proc.exitCode;
      proc.kill();
      return exited;
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 30_000, step = 200): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`timed out waiting${last ? `: ${last}` : ""}`);
}
