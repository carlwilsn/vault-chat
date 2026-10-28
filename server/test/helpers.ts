// Test rig: temp vaults and git repos, a fake key store (canary values only),
// a scripted fake OpenRouter, and the built server bundle as a real child
// process.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Encrypter } from "age-encryption";
import { pathToFileURL } from "node:url";

export const ROOT = resolve(__dirname, "..", "..");
export const BUNDLE = join(ROOT, "dist-server", "vault-chat-server.mjs");

/** An npm prefix holding the fake pi (server/test/fakePiCli.mjs) as @earendil-works/pi-coding-agent@1.1.0 (VC_PI_DIR). */
export function fakePiDir(home: string): string {
  const dir = join(home, "fakepi");
  const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.1.0", type: "module" }));
  // Resolve the official SDK from this checkout even though the fixture CLI
  // lives in a throwaway npm prefix (also works without symlink privileges).
  const source = readFileSync(join(ROOT, "server", "test", "fakePiCli.mjs"), "utf8")
    .replace('"@modelcontextprotocol/sdk/client/index.js"', JSON.stringify(pathToFileURL(join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href))
    .replace('"@modelcontextprotocol/sdk/client/streamableHttp.js"', JSON.stringify(pathToFileURL(join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href));
  writeFileSync(join(pkg, "dist", "bundle", "cli.js"), source);
  // Filesystem tools are the real pinned pi factories, even when the model
  // loop is scripted. Never maintain a fake second filesystem implementation.
  const tools = join(process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js");
  if (!existsSync(tools)) throw new Error("Tests require installed pi 1.1.0 tool factories (VC_TEST_PI_DIR)");
  mkdirSync(join(pkg, "dist", "core", "tools"), { recursive: true });
  writeFileSync(join(pkg, "dist", "core", "tools", "index.js"), `export * from ${JSON.stringify(pathToFileURL(tools).href)};`);
  return dir;
}

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

/** Test-side git never asks for credentials: no prompt, and no credential
 * helper (Git Credential Manager from Git for Windows' system config would
 * otherwise answer a 401 from a test server and record a
 * `credential.http://127.0.0.1:<port>.provider` line in the real ~/.gitconfig). */
const GIT_NO_CREDENTIALS: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
};

export function sh(cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...(cmd === "git" ? GIT_NO_CREDENTIALS : {}), ...env }, windowsHide: true });
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

export type ScriptStep = { text?: string; toolCall?: { name: string; args: unknown }; drop?: boolean };

export type FakeOpenRouter = {
  url: string;
  calls: any[];
  close: () => Promise<void>;
  /** Text the next completions reply with. */
  reply: string;
  /** Consumed one per completion before falling back to `reply`. */
  script: ScriptStep[];
};

/** Scripted OpenRouter: every chat completion answers `reply`, streamed or
 * not, with a usage block. /models returns a tiny catalog. */
export async function fakeOpenRouter(reply = "Acknowledged. Mission started."): Promise<FakeOpenRouter> {
  const state: FakeOpenRouter = { url: "", calls: [], close: async () => {}, reply, script: [] };
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
      const step = state.script.shift();
      // OpenRouter's edge closing the connection after the whole request arrived, no answer (the box's
      // "Connection error.": undici's "other side closed").
      if (step?.drop) {
        req.socket.destroy();
        return;
      }
      if (step?.toolCall && parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        // Scripts name logical tools; the provider must return the exact name
        // actually declared by pi (native MCP names are not display aliases).
        const native = `mcp__vault_chat__${step.toolCall.name}`;
        const name = parsed.tools?.some((t: any) => t.function?.name === native) ? native : step.toolCall.name;
        const tc = { index: 0, id: `call_${state.calls.length}`, type: "function", function: { name, arguments: JSON.stringify(step.toolCall.args) } };
        const ch = (delta: any, finish: string | null, extra: any = {}) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}

`;
        res.write(ch({ role: "assistant", content: null, tool_calls: [tc] }, null));
        res.write(ch({}, "tool_calls", { usage }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (step?.text !== undefined) state.reply = step.text;
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

/** A one-page PDF whose only text is `text` (ASCII), with a correct xref. */
export function tinyPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 60 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>
stream
${stream}
endstream`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj
${o}
endobj
`;
  });
  const xref = out.length;
  out += `xref
0 ${objs.length + 1}
0000000000 65535 f 
`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n 
`;
  out += `trailer
<< /Size ${objs.length + 1} /Root 1 0 R >>
startxref
${xref}
%%EOF
`;
  return Buffer.from(out, "latin1");
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
export async function startServer(e: ServerEnv & { bundle?: string }): Promise<Running> {
  const bundle = e.bundle ?? BUNDLE;
  if (!existsSync(bundle)) throw new Error("bundle missing — run `npm run build:server`");
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
    // The engine on the fake pi (server/test/fakePiCli.mjs) unless a test names another (piEngine.test.ts: the real pi).
    VC_ENGINE: "pi",
    VC_PI_DIR: fakePiDir(e.home),
    VC_ENGINE_MODEL: "openai/gpt-5.6-sol",
    VC_PI_UNSAFE: "1",
    VC_BWRAP: join(e.home, "no-bwrap"),
    ...(e.openrouter ? { VC_OPENROUTER_BASE: e.openrouter } : {}),
    ...(e.extra ?? {}),
  };
  const proc = spawn(process.execPath, [bundle], { cwd: dirname(bundle), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60_000);
    const check = setInterval(() => {
      // Listening, and the engine started (or said why not), unless it is off.
      const engineReady = env.VC_ENGINE === "0" || /engine (up|not running|failed)/.test(out);
      if (out.includes("listening on") && engineReady) {
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

// ---- Web Push: a fake push service that decrypts what it receives ----
import { createECDH, randomBytes, hkdfSync, createDecipheriv } from "node:crypto";

export type FakePush = {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  received: { headers: Record<string, string | string[] | undefined>; payload: any }[];
  close: () => Promise<void>;
};

/** RFC 8291 receiver: a P-256 subscription whose endpoint is a local server
 * that decrypts every aes128gcm POST back to its JSON payload. */
/** `status`: what it answers (Apple answers 400 on every push to a subscription made under another VAPID key). */
export async function fakePushService(status = 201): Promise<FakePush> {
  const ecdh = createECDH("prime256v1");
  const uaPub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const received: FakePush["received"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPub = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPub);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]);
      const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      const end = plain.lastIndexOf(2);
      received.push({ headers: req.headers, payload: JSON.parse(plain.subarray(0, end).toString("utf8")) });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status >= 400 ? JSON.stringify({ reason: "BadJwtToken" }) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const b64u = (b: Buffer) => b.toString("base64url");
  return {
    subscription: { endpoint: `http://127.0.0.1:${port}/push/abc`, keys: { p256dh: b64u(uaPub), auth: b64u(auth) } },
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
