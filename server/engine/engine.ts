// The engine: every agent turn on the box runs in pi (pi/backend.ts). A
// conversation maps to one pi session ("thread"; a new one after a roll-over).
// The transcript is pi's own session file; the vault's feed (server/convlog,
// src/convlog/protocol.ts) points into it as pi writes it and carries pi's live
// events for the message in flight (piFeed.ts). What only vault-chat knows
// (the turn running, steers pi has not delivered, an open question, cost,
// subagents, keep-going) is the conversation's fields in the same feed; its own
// lines (a notice, the verifier's verdict, a roll-over) are pi custom entries
// (`vc-note`), written by pi while it has the session. Every client folds the
// feed with one reducer. vault-chat's tools reach pi through its extension as
// host calls.
import { appendFileSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
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
  ctxConfig,
  type EngineConv,
  type ThreadTokenUsage,
} from "./context";
import { patchMeta, readConv, allConvs, createConv, newMessageId, emitTo, pictureOf, logOf, writeNotes, appendNotes, setNoteWriter, type NoteData } from "./convs";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "./wakes";
import { Ledger } from "./ledger";
import { pdfRead, webSearch } from "./extraTools";
import { failMake, inboxLog, listEntries, readEntry, sendEntry, startMake, type InboxEvent } from "../inbox";
import { BOARD_MAKER_PROMPT, boardMakeTask, makerStats } from "./boardTools";
import { startJob, jobStatus, jobList, jobStop, reapJobs, type PiJobEnv } from "./pi/jobs";
import { ENGINE_ROLE_PROMPT } from "./prompt";
import { isNoteTool, noteTool, noteToolSpecs } from "../notesTools";
import { capabilitiesOf, capabilityNote, learn } from "./capabilities";
import { join } from "node:path";
import { WRITE_TOOLS, writtenPath } from "../liveEdits";
import { appendActivity, contextImage, youLayer } from "../activity";
import { CAPTURE_FRESH_MS, chatPointerEntry } from "../../src/activityCore";
import type { EventBody, ItemImage, PendingInput } from "../../src/convlog/protocol";
import { isOpen, pendingOf, shown, type Picture } from "../../src/convlog/reduce";
import { toolName } from "../../src/convlog/view";
import { readEntries } from "../convlog/piSession";
import { PiFeed } from "./piFeed";
import { READ_ONLY_TOOLS, type SideState } from "./pi/side";
import { TurnRecorder, type TurnLine } from "./turnLog";
import { SERVER_VERSION } from "../config";

export type EngineDeps = {
  vault: string;
  backend: PiBackend;
  ledger: Ledger;
  jobEnv: PiJobEnv;
  model: () => string;
  webSearchModel: string;
  apiKey: () => string | null;
  /** Web Push + notifications.jsonl + the /poll "notif" signal. */
  notify: (n: { kind: "info" | "ask"; title: string; body: string; convId: string; options?: string[] }) => Promise<string | null>;
  /** One-line log. */
  log?: (s: string) => void;
  stallMs?: number;
  /** A vault-level signal on /poll (the inbox, notifications). */
  broadcast?: (ev: Record<string, unknown>) => void;
  /** Model for a turn that carries images when the default can't see. */
  visionModel?: string;
  /** The other vaults on this box (and their state): the verifier may not read them. */
  deny?: () => string[];
  /** A Write/Edit/NotebookEdit succeeded: the vault-relative paths it changed (server/liveEdits.ts). */
  onFilesWritten?: (paths: string[]) => void;
  /** A turn ended (the sync brings its results to the laptop). */
  onTurnEnded?: (convId: string) => void;
  /** The vault's name on this box (the turn log's `vault`); the folder's name when absent. */
  vaultName?: string;
  /** One structured line per turn (turnLog.ts): the box's turn log and the journal. */
  turnLog?: (line: TurnLine) => void;
};

type TurnKind = "user" | "wake" | "nudge" | "resume";

type Live = {
  convId: string;
  threadId: string;
  /** The turn's id: pi's (backend) and the log's are the same. */
  turnId: string;
  kind: TurnKind;
  startedAt: number;
  lastEventAt: number;
  /** pi's session and live events → the feed. */
  feed: PiFeed;
  /** pi's events → the turn's log line. */
  rec: TurnRecorder;
  usage: ThreadTokenUsage | null;
  flags: { wake: boolean; done: boolean; blocked: boolean };
  /** When the turn's ScheduleWake set its wake (ISO), and the tool calls the model made after it. */
  wakeAt: string | null;
  afterWake: number;
  /** The turn was ended by the engine after a ScheduleWake (the model kept going): not "stopped". */
  endedAfterWake: boolean;
  ask: { resolve: (answer: string) => void; question: string; itemId: string } | null;
  asks: number;
  /** Tool calls in flight (started, no result yet): while one is open the watchdog waits for its own timeout. */
  open: Map<string, { name: string; input: any }>;
  /** Tool calls seen running (the after-wake count counts new ones only). */
  seen: Set<string>;
  cut: boolean;
  stalled: boolean;
  stopped: boolean;
  controller: AbortController;
  /** pi accepted the prompt. */
  started: boolean;
  finished: boolean;
  /** What started the turn (for the silent retry). */
  input: string;
  turnOpts: TurnOpts;
};

type TurnOpts = { images?: string[]; context?: string; itemImages?: ItemImage[]; clientId?: string; /** What the chat shows (Carl's answer to a question asked before a restart). */ shown?: string; via?: string; /** Which client sent it (the turn log's `via`: laptop, phone, voice …). */ origin?: string };

const NUDGE_TEXT = "You're in keep-going mode: schedule your next check (ScheduleWake), or say Done or Blocked.";
const RESUME_TEXT =
  "The box restarted (or the engine stopped) while your last turn was running, so any command it was running was killed and may not have finished. Re-check reality (files, processes, logs), then continue from where you were.";
const LEGACY_SOURCES = new Set(["mission", "worker", "ask"]);
const ARCHIVED = "This is an archived mission thread (the old missions system): readable, never run. Start a new chat.";
const INTERRUPTED_TEXT = "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.";
/** Tool calls a turn may still make after ScheduleWake: only ending it differently. */
const AFTER_WAKE_OK = new Set(["Done", "Blocked"]);
/** Tool calls after ScheduleWake before the engine ends the turn itself. */
const AFTER_WAKE_MAX = 2;
/** How much longer than an open tool call's own timeout the watchdog waits. */
const TOOL_MARGIN_MS = 5 * 60_000;
export const wakeRefusal = (at: string) => `You scheduled a wake for ${at}. End your turn now; you'll be woken then.`;

// The server is going down (SIGTERM/SIGINT): pi's processes die with it, and
// that is not a crash. A turn cut by the shutdown stays open in the log for the
// next boot to close (as cut) and resume once; nothing is finished here.
let shuttingDown = false;
export function engineShuttingDown(on = true): void {
  shuttingDown = on;
}

const newTurnId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;


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
    name: "BoardSend",
    description:
      "Send something to Carl's iPad whiteboard inbox (he adds it to a board himself). Use it directly only when everything already exists: PDF pages, math you have written, an image or widget file already in the vault. Parts (ordered, each addable on its own): {kind:\"pdf\", path, pages:[3,4,5] (1-based, ≤20)} | {kind:\"math\", markdown (with $…$ / $…$), label?} | {kind:\"image\", path (PNG/JPEG/WebP/SVG in the vault), alt} | {kind:\"widget\", path (one TypeScript module exporting mount(el, api); api: size(), onResize(fn), theme; no network), alt, layout?:{w,h}}. Optional width (canvas units; the view is 1000 wide) and label per part. A problem set is one math part per problem. A bad send is refused with every reason: fix them and send again. Returns the entry id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        note: { type: "string" },
        parts: { type: "array", items: { type: "object" } },
        make: { type: "string", description: "Only inside a BoardMake: the id of the entry being made." },
        more: { type: "boolean", description: "Only with make: these parts land now and the entry stays being made; the last send leaves it out." },
      },
      required: ["title", "parts"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "BoardMake",
    description:
      "Have something made for Carl's whiteboard in the background (a problem set, a graph, a widget) and land in his iPad inbox. Returns at once; a sub-agent in this vault makes the files, sends them through BoardSend and fixes refusals itself. The inbox shows it as being made, then the result or why it couldn't be made. Never wait for it: tell Carl it's on its way and carry on.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What to make, with everything the maker needs (the maker does not see this conversation)." },
        title: { type: "string", description: "The inbox title, one line." },
      },
      required: ["request", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "BoardInbox",
    description: "The whiteboard inbox: each entry's title, status (unread / read / added / being made / couldn't make) and, for added parts, the board and whether its items are still there. Give id for one entry.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
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
  /** Captures already sent to each conversation's model (in memory): one is never attached twice. */
  private imagesGiven = new Map<string, Set<string>>();
  /** The rules each thread last received (its instructions at start, or a turn's prefix): a turn repeats them only when they changed. In memory; after a restart a resumed thread gets them once more. */
  private rulesSent = new Map<string, string>();
  private jobLogs = new Map<string, string[]>(); // convId → its StartJob logs
  /** History from before a conversation's thread, handed to its first turn once (a legacy chat, a lost thread). */
  private handover = new Map<string, string>();

  constructor(private d: EngineDeps) {
    // Everything this engine does runs scoped to its vault (CONTEXT reads that
    // vault's projects and rules): the public entry points here, the backend's
    // events, handlers and timers in start().
    for (const k of ["message", "answerRoute", "subagent", "kill", "intent", "sideStart", "once"] as const) {
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

  /** Write one record to a conversation's log. */
  private emit(convId: string, body: EventBody): void {
    emitTo(this.d.vault, convId, body);
  }

  private picture(convId: string): Picture | null {
    return pictureOf(this.d.vault, convId);
  }

  /** A turn's log line recorder (turnLog.ts). */
  private recorder(convId: string, turnId: string, threadId: string | null, kind: TurnKind, opts: TurnOpts, clientId: string, model: string | null, start: number): TurnRecorder {
    const via = kind === "user" ? (opts.origin ?? opts.via ?? null) : (opts.via ?? (kind === "wake" ? "wake" : kind));
    return new TurnRecorder({
      vault: this.d.vaultName ?? (this.d.vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || this.d.vault),
      conv: convId,
      turn: turnId,
      session: threadId,
      mode: kind,
      via,
      cmid: kind === "user" ? clientId : null,
      model,
      start,
      version: SERVER_VERSION,
    });
  }

  /** Write a turn's line (never throws). */
  private turnLine(rec: TurnRecorder, end: { status: string; outcome: string; state?: string; error?: string | null }): void {
    try {
      this.d.turnLog?.(rec.line(end));
    } catch (e) {
      this.log(`turn log: ${(e as Error).message}`);
    }
  }

  /** A line of vault-chat's in the transcript (a pi custom entry). */
  private notice(convId: string, text: string, level: "info" | "warn" | "error" = "info"): Promise<void> {
    return this.note(convId, [{ kind: "notice", text, level }]);
  }

  private note(convId: string, notes: NoteData[]): Promise<void> {
    return writeNotes(this.d.vault, convId, notes).catch((e) => this.log(`note on ${convId}: ${(e as Error).message}`));
  }

  /** Through pi while a pi process has the conversation's session (then the feed points to what pi wrote). */
  private async noteViaPi(convId: string, notes: NoteData[]): Promise<boolean> {
    const p = this.picture(convId);
    const threadId = p?.meta.threadId;
    const file = p?.meta.threadPath;
    if (!threadId || !file || !this.d.backend.holds(threadId)) return false;
    for (const n of notes) {
      // A line's pixels stay out of the session (its paths are enough).
      const data = n.images ? { ...n, images: n.images.map((i) => ({ path: i.path })) } : n;
      if (!(await this.d.backend.note(threadId, data))) return false;
    }
    const l = this.live.get(convId);
    if (l && l.feed.file === file) l.feed.sync();
    else this.catchUp(convId, file);
    return true;
  }

  /** Point to what pi wrote that the feed does not have yet (a session read after a crash, a note between turns). */
  private catchUp(convId: string, file: string): void {
    const p = this.picture(convId);
    const from = p?.meta.sessionFrom as { file?: string; after?: string | null } | undefined;
    const feed = new PiFeed({ file, emit: (b) => this.emit(convId, b), pointed: this.skipSet(convId, file, from?.file === file ? from.after : undefined) });
    feed.dispose();
  }

  /** The entries of `file` the feed must not point to again: those it points to, and a resumed older session's history. */
  private skipSet(convId: string, file: string, after?: string | null): Set<string> {
    const set = logOf(this.d.vault).pointedIn(convId, file);
    if (after) {
      for (const e of readEntries(file)) {
        set.add(e.id);
        if (e.id === after) break;
      }
    }
    return set;
  }

  // ---------------------------------------------------------------- fields

  private setPending(convId: string, add?: PendingInput, removeId?: string): void {
    const cur = pendingOf(this.picture(convId) ?? ({ meta: {} } as Picture)).filter((x) => x.id !== removeId && x.id !== add?.id);
    const next = add ? [...cur, add] : cur;
    this.emit(convId, { type: "meta", patch: { pending: next.length ? next : null } });
  }

  private addCost(convId: string, usd: number, missing?: number): void {
    const m = this.picture(convId)?.meta;
    if (!m) return;
    const total = Math.round(((Number(m.costUsd) || 0) + usd) * 1e7) / 1e7;
    this.emit(convId, { type: "meta", patch: { costUsd: total, ...(missing ? { costMissingCalls: (Number(m.costMissingCalls) || 0) + missing } : {}) } });
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const b = this.d.backend;
    b.on("event", (e: BackendEvent) => this.scoped(() => this.onEvent(e)));
    b.on("up", () => this.scoped(() => void this.onUp()));
    setNoteWriter(this.d.vault, (convId, notes) => this.scoped(() => this.noteViaPi(convId, notes)));
    b.setHandlers({
      toolCall: (threadId, name, args) =>
        this.scoped(async () => {
          const r: any = await this.onToolCall({ threadId, tool: name, arguments: args });
          return { ok: r?.success !== false, text: (r?.contentItems ?? []).map((c: any) => c?.text ?? "").join("\n") };
        }),
      userInput: (threadId, question, options) => this.scoped(() => this.waitForAnswer(threadId, question, options)),
      you: (q) => this.scoped(async () => this.you(q)),
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
      log: { latest: logOf(this.d.vault).latest(), epoch: logOf(this.d.vault).epoch },
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
      // A turn a crash or a restart of the whole server cut: still open in the log.
      // It ends here as cut (with a line saying so), then it is resumed — unless it
      // was waiting on Carl, whose answer starts the next turn.
      const log = logOf(this.d.vault);
      for (const r of log.rows()) {
        if (this.live.has(r.id)) continue;
        if (r.legacy) {
          // An older file that says a turn was running (a restart during the upgrade): resume it once.
          if (r.state !== "running") continue;
        } else if (!r.running) continue;
        const p = this.picture(r.id);
        if (!p) continue;
        if (p.meta.running) {
          // What pi wrote before it died is pointed to first; the turn ends (what was in flight stays, closed);
          // then the line saying so (no pi has the session now).
          const file = p.meta.threadPath;
          if (typeof file === "string" && existsSync(file)) this.catchUp(r.id, file);
          this.emit(r.id, { type: "meta", patch: { running: null, pending: null } });
          appendNotes(this.d.vault, r.id, [{ kind: "notice", text: INTERRUPTED_TEXT, level: "error" }]);
        }
        if (p.meta.asking) continue;
        if (p.meta.threadId) this.resumeQueue.add(r.id);
      }
    }
    const q = [...this.resumeQueue];
    this.resumeQueue.clear();
    for (const id of q) void this.run(id, RESUME_TEXT, "resume").catch((e) => this.log(`resume ${id} failed: ${e}`));
  }

  // ---------------------------------------------------------------- inbound

  /**
   * POST /api/v2/intent: everything a client may ask of a conversation. The
   * box is the only writer: an intent's effect reaches every client through
   * the log, never through the answer.
   */
  async intent(b: Record<string, any>): Promise<Record<string, unknown>> {
    switch (b?.type) {
      case "send":
        return (await this.message({ ...b, clientMsgId: b.clientId })) ?? { error: "legacy conversation" };
      case "steer":
        return (await this.message({ ...b, clientMsgId: b.clientId, mode: "steer" })) ?? { error: "legacy conversation" };
      case "queue":
        return (await this.message({ ...b, clientMsgId: b.clientId, queue: true })) ?? { error: "legacy conversation" };
      case "unqueue":
        return (await this.message({ convId: b.convId, unqueue: String(b.id ?? "") })) ?? { error: "legacy conversation" };
      case "stop":
        return (await this.kill({ convId: b.convId })) ?? { error: "legacy conversation" };
      case "answer":
        return (await this.answerRoute({ convId: b.convId, text: b.text, defer: b.defer, clientMsgId: b.clientId })) ?? { error: "legacy conversation" };
      case "lines": {
        // Lines a client brings into a chat as they are (a Ctrl+K exchange, a note opened for
        // discussion): written as its items, under the client's ids; no turn runs.
        const lines: any[] = Array.isArray(b.lines) ? b.lines.slice(0, 40) : [];
        if (!lines.length) return { error: "no lines" };
        let id = String(b.convId ?? "");
        if (!id || !this.picture(id)) {
          if (id && !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return { error: "bad conversation id" };
          const first = String(lines.find((l) => l?.role === "user" && !l.hidden)?.text ?? "Chat");
          id = (await createConv(this.d.vault, { source: "manual" }, first, id || undefined)).id;
        }
        const { appendMessage } = await import("./convs");
        for (const [i, l] of lines.entries()) {
          const mid = `${String(b.clientId ?? newMessageId()).slice(0, 70)}:${i}`;
          await appendMessage(this.d.vault, id, {
            role: l?.role === "assistant" ? "assistant" : "user",
            content: String(l?.text ?? "").slice(0, 100_000),
            ...(l?.hidden ? { hidden: true } : {}),
            ...(Array.isArray(l?.images) && l.images.length ? { attachments: l.images.slice(0, 8).map((u: unknown) => ({ imageDataUrl: String(u) })) } : {}),
            mid,
          } as any);
        }
        return { ok: true, convId: id };
      }
      case "delete": {
        const id = String(b.convId ?? "");
        if (!this.picture(id)) return { ok: false, error: `conversation ${id} not found` };
        if (this.live.has(id)) await this.interrupt(id, true);
        this.emit(id, { type: "meta", patch: { deleted: true } });
        return { ok: true, convId: id };
      }
      default:
        return { error: `unknown intent ${String(b?.type).slice(0, 40)}` };
    }
  }

  /**
   * /message {text, convId?, clientMsgId?, project?, context?, images?, imagePaths?, source?, queue?, unqueue?, mode?}
   *  → {ok, convId}. images: [{name?, mime, dataBase64}] (saved under .vault-chat/captures/) or
   * imagePaths: [vault-relative path]. context: a preamble the agent sees before
   * the text (not shown as the message). project: tags a new conversation — Carl's choice in the app (the
   * phone's "New chat in project"); no agent tool sends it.
   * While a turn runs the message steers it (pi's steer), or with `queue` waits
   * for its end (pi's follow-up); `unqueue: <id>` takes a queued one back.
   * `clientMsgId` is the id Carl's client shows it under (the item's id): a repeat
   * of the same id is a no-op. Returns null for a legacy mission thread.
   */
  async message(body: {
    convId?: string | null;
    text?: string;
    clientMsgId?: string;
    project?: string;
    context?: string;
    images?: { name?: string; mime?: string; dataBase64?: string }[];
    imagePaths?: string[];
    /** Who started it: "voice" (the voice agent's AskAgent); a phone chat otherwise. */
    source?: string;
    /** Hold it until the running turn ends (a follow-up), instead of steering. */
    queue?: boolean;
    /** Take back a queued (or steering) message not delivered yet (its id). */
    unqueue?: string;
    mode?: "steer";
    /** Which client sent it (laptop, phone, board): the turn log's `via`. */
    client?: string;
  }): Promise<Record<string, unknown> | null> {
    const clientId = typeof body.clientMsgId === "string" && body.clientMsgId.trim() ? body.clientMsgId.trim().slice(0, 80) : newMessageId();
    if (typeof body?.unqueue === "string" && body.convId) return this.takeBack(body.convId, body.unqueue);
    const textIn = String(body?.text ?? "").trim();
    const hasImages = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0) > 0;
    if (!textIn && !hasImages) return { error: "empty message" };
    let conv: EngineConv | null = null;
    if (body.convId) {
      conv = await readConv(this.d.vault, body.convId);
      if (!conv) {
        // A client's optimistic new chat: the id it chose becomes the conversation's.
        if (/^[A-Za-z0-9_-]{6,80}$/.test(body.convId) && !logOf(this.d.vault).has(body.convId)) {
          conv = await createConv(this.d.vault, body.source === "voice" ? { source: "voice" } : {}, textIn || "Image", body.convId);
        } else return { error: `conversation ${body.convId} not found` };
      }
      if (LEGACY_SOURCES.has(conv.source)) return { error: ARCHIVED };
    } else {
      conv = await createConv(this.d.vault, body.source === "voice" ? { source: "voice" } : {}, textIn || "Image");
    }
    const id = conv.id;
    // The same message again (a retry, a service worker's replay): already here.
    const pic0 = this.picture(id);
    if (pic0 && (pic0.items.some((x) => x.id === clientId) || pendingOf(pic0).some((x) => x.id === clientId))) return { ok: true, convId: id, duplicate: true };
    if (typeof body.project === "string" && body.project.trim()) {
      try {
        const { ensureProject } = await import("../context");
        const { project } = ensureProject(body.project.trim());
        await patchMeta(this.d.vault, id, { project: project.slug });
      } catch (e) {
        this.log(`project ${body.project}: ${(e as Error).message}`);
      }
    }
    const { paths, itemImages } = this.saveImages(id, body);
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
    // The shared stream: a pointer to Carl's message (his words only: the reply stays in this chat), and
    // the images he pasted into it, by path (the other conversations' "you" layer lists them).
    const now = (await readConv(this.d.vault, id).catch(() => null)) ?? conv;
    const proj = now.project;
    const title = String(now.title ?? "").trim() || shown;
    const device = body.source === "voice" ? null : body.client ?? null;
    appendActivity(this.d.vault, chatPointerEntry({ convId: id, title, user: shown, project: typeof proj === "string" ? proj : null, device }));
    for (const im of itemImages.filter((x) => x.path.startsWith(".vault-chat/captures/")))
      appendActivity(this.d.vault, { kind: "capture", modality: "chat", text: `pasted into "${title}"`, path: im.path, convId: id, ...(device ? { device } : {}) });
    this.nudged.delete(id);
    // An open question: this message is the answer.
    if (this.live.get(id)?.ask || conv.pendingAsk) {
      await this.answer(id, shown, clientId);
      return { ok: true, convId: id, answered: true };
    }
    // A turn still starting (pi not prompted yet): it is about to run, so the message goes into it.
    for (let t = 0; t < 600; t++) {
      const s = this.live.get(id);
      if (!s || s.finished || s.started) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const l = this.live.get(id);
    const sent = context ? `${context}\n\n${shown}` : shown;
    if (l && !l.finished && l.started) {
      // A running turn: steer it (pi delivers it after the current tool calls), or queue it as
      // pi's follow-up (delivered when the agent would otherwise stop). Either way it is pending
      // until pi takes it, and enters the transcript where pi puts it.
      const kind = body.queue ? "queue" : "steer";
      this.setPending(id, { id: clientId, kind, text: shown, at: Date.now() });
      l.feed.expect({ kind, text: sent, clientId, shown, via: kind, images: itemImages });
      l.rec.q(kind, clientId);
      try {
        if (kind === "queue") await this.d.backend.followUp(l.threadId, { texts: [sent], images: paths });
        else await this.d.backend.steer(l.threadId, l.turnId, { texts: [sent], images: paths });
        return { ok: true, convId: id, ...(kind === "queue" ? { queued: true, qid: clientId } : { steered: true }) };
      } catch (e) {
        l.feed.forget(clientId);
        this.setPending(id, undefined, clientId);
        l.rec.q("refused", clientId);
        this.log(`${kind} failed (${(e as Error).message})`);
        return { ok: false, convId: id, error: `the running turn did not take it: ${(e as Error).message}` };
      }
    }
    const origin = body.source === "voice" ? "voice" : typeof body.client === "string" && body.client ? body.client.slice(0, 20) : body.source ? String(body.source).slice(0, 20) : undefined;
    void this.run(id, shown, "user", { images: paths, context, itemImages, clientId, origin }).catch((e) => this.log(`turn failed: ${e}`));
    return { ok: true, convId: id };
  }

  /** Take back a message pi has not delivered yet: pi's queue is cleared and the others go back in, in order. */
  private async takeBack(convId: string, id: string): Promise<Record<string, unknown>> {
    const p = this.picture(convId);
    const hit = p ? pendingOf(p).find((x) => x.id === id) : undefined;
    if (!hit) return { ok: false, error: "already delivered" };
    const l = this.live.get(convId);
    if (l && !l.finished) {
      const rest = l.feed.undelivered().filter((e) => e.clientId !== id);
      try {
        await this.d.backend.clearQueue(l.threadId);
        for (const e of rest) {
          if (e.kind === "queue") await this.d.backend.followUp(l.threadId, { texts: [e.text], images: [] });
          else await this.d.backend.steer(l.threadId, l.turnId, { texts: [e.text], images: [] });
        }
      } catch (err) {
        this.log(`take back on ${convId}: ${(err as Error).message}`);
      }
      l.feed.forget(id);
      l.rec.q("unqueue", id);
    }
    this.setPending(convId, undefined, id);
    return { ok: true, convId, unqueued: id };
  }

  private saveImages(convId: string, body: { images?: { name?: string; mime?: string; dataBase64?: string }[]; imagePaths?: string[] }): { paths: string[]; itemImages: ItemImage[] } {
    const paths: string[] = [];
    const itemImages: ItemImage[] = [];
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
      itemImages.push({ path: rel, ...(buf.length < 400_000 ? { dataUrl: `data:${mime};base64,${b64}` } : {}) });
    });
    for (const p of (body.imagePaths ?? []).slice(0, 8)) {
      const rel = String(p).replace(/^[\/]+/, "");
      if (!rel || rel.includes("..")) continue;
      paths.push(join(this.d.vault, rel));
      itemImages.push({ path: rel });
    }
    return { paths, itemImages };
  }

  /** /answer. null → legacy path. */
  async answerRoute(body: { convId?: string; text?: string; defer?: boolean; clientMsgId?: string }): Promise<Record<string, unknown> | null> {
    const id = String(body?.convId ?? "");
    if (!id) return null;
    const conv = await readConv(this.d.vault, id);
    if (!conv) return null;
    if (LEGACY_SOURCES.has(conv.source)) return { error: ARCHIVED };
    const t = body.defer
      ? "Not now — I'm not picking an option. Take the default you named if there is a safe one; otherwise hold, and don't do anything irreversible or that spends money."
      : String(body?.text ?? "").trim();
    if (!t) return { error: "answer needs a convId and non-empty text" };
    if (!this.live.get(id)?.ask && !conv.pendingAsk) {
      // No open question (already answered elsewhere): a plain message.
      return (await this.message({ convId: id, text: t, clientMsgId: body.clientMsgId })) ?? { ok: true, convId: id };
    }
    const clientId = typeof body.clientMsgId === "string" && body.clientMsgId.trim() ? body.clientMsgId.trim().slice(0, 80) : newMessageId();
    if (this.picture(id)?.items.some((x) => x.id === clientId)) return { ok: true, convId: id, duplicate: true };
    await this.answer(id, t, clientId);
    return { ok: true, convId: id, answered: true };
  }

  /** POST /api/v1/conversations/:id/subagents/:sid/{steer,stop}. */
  async subagent(convId: string, sid: string, op: "steer" | "stop", body: { text?: string }): Promise<Record<string, unknown>> {
    const conv = await readConv(this.d.vault, convId);
    if (!conv) return { ok: false, error: `conversation ${convId} not found` };
    if (!(conv.subagents ?? []).some((s: any) => s.threadId === sid)) return { ok: false, error: `no subagent ${sid} on this conversation` };
    return this.d.backend.subagentControl(sid, op, body?.text);
  }

  // ---------------------------------------------------------------- side threads (pi/side.ts)

  /**
   * POST /api/v1/side. Ctrl+K / Ctrl+L ({kind: "edit" | "ask", convId?, side?, text, images?}): pi forks the
   * conversation's session (its history and instructions; a fresh session with the agent's instructions when it
   * has none) with pi's read-only tools; pi's extension adds what Carl did elsewhere since that conversation
   * last saw it (the "you" layer, the same hook a turn of the agent runs). `side`: the popover's next request, in
   * the same side thread. One-shots ({kind: "once", system, text, images?, fast?}): no session, no tools.
   */
  async sideStart(b: Record<string, any>): Promise<Record<string, unknown>> {
    const text = typeof b?.text === "string" ? b.text : "";
    if (!text.trim()) return { error: "missing text" };
    const kind = b.kind === "once" ? "once" : b.kind === "edit" ? "edit" : "ask";
    const images: string[] = (Array.isArray(b.images) ? b.images : []).filter((u: unknown) => typeof u === "string" && u.startsWith("data:image/"));
    let model = kind === "once" && b.fast ? ctxConfig().recapModel : this.d.model();
    if (images.length && !capabilitiesOf(model).images) model = this.d.visionModel ?? model;
    const dir = (parent: string) => join(this.d.backend.paths.sessionsDir, "side", parent);
    const side = this.d.backend.side;
    try {
      let s: SideState;
      let conv: EngineConv | null = null;
      if (kind === "once") {
        s = await side.start({ kind, system: String(b.system ?? ""), cwd: this.d.vault, model, tools: [], ephemeral: true, thinking: "off", sessionDir: dir("once"), text, images });
      } else if (typeof b.side === "string" && b.side) {
        s = await side.start({ kind, side: b.side, cwd: this.d.vault, model, tools: READ_ONLY_TOOLS, sessionDir: "", text, images });
      } else {
        conv = typeof b.convId === "string" && b.convId ? await readConv(this.d.vault, b.convId) : null;
        const src = conv?.threadId ? this.d.backend.threadSource(conv.threadId) : null;
        let instr = src?.instr;
        if (!instr) {
          // No session to fork: the agent's own instructions, as a new thread of that conversation would get them.
          const note = capabilityNote(model);
          mkdirSync(this.d.backend.paths.instrDir, { recursive: true });
          instr = join(this.d.backend.paths.instrDir, `side-${Date.now().toString(36)}-${newMessageId().slice(-6)}.md`);
          writeFileSync(instr, buildDeveloperInstructions((conv ?? { id: "side", title: "", messages: [] }) as any, { rolePrompt: ENGINE_ROLE_PROMPT + (note ? `\n\n${note}` : "") }));
        }
        // What Carl did elsewhere comes in through pi (the extension's "you" layer, as of this conversation).
        s = await side.start({ kind, fork: src?.file ?? null, instr, cwd: src?.cwd || this.d.vault, model, tools: READ_ONLY_TOOLS, sessionDir: dir(conv?.id ?? "none"), text, images, you: { convId: conv?.id ?? null } });
      }
      this.log(`side ${kind} ${s.id}${conv ? ` (forked from ${conv.id})` : ""} on ${model}${s.file ? `: ${s.file}` : ""}`);
      return { ok: true, id: s.id, v: s.v };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }

  /** GET /api/v1/side/:id?after=v: the answer so far, once it changed (long poll). */
  sidePoll(id: string, after: number, waitMs: number): Promise<SideState | null> {
    return this.d.backend.side.poll(id, after, Math.max(0, Math.min(waitMs, 25_000)));
  }

  /** POST /api/v1/side/:id/stop. */
  sideStop(id: string): Promise<boolean> {
    return this.d.backend.side.stop(id);
  }

  /** A one-shot on the box itself (a note's title): pi, no session, no tools; the final text. */
  async once(req: { instructions: string; text: string; images?: string[]; fast?: boolean }): Promise<string> {
    const r = await this.sideStart({ kind: "once", system: req.instructions, text: req.text, images: req.images, fast: req.fast });
    if (r.error) throw new Error(String(r.error));
    const s = await this.d.backend.side.wait(String(r.id));
    this.d.backend.side.forget(s.id);
    if (s.error) throw new Error(s.error);
    return s.text;
  }

  /** /kill. null → legacy path. Stop means stop: interrupt, keep-going off, wakes cancelled. */
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
      this.emit(convId, { type: "meta", patch: { asking: null } });
      a.resolve("Carl stopped this turn instead of answering. End the turn now; do nothing else.");
    }
    l.stopped = byUser || l.stopped;
    if (!l.started) return true;
    try {
      // pi's own stop: its queue is cleared first (what was not delivered is taken back), then abort.
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

  /** How an engine input shows (a wake, a job, a nudge, a resume). */
  private engineInput(input: string, kind: TurnKind): { via: string; shown: string } {
    const via = kind === "wake" ? (/^Job \S+ /.test(input) ? "job" : "wake") : kind === "nudge" ? "nudge" : "resume";
    return { via, shown: kind === "wake" ? input.replace(/^Wake:\s*/, "") : input };
  }

  /** Start a turn (or, if one is running, hand the input to it). */
  run(convId: string, input: string, kind: TurnKind, opts: TurnOpts = {}): Promise<void> {
    return this.serial(convId, async () => {
      const existing = this.live.get(convId);
      if (existing && !existing.finished) {
        if (existing.started && !existing.ask) {
          const b = this.d.backend;
          if (kind === "user") {
            // Carl's message that raced the turn's start: a steer (pending until pi delivers it).
            const id = opts.clientId ?? newMessageId();
            const sent = opts.context ? `${opts.context}\n\n${input}` : input;
            this.setPending(convId, { id, kind: "steer", text: opts.shown ?? input, at: Date.now() });
            existing.feed.expect({ kind: "steer", text: sent, clientId: id, shown: opts.shown ?? input, via: opts.via ?? "steer", images: opts.itemImages });
            existing.rec.q("steer", id);
            await b.steer(existing.threadId, existing.turnId, { texts: [sent], images: opts.images ?? [] }).catch(() => {
              existing.feed.forget(id);
              this.setPending(convId, undefined, id);
            });
            return;
          }
          // An engine input while a turn runs: shown where pi delivers it.
          existing.feed.expect({ kind: "silent", text: input, ...this.engineInput(input, kind) });
          await b.followUp(existing.threadId, { texts: [input], images: [] }).catch(() => undefined);
        }
        return;
      }
      if (!(await this.d.backend.ready(120_000))) throw new Error(`the ${this.d.backend.name} runtime is not up`);
      let conv = await readConv(this.d.vault, convId);
      if (!conv) throw new Error(`conversation ${convId} not found`);
      const turnId = newTurnId();
      // Running from here. What started it enters the transcript when pi writes it (the client shows it meanwhile).
      const startedAt = Date.now();
      this.emit(convId, { type: "meta", patch: { running: { turn: turnId, kind, startedAt }, state: "running" } });
      const clientId = opts.clientId ?? newMessageId();
      const shownInput = kind === "user" ? { via: opts.via ?? "chat", shown: opts.shown ?? input } : this.engineInput(input, kind);
      const fail = async (text: string, rec?: TurnRecorder) => {
        // pi never took it: the message itself (Carl's) and why, as vault-chat's lines.
        this.turnLine(rec ?? this.recorder(convId, turnId, null, kind, opts, clientId, null, startedAt), { status: "failed", outcome: "not_started", state: "idle", error: text });
        const lines: NoteData[] = kind === "user" ? [{ kind: "line", role: "user", text: shownInput.shown, via: shownInput.via, clientId, ...(opts.itemImages?.length ? { images: opts.itemImages } : {}) }] : [];
        await this.note(convId, [...lines, { kind: "notice", text, level: "error" }]);
        this.emit(convId, { type: "meta", patch: { running: null, state: "idle" } });
      };
      if (!existsSync(this.d.vault) || !statSync(this.d.vault).isDirectory()) {
        await fail(`⚠️ The vault ${this.d.vault} is missing on the box; no turn was run.`);
        return;
      }
      let threadId: string;
      let fresh: boolean;
      try {
        ({ threadId, fresh } = await this.ensureThread(conv));
        conv = (await readConv(this.d.vault, convId)) ?? conv;
      } catch (e) {
        await fail(`⚠️ The engine could not open this conversation's thread: ${(e as Error).message}`);
        throw e;
      }
      const file = String(conv.threadPath ?? "");
      // A session from before the feed (an older conversation's): its history is not pointed to again.
      const from = this.picture(convId)?.meta.sessionFrom as { file?: string; after?: string | null } | undefined;
      let after = from?.file === file ? from.after : undefined;
      if (!fresh && from?.file !== file && file && !logOf(this.d.vault).pointedIn(convId, file).size) {
        const all = readEntries(file);
        after = all.length ? all[all.length - 1]!.id : null;
        this.emit(convId, { type: "meta", patch: { sessionFrom: { file, after } } });
      }
      // Images on a model that can't see: this turn (silently) uses the vision model.
      let model = this.d.model();
      if (opts.images?.length && !capabilitiesOf(model).images) model = this.d.visionModel ?? model;
      const rec = this.recorder(convId, turnId, threadId, kind, opts, clientId, model, startedAt);
      const feed = new PiFeed({
        file,
        emit: (b) => this.emit(convId, b),
        pointed: this.skipSet(convId, file, after),
        delivered: (id) => {
          this.setPending(convId, undefined, id);
          rec.q("delivered", id);
        },
      });
      // Anything pi wrote that the feed missed (a crash between its write and the pointer) comes first.
      feed.sync();
      const live: Live = {
        convId,
        threadId,
        turnId,
        kind,
        startedAt,
        lastEventAt: Date.now(),
        feed,
        rec,
        usage: null,
        flags: { wake: false, done: false, blocked: false },
        wakeAt: null,
        afterWake: 0,
        endedAfterWake: false,
        ask: null,
        asks: 0,
        open: new Map(),
        seen: new Set(),
        cut: false,
        stalled: false,
        stopped: false,
        controller: new AbortController(),
        started: false,
        finished: false,
        input,
        turnOpts: opts,
      };
      // The old Stop path (runRegistry) reaches engine runs too.
      live.controller.signal.addEventListener("abort", () => void this.interrupt(convId, true));
      this.live.set(convId, live);
      registerRun(convId, live.controller);
      // History from before this thread (a legacy chat) goes with its first turn.
      let body = input;
      const prior = this.handover.get(convId);
      if (prior) {
        this.handover.delete(convId);
        body = `${prior}\n\n${input}`;
      }
      // The rules are in the thread already (its instructions, or an earlier prefix): only a change goes in front of the turn.
      const rulesNow = rulesPrefixForTurn(conv as any);
      const rules = this.rulesSent.get(threadId) === rulesNow ? "" : rulesNow;
      this.rulesSent.set(threadId, rulesNow);
      if (opts.context) body = `${opts.context}\n\n${body}`;
      // What Carl did elsewhere is not in the prompt: pi's extension adds it (the "you" layer, a vc-you custom message).
      const texts = [rules, kind === "wake" ? input : body].filter(Boolean);
      live.feed.expect({ kind: "prompt", text: texts.join("\n\n"), clientId: kind === "user" ? clientId : undefined, ...shownInput, ...(opts.itemImages?.length ? { images: opts.itemImages } : {}) });
      try {
        await this.d.backend.startTurn(threadId, { texts, images: opts.images ?? [], model, turnId });
        live.started = true;
      } catch (e) {
        live.finished = true;
        this.live.delete(convId);
        unregisterRun(convId, live.controller);
        live.feed.dispose();
        await fail(`⚠️ The engine could not start this turn: ${(e as Error).message}`, rec);
      }
    });
  }

  /**
   * The "you" layer for a pi session's prompt (the extension's before_agent_start): what Carl did
   * since that session last saw it (`since`: its last vc-you message), as of its conversation: a
   * thread's own, or the one a Ctrl+K / Ctrl+L side thread was opened from.
   */
  private you(q: { threadId?: string; convId?: string | null; since: number | null }): { text: string; until: number } {
    const convId = q.threadId ? (this.byThread.get(q.threadId) ?? null) : (q.convId ?? null);
    const r = youLayer(this.d.vault, { since: q.since, convId });
    return { text: r.text, until: r.until };
  }

  private async ensureThread(conv: EngineConv): Promise<{ threadId: string; fresh: boolean }> {
    const model = this.d.model();
    // Subagents only for models where they work (learned from use; see capabilities.ts).
    const subagents = capabilitiesOf(model).subagents;
    if (conv.threadId) {
      try {
        await this.d.backend.resumeThread(conv.threadId, { model, subagents });
        this.byThread.set(conv.threadId, conv.id);
        return { threadId: conv.threadId, fresh: false };
      } catch (e) {
        if (!(e as any)?.threadUnknown) throw e;
        // A thread of the other runtime or a lost one: a fresh thread, with the transcript handed over.
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
      tools: [...ENGINE_TOOL_SPECS, ...noteToolSpecs, ...contextToolSpecs] as any,
      subagents,
    });
    this.byThread.set(threadId, conv.id);
    this.rulesSent.set(threadId, rulesPrefixForTurn(conv as any)); // the instructions carry them in full
    // History from before this thread (a legacy chat, or a retry on a fresh thread): hand it over once.
    const old = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim()).slice(0, -1);
    if (old.length && !conv.messages.some((m: any) => m.rollover)) {
      const t = old.slice(-30).map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1500)}`).join("\n");
      this.handover.set(conv.id, `<earlier_conversation>\n${t.slice(-12_000)}\n</earlier_conversation>`);
    }
    await patchMeta(this.d.vault, conv.id, { threadId, threadPath: ref });
    return { threadId, fresh: true };
  }

  // ---------------------------------------------------------------- events

  private liveByThread(threadId: string | undefined): Live | undefined {
    if (!threadId) return undefined;
    const c = this.byThread.get(threadId);
    return c ? this.live.get(c) : undefined;
  }

  private onEvent(e: BackendEvent): void {
    const parent = this.childOf.get(e.threadId);
    if (parent) {
      // A subagent's own stream: keeps the parent's turn alive, never mixed into its transcript.
      const pl = this.live.get(parent);
      if (pl) pl.lastEventAt = Date.now();
      if (e.kind === "turnCompleted") this.updateSubagent(parent, e.threadId, { status: e.status });
      return;
    }
    // A subagent's end can arrive after its parent's turn is gone (the parent crashed): still record it.
    if (e.kind === "subagentStatus" && !this.liveByThread(e.threadId)) {
      const convId = this.byThread.get(e.threadId);
      if (convId) this.updateSubagent(convId, e.child, { status: e.status, ...(e.patch ?? {}) });
      return;
    }
    const l = this.liveByThread(e.threadId);
    if (!l) return;
    l.lastEventAt = Date.now();
    switch (e.kind) {
      case "pi":
        this.onPi(l, e.ev);
        return;
      case "alive":
        return;
      case "usage": {
        l.usage = e.usage;
        const w = e.usage.modelContextWindow;
        if (w && this.picture(l.convId)?.meta.contextWindow !== w) this.emit(l.convId, { type: "meta", patch: { contextWindow: w } });
        return;
      }
      case "subagents": {
        for (const t of e.children) {
          if (!this.childOf.has(t)) {
            this.childOf.set(t, l.convId);
            this.updateSubagent(l.convId, t, { prompt: String(e.prompt ?? "").slice(0, 300), model: e.model ?? this.d.model(), status: "running", startedAt: Date.now() });
          }
        }
        // The children ride on the parent's own `subagent` tool call (its id; an older extension
        // without it: the newest `subagent` call still open).
        const call = this.spawnCall(l.convId, e.itemId);
        if (call) for (const t of e.children) this.updateSubagent(l.convId, t, { toolCallId: call });
        if (e.done && e.ok && e.op === "spawnAgent" && e.children.length) {
          if (learn(this.d.model(), "subagents", true, `spawned ${e.children.length} subagent(s) in a real turn`)) this.log(`learned: ${this.d.model()} subagents on`);
        }
        return;
      }
      case "subagentStatus":
        if (!this.childOf.has(e.child)) this.childOf.set(e.child, l.convId);
        this.updateSubagent(l.convId, e.child, { status: e.status, ...(e.path ? { path: e.path } : {}), ...(e.patch ?? {}) });
        return;
      case "turnCompleted":
        // Going down: pi was killed with the server; the turn stays open in the log for the next boot.
        if (shuttingDown) return;
        void this.finishTurn(l, e.status, e.error ?? l.feed.lastError);
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

  /** One pi event: into the feed (piFeed.ts), plus what the engine itself watches. */
  private onPi(l: Live, ev: any): void {
    l.rec.pi(ev);
    switch (ev?.type) {
      case "tool_execution_start": {
        const id = String(ev.toolCallId ?? "");
        const name = String(ev.toolName ?? "");
        // A call the model made after its ScheduleWake (the refusal goes back to it).
        // Past AFTER_WAKE_MAX it is not listening: the engine ends the turn.
        if (l.flags.wake && !l.seen.has(id) && !AFTER_WAKE_OK.has(name)) {
          l.afterWake++;
          if (l.afterWake >= AFTER_WAKE_MAX && !l.endedAfterWake) {
            l.endedAfterWake = true;
            this.log(`turn on ${l.convId} kept calling tools after ScheduleWake (${l.afterWake}); ending it`);
            void this.interrupt(l.convId, false);
          }
        }
        l.seen.add(id);
        l.open.set(id, { name: toolName(name), input: ev.args ?? {} });
        break;
      }
      case "tool_execution_end": {
        const id = String(ev.toolCallId ?? "");
        const o = l.open.get(id);
        if (o && WRITE_TOOLS.has(o.name) && !ev.isError) {
          const p = writtenPath(this.d.vault, o.input);
          if (p) this.d.onFilesWritten?.([p]);
        }
        l.open.delete(id);
        break;
      }
    }
    l.feed.onPi(ev);
  }

  private onThreadLost(l: Live): void {
    if (l.ask) {
      // Parked on a question: the answer starts the next turn (the question stays open).
      l.finished = true;
      this.live.delete(l.convId);
      unregisterRun(l.convId, l.controller);
      l.feed.dispose();
      this.emit(l.convId, { type: "meta", patch: { running: null } });
      return;
    }
    l.cut = true;
    void this.finishTurn(l, "interrupted", null).then(() => this.run(l.convId, RESUME_TEXT, "resume")).catch((err) => this.log(`resume ${l.convId} failed: ${err}`));
  }

  private spawnCall(convId: string, itemId: string | undefined): string | null {
    const p = this.picture(convId);
    if (!p) return null;
    const all = shown(p);
    if (itemId && all.some((x) => x.kind === "tool" && x.id === itemId)) return itemId;
    for (let j = all.length - 1; j >= 0; j--) {
      const x = all[j]!;
      if (x.kind === "tool" && x.name === "subagent" && isOpen(x)) return x.id;
    }
    return itemId || null;
  }

  private async finishTurn(l: Live, status: string, error: any): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    if (this.live.get(l.convId) === l) this.live.delete(l.convId);
    unregisterRun(l.convId, l.controller);
    l.feed.dispose();
    const vault = this.d.vault;
    const errStr = status === "failed" ? errText(error) : "";
    if (errStr && /tool/i.test(errStr) && /(not support|unsupported|No endpoints found)/i.test(errStr)) {
      learn(this.d.model(), "tools", false, `request rejected: ${errStr}`);
    }
    const conv0 = await readConv(vault, l.convId);
    const wakeAt = nextWakeFor(vault, l.convId);
    // The final state, decided once (the log never says idle on the way to blocked).
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
    // The turn is over: messages pi never took (a stop clears its queue; a failure drops it) are no longer pending.
    this.emit(l.convId, { type: "meta", patch: { running: null, pending: null, state, nextWakeAt: wakeAt ?? null, ...(stuck || failedKeepGoing ? { working: false } : {}) } });
    // What ended it, said once in the transcript (after what was in flight, which the end closed).
    if (l.cut) await this.notice(l.convId, INTERRUPTED_TEXT, "error");
    // (A failure pi's own message carries is shown from that message: not said twice.)
    else if (status === "failed" && errStr !== l.feed.lastError) await this.notice(l.convId, `⚠️ The turn failed: ${errStr}`, "error");
    else if (status === "interrupted" && !l.endedAfterWake) await this.notice(l.convId, l.stalled ? "Stalled — interrupted by the watchdog." : "Stopped.", "info");
    const conv = await readConv(vault, l.convId);
    const reply = l.feed.replies.join("\n\n").trim();
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);
    const outcome = l.cut ? "cut" : l.stalled ? "stalled" : l.endedAfterWake ? "ended_after_wake" : l.stopped ? "stopped" : status === "completed" ? "ok" : status;
    this.turnLine(l.rec, { status, outcome, state, error: errStr || null });
    this.d.onTurnEnded?.(l.convId);

    // Cost, from the session's own figures (async; lands a few seconds later).
    void this.settleCost(l.convId, conv?.threadPath ?? conv0?.threadPath, l.turnId);

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

    if (failedKeepGoing) {
      this.nudged.delete(l.convId);
      await this.d.notify({ kind: "info", title: `Failed: ${conv.title}`.slice(0, 90), body: (reply || errStr || "Its last turn failed.").slice(0, 600), convId: l.convId });
      return;
    }

    // Rolling sessions: past the threshold, retire the thread with a recap.
    if (status === "completed" && l.usage && shouldRoll(conv as any, l.usage)) {
      await this.rollOver(conv).catch((e) => this.log(`roll-over failed: ${e}`));
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
    await this.note(conv.id, [{ kind: "divider", text: r.recap, rollover: true }]);
    this.emit(conv.id, { type: "meta", patch: { recap: r.recap, threadId: null, threadPath: null } });
    if (typeof r.costUsd === "number" && r.costUsd) this.addCost(conv.id, r.costUsd);
    if (from) this.byThread.delete(from);
    this.log(`rolled ${conv.id} over (from ${from}); next turn starts a new thread`);
  }

  private updateSubagent(convId: string, threadId: string, patch: Record<string, unknown>): void {
    const p = this.picture(convId);
    if (!p) return;
    const subs = ((p.meta.subagents ?? []) as { threadId: string }[]).slice();
    const i = subs.findIndex((s) => s.threadId === threadId);
    if (i >= 0) subs[i] = { ...subs[i]!, ...patch };
    else subs.push({ threadId, ...patch });
    this.emit(convId, { type: "meta", patch: { subagents: subs } });
  }

  private async settleCost(convId: string, threadPath: string | undefined, turnId: string): Promise<void> {
    if (!threadPath) return;
    await new Promise((r) => setTimeout(r, 1500));
    // The turn's own calls, plus every call of this conversation's subagents
    // (their sessions are separate; the ledger skips ids already counted).
    const childCalls = [...this.childOf.entries()].filter(([, c]) => c === convId).flatMap(([t]) => this.d.backend.childUsageCalls(t));
    const res = await this.d.ledger.settle([...this.d.backend.usageCalls(threadPath, turnId), ...childCalls]);
    if (!res.calls) return;
    this.scoped(() => this.addCost(convId, res.usd, res.missing));
  }

  /** At boot: cost any model call a restart cut off before its lookup finished
   * (the ledger skips ids already counted), onto its conversation. */
  private async reconcileCosts(): Promise<void> {
    const log = logOf(this.d.vault);
    for (const id of log.ids()) {
      const p = this.picture(id);
      const path = p?.meta.threadPath;
      if (!p || !path) continue;
      const calls = this.d.backend.usageCalls(path).filter((x) => !this.d.ledger.has(x.responseId));
      if (!calls.length) continue;
      const res = await this.d.ledger.settle(calls);
      if (!res.calls) continue;
      this.addCost(id, res.usd, res.missing);
      this.log(`reconciled ${res.calls} uncounted call(s) on ${id}: $${res.usd}`);
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
    // After ScheduleWake the turn is over: only Done or Blocked may still end it differently
    // (a background make's BoardSend is the maker's, not this turn's).
    if (l?.flags.wake && l.wakeAt && !AFTER_WAKE_OK.has(name) && !(name === "BoardSend" && a?.make)) return { success: false, contentItems: [{ type: "inputText", text: wakeRefusal(l.wakeAt) }] };
    try {
      // ListProjects only reads: no agent tool makes a project or moves a chat (Carl does, in the app).
      if (isContextTool(name)) return await handleContextTool(name, a, { conv: conv as any, convs: (await allConvs(vault)) as any });
      // The notes tools: the same code voice runs (server/notesTools.ts), every result read back from the file.
      if (isNoteTool(name)) {
        const r = await noteTool(vault, name, a);
        return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
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
          // Never the same wake twice (summer: 36 duplicate reminders): one already set for this reason, or within a
          // minute of this time, stands.
          const same = readWakes(vault).find((w) => w.conv === convId && (w.reason.trim().toLowerCase() === reason.toLowerCase() || Math.abs(w.at - at) < 60_000));
          if (same) return text(`A wake is already set for ${new Date(same.at).toISOString()} ("${same.reason}"); no second one was added. Stop now: do not call any more tools this turn.`);
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
          this.emit(convId, { type: "meta", patch: { working: false, nextWakeAt: null, verdict: { verdict: v.verdict, notes: v.notes, at: v.at, summary } } });
          if (typeof v.costUsd === "number" && v.costUsd) this.addCost(convId, v.costUsd);
          await this.notice(convId, `Verifier: ${line}`, v.verdict === "pass" ? "info" : "warn");
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
        case "BoardSend": {
          const r = await sendEntry(vault, a, { conversation: convId, emit: (ev) => this.inboxEvent(ev) });
          if (!r.ok) return { success: false, contentItems: [{ type: "inputText", text: `Refused (nothing reached the inbox):\n- ${r.refusals.join("\n- ")}` }] };
          return text(JSON.stringify({ id: r.id, parts: r.parts }) + " — in Carl's whiteboard inbox.");
        }
        case "BoardMake": {
          const request = String(a.request ?? "").trim();
          const title = String(a.title ?? "").trim();
          if (!request || !title) return text("BoardMake needs a request and a title.");
          const entry = startMake(vault, { title, request }, { conversation: convId, emit: (ev) => this.inboxEvent(ev) });
          const t0 = Date.now();
          const started = this.d.backend.background(p.threadId, {
            agent: { name: "board-maker", systemPrompt: BOARD_MAKER_PROMPT, tools: ["read", "bash", "edit", "write", "BoardSend"] },
            task: boardMakeTask(entry.id, title, request),
          });
          inboxLog({}, "make.spawn", { id: entry.id, ms: Date.now() - t0 });
          void started
            .then((r: any) => {
              // Where the time went: the whole make, and the maker's model calls (its own session file).
              inboxLog({}, "make.done", { id: entry.id, ms: Date.now() - t0, ok: !!r?.ok, state: r?.state ?? null, model: r?.model ?? null, costUsd: r?.costUsd ?? null, ...(makerStats(r?.sessionFile) ?? {}) });
              // Landed: the last send cleared `making`. Otherwise it failed: say why in the inbox.
              const e = readEntry(vault, entry.id);
              if (e?.making) failMake(vault, entry.id, r?.ok ? (e.parts.length ? "the maker stopped before its last send" : "the maker finished without sending anything") : String(r?.text ?? r?.state ?? "the maker failed").split("\n")[0]!, { emit: (ev) => this.inboxEvent(ev) });
            })
            .catch((err: Error) => failMake(vault, entry.id, err.message, { emit: (ev) => this.inboxEvent(ev) }));
          return text(`Making it in the background (inbox entry ${entry.id}, shown as being made). It lands in Carl's inbox when ready; don't wait for it.`);
        }
        case "BoardInbox":
          return text(boardInboxText(vault, a.id ? String(a.id) : null));
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
          // The plan is the call itself (pi's toolCall carries it; the reducer reads the last one).
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

  /** An inbox change on /poll (the iPad's badge); a landed entry carries a short line for a live voice session to say at its next pause (src/voice-elevenlabs.ts). */
  private inboxEvent(ev: InboxEvent): void {
    this.d.broadcast?.({ ...ev, ...(ev.landed ? { say: `"${ev.title}" is in your board inbox.` } : ev.failed ? { say: `I couldn't make "${ev.title}": ${ev.failed}.` } : {}) });
  }


  /** Park the turn on a question until Carl answers (via /message, /answer or an answer intent). */
  private async waitForAnswer(threadId: string, question: string, options: string[]): Promise<string> {
    const convId = this.byThread.get(threadId) ?? this.childOf.get(threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (!convId || !l) return "No one is available to answer right now. Continue with your best judgement and say what you assumed.";
    const vault = this.d.vault;
    const conv = await readConv(vault, convId);
    l.asks++;
    const itemId = `${l.turnId}:ask:${l.asks}`;
    const p = new Promise<string>((resolve) => {
      l.ask = { resolve, question, itemId };
    });
    this.emit(convId, { type: "meta", patch: { asking: { question, options, at: Date.now() }, state: "waiting_user" } });
    await this.d.notify({ kind: "ask", title: (conv?.title ? `Needs you: ${conv.title}` : "Needs your call").slice(0, 90), body: question, convId, options });
    return p;
  }

  /** Carl's answer: his message (under his client's id), the question closed, the turn resumed (or a new one). */
  private async answer(convId: string, answer: string, clientId: string = newMessageId()): Promise<void> {
    const l = this.live.get(convId);
    const ask = this.picture(convId)?.meta.asking ?? null;
    // His line is the question's result pi writes ("Carl answered: …"), under his client's id.
    if (l?.ask) l.feed.answered(clientId);
    this.emit(convId, { type: "meta", patch: { asking: null, state: l?.ask ? "running" : "idle" } });
    this.nudged.delete(convId);
    // The question's card in the phone feed is answered too, however the answer came in.
    if (this.markAsksAnswered(convId, answer)) this.d.broadcast?.({ type: "notif" });
    if (l?.ask) {
      const a = l.ask;
      l.ask = null;
      l.lastEventAt = Date.now();
      a.resolve(answer);
      return;
    }
    // The turn that asked is gone (a restart): a new turn carries the answer.
    const q = ask?.question;
    void this.run(convId, q ? `Carl's answer to your question "${q}": ${answer}` : answer, "user", { clientId, shown: answer, via: "answer" });
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
    await patchMeta(this.d.vault, w.conv, { nextWakeAt: nextWakeFor(this.d.vault, w.conv) ?? undefined });
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

function errText(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message ?? JSON.stringify(e)).slice(0, 500);
}


/** BoardInbox's answer: entries, their status, and whether added items are still on their boards. */
function boardInboxText(vault: string, id: string | null): string {
  const { entries } = listEntries(vault);
  const pick = id ? entries.filter((e) => e.id === id) : entries.slice(0, 20);
  if (!pick.length) return id ? `No inbox entry ${id}.` : "The inbox is empty.";
  return pick
    .map((s) => {
      const e = readEntry(vault, s.id);
      const state = s.failed ? `couldn't make: ${s.failed}` : s.making ? "being made" : s.status;
      const lines = [`${s.id} — "${s.title}" (${state}; ${s.parts.length} part${s.parts.length === 1 ? "" : "s"})`];
      for (const [k, v] of Object.entries(e?.added ?? {})) {
        let still = "?";
        try {
          const b = JSON.parse(readFileSync(join(vault, "boards", v.board, "board.json"), "utf8"));
          const have = new Set((b.items ?? []).map((x: any) => x.id));
          const n = v.items.filter((x) => have.has(x)).length;
          still = n === v.items.length ? "still on the board" : n ? `${n} of ${v.items.length} still on the board` : "removed from the board";
        } catch {
          still = "board not found";
        }
        const label = e?.parts[Number(k)]?.label;
        lines.push(`  part ${Number(k) + 1}${label ? ` (${label})` : ""}: added to ${v.board}, ${still}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

