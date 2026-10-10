// EngineBackend on pi 1.1.0 (RPC mode). A thread is a pi session (thread id =
// pi's session id, ref = its session file); each thread with work in hand has
// its own pi process (proc.ts: own process group, bubblewrap pid namespace,
// key on fd 3). vault-chat's tools reach the engine through the extension
// (ext/vc.mjs) as blocking host calls on the extension-UI channel; the cost of
// every model call is OpenRouter's own figure, which the extension writes into
// the session as `vc-cost` entries (usageCalls reads them back).
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendEvent, EngineBackend, ToolCallHandler, ToolSpec, UserInputHandler } from "../backend";
import { ThreadUnknownError } from "../backend";
import type { CallRecord } from "../ledger";
import { PiProc } from "./proc";
import { modelWindow, type PiCatalogRow, type PiPaths } from "./config";
import type { PiInstall } from "./install";

export type PiSandbox = {
  /** bubblewrap argv for pi itself (ends with "--"), or null (no sandbox). */
  outer: string[] | null;
  /** bubblewrap argv for each shell command (ends with "--"), or null. */
  shell: string[] | null;
  /** Paths pi's in-process tools may not read or write / may not write. */
  denyRead: string[];
  denyWrite: string[];
};

export type PiBackendOptions = {
  install: PiInstall;
  paths: PiPaths;
  catalog: Map<string, PiCatalogRow>;
  sandbox: PiSandbox;
  apiKey: () => string | null;
  thinking: string;
  idleMs: number;
  maxProcs: number;
  log?: (s: string) => void;
};

/** pi's tool names → the names the renderers already know. */
const TOOL_NAMES: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", ls: "LS" };
const RESULT_CAP = 4_000;
const cap = (s: string, n = RESULT_CAP) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);

type Thread = {
  id: string;
  file: string;
  proc: PiProc;
  model: string;
  lastUsed: number;
  turnId: string | null;
  msgIndex: number;
  crashes: number[];
  /** A model set for one turn only (images on a model that can't see). */
  restoreModel: string | null;
};

export class PiBackend extends EventEmitter implements EngineBackend {
  readonly name = "pi";
  readonly version: string;
  private threads = new Map<string, Thread>();
  private h: { toolCall: ToolCallHandler; userInput: UserInputHandler } | null = null;
  private seq = 0;
  private stats = { spawns: 0, crashes: 0 };
  private crashLog = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;
  private lastPid: number | null = null;

  constructor(private o: PiBackendOptions) {
    super();
    this.setMaxListeners(50);
    this.version = o.install.version;
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

  async ready(): Promise<boolean> {
    return true;
  }

  health(): Record<string, unknown> {
    const procs = [...this.threads.values()].map((t) => ({ threadId: t.id, pid: t.proc.pid, model: t.model, busy: !!t.turnId, sinceMs: Date.now() - t.proc.startedAt }));
    return { state: "up", version: this.version, sandbox: !!this.o.sandbox.outer, pid: this.lastPid, procs, ...this.stats };
  }

  setHandlers(h: { toolCall: ToolCallHandler; userInput: UserInputHandler }): void {
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

  private piEnv(toolsFile: string): NodeJS.ProcessEnv {
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
      VC_PI_DENY_READ: JSON.stringify(this.o.sandbox.denyRead),
      VC_PI_DENY_WRITE: JSON.stringify(this.o.sandbox.denyWrite),
      ...(this.o.sandbox.shell ? { VC_PI_SHELL_WRAP: JSON.stringify(this.o.sandbox.shell) } : {}),
      ...(process.env.VC_PI_SHELL_TIMEOUT_S ? { VC_PI_SHELL_TIMEOUT_S: process.env.VC_PI_SHELL_TIMEOUT_S } : {}),
      ...(process.env.VC_PI_GEMINI_CACHE ? { VC_PI_GEMINI_CACHE: process.env.VC_PI_GEMINI_CACHE } : {}),
      ...(process.env.VC_PI_CACHE_RETENTION ? { PI_CACHE_RETENTION: process.env.VC_PI_CACHE_RETENTION } : {}),
    });
  }

  /** Spawn pi on a session (new when `file` is null) and wait for it to answer. */
  private async spawn(o: { cwd: string; model: string; file: string | null; instr: string; tools: string }): Promise<{ proc: PiProc; id: string; file: string }> {
    await this.makeRoom();
    const args = [
      this.o.install.cli,
      "--mode", "rpc",
      "--session-dir", this.o.paths.sessionsDir,
      "--model", `openrouter/${o.model}`,
      "--thinking", this.o.thinking,
      "-ne", "--no-mcp", "-ns", "-np", "--no-themes", "-na", "--offline",
      "-e", this.o.paths.ext,
      "--append-system-prompt", o.instr,
      ...(o.file ? ["--session", o.file] : []),
    ];
    const argv = this.o.sandbox.outer ? [...this.o.sandbox.outer, this.o.install.node, ...args] : [this.o.install.node, ...args];
    const proc = new PiProc({ argv, cwd: o.cwd, env: this.piEnv(o.tools), key: this.o.apiKey() });
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
    if (!id || !file) {
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
    const idle = [...this.threads.values()].filter((t) => !t.turnId).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.threads.size >= this.o.maxProcs && idle.length) await this.close(idle.shift()!);
  }

  private async close(t: Thread): Promise<void> {
    if (this.threads.get(t.id) === t) this.threads.delete(t.id);
    this.savePids();
    await t.proc.close(3000);
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const t of [...this.threads.values()]) if (!t.turnId && now - t.lastUsed > this.o.idleMs) await this.close(t);
  }

  private onExit(t: Thread, x: { code: number | null; signal: string | null }): void {
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

  private writeTools(tools: ToolSpec[]): string {
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
    const { proc, id, file } = await this.spawn({ cwd: o.cwd, model: o.model, file: null, instr, tools });
    // The session's instructions and tools live beside it, so any later pi on it gets the same prompt (cache-stable).
    writeFileSync(join(this.o.paths.instrDir, `${id}.json`), JSON.stringify({ instr, tools, cwd: o.cwd }));
    this.attach({ id, file, proc, model: o.model, lastUsed: Date.now(), turnId: null, msgIndex: 0, crashes: [], restoreModel: null });
    return { threadId: id, ref: file };
  }

  async resumeThread(threadId: string, o: { model: string; subagents: boolean }): Promise<void> {
    const have = this.threads.get(threadId);
    if (have?.proc.isAlive()) {
      have.lastUsed = Date.now();
      return;
    }
    let meta: { instr: string; tools: string; cwd: string } | null = null;
    try {
      meta = JSON.parse(readFileSync(join(this.o.paths.instrDir, `${threadId}.json`), "utf8"));
    } catch {
      meta = null;
    }
    const file = this.sessionFileOf(threadId);
    if (!meta || !file) throw new ThreadUnknownError(`no pi session ${threadId}`);
    // Before any resume, whatever ran this session last is gone (its group, its namespace).
    if (have) {
      have.proc.killGroup("SIGKILL");
      await have.proc.waitExit(5000);
      if (this.threads.get(threadId) === have) this.threads.delete(threadId);
    }
    const { proc } = await this.spawn({ cwd: meta.cwd, model: o.model, file, instr: meta.instr, tools: meta.tools });
    this.attach({ id: threadId, file, proc, model: o.model, lastUsed: Date.now(), turnId: null, msgIndex: 0, crashes: [], restoreModel: null });
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

  async startTurn(threadId: string, o: { texts: string[]; images: string[]; model: string }): Promise<{ turnId: string | null }> {
    const t = this.live(threadId);
    t.lastUsed = Date.now();
    const prev = t.model;
    if (o.model !== t.model && (await this.setModel(t, o.model)) && o.images.length) t.restoreModel = prev;
    const turnId = `pt-${Date.now().toString(36)}-${++this.seq}`;
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
  async followUp(threadId: string, o: { texts: string[] }): Promise<void> {
    const t = this.live(threadId);
    const r = await t.proc.request({ type: "follow_up", message: o.texts.filter(Boolean).join("\n\n") }, 30_000);
    if (!r?.success) throw new Error(String(r?.error ?? "follow_up rejected"));
  }

  async interrupt(threadId: string, _turnId: string): Promise<void> {
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

  childUsageCalls(): CallRecord[] {
    return []; // no subagents on pi (yet)
  }

  // ---------------------------------------------------------------- pi → neutral events

  private ev(e: BackendEvent): void {
    this.emit("event", e);
  }

  private onPiEvent(t: Thread, e: any): void {
    const threadId = t.id;
    const turn = t.turnId ?? "x";
    switch (e?.type) {
      case "message_start":
        if (e.message?.role === "assistant") t.msgIndex++;
        return;
      case "message_update": {
        const ev = e.assistantMessageEvent ?? {};
        const itemId = `${turn}:${t.msgIndex}:${ev.contentIndex ?? 0}`;
        if (ev.type === "text_delta") this.ev({ kind: "textDelta", threadId, itemId, delta: String(ev.delta ?? "") });
        else if (ev.type === "text_end" && typeof ev.content === "string") this.ev({ kind: "text", threadId, itemId, text: ev.content });
        else if (ev.type === "thinking_end" && typeof ev.content === "string" && ev.content.trim()) this.ev({ kind: "reasoning", threadId, text: ev.content.trim() });
        return;
      }
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
        (Array.isArray(m.content) ? m.content : []).forEach((c: any, i: number) => {
          if (c?.type === "text" && typeof c.text === "string") this.ev({ kind: "text", threadId, itemId: `${turn}:${t.msgIndex}:${i}`, text: c.text });
        });
        (t as any).lastError = m.stopReason === "error" && m.errorMessage ? String(m.errorMessage).slice(0, 500) : null;
        return;
      }
      case "tool_execution_start":
        return this.ev({ kind: "tool", threadId, itemId: String(e.toolCallId), name: TOOL_NAMES[e.toolName] ?? String(e.toolName ?? "tool"), input: e.args ?? {} });
      case "tool_execution_end": {
        const txt = (e.result?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
        return this.ev({ kind: "tool", threadId, itemId: String(e.toolCallId), name: TOOL_NAMES[e.toolName] ?? String(e.toolName ?? "tool"), input: undefined, result: cap(`${e.isError ? "[error] " : ""}${txt}`) });
      }
      case "compaction_end":
        if (e.result) this.ev({ kind: "tool", threadId, itemId: `compaction-${Date.now()}`, name: "Compaction", input: { reason: e.reason }, result: "context compacted" });
        return;
      case "extension_error":
        this.log(`extension error (${e.event}): ${String(e.error ?? "").slice(0, 300)}`);
        return;
      case "agent_settled": {
        const turnId = t.turnId;
        t.turnId = null;
        t.lastUsed = Date.now();
        const err = (t as any).lastError as string | null;
        (t as any).lastError = null;
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
      if (!this.h) return reply({ value: JSON.stringify({ text: "engine not ready", isError: true }) });
      const r = await this.h.toolCall(t.id, String(call.tool ?? ""), call.args ?? {}).catch((e) => ({ ok: false, text: `${call.tool} failed: ${(e as Error).message}` }));
      return reply({ value: JSON.stringify({ text: r.text, ...(r.ok ? {} : { isError: true }) }) });
    }
    if (req.method === "select" || req.method === "confirm" || req.method === "input" || req.method === "editor") return reply({ cancelled: true });
    // notify / setStatus / …: fire-and-forget.
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
