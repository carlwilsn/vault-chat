// The pi engine: every agent turn on the box runs in pi (RPC mode), one pi
// process per active conversation, each with its own session file. Same
// contract as the Codex engine (server/engine/engine.ts): the phone API, the
// conversation files, wakes.json, the /poll events, the keep-going rule, the
// watchdog and resume after a restart. vault-chat's tools come in through
// the extension (ext/vc.mjs) as blocking host calls.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../../../src/store";
import { registerRun, unregisterRun } from "../../../src/runRegistry";
import {
  contextToolSpecs,
  handleContextTool,
  isContextTool,
  buildDeveloperInstructions,
  rulesPrefixForTurn,
  shouldRoll,
  buildRecap,
  verifyDone,
  formatVerdict,
  projectCost,
  type EngineConv,
  type ThreadTokenUsage,
} from "../context";
import { appendMessage, patchMeta, readConv, allConvs, createConv, mutateConv, setLive, setRuntime, newMessageId } from "../convs";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "../wakes";
import { pdfRead, webSearch } from "../extraTools";
import { ENGINE_ROLE_PROMPT } from "../prompt";
import { ENGINE_TOOL_SPECS } from "../engine";
import { PiProc } from "./proc";
import type { PiPaths, PiCatalogRow } from "./config";
import { modelWindow } from "./config";
import type { PiInstall } from "./install";
import { PiLedger } from "./ledger";
import { startJob, jobStatus, type PiJobEnv } from "./jobs";
import type { AgentEngine } from "../types";

export type PiSandbox = {
  /** Outer bubblewrap argv for pi itself (ends with "--"), or null (no sandbox). */
  outer: string[] | null;
  /** Inner bubblewrap argv for each shell command (ends with "--"), or null. */
  shell: string[] | null;
  denyRead: string[];
  denyWrite: string[];
};

export type PiEngineDeps = {
  vault: string;
  install: PiInstall;
  paths: PiPaths;
  catalog: Map<string, PiCatalogRow>;
  sandbox: PiSandbox;
  ledger: PiLedger;
  jobEnv: PiJobEnv;
  model: () => string;
  thinking?: string;
  webSearchModel: string;
  visionModel?: string;
  apiKey: () => string | null;
  notify: (n: { kind: "info" | "ask"; title: string; body: string; convId: string; options?: string[] }) => Promise<string | null>;
  broadcast?: (ev: Record<string, unknown>) => void;
  log?: (s: string) => void;
  stallMs?: number;
  idleMs?: number;
  askParkMs?: number;
  maxProcs?: number;
};

type ToolRec = { id?: string; name: string; input: any; result?: string };
type TurnKind = "user" | "wake" | "nudge" | "resume";
type Cost = { genId: string | null; cost: number | null };

type Live = {
  convId: string;
  slot: Slot;
  kind: TurnKind;
  startedAt: number;
  lastEventAt: number;
  order: string[];
  texts: Map<string, string>;
  msgIndex: number;
  tools: ToolRec[];
  toolIndex: Map<string, number>;
  reasoning: string[];
  usage: ThreadTokenUsage | null;
  costs: Cost[];
  flags: { wake: boolean; done: boolean; blocked: boolean };
  ask: { resolve: (answer: string) => void; question: string; since: number } | null;
  error: string | null;
  cut: boolean;
  stalled: boolean;
  stopped: boolean;
  controller: AbortController;
  finished: boolean;
  /** Model switched for this turn only (images on a model that can't see). */
  restoreModel: string | null;
};

type Slot = {
  convId: string;
  proc: PiProc;
  model: string;
  sessionFile: string | null;
  lastUsed: number;
  live: Live | null;
};

type TurnOpts = { alreadyAppended?: boolean; images?: { data: string; mimeType: string }[]; context?: string; attachments?: any[] };

const MSG_CAP = 20_000;
const RESULT_CAP = 4_000;
const NUDGE_TEXT = "You're in keep-going mode: schedule your next check (ScheduleWake), or say Done or Blocked.";
const RESUME_TEXT =
  "The box restarted (or the engine stopped) while your last turn was running, so any command it was running was killed and may not have finished. Re-check reality (files, processes, logs), then continue from where you were.";
const LEGACY_SOURCES = new Set(["mission", "worker", "ask"]);
const CUT_NOTE = "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.";

/** pi's tool names → the names the renderers already know. */
const TOOL_NAMES: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", ls: "LS" };

/** What the extension registers (tools.json): vault-chat's tools minus Codex-only ones, plus CONTEXT's. */
export function piToolSpecs(): unknown[] {
  return [...ENGINE_TOOL_SPECS, ...contextToolSpecs];
}

export class PiEngine implements AgentEngine {
  private slots = new Map<string, Slot>();
  private chains = new Map<string, Promise<unknown>>();
  private nudged = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private firing = new Set<string>();
  private crashes = new Map<string, number[]>();
  private lastMid = new Map<string, string>();
  private stats = { spawns: 0, crashes: 0, resumes: 0 };

  constructor(private d: PiEngineDeps) {}

  private log(s: string): void {
    (this.d.log ?? ((m) => console.log(`[engine:pi] ${m}`)))(s);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.killStale();
    this.timers.push(setInterval(() => void this.tickWakes(), 2_000));
    this.timers.push(setInterval(() => this.tickWatchdog(), 15_000));
    this.timers.push(setInterval(() => void this.reapIdle(), 30_000));
    // Turns cut by a crash or restart of the whole server: the file still says
    // running. Mark them, then resume them (a fresh pi on the same session).
    for (const c of await allConvs(this.d.vault).catch(() => [])) {
      if (c.state === "running" && (c.piSessionFile || c.codexThreadId) && !LEGACY_SOURCES.has(c.source)) {
        await appendMessage(this.d.vault, c.id, { role: "assistant", content: CUT_NOTE, failed: true });
        this.stats.resumes++;
        void this.run(c.id, RESUME_TEXT, "resume").catch((e) => this.log(`resume ${c.id} failed: ${e}`));
      }
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await Promise.all([...this.slots.values()].map((s) => s.proc.close(1000)));
  }

  health(): Record<string, unknown> {
    return {
      kind: "pi",
      pi: {
        state: "up",
        version: this.d.install.version,
        sandbox: !!this.d.sandbox.outer,
        procs: [...this.slots.values()].map((s) => ({ convId: s.convId, pid: s.proc.pid, model: s.model, sinceMs: Date.now() - s.proc.startedAt })),
        ...this.stats,
      },
      liveTurns: [...this.slots.values()].filter((s) => s.live).map((s) => ({ convId: s.convId, kind: s.live!.kind, waitingUser: !!s.live!.ask, sinceMs: Date.now() - s.live!.startedAt })),
      wakes: readWakes(this.d.vault).length,
    };
  }

  isRunning(convId: string): boolean {
    const l = this.slots.get(convId)?.live;
    return !!l && !l.ask && !l.finished;
  }

  private liveOf(convId: string): Live | undefined {
    const l = this.slots.get(convId)?.live;
    return l && !l.finished ? l : undefined;
  }

  // ---------------------------------------------------------------- pi processes

  /** Kill pi process groups a previous server left behind (pids.json). */
  private killStale(): void {
    let pids: { pid: number }[] = [];
    try {
      pids = JSON.parse(readFileSync(this.d.paths.pidsFile, "utf8"));
    } catch {
      pids = [];
    }
    for (const { pid } of pids) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue; // gone (or not Linux)
      }
      if (!cmd.includes(this.d.install.cli)) continue; // pid reused by something else
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* group gone */
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
      this.log(`killed a stale pi (pid ${pid}) left by a previous run`);
    }
    this.savePids();
  }

  private savePids(): void {
    try {
      mkdirSync(this.d.paths.root, { recursive: true });
      writeFileSync(this.d.paths.pidsFile, JSON.stringify([...this.slots.values()].map((s) => ({ conv: s.convId, pid: s.proc.pid }))));
    } catch {
      /* best effort */
    }
  }

  private instrFile(conv: EngineConv): string {
    const n = conv.messages.filter((m: any) => m.rollover).length;
    return join(this.d.paths.instrDir, `${conv.id}-${n}.md`);
  }

  private piEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/OPENROUTER|API_KEY|APIKEY|SECRET|PASSW|_TOKEN$|^VC_|^PI_/i.test(k)) continue;
      env[k] = v;
    }
    Object.assign(env, {
      PI_CODING_AGENT_DIR: this.d.paths.agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      VC_KEY_FD: "3",
      VC_PI_TOOLS: this.d.paths.toolsJson,
      VC_PI_DENY_READ: JSON.stringify(this.d.sandbox.denyRead),
      VC_PI_DENY_WRITE: JSON.stringify(this.d.sandbox.denyWrite),
      ...(this.d.sandbox.shell ? { VC_PI_SHELL_WRAP: JSON.stringify(this.d.sandbox.shell) } : {}),
      ...(process.env.VC_PI_SHELL_TIMEOUT_S ? { VC_PI_SHELL_TIMEOUT_S: process.env.VC_PI_SHELL_TIMEOUT_S } : {}),
      ...(process.env.VC_PI_GEMINI_CACHE ? { VC_PI_GEMINI_CACHE: process.env.VC_PI_GEMINI_CACHE } : {}),
      ...(process.env.VC_PI_CACHE_RETENTION ? { PI_CACHE_RETENTION: process.env.VC_PI_CACHE_RETENTION } : {}),
    });
    return env;
  }

  /** The conversation's pi, started (or resumed on its session) when needed. */
  private async ensureSlot(conv: EngineConv): Promise<Slot> {
    const model = this.d.model();
    const have = this.slots.get(conv.id);
    if (have && have.proc.isAlive()) {
      have.lastUsed = Date.now();
      if (have.model !== model) {
        const r = await have.proc.request({ type: "set_model", provider: "openrouter", modelId: model }, 30_000).catch((e) => ({ success: false, error: String(e) }));
        if (r?.success) have.model = model;
        else this.log(`set_model ${model} failed: ${r?.error}`);
      }
      return have;
    }
    // Before any (re)start on a session: whatever the last pi of this
    // conversation started must be gone (its group, its namespace).
    if (have) {
      have.proc.killGroup("SIGKILL");
      await have.proc.waitExit(5000);
      this.slots.delete(conv.id);
    }
    await this.makeRoom();
    const instr = this.instrFile(conv);
    if (!existsSync(instr)) {
      mkdirSync(this.d.paths.instrDir, { recursive: true });
      writeFileSync(instr, buildDeveloperInstructions(conv as any, { rolePrompt: ENGINE_ROLE_PROMPT }));
    }
    const session = conv.piSessionFile && existsSync(conv.piSessionFile) ? conv.piSessionFile : null;
    const piArgs = [
      this.d.install.cli,
      "--mode", "rpc",
      "--session-dir", this.d.paths.sessionsDir,
      "--model", `openrouter/${model}`,
      "--thinking", this.d.thinking ?? "medium",
      "-ne", "--no-mcp", "-ns", "-np", "--no-themes", "-na", "--offline",
      "-e", this.d.paths.ext,
      "--append-system-prompt", instr,
      ...(session ? ["--session", session] : []),
    ];
    const argv = this.d.sandbox.outer ? [...this.d.sandbox.outer, this.d.install.node, ...piArgs] : [this.d.install.node, ...piArgs];
    const proc = new PiProc({ argv, cwd: this.d.vault, env: this.piEnv(), key: this.d.apiKey(), log: (s) => this.log(s) });
    const slot: Slot = { convId: conv.id, proc, model, sessionFile: session, lastUsed: Date.now(), live: null };
    proc.on("event", (e: any) => this.onEvent(slot, e));
    proc.on("ui", (r: any) => void this.onUi(slot, r));
    proc.on("exit", (x: any) => void this.onExit(slot, x));
    proc.start();
    this.stats.spawns++;
    this.slots.set(conv.id, slot);
    this.savePids();
    let st: any;
    try {
      st = await proc.request({ type: "get_state" }, 60_000);
    } catch (e) {
      throw new Error(`pi did not start: ${(e as Error).message}${proc.stderrTail ? ` — ${proc.stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}` : ""}`);
    }
    const file = st?.data?.sessionFile;
    if (typeof file === "string" && file && file !== conv.piSessionFile) {
      slot.sessionFile = file;
      await patchMeta(this.d.vault, conv.id, { piSessionFile: file });
      conv.piSessionFile = file;
    }
    return slot;
  }

  /** At most maxProcs pi processes: close the least recently used idle ones. */
  private async makeRoom(): Promise<void> {
    const max = this.d.maxProcs ?? 6;
    const idle = [...this.slots.values()].filter((s) => !s.live).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.slots.size >= max && idle.length) await this.closeSlot(idle.shift()!);
  }

  private async closeSlot(s: Slot): Promise<void> {
    if (this.slots.get(s.convId) === s) this.slots.delete(s.convId);
    this.savePids();
    await s.proc.close(3000);
  }

  private async reapIdle(): Promise<void> {
    const idleMs = this.d.idleMs ?? 10 * 60_000;
    const parkMs = this.d.askParkMs ?? 30 * 60_000;
    const now = Date.now();
    for (const s of [...this.slots.values()]) {
      if (!s.live && now - s.lastUsed > idleMs) await this.closeSlot(s);
      else if (s.live?.ask && now - s.live.ask.since > parkMs) {
        // A question nobody has answered for a while: free the process. The
        // question stays on the conversation; the answer starts a new turn.
        const l = s.live;
        l.finished = true;
        s.live = null;
        unregisterRun(l.convId, l.controller);
        this.log(`parked question on ${s.convId} — closing its pi until Carl answers`);
        await this.closeSlot(s);
      }
    }
  }

  private async onExit(slot: Slot, x: { code: number | null; signal: string | null }): Promise<void> {
    if (this.slots.get(slot.convId) === slot) this.slots.delete(slot.convId);
    this.savePids();
    const l = slot.live;
    if (!l || l.finished) return;
    this.log(`pi for ${slot.convId} exited mid-turn (${x.signal ?? x.code})${slot.proc.stderrTail ? `: ${slot.proc.stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""}`);
    if (l.ask) {
      // Parked on a question: the question is persisted; the answer starts a new turn.
      l.finished = true;
      slot.live = null;
      unregisterRun(l.convId, l.controller);
      setLive(l.convId, false);
      return;
    }
    this.stats.crashes++;
    l.cut = true;
    await this.finishTurn(l, "interrupted");
    // Resume, unless this conversation keeps crashing pi.
    const now = Date.now();
    const recent = (this.crashes.get(l.convId) ?? []).filter((t) => now - t < 10 * 60_000);
    recent.push(now);
    this.crashes.set(l.convId, recent);
    if (recent.length > 3) {
      await patchMeta(this.d.vault, l.convId, { state: "idle" });
      await appendMessage(this.d.vault, l.convId, { role: "assistant", content: "⚠️ pi kept exiting on this conversation (4 times in 10 minutes); not resuming it again. Send a message to retry.", failed: true });
      return;
    }
    this.stats.resumes++;
    setTimeout(() => void this.run(l.convId, RESUME_TEXT, "resume").catch((e) => this.log(`resume ${l.convId} failed: ${e}`)), 1000 * recent.length);
  }

  // ---------------------------------------------------------------- inbound

  /**
   * /message {text, convId?, project?, context?, images?, imagePaths?, clientMsgId?, followUp?} → {ok, convId}.
   * Same payload as the Codex engine. A message while a turn runs steers it
   * (pi delivers it before its next model call); `followUp: true` queues it
   * until the turn's work is done instead.
   */
  async message(body: {
    convId?: string | null;
    text?: string;
    project?: string;
    context?: string;
    images?: { name?: string; mime?: string; dataBase64?: string }[];
    imagePaths?: string[];
    followUp?: boolean;
  }): Promise<Record<string, unknown> | null> {
    const textIn = String(body?.text ?? "").trim();
    const hasImages = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0) > 0;
    if (!textIn && !hasImages) return { error: "empty message" };
    let conv: EngineConv | null = null;
    if (body.convId) {
      conv = await readConv(this.d.vault, body.convId);
      if (!conv) return { error: `conversation ${body.convId} not found` };
      if (LEGACY_SOURCES.has(conv.source)) return null;
    } else {
      conv = await createConv(this.d.vault, {}, textIn || "Image");
      // Let the phone host's store diff see the new (empty) conversation first.
      await new Promise((r) => setTimeout(r, 400));
    }
    const id = conv.id;
    if (typeof body.project === "string" && body.project.trim()) {
      try {
        const { ensureProject } = await import("../../context");
        const { project } = ensureProject(body.project.trim());
        await patchMeta(this.d.vault, id, { project: project.slug });
      } catch (e) {
        this.log(`project ${body.project}: ${(e as Error).message}`);
      }
    }
    const { images, attachments } = this.saveImages(id, body);
    const context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    const shown = textIn || "(image)";
    this.nudged.delete(id);
    if (this.liveOf(id)?.ask || conv.pendingAsk) {
      await this.answer(id, shown);
      return { ok: true, convId: id, answered: true };
    }
    const l = this.liveOf(id);
    if (l) {
      await appendMessage(this.d.vault, id, { role: "user", content: shown, direct: true, ...(attachments.length ? { attachments } : {}) });
      const type = body.followUp ? "follow_up" : "steer";
      const r = await l.slot.proc
        .request({ type, message: context ? `${context}\n\n${shown}` : shown, ...(images.length ? { images } : {}) }, 30_000)
        .catch((e) => ({ success: false, error: String((e as Error).message) }));
      if (r?.success) return { ok: true, convId: id, ...(type === "steer" ? { steered: true } : { queued: true }) };
      this.log(`${type} failed (${r?.error}); starting a new turn`);
      void this.run(id, shown, "user", { alreadyAppended: true, images, context });
      return { ok: true, convId: id };
    }
    void this.run(id, shown, "user", { images, context, attachments }).catch((e) => this.log(`turn failed: ${e}`));
    return { ok: true, convId: id };
  }

  /** Images → .vault-chat/captures (shown as attachments) and pi's ImageContent. */
  private saveImages(convId: string, body: { images?: { name?: string; mime?: string; dataBase64?: string }[]; imagePaths?: string[] }): { images: { type: "image"; data: string; mimeType: string }[]; attachments: any[] } {
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    const attachments: any[] = [];
    const dir = join(this.d.vault, ".vault-chat", "captures");
    (body.images ?? []).slice(0, 8).forEach((img, i) => {
      const b64 = String(img?.dataBase64 ?? "").replace(/^data:[^,]*,/, "");
      if (!b64) return;
      const buf = Buffer.from(b64, "base64");
      if (!buf.length || buf.length > 15 * 1024 * 1024) return;
      const mime = String(img?.mime ?? "image/png");
      const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".png";
      const rel = `.vault-chat/captures/${new Date().toISOString().replace(/[:.]/g, "-")}-${convId.slice(0, 8)}-${i}${ext}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(this.d.vault, rel), buf);
      images.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
      attachments.push({ imageDataUrl: buf.length < 400_000 ? `data:${mime};base64,${b64}` : "", capturedFilePath: rel });
    });
    for (const p of (body.imagePaths ?? []).slice(0, 8)) {
      const rel = String(p).replace(/^[\\/]+/, "");
      if (!rel || rel.includes("..")) continue;
      try {
        const buf = readFileSync(join(this.d.vault, rel));
        const mime = /\.jpe?g$/i.test(rel) ? "image/jpeg" : /\.webp$/i.test(rel) ? "image/webp" : /\.gif$/i.test(rel) ? "image/gif" : "image/png";
        images.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
        attachments.push({ imageDataUrl: "", capturedFilePath: rel, sourcePath: rel });
      } catch {
        /* missing file: skipped */
      }
    }
    return { images, attachments };
  }

  async answerRoute(body: { convId?: string; text?: string; defer?: boolean }): Promise<Record<string, unknown> | null> {
    const id = String(body?.convId ?? "");
    if (!id) return null;
    const conv = await readConv(this.d.vault, id);
    if (!conv || LEGACY_SOURCES.has(conv.source)) return null;
    const t = body.defer
      ? "Not now — I'm not picking an option. Take the default you named if there is a safe one; otherwise hold, and don't do anything irreversible or that spends money."
      : String(body?.text ?? "").trim();
    if (!t) return { error: "answer needs a convId and non-empty text" };
    if (!this.liveOf(id)?.ask && !conv.pendingAsk) return (await this.message({ convId: id, text: t })) ?? { ok: true, convId: id };
    await this.answer(id, t);
    return { ok: true, convId: id, answered: true };
  }

  /** /kill: interrupt, keep-going off, wakes cancelled. */
  async kill(body: { convId?: string | null }): Promise<Record<string, unknown> | null> {
    const id = body?.convId ? String(body.convId) : "";
    if (!id) {
      let n = 0;
      for (const s of [...this.slots.values()]) if (s.live && (await this.interrupt(s.convId, true))) n++;
      return n ? { ok: true, result: `Stopped ${n} run(s).` } : null;
    }
    const conv = await readConv(this.d.vault, id);
    if (!conv || LEGACY_SOURCES.has(conv.source)) return null;
    const hit = await this.interrupt(id, true);
    return { ok: true, result: hit ? "Stopped — interrupting now (an in-flight command is killed)." : "Nothing running on that thread." };
  }

  async interrupt(convId: string, byUser: boolean): Promise<boolean> {
    if (byUser) {
      removeWakes(this.d.vault, (w) => w.conv === convId);
      await patchMeta(this.d.vault, convId, { working: false, nextWakeAt: undefined });
    }
    const l = this.liveOf(convId);
    if (!l) return false;
    l.stopped = byUser || l.stopped;
    if (l.ask) {
      const a = l.ask;
      l.ask = null;
      await patchMeta(this.d.vault, convId, { pendingAsk: undefined });
      a.resolve("Carl stopped this turn instead of answering. End the turn now; do nothing else.");
    }
    try {
      await l.slot.proc.request({ type: "clear_queue" }, 10_000);
      await l.slot.proc.request({ type: "abort" }, 30_000);
    } catch (e) {
      this.log(`abort failed (${(e as Error).message}); killing pi`);
      l.slot.proc.killGroup("SIGKILL");
    }
    return true;
  }

  // ---------------------------------------------------------------- turns

  private serial<T>(convId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(convId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(convId, next.catch(() => undefined));
    return next;
  }

  /** Start a turn; if one is running, a user message steers it and anything else follows up. */
  run(convId: string, input: string, kind: TurnKind, opts: TurnOpts = {}): Promise<void> {
    return this.serial(convId, async () => {
      const existing = this.liveOf(convId);
      if (existing) {
        if (kind !== "user" && !opts.alreadyAppended) {
          await appendMessage(this.d.vault, convId, { role: "user", content: kind === "wake" ? `⏰ ${input}` : `↻ ${input}`, system: true });
        }
        if (!existing.ask) {
          await existing.slot.proc
            .request({ type: kind === "user" ? "steer" : "follow_up", message: input, ...(opts.images?.length ? { images: opts.images } : {}) }, 30_000)
            .catch(() => undefined);
        }
        return;
      }
      let conv = await readConv(this.d.vault, convId);
      if (!conv) throw new Error(`conversation ${convId} not found`);
      if (!opts.alreadyAppended) {
        const visible: ChatMessage =
          kind === "user"
            ? { role: "user", content: input, direct: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }
            : { role: "user", content: kind === "wake" ? `⏰ ${input}` : `↻ ${input}`, system: true };
        conv = (await appendMessage(this.d.vault, convId, visible)) ?? conv;
      }
      if (!existsSync(this.d.vault) || !statSync(this.d.vault).isDirectory()) {
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The vault ${this.d.vault} is missing on the box; no turn was run.`, failed: true });
        return;
      }
      const fresh = !(conv.piSessionFile && existsSync(conv.piSessionFile));
      let slot: Slot;
      try {
        slot = await this.ensureSlot(conv);
      } catch (e) {
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The engine could not start pi for this conversation: ${(e as Error).message}`, failed: true }, { state: "idle" });
        throw e;
      }
      const live: Live = {
        convId,
        slot,
        kind,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        order: [],
        texts: new Map(),
        msgIndex: 0,
        tools: [],
        toolIndex: new Map(),
        reasoning: [],
        usage: null,
        costs: [],
        flags: { wake: false, done: false, blocked: false },
        ask: null,
        error: null,
        cut: false,
        stalled: false,
        stopped: false,
        controller: new AbortController(),
        finished: false,
        restoreModel: null,
      };
      live.controller.signal.addEventListener("abort", () => void this.interrupt(convId, true));
      slot.live = live;
      slot.lastUsed = Date.now();
      registerRun(convId, live.controller);
      setLive(convId, true);
      await patchMeta(this.d.vault, convId, { state: "running" });
      // History from before pi (a legacy or Codex chat): handed over once, on the first session.
      let body = input;
      if (fresh && !conv.messages.some((m: any) => m.rollover)) {
        const old = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim()).slice(0, -1);
        if (old.length) {
          const t = old.slice(-30).map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1500)}`).join("\n");
          body = `<earlier_conversation>\n${t.slice(-12_000)}\n</earlier_conversation>\n\n${input}`;
        }
      }
      if (opts.context) body = `${opts.context}\n\n${body}`;
      const rules = rulesPrefixForTurn(conv as any);
      const message = `${rules}${kind === "wake" ? input : body}`;
      // Images on a model that can't see: this turn uses the vision model.
      if (opts.images?.length && this.d.visionModel && !this.canSee(slot.model)) {
        const r = await slot.proc.request({ type: "set_model", provider: "openrouter", modelId: this.d.visionModel }, 30_000).catch(() => null);
        if (r?.success) {
          live.restoreModel = slot.model;
          slot.model = this.d.visionModel;
        }
      }
      this.chatEvent(convId, "start");
      try {
        const r = await slot.proc.request({ type: "prompt", message, ...(opts.images?.length ? { images: opts.images } : {}) }, 60_000);
        if (!r?.success) throw new Error(String(r?.error ?? "prompt rejected"));
      } catch (e) {
        live.finished = true;
        slot.live = null;
        unregisterRun(convId, live.controller);
        setLive(convId, false);
        this.chatEvent(convId, "end");
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The engine could not start this turn: ${(e as Error).message}`, failed: true }, { state: "idle" });
      }
    });
  }

  private canSee(model: string): boolean {
    const row = this.d.catalog.get(model);
    return row ? row.images : true;
  }

  // ---------------------------------------------------------------- events

  private pushRuntime(l: Live): void {
    setRuntime(l.convId, { text: this.turnContent(l).slice(-6000), tools: l.tools, startedAt: l.startedAt });
  }

  private onEvent(slot: Slot, e: any): void {
    const l = slot.live;
    if (e?.type === "entry_appended" && e.entry?.customType === "vc-cost") {
      const c: Cost = { genId: typeof e.entry.data?.genId === "string" ? e.entry.data.genId : null, cost: Number.isFinite(Number(e.entry.data?.cost)) && e.entry.data?.cost !== null ? Number(e.entry.data.cost) : null };
      if (l && !l.finished) l.costs.push(c);
      else void this.settleCosts(slot.convId, [c], this.lastMid.get(slot.convId) ?? null);
      return;
    }
    if (!l || l.finished) return;
    l.lastEventAt = Date.now();
    switch (e?.type) {
      case "message_start":
        if (e.message?.role === "assistant") l.msgIndex++;
        break;
      case "message_update": {
        const ev = e.assistantMessageEvent ?? {};
        const key = `${l.msgIndex}:${ev.contentIndex ?? 0}`;
        if (ev.type === "text_delta") {
          if (!l.texts.has(key)) l.order.push(key);
          l.texts.set(key, (l.texts.get(key) ?? "") + String(ev.delta ?? ""));
          this.pushRuntime(l);
          this.chatStream(l);
        } else if (ev.type === "text_end" && typeof ev.content === "string") {
          if (!l.texts.has(key)) l.order.push(key);
          l.texts.set(key, ev.content);
        } else if (ev.type === "thinking_end" && typeof ev.content === "string" && ev.content.trim()) {
          l.reasoning.push(ev.content.trim());
        }
        break;
      }
      case "message_end": {
        const m = e.message ?? {};
        if (m.role !== "assistant") break;
        const u = m.usage ?? {};
        const input = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
        const out = Number(u.output ?? 0);
        l.usage = {
          last: { inputTokens: input, cachedInputTokens: Number(u.cacheRead ?? 0), cacheWriteInputTokens: Number(u.cacheWrite ?? 0), outputTokens: out, totalTokens: input + out },
          modelContextWindow: modelWindow(slot.model, this.d.catalog),
        };
        if (m.stopReason === "error" && m.errorMessage) l.error = String(m.errorMessage);
        else if (m.stopReason !== "aborted") l.error = null;
        // The authoritative text of this message.
        (Array.isArray(m.content) ? m.content : []).forEach((c: any, i: number) => {
          if (c?.type !== "text" || typeof c.text !== "string") return;
          const key = `${l.msgIndex}:${i}`;
          if (!l.texts.has(key)) l.order.push(key);
          l.texts.set(key, c.text);
        });
        this.pushRuntime(l);
        break;
      }
      case "tool_execution_start":
        this.upsertTool(l, String(e.toolCallId), { name: TOOL_NAMES[e.toolName] ?? String(e.toolName ?? "tool"), input: e.args ?? {} });
        this.pushRuntime(l);
        break;
      case "tool_execution_end": {
        const txt = (e.result?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
        this.upsertTool(l, String(e.toolCallId), { name: TOOL_NAMES[e.toolName] ?? String(e.toolName ?? "tool"), input: undefined as any, result: capStr(`${e.isError ? "[error] " : ""}${txt}`, RESULT_CAP) });
        this.pushRuntime(l);
        break;
      }
      case "compaction_end":
        if (e.result) this.upsertTool(l, `compaction-${Date.now()}`, { name: "Compaction", input: { reason: e.reason }, result: "context compacted" });
        break;
      case "extension_error":
        this.log(`extension error (${e.event}): ${String(e.error ?? "").slice(0, 300)}`);
        break;
      case "agent_settled":
        void this.finishTurn(l, e.aborted ? "interrupted" : l.error ? "failed" : "completed");
        break;
      default:
        break;
    }
  }

  private lastStream = new Map<string, number>();
  private chatEvent(convId: string, phase: "start" | "end"): void {
    this.lastStream.delete(convId);
    this.d.broadcast?.({ type: "chat", convId, phase });
  }
  private chatStream(l: Live): void {
    const now = Date.now();
    if (now - (this.lastStream.get(l.convId) ?? 0) < 250) return;
    this.lastStream.set(l.convId, now);
    this.d.broadcast?.({ type: "chat", convId: l.convId, phase: "stream", text: this.turnContent(l).slice(-6000) });
  }

  private upsertTool(l: Live, id: string, t: Omit<ToolRec, "id">): void {
    const i = l.toolIndex.get(id);
    if (i === undefined) {
      l.toolIndex.set(id, l.tools.length);
      l.tools.push({ id, ...t });
    } else {
      const cur = l.tools[i]!;
      l.tools[i] = { ...cur, name: t.name ?? cur.name, input: t.input ?? cur.input, result: t.result ?? cur.result };
    }
  }

  private turnContent(l: Live): string {
    return l.order.map((k) => l.texts.get(k) ?? "").filter((s) => s.trim()).join("\n\n");
  }

  private async finishTurn(l: Live, status: "completed" | "interrupted" | "failed"): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    const slot = l.slot;
    if (slot.live === l) slot.live = null;
    slot.lastUsed = Date.now();
    unregisterRun(l.convId, l.controller);
    const vault = this.d.vault;
    this.chatEvent(l.convId, "end");
    if (l.restoreModel && slot.proc.isAlive()) {
      const back = l.restoreModel;
      void slot.proc.request({ type: "set_model", provider: "openrouter", modelId: back }, 30_000).then((r) => r?.success && (slot.model = back)).catch(() => undefined);
    }
    let content = this.turnContent(l);
    let failed = false;
    if (l.cut) {
      content = `${content}\n\n${CUT_NOTE}`.trim();
      failed = true;
    } else if (status === "failed") {
      content = `${content}\n\n⚠️ The turn failed: ${l.error ?? "unknown error"}`.trim();
      failed = true;
    } else if (status === "interrupted") {
      content = `${content}\n\n_(${l.stalled ? "stalled — interrupted by the watchdog" : "stopped"})_`.trim();
    }
    const mid = newMessageId();
    const usage = l.usage?.last;
    const msg: ChatMessage & Record<string, unknown> = {
      role: "assistant",
      content: capStr(content, MSG_CAP),
      mid,
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
      ...(l.reasoning.length ? { thinking: capStr(l.reasoning.join("\n\n"), 8_000) } : {}),
      ...(usage ? { usage: { prompt: usage.inputTokens ?? 0, completion: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0, context: usage.inputTokens ?? 0 } } : {}),
      ...(failed ? { failed: true } : {}),
    };
    const conv0 = await readConv(vault, l.convId);
    const wakeAt = nextWakeFor(vault, l.convId);
    let state: EngineConv["state"] = l.flags.blocked ? "blocked" : l.flags.done ? "done" : wakeAt ? "sleeping" : "idle";
    if (conv0?.pendingAsk) state = "waiting_user";
    if (l.cut) state = "running"; // resumed next
    const hasBody = !!(content.trim() || l.tools.length);
    let conv = hasBody ? await appendMessage(vault, l.convId, msg, { state, nextWakeAt: wakeAt }) : await patchMeta(vault, l.convId, { state, nextWakeAt: wakeAt });
    if (hasBody) this.lastMid.set(l.convId, mid);
    setLive(l.convId, false);
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);

    void this.settleCosts(l.convId, l.costs, hasBody ? mid : null);

    if (l.cut || !conv) return;

    if (l.stalled && !l.stopped) {
      void this.run(l.convId, `Your last turn made no progress for ${Math.round((this.d.stallMs ?? 0) / 60000)} minutes and was interrupted by the watchdog. ${RESUME_TEXT}`, "resume");
      return;
    }

    if (status === "completed" && l.usage && shouldRoll({ ...(conv as any), model: slot.model }, l.usage)) {
      await this.rollOver(conv).catch((e) => this.log(`roll-over failed: ${e}`));
      conv = (await readConv(vault, l.convId)) ?? conv;
    }

    const ended = l.flags.wake || l.flags.done || l.flags.blocked || !!conv.pendingAsk || !!wakeAt;
    if (ended) this.nudged.delete(l.convId);
    if (conv.working && !ended && !l.stopped && status !== "failed") {
      if (!this.nudged.has(l.convId)) {
        this.nudged.add(l.convId);
        void this.run(l.convId, NUDGE_TEXT, "nudge");
      } else {
        this.nudged.delete(l.convId);
        await patchMeta(vault, l.convId, { state: "blocked" });
        await this.d.notify({
          kind: "info",
          title: `Stopped: ${conv.title}`.slice(0, 90),
          body: "It ended a keep-going turn twice without scheduling a check, asking you, or saying Done or Blocked.",
          convId: l.convId,
        });
      }
    }
  }

  /** Roll-over: a recap from CONTEXT, a quiet marker, and the next turn starts a new pi session. */
  private async rollOver(conv: EngineConv): Promise<void> {
    const r = await buildRecap(conv as any);
    const from = conv.piSessionFile;
    await mutateConv(this.d.vault, conv.id, (c) => {
      c.messages.push({ ...(r.marker as any), mid: newMessageId() });
      c.recap = r.recap;
      c.piSessionFile = undefined;
      if (typeof r.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + r.costUsd);
    });
    const s = this.slots.get(conv.id);
    if (s && !s.live) await this.closeSlot(s);
    this.log(`rolled ${conv.id} over (from ${from}); next turn starts a new session`);
  }

  /** OpenRouter's own cost per call (from the stream); /generation for the ones the stream lacked. */
  private async settleCosts(convId: string, costs: Cost[], mid: string | null): Promise<void> {
    if (!costs.length) return;
    const r = await this.d.ledger.settle(costs);
    if (!r.calls) return;
    await mutateConv(this.d.vault, convId, (c) => {
      c.costUsd = round((c.costUsd ?? 0) + r.usd);
      if (r.missing) c.costMissingCalls = (c.costMissingCalls ?? 0) + r.missing;
      if (mid) {
        const i = c.messages.findIndex((m) => m.mid === mid);
        if (i >= 0) c.messages[i] = { ...c.messages[i]!, costUsd: round(((c.messages[i] as any).costUsd ?? 0) + r.usd) } as any;
      }
    }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- host calls (vault-chat's tools)

  private async onUi(slot: Slot, req: any): Promise<void> {
    const reply = (o: Record<string, unknown>) => slot.proc.write({ type: "extension_ui_response", id: req.id, ...o });
    if (req.method === "editor" && req.title === "vc:host-call") {
      let call: any = {};
      try {
        call = JSON.parse(String(req.prefill ?? "{}"));
      } catch {
        return reply({ value: JSON.stringify({ text: "bad host call", isError: true }) });
      }
      const l = slot.live && !slot.live.finished ? slot.live : null;
      if (l) l.lastEventAt = Date.now();
      const r = await this.hostTool(slot.convId, l, String(call.tool ?? ""), call.args ?? {}).catch((e) => ({ text: `${call.tool} failed: ${(e as Error).message}`, isError: true }));
      return reply({ value: JSON.stringify(r) });
    }
    if (req.method === "select" || req.method === "confirm" || req.method === "input" || req.method === "editor") return reply({ cancelled: true });
    // notify / setStatus / …: fire-and-forget, nothing to show.
  }

  private async hostTool(convId: string, l: Live | null, name: string, a: any): Promise<{ text: string; isError?: boolean }> {
    const vault = this.d.vault;
    const conv = await readConv(vault, convId);
    if (!conv) return { text: "No conversation for this session.", isError: true };
    if (isContextTool(name)) {
      const r = await handleContextTool(name, a, {
        conv: conv as any,
        setConversationProject: async (slug: string) => {
          await patchMeta(vault, convId, { project: slug });
        },
      });
      return { text: (r.contentItems ?? []).map((c) => c.text).join("\n"), ...(r.success ? {} : { isError: true }) };
    }
    switch (name) {
      case "AskUser": {
        const opts = Array.isArray(a.options) ? a.options.map(String).filter(Boolean).slice(0, 6) : [];
        const ans = await this.waitForAnswer(convId, l, String(a.question ?? "").trim() || "?", opts);
        return { text: `Carl answered: ${ans}` };
      }
      case "ScheduleWake": {
        const reason = String(a.reason ?? "").trim() || "scheduled check";
        let at = a.at ? Date.parse(String(a.at)) : NaN;
        if (!Number.isFinite(at)) {
          const ms = parseDelay(a.in);
          if (ms === null) return { text: 'ScheduleWake needs `in` (e.g. "10m") or `at` (ISO time).', isError: true };
          at = Date.now() + ms;
        }
        at = Math.max(at, Date.now() + 5_000);
        addWake(vault, { conv: convId, at, reason });
        if (l) l.flags.wake = true;
        await patchMeta(vault, convId, { nextWakeAt: nextWakeFor(vault, convId) });
        return { text: `Wake scheduled for ${new Date(at).toISOString()} ("${reason}"). End your turn now; you'll be woken then.` };
      }
      case "KeepWorking": {
        const on = a.on !== false;
        await patchMeta(vault, convId, { working: on, ...(on && (conv.state === "done" || conv.state === "blocked") ? { state: "running" } : {}) });
        if (!on) this.nudged.delete(convId);
        return { text: on ? "Keep-going mode on. End every turn with ScheduleWake, AskUser, Done or Blocked." : "Keep-going mode off." };
      }
      case "Done": {
        if (l) l.flags.done = true;
        const summary = String(a.summary ?? "").trim();
        const evidence = Array.isArray(a.evidence) ? a.evidence.map(String) : [];
        const v = await verifyDone({ conv: { ...(conv as any), model: this.d.model() }, summary, evidence });
        const line = formatVerdict(v);
        await mutateConv(vault, convId, (c) => {
          c.working = false;
          c.verdict = { verdict: v.verdict, notes: v.notes, at: v.at, summary };
          if (typeof v.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + v.costUsd);
        });
        await this.d.notify({ kind: "info", title: `Done: ${conv.title}`.slice(0, 90), body: `${summary.slice(0, 300)}\n${line}`, convId });
        return { text: `Recorded as done. ${line}\nTell Carl the verdict in your reply.` };
      }
      case "Blocked": {
        if (l) l.flags.blocked = true;
        const reason = String(a.reason ?? "").trim();
        await patchMeta(vault, convId, { state: "blocked", working: false });
        await this.d.notify({ kind: "info", title: `Blocked: ${conv.title}`.slice(0, 90), body: reason.slice(0, 600), convId });
        return { text: "Recorded as blocked; Carl has been notified. End your turn." };
      }
      case "Notify": {
        const sent = await this.d.notify({ kind: "info", title: String(a.title ?? "vault-chat").slice(0, 90), body: String(a.body ?? "").slice(0, 2000), convId });
        return { text: sent ? "Notified." : "Recorded in the feed (no phone subscribed)." };
      }
      case "PdfRead":
        return { text: await pdfRead(vault, a) };
      case "WebSearch":
        return { text: await webSearch(String(a.query ?? ""), this.d.apiKey(), this.d.webSearchModel) };
      case "StartJob":
        return { text: startJob(this.d.jobEnv, vault, a) };
      case "JobStatus":
        return { text: jobStatus(this.d.jobEnv, a) };
      case "Cost": {
        if (a.project) {
          const pc = projectCost(String(a.project), (await allConvs(vault)) as any);
          return { text: pc ? `Project ${pc.name}: $${pc.totalUsd.toFixed(4)} over ${pc.parts.length} conversation(s)${pc.missingCalls ? ` (${pc.missingCalls} call(s) without a cost)` : ""}.` : `No project "${a.project}".` };
        }
        const target = a.conversation ? await readConv(vault, String(a.conversation)) : conv;
        if (!target) return { text: `No conversation ${a.conversation}.` };
        return { text: `Conversation "${target.title}": $${(target.costUsd ?? 0).toFixed(4)}${target.costMissingCalls ? ` (+${target.costMissingCalls} call(s) without a cost)` : ""}. (Costs land a few seconds after each turn.)` };
      }
      default:
        return { text: `Unknown tool ${name}.`, isError: true };
    }
  }

  /** Park the turn on a question until Carl answers (via /message or /answer). */
  private async waitForAnswer(convId: string, l: Live | null, question: string, options: string[]): Promise<string> {
    if (!l) return "No one is available to answer right now. Continue with your best judgement and say what you assumed.";
    const vault = this.d.vault;
    const conv = await readConv(vault, convId);
    const before = this.turnContent(l);
    const optsBlock = options.length ? `\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : "";
    const msg: any = {
      role: "assistant",
      content: `${before ? before + "\n\n" : ""}**❓ ${question}**${optsBlock}`,
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
      ...(options.length ? { askOptions: options.map((o) => ({ answer: o, title: o, body: "" })) } : {}),
    };
    l.order = [];
    l.texts = new Map();
    l.tools = [];
    l.toolIndex = new Map();
    const p = new Promise<string>((resolve) => {
      l.ask = { resolve, question, since: Date.now() };
    });
    await appendMessage(vault, convId, msg, { state: "waiting_user", pendingAsk: { question, options, at: Date.now() } });
    setLive(convId, false);
    await this.d.notify({ kind: "ask", title: (conv?.title ? `Needs you: ${conv.title}` : "Needs your call").slice(0, 90), body: question, convId, options });
    return p;
  }

  private async answer(convId: string, answer: string): Promise<void> {
    const vault = this.d.vault;
    const l = this.liveOf(convId);
    const conv = await readConv(vault, convId);
    await appendMessage(vault, convId, { role: "user", content: answer, direct: true, decision: true }, { pendingAsk: undefined, state: l?.ask ? "running" : conv?.state === "waiting_user" ? "idle" : conv?.state });
    this.nudged.delete(convId);
    if (l?.ask) {
      const a = l.ask;
      l.ask = null;
      l.lastEventAt = Date.now();
      setLive(convId, true);
      a.resolve(answer);
      return;
    }
    const q = conv?.pendingAsk?.question;
    void this.run(convId, q ? `Carl's answer to your question "${q}": ${answer}` : answer, "user", { alreadyAppended: true });
  }

  /** Capability probes are Codex's (they test Codex features); pi reads capabilities from its catalog. */
  async probe(model: string): Promise<Record<string, unknown>> {
    const row = this.d.catalog.get(model);
    return { ok: false, model, engine: "pi", error: "paid probes run on the Codex engine only", catalog: row ?? null };
  }

  // ---------------------------------------------------------------- wakes & watchdog

  private async tickWakes(): Promise<void> {
    const now = Date.now();
    const due = readWakes(this.d.vault).filter((w) => w.at <= now && !this.firing.has(w.id));
    for (const w of due) {
      if (this.liveOf(w.conv)?.ask) continue; // waiting on Carl: the wake waits too
      this.firing.add(w.id);
      removeWakes(this.d.vault, (x) => x.id === w.id);
      void this.fireWake(w).finally(() => this.firing.delete(w.id));
    }
  }

  private async fireWake(w: Wake): Promise<void> {
    const conv = await readConv(this.d.vault, w.conv);
    if (!conv) return;
    await patchMeta(this.d.vault, w.conv, { nextWakeAt: nextWakeFor(this.d.vault, w.conv) });
    this.log(`wake ${w.id} → ${w.conv}: ${w.reason}`);
    // While a turn runs, run() queues the wake as a follow-up (pi delivers it when the work in hand is done).
    await this.run(w.conv, `Wake: ${w.reason}`, "wake").catch((e) => this.log(`wake failed: ${e}`));
  }

  private tickWatchdog(): void {
    const stall = this.d.stallMs ?? 30 * 60_000;
    const now = Date.now();
    for (const s of this.slots.values()) {
      const l = s.live;
      if (!l || l.ask || l.finished || l.stalled) continue;
      if (now - l.lastEventAt > stall) {
        l.stalled = true;
        this.log(`watchdog: ${l.convId} silent for ${Math.round((now - l.lastEventAt) / 1000)} s — aborting`);
        void this.interrupt(l.convId, false);
      }
    }
  }
}

function capStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}
function round(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
