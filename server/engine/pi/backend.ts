// EngineBackend on pi 1.1.0 (RPC mode). A thread is a pi session (thread id =
// pi's session id, ref = its session file); each thread with work in hand has
// its own pi process (proc.ts: own process group, bubblewrap pid namespace,
// key on fd 3). vault-chat's tools reach the engine through the extension
// (ext/vc.mjs) as blocking host calls on the extension-UI channel; the cost of
// every model call is OpenRouter's own figure, which the extension writes into
// the session as `vc-cost` entries (usageCalls reads them back).
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { CallRecord } from "../ledger";
import type { ThreadTokenUsage } from "../context";
import { PiProc } from "./proc";
import { Subagents, type SubagentOptions } from "./subagents";
import { SideRuns } from "./side";
import { modelWindow, type PiCatalogRow, type PiPaths } from "./config";
import type { PiInstall } from "./install";

// ---- what the engine (../engine.ts) sees: neutral events and the two handlers it answers
/** `readOnly`: the tool changes nothing (Ctrl+K / Ctrl+L side threads get every such tool: pi/side.ts). */
export type ToolSpec = { type: "function"; name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean };

/** What the runtime reports, in neutral terms. Every event names the thread it
 * belongs to; subagent threads report under their own ids (the engine maps
 * them to the parent conversation from the `subagents` event). */
export type BackendEvent =
  | { kind: "turnStarted"; threadId: string; turnId: string }
  /** One of pi's own RPC session events, as pi sent it (the engine maps it into the log, 1:1: ../piMap.ts). */
  | { kind: "pi"; threadId: string; ev: any }
  /** The context size of the last model call, and the model's window. */
  | { kind: "usage"; threadId: string; usage: ThreadTokenUsage }
  /** The parent spawned/messaged subagents. */
  | { kind: "subagents"; threadId: string; itemId: string; children: string[]; op: string; prompt?: string; model?: string | null; done: boolean; ok: boolean }
  | { kind: "subagentStatus"; threadId: string; child: string; status: string; path?: string; patch?: Record<string, unknown> }
  | { kind: "turnCompleted"; threadId: string; turnId: string | null; status: "completed" | "interrupted" | "failed" | string; error: string | null }
  /** One thread's runtime died mid-turn while the rest of the runtime is fine (pi: one process per thread).
   * The engine marks that turn cut and resumes it, as it does for all turns on "down". */
  | { kind: "threadLost"; threadId: string };

/** resumeThread throws this when the thread belongs to another runtime (or is gone): the engine starts a fresh one. */
export class ThreadUnknownError extends Error {
  readonly threadUnknown = true;
}

/** A host tool's answer: its text, and images it attaches (pi image blocks: base64 + mime). */
export type ToolAnswer = { ok: boolean; text: string; images?: { data: string; mimeType: string }[] };
export type ToolCallHandler = (threadId: string, name: string, args: any) => Promise<ToolAnswer>;
export type UserInputHandler = (threadId: string, question: string, options: string[]) => Promise<string>;
/** The "you" layer for a session (the extension's before_agent_start asks before each prompt): what Carl
 * did since `since` (that session's last layer). A conversation's thread names itself by `threadId`; a
 * Ctrl+K / Ctrl+L side thread by the conversation it was forked from (`convId`, or none). */
export type YouHandler = (q: { threadId?: string; convId?: string | null; since: number | null }) => Promise<{ text: string; until: number }>;
/** A read-only vault-chat tool called from a Ctrl+K / Ctrl+L side thread, as of the conversation it was opened from (or none). */
export type SideToolHandler = (convId: string | null, name: string, args: any) => Promise<ToolAnswer>;
export type Handlers = { toolCall: ToolCallHandler; userInput: UserInputHandler; you?: YouHandler; sideTool?: SideToolHandler };

export type PiSandbox = {
  /** bubblewrap argv for pi itself (ends with "--"), or null (no sandbox). */
  outer: string[] | null;
  /** bubblewrap argv for each shell command (ends with "--"), or null. */
  shell: string[] | null;
  /** Paths pi's in-process tools may not read or write / may not write. */
  denyRead: string[];
  denyWrite: string[];
  /** The other vaults on the box (working copies, bare repos, their engine state), read at each
   * spawn so a vault added later is walled off too: hidden in the outer layer, denied to the guard. */
  others?: () => string[];
  /** The vault roots the sandbox empties (tmpfs): another vault under one is already gone, never re-walled. */
  roots?: string[];
};

/** bubblewrap args hiding each path that exists (a dir behind an empty tmpfs, a file behind /dev/null). */
export function hideArgs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push("--tmpfs", p);
      else if (st.isFile()) out.push("--ro-bind", "/dev/null", p);
    } catch {
      /* missing: nothing to hide */
    }
  }
  return out;
}

/** The outer bubblewrap argv with the other vaults hidden (null without a sandbox). */
export function outerWith(sb: PiSandbox): string[] | null {
  if (!sb.outer) return null;
  // A path under an emptied vault root does not exist in the sandbox; a --tmpfs on it would create an
  // empty stub named after that vault. Only what lies elsewhere (e.g. its engine state) is walled.
  const gone = (p: string) =>
    (sb.roots ?? []).some((r) => {
      const rel = relative(r, p);
      return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
    });
  const extra = hideArgs((sb.others?.() ?? []).filter((p) => !gone(p)));
  return extra.length ? [...sb.outer.slice(0, -1), ...extra, "--"] : sb.outer;
}

export type PiBackendOptions = {
  install: PiInstall;
  paths: PiPaths;
  catalog: Map<string, PiCatalogRow>;
  sandbox: PiSandbox;
  apiKey: () => string | null;
  thinking: string;
  idleMs: number;
  maxProcs: number;
  subagents: SubagentOptions;
  /** The keys as environment variables (server/keys.ts agentKeyEnv), read at each command: the agent's Bash gets them. */
  keyEnv?: () => Record<string, string>;
  log?: (s: string) => void;
};

type Thread = {
  id: string;
  /** Subagents may be spawned from this thread (the `subagent` tool is registered). */
  subagents: boolean;
  file: string;
  proc: PiProc;
  model: string;
  lastUsed: number;
  turnId: string | null;
  msgIndex: number;
  crashes: number[];
  /** A model set for one turn only (images on a model that can't see). */
  restoreModel: string | null;
  /** The provider's error on the last assistant message (stopReason "error"). */
  lastError?: string | null;
  /** The thinking level set on the process when a turn asked for one (a voice call's talker); null: the default. */
  thinking?: string | null;
};

/** Events: "event" (BackendEvent), "up" (ready; the engine resumes cut turns). */
export class PiBackend extends EventEmitter {
  readonly name = "pi";
  readonly version: string;
  private threads = new Map<string, Thread>();
  private h: Handlers | null = null;
  private seq = 0;
  private stats = { spawns: 0, crashes: 0 };
  private crashLog = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;
  private lastPid: number | null = null;

  constructor(private o: PiBackendOptions) {
    super();
    this.setMaxListeners(50);
    this.version = o.install.version;
    this.subs = new Subagents(this, o.subagents, (m) => this.log(m));
    this.side = new SideRuns(this, (m) => this.log(m));
  }

  private subs: Subagents;
  /** Side threads (Ctrl+K / Ctrl+L, one-shots): side.ts. */
  readonly side: SideRuns;
  /** A thread's session file, instructions and working folder: what a side thread forks. */
  threadSource(threadId: string): { file: string; instr: string; cwd: string } | null {
    try {
      const meta = JSON.parse(readFileSync(join(this.o.paths.instrDir, `${threadId}.json`), "utf8"));
      const file = this.sessionFileOf(threadId);
      return file && typeof meta.instr === "string" ? { file, instr: meta.instr, cwd: String(meta.cwd ?? "") } : null;
    } catch {
      return null;
    }
  }
  /** The engine's handlers (a child's Notify/PdfRead/WebSearch go to its parent's). */
  get handlers(): Handlers | null {
    return this.h;
  }
  get paths(): PiPaths {
    return this.o.paths;
  }
  /** The tool-spec file of a thread (its children's specs are filtered from it). */
  toolsFileOf(threadId: string): string | null {
    try {
      return JSON.parse(readFileSync(join(this.o.paths.instrDir, `${threadId}.json`), "utf8")).tools ?? null;
    } catch {
      return null;
    }
  }
  modelOf(threadId: string): string | null {
    return this.threads.get(threadId)?.model ?? null;
  }

  private log(s: string): void {
    (this.o.log ?? ((m) => console.log(`[pi] ${m}`)))(s);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.killStale();
    this.timer = setInterval(() => void this.reapIdle(), 30_000);
    this.timer.unref?.();
    // No single runtime process: pi is "up" once installed; the engine's boot resume runs now.
    setImmediate(() => this.emit("up"));
  }

  async ready(_ms?: number): Promise<boolean> {
    return true;
  }

  health(): Record<string, unknown> {
    const procs = [...this.threads.values()].map((t) => ({ threadId: t.id, pid: t.proc.pid, model: t.model, busy: !!t.turnId, sinceMs: Date.now() - t.proc.startedAt }));
    return { state: "up", version: this.version, sandbox: !!this.o.sandbox.outer, pid: this.lastPid, procs, subagents: this.subs.health(), side: this.side.health(), ...this.stats };
  }

  setHandlers(h: Handlers): void {
    this.h = h;
  }

  /** Tests: kill the pi that last started a turn, hard (its whole namespace goes with it). */
  killHard(): number | null {
    const busy = [...this.threads.values()].filter((t) => t.turnId).sort((a, b) => b.lastUsed - a.lastUsed)[0];
    const t = busy ?? [...this.threads.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!t?.proc.pid) return null;
    const pid = t.proc.pid;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return null;
    }
    return pid;
  }

  // ---------------------------------------------------------------- processes

  /** pi process groups a previous server left behind (pids.json): killed at boot. */
  private killStale(): void {
    let pids: { pid: number }[] = [];
    try {
      pids = JSON.parse(readFileSync(this.o.paths.pidsFile, "utf8"));
    } catch {
      pids = [];
    }
    for (const { pid } of pids) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (!cmd.includes(this.o.install.cli)) continue; // the pid was reused
      for (const p of [-pid, pid]) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      this.log(`killed a stale pi (pid ${pid}) left by a previous run`);
    }
    this.savePids();
  }

  private savePids(): void {
    try {
      mkdirSync(this.o.paths.root, { recursive: true });
      writeFileSync(this.o.paths.pidsFile, JSON.stringify([...this.threads.values()].map((t) => ({ thread: t.id, pid: t.proc.pid }))));
    } catch {
      /* best effort */
    }
  }

  piEnv(toolsFile: string, subagents = false, you = false): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /OPENROUTER|API_KEY|APIKEY|SECRET|PASSW|_TOKEN$|^VC_|^PI_/i.test(k)) continue;
      env[k] = v;
    }
    return Object.assign(env, {
      PI_CODING_AGENT_DIR: this.o.paths.agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      VC_KEY_FD: "3",
      VC_PI_TOOLS: toolsFile,
      ...(you ? { VC_PI_YOU: "1" } : {}),
      ...(subagents
        ? {
            VC_PI_SUBAGENTS: "1",
            VC_PI_AGENTS_DIRS: JSON.stringify(this.o.subagents.agentsDirs),
            VC_PI_SUBAGENT_CONCURRENCY: String(this.o.subagents.concurrency),
            VC_PI_SUBAGENT_MAX_TASKS: String(this.o.subagents.maxTasks),
          }
        : {}),
      VC_PI_DENY_READ: JSON.stringify([...this.o.sandbox.denyRead, ...(this.o.sandbox.others?.() ?? [])]),
      VC_PI_DENY_WRITE: JSON.stringify(this.o.sandbox.denyWrite),
      ...(this.o.sandbox.shell ? { VC_PI_SHELL_WRAP: JSON.stringify(this.o.sandbox.shell) } : {}),
      ...(process.env.VC_PI_SHELL_TIMEOUT_S ? { VC_PI_SHELL_TIMEOUT_S: process.env.VC_PI_SHELL_TIMEOUT_S } : {}),
      ...(process.env.VC_PI_GEMINI_CACHE ? { VC_PI_GEMINI_CACHE: process.env.VC_PI_GEMINI_CACHE } : {}),
      ...(process.env.VC_PI_CACHE_RETENTION ? { PI_CACHE_RETENTION: process.env.VC_PI_CACHE_RETENTION } : {}),
    });
  }

  /** Spawn pi on a session (new when `file` is null) and wait for it to answer. Children (subagents) and
   * side threads (side.ts) pass their own session dir and tool list; they don't count against maxProcs.
   * `fork`: pi's --fork (a new session holding that session's history, its header naming it as parent);
   * `ephemeral`: pi's --no-session; `system`: pi's --system-prompt (replaces pi's own) instead of
   * --append-system-prompt `instr`; `builtins: []`: pi's --no-tools. `you`: the extension asks for the
   * "you" layer before each prompt (conversations and Ctrl+K / Ctrl+L; not subagents or one-shots). */
  async spawn(o: { cwd: string; model: string; file: string | null; instr: string; tools: string; subagents?: boolean; sessionDir?: string; builtins?: string[]; fork?: string; ephemeral?: boolean; system?: string; thinking?: string; you?: boolean }): Promise<{ proc: PiProc; id: string; file: string }> {
    if (!o.sessionDir) await this.makeRoom();
    const session = o.fork ? ["--fork", o.fork] : o.ephemeral ? ["--no-session"] : o.file ? ["--session", o.file] : [];
    const args = [
      this.o.install.cli,
      "--mode", "rpc",
      "--session-dir", o.sessionDir ?? this.o.paths.sessionsDir,
      "--model", `openrouter/${o.model}`,
      "--thinking", o.thinking ?? this.o.thinking,
      "-ne", "--no-mcp", "-ns", "-np", "--no-themes", "-na", "--offline",
      "-e", this.o.paths.ext,
      ...(o.system ? ["--system-prompt", o.system] : ["--append-system-prompt", o.instr]),
      ...(o.builtins ? (o.builtins.length ? ["--tools", o.builtins.join(",")] : ["--no-tools"]) : []),
      ...session,
    ];
    const outer = outerWith(this.o.sandbox);
    const argv = outer ? [...outer, this.o.install.node, ...args] : [this.o.install.node, ...args];
    const proc = new PiProc({ argv, cwd: o.cwd, env: this.piEnv(o.tools, !!o.subagents, !!o.you), key: this.o.apiKey() });
    proc.start();
    this.stats.spawns++;
    let st: any;
    try {
      st = await proc.request({ type: "get_state" }, 60_000);
    } catch (e) {
      proc.killGroup("SIGKILL");
      const tail = proc.stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      throw new Error(`pi did not start: ${(e as Error).message}${tail ? ` — ${tail}` : ""}`);
    }
    const id = String(st?.data?.sessionId ?? "");
    const file = String(st?.data?.sessionFile ?? "");
    if (!id || (!file && !o.ephemeral)) {
      proc.killGroup("SIGKILL");
      throw new Error("pi reported no session");
    }
    return { proc, id, file };
  }

  private attach(t: Thread): void {
    this.threads.set(t.id, t);
    this.lastPid = t.proc.pid;
    t.proc.on("event", (e: any) => this.onPiEvent(t, e));
    t.proc.on("ui", (r: any) => void this.onUi(t, r));
    t.proc.on("exit", (x: any) => this.onExit(t, x));
    this.savePids();
  }

  private async makeRoom(): Promise<void> {
    // A parent with children running (a background make, BoardMake) is not idle: closing it would take them down.
    const idle = [...this.threads.values()].filter((t) => !t.turnId && !this.subs.childrenOf(t.id).length).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.threads.size >= this.o.maxProcs && idle.length) await this.close(idle.shift()!);
  }

  private async close(t: Thread): Promise<void> {
    if (this.threads.get(t.id) === t) this.threads.delete(t.id);
    this.savePids();
    await t.proc.close(3000);
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const t of [...this.threads.values()]) if (!t.turnId && !this.subs.childrenOf(t.id).length && now - t.lastUsed > this.o.idleMs) await this.close(t);
  }

  private onExit(t: Thread, x: { code: number | null; signal: string | null }): void {
    // A parent that dies takes its children with it (they are its siblings, not its descendants).
    this.subs.stopAll(t.id, "parent exited", true);
    const mine = this.threads.get(t.id) === t;
    if (mine) this.threads.delete(t.id);
    this.savePids();
    if (!mine || !t.turnId) return;
    t.turnId = null;
    this.stats.crashes++;
    this.log(`pi for ${t.id} exited mid-turn (${x.signal ?? x.code})${t.proc.stderrTail ? `: ${t.proc.stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""}`);
    const now = Date.now();
    const recent = (this.crashLog.get(t.id) ?? []).filter((c) => now - c < 10 * 60_000);
    recent.push(now);
    this.crashLog.set(t.id, recent);
    if (recent.length > 3) {
      // A session that keeps killing pi is not resumed again by itself.
      this.ev({ kind: "turnCompleted", threadId: t.id, turnId: null, status: "failed", error: "pi kept exiting on this conversation (4 times in 10 minutes); send a message to retry" });
      return;
    }
    this.ev({ kind: "threadLost", threadId: t.id });
  }

  private sessionFileOf(id: string): string | null {
    try {
      const hit = readdirSync(this.o.paths.sessionsDir).find((n) => n.endsWith(`_${id}.jsonl`));
      return hit ? join(this.o.paths.sessionsDir, hit) : null;
    } catch {
      return null;
    }
  }

  writeTools(tools: ToolSpec[]): string {
    mkdirSync(this.o.paths.extDir, { recursive: true });
    const json = JSON.stringify(tools);
    const f = join(this.o.paths.extDir, `tools-${Buffer.from(json).length}-${hash(json)}.json`);
    if (!existsSync(f)) writeFileSync(f, json);
    return f;
  }

  // ---------------------------------------------------------------- threads & turns

  async startThread(o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean }): Promise<{ threadId: string; ref?: string }> {
    mkdirSync(this.o.paths.instrDir, { recursive: true });
    const instr = join(this.o.paths.instrDir, `${Date.now().toString(36)}-${++this.seq}.md`);
    writeFileSync(instr, o.instructions);
    const tools = this.writeTools(o.tools);
    const { proc, id, file } = await this.spawn({ cwd: o.cwd, model: o.model, file: null, instr, tools, subagents: o.subagents, you: true });
    // The session's instructions and tools live beside it, so any later pi on it gets the same prompt (cache-stable).
    writeFileSync(join(this.o.paths.instrDir, `${id}.json`), JSON.stringify({ instr, tools, cwd: o.cwd, subagents: o.subagents }));
    this.attach({ id, subagents: o.subagents, file, proc, model: o.model, lastUsed: Date.now(), turnId: null, msgIndex: 0, crashes: [], restoreModel: null });
    return { threadId: id, ref: file };
  }

  /** `cwd`: the thread's working folder now (a project's main folder); a change restarts its pi there (pi reads
   *  context files such as that folder's AGENTS.md when it starts). Not while a turn runs. */
  async resumeThread(threadId: string, o: { model: string; subagents: boolean; cwd?: string }): Promise<void> {
    const have = this.threads.get(threadId);
    let meta: { instr: string; tools: string; cwd: string; subagents?: boolean } | null = null;
    try {
      meta = JSON.parse(readFileSync(join(this.o.paths.instrDir, `${threadId}.json`), "utf8"));
    } catch {
      meta = null;
    }
    const moved = !!meta && !!o.cwd && meta.cwd !== o.cwd;
    if (have?.proc.isAlive() && (!moved || have.turnId)) {
      have.lastUsed = Date.now();
      return;
    }
    if (meta && moved) {
      meta = { ...meta, cwd: o.cwd! };
      writeFileSync(join(this.o.paths.instrDir, `${threadId}.json`), JSON.stringify(meta));
      this.log(`thread ${threadId} now runs in ${o.cwd}`);
    }
    const file = this.sessionFileOf(threadId);
    if (!meta || !file) throw new ThreadUnknownError(`no pi session ${threadId}`);
    // Before any resume, whatever ran this session last is gone (its group, its namespace).
    if (have) {
      have.proc.killGroup("SIGKILL");
      await have.proc.waitExit(5000);
      if (this.threads.get(threadId) === have) this.threads.delete(threadId);
    }
    // The tool set is the session's own (a cache-stable prompt); subagents only if it was started with them.
    const subagents = !!meta.subagents && o.subagents;
    const { proc } = await this.spawn({ cwd: meta.cwd, model: o.model, file, instr: meta.instr, tools: meta.tools, subagents, you: true });
    this.attach({ id: threadId, subagents, file, proc, model: o.model, lastUsed: Date.now(), turnId: null, msgIndex: 0, crashes: [], restoreModel: null });
  }

  /** pi's own compaction of a thread, now (RPC `compact`, with a focus for its summary). Throws when pi refuses. */
  async compact(threadId: string, customInstructions?: string): Promise<{ tokensBefore?: number; summary?: string }> {
    const t = this.live(threadId);
    t.lastUsed = Date.now();
    const r = await t.proc.request({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, 300_000);
    if (!r?.success) throw new Error(String(r?.error ?? "compact rejected"));
    return r.data ?? {};
  }

  /** Has a pi process this session open (only then may nothing else write its file)? */
  holds(threadId: string): boolean {
    return !!this.threads.get(threadId)?.proc.isAlive();
  }

  /** A vault-chat entry (a notice, a line, a divider) appended to the session by pi itself
   *  (the extension's /vc-note command → pi.appendEntry). False: no pi has the session open. */
  async note(threadId: string, data: Record<string, unknown>): Promise<boolean> {
    const t = this.threads.get(threadId);
    if (!t?.proc.isAlive()) return false;
    const r = await t.proc.request({ type: "prompt", message: `/vc-note ${JSON.stringify(data)}` }, 15_000).catch((e) => ({ success: false, error: (e as Error).message }));
    if (!r?.success) {
      this.log(`vc-note on ${threadId} failed: ${String(r?.error ?? "no answer").slice(0, 200)}`);
      return false;
    }
    return true;
  }

  private live(threadId: string): Thread {
    const t = this.threads.get(threadId);
    if (!t || !t.proc.isAlive()) throw new Error(`pi session ${threadId} is not loaded`);
    return t;
  }

  private images(paths: string[]): { type: "image"; data: string; mimeType: string }[] {
    const out: { type: "image"; data: string; mimeType: string }[] = [];
    for (const p of paths) {
      try {
        const data = readFileSync(p).toString("base64");
        const mimeType = /\.jpe?g$/i.test(p) ? "image/jpeg" : /\.webp$/i.test(p) ? "image/webp" : /\.gif$/i.test(p) ? "image/gif" : "image/png";
        out.push({ type: "image", data, mimeType });
      } catch {
        /* missing: skipped */
      }
    }
    return out;
  }

  private async setModel(t: Thread, model: string): Promise<boolean> {
    if (t.model === model) return true;
    const r = await t.proc.request({ type: "set_model", provider: "openrouter", modelId: model }, 30_000).catch(() => null);
    if (r?.success) t.model = model;
    else this.log(`set_model ${model} failed: ${r?.error ?? "no answer"}`);
    return !!r?.success;
  }

  async startTurn(threadId: string, o: { texts: string[]; images: string[]; model: string; turnId?: string; thinking?: string }): Promise<{ turnId: string | null }> {
    const t = this.live(threadId);
    t.lastUsed = Date.now();
    const prev = t.model;
    const switched = o.model !== t.model;
    if (switched && (await this.setModel(t, o.model)) && o.images.length) t.restoreModel = prev;
    // A turn's own thinking level (a voice call's talker), pi's set_thinking_level, back to the default after.
    // After the model: pi clamps a level to what the CURRENT model supports ("off" on a model that can't is "low").
    const want = o.thinking ?? this.o.thinking;
    if (switched || (t.thinking ?? this.o.thinking) !== want) {
      const r = await t.proc.request({ type: "set_thinking_level", level: want }, 10_000).catch(() => null);
      if (r?.success) t.thinking = o.thinking ? want : null;
      else this.log(`set_thinking_level ${want} failed: ${r?.error ?? "no answer"}`);
    }
    const turnId = o.turnId ?? `pt-${Date.now().toString(36)}-${++this.seq}`;
    t.turnId = turnId;
    const imgs = this.images(o.images);
    const r = await t.proc.request({ type: "prompt", message: o.texts.filter(Boolean).join("\n\n"), ...(imgs.length ? { images: imgs } : {}) }, 60_000).catch((e) => ({ success: false, error: (e as Error).message }));
    if (!r?.success) {
      t.turnId = null;
      throw new Error(String(r?.error ?? "prompt rejected"));
    }
    this.ev({ kind: "turnStarted", threadId, turnId });
    return { turnId };
  }

  async steer(threadId: string, _turnId: string, o: { texts: string[]; images: string[] }): Promise<void> {
    const t = this.live(threadId);
    const imgs = this.images(o.images);
    const r = await t.proc.request({ type: "steer", message: o.texts.filter(Boolean).join("\n\n"), ...(imgs.length ? { images: imgs } : {}) }, 30_000);
    if (!r?.success) throw new Error(String(r?.error ?? "steer rejected"));
  }

  /** Queue a message for when the turn's work is done (pi's follow_up). */
  async followUp(threadId: string, o: { texts: string[]; images?: string[] }): Promise<void> {
    const t = this.live(threadId);
    const imgs = this.images(o.images ?? []);
    const r = await t.proc.request({ type: "follow_up", message: o.texts.filter(Boolean).join("\n\n"), ...(imgs.length ? { images: imgs } : {}) }, 30_000);
    if (!r?.success) throw new Error(String(r?.error ?? "follow_up rejected"));
  }

  /** pi's clear_queue: every steering and follow-up message not delivered yet is dropped (their texts are returned). */
  async clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const t = this.live(threadId);
    const r = await t.proc.request({ type: "clear_queue" }, 10_000);
    if (!r?.success) throw new Error(String(r?.error ?? "clear_queue rejected"));
    return { steering: r.data?.steering ?? [], followUp: r.data?.followUp ?? [] };
  }

  async interrupt(threadId: string, _turnId: string): Promise<void> {
    this.subs.stopAll(threadId, "stopped with the parent's turn", false);
    const t = this.threads.get(threadId);
    if (!t?.proc.isAlive()) return;
    try {
      await t.proc.request({ type: "clear_queue" }, 10_000);
      await t.proc.request({ type: "abort" }, 30_000);
    } catch (e) {
      // pi did not abort in time: kill it (its namespace takes the command along); the engine resumes.
      this.log(`abort failed (${(e as Error).message}); killing pi`);
      t.proc.killGroup("SIGKILL");
    }
  }

  forget(threadId: string): void {
    const t = this.threads.get(threadId);
    if (t && !t.turnId) void this.close(t);
  }

  /** OpenRouter's per-call figures, as the extension wrote them into the session (`vc-cost`). */
  usageCalls(ref: string | undefined, turnId?: string | null): CallRecord[] {
    if (!ref) return [];
    let raw = "";
    try {
      raw = readFileSync(ref, "utf8");
    } catch {
      return [];
    }
    const out: CallRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.includes('"vc-cost"')) continue;
      try {
        const v = JSON.parse(line);
        if (v?.type !== "custom" || v.customType !== "vc-cost") continue;
        const d = v.data ?? {};
        const id = typeof d.genId === "string" && d.genId ? d.genId : `pi-entry-${v.id}`;
        const cost = d.cost === null || d.cost === undefined ? null : Number(d.cost);
        // An entry with neither an id nor a cost cannot be priced; the ledger reports it missing.
        out.push({ responseId: id, turnId: String(turnId ?? ""), cost: Number.isFinite(cost as number) ? (cost as number) : null });
      } catch {
        /* partial line */
      }
    }
    return out;
  }

  /** A subagent's model calls (its own session's vc-cost entries), rolled up onto the parent's conversation. */
  childUsageCalls(threadId: string): CallRecord[] {
    return this.usageCalls(this.subs.sessionFileOf(threadId) ?? undefined);
  }

  /** Steer or stop one running subagent (POST /api/v1/conversations/:id/subagents/:sid/{steer,stop}). */
  /** A child that outlives its parent's turn (BoardMake): started now, resolves with its report when it ends. It
   *  is not stopped with the parent's turn, only with the parent's process; it may call BoardSend. */
  background(parentThreadId: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.subs.run(parentThreadId, { ...a, background: true });
  }

  subagentControl(childId: string, op: "steer" | "stop", text?: string): Promise<{ ok: boolean; error?: string }> {
    return this.subs.control(childId, op, text);
  }

  // ---------------------------------------------------------------- pi → neutral events

  ev(e: BackendEvent): void {
    this.emit("event", e);
  }

  private onPiEvent(t: Thread, e: any): void {
    const threadId = t.id;
    // Test instances only: pi's raw events, one file per session (the reducer's recorded fixtures).
    const rec = process.env.VC_PI_RECORD;
    if (rec) {
      try {
        mkdirSync(rec, { recursive: true });
        appendFileSync(join(rec, `${threadId}.jsonl`), JSON.stringify(e) + "\n");
      } catch {
        /* best effort */
      }
    }
    // Every session event goes to the engine as pi sent it.
    if (e?.type !== "agent_settled" && e?.type !== "extension_error") this.ev({ kind: "pi", threadId, ev: e });
    switch (e?.type) {
      case "message_end": {
        const m = e.message ?? {};
        if (m.role !== "assistant") return;
        const u = m.usage ?? {};
        const input = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
        const out = Number(u.output ?? 0);
        this.ev({
          kind: "usage",
          threadId,
          usage: {
            last: { inputTokens: input, cachedInputTokens: Number(u.cacheRead ?? 0), cacheWriteInputTokens: Number(u.cacheWrite ?? 0), outputTokens: out, totalTokens: input + out },
            modelContextWindow: modelWindow(t.model, this.o.catalog),
          },
        });
        t.lastError = m.stopReason === "error" && m.errorMessage ? String(m.errorMessage).slice(0, 500) : null;
        return;
      }
      case "extension_error":
        this.log(`extension error (${e.event}): ${String(e.error ?? "").slice(0, 300)}`);
        return;
      case "agent_settled": {
        const turnId = t.turnId;
        t.turnId = null;
        t.lastUsed = Date.now();
        const err = t.lastError ?? null;
        t.lastError = null;
        if (t.restoreModel) {
          const back = t.restoreModel;
          t.restoreModel = null;
          void this.setModel(t, back);
        }
        return this.ev({ kind: "turnCompleted", threadId, turnId, status: e.aborted ? "interrupted" : err ? "failed" : "completed", error: e.aborted ? null : err });
      }
      default:
        return;
    }
  }

  /** The keys for a command the agent runs (empty without a key store). */
  agentEnv(): Record<string, string> {
    try {
      return this.o.keyEnv?.() ?? {};
    } catch {
      return {};
    }
  }

  /** The "you" layer for a session's prompt (the extension's `__you` host call); empty when the engine can't say. */
  async you(q: { threadId?: string; convId?: string | null; since: number | null }): Promise<{ text: string; until: number }> {
    try {
      return (await this.h?.you?.(q)) ?? { text: "", until: Date.now() };
    } catch (e) {
      this.log(`you layer failed: ${(e as Error).message}`);
      return { text: "", until: Date.now() };
    }
  }

  /** The extension's host calls (vault-chat's tools, AskUser included) and any other dialog. */
  private async onUi(t: Thread, req: any): Promise<void> {
    const reply = (o: Record<string, unknown>) => t.proc.write({ type: "extension_ui_response", id: req.id, ...o });
    if (req.method === "editor" && req.title === "vc:host-call") {
      let call: any = {};
      try {
        call = JSON.parse(String(req.prefill ?? "{}"));
      } catch {
        return reply({ value: JSON.stringify({ text: "bad host call", isError: true }) });
      }
      // The extension's Bash asks for the keys before each command (never shown to the model).
      if (call.tool === "__env") return reply({ value: JSON.stringify({ env: this.agentEnv() }) });
      if (call.tool === "__you") return reply({ value: JSON.stringify(await this.you({ threadId: t.id, since: sinceOf(call.args) })) });
      if (!this.h) return reply({ value: JSON.stringify({ text: "engine not ready", isError: true }) });
      if (call.tool === "__subagent") {
        if (!t.subagents) return reply({ value: JSON.stringify({ ok: false, text: "Subagents are off for this conversation." }) });
        const r = await this.subs.run(t.id, call.args ?? {}).catch((e) => ({ ok: false, text: `subagent failed: ${(e as Error).message}` }));
        return reply({ value: JSON.stringify(r) });
      }
      const r: ToolAnswer = await this.h.toolCall(t.id, String(call.tool ?? ""), call.args ?? {}).catch((e) => ({ ok: false, text: `${call.tool} failed: ${(e as Error).message}` }));
      return reply({ value: JSON.stringify({ text: r.text, ...(r.images?.length ? { images: r.images } : {}), ...(r.ok ? {} : { isError: true }) }) });
    }
    if (req.method === "select" || req.method === "confirm" || req.method === "input" || req.method === "editor") return reply({ cancelled: true });
    // notify / setStatus / …: fire-and-forget.
  }
}

/** The `since` of a `__you` host call (a number, or null for a session that has seen no layer). */
export function sinceOf(args: any): number | null {
  const n = Number(args?.since);
  return args?.since != null && Number.isFinite(n) ? n : null;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
