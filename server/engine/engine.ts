// The engine: every agent turn on the box runs in pi (pi/backend.ts). A
// conversation maps to one pi session ("thread"; a new one after a roll-over);
// each turn's events become the existing message shapes in the conversation
// file, and the live run is mirrored into the store so the phone host emits the
// /poll events the phone already renders. vault-chat's own tools reach pi
// through its extension as host calls.
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import type { ChatMessage } from "../../src/store";
import { registerRun, unregisterRun } from "../../src/runRegistry";
import type { BackendEvent, PiBackend } from "./pi/backend";
import {
  withVault,
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
} from "./context";
import { appendMessage, patchMeta, readConv, allConvs, createConv, mutateConv, setLive, setRuntime, newMessageId } from "./convs";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "./wakes";
import { Ledger } from "./ledger";
import { pdfRead, webSearch } from "./extraTools";
import { startJob, jobStatus, type PiJobEnv } from "./pi/jobs";
import { ENGINE_ROLE_PROMPT } from "./prompt";
import { capabilitiesOf, capabilityNote, learn } from "./capabilities";
import { join } from "node:path";
import { StreamWire } from "../../src/streamWire";
import { COMPACTION_DIVIDER_TEXT } from "../../src/chatContext";

export type EngineDeps = {
  vault: string;
  backend: PiBackend;
  ledger: Ledger;
  jobEnv: PiJobEnv;
  model: () => string;
  webSearchModel: string;
  apiKey: () => string | null;
  /** Web Push + notifications.jsonl + the /poll "notif" event. */
  notify: (n: { kind: "info" | "ask"; title: string; body: string; convId: string; options?: string[] }) => Promise<string | null>;
  /** One-line log. */
  log?: (s: string) => void;
  stallMs?: number;
  /** /poll ring. */
  broadcast?: (ev: Record<string, unknown>) => void;
  /** Model for a turn that carries images when the default can't see. */
  visionModel?: string;
  /** The other vaults on this box (and their state): the verifier may not read them. */
  deny?: () => string[];
};

/** `subagents`: the children a `subagent` call spawned (their threadIds; state and cost live in conv.subagents). */
type ToolRec = { id?: string; name: string; input: any; result?: string; subagents?: string[] };
type TurnKind = "user" | "wake" | "nudge" | "resume";

type Live = {
  convId: string;
  threadId: string;
  turnId: string | null;
  kind: TurnKind;
  startedAt: number;
  lastEventAt: number;
  order: string[];
  texts: Map<string, string>;
  tools: ToolRec[];
  toolIndex: Map<string, number>;
  reasoning: string[];
  /** The thinking block streaming now (thinking_delta), before it is final. */
  reasoningLive: string;
  usage: ThreadTokenUsage | null;
  flags: { wake: boolean; done: boolean; blocked: boolean };
  ask: { resolve: (answer: string) => void; question: string } | null;
  cut: boolean;
  stalled: boolean;
  stopped: boolean;
  controller: AbortController;
  finished: boolean;
  /** What started the turn (for the silent retry). */
  input: string;
  turnOpts: TurnOpts;
};

type TurnOpts = { alreadyAppended?: boolean; images?: string[]; context?: string; attachments?: any[] };

const MSG_CAP = 20_000;
const NUDGE_TEXT = "You're in keep-going mode: schedule your next check (ScheduleWake), or say Done or Blocked.";
const RESUME_TEXT =
  "The box restarted (or the engine stopped) while your last turn was running, so any command it was running was killed and may not have finished. Re-check reality (files, processes, logs), then continue from where you were.";
const LEGACY_SOURCES = new Set(["mission", "worker", "ask"]);

export const ENGINE_TOOL_SPECS = [
  {
    type: "function",
    name: "AskUser",
    description:
      "Ask Carl a question and wait for his answer (he gets a push on his phone). Only when stuck, for anything irreversible or that spends money, for matters of taste, or when he asked to be consulted. Give 2-4 short options when they help.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ScheduleWake",
    description:
      "Schedule ONE future turn of this conversation (survives restarts). Give `in` (e.g. \"2m\", \"1h30m\") or `at` (ISO time), and the reason you will read when woken. Then end your turn.",
    inputSchema: {
      type: "object",
      properties: { in: { type: "string" }, at: { type: "string" }, reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "KeepWorking",
    description: "Turn keep-going mode on or off for this conversation. On: every turn must end with ScheduleWake, AskUser, Done or Blocked.",
    inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
  },
  {
    type: "function",
    name: "Done",
    description: "Declare the work done, with a summary and the evidence (file paths, quoted command outputs). A separate verifier checks it; its verdict is returned and shown to Carl.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Blocked",
    description: "Say you cannot continue without Carl, and why. Ends keep-going work and pushes him.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
  },
  {
    type: "function",
    name: "Notify",
    description: "Send Carl a push notification (for news he should see now, not for questions).",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "PdfRead",
    description: "Read text from a PDF: the page count plus the pages asked for (default 1-3), capped at maxChars (default 12000). Use page ranges; never read a whole long PDF at once.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, pages: { type: "string", description: "e.g. \"1\", \"4-8\", \"1,3,7-9\"" }, maxChars: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "WebSearch",
    description: "Search the web; returns a short answer with source URLs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    type: "function",
    name: "StartJob",
    description:
      "Start a long-running shell command that must outlive this turn (training, downloads, builds). It runs detached, sandboxed, in the vault; output goes to a log. Returns a job id for JobStatus.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, name: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "JobStatus",
    description: "State and last output lines of a job started with StartJob.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, tail: { type: "number" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "TodoWrite",
    description:
      "Keep a short to-do list Carl sees in the chat while you work on a task with 3+ steps: lay out the plan at the start, then call again after each step with the updated statuses. Each item: content (imperative), status (pending | in_progress | completed), optional activeForm (\"Reading the file\") shown while in progress. At most one in progress.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Cost",
    description: "Model spend in USD: this conversation by default, or a project's total.",
    inputSchema: {
      type: "object",
      properties: { conversation: { type: "string" }, project: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const text = (t: string) => ({ success: true, contentItems: [{ type: "inputText", text: t }] });

export class Engine {
  private live = new Map<string, Live>(); // convId → live turn
  private byThread = new Map<string, string>(); // threadId → convId
  private chains = new Map<string, Promise<unknown>>();
  private nudged = new Set<string>();
  /** Watchdog resumes in a row per conversation; a third stall ends it as blocked. */
  private stalls = new Map<string, number>();
  /** Notify calls per conversation in the last hour (the agent's pings are capped). */
  private pings = new Map<string, number[]>();
  private resumeQueue = new Set<string>();
  private firstUp = true;
  private timers: NodeJS.Timeout[] = [];
  private firing = new Set<string>();
  private childOf = new Map<string, string>(); // subagent threadId → parent conversation id

  constructor(private d: EngineDeps) {
    // Everything this engine does runs scoped to its vault (CONTEXT reads that
    // vault's projects and rules): the public entry points here, the backend's
    // events, handlers and timers in start().
    for (const k of ["message", "answerRoute", "subagent", "kill"] as const) {
      const f = (this as any)[k].bind(this);
      (this as any)[k] = (...a: unknown[]) => this.scoped(() => f(...a));
    }
  }

  private scoped<T>(fn: () => T): T {
    return withVault(this.d.vault, fn, this.d.deny);
  }

  private log(s: string): void {
    (this.d.log ?? ((m) => console.log(`[engine] ${m}`)))(s);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const b = this.d.backend;
    b.on("event", (e: BackendEvent) => this.scoped(() => this.onEvent(e)));
    b.on("up", () => this.scoped(() => void this.onUp()));
    b.setHandlers({
      toolCall: (threadId, name, args) =>
        this.scoped(async () => {
          const r: any = await this.onToolCall({ threadId, tool: name, arguments: args });
          return { ok: r?.success !== false, text: (r?.contentItems ?? []).map((c: any) => c?.text ?? "").join("\n") };
        }),
      userInput: (threadId, question, options) => this.scoped(() => this.waitForAnswer(threadId, question, options)),
    });
    this.timers.push(setInterval(() => this.scoped(() => void this.tickWakes()), 2_000));
    this.timers.push(setInterval(() => this.scoped(() => this.tickWatchdog()), 15_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  health(): Record<string, unknown> {
    return {
      [this.d.backend.name]: this.d.backend.health(),
      backend: this.d.backend.name,
      liveTurns: [...this.live.values()].map((l) => ({ convId: l.convId, kind: l.kind, waitingUser: !!l.ask, sinceMs: Date.now() - l.startedAt })),
      wakes: readWakes(this.d.vault).length,
    };
  }

  isRunning(convId: string): boolean {
    const l = this.live.get(convId);
    return !!l && !l.ask;
  }

  private async onUp(): Promise<void> {
    if (this.firstUp) {
      this.firstUp = false;
      void this.reconcileCosts().catch((e) => this.log(`cost reconcile failed: ${e}`));
      // A turn cut by a crash or restart of the whole server: the file still
      // says running. Mark it, then resume it.
      for (const c of await allConvs(this.d.vault).catch(() => [])) {
        if (c.state === "running" && c.threadId && !this.live.has(c.id)) {
          await appendMessage(this.d.vault, c.id, {
            role: "assistant",
            content: "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.",
            failed: true,
          });
          this.resumeQueue.add(c.id);
        }
      }
    }
    const q = [...this.resumeQueue];
    this.resumeQueue.clear();
    for (const id of q) void this.run(id, RESUME_TEXT, "resume").catch((e) => this.log(`resume ${id} failed: ${e}`));
  }

  // ---------------------------------------------------------------- inbound

  /** /message. Returns null when the conversation is a legacy mission thread (old path). */
  /**
   * /message {text, convId?, project?, context?, images?, clientMsgId?} → {ok, convId}.
   * images: [{name?, mime, dataBase64}] (saved under .vault-chat/captures/) or
   * imagePaths: [vault-relative path]. context: a preamble the agent sees before
   * the text (not shown as the message). project: tags the conversation.
   * Returns null when the conversation is a legacy mission thread (old path).
   */
  async message(body: {
    convId?: string | null;
    text?: string;
    project?: string;
    context?: string;
    images?: { name?: string; mime?: string; dataBase64?: string }[];
    imagePaths?: string[];
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
      // Let the phone host's store diff see the new (empty) conversation first,
      // so this turn's messages go out as live "message" events.
      await new Promise((r) => setTimeout(r, 400));
    }
    const id = conv.id;
    if (typeof body.project === "string" && body.project.trim()) {
      try {
        const { ensureProject } = await import("../context");
        const { project } = ensureProject(body.project.trim());
        await patchMeta(this.d.vault, id, { project: project.slug });
      } catch (e) {
        this.log(`project ${body.project}: ${(e as Error).message}`);
      }
    }
    const { paths, attachments } = this.saveImages(id, body);
    const context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    const shown = textIn || "(image)";
    this.nudged.delete(id);
    // An open question: this message is the answer.
    if (this.live.get(id)?.ask || conv.pendingAsk) {
      await this.answer(id, shown);
      return { ok: true, convId: id, answered: true };
    }
    // A running turn: steer it.
    const l = this.live.get(id);
    if (l && l.turnId && !l.finished) {
      await appendMessage(this.d.vault, id, { role: "user", content: shown, direct: true, ...(attachments.length ? { attachments } : {}) });
      try {
        await this.d.backend.steer(l.threadId, l.turnId, { texts: [context ? `${context}\n\n${shown}` : shown], images: paths });
        return { ok: true, convId: id, steered: true };
      } catch (e) {
        this.log(`steer failed (${(e as Error).message}); starting a new turn`);
        void this.run(id, shown, "user", { alreadyAppended: true, images: paths, context });
        return { ok: true, convId: id };
      }
    }
    void this.run(id, shown, "user", { images: paths, context, attachments }).catch((e) => this.log(`turn failed: ${e}`));
    return { ok: true, convId: id };
  }

  private saveImages(convId: string, body: { images?: { name?: string; mime?: string; dataBase64?: string }[]; imagePaths?: string[] }): { paths: string[]; attachments: any[] } {
    const paths: string[] = [];
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
      paths.push(join(this.d.vault, rel));
      attachments.push({ imageDataUrl: buf.length < 400_000 ? `data:${mime};base64,${b64}` : "", capturedFilePath: rel });
    });
    for (const p of (body.imagePaths ?? []).slice(0, 8)) {
      const rel = String(p).replace(/^[\/]+/, "");
      if (!rel || rel.includes("..")) continue;
      paths.push(join(this.d.vault, rel));
      attachments.push({ imageDataUrl: "", capturedFilePath: rel, sourcePath: rel });
    }
    return { paths, attachments };
  }

  /** /answer. null → legacy path. */
  async answerRoute(body: { convId?: string; text?: string; defer?: boolean }): Promise<Record<string, unknown> | null> {
    const id = String(body?.convId ?? "");
    if (!id) return null;
    const conv = await readConv(this.d.vault, id);
    if (!conv || LEGACY_SOURCES.has(conv.source)) return null;
    const t = body.defer
      ? "Not now — I'm not picking an option. Take the default you named if there is a safe one; otherwise hold, and don't do anything irreversible or that spends money."
      : String(body?.text ?? "").trim();
    if (!t) return { error: "answer needs a convId and non-empty text" };
    if (!this.live.get(id)?.ask && !conv.pendingAsk) {
      // No open question (already answered elsewhere): a plain message.
      return (await this.message({ convId: id, text: t })) ?? { ok: true, convId: id };
    }
    await this.answer(id, t);
    return { ok: true, convId: id, answered: true };
  }

  /** /kill. null → legacy path. Stop means stop: interrupt, keep-going off, wakes cancelled. */
  /** POST /api/v1/conversations/:id/subagents/:sid/{steer,stop} {text?}. */
  async subagent(convId: string, sid: string, op: "steer" | "stop", body: { text?: string }): Promise<Record<string, unknown>> {
    const conv = await readConv(this.d.vault, convId);
    if (!conv) return { ok: false, error: `conversation ${convId} not found` };
    if (!(conv.subagents ?? []).some((s: any) => s.threadId === sid)) return { ok: false, error: `no subagent ${sid} on this conversation` };
    return this.d.backend.subagentControl(sid, op, body?.text);
  }

  async kill(body: { convId?: string | null }): Promise<Record<string, unknown> | null> {
    const id = body?.convId ? String(body.convId) : "";
    if (!id) {
      let n = 0;
      for (const l of [...this.live.values()]) if (await this.interrupt(l.convId, true)) n++;
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
    const l = this.live.get(convId);
    if (!l) return false;
    if (l.ask) {
      // Parked on a question: release the call so the turn can close.
      l.stopped = true;
      const a = l.ask;
      l.ask = null;
      await patchMeta(this.d.vault, convId, { pendingAsk: undefined });
      a.resolve("Carl stopped this turn instead of answering. End the turn now; do nothing else.");
    }
    l.stopped = byUser || l.stopped;
    if (!l.turnId) return true;
    try {
      await this.d.backend.interrupt(l.threadId, l.turnId);
    } catch (e) {
      this.log(`interrupt failed: ${(e as Error).message}`);
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

  /** Start a turn (or, if one is running, steer the input into it). */
  run(convId: string, input: string, kind: TurnKind, opts: TurnOpts = {}): Promise<void> {
    return this.serial(convId, async () => {
      const existing = this.live.get(convId);
      if (existing && !existing.finished) {
        if (existing.turnId && !existing.ask) {
          const b = this.d.backend;
          if (kind !== "user" && b.followUp) await b.followUp(existing.threadId, { texts: [input] }).catch(() => undefined);
          else await b.steer(existing.threadId, existing.turnId, { texts: [input], images: [] }).catch(() => undefined);
        }
        return;
      }
      if (!(await this.d.backend.ready(120_000))) throw new Error(`the ${this.d.backend.name} runtime is not up`);
      let conv = await readConv(this.d.vault, convId);
      if (!conv) throw new Error(`conversation ${convId} not found`);
      if (!opts.alreadyAppended) {
        const visible: ChatMessage =
          kind === "user"
            ? { role: "user", content: input, direct: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }
            : { role: "user", content: kind === "wake" ? `⏰ ${input}` : kind === "nudge" ? `↻ ${input}` : `↻ ${input}`, system: true };
        conv = (await appendMessage(this.d.vault, convId, visible)) ?? conv;
      }
      if (!existsSync(this.d.vault) || !statSync(this.d.vault).isDirectory()) {
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The vault ${this.d.vault} is missing on the box; no turn was run.`, failed: true });
        return;
      }
      let threadId: string;
      try {
        threadId = await this.ensureThread(conv);
      } catch (e) {
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The engine could not open this conversation's thread: ${(e as Error).message}`, failed: true }, { state: "idle" });
        throw e;
      }
      const live: Live = {
        convId,
        threadId,
        turnId: null,
        kind,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        order: [],
        texts: new Map(),
        tools: [],
        toolIndex: new Map(),
        reasoning: [],
        reasoningLive: "",
        usage: null,
        flags: { wake: false, done: false, blocked: false },
        ask: null,
        cut: false,
        stalled: false,
        stopped: false,
        controller: new AbortController(),
        finished: false,
        input,
        turnOpts: opts,
      };
      // The old Stop path (runRegistry) reaches engine runs too.
      live.controller.signal.addEventListener("abort", () => void this.interrupt(convId, true));
      this.live.set(convId, live);
      registerRun(convId, live.controller);
      setLive(this.d.vault, convId, true);
      await patchMeta(this.d.vault, convId, { state: "running" });
      // A legacy chat (history from the old loop) carries its transcript into the first turn.
      let body = input;
      const prior = (conv as any).__legacyHistory as string | undefined;
      if (prior) body = `${prior}\n\n${input}`;
      const rules = rulesPrefixForTurn(conv as any);
      if (opts.context) body = `${opts.context}\n\n${body}`;
      const texts = [rules, kind === "wake" ? input : body].filter(Boolean);
      // Images on a model that can't see: this turn (silently) uses the vision model.
      let model = this.d.model();
      if (opts.images?.length && !capabilitiesOf(model).images) model = this.d.visionModel ?? model;
      this.chatEvent(convId, "start");
      try {
        const r = await this.d.backend.startTurn(threadId, { texts, images: opts.images ?? [], model });
        if (!live.turnId) live.turnId = r.turnId;
      } catch (e) {
        live.finished = true;
        this.live.delete(convId);
        unregisterRun(convId, live.controller);
        setLive(this.d.vault, convId, false);
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The engine could not start this turn: ${(e as Error).message}`, failed: true }, { state: "idle" });
      }
    });
  }

  private async ensureThread(conv: EngineConv): Promise<string> {
    const model = this.d.model();
    // Subagents only for models where they work (learned from use; see capabilities.ts).
    const subagents = capabilitiesOf(model).subagents;
    if (conv.threadId) {
      try {
        await this.d.backend.resumeThread(conv.threadId, { model, subagents });
        this.byThread.set(conv.threadId, conv.id);
        return conv.threadId;
      } catch (e) {
        if (!(e as any)?.threadUnknown) throw e;
        // A thread of the other runtime (VC_ENGINE switched) or a lost one: a fresh thread, with the transcript handed over.
        this.log(`thread ${conv.threadId} is unknown to ${this.d.backend.name}; starting a new one`);
        conv.threadId = undefined;
        conv.threadPath = undefined;
      }
    }
    const note = capabilityNote(model);
    const instructions = buildDeveloperInstructions(conv as any, { rolePrompt: ENGINE_ROLE_PROMPT + (note ? `\n\n${note}` : "") });
    const { threadId, ref } = await this.d.backend.startThread({
      cwd: this.d.vault,
      model,
      instructions,
      tools: [...ENGINE_TOOL_SPECS, ...contextToolSpecs] as any,
      subagents,
    });
    this.byThread.set(threadId, conv.id);
    // History from before this thread (a legacy chat, or a retry on a fresh thread): hand it over once.
    const old = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim()).slice(0, -1);
    if (old.length && !conv.messages.some((m: any) => m.rollover)) {
      const t = old.slice(-30).map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1500)}`).join("\n");
      (conv as any).__legacyHistory = `<earlier_conversation>\n${t.slice(-12_000)}\n</earlier_conversation>`;
    }
    await patchMeta(this.d.vault, conv.id, { threadId: threadId, threadPath: ref });
    conv.threadId = threadId;
    conv.threadPath = ref;
    return threadId;
  }

  // ---------------------------------------------------------------- events

  private liveByThread(threadId: string | undefined): Live | undefined {
    if (!threadId) return undefined;
    const c = this.byThread.get(threadId);
    return c ? this.live.get(c) : undefined;
  }

  private pushRuntime(l: Live): void {
    // The whole text: the /poll events carry it in pieces (src/streamWire.ts).
    const reasoning = [...l.reasoning, l.reasoningLive].filter((s) => s.trim()).join("\n\n");
    const last = l.usage?.last;
    setRuntime(this.d.vault, l.convId, {
      text: this.turnContent(l),
      reasoning: reasoning.slice(-4000),
      tools: l.tools,
      startedAt: l.startedAt,
      ...(last ? { context: last.inputTokens ?? 0, window: l.usage?.modelContextWindow ?? undefined } : {}),
    });
  }

  private onEvent(e: BackendEvent): void {
    const parent = this.childOf.get(e.threadId);
    if (parent) {
      // A subagent's own stream: keeps the parent's turn alive, never mixed into its text.
      const pl = this.live.get(parent);
      if (pl) pl.lastEventAt = Date.now();
      if (e.kind === "turnCompleted") void this.updateSubagent(parent, e.threadId, { status: e.status });
      return;
    }
    // A subagent's end can arrive after its parent's turn is gone (the parent crashed): still record it.
    if (e.kind === "subagentStatus" && !this.liveByThread(e.threadId)) {
      const convId = this.byThread.get(e.threadId);
      if (convId) void this.updateSubagent(convId, e.child, { status: e.status, ...(e.patch ?? {}) });
      return;
    }
    const l = this.liveByThread(e.threadId);
    if (!l) return;
    l.lastEventAt = Date.now();
    switch (e.kind) {
      case "turnStarted":
        if (!l.turnId) l.turnId = e.turnId;
        return;
      case "textDelta":
        if (!l.texts.has(e.itemId)) l.order.push(e.itemId);
        l.texts.set(e.itemId, (l.texts.get(e.itemId) ?? "") + e.delta);
        this.pushRuntime(l);
        this.chatStream(l);
        return;
      case "text":
        if (!l.texts.has(e.itemId)) l.order.push(e.itemId);
        l.texts.set(e.itemId, e.text);
        this.pushRuntime(l);
        return;
      case "reasoningDelta":
        l.reasoningLive += e.delta;
        this.pushRuntime(l);
        return;
      case "reasoning":
        l.reasoning.push(e.text);
        l.reasoningLive = "";
        this.pushRuntime(l);
        return;
      case "compaction":
        // pi summarized the thread's earlier context: the same quiet divider as a local compaction.
        void appendMessage(this.d.vault, l.convId, { role: "assistant", system: true, content: COMPACTION_DIVIDER_TEXT, compaction: { summary: e.summary, at: Date.now() } });
        return;
      case "tool":
        this.upsertTool(l, e.itemId, { name: e.name, input: e.input, result: e.result });
        this.pushRuntime(l);
        return;
      case "usage":
        l.usage = e.usage;
        this.pushRuntime(l);
        return;
      case "subagents": {
        for (const t of e.children) {
          if (!this.childOf.has(t)) {
            this.childOf.set(t, l.convId);
            void this.updateSubagent(l.convId, t, { prompt: String(e.prompt ?? "").slice(0, 300), model: e.model ?? this.d.model(), status: "running", startedAt: Date.now() });
          }
        }
        // One entry per spawn: the children ride on the parent's own `subagent` tool call.
        this.attachChildren(l, e.itemId, e.children);
        if (e.done && e.ok && e.op === "spawnAgent" && e.children.length) {
          if (learn(this.d.model(), "subagents", true, `spawned ${e.children.length} subagent(s) in a real turn`)) this.log(`learned: ${this.d.model()} subagents on`);
        }
        this.pushRuntime(l);
        return;
      }
      case "subagentStatus":
        if (!this.childOf.has(e.child)) this.childOf.set(e.child, l.convId);
        void this.updateSubagent(l.convId, e.child, { status: e.status, ...(e.path ? { path: e.path } : {}), ...(e.patch ?? {}) });
        return;
      case "turnCompleted":
        void this.finishTurn(l, e.status, e.error);
        return;
      case "threadLost":
        // Only this thread's runtime died: cut its turn and resume it now (no "up" will follow).
        if (l.ask) {
          this.live.delete(l.convId);
          unregisterRun(l.convId, l.controller);
          setLive(this.d.vault, l.convId, false);
          return;
        }
        l.cut = true;
        void this.finishTurn(l, "interrupted", null).then(() => this.run(l.convId, RESUME_TEXT, "resume")).catch((err) => this.log(`resume ${l.convId} failed: ${err}`));
        return;
    }
  }

  /** Live streaming for clients that want it: /poll `chat` start/stream/end (throttled). */
  private lastStream = new Map<string, number>();
  private wire = new StreamWire();
  private chatEvent(convId: string, phase: "start" | "end"): void {
    this.lastStream.delete(convId);
    this.wire.reset(convId);
    this.d.broadcast?.({ type: "chat", convId, phase });
  }
  private chatStream(l: Live): void {
    const now = Date.now();
    if (now - (this.lastStream.get(l.convId) ?? 0) < 250) return;
    this.lastStream.set(l.convId, now);
    this.d.broadcast?.({ type: "chat", convId: l.convId, phase: "stream", ...this.wire.next(l.convId, this.turnContent(l), now) });
  }

  /** Children onto the `subagent` call that spawned them (by its toolCallId; an
   *  older extension without it: the newest unfinished `subagent` call). Never a
   *  tool entry of their own. */
  private attachChildren(l: Live, itemId: string, children: string[]): void {
    let i = l.toolIndex.get(itemId);
    if (i === undefined) {
      for (let j = l.tools.length - 1; j >= 0; j--) {
        if (l.tools[j]!.name === "subagent" && l.tools[j]!.result === undefined) {
          i = j;
          break;
        }
      }
    }
    if (i === undefined) return;
    const cur = l.tools[i]!;
    const have = cur.subagents ?? [];
    const add = children.filter((c) => !have.includes(c));
    if (add.length) l.tools[i] = { ...cur, subagents: [...have, ...add] };
  }

  private upsertTool(l: Live, id: string, t: Omit<ToolRec, "id">): void {
    const i = l.toolIndex.get(id);
    if (i === undefined) {
      l.toolIndex.set(id, l.tools.length);
      l.tools.push({ id, ...t });
    } else {
      const cur = l.tools[i]!;
      l.tools[i] = { ...cur, ...t, input: t.input ?? cur.input, result: t.result ?? cur.result };
    }
  }

  private turnContent(l: Live): string {
    return l.order.map((k) => l.texts.get(k) ?? "").filter((s) => s.trim()).join("\n\n");
  }

  private async finishTurn(l: Live, status: string, error: any): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    if (this.live.get(l.convId) === l) this.live.delete(l.convId);
    unregisterRun(l.convId, l.controller);
    const vault = this.d.vault;
    this.chatEvent(l.convId, "end");
    const errStr = status === "failed" ? errText(error) : "";
    if (errStr && /tool/i.test(errStr) && /(not support|unsupported|No endpoints found)/i.test(errStr)) {
      learn(this.d.model(), "tools", false, `request rejected: ${errStr}`);
    }
    let content = this.turnContent(l);
    let failed = false;
    if (l.cut) {
      content = `${content}\n\n⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.`.trim();
      failed = true;
    } else if (status === "failed") {
      content = `${content}\n\n⚠️ The turn failed: ${errText(error)}`.trim();
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
      ...(l.turnId ? { turnId: l.turnId } : {}),
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
      ...(l.reasoning.length ? { thinking: capStr(l.reasoning.join("\n\n"), 8_000) } : {}),
      ...(usage
        ? { usage: { prompt: usage.inputTokens ?? 0, completion: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0, context: usage.inputTokens ?? 0, ...(l.usage?.modelContextWindow ? { window: l.usage.modelContextWindow } : {}) } }
        : {}),
      ...(failed ? { failed: true } : {}),
    };
    const conv0 = await readConv(vault, l.convId);
    const wakeAt = nextWakeFor(vault, l.convId);
    let state: EngineConv["state"] = l.flags.blocked ? "blocked" : l.flags.done ? "done" : wakeAt ? "sleeping" : "idle";
    if (conv0?.pendingAsk) state = "waiting_user";
    if (l.cut) state = "running"; // resumed on the next up
    const hasBody = !!(content.trim() || l.tools.length);
    let conv = hasBody
      ? await appendMessage(vault, l.convId, msg, { state, nextWakeAt: wakeAt })
      : await patchMeta(vault, l.convId, { state, nextWakeAt: wakeAt });
    setLive(this.d.vault, l.convId, false);
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);

    // Cost, from the rollout's response ids (async; lands a few seconds later).
    void this.settleCost(l.convId, conv?.threadPath ?? conv0?.threadPath, l.turnId, hasBody ? mid : null);

    if (l.cut || !conv) return;

    // A stalled turn gets a resume turn — twice in a row at most; then it is
    // blocked and Carl hears about it, instead of a silent stall loop.
    if (l.stalled && !l.stopped) {
      const n = (this.stalls.get(l.convId) ?? 0) + 1;
      this.stalls.set(l.convId, n);
      if (n <= 2) {
        void this.run(l.convId, `Your last turn made no progress for ${Math.round((this.d.stallMs ?? 0) / 60000)} minutes and was interrupted by the watchdog. ${RESUME_TEXT}`, "resume");
        return;
      }
      this.stalls.delete(l.convId);
      await patchMeta(vault, l.convId, { state: "blocked", working: false });
      await this.d.notify({ kind: "info", title: `Stuck: ${conv.title}`.slice(0, 90), body: "Its turns stopped making progress three times in a row, so it was stopped. Open the chat to see where.", convId: l.convId });
      return;
    }
    if (status === "completed") this.stalls.delete(l.convId);

    // A keep-going conversation whose turn failed (the model or its provider
    // kept erroring after retries) ends blocked with the reason — never idle.
    if (conv.working && status === "failed" && !l.stopped) {
      this.nudged.delete(l.convId);
      await patchMeta(vault, l.convId, { state: "blocked", working: false });
      await this.d.notify({ kind: "info", title: `Failed: ${conv.title}`.slice(0, 90), body: (content.trim() || "Its last turn failed.").slice(0, 600), convId: l.convId });
      return;
    }

    // Rolling sessions: past the threshold, retire the thread with a recap.
    if (status === "completed" && l.usage && shouldRoll(conv as any, l.usage)) {
      await this.rollOver(conv).catch((e) => this.log(`roll-over failed: ${e}`));
      conv = (await readConv(vault, l.convId)) ?? conv;
    }

    // Keep-going rule.
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

  private async rollOver(conv: EngineConv): Promise<void> {
    const r = await buildRecap(conv as any);
    const from = conv.threadId;
    await mutateConv(this.d.vault, conv.id, (c) => {
      c.messages.push({ ...(r.marker as any), mid: newMessageId() });
      c.recap = r.recap;
      c.threadId = undefined;
      c.threadPath = undefined;
      if (typeof r.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + r.costUsd);
    });
    if (from) this.byThread.delete(from);
    this.log(`rolled ${conv.id} over (from ${from}); next turn starts a new thread`);
  }

  private async updateSubagent(convId: string, threadId: string, patch: Record<string, unknown>): Promise<void> {
    await mutateConv(this.d.vault, convId, (c) => {
      const list = [...((c.subagents as any[]) ?? [])];
      const i = list.findIndex((x) => x.threadId === threadId);
      if (i >= 0) list[i] = { ...list[i], ...patch };
      else list.push({ threadId, ...patch });
      c.subagents = list as any;
    }).catch(() => undefined);
  }

  private async settleCost(convId: string, threadPath: string | undefined, turnId: string | null, mid: string | null): Promise<void> {
    if (!threadPath || !turnId) return;
    await new Promise((r) => setTimeout(r, 1500));
    // The turn's own calls, plus every call of this conversation's subagents
    // (their rollouts are separate threads; the ledger skips ids already counted).
    const childCalls = [...this.childOf.entries()].filter(([, c]) => c === convId).flatMap(([t]) => this.d.backend.childUsageCalls(t));
    const res = await this.d.ledger.settle([...this.d.backend.usageCalls(threadPath, turnId), ...childCalls]);
    if (!res.calls) return;
    await mutateConv(this.d.vault, convId, (c) => {
      c.costUsd = round((c.costUsd ?? 0) + res.usd);
      if (res.missing) c.costMissingCalls = (c.costMissingCalls ?? 0) + res.missing;
      if (mid) {
        const i = c.messages.findIndex((m) => m.mid === mid);
        if (i >= 0) c.messages[i] = { ...c.messages[i]!, costUsd: round(((c.messages[i] as any).costUsd ?? 0) + res.usd) } as any;
      }
    });
  }

  /** At boot: cost any model call a restart cut off before its lookup finished
   * (the ledger skips ids already counted), onto the message of its turn. */
  private async reconcileCosts(): Promise<void> {
    for (const c of await allConvs(this.d.vault)) {
      const path = c.threadPath;
      if (!path) continue;
      const calls = this.d.backend.usageCalls(path).filter((x) => !this.d.ledger.has(x.responseId));
      if (!calls.length) continue;
      const res = await this.d.ledger.settle(calls);
      if (!res.calls) continue;
      const turnOf = new Map(calls.map((x) => [x.responseId, x.turnId]));
      await mutateConv(this.d.vault, c.id, (cv) => {
        cv.costUsd = round((cv.costUsd ?? 0) + res.usd);
        if (res.missing) cv.costMissingCalls = (cv.costMissingCalls ?? 0) + res.missing;
        for (const [id, cost] of Object.entries(res.byId)) {
          if (cost == null) continue;
          const i = cv.messages.findIndex((m: any) => m.role === "assistant" && m.turnId && m.turnId === turnOf.get(id));
          if (i >= 0) cv.messages[i] = { ...cv.messages[i]!, costUsd: round(((cv.messages[i] as any).costUsd ?? 0) + cost) } as any;
        }
      });
      this.log(`reconciled ${res.calls} uncounted call(s) on ${c.id}: $${res.usd}`);
    }
  }

  // ---------------------------------------------------------------- tools

  private async onToolCall(p: any): Promise<unknown> {
    const convId = this.byThread.get(p?.threadId) ?? this.childOf.get(p?.threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (l) l.lastEventAt = Date.now();
    const vault = this.d.vault;
    const conv = convId ? await readConv(vault, convId) : null;
    if (!convId || !conv) return { success: false, contentItems: [{ type: "inputText", text: "No conversation for this thread." }] };
    const a = p?.arguments ?? {};
    const name = String(p?.tool ?? "");
    try {
      if (isContextTool(name)) {
        return await handleContextTool(name, a, {
          conv: conv as any,
          setConversationProject: async (slug: string) => {
            await patchMeta(vault, convId, { project: slug });
          },
        });
      }
      switch (name) {
        case "AskUser": {
          const opts = Array.isArray(a.options) ? a.options.map(String).filter(Boolean).slice(0, 6) : [];
          const ans = await this.waitForAnswer(p.threadId, String(a.question ?? "").trim() || "?", opts);
          return text(`Carl answered: ${ans}`);
        }
        case "ScheduleWake": {
          const reason = String(a.reason ?? "").trim() || "scheduled check";
          let at = a.at ? Date.parse(String(a.at)) : NaN;
          if (!Number.isFinite(at)) {
            const ms = parseDelay(a.in);
            if (ms === null) return text("ScheduleWake needs `in` (e.g. \"10m\") or `at` (ISO time).");
            at = Date.now() + ms;
          }
          at = Math.max(at, Date.now() + 5_000);
          addWake(vault, { conv: convId, at, reason });
          if (l) l.flags.wake = true;
          await patchMeta(vault, convId, { nextWakeAt: nextWakeFor(vault, convId) });
          return text(`Wake scheduled for ${new Date(at).toISOString()} ("${reason}"). End your turn now; you'll be woken then.`);
        }
        case "KeepWorking": {
          const on = a.on !== false;
          await patchMeta(vault, convId, { working: on, ...(on && (conv.state === "done" || conv.state === "blocked") ? { state: "running" } : {}) });
          if (!on) this.nudged.delete(convId);
          return text(on ? "Keep-going mode on. End every turn with ScheduleWake, AskUser, Done or Blocked." : "Keep-going mode off.");
        }
        case "Done": {
          if (l) l.flags.done = true;
          const summary = String(a.summary ?? "").trim();
          const evidence = Array.isArray(a.evidence) ? a.evidence.map(String) : [];
          const v = await verifyDone({ conv: conv as any, summary, evidence });
          const line = formatVerdict(v);
          await mutateConv(vault, convId, (c) => {
            c.working = false;
            c.verdict = { verdict: v.verdict, notes: v.notes, at: v.at, summary };
            if (typeof v.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + v.costUsd);
          });
          await this.d.notify({ kind: "info", title: `Done: ${conv.title}`.slice(0, 90), body: `${summary.slice(0, 300)}\n${line}`, convId });
          return text(`Recorded as done. ${line}\nTell Carl the verdict in your reply.`);
        }
        case "Blocked": {
          if (l) l.flags.blocked = true;
          const reason = String(a.reason ?? "").trim();
          await patchMeta(vault, convId, { state: "blocked", working: false });
          await this.d.notify({ kind: "info", title: `Blocked: ${conv.title}`.slice(0, 90), body: reason.slice(0, 600), convId });
          return text("Recorded as blocked; Carl has been notified. End your turn.");
        }
        case "Notify": {
          // At most 4 pings an hour per conversation; past that they go to the
          // feed only (a run "still training normally" 50 times a day is noise).
          const hour = Date.now() - 3_600_000;
          const recent = (this.pings.get(convId) ?? []).filter((t) => t > hour);
          if (recent.length >= 4) {
            this.pings.set(convId, recent);
            return text("Not sent: this conversation already pinged Carl 4 times this hour. Only ping for a decision, a finish, or a real problem; batch the rest into your next reply.");
          }
          this.pings.set(convId, [...recent, Date.now()]);
          const sent = await this.d.notify({ kind: "info", title: String(a.title ?? "vault-chat").slice(0, 90), body: String(a.body ?? "").slice(0, 2000), convId });
          return text(sent ? "Notified." : "Recorded in the feed (no phone subscribed).");
        }
        case "PdfRead":
          return text(await pdfRead(vault, a));
        case "WebSearch":
          return text(await webSearch(String(a.query ?? ""), this.d.apiKey(), this.d.webSearchModel));
        case "StartJob":
          return text(startJob(this.d.jobEnv, vault, a));
        case "JobStatus":
          return text(jobStatus(this.d.jobEnv, a));
        case "TodoWrite": {
          const todos = (Array.isArray(a.todos) ? a.todos : [])
            .slice(0, 30)
            .map((t: any) => ({
              content: String(t?.content ?? "").slice(0, 300),
              status: t?.status === "completed" || t?.status === "in_progress" ? t.status : "pending",
              ...(t?.activeForm ? { activeForm: String(t.activeForm).slice(0, 300) } : {}),
            }))
            .filter((t: { content: string }) => t.content.trim());
          await patchMeta(vault, convId, { todos });
          const n = (st: string) => todos.filter((t: { status: string }) => t.status === st).length;
          return text(`updated: ${todos.length} items (${n("completed")} done, ${n("in_progress")} active, ${n("pending")} pending)`);
        }
        case "Cost": {
          if (a.project) {
            const pc = projectCost(String(a.project), (await allConvs(vault)) as any);
            return text(pc ? `Project ${pc.name}: $${pc.totalUsd.toFixed(4)} over ${pc.parts.length} conversation(s)${pc.missingCalls ? ` (${pc.missingCalls} call(s) without a cost)` : ""}.` : `No project "${a.project}".`);
          }
          const target = a.conversation ? await readConv(vault, String(a.conversation)) : conv;
          if (!target) return text(`No conversation ${a.conversation}.`);
          return text(`Conversation "${target.title}": $${(target.costUsd ?? 0).toFixed(4)}${target.costMissingCalls ? ` (+${target.costMissingCalls} call(s) without a cost)` : ""}. (Costs land a few seconds after each turn.)`);
        }
        default:
          return { success: false, contentItems: [{ type: "inputText", text: `Unknown tool ${name}.` }] };
      }
    } catch (e) {
      return { success: false, contentItems: [{ type: "inputText", text: `${name} failed: ${(e as Error).message}` }] };
    }
  }

  /** Park the turn on a question until Carl answers (via /message or /answer). */
  private async waitForAnswer(threadId: string, question: string, options: string[]): Promise<string> {
    const convId = this.byThread.get(threadId) ?? this.childOf.get(threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (!convId || !l) return "No one is available to answer right now. Continue with your best judgement and say what you assumed.";
    const vault = this.d.vault;
    const conv = await readConv(vault, convId);
    // Show what was said so far plus the question as an assistant message.
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
      l.ask = { resolve, question };
    });
    await appendMessage(vault, convId, msg, { state: "waiting_user", pendingAsk: { question, options, at: Date.now() } });
    setLive(this.d.vault, convId, false);
    await this.d.notify({ kind: "ask", title: (conv?.title ? `Needs you: ${conv.title}` : "Needs your call").slice(0, 90), body: question, convId, options });
    return p;
  }

  private async answer(convId: string, answer: string): Promise<void> {
    const vault = this.d.vault;
    const l = this.live.get(convId);
    const conv = await readConv(vault, convId);
    await appendMessage(vault, convId, { role: "user", content: answer, direct: true, decision: true }, { pendingAsk: undefined, state: l?.ask ? "running" : conv?.state === "waiting_user" ? "idle" : conv?.state });
    this.nudged.delete(convId);
    if (l?.ask) {
      const a = l.ask;
      l.ask = null;
      l.lastEventAt = Date.now();
      setLive(this.d.vault, convId, true);
      a.resolve(answer);
      return;
    }
    // The turn that asked is gone (restart): a new turn carries the answer.
    const q = conv?.pendingAsk?.question;
    void this.run(convId, q ? `Carl's answer to your question "${q}": ${answer}` : answer, "user", { alreadyAppended: true });
  }

  // ---------------------------------------------------------------- wakes & watchdog

  private async tickWakes(): Promise<void> {
    const now = Date.now();
    const due = readWakes(this.d.vault).filter((w) => w.at <= now && !this.firing.has(w.id));
    for (const w of due) {
      const l = this.live.get(w.conv);
      if (l?.ask) continue; // waiting on Carl: the wake waits too
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
    await this.run(w.conv, `Wake: ${w.reason}`, "wake").catch((e) => this.log(`wake failed: ${e}`));
  }

  private tickWatchdog(): void {
    const stall = this.d.stallMs ?? 30 * 60_000;
    const now = Date.now();
    for (const l of this.live.values()) {
      if (l.ask || l.finished || l.stalled) continue;
      if (now - l.lastEventAt > stall) {
        l.stalled = true;
        this.log(`watchdog: ${l.convId} silent for ${Math.round((now - l.lastEventAt) / 1000)} s — interrupting`);
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
function errText(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message ?? JSON.stringify(e)).slice(0, 500);
}

