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
  readProject,
  projectDir,
  type EngineConv,
  type ThreadTokenUsage,
} from "./context";
import { appendMessage, patchMeta, readConv, allConvs, createConv, mutateConv, setLive, setRuntime, newMessageId } from "./convs";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "./wakes";
import { Ledger } from "./ledger";
import { pdfRead, webSearch } from "./extraTools";
import { startJob, jobStatus, jobList, jobStop, reapJobs, type PiJobEnv } from "./pi/jobs";
import { addTasks, claimTask, finishTask, readTasks, taskCounts, type Task } from "./tasks";
import { mergeWorktree, prepareWorktree, removeWorktree, resolveRepo } from "./worktree";
import { appendJsonl, declaredCommand, longDir, metricLine, parseMetric, pinCommand, plateauOf, readJsonl, readLong, runCommand, saveRunLog, tailOf, tampered, writeLong, type CommandSpec, type MetricSpec, type Sample } from "./long";
import { ENGINE_ROLE_PROMPT } from "./prompt";
import { capabilitiesOf, capabilityNote, learn } from "./capabilities";
import { join } from "node:path";
import { StreamWire } from "../../src/streamWire";
import { COMPACTION_DIVIDER_TEXT } from "../../src/chatContext";
import { activitySummary, appendActivity } from "../activity";

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
type TurnKind = "user" | "wake" | "nudge" | "resume" | "task";

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
    name: "SetCheck",
    description:
      "Set this project's check: the command whose passing gates Done (the server runs it on Done; a failing or changed check refuses Done). Passing = exit 0, or the output matching pass_regex. Pinned when set: you can set it once; after that only Carl can change it (propose a new one with AskUser). A fenced command block in project.md's \"## Done when\" is the same.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, pass_regex: { type: "string" }, timeout_s: { type: "number" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "TaskAdd",
    description: "Add tasks to this project's task queue (for RunWorkers): tasks [{title, notes?, deadline_min? (default 60)}].",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, deadline_min: { type: "number" } }, required: ["title"], additionalProperties: false },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "TaskClaim",
    description: "Claim the next task of the project's queue (or get the one you are on).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "TaskUpdate",
    description:
      "Finish a task: status done (the server runs the project's check for it, when one is declared with {task}), failed (back to the queue; given up after 3 attempts) or todo (release it). note: what you did or why it failed. learning: one line for the other workers (shared learnings.md).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: ["done", "failed", "todo"] }, note: { type: "string" }, learning: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "TaskList",
    description: "The project's task queue: counts, and the tasks (optionally of one status).",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["todo", "doing", "done", "failed", "gave_up"] } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "RunWorkers",
    description:
      "Start `count` workers (at most 8) on this project's task queue. Each is a conversation of its own that takes a task, works it in a fresh session under its deadline, marks it done or failed, shares a learning, and takes the next — until the queue is empty or the budget is spent. You see their progress in TaskList; you get a wake when they are all finished. model: the workers' model (default the project's cheap one).",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number" },
        model: { type: "string" },
        repo: { type: "string", description: "A git repo (in the vault or ~/agent-work/<vault>/): each worker gets its own worktree and branch; a done task is merged back (a conflict sends it back to the queue)." },
      },
      required: ["count"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "SetMetric",
    description:
      "Set this project's progress metric: a cheap command that prints a number (e.g. the % of functions matched). The server samples it every every_min minutes (default 15) while the project has work going, shows it to Carl, and alerts him when it has not risen in window_h hours of work (default 6). Pinned like the check: once set, only Carl changes it. A fenced command block under \"## Progress metric\" in project.md is the same.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, every_min: { type: "number" }, window_h: { type: "number" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "SetBudget",
    description:
      "Ask Carl to cap the model spend (USD) of this conversation or its project. He approves or declines. Past 80% you are told before each turn; at 100% the work stops (blocked) until he raises it.",
    inputSchema: {
      type: "object",
      properties: { usd: { type: "number" }, scope: { type: "string", enum: ["conversation", "project"] }, reason: { type: "string" } },
      required: ["usd"],
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
  /** The shared activity stream: when each conversation last saw it (in memory; after a restart a turn sees the whole window again). */
  private activitySeen = new Map<string, number>();
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
    this.timers.push(setInterval(() => this.scoped(() => void this.tickMetrics()), 60_000));
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
  }): Promise<Record<string, unknown> | null> {
    const textIn = String(body?.text ?? "").trim();
    const hasImages = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0) > 0;
    if (!textIn && !hasImages) return { error: "empty message" };
    let conv: EngineConv | null = null;
    if (body.convId) {
      conv = await readConv(this.d.vault, body.convId);
      if (!conv) return { error: `conversation ${body.convId} not found` };
      if (LEGACY_SOURCES.has(conv.source) && !conv.parent) return null;
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
    const context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    const shown = textIn || "(image)";
    // The shared stream: a pointer to this chat (its messages are stored already).
    const now = (await readConv(this.d.vault, id).catch(() => null)) ?? conv;
    const title = String(now.title ?? "").trim();
    const proj = now.project;
    appendActivity(this.d.vault, {
      kind: "chat",
      modality: "chat",
      text: `Chat "${(title || shown).slice(0, 120)}"`,
      convId: id,
      ...(typeof proj === "string" && proj ? { project: proj } : {}),
    });
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
    if (!conv || (LEGACY_SOURCES.has(conv.source) && !conv.parent)) return null;
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
    if (!conv || (LEGACY_SOURCES.has(conv.source) && !conv.parent)) return null;
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
      // Past its budget, only Carl's own messages still run a turn.
      const bud = this.budgetOf(conv);
      if (bud && bud.frac >= 1 && kind !== "user") {
        await this.budgetReached(conv, bud);
        return;
      }
      if (!opts.alreadyAppended) {
        const visible: ChatMessage =
          kind === "user"
            ? { role: "user", content: input, direct: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }
            : { role: "user", content: kind === "wake" ? `⏰ ${input}` : kind === "task" ? `▶ ${input}` : `↻ ${input}`, system: true };
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
      const rules = rulesPrefixForTurn(conv as any);
      if (opts.context) body = `${opts.context}\n\n${body}`;
      const activity = kind === "user" ? this.activityPrefix(conv) : "";
      const texts = [rules, this.turnNotes(conv), activity, kind === "wake" ? input : body].filter(Boolean);
      // Images on a model that can't see: this turn (silently) uses the vision model.
      let model = this.modelOf(conv);
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
    const model = this.modelOf(conv);
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
      cwd: typeof conv.long?.cwd === "string" ? conv.long.cwd : this.d.vault,
      model,
      instructions,
      tools: [...ENGINE_TOOL_SPECS, ...contextToolSpecs] as any,
      subagents,
    });
    this.byThread.set(threadId, conv.id);
    // History from before this thread (a legacy chat, or a retry on a fresh thread): hand it over once.
    const old = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim()).slice(0, -1);
    // (A worker's thread is fresh per task: nothing is handed over.)
    if (old.length && !conv.messages.some((m: any) => m.rollover) && !conv.parent) {
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
    if (i === undefined) return;
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
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);

    // Cost, from the rollout's response ids (async; lands a few seconds later).
    void this.settleCost(l.convId, conv?.threadPath ?? conv0?.threadPath, l.turnId, hasBody ? mid : null);

    if (l.cut || !conv) return;

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

    // A worker (RunWorkers) runs its own loop — the next task, in a fresh session — not the keep-going rule.
    if (conv.parent && conv.source === "worker") {
      await this.workerAfterTurn(conv, l, status);
      return;
    }

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
    // Past its budget: long work stops here (a turn that is running finishes; its wake never runs).
    const conv = await readConv(this.d.vault, convId);
    const bud = conv ? this.budgetOf(conv) : null;
    if (conv && bud && bud.frac >= 1 && (conv.working || conv.state === "sleeping") && !this.live.has(convId)) await this.budgetReached(conv, bud);
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
          if (conv.parent && conv.source === "worker") return text("A worker finishes its task with TaskUpdate (done or failed), not Done.");
          const summary = String(a.summary ?? "").trim();
          const evidence = Array.isArray(a.evidence) ? a.evidence.map(String) : [];
          // The project's check gates Done: the server runs it; a failing or changed check refuses Done and the work goes on.
          const g = conv.project ? await this.runCheck(conv.project) : null;
          if (g && !g.ok) {
            await mutateConv(vault, convId, (c) => {
              c.working = true;
              c.long = { ...(c.long ?? {}), lastCheck: { ok: false, at: Date.now(), why: g.why } };
            });
            this.nudged.delete(convId);
            const tail = g.out ? `\n--- check output (tail) ---\n${tailOf(g.out, 3000)}` : "";
            return { success: false, contentItems: [{ type: "inputText", text: `Done refused: ${g.why}. Keep-going stays on: fix it, then call Done again (the server reruns the check).${tail}` }] };
          }
          if (l) l.flags.done = true;
          const v = await verifyDone({ conv: conv as any, summary, evidence, ...(g ? { check: { command: g.command, exit: g.code, output: g.out, log: g.log } } : {}) });
          const line = formatVerdict(v);
          // Done ends the work: no wake of it may run a turn later.
          removeWakes(vault, (w) => w.conv === convId);
          await mutateConv(vault, convId, (c) => {
            c.working = false;
            c.nextWakeAt = undefined;
            if (g) c.long = { ...(c.long ?? {}), lastCheck: { ok: true, at: Date.now() } };
            c.verdict = { verdict: v.verdict, notes: v.notes, at: v.at, summary };
            if (typeof v.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + v.costUsd);
          });
          const mline = this.metricNow(conv.project);
          await this.d.notify({ kind: "info", title: `Done: ${conv.title}`.slice(0, 90), body: `${summary.slice(0, 300)}\n${line}${mline ? `\nProgress: ${mline}` : ""}`, convId });
          return text(`Recorded as done.${g ? " The project's check passed." : ""} ${line}\nTell Carl the verdict in your reply.`);
        }
        case "Blocked": {
          // A worker stuck on its task: the attempt fails (with the reason); the loop goes on.
          if (conv.parent && conv.source === "worker") return await this.taskUpdate(conv, { status: "failed", note: `blocked: ${String(a.reason ?? "")}` });
          if (l) l.flags.blocked = true;
          const reason = String(a.reason ?? "").trim();
          removeWakes(vault, (w) => w.conv === convId);
          await patchMeta(vault, convId, { state: "blocked", working: false, nextWakeAt: undefined });
          const mline = this.metricNow(conv.project);
          await this.d.notify({ kind: "info", title: `Blocked: ${conv.title}`.slice(0, 90), body: `${reason.slice(0, 600)}${mline ? `\nProgress: ${mline}` : ""}`, convId });
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
        case "SetCheck": {
          if (!conv.project) return { success: false, contentItems: [{ type: "inputText", text: "SetCheck needs a project: call SetProject first." }] };
          const cur = this.checkSpec(conv.project);
          if (cur) {
            const who = cur.source === "carl" ? "Carl" : cur.source === "agent" ? "you, earlier" : "project.md";
            return { success: false, contentItems: [{ type: "inputText", text: `This project's check is already set (by ${who}): \`${cur.command}\`. Only Carl can change it now; propose a new one with AskUser and he sets it.` }] };
          }
          const command = String(a.command ?? "").trim();
          if (!command) return text("SetCheck needs a command.");
          const spec = pinCommand({ command, passRegex: a.pass_regex ? String(a.pass_regex) : undefined, timeoutS: Number(a.timeout_s) > 0 ? Number(a.timeout_s) : undefined, cwd: vault, source: "agent" });
          writeLong(vault, conv.project, (st) => ({ ...st, check: spec }));
          const files = Object.keys(spec.files);
          return text(`Check set and pinned: \`${command}\`${files.length ? ` (with ${files.join(", ")})` : ""}. Done now runs it on the server; a changed command or file refuses Done.`);
        }
        case "SetMetric": {
          if (!conv.project) return { success: false, contentItems: [{ type: "inputText", text: "SetMetric needs a project: call SetProject first." }] };
          const cur = this.pinned(conv.project, "metric");
          if (cur) return { success: false, contentItems: [{ type: "inputText", text: `This project's metric is already set: \`${cur.command}\`. Only Carl can change it; propose a new one with AskUser.` }] };
          const command = String(a.command ?? "").trim();
          if (!command) return text("SetMetric needs a command that prints a number.");
          const spec: MetricSpec = { ...pinCommand({ command, cwd: vault, source: "agent" }), ...metricOpts(a) };
          writeLong(vault, conv.project, (st) => ({ ...st, metric: spec }));
          const s = await this.sampleMetric(conv.project);
          return text(`Metric set and pinned: \`${command}\`. ${s ? `First sample: ${s.value}${s.unit ?? ""}.` : "It printed no number yet."} The server samples it every ${spec.everyMin ?? 15} min while the project has work going.`);
        }
        case "SetBudget": {
          const usd = Number(a.usd);
          const scope = a.scope === "project" ? "project" : "conversation";
          if (!(usd > 0)) return text("SetBudget needs usd > 0.");
          if (scope === "project" && !conv.project) return text("This conversation has no project; use scope conversation or SetProject first.");
          const q = `Set a ${money(usd)} budget on this ${scope === "project" ? `project (${conv.project})` : "conversation"}?${a.reason ? ` ${String(a.reason).slice(0, 300)}` : ""}`;
          const ans = await this.waitForAnswer(p.threadId, q, ["Approve", "Decline"]);
          if (!/^\s*(approve|yes|y|ok|okay|sure)\b/i.test(ans)) return text(`Carl did not approve the budget (he said: ${ans.slice(0, 200)}).`);
          await this.control(scope === "project" ? { project: conv.project } : { convId }, "budget", { usd });
          return text(`Budget set: ${money(usd)} on this ${scope}. You'll be told at 80%; at 100% the work stops.`);
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
        case "TaskAdd": {
          if (!conv.project) return text("TaskAdd needs a project: call SetProject first.");
          const items = Array.isArray(a.tasks) ? a.tasks : [a];
          const added = addTasks(vault, conv.project, items);
          const c = taskCounts(readTasks(vault, conv.project));
          return text(`Added ${added.length} task(s): ${added.map((t) => t.id).join(", ")}. Queue: ${c.todo} to do, ${c.doing} in progress, ${c.done} done of ${c.total}.`);
        }
        case "TaskClaim": {
          if (!conv.project) return text("TaskClaim needs a project.");
          const t = claimTask(vault, conv.project, convId);
          return text(t ? `Claimed ${t.id} (attempt ${t.attempts}, ${t.deadline_min} min): ${t.title}${t.notes ? `\nNotes: ${t.notes}` : ""}` : "No task left to claim.");
        }
        case "TaskUpdate":
          return await this.taskUpdate(conv, a);
        case "TaskList": {
          if (!conv.project) return text("TaskList needs a project.");
          const list = readTasks(vault, conv.project).filter((t) => !a.status || t.status === a.status);
          const c = taskCounts(readTasks(vault, conv.project));
          const rows = list.slice(0, 60).map((t) => `- ${t.id} [${t.status}${t.attempts ? `, ${t.attempts} attempt(s)` : ""}] ${t.title}`);
          return text(`${c.done}/${c.total} done, ${c.doing} in progress, ${c.todo} to do, ${c.gave_up} given up.\n${rows.join("\n")}${list.length > 60 ? `\n… ${list.length - 60} more` : ""}`);
        }
        case "RunWorkers":
          return text(await this.runWorkers(conv, Number(a.count) || 1, a.model ? String(a.model) : undefined, a.repo ? String(a.repo) : undefined));
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

  // ---------------------------------------------------------------- long-run controls

  /** A project's pinned command (its check or its progress metric): as stored, or project.md's block under
   *  "## Done when" / "## Progress metric", pinned the first time it is seen. */
  pinned(slug: string, kind: "check" | "metric"): CommandSpec | null {
    const st = readLong(this.d.vault, slug);
    if (st[kind]) return st[kind]!;
    const p = readProject(slug);
    const dec = p ? declaredCommand(p.project, PINNED_HEADING[kind]) : null;
    if (!dec) return null;
    const spec = pinCommand({ command: dec.command, passRegex: dec.passRegex, cwd: this.d.vault, source: "project.md" });
    writeLong(this.d.vault, slug, (s) => ({ ...s, [kind]: s[kind] ?? spec }));
    this.log(`project ${slug}: ${kind} pinned from project.md`);
    return spec;
  }

  checkSpec(slug: string): CommandSpec | null {
    return this.pinned(slug, "check");
  }

  /** Null when the pinned command and its files are as set; else what changed. */
  private changed(slug: string, kind: "check" | "metric", spec: CommandSpec): string | null {
    const p = readProject(slug);
    const declared = spec.source === "project.md" ? (p ? (declaredCommand(p.project, PINNED_HEADING[kind])?.command ?? "") : "") : null;
    return tampered(spec, declared);
  }

  /** Run the project's check (null: it has none). Refused, not run, when its command or files changed since it was set. */
  async runCheck(slug: string, extraEnv?: Record<string, string>): Promise<{ ok: boolean; why: string; out: string; code: number | null; command: string; log?: string } | null> {
    const spec = this.checkSpec(slug);
    if (!spec) return null;
    const bad = this.changed(slug, "check", spec);
    if (bad) return { ok: false, why: `the project's check was changed (${bad}); it was not run, and only Carl can re-set it`, out: "", code: null, command: spec.command };
    let command = spec.command;
    if (extraEnv?.VC_TASK) command = command.split("{task}").join(extraEnv.VC_TASK);
    if (extraEnv?.VC_WORKTREE) command = command.split("{worktree}").join(extraEnv.VC_WORKTREE);
    const r = await runCommand(this.d.jobEnv, { command, cwd: this.d.vault, timeoutMs: checkTimeoutMs(spec), passRegex: spec.passRegex, extraEnv });
    if (r.refused) return { ok: false, why: `the check could not run: ${r.refused}`, out: "", code: null, command };
    const log = saveRunLog(this.d.vault, slug, "check", r, command);
    const why = r.ok
      ? "passed"
      : r.timedOut
        ? "the project's check timed out"
        : spec.passRegex
          ? `the project's check output did not match ${spec.passRegex} (exit ${r.code})`
          : `the project's check failed (exit ${r.code})`;
    return { ok: r.ok, why, out: r.out, code: r.code, command, log };
  }

  private sampling = new Set<string>();

  private metricSeries(slug: string): Sample[] {
    return readJsonl<Sample>(join(longDir(this.d.vault, slug), "metric.jsonl"));
  }

  /** The project's metric line now ("62.4% · +1.8 today"), or null. */
  metricNow(slug: string | undefined, now = Date.now()): string | null {
    return slug ? metricLine(this.metricSeries(slug), now) : null;
  }

  /**
   * Sample a project's progress metric: run its pinned command (sandboxed, at most 5 min), store the
   * number it printed, refresh the line on its conversations, and alert once when it has stopped rising.
   */
  async sampleMetric(slug: string, at = Date.now()): Promise<Sample | null> {
    const spec = this.pinned(slug, "metric") as MetricSpec | null;
    if (!spec || this.sampling.has(slug)) return null;
    const bad = this.changed(slug, "metric", spec);
    if (bad) {
      this.log(`project ${slug}: metric not run (${bad})`);
      return null;
    }
    this.sampling.add(slug);
    try {
      const r = await runCommand(this.d.jobEnv, { command: spec.command, cwd: this.d.vault, timeoutMs: Math.min(spec.timeoutS ?? 300, 3600) * 1000 });
      const m = r.refused || r.timedOut ? null : parseMetric(r.out);
      if (!m) {
        this.log(`project ${slug}: metric gave no number (${r.refused ?? (r.timedOut ? "timed out" : `exit ${r.code}`)})`);
        return null;
      }
      const s: Sample = { at, value: m.value, ...(m.unit ? { unit: m.unit } : {}) };
      appendJsonl(join(longDir(this.d.vault, slug), "metric.jsonl"), s);
      const series = this.metricSeries(slug);
      const line = metricLine(series, at);
      for (const c of await allConvs(this.d.vault)) {
        const active = c.working || c.state === "running" || c.state === "sleeping" || c.state === "waiting_user";
        if (c.project !== slug || !active || c.long?.metric === line) continue;
        await mutateConv(this.d.vault, c.id, (x) => {
          x.long = { ...(x.long ?? {}), metric: line ?? undefined };
        });
      }
      await this.checkPlateau(slug, spec, series);
      return s;
    } finally {
      this.sampling.delete(slug);
    }
  }

  /** No rise in `windowH` hours of work: one push per best value, and the agent is told before its turns. */
  private async checkPlateau(slug: string, spec: MetricSpec, series: Sample[]): Promise<void> {
    const windowH = spec.windowH ?? 6;
    const p = plateauOf(series, spec.everyMin ?? 15, windowH);
    if (!p) return;
    const st = readLong(this.d.vault, slug);
    if (st.plateau && st.plateau.best === p.best && st.plateau.since === p.since) return;
    writeLong(this.d.vault, slug, (s) => ({ ...s, plateau: { best: p.best, since: p.since, alertedAt: Date.now() } }));
    const convs = (await allConvs(this.d.vault)).filter((c) => c.project === slug && !c.parent).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const conv = convs.find((c) => c.working) ?? convs[0];
    if (!conv) return;
    const unit = series.at(-1)?.unit ?? "";
    await this.d.notify({
      kind: "info",
      title: `No progress in ${windowH} h: ${conv.title}`.slice(0, 90),
      body: `The progress metric has not risen past ${p.best}${unit} in ${Math.round(p.activeMs / 360_000) / 10} h of work.`,
      convId: conv.id,
    });
  }

  /** Every minute: sample the metric of each project with work going, when its interval is up. */
  private async tickMetrics(now = Date.now()): Promise<void> {
    if (shuttingDown) return;
    const active = new Set<string>();
    for (const c of await allConvs(this.d.vault).catch(() => [])) if (c.project && (c.working || c.state === "running" || c.state === "sleeping")) active.add(c.project);
    for (const slug of active) {
      const spec = readLong(this.d.vault, slug).metric ?? (this.pinned(slug, "metric") as MetricSpec | null);
      if (!spec) continue;
      const last = this.metricSeries(slug).at(-1);
      if (last && now - last.at < (spec.everyMin ?? 15) * 60_000 - 5_000) continue; // a tick a few ms early still samples
      void this.sampleMetric(slug).catch((e) => this.log(`metric ${slug}: ${e}`));
    }
  }

  // ---------------------------------------------------------------- the task queue and its workers

  private workerNudged = new Set<string>();
  /** A live worker's task deadline (ms). */
  private workerDeadline = new Map<string, number>();

  /** The model a conversation's turns run on: a worker's own (its task's tier), else the box's. */
  private modelOf(conv: EngineConv): string {
    return typeof conv.long?.model === "string" && conv.long.model ? conv.long.model : this.d.model();
  }

  private appendLearning(slug: string, taskId: string, line: string): void {
    const p = join(projectDir(slug), "learnings.md");
    mkdirSync(projectDir(slug), { recursive: true });
    const head = existsSync(p) ? "" : "# Learnings\n\nOne line per task, from the workers.\n\n";
    appendFileSync(p, `${head}- [${taskId}] ${line.replace(/\s+/g, " ").trim().slice(0, 500)}\n`);
  }

  private learningsTail(slug: string, n = 3000): string {
    try {
      const t = readFileSync(join(projectDir(slug), "learnings.md"), "utf8").trim();
      return t.length > n ? `…${t.slice(-n)}` : t;
    } catch {
      return "";
    }
  }

  /** TaskUpdate (and a worker's Blocked): finish an attempt of a task. */
  private async taskUpdate(conv: EngineConv, a: any): Promise<unknown> {
    const vault = this.d.vault;
    const slug = conv.project;
    if (!slug) return text("TaskUpdate needs a project.");
    const id = String(a.id ?? "").trim() || readTasks(vault, slug).find((t) => t.status === "doing" && t.worker === conv.id)?.id;
    const t = id ? readTasks(vault, slug).find((x) => x.id === id) : undefined;
    if (!t) return text(`No task ${id ?? "in progress"}.`);
    if (t.status !== "doing") return text(`Task ${t.id} is ${t.status}, not in progress.`);
    const status = a.status === "done" ? "done" : a.status === "todo" ? "todo" : "failed";
    let note = String(a.note ?? "");
    if (status === "done") {
      // The project's oracle, per task: a check whose command names {task}.
      const spec = this.checkSpec(slug);
      const wt = typeof conv.long?.cwd === "string" && conv.long.repo ? conv.long.cwd : undefined;
      if (spec?.command.includes("{task}")) {
        const g = await this.runCheck(slug, { VC_TASK: t.id, ...(wt ? { VC_WORKTREE: wt } : {}) });
        if (g && !g.ok) {
          const tail = g.out ? `\n--- check output (tail) ---\n${tailOf(g.out, 3000)}` : "";
          return { success: false, contentItems: [{ type: "inputText", text: `Not done: ${g.why} for ${t.id}. Fix it and call TaskUpdate done again, or mark it failed.${tail}` }] };
        }
      }
    }
    if (typeof a.learning === "string" && a.learning.trim()) this.appendLearning(slug, t.id, a.learning);
    const max = readLong(vault, slug).maxAttempts ?? 3;
    // A worker on a code repo: its worktree's work is committed and merged back; a conflict sends the task back.
    const repo = typeof conv.long?.repo === "string" ? conv.long.repo : "";
    if (status === "done" && repo && conv.parent) {
      const m = mergeWorktree(repo, conv.id, `task ${t.id}: ${t.title}`.slice(0, 200));
      if (!m.ok && m.conflict) {
        finishTask(vault, slug, t.id, "todo", `merge conflict with the repo (${m.out}); redo it on the current HEAD`, max);
        this.workerNudged.delete(conv.id);
        this.workerDeadline.delete(conv.id);
        await this.refreshParent(conv.parent);
        return text(`Task ${t.id} could not be merged: ${m.out}. It is back in the queue (to redo on the current code). Stop now.`);
      }
      if (!m.ok) return { success: false, contentItems: [{ type: "inputText", text: `Not done: merging the worktree failed (${m.out}).` }] };
      note = `${note}${note ? " " : ""}(${m.merged ? `merged: ${m.out}` : "no changes to merge"})`;
    }
    const after = finishTask(vault, slug, t.id, status, note, max);
    this.workerNudged.delete(conv.id);
    this.workerDeadline.delete(conv.id);
    if (conv.parent) await this.refreshParent(conv.parent);
    const worker = conv.parent && conv.source === "worker";
    return text(`Task ${t.id}: ${after?.status}.${worker ? " Stop now; the server gives you the next task in a fresh session." : ""}`);
  }

  /** RunWorkers: start worker conversations on the project's queue. */
  async runWorkers(parent: EngineConv, count: number, model?: string, repoPath?: string): Promise<string> {
    const vault = this.d.vault;
    const slug = parent.project;
    if (!slug) return "RunWorkers needs a project: call SetProject first.";
    let repo: string | undefined;
    if (repoPath) {
      const r = resolveRepo(vault, repoPath);
      if ("error" in r) return `Not started: ${r.error}.`;
      repo = r.repo;
    }
    if (parent.parent) return "A worker cannot start workers.";
    const c = taskCounts(readTasks(vault, slug));
    if (!c.todo) return "The task queue has nothing to do: add tasks with TaskAdd first.";
    const mine = (await allConvs(vault)).filter((w) => w.parent === parent.id && w.working);
    const n = Math.max(0, Math.min(Math.floor(count), 8 - mine.length, c.todo));
    if (!n) return `Not started: ${mine.length} workers are already running for this conversation (at most 8).`;
    const st = readLong(vault, slug);
    const cheap = model || st.models?.cheap || process.env.VC_WORKER_MODEL || this.d.model();
    const p = readProject(slug);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = await createConv(vault, { source: "worker" as any, parent: parent.id, project: slug, working: true, long: { cheap, ...(repo ? { repo } : {}) } }, `Worker ${mine.length + i + 1} · ${p?.name ?? slug}`);
      ids.push(w.id);
    }
    for (const id of ids) await this.workerNext(id);
    await this.refreshParent(parent.id);
    return `Started ${n} worker(s) on ${c.todo} task(s) (model ${cheap}${repo ? `; each in its own git worktree of ${repo}, merged back per task` : ""}). They work until the queue is empty or the budget is spent; you get a wake when they are all finished. TaskList shows progress.`;
  }

  private taskPrompt(slug: string, t: Task, max: number, wt?: { path: string; repo: string }): string {
    const p = readProject(slug);
    const learned = this.learningsTail(slug);
    return [
      `You are a worker on project "${p?.name ?? slug}", one of several working through its task queue. This is a fresh session for one task.`,
      `Task ${t.id} (attempt ${t.attempts} of ${max}; deadline ${t.deadline_min} min): ${t.title}`,
      wt ? `Work in ${wt.path}: your own git worktree of ${wt.repo}, on the repo's latest code. Don't touch ${wt.repo} itself; when you mark the task done the server commits your changes and merges them in.` : "",
      t.notes ? `Notes (from Carl and earlier attempts):\n${t.notes}` : "",
      learned ? `What other workers learned (learnings.md, latest):\n${learned}` : "",
      `Do the task. Then call TaskUpdate {id:"${t.id}", status:"done" or "failed", note: what you did or why it failed, learning: one line the other workers should know}. Then stop: the server gives you the next task in a fresh session. Do not work on other tasks.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** A worker takes its next task in a fresh session — or ends (queue empty, budget spent). */
  async workerNext(wid: string): Promise<void> {
    const vault = this.d.vault;
    const conv = await readConv(vault, wid);
    if (!conv?.project || !conv.working) return;
    const bud = this.budgetOf(conv);
    if (bud && bud.frac >= 1) return this.endWorker(conv, "the budget is spent");
    const t = claimTask(vault, conv.project, wid);
    if (!t) return this.endWorker(conv, "the queue is empty");
    const st = readLong(vault, conv.project);
    const max = st.maxAttempts ?? 3;
    const model = this.taskModel(conv, t, max);
    const repo = typeof conv.long?.repo === "string" ? conv.long.repo : "";
    let cwd: string | undefined;
    if (repo) {
      const w = prepareWorktree(repo, wid);
      if ("error" in w) {
        finishTask(vault, conv.project, t.id, "todo", "", max);
        return this.endWorker(conv, `its worktree failed: ${w.error}`);
      }
      cwd = w.path;
    }
    const from = conv.threadId;
    await mutateConv(vault, wid, (c) => {
      c.threadId = undefined;
      c.threadPath = undefined;
      c.long = { ...(c.long ?? {}), model, task: t.id, ...(cwd ? { cwd } : {}) };
    });
    if (from) this.byThread.delete(from);
    this.workerNudged.delete(wid);
    this.workerDeadline.set(wid, (t.claimedAt ?? Date.now()) + t.deadline_min * 60_000);
    if (conv.parent) await this.refreshParent(conv.parent);
    void this.run(wid, this.taskPrompt(conv.project, t, max, cwd ? { path: cwd, repo } : undefined), "task").catch((e) => this.log(`worker ${wid}: ${e}`));
  }

  /** The model for a task's attempt: the worker's cheap one; after `escalateAfter` (2) failed attempts, the project's strong one. */
  private taskModel(conv: EngineConv, t: Task, _max: number): string {
    const cheap = (conv.long?.cheap as string) || this.d.model();
    const m = conv.project ? readLong(this.d.vault, conv.project).models : undefined;
    const after = m?.escalateAfter ?? 2;
    if (after > 0 && (t.failures ?? 0) >= after) return m?.strong || process.env.VC_WORKER_STRONG_MODEL || this.d.model();
    return cheap;
  }

  private async endWorker(conv: EngineConv, why: string): Promise<void> {
    this.workerDeadline.delete(conv.id);
    if (typeof conv.long?.repo === "string") removeWorktree(conv.long.repo, conv.id);
    await appendMessage(this.d.vault, conv.id, { role: "assistant", system: true, content: `Worker finished: ${why}.` }, { state: "done", working: false, nextWakeAt: undefined });
    removeWakes(this.d.vault, (w) => w.conv === conv.id);
    if (!conv.parent) return;
    await this.refreshParent(conv.parent);
    const parent = await readConv(this.d.vault, conv.parent);
    const still = (await allConvs(this.d.vault)).some((w) => w.parent === conv.parent && w.working);
    if (!parent || still || parent.state === "done" || parent.state === "blocked") return;
    const c = taskCounts(readTasks(this.d.vault, conv.project!));
    void this.run(parent.id, `Workers finished (${why}): ${c.done}/${c.total} done, ${c.gave_up} given up, ${c.todo} left to do.`, "wake").catch((e) => this.log(`parent wake: ${e}`));
  }

  /** A worker's turn ended: the next task, a nudge to finish this one, or a failed attempt. */
  private async workerAfterTurn(conv: EngineConv, l: Live, status: string): Promise<void> {
    const vault = this.d.vault;
    const slug = conv.project;
    if (!slug) return;
    if (!conv.working && conv.state === "done") return;
    const t = readTasks(vault, slug).find((x) => x.status === "doing" && x.worker === conv.id);
    if (!t) return this.workerNext(conv.id);
    const late = Date.now() > (t.claimedAt ?? 0) + t.deadline_min * 60_000;
    // Waiting on a job of its own (a wake set): the task stays open until the deadline.
    if (nextWakeFor(vault, conv.id) && !late) return;
    let why = "";
    if (late) why = `deadline (${t.deadline_min} min) passed`;
    else if (status === "failed") why = "the turn failed";
    else if (this.workerNudged.has(conv.id)) why = "ended twice without TaskUpdate";
    if (!why) {
      this.workerNudged.add(conv.id);
      void this.run(conv.id, `Task ${t.id} is still open. Finish it now: TaskUpdate {id:"${t.id}", status:"done" or "failed", note, learning}.`, "nudge");
      return;
    }
    removeWakes(vault, (w) => w.conv === conv.id);
    finishTask(vault, slug, t.id, "failed", why, readLong(vault, slug).maxAttempts ?? 3);
    this.log(`worker ${conv.id}: ${t.id} failed (${why})`);
    await this.workerNext(conv.id);
  }

  /** The parent's line: "4 workers · 37/120 done". */
  async refreshParent(parentId: string): Promise<void> {
    const vault = this.d.vault;
    const parent = await readConv(vault, parentId);
    if (!parent?.project) return;
    const workers = (await allConvs(vault)).filter((w) => w.parent === parentId);
    const active = workers.filter((w) => w.working).length;
    const c = taskCounts(readTasks(vault, parent.project));
    const line = `${active ? `${active} worker${active === 1 ? "" : "s"}` : "workers done"} · ${c.done}/${c.total} done${c.gave_up ? ` · ${c.gave_up} given up` : ""}`;
    if (parent.long?.workers === line) return;
    await mutateConv(vault, parentId, (x) => {
      x.long = { ...(x.long ?? {}), workers: line };
    });
  }

  /** The tightest of the conversation's and its project's budgets: spent, cap, fraction. Null without one. */
  budgetOf(conv: EngineConv): { scope: "conversation" | "project"; spent: number; cap: number; frac: number } | null {
    const out: { scope: "conversation" | "project"; spent: number; cap: number; frac: number }[] = [];
    const cc = conv.long?.budgetUsd;
    if (typeof cc === "number" && cc > 0) out.push({ scope: "conversation", spent: conv.costUsd ?? 0, cap: cc, frac: (conv.costUsd ?? 0) / cc });
    const pc = conv.project ? readLong(this.d.vault, conv.project).budgetUsd : undefined;
    if (conv.project && typeof pc === "number" && pc > 0) {
      const spent = projectCost(conv.project)?.totalUsd ?? 0;
      out.push({ scope: "project", spent, cap: pc, frac: spent / pc });
    }
    return out.sort((a, b) => b.frac - a.frac)[0] ?? null;
  }

  /** The budget is spent: the conversation ends blocked (its wakes cancelled) and Carl hears it once. */
  private async budgetReached(conv: EngineConv, bud: { scope: string; spent: number; cap: number }): Promise<void> {
    const already = conv.state === "blocked" && conv.long?.budgetHit;
    removeWakes(this.d.vault, (w) => w.conv === conv.id);
    const what = `${money(bud.spent)} of the ${bud.scope}'s ${money(bud.cap)} budget`;
    await appendMessage(
      this.d.vault,
      conv.id,
      { role: "assistant", system: true, content: `Budget reached: ${what}. The work stopped; raise the budget or send a message to go on.` },
      { state: "blocked", working: false, nextWakeAt: undefined, long: { ...(conv.long ?? {}), budgetHit: true } },
    );
    this.log(`budget reached on ${conv.id}: ${what}`);
    if (!already) await this.d.notify({ kind: "info", title: `Budget reached: ${conv.title}`.slice(0, 90), body: `Spent ${what}. It stopped.`, convId: conv.id });
  }

  /** What the agent is told in front of a turn (besides the rules): budget past 80%, a plateau. */
  turnNotes(conv: EngineConv): string {
    const notes: string[] = [];
    const bud = this.budgetOf(conv);
    if (bud && bud.frac >= 0.8) {
      notes.push(
        bud.frac >= 1
          ? `Budget reached: ${money(bud.spent)} of the ${bud.scope}'s ${money(bud.cap)}. Answer Carl; start no new work unless he raises it.`
          : `Budget: ${money(bud.spent)} of the ${bud.scope}'s ${money(bud.cap)} spent (${Math.round(bud.frac * 100)}%). At 100% the work stops. Spend what is left on what matters most, and write down where you are.`,
      );
    }
    const pl = conv.project ? readLong(this.d.vault, conv.project).plateau : undefined;
    if (conv.project && pl) {
      const series = this.metricSeries(conv.project);
      const best = Math.max(...series.map((s) => s.value));
      if (best <= pl.best) {
        const h = (this.pinned(conv.project, "metric") as MetricSpec | null)?.windowH ?? 6;
        notes.push(`No progress: the project's metric has not risen past ${pl.best}${series.at(-1)?.unit ?? ""} in over ${h} h of work. Step back: re-read what was tried (memory.md), change the approach, or say Blocked.`);
      }
    }
    return notes.length ? `<status>\n${notes.join("\n")}\n</status>\n\n` : "";
  }

  /**
   * Carl's controls (the API, never the agent): POST /api/v1/projects/:slug/:op
   * and /api/v1/conversations/:id/:op.
   *   check {command | null, pass_regex?, timeout_s?}   — set (pinned) or remove the project's check
   *   budget {usd | null}                               — a project's or a conversation's dollar cap
   *   metric {command | null, every_min?, window_h?}    — the project's progress metric
   *   models {cheap?, strong?, escalate_after?, max_attempts?} — workers' models: a task that failed
   *                                                       escalate_after (2) times runs on the strong one
   */
  async control(target: { project?: string; convId?: string }, op: string, b: any): Promise<Record<string, unknown>> {
    return this.scoped(async () => {
      const vault = this.d.vault;
      const slug = target.project ? String(target.project) : "";
      if (slug && !readProject(slug)) return { ok: false, error: `no project ${slug}` };
      if (op === "check" && slug) {
        if (b?.command === null || b?.command === "") {
          writeLong(vault, slug, (st) => {
            delete st.check;
          });
          return { ok: true, check: null };
        }
        const command = String(b?.command ?? "").trim();
        if (!command) return { ok: false, error: "check needs a command (or null to remove it)" };
        const spec = pinCommand({ command, passRegex: b?.pass_regex ? String(b.pass_regex) : undefined, timeoutS: Number(b?.timeout_s) > 0 ? Number(b.timeout_s) : undefined, cwd: vault, source: "carl" });
        writeLong(vault, slug, (st) => ({ ...st, check: spec }));
        return { ok: true, check: { command: spec.command, files: Object.keys(spec.files) } };
      }
      if (op === "metric" && slug) {
        if (b?.command === null || b?.command === "") {
          writeLong(vault, slug, (st) => {
            delete st.metric;
            delete st.plateau;
          });
          return { ok: true, metric: null };
        }
        const command = String(b?.command ?? "").trim();
        if (!command) return { ok: false, error: "metric needs a command (or null to remove it)" };
        const spec: MetricSpec = { ...pinCommand({ command, timeoutS: Number(b?.timeout_s) > 0 ? Number(b.timeout_s) : undefined, cwd: vault, source: "carl" }), ...metricOpts(b) };
        writeLong(vault, slug, (st) => ({ ...st, metric: spec }));
        return { ok: true, metric: { command: spec.command, files: Object.keys(spec.files), everyMin: spec.everyMin ?? 15, windowH: spec.windowH ?? 6 } };
      }
      if (op === "models" && slug) {
        const st = writeLong(vault, slug, (s) => {
          const m = { ...(s.models ?? {}) };
          if (typeof b?.cheap === "string") m.cheap = b.cheap || undefined;
          if (typeof b?.strong === "string") m.strong = b.strong || undefined;
          if (Number(b?.escalate_after) >= 0 && b?.escalate_after !== undefined) m.escalateAfter = Number(b.escalate_after);
          s.models = m;
          if (Number(b?.max_attempts) > 0) s.maxAttempts = Math.min(Number(b.max_attempts), 10);
        });
        return { ok: true, models: st.models, maxAttempts: st.maxAttempts ?? 3 };
      }
      if (op === "budget") {
        const usd = b?.usd === null ? null : Number(b?.usd);
        if (usd !== null && !(usd > 0)) return { ok: false, error: "budget needs usd > 0 (or null to remove it)" };
        if (slug) {
          writeLong(vault, slug, (st) => {
            if (usd === null) delete st.budgetUsd;
            else st.budgetUsd = usd;
          });
          return { ok: true, project: slug, budgetUsd: usd };
        }
        const id = String(target.convId ?? "");
        const c = await mutateConv(vault, id, (c) => {
          const lg = { ...(c.long ?? {}) };
          if (usd === null) delete lg.budgetUsd;
          else lg.budgetUsd = usd;
          delete lg.budgetHit;
          c.long = lg;
        });
        return c ? { ok: true, convId: id, budgetUsd: usd } : { ok: false, error: `no conversation ${id}` };
      }
      return { ok: false, error: `unknown control ${op}` };
    });
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
      // Done runs the project's check on the server.
      if (t.name === "Done") limit = Math.max(limit, checkTimeoutMs() + 2 * TOOL_MARGIN_MS);
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
      // A worker past its task's deadline is stopped; its turn's end fails the attempt.
      const dl = this.workerDeadline.get(l.convId);
      if (dl && now > dl && !l.stopped) {
        this.log(`worker ${l.convId}: task deadline passed — interrupting`);
        l.stopped = true;
        void this.interrupt(l.convId, false);
        continue;
      }
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

const PINNED_HEADING = { check: "Done when", metric: "Progress metric" } as const;

/** A metric's sampling interval and plateau window from a tool call or an API body. */
function metricOpts(b: any): { everyMin?: number; windowH?: number } {
  const every = Number(b?.every_min);
  const win = Number(b?.window_h);
  return { ...(every > 0 ? { everyMin: Math.max(1, every) } : {}), ...(win > 0 ? { windowH: win } : {}) };
}

/** A check's time limit: its own, else VC_CHECK_TIMEOUT_S (30 min); at most 4 h. */
function checkTimeoutMs(spec?: CommandSpec): number {
  const s = spec?.timeoutS ?? (Number(process.env.VC_CHECK_TIMEOUT_S) || 1800);
  return Math.min(s, 4 * 3600) * 1000;
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


/** Dollars for people: cents normally, more digits for sub-dollar amounts so a $0.002 cap doesn't read "$0.00". */
function money(usd: number): string {
  if (usd >= 1 || usd === 0) return `$${usd.toFixed(2)}`;
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}
