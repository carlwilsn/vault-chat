// The engine: every agent turn on the box runs in pi (pi/backend.ts). A
// conversation maps to one pi session ("thread"; a new one after a roll-over);
// each turn's events become the existing message shapes in the conversation
// file, and the live run is mirrored into the store so the phone host emits the
// /poll events the phone already renders. vault-chat's own tools reach pi
// through its extension as host calls.
import { appendFileSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
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
import { startJob, jobStatus, jobList, jobStop, reapJobs, type PiJobEnv } from "./pi/jobs";
import { ENGINE_ROLE_PROMPT } from "./prompt";
import { capabilitiesOf, capabilityNote, learn } from "./capabilities";
import { join } from "node:path";
import { StreamWire } from "../../src/streamWire";
import { COMPACTION_DIVIDER_TEXT } from "../../src/chatContext";
import { activitySummary, appendActivity, contextImage } from "../activity";
import { CAPTURE_FRESH_MS, chatExchangeEntry } from "../../src/activityCore";

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
  /** When the turn's ScheduleWake set its wake (ISO), and the tool calls the model made after it. */
  wakeAt: string | null;
  afterWake: number;
  /** The turn was ended by the engine after a ScheduleWake (the model kept going): not "stopped". */
  endedAfterWake: boolean;
  ask: { resolve: (answer: string) => void; question: string } | null;
  /** Tool calls in flight (started, no result yet): while one is open the watchdog waits for its own timeout. */
  open: Map<string, { name: string; input: any }>;
  /** The message that carried the last question (its tool calls were moved there): a late result lands on it. */
  asked: { mid: string; ids: Set<string> } | null;
  /** Text items closed into a message mid-stream (a steer): what of each was already shown there. */
  closedTexts?: Map<string, string>;
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
const INTERRUPTED_TEXT = "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.";
/** Tool calls a turn may still make after ScheduleWake: only ending it differently. */
const AFTER_WAKE_OK = new Set(["Done", "Blocked"]);
/** Tool calls after ScheduleWake before the engine ends the turn itself. */
const AFTER_WAKE_MAX = 2;
/** How much longer than an open tool call's own timeout the watchdog waits. */
const TOOL_MARGIN_MS = 5 * 60_000;
export const wakeRefusal = (at: string) => `You scheduled a wake for ${at}. End your turn now; you'll be woken then.`;

// The server is going down (SIGTERM/SIGINT): pi's processes die with it, and
// that is not a crash. A turn cut by the shutdown is left "running" in its file
// for the next boot to resume once; nothing is finished or resumed here.
let shuttingDown = false;
export function engineShuttingDown(on = true): void {
  shuttingDown = on;
}

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
      "Start a long-running shell command that must outlive this turn (training, downloads, builds). It runs detached, sandboxed, in the vault, with a memory ceiling and a low CPU share; output goes to a log. It is stopped after `timeout` (default \"24h\", at most \"7d\"). At most 4 run at once in the vault. When it ends, this conversation gets a wake turn with its exit code and last lines. Returns a job id.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, name: { type: "string" }, timeout: { type: "string", description: "e.g. \"36h\", \"90m\"; default 24h, max 7d" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "JobList",
    description: "This conversation's jobs (all: true for every job in the vault): id, state, age, command.",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "JobStop",
    description: "Stop a running job (its whole process tree).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
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
  /** Messages Carl queued while a turn ran (/message {queue: true}): each runs, in order, after it ends. */
  private queued = new Map<string, Array<{ id: string; body: Record<string, any> }>>();
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
  /** The shared activity stream: when each conversation last saw it (in memory; after a restart a turn sees the whole window again). */
  private activitySeen = new Map<string, number>();
  /** Captures already sent to each conversation's model (in memory): one is never attached twice. */
  private imagesGiven = new Map<string, Set<string>>();
  /** The rules each thread last received (its instructions at start, or a turn's prefix): a turn repeats them only when they changed. In memory; after a restart a resumed thread gets them once more. */
  private rulesSent = new Map<string, string>();
  private jobLogs = new Map<string, string[]>(); // convId → its StartJob logs

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
    this.timers.push(setInterval(() => this.scoped(() => void this.tickJobs()), 15_000));
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
          // One marker per cut: not again when the last message already says so (or is the resume prompt).
          const last = [...(c.messages ?? [])].reverse().find((m: any) => !m.hidden);
          const marked = !!last && (String(last.content ?? "").includes(INTERRUPTED_TEXT) || (last.system && String(last.content ?? "").includes(RESUME_TEXT)));
          if (!marked) await appendMessage(this.d.vault, c.id, { role: "assistant", content: INTERRUPTED_TEXT, failed: true });
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
   * queue: while a turn runs, hold the message until it ends (→ {queued: true, qid});
   * the conversation's `queued` lists what waits. unqueue: qid — take it back.
   */
  async message(body: {
    convId?: string | null;
    text?: string;
    project?: string;
    context?: string;
    images?: { name?: string; mime?: string; dataBase64?: string }[];
    imagePaths?: string[];
    /** Who started it: "voice" (the voice agent's AskAgent); a phone chat otherwise. */
    source?: string;
    /** Hold it until the running turn ends (a follow-up), instead of steering. */
    queue?: boolean;
    /** Take back a queued message (its qid). */
    unqueue?: string;
  }): Promise<Record<string, unknown> | null> {
    if (typeof body?.unqueue === "string" && body.convId) {
      const list = this.queued.get(body.convId) ?? [];
      const hit = list.find((q) => q.id === body.unqueue);
      if (!hit) return { ok: false, error: "already delivered" };
      await this.setQueued(body.convId, list.filter((q) => q !== hit));
      return { ok: true, convId: body.convId, unqueued: body.unqueue };
    }
    if (body?.queue && body.convId) {
      const l = this.live.get(body.convId);
      if (l && !l.finished && !l.ask) {
        const textQ = String(body.text ?? "").trim();
        if (!textQ && !(body.images?.length || body.imagePaths?.length)) return { error: "empty message" };
        const qid = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const { queue: _q, ...rest } = body;
        await this.setQueued(body.convId, [...(this.queued.get(body.convId) ?? []), { id: qid, body: rest }]);
        return { ok: true, convId: body.convId, queued: true, qid };
      }
      // Nothing running (it just ended): an ordinary message.
    }
    const textIn = String(body?.text ?? "").trim();
    const hasImages = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0) > 0;
    if (!textIn && !hasImages) return { error: "empty message" };
    let conv: EngineConv | null = null;
    if (body.convId) {
      conv = await readConv(this.d.vault, body.convId);
      if (!conv) return { error: `conversation ${body.convId} not found` };
      if (LEGACY_SOURCES.has(conv.source)) return null;
    } else {
      conv = await createConv(this.d.vault, body.source === "voice" ? { source: "voice" } : {}, textIn || "Image");
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
    let context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    const shown = textIn || "(image)";
    // "This plot", "what I circled": the latest capture itself goes with the turn (one, capped), once per chat.
    const given = this.imagesGiven.get(id) ?? new Set<string>();
    this.imagesGiven.set(id, given);
    if (paths.length) {
      // The message carries its own image — most likely that capture: never sent again.
      const latest = contextImage(this.d.vault, "the image", {});
      if (latest && Date.now() - latest.entry.ts <= CAPTURE_FRESH_MS) given.add(latest.rel);
    } else if (textIn) {
      const img = contextImage(this.d.vault, textIn, { deictic: true, exclude: given });
      if (img) {
        given.add(img.rel);
        paths.push(img.abs);
        context = [context, img.caption].filter(Boolean).join("\n\n");
      }
    }
    // The shared stream: this chat's latest exchange (Carl's side now; the reply when the turn ends).
    const now = (await readConv(this.d.vault, id).catch(() => null)) ?? conv;
    const proj = now.project;
    appendActivity(this.d.vault, chatExchangeEntry({ convId: id, title: String(now.title ?? "").trim() || shown, user: shown, agent: null, project: typeof proj === "string" ? proj : null }));
    this.nudged.delete(id);
    // An open question: this message is the answer.
    if (this.live.get(id)?.ask || conv.pendingAsk) {
      await this.answer(id, shown);
      return { ok: true, convId: id, answered: true };
    }
    // A running turn: steer it.
    const l = this.live.get(id);
    if (l && l.turnId && !l.finished) {
      // What the turn showed so far becomes its own message, so Carl's lands
      // after it (as on the laptop) and the rest of the turn after that.
      await this.closeReplySoFar(l);
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

  /** The queue for a conversation, mirrored on it (`queued`: id + text) for the clients. */
  private async setQueued(convId: string, list: Array<{ id: string; body: Record<string, any> }>): Promise<void> {
    if (list.length) this.queued.set(convId, list);
    else this.queued.delete(convId);
    await patchMeta(this.d.vault, convId, { queued: list.map((q) => ({ id: q.id, text: String(q.body.text ?? "").trim() || "(image)" })) } as any).catch(() => undefined);
  }

  /** A turn ended with messages queued: the oldest runs now (as if just sent). */
  private async deliverQueued(convId: string): Promise<boolean> {
    const list = this.queued.get(convId);
    if (!list?.length) return false;
    const [next, ...rest] = list;
    await this.setQueued(convId, rest);
    await this.message({ ...next!.body, convId }).catch((e) => this.log(`queued message on ${convId} failed: ${e}`));
    return true;
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
        wakeAt: null,
        afterWake: 0,
        endedAfterWake: false,
        ask: null,
        asked: null,
        open: new Map(),
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
      // The rules are in the thread already (its instructions, or an earlier prefix): only a change goes in front of the turn.
      const rulesNow = rulesPrefixForTurn(conv as any);
      const rules = this.rulesSent.get(threadId) === rulesNow ? "" : rulesNow;
      this.rulesSent.set(threadId, rulesNow);
      if (opts.context) body = `${opts.context}\n\n${body}`;
      const activity = kind === "user" ? this.activityPrefix(conv) : "";
      const texts = [rules, activity, kind === "wake" ? input : body].filter(Boolean);
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

  /**
   * For a user turn: what Carl did elsewhere (Ctrl+K, Ctrl+L, captures, voice,
   * other chats) since this conversation last saw the stream — the earlier
   * entries are in its thread already. "" when there is nothing new.
   */
  private activityPrefix(conv: EngineConv): string {
    const now = Date.now();
    const block = activitySummary(this.d.vault, {
      now,
      project: typeof conv.project === "string" ? conv.project : null,
      since: this.activitySeen.get(conv.id),
      excludeConv: conv.id,
    });
    this.activitySeen.set(conv.id, now);
    return block ? `${block}\n\n` : "";
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
    this.rulesSent.set(threadId, rulesPrefixForTurn(conv as any)); // the instructions carry them in full
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
      case "text": {
        if (!l.texts.has(e.itemId)) l.order.push(e.itemId);
        // Part of it already closed into its own message (a steer): only the rest is new.
        const shown = l.closedTexts?.get(e.itemId);
        const t = shown && e.text.startsWith(shown) ? e.text.slice(shown.length).replace(/^\s+/, "") : e.text;
        l.texts.set(e.itemId, t);
        this.pushRuntime(l);
        return;
      }
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
        // A call the model made after its ScheduleWake (a new id; the refusal goes back to it).
        // Past AFTER_WAKE_MAX it is not listening: the engine ends the turn.
        if (l.flags.wake && e.result === undefined && !l.toolIndex.has(e.itemId) && !AFTER_WAKE_OK.has(e.name) && !(l.asked?.ids.has(e.itemId))) {
          l.afterWake++;
          if (l.afterWake >= AFTER_WAKE_MAX && !l.endedAfterWake && l.turnId) {
            l.endedAfterWake = true;
            this.log(`turn on ${l.convId} kept calling tools after ScheduleWake (${l.afterWake}); ending it`);
            void this.interrupt(l.convId, false);
          }
        }
        if (e.result === undefined) l.open.set(e.itemId, { name: e.name, input: e.input ?? l.open.get(e.itemId)?.input });
        else l.open.delete(e.itemId);
        if (this.toAskedMessage(l, e.itemId, { name: e.name, input: e.input, result: e.result })) return;
        this.upsertTool(l, e.itemId, { name: e.name, input: e.input, result: e.result });
        this.pushRuntime(l);
        return;
      case "toolProgress":
        // lastEventAt is already bumped: a command streaming output is not a stall.
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
        // Going down: pi was killed with the server; the turn stays "running" for the next boot.
        if (shuttingDown) return;
        void this.finishTurn(l, e.status, e.error);
        return;
      case "threadLost":
        if (shuttingDown) return;
        // Only this thread's runtime died: cut its turn and resume it now (no "up" will follow).
        // pi can die of the shutdown's SIGTERM a moment before the server sees the signal: wait
        // a beat, and leave the turn alone if the server turned out to be going down.
        void new Promise((r) => setTimeout(r, 1500)).then(() => {
          if (shuttingDown || l.finished) return;
          this.scoped(() => this.onThreadLost(l));
        });
        return;
    }
  }

  private onThreadLost(l: Live): void {
    if (l.ask) {
      this.live.delete(l.convId);
      unregisterRun(l.convId, l.controller);
      setLive(this.d.vault, l.convId, false);
      return;
    }
    l.cut = true;
    void this.finishTurn(l, "interrupted", null).then(() => this.run(l.convId, RESUME_TEXT, "resume")).catch((err) => this.log(`resume ${l.convId} failed: ${err}`));
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
    if (i === undefined) {
      // The call was closed into its own message (a steer, a question): the children go there.
      const a = l.asked;
      if (a?.ids.has(itemId)) {
        void mutateConv(this.d.vault, l.convId, (c) => {
          const m: any = c.messages.find((x: any) => x.mid === a.mid);
          const t = m?.toolCalls?.find((x: any) => x.id === itemId);
          if (t) t.subagents = [...new Set([...(t.subagents ?? []), ...children])];
        }).catch(() => undefined);
      }
      return;
    }
    const cur = l.tools[i]!;
    const have = cur.subagents ?? [];
    const add = children.filter((c) => !have.includes(c));
    if (add.length) l.tools[i] = { ...cur, subagents: [...have, ...add] };
  }

  /**
   * A tool event that belongs to the message that asked the last question: the
   * AskUser call (and any call in flight with it) moved there when the turn
   * parked, so its result ("Carl answered: ...") is attached to that entry,
   * never a second AskUser entry in the next message. True when handled.
   */
  private toAskedMessage(l: Live, id: string, t: Omit<ToolRec, "id">): boolean {
    const a = l.asked;
    if (!a || l.toolIndex.has(id)) return false;
    // The result of a call that was in flight when the question was asked (or the AskUser
    // whose start had not arrived yet: a result-only event for it).
    const mine = a.ids.has(id) || (t.name === "AskUser" && t.result !== undefined && (t.input === undefined || t.input === "" || t.input === null));
    if (!mine) return false;
    if (t.result === undefined) return true;
    void mutateConv(this.d.vault, l.convId, (c) => {
      const i = c.messages.findIndex((m) => m.mid === a.mid);
      if (i < 0) return;
      const m: any = { ...c.messages[i] };
      const calls: ToolRec[] = [...(m.toolCalls ?? [])];
      const j = calls.findIndex((x) => x.id === id);
      if (j >= 0) calls[j] = { ...calls[j]!, result: t.result };
      else {
        const k = t.name === "AskUser" ? calls.findIndex((x) => x.name === "AskUser" && x.result === undefined) : -1;
        if (k >= 0) calls[k] = { ...calls[k]!, result: t.result };
        else calls.push({ id, name: t.name, input: t.input ?? {}, result: t.result });
      }
      m.toolCalls = calls;
      c.messages[i] = m;
    }).catch((e) => this.log(`asked message ${a.mid}: ${e}`));
    return true;
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

  /** A steer mid-turn: the reply so far (its text and tool calls) is stored as
   * a message of its own now; the turn's end stores only what came after. A
   * result for a call still in flight lands on that message (toAskedMessage). */
  private async closeReplySoFar(l: Live): Promise<void> {
    const before = this.turnContent(l);
    if (!before.trim() && !l.tools.length) return;
    const mid = newMessageId();
    const open = l.tools.filter((t) => t.id && t.result === undefined).map((t) => t.id!);
    const msg: any = {
      role: "assistant",
      mid,
      content: capStr(before, MSG_CAP),
      ...(l.turnId ? { turnId: l.turnId } : {}),
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
    };
    if (open.length) l.asked = { mid, ids: new Set(open) };
    const closed = l.closedTexts ?? new Map<string, string>();
    for (const k of l.order) closed.set(k, (closed.get(k) ?? "") + (l.texts.get(k) ?? ""));
    l.closedTexts = closed;
    l.order = [];
    l.texts = new Map();
    l.tools = [];
    l.toolIndex = new Map();
    await appendMessage(this.d.vault, l.convId, msg);
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
    } else if (status === "interrupted" && !l.endedAfterWake) {
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
    // The final state, decided once (the file never says idle on the way to blocked).
    // A stalled turn gets a resume turn — twice in a row at most; then it is blocked
    // and Carl hears about it, instead of a silent stall loop.
    const stallN = l.stalled && !l.stopped && !l.cut ? (this.stalls.get(l.convId) ?? 0) + 1 : 0;
    const stuck = stallN > 2;
    // A keep-going conversation whose turn failed (the model or its provider kept
    // erroring after retries) ends blocked with the reason — never idle.
    const failedKeepGoing = !l.cut && stallN === 0 && !!conv0?.working && status === "failed" && !l.stopped;
    // Keep-going rule: a keep-going turn must end in a wake, a question, Done or Blocked;
    // the first time it doesn't it is nudged, the second time it is stopped (blocked).
    const ended = l.flags.wake || l.flags.done || l.flags.blocked || !!conv0?.pendingAsk || !!wakeAt;
    const unended = !l.cut && stallN === 0 && !!conv0?.working && !ended && !l.stopped && status !== "failed";
    const nudgeStop = unended && this.nudged.has(l.convId);
    let state: EngineConv["state"] = l.flags.blocked ? "blocked" : l.flags.done ? "done" : wakeAt ? "sleeping" : "idle";
    if (conv0?.pendingAsk) state = "waiting_user";
    if (stuck || failedKeepGoing || nudgeStop) state = "blocked";
    if (l.cut) state = "running"; // resumed on the next up
    const meta: Partial<EngineConv> = { state, nextWakeAt: wakeAt, ...(stuck || failedKeepGoing ? { working: false } : {}) };
    const hasBody = !!(content.trim() || l.tools.length);
    let conv = hasBody ? await appendMessage(vault, l.convId, msg, meta) : await patchMeta(vault, l.convId, meta);
    setLive(this.d.vault, l.convId, false);
    // The shared stream: this chat's latest exchange, now with the reply (Ctrl+L, Ctrl+K, voice read it).
    if (hasBody && !l.cut && conv) {
      const lastUser = [...(conv.messages ?? [])].reverse().find((m: any) => m.role === "user" && !m.hidden && !m.system && String(m.content ?? "").trim());
      appendActivity(vault, chatExchangeEntry({ convId: l.convId, title: conv.title, user: lastUser?.content ?? "", agent: content, project: typeof conv.project === "string" ? conv.project : null }));
    }
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);

    // Cost, from the rollout's response ids (async; lands a few seconds later).
    void this.settleCost(l.convId, conv?.threadPath ?? conv0?.threadPath, l.turnId, hasBody ? mid : null);

    if (l.cut || !conv) return;

    // Carl queued a follow-up while this turn ran: it goes next, before any resume or nudge.
    // After a stop, the queue waits for Carl (it stays listed on the conversation).
    if (!l.stopped && (await this.deliverQueued(l.convId))) return;

    if (stallN) {
      this.stalls.set(l.convId, stallN);
      if (!stuck) {
        void this.run(l.convId, `Your last turn made no progress for ${Math.round((this.d.stallMs ?? 0) / 60000)} minutes and was interrupted by the watchdog. ${RESUME_TEXT}`, "resume");
        return;
      }
      this.stalls.delete(l.convId);
      await this.d.notify({ kind: "info", title: `Stuck: ${conv.title}`.slice(0, 90), body: "Its turns stopped making progress three times in a row, so it was stopped. Open the chat to see where.", convId: l.convId });
      return;
    }
    if (status === "completed") this.stalls.delete(l.convId);

    if (failedKeepGoing) {
      this.nudged.delete(l.convId);
      await this.d.notify({ kind: "info", title: `Failed: ${conv.title}`.slice(0, 90), body: (content.trim() || "Its last turn failed.").slice(0, 600), convId: l.convId });
      return;
    }

    // Rolling sessions: past the threshold, retire the thread with a recap.
    if (status === "completed" && l.usage && shouldRoll(conv as any, l.usage)) {
      await this.rollOver(conv).catch((e) => this.log(`roll-over failed: ${e}`));
      conv = (await readConv(vault, l.convId)) ?? conv;
    }

    // Keep-going rule (decided above).
    if (ended) this.nudged.delete(l.convId);
    if (unended) {
      if (!nudgeStop) {
        this.nudged.add(l.convId);
        void this.run(l.convId, NUDGE_TEXT, "nudge");
      } else {
        this.nudged.delete(l.convId);
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
    this.activitySeen.delete(conv.id); // the new thread has seen nothing: its first turn gets the whole block
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
    // After ScheduleWake the turn is over: only Done or Blocked may still end it differently.
    if (l?.flags.wake && l.wakeAt && !AFTER_WAKE_OK.has(name)) return { success: false, contentItems: [{ type: "inputText", text: wakeRefusal(l.wakeAt) }] };
    try {
      if (isContextTool(name)) {
        return await handleContextTool(name, a, {
          conv: conv as any,
          setConversationProject: async (slug: string) => {
            await patchMeta(vault, convId, { project: slug });
          },
          // SetProject only proposes: Carl answers an AskUser card, like AskUser's own.
          ask: async (question: string, options: string[]) => {
            if (!this.live.get(convId)) throw new Error("Carl cannot be asked right now; nothing changed");
            return this.waitForAnswer(p.threadId, question, options);
          },
          patchConversation: async (patch) => {
            await patchMeta(vault, convId, patch as any);
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
          if (l) {
            l.flags.wake = true;
            l.wakeAt = new Date(at).toISOString();
          }
          await patchMeta(vault, convId, { nextWakeAt: nextWakeFor(vault, convId) });
          return text(`Wake set for ${new Date(at).toISOString()} ("${reason}"). Stop now: do not call any more tools this turn.`);
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
          // Done ends the work: no wake of it may run a turn later.
          removeWakes(vault, (w) => w.conv === convId);
          await mutateConv(vault, convId, (c) => {
            c.working = false;
            c.nextWakeAt = undefined;
            c.verdict = { verdict: v.verdict, notes: v.notes, at: v.at, summary };
            if (typeof v.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + v.costUsd);
          });
          await this.d.notify({ kind: "info", title: `Done: ${conv.title}`.slice(0, 90), body: `${summary.slice(0, 300)}\n${line}`, convId });
          return text(`Recorded as done. ${line}\nTell Carl the verdict in your reply.`);
        }
        case "Blocked": {
          if (l) l.flags.blocked = true;
          const reason = String(a.reason ?? "").trim();
          removeWakes(vault, (w) => w.conv === convId);
          await patchMeta(vault, convId, { state: "blocked", working: false, nextWakeAt: undefined });
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
        case "StartJob": {
          const out = startJob(this.d.jobEnv, vault, a, convId);
          // Its log growing counts as this conversation's progress (the watchdog reads its mtime).
          const id = /^Started job (\S+) /.exec(out)?.[1];
          if (id) this.jobLogs.set(convId, [...(this.jobLogs.get(convId) ?? []), join(this.d.jobEnv.logDir, `${id}.log`)].slice(-8));
          return text(out);
        }
        case "JobStatus":
          return text(jobStatus(this.d.jobEnv, a));
        case "JobList":
          return text(jobList(this.d.jobEnv, convId, a.all === true));
        case "JobStop":
          return text(jobStop(this.d.jobEnv, String(a.id ?? "").trim(), convId));
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
    const askMid = newMessageId();
    l.asked = { mid: askMid, ids: new Set(l.tools.filter((t) => t.id && t.result === undefined).map((t) => t.id!)) };
    const msg: any = {
      role: "assistant",
      mid: askMid,
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
    // The question's card in the phone feed is answered too, however the answer came in.
    if (this.markAsksAnswered(convId, answer)) this.d.broadcast?.({ type: "notif" });
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

  /** Write an "answered" record for each of the conversation's unanswered ask notifications. Returns how many. */
  private markAsksAnswered(convId: string, answer: string): number {
    const p = join(this.d.vault, ".vault-chat", "notifications.jsonl");
    let raw = "";
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      return 0;
    }
    const asks: string[] = [];
    const done = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (typeof v?.id !== "string") continue;
        if (v.type === "answered") done.add(v.id);
        else if (!v.type && v.kind === "ask" && v.convId === convId) asks.push(v.id);
      } catch {
        /* partial line */
      }
    }
    const open = [...new Set(asks)].filter((id) => !done.has(id));
    if (!open.length) return 0;
    const ts = Date.now();
    try {
      appendFileSync(p, open.map((id) => JSON.stringify({ type: "answered", id, answer: [...answer].slice(0, 160).join(""), ts }) + "\n").join(""));
    } catch (e) {
      this.log(`notifications: ${(e as Error).message}`);
      return 0;
    }
    return open.length;
  }

  // ---------------------------------------------------------------- wakes & watchdog

  private async tickWakes(): Promise<void> {
    if (shuttingDown) return;
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
    // The work ended (Done or Blocked) after this wake was set: it never runs a turn.
    if (conv.state === "done" || conv.state === "blocked") {
      this.log(`wake ${w.id} → ${w.conv} dropped: the conversation is ${conv.state}`);
      return;
    }
    this.log(`wake ${w.id} → ${w.conv}: ${w.reason}`);
    await this.run(w.conv, `Wake: ${w.reason}`, "wake").catch((e) => this.log(`wake failed: ${e}`));
  }

  /** A job that ended wakes the conversation that started it (never a done or blocked one). */
  async tickJobs(): Promise<void> {
    if (shuttingDown) return;
    let ended: ReturnType<typeof reapJobs> = [];
    try {
      ended = reapJobs(this.d.jobEnv);
    } catch (e) {
      this.log(`jobs: ${(e as Error).message}`);
    }
    for (const j of ended) {
      this.log(`job ${j.id} ended: ${j.state}${j.exit !== undefined ? ` (exit ${j.exit})` : ""}`);
      if (!j.conv) continue;
      const conv = await readConv(this.d.vault, j.conv);
      if (!conv || conv.state === "done" || conv.state === "blocked") continue;
      const how =
        j.state === "finished" ? `finished: exit ${j.exit}` : j.state === "timeout" ? "was stopped by its time limit" : j.state === "stopped" ? "was stopped" : "ended without an exit code (stopped, or killed: out of memory?)";
      const tail = j.tail.split("\n").slice(-30).join("\n").slice(-3000);
      void this.run(j.conv, `Job ${j.id} ${how}.\n--- last output ---\n${tail || "(none)"}`, "wake").catch((e) => this.log(`job wake ${j.conv}: ${e}`));
    }
  }

  /** The silence a turn is allowed: the stall limit, or longer while a tool call that may run longer is open
   * (a Bash command: its own timeout, the extension's default or max, plus a margin). */
  stallLimit(l: Live): number {
    const stall = this.d.stallMs ?? 30 * 60_000;
    let limit = stall;
    for (const t of l.open.values()) {
      if (t.name !== "Bash") continue;
      const def = Number(process.env.VC_PI_SHELL_TIMEOUT_S) || 1800;
      const max = Number(process.env.VC_PI_SHELL_MAX_TIMEOUT_S) || 4 * 3600;
      const asked = Number(t.input?.timeout);
      const s = Number.isFinite(asked) && asked > 0 ? Math.min(asked, max) : def;
      limit = Math.max(limit, s * 1000 + TOOL_MARGIN_MS);
    }
    return limit;
  }

  private tickWatchdog(): void {
    const now = Date.now();
    for (const l of this.live.values()) {
      if (l.ask || l.finished || l.stalled) continue;
      // A job of this conversation writing to its log is progress too.
      for (const p of this.jobLogs.get(l.convId) ?? []) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > l.lastEventAt && m <= now) l.lastEventAt = m;
        } catch {
          /* not written yet */
        }
      }
      const stall = this.stallLimit(l);
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

