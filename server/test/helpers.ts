// Test rig: temp vaults and git repos, a fake key store (canary values only),
// and the built server bundle as a real child process running the real Claude
// Code CLI against a scripted stand-in for the Anthropic API
// (./claudeFakeApi.ts) — which is every model call the box makes now.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { Encrypter } from "age-encryption";
import { pathToFileURL } from "node:url";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { findClaude } from "../engine/claude/install";

export const ROOT = resolve(__dirname, "..", "..");
export const BUNDLE = join(ROOT, "dist-server", "vault-chat-server.mjs");
/**
 * The Claude Code the tests run: the pinned CLI the Agent SDK ships, exactly
 * the binary a box runs. Found once (resolving it probes `--version`), and
 * handed to the server as VC_CLAUDE_BIN.
 */
let foundCli: string | null = null;
export function claudeCli(): string {
  if (foundCli) return foundCli;
  const dir = join(tmpdir(), "vc-test-claude");
  mkdirSync(dir, { recursive: true });
  const found = findClaude({ stateDir: dir, env: { PATH: process.env.PATH ?? "" } });
  if (!("install" in found)) throw new Error(`tests need Claude Code: ${found.error} — ${found.tried.join("; ")}`);
  return (foundCli = found.install.cli);
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
  /** Where the engine's Claude Code sends its API calls (./claudeFakeApi.ts).
   * Left out, the server still gets one of its own, so no turn ever reaches the
   * real API and none hangs waiting for a key. */
  anthropic?: string;
  token?: string;
  extra?: Record<string, string>;
};

/** Spawn the built bundle; resolves once it is listening (or exited). */
export async function startServer(e: ServerEnv & { bundle?: string }): Promise<Running> {
  const bundle = e.bundle ?? BUNDLE;
  if (!existsSync(bundle)) throw new Error("bundle missing — run `npm run build:server`");
  const port = await freePort();
  const voicePort = String(await freePort());
  const tokenFile = join(e.home, "phone-token");
  if (e.token) writeFileSync(tokenFile, e.token);
  // A test that scripts its turns passes its own; the rest get a silent one, so
  // the CLI is always pointed somewhere local and always counts as signed in.
  const ownApi: FakeApi | null = e.anthropic || e.extra?.ANTHROPIC_BASE_URL ? null : await fakeAnthropic();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: e.home,
    USERPROFILE: e.home,
    VC_HOST: "127.0.0.1",
    VC_PORT: String(port),
    VC_VOICE_PORT: voicePort,
    VC_VOICE_PIPELINE_PORT: voicePort,
    VC_VOICE_PIPELINE: "off",
    VC_VAULT: e.vault,
    VC_BARE_REPO: e.bare ?? join(e.home, "none.git"),
    VC_SECRETS_DIR: e.secrets,
    VC_LOCALSTORAGE: join(e.home, "mission-engine.localstorage"),
    VC_PUSH_SUBS: join(e.home, "phone-push-subs.json"),
    VC_TOKEN_FILE: tokenFile,
    VC_STATE_DIR: join(e.home, "state"),
    VC_SYNC: e.bare ? "1" : "0",
    // The engine is the real Claude Code CLI, the pinned one a box runs, with
    // the model's answers scripted by the stand-in API below.
    VC_CLAUDE_BIN: claudeCli(),
    VC_ENGINE_MODEL: "haiku",
    ANTHROPIC_BASE_URL: e.anthropic ?? ownApi?.url ?? "",
    // Not a key: the stand-in never looks, and it is what makes the CLI (and so
    // the backend's signedIn) treat this box as signed in without a login.
    ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
    VC_SANDBOX_UNSAFE: "1",
    VC_BWRAP: join(e.home, "no-bwrap"),
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
      if (proc.exitCode !== null) {
        await ownApi?.close();
        return proc.exitCode;
      }
      proc.kill();
      const code = await exited;
      await ownApi?.close();
      return code;
    },
  };
}

/**
 * How much longer than a call site asks for a wait may take here.
 *
 * Every budget in this suite was chosen on a machine running it alone. The ship
 * host runs it nice'd, on a box that is also serving Carl, and a turn there can
 * take several times what it takes locally: read out of the gate's own baseline
 * log for main 7f2f775c, 14 turn-driven tests failed on "timed out waiting"
 * while passing here. Fewer workers (server/vitest.config.ts) is the first half
 * of that fix; this is the rest of it.
 *
 * Waiting longer costs nothing when the thing happens — waitFor returns as soon
 * as its condition holds. It only makes a test that was already going to fail
 * slower to say so. Capped so a scaled budget still fits inside the per-test
 * timeout, which would otherwise cut the wait off before it could name what it
 * was waiting for.
 */
const PATIENCE = 2;
const PATIENCE_CAP_MS = 100_000;
export const patient = (ms: number): number => Math.min(ms * PATIENCE, Math.max(ms, PATIENCE_CAP_MS));

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 30_000, step = 200): Promise<T> {
  const end = Date.now() + patient(ms);
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

/**
 * A project as the box keeps it (server/context/projects.ts): a folder registered in its vault's registry
 * (.vault-chat/local/project-folders.json), its AGENTS.md (instructions), .vault-chat/project-memory.md and
 * .vault-chat/rules.md inside it. `folder`: vault-relative or absolute (default: the slug). Returns the folder.
 */
export function seedProject(vault: string, slug: string, o: { folder?: string; agents?: string; memory?: string; rules?: string } = {}): string {
  const raw = o.folder ? (isAbsolute(o.folder) ? o.folder : join(vault, o.folder)) : join(vault, slug);
  mkdirSync(join(raw, ".vault-chat"), { recursive: true });
  const folder = realpathSync(raw);
  if (o.agents !== undefined) writeFileSync(join(folder, "AGENTS.md"), o.agents);
  if (o.memory !== undefined) writeFileSync(join(folder, ".vault-chat", "project-memory.md"), o.memory);
  if (o.rules !== undefined) writeFileSync(join(folder, ".vault-chat", "rules.md"), o.rules);
  const reg = join(vault, ".vault-chat", "local", "project-folders.json");
  let r: { folders: Record<string, unknown>; deleted: Record<string, unknown> } = { folders: {}, deleted: {} };
  try {
    r = JSON.parse(readFileSync(reg, "utf8"));
  } catch {
    /* none yet */
  }
  r.folders[slug] = { path: folder, at: new Date().toISOString() };
  mkdirSync(dirname(reg), { recursive: true });
  writeFileSync(reg, JSON.stringify(r, null, 2) + "\n");
  return folder;
}
