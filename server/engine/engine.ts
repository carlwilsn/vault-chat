import { globalCutover } from '../convlog/globalCutover';
// The engine: every agent turn on the box runs in a backend behind the
// EngineBackend contract (backend.ts); today that is pi (pi/backend.ts). A
// conversation maps to one pi session ("thread"; a new one after a roll-over).
// The transcript is pi's own session file; the vault's feed (server/convlog,
// src/convlog/protocol.ts) points into it as pi writes it and carries pi's live
// events for the message in flight (piFeed.ts). What only vault-chat knows
// (the turn running, steers pi has not delivered, an open question, cost,
// subagents, the next wake) is the conversation's fields in the same feed; its own
// lines (a notice) are pi custom entries
// (`vc-note`), written by pi while it has the session. Every client folds the
// feed with one reducer. vault-chat's tools reach pi through its extension as
// host calls.
import { vaultPath } from "../vaultPath";
import { conversationRoot } from "../context/config";
import { ownerVault } from "../convlog/log";
import { appendFileSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { LIVE_LIMITS, allowRate, liveAskText } from "../../src/liveBridge";
import { holdRun, registerRun, unregisterRun } from "../../src/runRegistry";
import type { BackendEvent, EngineBackend, ToolSpec, HostLoadout, Interaction } from "./backend";
import {
  withVault,
  contextToolSpecs,
  handleContextTool,
  isContextTool,
  buildDeveloperInstructions,
  rulesPrefixForTurn,
  turnSections,
  readProject,
  deleteProjectFiles,
  restoreProjectFiles,
  listDeletedProjects,
  renameProject,
  listProjects,
  projectCost,
  ctxConfig,
  type EngineConv,
} from "./context";
import { patchMeta, readConv, allConvs, createConv, newMessageId, emitTo, pictureOf, logOf, writeNotes, appendNotes, setNoteWriter, ensureMain, ensureProjectThread, type NoteData } from "./convs";
import { workerWorktree } from "../workerWorktree";
import { MAIN_ID, projectOfThread, projectThreadId, threadKindOf } from "../../src/threads";
import { searchHistory } from "./history";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "./wakes";
import { pdfPagesAnswer, pdfPagesSpec, pdfRead, webFetch, webFetchSpec } from "./extraTools";
import { failMake, inboxLog, listEntries, readEntry, sendEntry, startMake, type InboxEvent } from "../inbox";
import { BOARD_MAKER_PROMPT, boardMakeTask, makerStats } from "./boardTools";
import { lookBoard } from "../boards";
import { show, SHOW_DESCRIPTION, SHOW_SCHEMA } from "../show";
import { boardGuard } from "../boardGuard";
import { openProject, OPEN_PROJECT_DESCRIPTION, OPEN_PROJECT_SCHEMA } from "../projectRoutes";
import { startJobWith, jobStatus, jobList, jobStop, reapJobs, readJobs, type JobEnv } from "./jobs";
import { devProxies, exposedNote, jobPorts } from "../devProxy";
import { recordUITool, RECORD_DESCRIPTION, RECORD_SCHEMA } from "../recordUI";
import { externalRecordUI } from "../mcp/recordUI";
import { loadConfig } from "../config";
import { ENGINE_ROLE_PROMPT } from "./prompt";
import { isNoteTool, noteTool, noteToolSpecs } from "../notesTools";
import { PLUGIN_TOOL, pluginTool, pluginToolSpecs } from "../supervisorTools";
import { capabilitiesOf, capabilityNote } from "./capabilities";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectFolderOf, reviveFolder } from "../projectFolders";
import { deleteFolder, folderOpsWalls } from "../folderOps";
import { answerReview, cloneDirOf, ensureClone, isGatedProject, pendingReview } from "../projectChanges";
import { WRITE_TOOLS, writtenPath } from "../liveEdits";
import { appendActivity, contextImage, searchActivity, youLayer } from "../activity";
import { CAPTURE_FRESH_MS, chatPointerEntry } from "../../src/activityCore";
import type { EventBody, ItemImage, PendingInput } from "../../src/convlog/protocol";
import { isOpen, pendingOf, type Picture } from "../../src/convlog/reduce";
import { makeChatView, toolName } from "../../src/convlog/view";
import { waitInputs } from "../../src/voiceWaitLine";
import { lookupAll } from "./lookup";
import { pluginCatalog } from "../pluginCatalog";
import { catalogText } from "../../src/pluginCatalog";
import { attachmentAt, attachmentsNote } from "../attachments";
import { readEntries } from "../convlog/piSession";
import { PiFeed, type Expected, type UserRequest } from "./piFeed";
import { READ_ONLY_TOOLS, type ModelChoice, type SideLog, type SideState } from "./backend";
import { TurnRecorder, type TurnLine } from "./turnLog";
import { SERVER_VERSION } from "../config";
import { runVaultTool, vaultToolSpecsFor } from "../vaultTools";
import { submitChangeJob, SUBMIT_CHANGE_SCHEMA } from "../submitChange";
import { isClaudeModel, isEffort, type Effort } from "./claude/models";
import { SIGN_IN_AGAIN } from "./claude/auth";

export type EngineDeps = {
  vault: string;
  backend: EngineBackend;
  jobEnv: JobEnv;
  model: () => string;
  /** The effort a chat Carl has not chosen for runs at (his last choice). */
  effort?: () => Effort | undefined;
  /** Keep his newest pick as what a NEW chat starts from. */
  rememberModel?: (model: string) => void;
  rememberEffort?: (effort: string | null) => void;
  /** Web Push + notifications.jsonl + the /poll "notif" signal. */
  notify: (n: EngineNotice) => Promise<string | null>;
  /** One-line log. */
  log?: (s: string) => void;
  /** The engine of the vault at this path (the owner of a chat this vault's log does not hold). */
  engineAt?: (path: string) => Promise<Engine | null>;
  /** A vault-level signal on /poll (the inbox, notifications). */
  broadcast?: (ev: Record<string, unknown>) => void;
  /** Model for a turn that carries images when the default can't see. */
  visionModel?: string;
  /** A Write/Edit/NotebookEdit succeeded: the vault-relative paths it changed (server/liveEdits.ts). */
  onFilesWritten?: (paths: string[]) => void;
  /** A turn ended (the sync brings its results to the laptop). */
  onTurnEnded?: (convId: string) => void;
  /** A chat's summary title from its transcript (tests); default: a one-shot on TITLE_MODEL. */
  titleWith?: (instructions: string, text: string) => Promise<string>;
  /** The vault's name on this box (the turn log's `vault`); the folder's name when absent. */
  vaultName?: string;
  /** One structured line per turn (turnLog.ts): the box's turn log and the journal. */
  turnLog?: (line: TurnLine) => void;
  /** The per-command sandbox the vault's own tools run in (server/vaultTools.ts); null: none (not Linux). */
  shell?: () => string[] | null | undefined;
};

/** What the engine raises: a question (kind "ask") or a line for Carl (kind "info"), with what the
 * push gate needs to decide whether the phone buzzes (server/pushGate.ts). */
export type EngineNotice = {
  kind: "info" | "ask";
  title: string;
  body: string;
  convId: string;
  options?: string[];
  /** Why the phone would buzz: a question, a finish, a failure he must act on. Default: ask for an ask, else finished. */
  why?: "ask" | "finished" | "failed";
  /** Carl started what finished (his message, or a wake or job his own turn set). */
  byCarl?: boolean;
  /** Still needs him (an ask: not answered yet). */
  stillNeeded?: () => boolean;
  /** What raised it, for the push log. */
  trigger?: string;
  /** Only the buzz: no feed card (a turn's own end: the chat already shows it). */
  pushOnly?: boolean;
  /** Only Notify may set this, after validating a host-owned originating turn. */
  explicitPush?: boolean;
  workId?: string;
};

type TurnKind = "user" | "wake" | "resume";

type Live = {
  convId: string;
  threadId: string;
  /** The turn's id: pi's (backend) and the log's are the same. */
  turnId: string;
  kind: TurnKind;
  startedAt: number;
  /** pi's session and live events → the feed. */
  feed: PiFeed;
  /** pi's events → the turn's log line. */
  rec: TurnRecorder;
  ask: { resolve: (answer: string) => void; question: string; itemId: string } | null;
  asks: number;
  /** Tool calls in flight (started, no result yet): a write tool's path is reported when it ends. */
  open: Map<string, { name: string; input: any }>;
  cut: boolean;
  stopped: boolean;
  /** Ended by "Send now": Carl's waiting message starts the next turn (no "Stopped." line). */
  sendNow?: boolean;
  /** Stopped because the API refused the sign-in: its one line is already written. */
  refused?: boolean;
  controller: AbortController;
  /** pi accepted the prompt. */
  started: boolean;
  finished: boolean;
  /** What started the turn (for the silent retry). */
  input: string;
  /** Carl started it: his message, or a wake or job a turn of his set (server/pushGate.ts: only his finishes buzz). */
  byCarl: boolean;
  turnOpts: TurnOpts;
  /** The thread's working folder (the vault, or a project's main folder): relative tool paths start here. */
  cwd: string;

};

type TurnOpts = { completion?: import("./backend").NativeCompletion; /** Send now replays the existing feed directly into Pi before its replacement prompt can settle. */ replay?: Expected[]; /** Existing host-owned job/wake identity, never a push arm. */ pushWorkId?: string; images?: string[]; context?: string; hostContext?: string; itemImages?: ItemImage[]; clientId?: string; /** What the chat shows (Carl's answer to a question asked before a restart). */ shown?: string; device?: "laptop" | "phone" | "board" | null; via?: string; /** Which client sent it (the turn log's `via`: laptop, phone, voice …). */ origin?: string; /** A wake, job or resume of something Carl started. */ byCarl?: boolean; /** An engine input that runs as its own turn once the running one ends, never folded into it (a background report: pi may settle the turn before a follow-up is taken, and a turn parked on a question takes none). */ ownTurn?: boolean; /** The backend already started this turn by itself (a queued message it took, a background task that finished): open the turn around it instead of sending a prompt. */ adopt?: boolean; /** The retry of work held for the usage limit (its hold's count): failing on the limit again waits for the next reset, longer. */ limitTries?: number; /** Carl's message held (shown waiting) while the conversation was being summarized: not run if he took it back meanwhile. */ held?: boolean };

const RESUME_TEXT =
  "The box restarted (or the engine stopped) while your last turn was running, so any command it was running was killed and may not have finished. Re-check reality (files, processes, logs), then continue from where you were.";
const LEGACY_SOURCES = new Set(["mission", "worker", "ask"]);
/**
 * Carl's usage limit: what failed on it (his messages, a wake, a job's report)
 * is already in the thread's history, so it is held as ONE turn per
 * conversation that runs after the reset and takes all of it up together.
 */
const LIMIT_TEXT =
  "Carl's usage limit has reset. The messages above that got no reply (his, or a wake or job report) were sent while it was reached: take them up now, in order, in one reply.";
const LIMIT_SHOWN = "Usage limit reset: picking up where it stopped";
/** After the reset the SDK named: its clock and ours are not the same clock. */
const LIMIT_MARGIN_MS = 60_000;
/** No reset named: wait this long, doubling on each failed retry, up to the cap. */
const LIMIT_BACKOFF_MS = 5 * 60_000;
const LIMIT_BACKOFF_CAP_MS = 60 * 60_000;
const ARCHIVED = "This is an archived mission thread (the old missions system): readable, never run. Start a new chat.";
const INTERRUPTED_TEXT = "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.";

/**
 * How many times in a row a lost thread is resumed before the engine stops and
 * says so, and the window that counts as "in a row".
 *
 * A session that dies mid-turn is resumed, which is right: a runtime that fell
 * over should not cost Carl the turn. But a session that dies on EVERY request —
 * a rejected token, a model the subscription cannot run, a 400 the runtime
 * treats as fatal — dies again the moment it is resumed, and nothing here
 * counted. That is how one turn made 1,262 requests during the pi deletion,
 * against a local fake; against the real API it is Carl's own subscription being
 * spent on a loop that cannot succeed. Three tries, then the chat is told.
 */
const MAX_RESUMES = 3;
const RESUME_WINDOW_MS = 5 * 60_000;
const RESUME_GAVE_UP =
  "⚠️ The engine could not keep this turn going: its session ended three times in a row without getting anywhere. Nothing more was sent. Send again when you want it to try, or check the Claude sign-in in Settings.";


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
    name: "SubmitChange",
    description: "After checking the change and recording its real UI, push your agent/<name> branch to the configured remote, then submit that branch here. One separately installed box script runs the seven baseline/candidate gates and fast-forwards main if there are no new named failures or lost test coverage. Returns an existing background job. Acceptance is not Shipped: laptop sync, CI, actual box and authenticated laptop health follow. Never merge or push main.",
    inputSchema: SUBMIT_CHANGE_SCHEMA,
  },
  {
    type: "function",
    name: "ScheduleWake",
    description:
      "Schedule ONE future turn of this conversation (survives restarts), only when Carl asks for a reminder or a later check. Give `in` (e.g. \"2m\", \"1h30m\") or `at` (ISO time), and the reason you will read when woken. Then end your turn.",
    inputSchema: {
      type: "object",
      properties: { in: { type: "string" }, at: { type: "string" }, reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "PostToConversation",
    description:
      "Hand work to one of Carl's other chats: post a message into it, which starts its own turn there. It does not wait for the answer — the chat you posted to does the work and tells Carl itself. Use it to pass something to the chat that already owns that work (ListConversations, ReadConversation name them); never to post into this chat, and never for something Carl should simply be told (that is Notify). It is shown in that chat as a message from outside it, not as Carl's words.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "The chat to post into (from ListConversations)." },
        text: { type: "string", description: "What that chat should do, in full: it has none of this chat's context." },
      },
      required: ["conversation_id", "text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Notify",
    description:
      "Tell Carl that something he asked for finished, or that something needs him (a failure he must act on). It always lands in his in-app alerts. Phone push is OFF by default. Set push:true ONLY when Carl explicitly asked to be pinged for THIS work (e.g. 'Ping me when it is done', 'notify me if it fails'), and only on that requested finish/failure, not progress or unrelated later work. One invocation requests one event push, not future alerts. A worker must use only the request passed into its original task, never a later parent request. Omit push otherwise. Push still respects away/seen/dedup rules; an optional user Settings preference restores legacy automatic pushes. The title says plainly what finished or what is needed (\"Done: …\", \"Needs you: …\"). Not for progress, not for background work he did not ask about, not for questions (AskUser).",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, push: { type: "boolean", description: "One event only: true exclusively for an explicit user request to push the finish/failure of this work. Missing/false means in-app only unless legacy automatic pushes are enabled." }, needsYou: { type: "boolean", description: "true when Carl must act (a failure, something blocked on him); false or absent for a finish." } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "PdfRead",
    readOnly: true,
    description: "Read text from a PDF in the vault: the page count plus the pages asked for (default 1-3), capped at maxChars (default 12000). Use page ranges; never read a whole long PDF at once. The read tool gives a PDF's raw bytes: use this instead, and never ask Carl for a screenshot of a PDF you can read. When a page has no text layer (a scan, handwriting), or the question is about a figure, a diagram or the layout, use PdfPages to see the page.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, pages: { type: "string", description: "e.g. \"1\", \"4-8\", \"1,3,7-9\"" }, maxChars: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  webFetchSpec,
  {
    type: "function",
    name: "StartJob",
    description:
      "Start a long-running shell command that must outlive this turn (training, downloads, builds, a dev server such as `npm run dev`: Show {url: \"http://localhost:<port>\"} then opens it on Carl's devices, behind his login; keep it on localhost, never --host 0.0.0.0, which would put it on his network unguarded). It runs detached, sandboxed, in the vault, with a memory ceiling and a low CPU share; output goes to a log. It is stopped after `timeout` (default \"24h\", at most \"7d\"). At most 4 run at once in the vault. When it ends, this conversation gets a wake turn with its exit code and last lines. Returns a job id.",
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
    readOnly: true,
    description: "This conversation's background work: its running background workers (id, title, what each is doing now) and its StartJob jobs (all: true for every job in the vault): id, state, age, command.",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "JobStop",
    description: "Stop a running background worker or StartJob job by its id (JobList). A stopped worker's turn still follows, saying it was stopped.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "JobStatus",
    readOnly: true,
    description: "What a background worker is doing now (its latest step, steps done, time), or a StartJob job's state and last output lines.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, tail: { type: "number" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "JobSteer",
    description: "Pass Carl's change to a running background worker (\"make it shorter\"): it takes it up after its current step and keeps going. The id is from JobList.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"], additionalProperties: false },
  },
  {
    type: "function",
    name: "BoardSend",
    description:
      "Send something to Carl's iPad whiteboard inbox (he adds it to a board himself). Only when Carl asks for the board or his iPad (\"send it to my iPad\", \"put it on the board\") or is at the board now (the \"you\" layer's Device: board, or a call on the board); a visual for him anywhere else goes where he is talking: an image in your reply, or Show. When he is on another device and did not ask, it is refused with why; asked: true when he did ask (earlier, or in other words). Use it directly only when everything already exists: PDF pages, math you have written, an image or widget file already in the vault. Parts (ordered, each addable on its own): {kind:\"pdf\", path, pages:[3,4,5] (1-based, ≤20)} | {kind:\"math\", markdown (with $…$ / $…$), label?} | {kind:\"image\", path (PNG/JPEG/WebP/SVG in the vault), alt} | {kind:\"widget\", path (one TypeScript module exporting mount(el, api); api: size(), onResize(fn), theme; no network), alt, layout?:{w,h}}. Optional width (canvas units; the view is 1000 wide) and label per part. A problem set is one math part per problem. A bad send is refused with every reason: fix them and send again. Returns the entry id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        note: { type: "string" },
        parts: { type: "array", items: { type: "object" } },
        make: { type: "string", description: "Only inside a BoardMake: the id of the entry being made." },
        asked: { type: "boolean", description: "Carl asked for the board or iPad (earlier, or in words the check did not catch)." },
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
      "Have something made for Carl's iPad whiteboard in the background (a problem set, a graph, a widget) and land in its inbox. Only when Carl asks for the board or his iPad, or is at the board now (Device: board, or a call on the board); never for \"visualize this\" while he is on his laptop or phone — make that picture yourself and put it in your reply. When he is elsewhere and did not ask, it is refused with why; asked: true when he did ask. Returns at once; a sub-agent in this vault makes the files, sends them through BoardSend and fixes refusals itself. The inbox shows it as being made, then the result or why it couldn't be made. Never wait for it: tell Carl it's on its way and carry on.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What to make, with everything the maker needs (the maker does not see this conversation)." },
        title: { type: "string", description: "The inbox title, one line." },
        asked: { type: "boolean", description: "Carl asked for the board or iPad (earlier, or in words the check did not catch)." },
      },
      required: ["request", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "BoardInbox",
    readOnly: true,
    description: "The whiteboard inbox: each entry's title, status (unread / read / added / being made / couldn't make) and, for added parts, the board and whether its items are still there. Give id for one entry.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "BoardLook",
    readOnly: true,
    description:
      "See one of Carl's whiteboard boards as it was last saved, whether or not it is on any screen (on his laptop he may be looking at a PDF: that is not the board). `board`: its name or words of it (\"physics\"); left out, his most recently changed board. Attaches the part he had in view on the iPad at that save and a picture of the whole board. Use it for \"look at my whiteboard\" or \"what did I write on the board\": never answer from his screen instead, and never ask him to bring the board up.",
    inputSchema: { type: "object", properties: { board: { type: "string", description: "The board's name or words of it; empty: the most recent." } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "Show",
    description: SHOW_DESCRIPTION,
    inputSchema: SHOW_SCHEMA as unknown as Record<string, unknown>,
  },
  {
    type: "function",
    name: "RecordUI",
    description: RECORD_DESCRIPTION,
    inputSchema: RECORD_SCHEMA as unknown as Record<string, unknown>,
  },
  {
    type: "function",
    name: "OpenProject",
    description: OPEN_PROJECT_DESCRIPTION,
    inputSchema: OPEN_PROJECT_SCHEMA as unknown as Record<string, unknown>,
  },
  {
    type: "function",
    name: "RestoreProject",
    description:
      "Bring back a project Carl deleted, only when he asks for it back. Without project: lists what is deleted (name, slug, when). With project (its name, slug, or a listed entry): the project comes back whole — its folder, notes and memory, its thread with its whole conversation — on every one of his screens. " +
      "This is the only way back: never move or copy anything in agent-projects/.deleted/ yourself (a project put back by hand shows up half-way).",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "The deleted project's name, slug or .deleted entry; omit to list them." } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "DeleteConversation",
    description:
      "Delete Carl's chats by id (from ListConversations), only when he asks for them gone. Recoverable: each leaves every list but its whole history is kept, and RestoreConversation brings it back. Main, a project's thread and this chat itself can't be deleted. Returns what was deleted and what wasn't, with why.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: "The chats' ids." } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "RestoreConversation",
    description: "Bring back a chat Carl deleted, only when he asks for it back. Without id: lists the deleted chats (id, title, when). With id: it is back in his lists as it was.",
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
    name: "RecentActivity",
    readOnly: true,
    description:
      "Search what Carl did on his surfaces over the last days (the shared activity stream: Ctrl+L asks and their answers, Ctrl+K edits, voice lines, captures, files he opened, his messages in other chats, inbox sends). Your turns only get the last ~45 minutes of it; use this when he refers to something older (\"what did I ask before lunch?\"). `query`: words to match (empty: everything); `hours`: how far back (default 24, at most 168).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, hours: { type: "number" }, limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Cost",
    readOnly: true,
    description: "Model spend in USD: this conversation by default, or a project's total.",
    inputSchema: {
      type: "object",
      properties: { conversation: { type: "string" }, project: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Compact",
    readOnly: true,
    description:
      "Compact this conversation's context now (pi's own summary of the earlier conversation; the raw history stays in its file), when Carl asks for it (\"compact\", \"/compact\", \"make the context smaller\"). Optional `focus`: what the summary must keep. It runs when the current turn ends. Never on your own: compaction also happens automatically.",
    inputSchema: { type: "object", properties: { focus: { type: "string" } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "SearchHistory",
    readOnly: true,
    description:
      "Search a thread's full raw history (pi's own session file: everything ever said, before any compaction or Clear), newest first, with the time of each hit. Use it when Carl refers to something earlier that your context no longer holds (\"what did we decide about X last week?\"). `query`: words that must all appear (case-insensitive); `thread`: \"main\" (default: this thread) or a project's name; `limit`: hits (default 12, at most 40). Read-only.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, thread: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Catalog",
    readOnly: true,
    description:
      "What vault-chat's pages can be built from: every registered service a page can name in its <meta name=\"vc-capabilities\"> manifest (what each does, who supplies it, its vc.<fn>), and the plugins in this vault (.html pages with a vc-capabilities or vc-mount manifest: path, name, where it runs, the services it needs). Use it for \"what services exist?\" or \"what plugins do I have?\". Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "Lookup",
    description:
      "Find something in Carl's notes and PDFs (lecture notes, homework) and read it, in one call: give his words (and part of a file name if you know it). Returns the best-matching passages with the lines around them (a PDF's with its page), from the files that match best. Use it instead of a find, grep, read chain.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find, in his words (\"theorem 1.2 proof workbook\")." },
        file: { type: "string", description: "Only files whose path contains this (\"Real 320-1\", \"Workbook\")." },
        lines: { type: "number", description: "Lines to show after each match (default 14, max 40)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/** Every vault-chat tool the agent has (Carl's own vault tools are added per thread). */
export function agentToolSpecs(): ToolSpec[] {
  return [...ENGINE_TOOL_SPECS, pdfPagesSpec, ...noteToolSpecs, ...contextToolSpecs, ...pluginToolSpecs] as ToolSpec[];
}
/** Ctrl+K / Ctrl+L: the agent's tools that change nothing (marked readOnly where they are defined). */
export function sideToolSpecs(): ToolSpec[] {
  return agentToolSpecs().filter((t) => t.readOnly === true);
}
/** The agent's tools a side thread can't use: they belong to a turn (its question, plan, background maker, job, wake). */
const TURN_ONLY_TOOLS = new Set(["AskUser", "SubmitChange", "TodoWrite", "BoardMake", "StartJob", "JobStop", "JobSteer", "ScheduleWake"]);
/** Voice's Ask (server/voice.ts), a side thread: a question has the read-only tools and Show; an action every tool a
 *  side thread can use (BoardSend, Show, the notes …), with pi's own file tools (sideStart). */
export function voiceSideToolSpecs(act: boolean): ToolSpec[] {
  if (act) return agentToolSpecs().filter((t) => !TURN_ONLY_TOOLS.has(t.name));
  return [...sideToolSpecs(), ...agentToolSpecs().filter((t) => t.name === "Show" && t.readOnly !== true)];
}

const text = (t: string) => ({ success: true, contentItems: [{ type: "inputText", text: t }] });

/** A tool's answer for pi: its text, and the images it attaches (BoardLook's board pictures) as pi's image blocks. */
export function toolAnswer(r: any): import("./backend").ToolAnswer {
  const items: any[] = Array.isArray(r?.contentItems) ? r.contentItems : [];
  const images = items.filter((c) => c?.type === "inputImage" && typeof c.data === "string" && c.data).map((c) => ({ data: String(c.data), mimeType: String(c.mimeType || "image/png") }));
  return { ok: r?.success !== false, text: items.filter((c) => c?.type !== "inputImage").map((c) => c?.text ?? "").join("\n"), ...(images.length ? { images } : {}), ...(r?.resources ? { resources: r.resources } : {}) };
}

/** pi's own tools (and the subagent tool): a vault tool of the same name is not registered over them. */
const PI_BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "subagent"];


/** The cheap model a chat's summary title is written on (Carl: Haiku 5.5). */
const TITLE_MODEL = process.env.VC_TITLE_MODEL || "claude-haiku-5-5";
/** After this many of Carl's messages the title is written again, once, from the longer conversation. */
const TITLE_REFRESH_TURNS = 4;
const TITLE_INSTRUCTIONS =
  "You name chats. Read the conversation and answer with only a short title (2 to 6 words) that says what it is about, " +
  "like a heading: no quotes, no trailing punctuation, no \"Title:\". Not a question, and not a copy of the first message.";

export class Engine {
  private live = new Map<string, Live>(); // convId → live turn
  private byThread = new Map<string, string>(); // threadId → convId
  /** Threads whose backend-started turn is being opened (adopt()). */
  private adopting = new Set<string>();
  /** When the usage limit was last logged, so waiting is said once, not every tick. */
  private saidLimitAt = 0;
  private chains = new Map<string, Promise<unknown>>();
  /** Notify calls per conversation in the last hour (the agent's pings are capped). */
  private pings = new Map<string, number[]>();
  private resumeQueue = new Set<string>();
  private firstUp = true;
  private timers: NodeJS.Timeout[] = [];
  private firing = new Set<string>();
  private childOf = new Map<string, string>(); // subagent threadId → parent conversation id
  /** Captures already sent to each conversation's model (in memory): one is never attached twice. */
  private imagesGiven = new Map<string, Set<string>>();
  /** What each thread last received of each turn section (rules, memory, its project.md, the project list, its
   *  folder: context/builder.ts turnSections): a turn sends a section again only when it changed. Forgotten when the
   *  thread compacts (the summary may have dropped them). In memory; after a restart a resumed thread gets them once more. */
  private sectionsSent = new Map<string, Map<string, string>>();
  /** A /compact running per conversation (one at a time). */
  private compacting = new Map<string, Promise<Record<string, unknown>>>();
  /** Waiting for a conversation's turn to end. */
  private turnWaiters = new Map<string, (() => void)[]>();
  /** History from before a conversation's thread, handed to its first turn once (a legacy chat, a lost thread). */
  private handover = new Map<string, string>();
  /** A voice call is live on these conversations (server/voiceBrain.ts): every turn, typed or spoken, runs on the
   *  talker's model with the call's rules (once per call), and its pi events reach the call (tap). */
  private talkers = new Map<string, { model: string; rules: string; sent: boolean; thinking?: string }>();
  /** Lost-thread resumes in a row, per conversation (MAX_RESUMES). Cleared by a turn that gets somewhere. */
  private resumes = new Map<string, { n: number; at: number }>();
  private taps = new Map<string, Set<(ev: any) => void>>();

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
    return withVault(this.d.vault, fn);
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

  /** Live pages' recent asks by page path (src/liveBridge.ts allowRate). */
  private readonly pageAsks = new Map<string, number[]>();

  /** A side thread's turn-log identity: each of its requests (voice's Asks, Ctrl+K / Ctrl+L, one-shots) is a line, mode "side". */
  private sideLog(conv: string | null, via: string, tools?: string[]): SideLog {
    return {
      vault: this.d.vaultName ?? (this.d.vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || this.d.vault),
      conv,
      via,
      ...(tools ? { act: tools.some((t) => !READ_ONLY_TOOLS.includes(t)), allowed: tools } : {}),
      version: SERVER_VERSION,
      write: (line) => this.d.turnLog?.(line),
    };
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

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const b = this.d.backend;
    b.on("event", (e: BackendEvent) => this.scoped(() => this.onEvent(e)));
    b.on("up", () => this.scoped(() => void this.onUp()));
    setNoteWriter(this.d.vault, (convId, notes) => this.scoped(() => this.noteViaPi(convId, notes)));
    b.setHandlers({
      toolCatalog: (loadout) => this.scoped(() => this.hostToolCatalog(loadout)),
      // Its session was summarised: everything the thread had been told, again,
      // for a runtime that can put it back into the compacted session.
      afterCompact: (threadId) => this.scoped(async () => {
        const convId = this.byThread.get(threadId);
        const conv = convId ? await readConv(this.d.vault, convId) : null;
        if (!conv) return "";
        this.sectionsSent.delete(threadId);
        return this.changedSections(threadId, conv);
      }),
      workerCwd: (threadId, cwd) => this.scoped(async () => {
        const conv = await readConv(this.d.vault, this.byThread.get(threadId) ?? "");
        if (!conv) throw new Error("Worker has no owning conversation");
        const parentCwd = this.cwdOf(conv);
        const folder = this.folderOf(conv);
        return folder && "git" in folder && folder.git
          ? workerWorktree({ vault: this.d.vault, slug: projectOfThread(conv.id)!, source: folder.git.folder, parentCwd, cwd })
          : cwd !== undefined ? resolve(parentCwd, cwd) : parentCwd;
      }),
      fileWrite: async (threadId) => !this.talkers.has(this.byThread.get(threadId) ?? ""),
      notifyScope: (threadId) => {
        const l = this.live.get(this.byThread.get(threadId) ?? "");
        return l ? Object.freeze({ workId: l.turnOpts.pushWorkId ?? l.turnId, byCarl: l.byCarl, interaction: this.interaction(l.convId) }) : null;
      },
      toolCall: (threadId, name, args, signal, capturedScope) => {
        const l = this.live.get(this.byThread.get(threadId) ?? "");
        const notifyScope = capturedScope !== undefined ? capturedScope : l ? { workId: l.turnOpts.pushWorkId ?? l.turnId, byCarl: l.byCarl, interaction: this.interaction(l.convId) } : null;
        return this.scoped(async () => {
          // A deferred worker retains what Carl asked, but "here" follows the
          // latest delivered human interaction in its owning conversation.
          // It cannot borrow a later request's explicit destination permission.
          const interaction = capturedScope?.interaction ? { request: capturedScope.interaction.request, device: this.interaction(this.byThread.get(threadId) ?? "").device } : undefined;
          const r: any = await this.onToolCall({ threadId, tool: name, arguments: args, signal, notifyScope, interaction });
          return toolAnswer(r);
        });
      },
      userInput: (threadId, question, options) => this.scoped(() => this.waitForAnswer(threadId, question, options)),
      continuationWait: (threadId, event) => this.scoped(async () => {
        const convId = this.byThread.get(threadId);
        if (!convId || this.live.get(convId)?.threadId !== threadId) return false;
        if (event.kind === "job") return readJobs(this.d.jobEnv).some(j => j.id === event.id && j.conv === convId && j.state === "running");
        if (event.kind === "wake") return readWakes(this.d.vault).some(w => w.id === event.id && w.conv === convId);
        return !!this.d.backend.liveChildren(threadId).find(w => w.id === event.id);
      }),
      you: (q) => this.scoped(async () => this.you(q)),
      // A worker's write: the screens showing that file refresh at once (liveEdits), as for the agent's own writes.
      childWrote: (_parent, input) => {
        const p = writtenPath(this.d.vault, input);
        if (p) this.d.onFilesWritten?.([p]);
      },
      sideTool: (convId, name, args, signal) =>
        this.scoped(async () => {
          const r: any = await this.onToolCall({ side: { convId }, tool: name, arguments: args, signal });
          return toolAnswer(r);
        }),
    });
    // The runtime comes up once its handlers are wired — the router used to do
    // this for whichever engine it led, and with pi gone there is no one else to.
    b.start?.();
    // Main and every project's thread exist from the start (src/threads.ts): every surface opens one.
    void this.scoped(() => this.ensureThreads()).catch((e) => this.log(`threads: ${(e as Error).message}`));
    this.timers.push(setInterval(() => this.scoped(() => void this.tickWakes()), 2_000));
    this.timers.push(setInterval(() => this.scoped(() => void this.tickJobs()), 15_000));
    // A project's folder that came back without the engine (moved back by hand): its thread back on every list.
    this.timers.push(setInterval(() => void this.scoped(() => this.ensureThreads()).catch(() => {}), 15_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** External clients have explicit vault/device/conversation context, never
   * whichever chat happens to be foreground. No external caller borrows a
   * running pi turn: questions, proof gates and workers require their owner. */
  async mcpBinding(context: { conversation: string | null; device: "laptop" | "phone" | "board" }) {
    return this.scoped(async () => {
      if (context.conversation && !(await readConv(this.d.vault, context.conversation))) return null;
      const builtin = agentToolSpecs().map((t) => t.name === "RecordUI" ? { ...t, description: `${t.description} External clients: browser-only http(s) pages; run steps and local-file navigation are refused. Omit out: a fresh vault visuals directory is allocated.` } : t);
      // Carl's vault tools (.vault-chat/tools) are not offered here: each runs his own code in the
      // command sandbox with every command key (vaultTools.ts), the shell authority this endpoint
      // withholds. For the same reason an external write never lands in that folder.
      const fs = await this.d.backend.filesystem(this.d.vault, PI_BUILTIN_TOOLS.filter((n) => n !== "bash"), { fileWrite: async () => true }, this.d.vault);
      const specs = [...builtin, ...fs.specs] as ToolSpec[];
      const listed = new Set(specs.map((t) => t.name));
      const toolsDir = resolve(this.d.vault, ".vault-chat", "tools");
      return {
        specs,
        resources: [{ uri: "vault-chat://context/you", name: "Authorized device and file context", mimeType: "text/plain" }],
        readResource: async (uri: string) => {
          if (uri !== "vault-chat://context/you") throw new Error("Resource unavailable in this scope");
          return `Bound device: ${context.device}; conversation: ${context.conversation ?? "none"}.\n${(await this.scoped(() => this.you({ convId: context.conversation, since: null }))).text}`;
        },
        call: async (name: string, args: Record<string, unknown>, contextOfCall: { signal: AbortSignal }) => this.scoped(async () => {
          if (!listed.has(name)) return { ok: false, text: `${name} is not available to external MCP clients.` };
          if ((name === "write" || name === "edit") && typeof args.path === "string") {
            const target = resolve(this.d.vault, args.path);
            const rel = relative(toolsDir, target);
            if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { ok: false, text: "External MCP clients cannot write vault tools (.vault-chat/tools)." };
          }
          if (PI_BUILTIN_TOOLS.includes(name)) return fs.call(name, args, { ...contextOfCall, requestId: "external" });
          if (TURN_ONLY_TOOLS.has(name) || name === "Compact") return { ok: false, text: `${name} needs an owning vault-chat turn; an external MCP client cannot borrow a chat's live turn.` };
          if (name === "RecordUI") return externalRecordUI(this.d.shell?.(), this.d.vault, args,
            (path, write) => this.d.backend.externalPath(this.d.vault, path, write), { signal: contextOfCall.signal });
          if (name === "PdfRead" || name === "PdfPages") {
            const why = await this.d.backend.externalPath(this.d.vault, args.path);
            if (why) return { ok: false, text: why };
          }
          const a = { ...args };
          if (name === "Show" && (!a.where || a.where === "here")) a.where = context.device;
          const toBoard = name === "BoardSend" || (name === "Show" && /^(board|ipad)$/i.test(String(a.where)));
          if (toBoard && context.device !== "board" && a.asked !== true) return { ok: false, text: "Board sending requires an explicit request (asked: true) from this external client, not ambient screen presence." };
          if (toBoard && context.device === "board") a.asked = true; // explicit bound board, not global presence
          return toolAnswer(await this.onToolCall({ side: { convId: context.conversation }, tool: name, arguments: a, signal: contextOfCall.signal, interaction: { device: context.device, request: "" } }));
        }),
      };
    });
  }

  /** Main, and one thread per project (made once; never a write when they exist). */
  async ensureThreads(): Promise<void> {
    const root = conversationRoot(this.d.vault);
    if (this.d.vault === root) await ensureMain(root);
    // Legacy engines may recover their original work, but must never manufacture
    // another Main or a copy of each globally registered project's thread.
    for (const p of listProjects()) {
      const owner = ownerVault(projectThreadId(p.slug), root) ?? root;
      if (owner === this.d.vault) await ensureProjectThread(owner, p.slug, p.name, { onRevived: (id) => this.revived(id) });
    }
  }

  /** The conversation a message without one goes to (Main), or the one named: a project's thread or a
   *  separate chat is made the first time its id is used. Null: an id that can't be a conversation. */
  private async target(convId: string | null | undefined, project: string | undefined, init: Partial<EngineConv>, first: string): Promise<EngineConv | null> {
    if (!convId && project) {
      // "New chat in project" from an older client: the project's one thread.
      const { ensureProject } = await import("../context");
      const { project: info } = ensureProject(project);
      return ensureProjectThread(this.d.vault, info.slug, info.name);
    }
    if (!convId || convId === MAIN_ID) return ensureMain(this.d.vault);
    // A stale pre-cutover link must not create/resume an alternate old Main.
    if (globalCutover(this.d.vault)?.retiredMainIds?.includes(convId)) return null;
    const revived = { onRevived: (id: string) => this.revived(id) };
    const have = await readConv(this.d.vault, convId);
    const slug = projectOfThread(convId);
    // A deleted project's thread (a surface still on it): Main — unless the project was made again.
    if ((have as { deleted?: boolean } | null)?.deleted && slug) {
      const p = readProject(slug);
      return p ? ensureProjectThread(this.d.vault, slug, p.name, revived) : ensureMain(this.d.vault);
    }
    if (have) return have;
    if (slug) {
      const p = readProject(slug);
      return p ? ensureProjectThread(this.d.vault, slug, p.name, revived) : null;
    }
    // A client's optimistic new chat (Carl asked for a separate one): the id it chose becomes the conversation's.
    if (/^[A-Za-z0-9_-]{6,80}$/.test(convId) && !logOf(this.d.vault).has(convId)) return createConv(this.d.vault, { ...init, kind: "separate" } as Partial<EngineConv>, first, convId);
    return null;
  }

  /** A new sign-in from the app (server/main.ts setKeys). */
  tokenChanged(): void {
    this.d.backend.tokenChanged?.();
  }

  /** One tiny real call: does this box's sign-in work? */
  async checkToken(): Promise<{ ok: boolean | null; error: string | null }> {
    return (await this.d.backend.checkToken?.()) ?? { ok: null, error: null };
  }

  health(): Record<string, unknown> {
    const own = this.d.backend.health();
    // The engine is readable under its own name (`engine.claude`), which is what
    // every client asks for — "is Claude Code signed in" among them
    // (src/engineHealth.ts). There was a router once, which published an
    // `engines` record of everything it ran; a backend that still answers with
    // one is passed through for a client built against that shape.
    const engines = (own as { engines?: Record<string, unknown> }).engines;
    const byName = engines ? Object.fromEntries(Object.entries(engines).filter(([k]) => k !== "default")) : {};
    return {
      ...byName,
      [this.d.backend.name]: own,
      ...(engines && typeof engines === "object" ? { engines } : {}),
      backend: this.d.backend.name,
      liveTurns: [...this.live.values()].map((l) => ({ convId: l.convId, kind: l.kind, waitingUser: !!l.ask, sinceMs: Date.now() - l.startedAt })),
      wakes: readWakes(this.d.vault).length,
      log: { latest: logOf(this.d.vault).latest(), epoch: logOf(this.d.vault).epoch },
    };
  }

  /** Background workers of this vault's engine that a restart would kill (health's busy.workers). */
  workers(): number {
    return this.d.backend.liveWorkers?.() ?? 0;
  }

  isRunning(convId: string): boolean {
    const l = this.live.get(convId);
    return !!l && !l.ask;
  }

  private async onUp(): Promise<void> {
    if (this.firstUp) {
      this.firstUp = false;
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
      this.reapLostWorkers();
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
  async intent(b: Record<string, any>, viewerRoot = this.d.vault): Promise<Record<string, unknown>> {
    switch (b?.type) {
      case "send":
        return (await this.message({ ...b, clientMsgId: b.clientId }, viewerRoot)) ?? { error: "legacy conversation" };
      case "steer":
        return (await this.message({ ...b, clientMsgId: b.clientId, mode: "steer" }, viewerRoot)) ?? { error: "legacy conversation" };
      case "queue":
        return (await this.message({ ...b, clientMsgId: b.clientId, queue: true }, viewerRoot)) ?? { error: "legacy conversation" };
      case "unqueue":
        return (await this.message({ convId: b.convId, unqueue: String(b.id ?? "") })) ?? { error: "legacy conversation" };
      case "now":
        return this.sendNow(String(b.convId ?? ""), String(b.id ?? ""));
      case "stop":
        return (await this.kill({ convId: b.convId })) ?? { error: "legacy conversation" };
      case "answer":
        return (await this.answerRoute({ convId: b.convId, text: b.text, defer: b.defer, clientMsgId: b.clientId })) ?? { error: "legacy conversation" };
      case "lines": {
        // Lines a client brings into a chat as they are (a Ctrl+K exchange, a note opened for
        // discussion): written as its items, under the client's ids; no turn runs. No conversation: Main.
        const lines: any[] = Array.isArray(b.lines) ? b.lines.slice(0, 40) : [];
        if (!lines.length) return { error: "no lines" };
        const first = String(lines.find((l) => l?.role === "user" && !l.hidden)?.text ?? "Chat");
        const into = await this.target(String(b.convId ?? "") || null, undefined, { source: "manual" }, first);
        if (!into) return { error: "bad conversation id" };
        const id = into.id;
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
      case "compact": {
        // Answered at once: the summary takes minutes (a client's request would time out waiting for it).
        // The thread says the rest: "Summarizing the earlier conversation…", then the divider or why not.
        const id = String(b.convId ?? "") || MAIN_ID;
        if (!this.picture(id)) return { ok: false, error: `conversation ${id} not found` };
        if (!(await readConv(this.d.vault, id))?.threadId) return { ok: true, convId: id, compacted: false, note: "nothing to compact yet" };
        void this.compact(id, typeof b.focus === "string" ? b.focus : undefined).then((r) => {
          if (r && r.ok === false) this.log(`compact on ${id}: ${String(r.error)}`);
        });
        return { ok: true, convId: id, started: true };
      }
      case "deleteProject":
        return this.deleteProject(String(b.slug ?? ""), { folder: b.folder === true });
      case "restoreProject":
        return this.restoreProject(String(b.slug ?? b.entry ?? ""));
      case "renameProject": {
        const slug = String(b.slug ?? "");
        const pid = projectThreadId(slug);
        if (this.live.has(pid)) return { ok: false, error: "its thread is working: rename it when the turn is done" };
        // Its pi works in the folder (Windows will not rename a process's working folder): closed first; the next
        // turn resumes it in the renamed folder.
        const tid = this.picture(pid)?.meta.threadId;
        if (typeof tid === "string" && this.d.backend.holds(tid)) {
          this.d.backend.forget(tid);
          for (let i = 0; i < 30 && this.d.backend.holds(tid); i++) await new Promise((r) => setTimeout(r, 100));
        }
        try {
          const p = renameProject(slug, String(b.name ?? ""));
          if (this.picture(projectThreadId(slug))) this.emit(projectThreadId(slug), { type: "meta", patch: { title: p.name } });
          this.d.broadcast?.({ type: "project", slug, renamed: p.name });
          return { ok: true, slug, name: p.name };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      case "delete": {
        // One chat (convId) or many (convIds: the app's multi-select).
        const ids = Array.isArray(b.convIds) ? b.convIds.map(String) : [String(b.convId ?? "")];
        const r = await this.deleteConversations(ids, String(b.client ?? "app"));
        if (!Array.isArray(b.convIds)) return r.deleted.length ? { ok: true, convId: r.deleted[0] } : { ok: false, error: r.refused[0]?.why ?? "not deleted" };
        return { ok: r.deleted.length > 0 || !ids.length, deleted: r.deleted, refused: r.refused };
      }
      case "renameConversation": {
        const r = this.renameConversation(String(b.convId ?? ""), String(b.title ?? ""));
        return r.ok ? { ok: true, convId: b.convId } : { ok: false, error: r.error };
      }
      case "restoreConversation": {
        const r = this.restoreConversation(String(b.convId ?? ""));
        return r.ok ? { ok: true, convId: r.id } : { ok: false, error: r.error };
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
   * While a turn runs ordinary messages wait in pi's native follow-up queue.
   * Only a split voice continuation refines the current turn; Send now interrupts
   * intentionally. `unqueue: <id>` takes a pending one back.
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
    /** Files Carl attached from outside the vault, by the path the upload gave them (server/attachments.ts). */
    files?: string[];
    /** Who started it: "voice" (the voice's Ask); a phone chat otherwise. */
    source?: string;
    /** Hold it until the running turn ends (a follow-up), instead of steering. */
    queue?: boolean;
    /** Take back a queued (or steering) message not delivered yet (its id). */
    unqueue?: string;
    mode?: "steer";
    /** Which client sent it (laptop, phone, board): the turn log's `via`. */
    client?: string;
    /** How the message shows (its item's `via`): "voice-ask" for a request voice handed over (server/voice.ts Ask). */
    via?: string;
    /** The rest of his previous line (a pause on a call cut it in two): it steers the running turn. */
    continues?: boolean;
  }, viewerRoot = this.d.vault): Promise<Record<string, unknown> | null> {
    const clientId = typeof body.clientMsgId === "string" && body.clientMsgId.trim() ? body.clientMsgId.trim().slice(0, 80) : newMessageId();
    if (typeof body?.unqueue === "string" && body.convId) return this.takeBack(body.convId, body.unqueue);
    const textIn = String(body?.text ?? "").trim();
    const hasImages = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0) > 0;
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 10).map((p) => attachmentAt(this.d.vault, p));
    if (files.some((f) => !f)) return { error: "an attached file is not on the box (upload it first: POST /api/v2/attachment)" };
    if (!textIn && !hasImages && !files.length) return { error: "empty message" };
    // No conversation named: Main (every surface's default). A project's thread or a separate chat is made on first use.
    const projectAsked = !body.convId && typeof body.project === "string" && body.project.trim() ? body.project.trim() : undefined;
    let conv: EngineConv | null;
    try {
      conv = await this.target(body.convId, projectAsked, body.source === "voice" ? { source: "voice" } : {}, textIn || "Image");
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (!conv) return { error: `conversation ${body.convId} not found` };
    if (LEGACY_SOURCES.has(conv.source)) return { error: ARCHIVED };
    const id = conv.id;
    // The same message again (a retry, a service worker's replay): already here.
    const pic0 = this.picture(id);
    if (pic0 && (pic0.items.some((x) => x.id === clientId) || pendingOf(pic0).some((x) => x.id === clientId))) return { ok: true, convId: id, duplicate: true };
    if (!projectAsked && body.convId && typeof body.project === "string" && body.project.trim() && threadKindOf(conv) === "separate") {
      try {
        const { ensureProject } = await import("../context");
        const { project } = ensureProject(body.project.trim());
        await patchMeta(this.d.vault, id, { project: project.slug });
      } catch (e) {
        this.log(`project ${body.project}: ${(e as Error).message}`);
      }
    }
    const { paths, itemImages, empty } = this.saveImages(id, body);
    let context = typeof body.context === "string" && body.context.trim() ? body.context.trim() : undefined;
    // An attachment that arrived empty is said, never guessed at (P17: the agent described an image it never got).
    if (empty) context = [context, `[Carl attached ${empty === 1 ? "an image" : `${empty} images`}, but ${empty === 1 ? "it" : "they"} arrived empty (no data): you have NOT seen ${empty === 1 ? "it" : "them"}. Say so plainly; don't guess what ${empty === 1 ? "it shows" : "they show"}.]`].filter(Boolean).join("\n\n");
    // Attached files: the agent gets each one's path on the box (never a path on Carl's laptop).
    const filesNote = attachmentsNote(files as NonNullable<(typeof files)[number]>[]);
    if (filesNote) context = [context, filesNote].filter(Boolean).join("\n\n");
    const shown = textIn || (files.length ? files.map((f) => f!.name).join(", ") : "(image)");
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
    const device = body.client ?? null;
    appendActivity(this.d.vault, chatPointerEntry({ convId: id, title, user: shown, project: typeof proj === "string" ? proj : null, device }));
    for (const im of itemImages.filter((x) => x.path.startsWith(".vault-chat/captures/")))
      appendActivity(this.d.vault, { kind: "capture", modality: "chat", text: `pasted into "${title}"`, path: im.path, convId: id, ...(device ? { device } : {}) });
    // An open question: this message is the answer.
    if (this.live.get(id)?.ask || conv.pendingAsk) {
      await this.answer(id, shown, clientId);
      return { ok: true, convId: id, answered: true };
    }
    // A loaded thread can accept native steer/follow_up even while prompt
    // preflight compacts. Do not poll a second "started" state for 60 seconds:
    // pi owns the queue and delivers input when its native run is ready.
    const l = this.live.get(id);
    const origin = body.source === "voice" ? "voice" : typeof body.client === "string" && body.client ? body.client.slice(0, 20) : body.source ? String(body.source).slice(0, 20) : undefined;
    // Which surface he is on (one conversation, several surfaces at once): the agent answers and shows things there.
    const surface = body.source === "voice" ? `a voice call${body.client ? ` (${String(body.client).slice(0, 20)})` : ""}` : typeof body.client === "string" && body.client ? `his ${body.client.slice(0, 20)}` : null;
    if (surface) context = [`[Carl, on ${surface}]`, context].filter(Boolean).join("\n");
    if (body.source === "voice" && !body.continues && l?.started && !l.finished) {
      context = [context, "[This spoken turn interrupts the previous foreground step via Send now. It may have partially run; do not claim it finished. Background workers continue and report normally. Check unfinished work before resuming it.]"].filter(Boolean).join("\n");
    }
    const sent = shown;
    // Capture the trusted HTTP viewer scope at receipt, not when a queued ask
    // eventually runs. This is historical request metadata, never a mutable
    // "current viewer" and never another copy of the prompt. Pi stores it in
    // its existing typed host context, never Carl's user-role text.
    const fileContext = viewerRoot !== this.d.vault
      ? `<file-context request=${JSON.stringify(clientId)} device=${JSON.stringify(origin ?? "unknown")} conversation=${JSON.stringify(id)}>Viewer/file-context vault root: ${viewerRoot}/. Conversation owner: ${this.d.vault}/. Resolve viewer-relative file references to absolute paths under that viewer root. Read and Bash relative paths still use the thread/project cwd; this binding does not change tool path resolution. This records the incoming request, not later viewer state.</file-context>`
      : undefined;
    const hostContext = [context, fileContext].filter(Boolean).join("\n\n") || undefined;
    const request: UserRequest = { v: 1, clientId, via: body.via ?? "chat", ...(validDevice(device) ? { device: validDevice(device)! } : {}), ...(itemImages.length ? { images: itemImages.map(({ path }) => ({ path })) } : {}) };
    if (l && !l.finished) {
      // Ordinary input on EVERY surface waits for its own native follow-up
      // boundary, even when that surface also started the active turn. The old
      // client "steer" intent is ordinary Send, not consent to interrupt. Only
      // a split spoken continuation refines the active thought; Send now below
      // remains the explicit interrupt path. Pi owns delivery and ordering.
      const elsewhere = !!origin && !!l.turnOpts.origin && origin !== l.turnOpts.origin;
      const kind = body.source === "voice" && body.continues && !body.queue && !elsewhere ? "steer" : "queue";
      this.setPending(id, { id: clientId, kind, text: shown, at: Date.now() });
      l.feed.expect({ kind, text: sent, clientId, shown, hostContext, via: body.via ?? kind, images: itemImages, ...(device ? { device } : {}) });
      l.rec.q(kind, clientId);
      // A turn waiting on a `subagent` call would take him up only when its children end (minutes): they move to
      // the background, the call answers at once, and his message is taken up now; each report comes as its own turn.
      this.detachWaiting(id, l.threadId);
      // A new spoken turn is Send now, not a cross-surface follow-up or a
      // steer stuck behind a foreground tool. Reuse that native interrupt path:
      // the SAME pi session keeps its history and pending inputs; detached and
      // Background workers keep running and report through their existing path.
      // A continuation of a split utterance still refines the current turn.
      if (body.source === "voice" && !body.continues && l.started) {
        return this.sendNow(id, clientId);
      }
      try {
        if (kind === "queue") await this.d.backend.followUp(l.threadId, { texts: [sent], context: hostContext, request: { ...request, via: body.via ?? kind }, images: paths });
        else await this.d.backend.steer(l.threadId, l.turnId, { texts: [sent], context: hostContext, request: { ...request, via: body.via ?? kind }, images: paths });
        return { ok: true, convId: id, ...(kind === "queue" ? { queued: true, qid: clientId } : { steered: true }) };
      } catch (e) {
        l.feed.forget(clientId);
        this.setPending(id, undefined, clientId);
        l.rec.q("refused", clientId);
        this.log(`${kind} failed (${(e as Error).message})`);
        return { ok: false, convId: id, error: `the running turn did not take it: ${(e as Error).message}` };
      }
    }
    // The conversation is being summarized (/compact, minutes): his message waits for it, shown waiting on
    // every surface (Cancel takes it back), and runs the moment the summary lands.
    const held = this.compacting.has(id);
    if (held) this.setPending(id, { id: clientId, kind: "queue", text: shown, at: Date.now() });
    void this.run(id, shown, "user", { images: paths, hostContext, itemImages, clientId, origin, device: validDevice(device), ...(body.via ? { via: body.via } : {}), ...(held ? { held: true } : {}) }).catch((e) => this.log(`turn failed: ${e}`));
    return { ok: true, convId: id, ...(held ? { queued: true, qid: clientId } : {}) };
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
          if (e.kind === "queue") await this.d.backend.followUp(l.threadId, { texts: [e.text], context: e.hostContext, request: e.clientId ? { v: 1, clientId: e.clientId, via: e.via, ...(e.device ? { device: e.device } : {}), ...(e.images?.length ? { images: e.images.map(({ path }) => ({ path })) } : {}) } : undefined, images: [] });
          else await this.d.backend.steer(l.threadId, l.turnId, { texts: [e.text], context: e.hostContext, request: e.clientId ? { v: 1, clientId: e.clientId, via: e.via, ...(e.device ? { device: e.device } : {}), ...(e.images?.length ? { images: e.images.map(({ path }) => ({ path })) } : {}) } : undefined, images: [] });
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

  /**
   * "Send now" on a message still waiting for the agent's next step (Claude Code's interrupt-and-send):
   * the current step is cut (pi's abort), and the message starts the next turn at once, so the agent
   * answers it next and goes on from there. The other waiting messages follow it, in order.
   */
  private async sendNow(convId: string, id: string): Promise<Record<string, unknown>> {
    const p = this.picture(convId);
    if (!p || !pendingOf(p).some((x) => x.id === id)) return { ok: false, error: "already delivered" };
    const l = this.live.get(convId);
    if (!l || l.finished || !l.started) return { ok: false, error: "nothing is running" };
    const waiting = l.feed.undelivered();
    const first = waiting.find((e) => e.clientId === id);
    if (!first) return { ok: false, error: "already delivered" };
    l.sendNow = true;
    const ended = this.turnEnd(convId);
    try {
      // pi's own stop: its queue is cleared (these messages go again below), then the step is aborted.
      await this.d.backend.interrupt(l.threadId, l.turnId);
    } catch (e) {
      this.log(`send now on ${convId}: ${(e as Error).message}`);
    }
    await Promise.race([ended, new Promise((r) => setTimeout(r, 60_000))]);
    // Input can land while clear_queue/abort is in flight. The FINAL original
    // feed, not the pre-interrupt snapshot, decides what Pi has not delivered.
    const undelivered = l.feed.undelivered();
    const rest = undelivered.filter(e => e !== first && e.clientId);
    const vault = this.d.vault;
    const again = (e: (typeof waiting)[number]) =>
      this.run(convId, e.text, "user", {
        replay: rest,
        shown: e.shown,
        hostContext: e.hostContext,
        clientId: e.clientId,
        itemImages: e.images,
        images: (e.images ?? []).map((im) => join(vault, im.path)),
        ...(e.device ? { origin: e.via === "voice" ? "voice" : e.device, device: validDevice(e.device) } : {}),
        ...(e.via && e.via !== "steer" && e.via !== "queue" ? { via: e.via } : {}),
      }).catch((err) => this.log(`send now on ${convId}: ${err}`));
    if (undelivered.includes(first)) void again(first);
    else void this.run(convId, "Continue from Carl's latest delivered message after Send now interrupted the foreground step. Check unfinished work; do not repeat already delivered inputs.", "resume", { byCarl: l.byCarl, replay: rest }).catch(err => this.log(`send now continuation on ${convId}: ${err}`));
    return { ok: true, convId, now: id };
  }

  private saveImages(convId: string, body: { images?: { name?: string; mime?: string; dataBase64?: string }[]; imagePaths?: string[] }): { paths: string[]; itemImages: ItemImage[]; empty: number } {
    const paths: string[] = [];
    const itemImages: ItemImage[] = [];
    let empty = 0;
    const dir = join(this.d.vault, ".vault-chat", "captures");
    (body.images ?? []).slice(0, 8).forEach((img, i) => {
      const b64 = String(img?.dataBase64 ?? "").replace(/^data:[^,]*,/, "");
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) {
        empty++;
        return;
      }
      if (buf.length > 15 * 1024 * 1024) return;
      const mime = String(img?.mime ?? "image/png");
      const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".png";
      const rel = `.vault-chat/captures/${new Date().toISOString().replace(/[:.]/g, "-")}-${convId.slice(0, 8)}-${i}${ext}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(this.d.vault, rel), buf);
      paths.push(join(this.d.vault, rel));
      itemImages.push({ path: rel, ...(buf.length < 400_000 ? { dataUrl: `data:${mime};base64,${b64}` } : {}) });
    });
    for (const p of (body.imagePaths ?? []).slice(0, 8)) {
      // imagePaths are owner-vault relative, not arbitrary host/client paths.
      const rel = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
      if (!rel || /^(?:[a-zA-Z]:|\/)/.test(rel) || rel.split("/").includes("..") ||
          (rel.split("/").includes(".vault-chat") && !/^\.vault-chat\/(captures|attachments)\//.test(rel))) { empty++; continue; }
      try {
        const { abs } = vaultPath(this.d.vault, rel, "read");
        const st = statSync(abs);
        if (!st.isFile() || !st.size || st.size > 15 * 1024 * 1024 || !/\.(png|jpe?g|gif|webp)$/i.test(rel)) { empty++; continue; }
        paths.push(abs);
        itemImages.push({ path: rel });
      } catch { empty++; }

    }
    return { paths, itemImages, empty };
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

  /** GET /api/v1/models: what a chat can run on, by name (the runtime's list). */
  models(): ModelChoice[] {
    return this.d.backend.models?.() ?? [];
  }

  /**
   * POST /api/v1/model (and the older /conversations/:id/model) — the composer's picker.
   *
   * Model and effort are ONE setting for the whole box, the same in every chat and
   * on every device (Carl, 2026-11-10): it is stored once (rememberModel/Effort)
   * and every chat, new or old, runs on it. A conversation's own model/effort
   * fields are no longer read.
   *
   * A model change reaches a running session live (setModel); effort is a start
   * option the runtime has no control request for, so the session ends and the
   * next turn resumes it — see ClaudeCodeBackend.resumeThread. `convId` (optional)
   * is the chat the picker was open in: its running session takes the change now.
   */
  async setChatModel(convId: string | null, body: { model?: unknown; effort?: unknown }): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    if (body.model !== undefined) {
      const m = String(body.model ?? "").trim();
      if (!isClaudeModel(m)) return { ok: false, error: `"${m.slice(0, 80)}" is not a model this engine runs` };
      patch.model = m;
    }
    if (body.effort !== undefined) {
      // null clears it: the model's own default.
      if (body.effort === null || body.effort === "") patch.effort = null;
      else if (!isEffort(body.effort)) return { ok: false, error: `"${String(body.effort).slice(0, 40)}" is not an effort level` };
      else patch.effort = body.effort;
    }
    if (!Object.keys(patch).length) return { ok: false, error: "nothing to set" };
    if (patch.model) this.d.rememberModel?.(String(patch.model));
    if (patch.effort !== undefined) this.d.rememberEffort?.(patch.effort === null ? null : String(patch.effort));
    const conv = convId ? await readConv(this.d.vault, convId) : null;
    if (conv?.threadId) {
      const { model, effort } = this.chatModel(conv);
      await this.d.backend
        .resumeThread(conv.threadId, { model, effort, subagents: capabilitiesOf(model).subagents, cwd: this.cwdOf(conv) })
        .catch((e) => this.log(`model change on ${convId}: ${(e as Error).message}`));
    }
    return { ok: true, ...(convId ? { convId } : {}), ...(patch.model ? { model: patch.model } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) };
  }

  /** POST /api/v1/conversations/:id/subagents/:sid/{steer,stop}. */
  async subagent(convId: string, sid: string, op: "steer" | "stop", body: { text?: string }): Promise<Record<string, unknown>> {
    const conv = await readConv(this.d.vault, convId);
    if (!conv) return { ok: false, error: `conversation ${convId} not found` };
    const rec = (conv.subagents ?? []).find((s: any) => s.threadId === sid) as Record<string, unknown> | undefined;
    if (!rec) return { ok: false, error: `no subagent ${sid} on this conversation` };
    if (rec.kind === "job") {
      // A StartJob job (a dev server, a build): Stop stops its unit; there is no one to steer.
      if (op === "steer") return { ok: false, error: "a shell job can't be steered: stop it, or tell the agent" };
      const out = jobStop(this.d.jobEnv, sid);
      if (!/^Stopped job /.test(out)) return { ok: false, error: out };
      this.jobRowEnded(convId, sid, "stopped");
      this.devSweep();
      return { ok: true };
    }
    return this.d.backend.subagentControl(sid, op, body?.text);
  }

  // ---------------------------------------------------------------- side threads (pi/side.ts)

  /**
   * POST /api/v1/side. Ctrl+K / Ctrl+L ({kind: "edit" | "ask", convId?, side?, text, images?}): pi forks the
   * conversation's session (its history and instructions; a fresh session with the agent's instructions when it
   * has none) with the agent's read-only tools (pi's read/grep/find/ls and every vault-chat tool marked readOnly:
   * PdfRead, WebSearch, …); pi's extension adds what Carl did elsewhere since that conversation
   * last saw it (the "you" layer, the same hook a turn of the agent runs). `side`: the popover's next request, in
   * the same side thread. One-shots ({kind: "once", system, text, images?, fast?}): no session, no tools.
   */
  async sideStart(b: Record<string, any>, viewerRoot = this.d.vault, onceModel?: string): Promise<Record<string, unknown>> {
    // A live page's vc.ask (src/liveBridge.ts): always a fresh read-only ask, tagged with the page; nothing else of the
    // request is used (no conversation to fork or write to, no images, no tools, no continued thread), and rate-limited here too.
    const page = typeof b?.page === "string" && b.page.trim() ? b.page.trim().slice(0, 200) : null;
    let pagePrompt = "";
    if (page) {
      const times = this.pageAsks.get(page) ?? [];
      this.pageAsks.set(page, times);
      if (!allowRate(times, LIVE_LIMITS.asksPerMinute)) return { error: `a page may ask at most ${LIVE_LIMITS.asksPerMinute} times a minute` };
      const prompt = typeof b.text === "string" ? b.text : "";
      const system = typeof b.system === "string" ? b.system : "";
      if (prompt.length > LIVE_LIMITS.promptChars || system.length > LIVE_LIMITS.systemChars) return { error: "ask too large" };
      pagePrompt = prompt;
      b = { kind: "ask", text: liveAskText(page, system, prompt) };
    }
    const text = typeof b?.text === "string" ? b.text : "";
    if (!text.trim()) return { error: "missing text" };
    const kind = b.kind === "once" ? "once" : b.kind === "edit" ? "edit" : "ask";
    const images: string[] = (Array.isArray(b.images) ? b.images : []).filter((u: unknown) => typeof u === "string" && u.startsWith("data:image/"));
    let model = kind === "once" && onceModel ? onceModel : kind === "once" && b.fast ? ctxConfig().recapModel : this.d.model();
    if (images.length && !capabilitiesOf(model).images) model = this.d.visionModel ?? model;
    const dir = (parent: string) => join(this.d.backend.paths.sessionsDir, "side", parent);
    const side = this.d.backend.side;
    try {
      let s: SideState;
      let conv: EngineConv | null = null;
      if (kind === "once") {
        s = await side.start({ kind, system: String(b.system ?? ""), cwd: this.d.vault, model, tools: [], ephemeral: true, thinking: "off", sessionDir: dir("once"), text, images, log: this.sideLog(null, "once", []) });
      } else if (typeof b.side === "string" && b.side) {
        s = await side.start({ kind, side: b.side, cwd: this.d.vault, model, tools: READ_ONLY_TOOLS, hostLoadout: "readOnly", hostTools: sideToolSpecs(), sessionDir: "", text, images });
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
        // Voice's Ask (server/voice.ts): Show too; an action also pi's own file tools and BoardSend.
        const voice = typeof b.kind === "string" && b.kind.startsWith("voice");
        const act = voice && b.tools === "act";
        const tools = act ? [...READ_ONLY_TOOLS, "bash", "edit", "write"] : READ_ONLY_TOOLS;
        // Voice's Asks also have Carl's own vault tools (his calendar …): voice reached them through the agent before.
        const hostLoadout: HostLoadout = voice ? (act ? "voiceAct" : "voiceRead") : "readOnly";
        const hostTools = await this.hostToolCatalog(hostLoadout);
        const context = viewerRoot !== this.d.vault
          ? `<file-context conversation=${JSON.stringify(conv?.id ?? null)}>Viewer/file-context vault root: ${viewerRoot}/. Conversation owner: ${this.d.vault}/. Resolve viewer-relative file references under that viewer root; relative tools still use the thread/project cwd. This is the captured side-request file context, not later viewer state.</file-context>`
          : undefined;
        s = await side.start({ kind, context, fork: src?.file ?? null, instr, cwd: src?.cwd || this.d.vault, model, tools, hostTools, hostLoadout, sessionDir: dir(conv?.id ?? "none"), text, images, you: { convId: conv?.id ?? null }, log: this.sideLog(conv?.id ?? null, page ? `page:${page}` : String(b.kind ?? kind).slice(0, 40), tools) });
      }
      this.log(`side ${kind} ${s.id}${conv ? ` (forked from ${conv.id})` : ""} on ${model}${s.file ? `: ${s.file}` : ""}`);
      if (page) this.recordPageAsk(side, s.id, page, pagePrompt);
      return { ok: true, id: s.id, v: s.v };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }

  /**
   * A live page's ask goes into the shared activity stream (what RecentActivity reads) once it ends: one entry with
   * the page, Carl's prompt and the reply (each clipped in sanitizeEntry). It makes no chat or conversation.
   */
  private recordPageAsk(side: { wait(id: string): Promise<SideState> }, id: string, page: string, prompt: string): void {
    const write = (reply: string) =>
      appendActivity(this.d.vault, { kind: "ask", modality: "page", text: `live page asked: ${prompt.replace(/\s+/g, " ").trim().slice(0, 100)}`, path: page, prompt, reply });
    side.wait(id).then(
      (st) => void write(st.text ?? ""),
      () => void write(""),
    );
  }

  /** GET /api/v1/side/:id?after=v: the answer so far, once it changed (long poll). */
  sidePoll(id: string, after: number, waitMs: number): Promise<SideState | null> {
    return this.d.backend.side.poll(id, after, Math.max(0, Math.min(waitMs, 25_000)));
  }

  /** POST /api/v1/side/:id/stop. */
  sideStop(id: string): Promise<boolean> {
    return this.d.backend.side.stop(id);
  }

  /**
   * Carl's Delete on chats (a row's Delete, his multi-select, or the agent's DeleteConversation): each is
   * tombstoned in its log (meta.deleted), so it leaves every list on every surface while its records and its
   * transcript stay on disk; restoreConversation clears the mark and it is back as it was. Nothing is ever
   * removed from .vault-chat. Main and a project's thread are refused (Clear gives a fresh view); `except`
   * is a chat that must not delete itself (the agent's own).
   */
  async deleteConversations(ids: string[], by: string, except?: string): Promise<{ deleted: string[]; refused: { id: string; why: string }[] }> {
    const deleted: string[] = [];
    const refused: { id: string; why: string }[] = [];
    for (const id of [...new Set(ids.map((x) => x.trim()).filter(Boolean))]) {
      const p = this.picture(id);
      if (!p || p.meta.deleted) {
        refused.push({ id, why: p ? "already deleted" : "no such chat" });
        continue;
      }
      if (threadKindOf({ id }) === "main" || threadKindOf({ id }) === "project") {
        refused.push({ id, why: "Main and a project's thread can't be deleted; Clear gives a fresh view" });
        continue;
      }
      if (id === except) {
        refused.push({ id, why: "this is the chat you are in" });
        continue;
      }
      if (this.live.has(id)) await this.interrupt(id, true);
      this.emit(id, { type: "meta", patch: { deleted: true, deletedAt: Date.now(), deletedBy: by } });
      deleted.push(id);
    }
    if (deleted.length) this.log(`deleted ${deleted.length} chat(s) by ${by} (recoverable): ${deleted.join(", ")}`);
    return { deleted, refused };
  }

  /** The engine whose log holds chat `id` (this one when it is ours or nobody's). */
  private async ownerOf(id: string): Promise<Engine> {
    const at = ownerVault(id, this.d.vault);
    if (!at || at === this.d.vault || !this.d.engineAt) return this;
    return (await this.d.engineAt(at)) ?? this;
  }

  /** The agent's delete: each id goes to the engine of the vault that holds it. */
  async deleteAcrossVaults(ids: string[], except?: string): Promise<{ deleted: string[]; refused: { id: string; why: string }[] }> {
    const groups = new Map<Engine, string[]>();
    for (const id of new Set(ids.map((x) => x.trim()).filter(Boolean))) {
      const e = await this.ownerOf(id);
      groups.set(e, [...(groups.get(e) ?? []), id]);
    }
    const out = { deleted: [] as string[], refused: [] as { id: string; why: string }[] };
    for (const [e, g] of groups) {
      const r = await e.deleteConversations(g, "agent", except);
      out.deleted.push(...r.deleted);
      out.refused.push(...r.refused);
    }
    return out;
  }

  async restoreAcrossVaults(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    return (await this.ownerOf(id)).restoreConversation(id);
  }

  /** The chats Carl deleted, newest first: what RestoreConversation can bring back. */
  deletedConversations(): { id: string; title: string; at: number }[] {
    const out: { id: string; title: string; at: number }[] = [];
    for (const id of logOf(this.d.vault).ids()) {
      const p = this.picture(id);
      if (p?.meta.deleted !== true || p.meta.deletedProject) continue;
      out.push({ id, title: String(p.meta.title ?? "").trim() || "(untitled)", at: Number(p.meta.deletedAt) || 0 });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** The inverse of deleteConversations: the mark cleared, the chat back in every list. */
  restoreConversation(id: string): { ok: true; id: string } | { ok: false; error: string } {
    const p = id ? this.picture(id) : null;
    if (!p) return { ok: false, error: `no chat ${id}` };
    if (p.meta.deleted !== true) return { ok: false, error: "it is not deleted" };
    if (p.meta.deletedProject) return { ok: false, error: "it is a deleted project's thread: RestoreProject brings it back" };
    this.emit(id, { type: "meta", patch: { deleted: null, deletedAt: null, deletedBy: null } });
    this.log(`chat ${id} restored`);
    return { ok: true, id };
  }

  /**
   * Carl's Delete on a project: its running turn stops, its own files move to agent-projects/.deleted/ (never
   * the folder it names, nothing else of his), its thread is gone from every list (each surface on it lands
   * on Main: the clients follow the row), and Main's next turn tells the agent once.
   */
  async deleteProject(slug: string, o: { folder?: boolean } = {}): Promise<Record<string, unknown>> {
    const id = projectThreadId(slug);
    if (!slug || projectOfThread(id) !== slug) return { ok: false, error: "not a project" };
    if (this.live.has(id)) {
      await this.interrupt(id, true);
      await this.turnEnd(id);
    }
    let moved: { name: string; movedTo: string; folder: string };
    try {
      // The conversation goes; the registry keeps the choice (a restore brings it back).
      moved = deleteProjectFiles(slug);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    // Carl's second choice: the folder goes too — recoverably (committed, then removed in git; a repo moved aside).
    let folderGone: Record<string, unknown> | null = null;
    if (o.folder) {
      const w = folderOpsWalls();
      const r = w ? await deleteFolder(moved.folder, w) : { error: "folders are not available on this box" };
      if ("error" in r) {
        reviveFolder(this.d.vault, moved.movedTo, slug);
        return { ok: false, error: `the folder could not be deleted (${r.error}); nothing changed` };
      }
      folderGone = r;
    }
    if (this.picture(id)) this.emit(id, { type: "meta", patch: { deleted: true, deletedProject: { name: moved.name, at: Date.now(), movedTo: moved.movedTo, ...(folderGone ? { folder: moved.folder, folderGone } : {}) } } });
    const main = await ensureMain(this.d.vault);
    const tell = [...((this.picture(main.id)?.meta.tellAgent as string[] | undefined) ?? []), `Carl deleted the project "${moved.name}" (its thread is gone from his screens${o.folder ? ", and its folder" : "; its folder stays, a plain folder"}). Don't bring it up or treat it as a project any more unless he does. If he wants it back, RestoreProject brings it back whole; never move its files yourself.`];
    this.emit(main.id, { type: "meta", patch: { tellAgent: tell } });
    this.d.broadcast?.({ type: "project", slug, deleted: true, convId: id, to: MAIN_ID });
    // A call in it goes on in Main (server/voiceBrain.ts).
    void import("../voiceBrain").then((v) => v.followCall(this.d.vault, MAIN_ID, id)).catch(() => {});
    this.log(`project ${slug} deleted (kept as ${moved.movedTo}${folderGone ? `; its folder too: ${String(folderGone.how)} ${String(folderGone.where)}` : "; its folder stays"})`);
    return { ok: true, slug, name: moved.name, movedTo: moved.movedTo, convId: id, to: MAIN_ID, ...(folderGone ? { folderGone } : {}) };
  }

  /**
   * The inverse of deleteProject (Carl's Undo, or the agent's RestoreProject when he asks): the project's
   * folder back from agent-projects/.deleted/, its thread back with its transcript and pi session, every
   * surface's list showing it again (the signal), and Main's agent told unless it never heard of the delete.
   */
  async restoreProject(slugNameOrEntry: string): Promise<Record<string, unknown>> {
    if (!slugNameOrEntry.trim()) return { ok: false, error: "which project? (slug, name or .deleted entry)" };
    let back: { slug: string; name: string; entry: string };
    try {
      back = restoreProjectFiles(slugNameOrEntry);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const id = projectThreadId(back.slug);
    await ensureProjectThread(this.d.vault, back.slug, back.name);
    // Main: a delete notice it has not read yet is simply dropped; otherwise it hears the project is back.
    const main = this.picture(MAIN_ID);
    const pending = (main?.meta.tellAgent as string[] | undefined) ?? [];
    const mine = (t: string) => t.startsWith(`Carl deleted the project "${back.name}"`);
    if (pending.some(mine)) {
      const rest = pending.filter((t) => !mine(t));
      this.emit(MAIN_ID, { type: "meta", patch: { tellAgent: rest.length ? rest : null } });
    } else if (main) {
      this.emit(MAIN_ID, { type: "meta", patch: { tellAgent: [...pending, `The project "${back.name}" is back (restored with its thread and notes); it is one of Carl's projects again.`] } });
    }
    this.d.broadcast?.({ type: "project", slug: back.slug, restored: true, convId: id, name: back.name });
    this.log(`project ${back.slug} restored (from .deleted/${back.entry})`);
    return { ok: true, slug: back.slug, name: back.name, convId: id, from: back.entry };
  }

  /** A deleted project's thread came back on its own (its folder was moved back by hand): the lists show it. */
  private revived(convId: string): void {
    const slug = projectOfThread(convId);
    this.log(`project thread ${convId} revived (its folder is back)`);
    this.d.broadcast?.({ type: "project", slug, restored: true, convId });
  }

  /** Resolves when the conversation's running turn (if any) has ended. */
  private turnEnd(convId: string): Promise<void> {
    const l = this.live.get(convId);
    if (!l || l.finished) return Promise.resolve();
    return new Promise((r) => this.turnWaiters.set(convId, [...(this.turnWaiters.get(convId) ?? []), r]));
  }

  /**
   * /compact (Carl, 2026-10-23: "there should be a compact skill"): pi's own compaction of the conversation's
   * context now, with an optional focus for its summary. Clear is a view marker on each surface (it never touches
   * the context), so this is how Carl makes the shared context small on purpose. It waits for a running turn to
   * end (pi can't compact mid-turn) and runs before the next one; pi's file keeps the raw history.
   */
  async compact(convId: string, focus?: string): Promise<Record<string, unknown>> {
    const p = this.picture(convId);
    if (!p) return { ok: false, error: `conversation ${convId} not found` };
    const busy = this.compacting.get(convId);
    if (busy) return busy;
    const work = this.serial(convId, () => this.scoped(() => this.compactNow(convId, focus)));
    this.compacting.set(convId, work);
    void work.finally(() => this.compacting.delete(convId));
    return work;
  }

  private async compactNow(convId: string, focus?: string): Promise<Record<string, unknown>> {
    await this.turnEnd(convId);
    const conv = await readConv(this.d.vault, convId);
    const threadId = String(conv?.threadId ?? "");
    const file = String(conv?.threadPath ?? "");
    if (!conv || !threadId) return { ok: true, convId, compacted: false, note: "nothing to compact yet" };
    // Its runtime's word about this compaction comes by thread (a server just started has not mapped it yet).
    this.byThread.set(threadId, convId);
    // Said at once, on every surface: the summary takes minutes, and the runtime
    // may first have to start. The runtime's own word, when it comes, is the same line.
    this.emit(convId, { type: "live", ev: { type: "compaction_start", reason: "manual" } });
    let failed: string | null = null;
    try {
      const { model: cModel, effort: cEffort } = this.chatModel(conv);
      await this.d.backend.resumeThread(threadId, { model: cModel, effort: cEffort, subagents: capabilitiesOf(cModel).subagents, cwd: this.cwdOf(conv) });
      const r = await this.d.backend.compact(threadId, focus?.trim() ? `Carl asked to compact now. Keep in particular: ${focus.trim().slice(0, 500)}` : undefined);
      if (r.error || r.pending) {
        failed = r.error ?? "no word from the runtime after 10 minutes (the divider appears here if the summary still lands)";
        this.log(`compact ${convId}: ${failed}`);
        return { ok: false, convId, error: failed };
      }
      this.log(`compacted ${convId}${focus ? ` (focus: ${focus.slice(0, 80)})` : ""}${r.tokensBefore ? ` from ${r.tokensBefore} tokens` : ""}`);
      return { ok: true, convId, compacted: true, ...(r.tokensBefore ? { tokensBefore: r.tokensBefore } : {}) };
    } catch (e) {
      failed = `the engine did not compact: ${(e as Error).message}`;
      return { ok: false, convId, error: failed };
    } finally {
      // The summary may have dropped the turn sections (memory, project.md): the next turn sends them again.
      this.sectionsSent.delete(threadId);
      if (file) this.catchUp(convId, file);
      // Never a "Summarizing…" line left spinning: the divider took it down, or the runtime's own
      // failure did; otherwise it ends here, saying why.
      if ((this.picture(convId)?.inflight ?? []).some((x) => x.kind === "compaction" && isOpen(x))) {
        this.emit(convId, { type: "live", ev: { type: "compaction_end", aborted: false, errorMessage: (failed ?? "the runtime ended it without a summary").slice(0, 500) } });
      }
    }
  }

  /** A compaction's live event when no turn of the host's is open (see onEvent). */
  private compactionOutsideTurn(threadId: string, ev: any): void {
    const convId = this.byThread.get(threadId);
    const p = convId ? this.picture(convId) : null;
    if (!convId || !p) return;
    if (ev.type === "compaction_end") {
      this.sectionsSent.delete(threadId);
      const file = p.meta.threadPath;
      if (typeof file === "string" && file) this.catchUp(convId, file);
    }
    this.emit(convId, { type: "live", ev: ev.type === "compaction_start" ? { type: ev.type, ...(ev.reason ? { reason: ev.reason } : {}) } : { type: ev.type, aborted: !!ev.aborted, ...(ev.result ? { result: { ok: true } } : {}), ...(ev.errorMessage ? { errorMessage: String(ev.errorMessage).slice(0, 500) } : {}) } });
  }

  /** "Stop" / "never mind" on a call: the running turn stops and so does the work it handed off (its background
   *  workers). How many workers were stopped. */
  async stopWork(convId: string, since?: number, stopped?: string[]): Promise<number> {
    const turn = await this.interrupt(convId, true).catch(() => false);
    const running = ((this.picture(convId)?.meta.subagents ?? []) as { threadId: string; state?: string; status?: string; startedAt?: number; kind?: string }[]).filter((s) => (s.state ?? s.status) === "running" && s.kind !== "job");
    // "Never mind" is about what he just asked for: the work started since his previous line. Older work he didn't
    // mention keeps going ("forget the flashcards" stopped the midterm guide started minutes before). With nothing that
    // new and no turn running, it is the newest work ("how's it going?" … "never mind, cancel it").
    let subs = since == null ? running : running.filter((s) => (s.startedAt ?? 0) >= since);
    if (since != null && !subs.length && !turn && running.length) subs = [running.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a))];
    let n = 0;
    for (const s of subs)
      if ((await this.d.backend.subagentControl(s.threadId, "stop").catch(() => ({ ok: false }))).ok) {
        n++;
        const title = (s as { title?: string }).title || "background work";
        stopped?.push(title);
        if (stopped) this.stoppedOnHisWord.add(`${convId}\n${title}`);
      }
    return n;
  }

  private waitView = makeChatView();
  /** Workers he stopped on a call ("never mind"; the voice already told him): their report is not a turn. */
  private stoppedOnHisWord = new Set<string>();
  /** What a voice on `convId` is waiting on (src/voiceWaitLine.ts), for a surface with no feed of its own (the board). */
  waitInputs(convId: string): ReturnType<typeof waitInputs> | null {
    const p = this.picture(convId);
    if (!p) return null;
    const v = this.waitView(p);
    return waitInputs({ running: v.running, tools: v.live.tools, startedAt: v.startedAt, subagents: p.meta.subagents as any, todos: v.todos as any, messages: v.messages as any, now: Date.now() });
  }

  /** A voice call on `convId` (null: it ended). Its turns run on `model`; `rules` go in front of the call's first turn. */
  setTalker(convId: string, t: { model: string; rules: string; thinking?: string } | null): void {
    if (t) this.talkers.set(convId, { ...t, sent: false });
    else this.talkers.delete(convId);
  }

  /** pi's events of `convId`'s turns as they happen, plus {type: "vc_turn_end"} at each turn's end. Returns the unsubscribe. */
  tap(convId: string, fn: (ev: any) => void): () => void {
    const set = this.taps.get(convId) ?? new Set();
    set.add(fn);
    this.taps.set(convId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.taps.delete(convId);
    };
  }

  private tapEmit(convId: string, ev: any): void {
    for (const f of [...(this.taps.get(convId) ?? [])]) {
      try {
        f(ev);
      } catch (e) {
        this.log(`tap on ${convId}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * A chat's title, as a short summary of what it is about (Carl: not his first message): a cheap one-shot after
   * its first exchange, refreshed once after TITLE_REFRESH_TURNS of his messages. Main and a project's thread keep
   * their names; a title Carl gave it by hand (meta.titleBy "carl") is never touched.
   */
  private titling = new Set<string>();
  private async autoTitle(convId: string): Promise<void> {
    if (threadKindOf({ id: convId }) === "main" || threadKindOf({ id: convId }) === "project" || this.titling.has(convId)) return;
    if (TITLE_MODEL === "off" && !this.d.titleWith) return;
    const p = this.picture(convId);
    if (!p || p.meta.deleted || p.meta.titleBy === "carl") return;
    const asks = p.items.filter((i) => i.kind === "user" && (i.text ?? "").trim() && !["wake", "nudge", "resume", "job", "handoff"].includes(i.via ?? ""));
    if (!asks.length || !p.items.some((i) => i.kind === "assistant" && (i.text ?? "").trim())) return;
    const done = Number((p.meta.autoTitle as { turns?: number } | undefined)?.turns ?? 0);
    if (done && (done >= TITLE_REFRESH_TURNS || asks.length < TITLE_REFRESH_TURNS)) return;
    this.titling.add(convId);
    try {
      const said = p.items
        .filter((i) => (i.kind === "user" || i.kind === "assistant") && (i.text ?? "").trim())
        .slice(-16)
        .map((i) => `${i.kind === "user" ? "Carl" : "Assistant"}: ${String(i.text).trim().slice(0, 600)}`)
        .join("\n\n")
        .slice(-6000);
      const raw = await (this.d.titleWith ?? ((ins: string, text: string) => this.once({ instructions: ins, text, model: TITLE_MODEL })))(TITLE_INSTRUCTIONS, said);
      const title = [...String(raw ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? ""]
        .join("")
        .replace(/^(title:\s*)/i, "")
        .replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g, "")
        .slice(0, 60)
        .trim();
      // He may have renamed it (or deleted it) while it was being written.
      const now = this.picture(convId);
      if (!title || !now || now.meta.deleted || now.meta.titleBy === "carl") return;
      this.emit(convId, { type: "meta", patch: { title, titleBy: "auto", autoTitle: { turns: asks.length, at: Date.now() } } });
    } catch (e) {
      this.log(`title for ${convId} not made: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      this.titling.delete(convId);
    }
  }

  /** Carl names a chat himself: kept, and never replaced by a summary title. */
  renameConversation(id: string, title: string): { ok: true } | { ok: false; error: string } {
    const name = title.trim().slice(0, 120);
    const p = id ? this.picture(id) : null;
    if (!p || p.meta.deleted) return { ok: false, error: `no chat ${id}` };
    if (!name) return { ok: false, error: "a name is needed" };
    if (threadKindOf({ id }) === "main" || threadKindOf({ id }) === "project") return { ok: false, error: "Main and a project's thread are named by their place" };
    this.emit(id, { type: "meta", patch: { title: name, titleBy: "carl" } });
    return { ok: true };
  }

  /** A one-shot on the box itself (a note's title): pi, no session, no tools; the final text. */
  async once(req: { instructions: string; text: string; images?: string[]; fast?: boolean; model?: string }): Promise<string> {
    const r = await this.sideStart({ kind: "once", system: req.instructions, text: req.text, images: req.images, fast: req.fast }, this.d.vault, req.model);
    if (r.error) throw new Error(String(r.error));
    const s = await this.d.backend.side.wait(String(r.id));
    this.d.backend.side.forget(s.id);
    if (s.error) throw new Error(s.error);
    return s.text;
  }

  /** /kill. null → legacy path. Stop means stop: interrupt, wakes cancelled. */
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
      const gone = removeWakes(this.d.vault, (w) => w.conv === convId);
      await patchMeta(this.d.vault, convId, { nextWakeAt: undefined });
      // Stop on work held for the usage limit: it is not picked up at the reset.
      if (gone.some((w) => w.limit) && !this.live.get(convId)) {
        this.emit(convId, { type: "meta", patch: { state: "idle", nextWakeAt: null } });
        await this.notice(convId, "Stopped: not picked up when the limit resets.", "info");
        return true;
      }
    }
    const l = this.live.get(convId);
    if (!l) {
      if (!byUser) return false;
      // A native wait has no foreground Live turn. Serialize with delivery so
      // Stop still cancels its branch state before a late callback can resume.
      return this.serial(convId, async () => {
        if (this.live.has(convId)) return this.interrupt(convId, byUser);
        const conv = await readConv(this.d.vault, convId);
        return !!conv?.threadId && !!(await this.d.backend.cancelContinuation?.(conv.threadId));
      });
    }
    if (l.ask) {
      // Parked on a question: release the call so the turn can close.
      l.stopped = true;
      const a = l.ask;
      l.ask = null;
      this.emit(convId, { type: "meta", patch: { asking: null } });
      a.resolve("Carl stopped this turn instead of answering. End the turn now; do nothing else.");
    }
    l.stopped = byUser || l.stopped;
    // Native preflight (including compaction) is abortable before acceptance.
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

  /** How an engine input shows (a wake, a job, a resume). */
  private engineInput(input: string, kind: TurnKind): { via: string; shown: string } {
    const via = kind === "wake" ? (/^Job \S+ /.test(input) ? "job" : /^Delegated work /.test(input) ? "delegate" : "wake") : "resume";
    return { via, shown: kind === "wake" ? input.replace(/^Wake:\s*/, "") : input };
  }

  /** Start a turn (or, if one is running, hand the input to it). */
  run(convId: string, input: string, kind: TurnKind, opts: TurnOpts = {}): Promise<void> {
    // Busy from here (health's busy.runs), not only once the turn has started: the wait for
    // the conversation's earlier input, the runtime and the thread is part of the turn.
    const release = holdRun(convId);
    // Something Carl sent is always tried: whatever was failing before, he gets
    // his three (MAX_RESUMES) again rather than meeting a chat that refuses.
    if (kind === "user") this.resumes.delete(convId);
    return this.serial(convId, async () => {
      // Held behind a summary, and taken back meanwhile (Cancel, Edit): it does not run.
      if (opts.held && !pendingOf(this.picture(convId) ?? ({ meta: {} } as Picture)).some((x) => x.id === opts.clientId)) return;
      // Nothing to run it on: not signed in, or no Claude Code on this box.
      // A wake waits quietly — it fires on a schedule, and filing the same
      // failure every time is what buried Carl's chat. Something he typed says
      // so once, where he typed it.
      const cannot = this.d.backend.cannotRun?.();
      if (cannot) {
        if (kind === "user") await this.sayCannotRun(convId, cannot);
        else this.log(`${convId}: ${kind} held — ${cannot}`);
        if (opts.held && opts.clientId) this.setPending(convId, undefined, opts.clientId);
        return;
      }
      const existing = this.live.get(convId);
      // A turn the backend started is already covered by the one that is open.
      if (opts.adopt && existing && !existing.finished) return;
      if (existing && !existing.finished) {
        if (opts.ownTurn && kind !== "user") {
          void this.turnEnd(convId).then(() => this.run(convId, input, kind, opts)).catch((e) => this.log(`after-turn input on ${convId}: ${e}`));
          return;
        }
        if (existing.started && !existing.ask) {
          const b = this.d.backend;
          if (kind === "user") {
            // Ordinary input racing startup still waits for its own native follow-up.
            const id = opts.clientId ?? newMessageId();
            const sent = input;
            this.setPending(convId, { id, kind: "queue", text: opts.shown ?? input, at: Date.now() });
            existing.feed.expect({ kind: "queue", text: sent, clientId: id, shown: opts.shown ?? input, via: opts.via ?? "queue", images: opts.itemImages, hostContext: [opts.context, opts.hostContext].filter(Boolean).join("\n\n"), ...(opts.device ?? validDevice(opts.origin) ? { device: opts.device ?? opts.origin } : {}) });
            existing.rec.q("queue", id);
            // Detached workers keep their existing completion/report path.
            this.detachWaiting(convId, existing.threadId);
            await b.followUp(existing.threadId, { texts: [sent], context: [opts.context, opts.hostContext].filter(Boolean).join("\n\n"), request: { v: 1, clientId: id, via: opts.via ?? "queue", ...(opts.device ?? validDevice(opts.origin) ? { device: opts.device ?? opts.origin } : {}), ...(opts.itemImages?.length ? { images: opts.itemImages.map(({ path }) => ({ path })) } : {}) }, images: opts.images ?? [] }).catch(() => {
              existing.feed.forget(id);
              this.setPending(convId, undefined, id);
            });
            return;
          }
          // An engine input while a turn runs: shown where pi delivers it.
          existing.feed.expect({ kind: "silent", text: input, ...this.engineInput(input, kind) });
          await b.followUp(existing.threadId, { texts: [input], completion: opts.completion, images: [] }).catch(() => undefined);
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
      const shownInput = kind === "user" ? { via: opts.via ?? "chat", shown: opts.shown ?? input } : { ...this.engineInput(input, kind), ...(opts.shown ? { shown: opts.shown } : {}) };
      const fail = async (text: string, rec?: TurnRecorder) => {
        // pi never took it: the message itself (Carl's) and why, as vault-chat's lines.
        this.turnLine(rec ?? this.recorder(convId, turnId, null, kind, opts, clientId, null, startedAt), { status: "failed", outcome: "not_started", state: "idle", error: text });
        const lines: NoteData[] = kind === "user" ? [{ kind: "line", role: "user", text: shownInput.shown, via: shownInput.via, clientId, ...(opts.itemImages?.length ? { images: opts.itemImages } : {}) }] : [];
        await this.note(convId, [...lines, { kind: "notice", text, level: "error" }]);
        this.emit(convId, { type: "meta", patch: { running: null, state: "idle" } });
        if (opts.held && opts.clientId) this.setPending(convId, undefined, opts.clientId);
      };
      if (!existsSync(this.d.vault) || !statSync(this.d.vault).isDirectory()) {
        await fail(`⚠️ The vault ${this.d.vault} is missing on the box; no turn was run.`);
        return;
      }
      let threadId: string;
      let fresh: boolean;
      try {
        ({ threadId, fresh } = await this.ensureThread(conv, kind === "user" ? (opts.shown ?? input) : null));
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
      const talker = this.talkers.get(convId);
      let model = talker?.model ?? this.d.model();
      if (opts.images?.length && !capabilitiesOf(model).images) model = this.d.visionModel ?? model;
      const rec = this.recorder(convId, turnId, threadId, kind, opts, clientId, model, startedAt);
      const feed = new PiFeed({
        file,
        emit: (b) => this.emit(convId, b),
        pointed: this.skipSet(convId, file, after),
        delivered: (id, origin) => {
          if (pendingOf(this.picture(convId)!).some(p => p.id === id)) {
            this.setPending(convId, undefined, id);
            rec.q("delivered", id);
          }
          // A call's voice speaks what answers his newest words from here on (server/voiceBrain.ts).
          if (this.taps.has(convId)) this.tapEmit(convId, { type: "vc_delivered", clientId: id, origin });
        },
      });
      // Anything pi wrote that the feed missed (a crash between its write and the pointer) comes first.
      feed.sync(true);
      const live: Live = {
        convId,
        threadId,
        turnId,
        kind,
        startedAt,
        feed,
        rec,
        ask: null,
        asks: 0,
        open: new Map(),
        cut: false,
        stopped: false,
        controller: new AbortController(),
        started: false,
        finished: false,
        input,
        byCarl: kind === "user" || !!opts.byCarl,
        turnOpts: opts,
        cwd: (typeof this.d.backend.threadSource === "function" ? this.d.backend.threadSource(threadId)?.cwd : null) || this.d.vault,
      };
      // The old Stop path (runRegistry) reaches engine runs too.
      live.controller.signal.addEventListener("abort", () => void this.interrupt(convId, true));
      this.live.set(convId, live);
      registerRun(convId, live.controller);
      // History from before this thread (a legacy chat) goes with its first turn.
      let body = input;
      const context: string[] = [];
      let rules = "";
      // An adopted turn sends no prompt, so it must consume nothing: the
      // handover, the sections the thread has not had, the one-off line for the
      // agent and a call's rules all still belong to the next real prompt.
      if (!opts.adopt) {
        context.push(...[opts.context, opts.hostContext].filter((s): s is string => !!s));
        const prior = this.handover.get(convId);
        if (prior) {
          this.handover.delete(convId);
          context.push(prior);
        }
        // What the thread already has (rules, memory, its project.md, the project list, its folder) is not sent
        // again: only a section that changed goes in front of the turn (the rules mechanism, for all of them).
        rules = this.changedSections(threadId, conv);
        // Something Carl did that the agent must hear once (a project he deleted): in front of this turn, then gone.
        const tell = this.picture(convId)?.meta.tellAgent as string[] | undefined;
        if (tell?.length) {
          context.push(tell.map((t) => `[${t}]`).join("\n"));
          this.emit(convId, { type: "meta", patch: { tellAgent: null } });
        }
        // A live voice call: its rules once per call, in front of its first turn (they stay in the session after).
        if (talker && !talker.sent) {
          talker.sent = true;
          context.push(talker.rules);
        }
      }
      // What Carl did elsewhere is not in the prompt: pi's extension adds it (the "you" layer, a vc-you custom message).
      // Host instructions/memory are pi custom context, never a forged user message.
      const texts = [kind === "wake" ? input : body].filter(Boolean);
      if (!opts.adopt) live.feed.expect({ kind: "prompt", text: texts.join("\n\n"), clientId: kind === "user" ? clientId : undefined, ...shownInput, ...(opts.itemImages?.length ? { images: opts.itemImages } : {}), ...(kind === "user" && (opts.device ?? validDevice(opts.origin)) ? { device: opts.device ?? opts.origin } : {}) });
      // A live call learns where this turn came from (a call speaks only its own surface's exchange).
      if (this.taps.has(convId)) this.tapEmit(convId, { type: "vc_turn_start", kind, origin: opts.origin ?? null });
      try {
        // Pi owns the waiting messages. Reinsert the existing undelivered feed
        // BEFORE starting the replacement prompt: a fast response can settle
        // while an asynchronous steer is still entering Pi, stranding it idle.
        // The selected message is answered next; other waiting inputs follow
        // via Pi's native follow_up, in order, without steering ahead of it.
        // Preserve client identity and original viewer/device/context.
        for (const e of opts.replay ?? []) {
          this.setPending(convId, { id: e.clientId!, kind: e.kind === "queue" ? "queue" : "steer", text: e.shown, at: Date.now() });
          live.feed.expect(e);
          rec.q(e.kind === "queue" ? "queue" : "steer", e.clientId!);
          const queued = { texts: [e.text], context: e.hostContext, request: e.clientId ? { v: 1 as const, clientId: e.clientId, via: e.via, ...(e.device ? { device: e.device } : {}), ...(e.images?.length ? { images: e.images.map(({ path }) => ({ path })) } : {}) } : undefined, images: (e.images ?? []).map(im => join(this.d.vault, im.path)) };
          await this.d.backend.followUp(threadId, queued);
        }
        // An adopted turn is already running in the backend: it gets no prompt,
        // and what it was started for (a queued message it took, a background
        // task that finished) is already in the transcript.
        if (!opts.adopt) await this.d.backend.startTurn(threadId, { texts, completion: kind === "user" ? undefined : opts.completion, context: [rules, ...context].filter(Boolean).join("\n\n"), ...(kind === "user" ? { request: { v: 1 as const, clientId, via: shownInput.via, ...(opts.device ?? validDevice(opts.origin) ? { device: opts.device ?? opts.origin } : {}), ...(opts.itemImages?.length ? { images: opts.itemImages.map(({ path }) => ({ path })) } : {}) } } : {}), images: opts.images ?? [], model, turnId, ...(talker?.thinking ? { thinking: talker.thinking } : {}) });
        live.started = true;
        // Stop may arrive before the prompt itself reached pi (model/context
        // setup). Honor it at native acceptance too, without a fresh prompt.
        if (live.stopped && !live.finished) await this.d.backend.interrupt(threadId, turnId);
      } catch (e) {
        live.finished = true;
        this.live.delete(convId);
        unregisterRun(convId, live.controller);
        live.feed.dispose();
        await fail(`⚠️ The engine could not start this turn: ${(e as Error).message}`, rec);
      }
    }).finally(release);
  }

  /**
   * "Sign in with Claude to chat", in the conversation, once.
   *
   * The clients already draw this inline where the composer is, from the box's
   * health — so this is only for a turn that reached the box anyway (a phone
   * that had not re-read health yet). Repeating it would be the thing it is
   * there to replace, so a conversation whose last word is already this one
   * stays as it is.
   */
  private async sayCannotRun(convId: string, why: string): Promise<void> {
    const last = this.picture(convId)?.items.slice(-1)[0];
    if (last && last.kind === "notice" && (last as { text?: string }).text === why) return;
    await this.notice(convId, why);
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

  /** A project thread's working folder: the folder Carl chose for it on the box (server/projectFolders.ts), else its
   *  main folder in the vault (project.md's `folder:`), else the vault. */
  private inVault(p: string): boolean {
    const rel = relative(resolve(this.d.vault), p);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /** A git project's clone, made before its pi starts there (its folder's main branch, the first time). */
  private async prepareFolder(conv: EngineConv): Promise<void> {
    const f = this.folderOf(conv);
    if (!f || !("git" in f) || !f.git) return;
    const slug = projectOfThread(conv.id)!;
    const r = await ensureClone(this.d.vault, slug, f.git.folder);
    if ("error" in r) this.log(`project ${slug}: ${r.error}`);
  }

  private folderOf(conv: EngineConv): { abs: string; rel: string; outside?: boolean; git?: { folder: string; clone: string } } | { error: string } | null {
    const slug = projectOfThread(conv.id);
    const p = slug ? readProject(slug) : null;
    if (!p) return null;
    const chosen = projectFolderOf(this.d.vault, p.slug);
    if (!chosen) return { error: `the project's folder is not registered` };
    if ("error" in chosen) return { error: `the folder chosen for this project can't be used: ${chosen.error}` };
    if (chosen && isGatedProject(chosen.abs) && !this.inVault(chosen.abs)) {
      // A git repo: the agent works in its clone, on an agent/ branch; the folder itself is service-owned (proof-gated acceptance).
      return { abs: cloneDirOf(this.d.vault, p.slug), rel: chosen.abs.split(sep).join("/"), outside: true, git: { folder: chosen.abs.split(sep).join("/"), clone: cloneDirOf(this.d.vault, p.slug).split(sep).join("/") } };
    }
    const rel = relative(resolve(this.d.vault), chosen.abs).split(sep).join("/");
    // The vault itself may be a project (its root: rel ".").
    const inVault = !rel.startsWith("..") && !isAbsolute(rel);
    return inVault ? { abs: chosen.abs, rel: rel || "." } : { abs: chosen.abs, rel: chosen.abs.split(sep).join("/"), outside: true };
  }

  /** A thread's working folder: a project's folder, else the vault (Main runs in the main vault: it is no
   *  folder's conversation, but its tools and the agent's habits work from the vault root). */
  private cwdOf(conv: EngineConv): string {
    const f = this.folderOf(conv);
    return f && "abs" in f ? f.abs : this.d.vault;
  }

  /** The turn sections that changed since this thread last got them (all of them for a thread that has none yet). */
  private changedSections(threadId: string, conv: EngineConv): string {
    const sent = this.sectionsSent.get(threadId) ?? new Map<string, string>();
    this.sectionsSent.set(threadId, sent);
    const out: string[] = [];
    const roots = ctxConfig().vaults?.() ?? [this.d.vault];
    // Names/paths only, not other conversations, rules or memories. This section
    // uses the existing changed-section cache, so it is not repeated every turn.
    const files = { key: "vault-files", text: `<vault-files>Registered synced vault content (use absolute paths; the project/thread stays here):\n${roots.map(p => `- ${p}/`).join("\n")}\nFile-context paths without a request-specific viewer binding refer to the conversation owner's vault: ${this.d.vault}/. Use absolute paths for vault files. Read and Bash relative paths use the thread/project cwd, not the viewer root.\nOther vaults' .vault-chat and .git are private; service-owned project sources remain read-only.</vault-files>` };
    // A runtime that is given the vault's memory by its own means (Claude Code
    // imports it in the session) must not be told it again in front of the turn.
    const ownMemory = !!this.d.backend.carriesMemory?.(threadId);
    for (const x of [...turnSections(conv as any, { folder: this.folderOf(conv) }), files]) {
      if (ownMemory && x.key === "memory") continue;
      if (sent.get(x.key) === x.text) continue;
      sent.set(x.key, x.text);
      out.push(x.text);
    }
    return out.join("\n\n");
  }

  /** One current host policy for new and resumed sessions; vault tools keep collision checks. */
  private async hostToolCatalog(loadout: HostLoadout): Promise<ToolSpec[]> {
    if (loadout === "readOnly") return sideToolSpecs();
    const builtin = agentToolSpecs();
    const own = await vaultToolSpecsFor(this.d.vault, [...builtin.map((t) => t.name), ...PI_BUILTIN_TOOLS]);
    const selected = loadout === "conversation" ? builtin : voiceSideToolSpecs(loadout === "voiceAct");
    return [...selected, ...own] as ToolSpec[];
  }

  /**
   * The model and effort THIS chat runs on: Carl's choice for it (the composer's
   * picker, kept in the conversation's own fields), or the box's last choice,
   * which is what a chat he has not chosen for starts from.
   */
  /** The one model and effort every chat runs on (setChatModel); the conversation's own fields are not read. */
  private chatModel(_conv: EngineConv): { model: string; effort?: Effort } {
    const effort = this.d.effort?.();
    return { model: this.d.model(), ...(effort ? { effort } : {}) };
  }

  private async ensureThread(conv: EngineConv, current: string | null = null): Promise<{ threadId: string; fresh: boolean }> {
    const { model, effort } = this.chatModel(conv);
    // Subagents only for models where they work (learned from use; see capabilities.ts).
    const subagents = capabilitiesOf(model).subagents;
    // A project's thread runs in its main folder (pi loads that folder's AGENTS.md itself); a change of folder restarts its pi.
    await this.prepareFolder(conv);
    const cwd = this.cwdOf(conv);
    if (conv.threadId) {
      try {
        await this.d.backend.resumeThread(conv.threadId, { model, effort, subagents, cwd });
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
    // The same current host policy is used by resumeThread (never a saved schema).
    const { threadId, ref } = await this.d.backend.startThread({
      cwd,
      model,
      effort,
      instructions,
      tools: await this.hostToolCatalog("conversation"),
      subagents,
      conv: conv.id,
    });
    this.byThread.set(threadId, conv.id);
    // The instructions carry the rules in full; the rest of the sections go with the first turn.
    this.sectionsSent.set(threadId, new Map([["rules", rulesPrefixForTurn(conv as any).trim()]]));
    // History from before this thread (a legacy chat, a voice call's lines, a retry on a fresh thread): hand it over
    // once — without this turn's own message when it is already there (a retry).
    const said = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim());
    const last = said[said.length - 1];
    const old = last && last.role === "user" && current !== null && last.content.trim() === current.trim() ? said.slice(0, -1) : said;
    if (old.length && !conv.messages.some((m: any) => m.rollover)) {
      const t = old.slice(-30).map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1500)}`).join("\n");
      this.handover.set(conv.id, `<earlier_conversation>\n${t.slice(-12_000)}\n</earlier_conversation>`);
    }
    // A new chat takes the last choice as its OWN, here, once: after this it is
    // this chat's model and effort, and a later pick in another chat leaves it
    // alone (nothing restarts a session Carl is not looking at).
    const own = (conv as { model?: unknown }).model;
    await patchMeta(this.d.vault, conv.id, {
      threadId,
      threadPath: ref,
      ...(typeof own === "string" && own ? {} : { model }),
      ...(effort && (conv as { effort?: unknown }).effort === undefined ? { effort } : {}),
    });
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
      // A subagent's own stream: never mixed into its parent's transcript.
      if (e.kind === "turnCompleted") this.updateSubagent(parent, e.threadId, { status: e.status });
      return;
    }
    // A subagent's end can arrive after its parent's turn is gone (the parent crashed): still record it.
    // A worker's row belongs to the conversation it was started in, whatever thread the parent is on by then.
    if (e.kind === "subagentStatus" && !this.liveByThread(e.threadId)) {
      const convId = this.childOf.get(e.child) ?? this.byThread.get(e.threadId);
      if (convId) {
        this.childOf.set(e.child, convId);
        this.updateSubagent(convId, e.child, { status: e.status, ...(e.patch ?? {}) });
      } else this.log(`worker ${e.child}: no conversation for its ${e.status} (thread ${e.threadId})`);
      return;
    }
    const l = this.liveByThread(e.threadId);
    if (!l && e.kind === "pi" && (e.ev?.type === "compaction_start" || e.ev?.type === "compaction_end")) {
      // A compaction with no turn of the host's around it (/compact, the runtime's own while idle): straight
      // to the conversation, or the chat would show nothing for minutes. At its end the divider first.
      this.compactionOutsideTurn(e.threadId, e.ev);
      return;
    }
    if (!l) {
      // A turn the backend started by itself: a queued message it has taken, or
      // a background task of its own that finished while nothing was running.
      // The host takes it as an ordinary turn, so the feed and the clients show
      // it like any other (it is how the chat stays whole).
      if (e.kind === "turnStarted" && !shuttingDown) this.adopt(e.threadId);
      return;
    }
    switch (e.kind) {
      case "pi":
        this.onPi(l, e.ev);
        return;
      case "usage": {
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
        // Workers own independent task rows; MCP request ids and pi model call
        // ids are unrelated. Never guess ownership from the newest open call.
        if (e.done && e.ok && e.op === "spawnAgent" && e.children.length) {
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
        void this.finishTurn(l, e.status, e.error ?? l.feed.lastError, !!e.limited);
        return;
      case "signInRefused":
        // The API is refusing this box's sign-in, and the runtime retries that
        // for ever. Say it once, where Carl is, and stop the turn: there is
        // nothing to retry on a credential that is being refused.
        l.refused = true;
        void this.notice(l.convId, SIGN_IN_AGAIN, "error").then(() => this.interrupt(l.convId, false));
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
      case "tool_execution_start":
        l.open.set(String(ev.toolCallId ?? ""), { name: toolName(String(ev.toolName ?? "")), input: ev.args ?? {} });
        break;
      case "compaction_end":
        // The summary may have dropped what the turn sections said: the next turn sends them again.
        if (ev.result) this.sectionsSent.delete(l.threadId);
        break;
      case "tool_execution_end": {
        const id = String(ev.toolCallId ?? "");
        const o = l.open.get(id);
        if (o && WRITE_TOOLS.has(o.name) && !ev.isError) {
          // A project thread in its main folder: a relative path starts there.
          const rel = String(o.input?.path ?? o.input?.file_path ?? "");
          const input = rel && !isAbsolute(rel) && l.cwd !== this.d.vault ? { ...o.input, path: resolve(l.cwd, rel) } : o.input;
          const p = writtenPath(this.d.vault, input);
          if (p) this.d.onFilesWritten?.([p]);
        }
        l.open.delete(id);
        break;
      }
    }
    l.feed.onPi(ev);
    if (this.taps.has(l.convId)) this.tapEmit(l.convId, ev);
  }

  /** Open a turn around one the backend started by itself (see onEvent). */
  private adopt(threadId: string): void {
    const convId = this.byThread.get(threadId);
    // One adoption at a time: the backend can report several events before the
    // turn is open, and a second run() would push an empty message into it.
    if (!convId || this.live.get(convId) || this.adopting.has(threadId)) return;
    this.adopting.add(threadId);
    void this.run(convId, "", "resume", { adopt: true })
      .catch((e) => this.log(`adopting a turn on ${convId}: ${(e as Error).message}`))
      .finally(() => this.adopting.delete(threadId));
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
    // A session that dies on every request would otherwise be resumed for ever.
    const prev = this.resumes.get(l.convId);
    const n = prev && Date.now() - prev.at < RESUME_WINDOW_MS ? prev.n + 1 : 1;
    this.resumes.set(l.convId, { n, at: Date.now() });
    if (n > MAX_RESUMES) {
      this.log(`thread lost ${n} times in a row on ${l.convId}: not resuming again`);
      void this.finishTurn(l, "interrupted", null)
        .then(() => this.notice(l.convId, RESUME_GAVE_UP, "error"))
        .catch((err) => this.log(`give up on ${l.convId}: ${err}`));
      return;
    }
    void this.finishTurn(l, "interrupted", null).then(() => this.run(l.convId, RESUME_TEXT, "resume", { byCarl: l.byCarl })).catch((err) => this.log(`resume ${l.convId} failed: ${err}`));
  }

  /**
   * A turn refused for the usage limit: one hold for the conversation (a limit
   * wake, durable in wakes.json like any wake), at the reset plus a margin —
   * or, with no reset named, after a back-off. Messages sent while it holds
   * keep the one hold and its time; only the retry failing again moves it on.
   */
  private holdForLimit(l: Live): Wake {
    const vault = this.d.vault;
    const prev = removeWakes(vault, (w) => w.conv === l.convId && !!w.limit);
    const retry = l.turnOpts.limitTries;
    const tries = retry !== undefined ? retry + 1 : Math.max(1, ...prev.map((w) => w.limit!.tries));
    const now = Date.now();
    const limit = this.d.backend.usageLimit?.();
    const at = limit?.resetsAt && limit.resetsAt > now
      ? limit.resetsAt + LIMIT_MARGIN_MS
      : retry === undefined && prev.length
        ? Math.min(...prev.map((w) => w.at))
        : now + Math.min(LIMIT_BACKOFF_MS * 2 ** (tries - 1), LIMIT_BACKOFF_CAP_MS);
    const wake = addWake(vault, { conv: l.convId, at, reason: LIMIT_SHOWN, ...(l.byCarl || prev.some((w) => w.byCarl) ? { byCarl: true } : {}), limit: { tries } });
    this.log(`usage limit on ${l.convId}: ${l.kind} held until ${new Date(at).toISOString()} (try ${tries})`);
    return wake;
  }

  private async finishTurn(l: Live, status: string, error: any, limited = false): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    // A turn that ended on its own terms means the session is not in the loop
    // onThreadLost counts (a stop is Carl's, not a failure to make progress).
    if (status !== "interrupted") this.resumes.delete(l.convId);
    if (this.live.get(l.convId) === l) this.live.delete(l.convId);
    unregisterRun(l.convId, l.controller);
    l.feed.dispose();
    const vault = this.d.vault;
    const errStr = status === "failed" ? errText(error) : "";
    if (errStr && /tool/i.test(errStr) && /(not support|unsupported|No endpoints found)/i.test(errStr)) {
    }
    // Refused for the usage limit: held for the reset, not a failure (Stop is Carl's: nothing held).
    const held = status === "failed" && limited && !l.stopped && !l.cut;
    if (held) this.holdForLimit(l);
    // Answered: whatever was held for the limit is in this turn's history and taken up.
    else if (status === "completed" && (l.kind === "user" || l.turnOpts.limitTries !== undefined)) removeWakes(vault, (w) => w.conv === l.convId && !!w.limit);
    const conv0 = await readConv(vault, l.convId);
    const wakeAt = nextWakeFor(vault, l.convId);
    // The final state, decided once.
    const state: EngineConv["state"] = conv0?.pendingAsk ? "waiting_user" : wakeAt ? "sleeping" : "idle";
    // Stop/failure drops undelivered input. Send now transfers the existing
    // native inputs: keep them pending until their exact entries are delivered.
    this.emit(l.convId, { type: "meta", patch: { running: null, ...(l.sendNow ? {} : { pending: null }), state, nextWakeAt: wakeAt ?? null } });
    // What ended it, said once in the transcript (after what was in flight, which the end closed).
    // A turn stopped because the sign-in was refused has already said so.
    if (l.refused || held) {
      /* its line is written (a limit's: the quiet one its message carries, src/convlog/reduce.ts) */
    } else if (l.cut) await this.notice(l.convId, INTERRUPTED_TEXT, "error");
    // (A failure pi's own message carries is shown from that message: not said twice.)
    else if (status === "failed" && errStr !== l.feed.lastError) await this.notice(l.convId, `⚠️ The turn failed: ${errStr}`, "error");
    else if (status === "interrupted" && !l.sendNow) await this.notice(l.convId, "Stopped.", "info");
    const conv = await readConv(vault, l.convId);
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);
    const outcome = l.cut ? "cut" : l.stopped ? "stopped" : held ? "held" : status === "completed" ? "ok" : status;
    this.turnLine(l.rec, { status, outcome, state, error: errStr || null });
    this.offerTurnPush(l, outcome, state, errStr, conv?.title ?? conv0?.title ?? "");
    this.d.onTurnEnded?.(l.convId);
    if (status === "completed") void this.autoTitle(l.convId);
    for (const w of this.turnWaiters.get(l.convId)?.splice(0) ?? []) w();
    if (this.taps.has(l.convId)) this.tapEmit(l.convId, { type: "vc_turn_end", status, kind: l.kind });
  }

  /** A turn Carl started ended: offered to the push gate (server/pushGate.ts), which buzzes only if he is away from every screen. */
  private offerTurnPush(l: Live, outcome: string, state: string, errStr: string, title: string): void {
    if (!l.byCarl || state === "waiting_user") return; // a question pushes on its own (AskUser)
    const name = title && title !== "New chat" ? title : "your chat";
    let why: "finished" | "failed";
    let head: string;
    let body: string;
    if (outcome === "ok") {
      const items = this.picture(l.convId)?.items ?? [];
      const reply = [...items].reverse().find((x) => x.kind === "assistant" && x.at >= l.startedAt && (x.text ?? "").trim());
      const t = (reply?.text ?? "").replace(/\s+/g, " ").trim();
      if (!t || /^NO_REPLY\b/.test(t)) return;
      why = "finished";
      head = `Done: ${name}`;
      body = t.slice(0, 180);
    } else if (outcome === "failed") {
      why = "failed";
      head = `Failed: ${name}`;
      body = `${(errStr || "the turn failed").slice(0, 140)} — open it to retry.`;
    } else return; // stopped or cut: he stopped it, or the restart resumes it
    void this.d
      .notify({ kind: "info", title: head.slice(0, 90), body, convId: l.convId, why, byCarl: true, trigger: l.kind === "user" ? "turn end" : `${l.turnOpts.via ?? l.kind} end`, pushOnly: true })
      .catch(() => undefined);
  }

  /** A background worker's report (a `subagent` call moved to the background, or any worker) comes back to its
   *  conversation as one new turn, "Delegated work finished: …" — exactly once. If that turn cannot start, the
   *  report is still written into the conversation as a line, never dropped. */
  private reportWhenDone(convId: string, title: string, result: Promise<Record<string, unknown>>, workerId?: Promise<string>): void {
    void result
      .then(
        (r: any) => `Delegated work ${r?.ok ? "finished" : `failed (${r?.state ?? "error"})`}: "${title}"\n\n${String(r?.text ?? "").slice(0, 12_000) || "(no report)"}`,
        (err: Error) => `Delegated work failed: "${title}"\n\n${err?.message ?? err}`,
      )
      .then(async (input) => {
        const id = await workerId;
        // He stopped it himself ("never mind"), and the agent already said so: its "stopped" report is a line in the
        // chat, not a turn — the voice said it was stopped twice (the roleplay's second round).
        const key = `${convId}\n${title}`;
        if (this.stoppedOnHisWord.delete(key) && !input.startsWith("Delegated work finished")) return this.notice(convId, `Stopped as he asked: "${title}".`);
        return this.scoped(() =>
          this.run(convId, input, "wake", { ownTurn: true, ...(id ? { completion: { kind: "delegate", id } } : {}) }).catch((err: Error) => {
            this.log(`delegate result on ${convId}: ${err.message}`);
            return this.notice(convId, `${input.split("\n")[0]} — the agent could not take it up (${err.message}).\n\n${input.split("\n").slice(2).join("\n").slice(0, 4000)}`, "warn");
          }),
        );
      });
  }

  /** At boot: workers a restart of the server took down (their processes went with it) still read "running". Each
   *  is marked ended; a background one's conversation gets its "failed" turn (the agent says so, or starts it again);
   *  a blocking one belonged to a turn that the restart cut, and that turn's resume takes it up. */
  private reapLostWorkers(): void {
    const log = logOf(this.d.vault);
    for (const convId of log.ids()) {
      const subs = (this.picture(convId)?.meta.subagents ?? []) as Record<string, any>[];
      for (const s of subs) {
        // A StartJob job outlives a restart (tickJobs ends its row when it ends).
        if ((s.state ?? s.status) !== "running" || s.kind === "job" || this.d.backend.liveChild?.(s.threadId)) continue;
        this.updateSubagent(convId, s.threadId, { status: "killed", state: "killed", endedAt: Date.now(), summary: "Stopped by a restart of the server before it reported." });
        // (A whiteboard make reports in Carl's inbox instead: BoardMake marks its entry failed on its own path.)
        if (!s.background || s.agent === "board-maker") continue;
        this.log(`worker ${s.threadId} on ${convId} was lost in a restart: reporting it`);
        this.reportWhenDone(convId, String(s.title ?? s.task ?? "background work").slice(0, 120), Promise.resolve({ ok: false, state: "killed", text: "The server restarted while this worker ran, so it stopped before it reported. Start it again if it is still wanted." }));
      }
    }
  }

  /** Every 15 s: a worker row still "running" whose worker is not running in this process (its end was never
   *  recorded) is closed with how it really ended (or as lost), so a dead task never lingers on screen. A StartJob
   *  job's row is tickJobs' (it may rightly run for days: a dev server). */
  private closeDeadWorkerRows(): void {
    if (!this.d.backend.liveChild) return;
    const now = Date.now();
    for (const convId of logOf(this.d.vault).ids()) {
      const subs = (this.picture(convId)?.meta.subagents ?? []) as Record<string, any>[];
      for (const s of subs) {
        if ((s.state ?? s.status) !== "running" || s.kind === "job") continue;
        if (now - (Number(s.startedAt) || now) < 60_000 || this.d.backend.liveChild?.(s.threadId)) continue;
        const end = this.d.backend.endedChild?.(s.threadId) ?? null;
        const state = end?.state ?? "killed";
        this.log(`worker ${s.threadId} on ${convId}: its row still said running; closed as ${state}`);
        this.updateSubagent(convId, s.threadId, { status: state, state, endedAt: end?.endedAt ?? now });
      }
    }
  }

  /** A worker (subagent) of this conversation, as its row has it. */
  private workerRec(convId: string, id: string): Record<string, any> | null {
    if (!id) return null;
    const subs = (this.picture(convId)?.meta.subagents ?? []) as Record<string, any>[];
    return subs.find((s) => s.threadId === id && s.kind !== "job") ?? null;
  }

  /** One worker for JobStatus: state, what it is doing (from its own pi events), steps, time; its report once ended. */
  private workerStatus(convId: string, id: string): string | null {
    const rec = this.workerRec(convId, id);
    if (!rec) return null;
    const live = this.d.backend.liveChild?.(id) ?? null;
    const since = Number(rec.startedAt) || Date.now();
    const dur = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
    if (live) return `Worker ${id} ("${live.title}"): running for ${dur(Date.now() - since)}, ${live.steps} tool call(s) done, now ${live.activity}.${live.said ? `\nIts latest words: ${live.said}` : ""}`;
    const state = String(rec.state ?? rec.status ?? "ended");
    return `Worker ${id} ("${rec.title ?? rec.task ?? ""}"): ${state === "running" ? "no longer running (its report is on its way)" : state}${rec.endedAt ? `, after ${dur(Number(rec.endedAt) - since)}` : ""}.${rec.summary ? `\nIts report began: ${String(rec.summary).slice(0, 400)}` : ""}`;
  }

  /** This conversation's running workers, one line each (JobList), or "" when none. */
  private workerList(convId: string): string {
    const subs = (this.picture(convId)?.meta.subagents ?? []) as Record<string, any>[];
    const out: string[] = [];
    for (const s of subs) {
      const live = this.d.backend.liveChild?.(s.threadId);
      if (!live) continue;
      out.push(`- ${s.threadId}: "${live.title}", running ${Math.round((Date.now() - (Number(s.startedAt) || Date.now())) / 60_000)} min, ${live.steps} step(s), now ${live.activity}`);
    }
    return out.join("\n");
  }

  /** Carl wrote while the turn waits on a `subagent` call: its children move to the background, the call answers
   *  at once (so his message is taken up now), and each report comes back as its own turn. */
  private detachWaiting(convId: string, threadId: string): void {
    for (const d of this.d.backend.detach?.(threadId) ?? []) this.reportWhenDone(convId, d.title, d.result, Promise.resolve(d.id));
  }

  /** A job's row in the chip ended (its own end, JobStop, or Stop in the chip). */
  private jobRowEnded(convId: string, id: string, state: "completed" | "stopped" | "failed", activity?: string): void {
    const rec = ((this.picture(convId)?.meta.subagents ?? []) as Record<string, any>[]).find((s) => s.threadId === id);
    if (!rec || rec.kind !== "job" || (rec.state ?? rec.status) !== "running") return;
    this.updateSubagent(convId, id, { state, status: state, endedAt: Date.now(), activity: activity ?? state });
  }

  /** Running jobs' rows say what they serve ("serving localhost:5173"), from the ports they listen on. */
  private jobActivity(): void {
    if (process.platform !== "linux") return;
    const running = readJobs(this.d.jobEnv).filter((j) => j.state === "running" && j.conv);
    if (!running.length) return;
    let ports: ReturnType<typeof jobPorts>;
    try {
      ports = jobPorts();
    } catch {
      return;
    }
    for (const j of running) {
      const mine = [...ports.entries()].filter(([, o]) => o.job === j.id).map(([p]) => p).sort((a, b) => a - b);
      // A port bound to every interface works, but answers on the tailnet without Carl's login: said in the row.
      const open = mine.filter((p) => ports.get(p)?.all);
      const activity = mine.length ? `serving ${mine.map((p) => `localhost:${p}`).join(", ")}${open.length ? ` · listening on all interfaces (${open.join(", ")})` : ""}` : "running";
      const rec = ((this.picture(j.conv!)?.meta.subagents ?? []) as Record<string, any>[]).find((s) => s.threadId === j.id);
      if (rec && rec.kind === "job" && (rec.state ?? rec.status) === "running" && rec.activity !== activity) this.updateSubagent(j.conv!, j.id, { activity });
    }
  }

  /** JobStatus of a job one of whose ports listens on every interface: says so, and to restart it on localhost. */
  private withExposed(id: string, status: string): string {
    if (process.platform !== "linux") return status;
    try {
      const open = [...jobPorts().entries()].filter(([, o]) => o.job === id && o.all).map(([p]) => p);
      return open.length ? `${status}\n\n${exposedNote(open)}` : status;
    } catch {
      return status;
    }
  }

  /** Show's dev servers: a loopback port one of this vault's running jobs listens on → its tailnet origin. */
  private devUrl(port: number): Promise<{ origin: string } | { error: string }> {
    const jobs = new Set(readJobs(this.d.jobEnv).filter((j) => j.state === "running").map((j) => j.id));
    return this.devs().url(port, jobs);
  }
  private devs() {
    let own: number[] = [];
    try {
      own = [loadConfig().port];
    } catch {
      /* no config (tests) */
    }
    return devProxies([...own, Number(process.env.VC_VOICE_PIPELINE_PORT) || 8857]);
  }
  private devSweep(): void {
    try {
      this.devs().sweep();
    } catch {
      /* next tick */
    }
  }

  private updateSubagent(convId: string, threadId: string, patch: Record<string, unknown>): void {
    const p = this.picture(convId);
    if (!p) return;
    const subs = ((p.meta.subagents ?? []) as { threadId: string }[]).slice();
    const i = subs.findIndex((s) => s.threadId === threadId);
    if (i >= 0) subs[i] = { ...subs[i]!, ...patch };
    else subs.push({ threadId, ...patch });
    this.emit(convId, { type: "meta", patch: { subagents: subs } });
    const worker = subs.find((s) => s.threadId === threadId) as Record<string, unknown> | undefined;
    // A finished native session is already the transcript. Expose it through the
    // same conversation/feed primitives; never copy its report to a new store.
    if (worker?.kind !== "job" && worker?.toolCallId && worker.sessionFile && worker.state && worker.state !== "running") {
      if (!this.picture(threadId)) this.emit(threadId, { type: "meta", patch: {
        title: String(worker.title ?? worker.task ?? "Worker"), source: "worker", kind: "separate",
        threadId, threadPath: String(worker.sessionFile), createdAt: Number(worker.startedAt ?? Date.now()),
      } });
      this.catchUp(threadId, String(worker.sessionFile));
    }

  }

  /** Read the last input pi actually delivered in THIS conversation, not ambient activity.
   * Worker scope snapshots this at creation; a queued input cannot take over early. */
  private interaction(convId: string): Interaction {
    const live = this.live.get(convId);
    live?.feed.sync();
    const item = this.picture(convId)?.items.slice().reverse().find(x => x.kind === "user" && !["wake", "job", "delegate", "resume", "nudge"].includes(x.via ?? ""));
    if (item) return Object.freeze({ request: item.text ?? "", device: validDevice(item.device) });
    return Object.freeze({ request: "", device: null });
  }

  // ---------------------------------------------------------------- tools

  private async onToolCall(p: any): Promise<unknown> {
    const name = String(p?.tool ?? "");
    // A Ctrl+K / Ctrl+L side thread (p.side): only the read-only tools, as of the conversation it was opened from (or none).
    const side: { convId: string | null } | null = p?.side ?? null;
    // (Each side thread's own list is enforced in pi/side.ts: voice's Asks may also Show, an action BoardSend and the
    // notes, and both Carl's vault tools. A turn's own tools never run in a side thread.)
    if (side && agentToolSpecs().some((t) => t.name === name) && !voiceSideToolSpecs(true).some((t) => t.name === name)) return { success: false, contentItems: [{ type: "inputText", text: `${name} is not available here: this request has read-only tools.` }] };
    const convId: string = (side ? side.convId : this.byThread.get(p?.threadId) ?? this.childOf.get(p?.threadId)) ?? "";
    const vault = this.d.vault;
    const found = convId ? await readConv(vault, convId) : null;
    if (!side && (!convId || !found)) return { success: false, contentItems: [{ type: "inputText", text: "No conversation for this thread." }] };
    const conv = found ?? ({ id: "", title: "", messages: [] } as unknown as NonNullable<typeof found>);
    const a = { ...(p?.arguments ?? {}) };
    const interaction: Interaction = p.interaction ?? p.notifyScope?.interaction ?? this.interaction(convId);
    try {
      p.signal?.throwIfAborted();
      // ListProjects only reads. A project is made only by Carl: in the app, or by asking for it (OpenProject below).
      if (isContextTool(name)) return await handleContextTool(name, a, { conv: conv as any, convs: (await allConvs(vault)) as any });
      // The notes tools: the same code voice runs (server/notesTools.ts), every result read back from the file.
      if (isNoteTool(name)) {
        const r = await noteTool(vault, name, a);
        return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
      }
      // A plugin turned off or on (server/supervisorTools.ts): a record in the log every view follows.
      if (name === PLUGIN_TOOL) {
        const r = pluginTool(vault, a);
        return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
      }
      switch (name) {
        case "SubmitChange": {
          const r = await submitChangeJob({ vault, convId, byCarl: !!this.live.get(convId)?.byCarl, jobs: this.d.jobEnv }, a);
          if (r.job) this.updateSubagent(convId, r.job.id, { kind: "job", title: r.job.name, task: r.job.command.slice(0, 300), status: "running", state: "running", startedAt: r.job.startedAt, background: true, activity: "checking published branch" });
          return text(r.text);
        }
        case "AskUser": {
          const opts = Array.isArray(a.options) ? a.options.map(String).filter(Boolean).slice(0, 6) : [];
          const ans = await this.waitForAnswer(p.threadId, String(a.question ?? "").trim() || "?", opts, p.signal);
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
          if (same) return text(`A wake is already set for ${new Date(same.at).toISOString()} ("${same.reason}"); no second one was added. Wake id: ${same.id}. If a bounded continuation is active, record ContinueWork wait for this wake id, then stop; otherwise stop now. Do not schedule another wake.`);
          const wake = addWake(vault, { conv: convId, at, reason, ...(this.live.get(convId)?.byCarl ? { byCarl: true } : {}) });
          await patchMeta(vault, convId, { nextWakeAt: nextWakeFor(vault, convId) });
          return text(`Wake set for ${new Date(at).toISOString()} ("${reason}"). Wake id: ${wake.id}. If a bounded continuation is active, record ContinueWork wait for this wake id, then stop; otherwise stop now. Do not schedule another wake.`);
        }
        case "PostToConversation": {
          const target = String(a.conversation_id ?? "").trim();
          const body = String(a.text ?? "").trim();
          if (!target || !body) return text("Give conversation_id and text.");
          if (target === convId) return text("That is this chat. Answer here instead of posting to yourself.");
          const to = await readConv(vault, target);
          if (!to) return text(`No chat with id "${target}". ListConversations lists them.`);
          if (LEGACY_SOURCES.has(to.source)) return text(`"${to.title}" is an archived mission thread: it is readable, never run.`);
          // It starts a turn there the way any message does, so that chat's own
          // engine, tools and rules apply — this chat lends it nothing.
          const r = await this.message({ convId: target, text: body, via: "handoff" });
          if (r?.error) return text(`Not posted: ${String(r.error)}`);
          // A chat that is mid-turn takes it when that turn ends, as any message does.
          const waiting = r?.queued === true || r?.steered === true;
          return text(
            `Posted to "${to.title}" (${target}); it ${waiting ? "has it waiting and will take it when its current turn ends" : "is taking its own turn"}. ` +
              `It will tell Carl itself, so do not wait or report for it.`,
          );
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
          // Intent comes from the normal structured tool decision, NOT text classification.
          // Scope comes from the host's original turn/worker binding, NOT args or today's parent turn.
          const scope = p.notifyScope;
          const explicitPush = a.push === true && scope?.byCarl === true && !!scope.workId;
          const needsYou = a.needsYou === true;
          await this.d.notify({ kind: "info", title: String(a.title ?? "vault-chat").slice(0, 90), body: String(a.body ?? "").slice(0, 2000), convId, why: needsYou ? "failed" : "finished", byCarl: scope ? scope.byCarl === true : !!this.live.get(convId)?.byCarl, trigger: "Notify", ...(explicitPush ? { explicitPush: true, workId: scope.workId } : {}) });
          return text(explicitPush ? "In Carl's alerts. One event push requested for this work, subject to away/seen/dedup rules; no future alerts armed." : "In Carl's alerts. No explicit phone push requested (legacy automatic pushes apply only if Carl enabled them in Settings).");
        }
        case "BoardSend": {
          // A host-accepted make keeps its original destination/permission for
          // this entry only. An arbitrary `make` id is never authorization;
          // other deferred tools still follow the latest delivered human surface.
          const make = p.notifyScope?.boardMake;
          const ownedMake = make && a.make === make.id ? make : null;
          const origin = ownedMake?.interaction ?? interaction;
          const no = boardGuard({ vault, request: origin.request, device: origin.device, asked: ownedMake?.asked === true || a.asked === true, tool: "BoardSend" });
          if (no) return { success: false, contentItems: [{ type: "inputText", text: no }] };
          delete a.asked;
          const r = await sendEntry(vault, a, { conversation: convId, emit: (ev) => this.inboxEvent(ev) });
          if (!r.ok) return { success: false, contentItems: [{ type: "inputText", text: `Refused (nothing reached the inbox):\n- ${r.refusals.join("\n- ")}` }] };
          return text(JSON.stringify({ id: r.id, parts: r.parts }) + " — in Carl's whiteboard inbox.");
        }
        case "Lookup":
          return text(await lookupAll(vault, a));
        case "Catalog":
          return text(catalogText(pluginCatalog(vault)));
        case "BoardMake": {
          const request = String(a.request ?? "").trim();
          const title = String(a.title ?? "").trim();
          if (!request || !title) return text("BoardMake needs a request and a title.");
          const no = boardGuard({ vault, request: interaction.request, device: interaction.device, asked: a.asked === true, tool: "BoardMake" });
          if (no) return { success: false, contentItems: [{ type: "inputText", text: no }] };
          const entry = startMake(vault, { title, request }, { conversation: convId, emit: (ev) => this.inboxEvent(ev) });
          const t0 = Date.now();
          const started = this.d.backend.background(p.threadId, {
            agent: { name: "board-maker", systemPrompt: BOARD_MAKER_PROMPT, tools: ["read", "bash", "edit", "write", "BoardSend"] },
            task: boardMakeTask(entry.id, title, request),
          }, undefined, Object.freeze({ id: entry.id, interaction, asked: a.asked === true }));
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
        case "BoardLook": {
          const r = lookBoard(vault, a.board);
          return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }, ...r.images.map((im) => ({ type: "inputImage", data: im.data, mimeType: im.mimeType }))] };
        }
        case "Show": {
          // On the device he names (or is on): a signal the laptop / phone acks, or the inbox's validated send.
          // The board named by the agent, not by Carl, while he is elsewhere: refused with why (server/boardGuard.ts).
          const destination = !a.where || a.where === "here" ? interaction.device : String(a.where).trim();
          const toBoard = /^(board|ipad)$/i.test(destination ?? "");
          const no = toBoard ? boardGuard({ vault, request: interaction.request, device: interaction.device, asked: a.asked === true, tool: "Show" }) : null;
          if (no) return { success: false, contentItems: [{ type: "inputText", text: no }] };
          if ((!a.where || a.where === "here") && interaction.device === "laptop" && /\b(?:not|away from)\s+(?:near\s+)?(?:at\s+)?my\s+(?:laptop|computer)\b/i.test(interaction.request)) {
            return { success: false, contentItems: [{ type: "inputText", text: "Nothing opened: Carl said he is away from his laptop. Keep the visual in the reply or use the destination he explicitly requested." }] };
          }
          delete a.asked;
          const r = await show({ vault, device: interaction.device, emit: (ev) => this.d.broadcast?.(ev), sendBoard: (b) => sendEntry(vault, b, { conversation: convId, emit: (ev) => this.inboxEvent(ev) }), dev: (port) => this.devUrl(port) }, a);
          return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
        }
        case "DeleteConversation": {
          const ids = Array.isArray(a.ids) ? a.ids.map(String) : typeof a.ids === "string" ? [a.ids] : [];
          if (!ids.length) return text("DeleteConversation needs ids (from ListConversations).");
          const r = await this.deleteAcrossVaults(ids, convId);
          const lines = [
            r.deleted.length ? `Deleted ${r.deleted.length} (recoverable with RestoreConversation): ${r.deleted.join(", ")}` : "Nothing deleted.",
            ...r.refused.map((x) => `- ${x.id}: not deleted (${x.why})`),
          ];
          return { success: r.deleted.length > 0, contentItems: [{ type: "inputText", text: lines.join("\n") }] };
        }
        case "RestoreConversation": {
          const want = typeof a.id === "string" ? a.id.trim() : "";
          if (!want) {
            const all = this.deletedConversations();
            const when = (t: number) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "earlier");
            return text(all.length ? `Deleted chats (newest first):\n${all.slice(0, 200).map((d) => `- ${d.title} (id ${d.id}, deleted ${when(d.at)})`).join("\n")}` : "No chat is deleted.");
          }
          const r = await this.restoreAcrossVaults(want);
          return { success: r.ok, contentItems: [{ type: "inputText", text: r.ok ? `Restored chat ${want}: it is back in Carl's lists.` : `Not restored: ${r.error}.` }] };
        }
        case "RestoreProject": {
          const want = typeof a.project === "string" ? a.project.trim() : "";
          if (!want) {
            const all = listDeletedProjects();
            const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
            return text(all.length ? `Deleted projects (newest first):\n${all.map((d) => `- ${d.name} (slug ${d.slug}, entry ${d.entry}, deleted ${when(d.deletedAt)})`).join("\n")}` : "Nothing is deleted.");
          }
          const r = await this.restoreProject(want);
          return { success: !!r.ok, contentItems: [{ type: "inputText", text: r.ok ? `Restored project ${r.name}: its notes and its thread (${r.convId}) are back on his screens.` : `Not restored: ${r.error}.` }] };
        }
        case "OpenProject": {
          // Carl asked to start or work on a project: made (or found), and his screens and a live call follow to its thread.
          const r = await openProject(vault, a, { emit: (ev) => this.d.broadcast?.(ev), message: (b) => this.message(b) });
          return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
        }
        case "PdfRead": {
          const why = await this.d.backend.nativePath?.(vault, a.path);
          if (why) return { success: false, contentItems: [{ type: "inputText", text: why }] };
          return text(await pdfRead(vault, a));
        }
        case "PdfPages": {
          const why = await this.d.backend.nativePath?.(vault, a.path);
          if (why) return { success: false, contentItems: [{ type: "inputText", text: why }] };
          const answer = await pdfPagesAnswer(vault, a);
          return { ...text(answer.text), resources: answer.resources };
        }
        case "WebFetch":
          return text(await webFetch(a, p.signal));
        case "StartJob": {
          // In the thread's working folder (a project's own folder, else the vault), as its shell commands run.
          const r = startJobWith(this.d.jobEnv, this.cwdOf(conv), a, convId, !!this.live.get(convId)?.byCarl);
          // The job is a row of the background-tasks chip (kind "job": Stop, no Steer) until it ends.
          if (r.job && convId) this.updateSubagent(convId, r.job.id, { kind: "job", title: r.job.name, task: r.job.command.slice(0, 300), status: "running", state: "running", startedAt: r.job.startedAt, background: true, activity: "starting" });
          return text(r.text);
        }
        case "RecordUI":
          return text(await recordUITool(this.d.shell?.(), vault, a, { cwd: this.cwdOf(conv) }));
        case "Compact": {
          if (!convId) return text("No conversation to compact.");
          void this.compact(convId, typeof a.focus === "string" ? a.focus : undefined).then((r) => {
            if (r && r.ok === false) this.log(`compact on ${convId}: ${String(r.error)}`);
          });
          return text("Compaction starts as soon as this turn ends (the thread then shows \"Earlier conversation summarized\"). Tell Carl in one line; don't wait for it.");
        }
        case "SearchHistory": {
          const want = String(a.thread ?? "").trim();
          let target = conv.id ? conv : null;
          if (want) {
            const slug = want.toLowerCase() === "main" ? null : (await import("../context")).findProject(want)?.slug;
            if (want.toLowerCase() !== "main" && !slug) return text(`No thread "${want}": "main" or a project's name.`);
            target = await readConv(vault, slug ? `project-${slug}` : MAIN_ID);
          }
          if (!target) return text("No thread to search.");
          return text(searchHistory(vault, target, String(a.query ?? ""), Number(a.limit) || undefined));
        }
        case "RecentActivity":
          return text(searchActivity(vault, { query: typeof a.query === "string" ? a.query : "", hours: Number(a.hours) || undefined, limit: Number(a.limit) || undefined }));
        case "JobStatus":
          return text(this.workerStatus(convId, String(a.id ?? "").trim()) ?? this.withExposed(String(a.id ?? "").trim(), jobStatus(this.d.jobEnv, a)));
        case "JobList": {
          const workers = this.workerList(convId);
          const jobs = jobList(this.d.jobEnv, convId, a.all === true);
          return text(workers ? `Background workers:\n${workers}\n\nShell jobs (StartJob):\n${jobs}` : jobs);
        }
        case "JobStop": {
          const id = String(a.id ?? "").trim();
          if (this.workerRec(convId, id)) {
            const r = await this.d.backend.subagentControl(id, "stop");
            return text(r.ok ? `Stopping worker ${id}; its "Delegated work failed (stopped)" turn follows.` : `Not stopped: ${r.error ?? "it is not running"}.`);
          }
          const out = jobStop(this.d.jobEnv, id, convId);
          if (/^Stopped job /.test(out)) {
            this.jobRowEnded(convId, id, "stopped");
            this.devSweep();
          }
          return text(out);
        }
        case "JobSteer": {
          const id = String(a.id ?? "").trim();
          const message = String(a.message ?? "").trim();
          if (!this.workerRec(convId, id)) return text(`No background worker ${id} in this conversation (JobList shows them).`);
          if (!message) return text("JobSteer needs a message.");
          const r = await this.d.backend.subagentControl(id, "steer", message);
          return text(r.ok ? `Passed to worker ${id}; it takes it up after its current step.` : `Not passed: ${r.error ?? "it is not running"}.`);
        }
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
            const pc = projectCost(String(a.project), (await allConvs(vault, { withDeleted: true })) as any);
            return text(pc ? `Project ${pc.name}: $${pc.totalUsd.toFixed(4)} over ${pc.parts.length} conversation(s)${pc.missingCalls ? ` (${pc.missingCalls} call(s) without a cost)` : ""}.` : `No project "${a.project}".`);
          }
          const target = a.conversation ? await readConv(vault, String(a.conversation)) : conv.id ? conv : null;
          if (!target) return text(`No conversation ${a.conversation}.`);
          return text(`Conversation "${target.title}": $${(target.costUsd ?? 0).toFixed(4)}${target.costMissingCalls ? ` (+${target.costMissingCalls} call(s) without a cost)` : ""}. (Costs land a few seconds after each turn.)`);
        }
        default: {
          // One of Carl's own vault tools (.vault-chat/tools), run in the command sandbox.
          const out = await runVaultTool(vault, this.d.shell?.(), name, a);
          if (out !== null) return { success: !/^(Error|exit \d|\(timed out\))/.test(out), contentItems: [{ type: "inputText", text: out }] };
          return { success: false, contentItems: [{ type: "inputText", text: `Unknown tool ${name}.` }] };
        }
      }
    } catch (e) {
      return { success: false, contentItems: [{ type: "inputText", text: `${name} failed: ${(e as Error).message}` }] };
    }
  }

  /** An inbox change on /poll (the iPad's badge); a landed entry (or a make that failed) is one short line a live call
   *  says at its next real gap (server/voiceBrain.ts announce). */
  private inboxEvent(ev: InboxEvent): void {
    const say = ev.landed ? `"${ev.title}" is in your board inbox.` : ev.failed ? `I couldn't make "${ev.title}": ${ev.failed}.` : "";
    this.d.broadcast?.({ ...ev, ...(say ? { say } : {}) });
    if (say) void import("../voiceBrain").then((v) => v.announce(this.d.vault, say)).catch(() => {});
  }


  /** Park the turn on a question until Carl answers (via /message, /answer or an answer intent). */
  private async waitForAnswer(threadId: string, question: string, options: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const convId = this.byThread.get(threadId) ?? this.childOf.get(threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (!convId || !l) return "No one is available to answer right now. Continue with your best judgement and say what you assumed.";
    if (l.ask) return "A question is already waiting for Carl. Do not ask another concurrently.";
    const vault = this.d.vault;
    l.asks++;
    const itemId = `${l.turnId}:ask:${l.asks}`;
    const p = new Promise<string>((resolve) => {
      l.ask = { resolve, question, itemId };
    });
    this.emit(convId, { type: "meta", patch: { asking: { question, options, at: Date.now() }, state: "waiting_user" } });
    const cancel = () => {
      if (l.ask?.itemId !== itemId) return;
      l.ask.resolve("");
      l.ask = null;
      this.emit(convId, { type: "meta", patch: { asking: null, state: "running" } });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const conv = await readConv(vault, convId);
      signal?.throwIfAborted();
      // Buzz only while this exact question is still open.
      await this.d.notify({ kind: "ask", title: (conv?.title ? `Needs your answer: ${conv.title}` : "Needs your answer").slice(0, 90), body: question, convId, options, why: "ask", trigger: "AskUser", stillNeeded: () => this.live.get(convId)?.ask?.itemId === itemId });
      const answer = await p;
      signal?.throwIfAborted();
      return answer;
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  /** Carl's answer: his message (under his client's id), the question closed, the turn resumed (or a new one). */
  private async answer(convId: string, answer: string, clientId: string = newMessageId()): Promise<void> {
    const l = this.live.get(convId);
    const ask = this.picture(convId)?.meta.asking ?? null;
    // His line is the question's result pi writes ("Carl answered: …"), under his client's id.
    if (l?.ask) l.feed.answered(clientId);
    this.emit(convId, { type: "meta", patch: { asking: null, state: l?.ask ? "running" : "idle" } });
    // The question's card in the phone feed is answered too, however the answer came in.
    if (this.markAsksAnswered(convId, answer)) this.d.broadcast?.({ type: "notif" });
    if (l?.ask) {
      const a = l.ask;
      l.ask = null;
      a.resolve(answer);
      return;
    }
    // The turn that asked is gone (a restart): a new turn carries the answer. A proof card's answer is acted on
    // here first (Keep is the server's merge, never the agent's), and the new turn says what was done.
    const q = ask?.question;
    const review = pendingReview(this.d.vault, convId);
    if (review) {
      const out = await answerReview(this.d.vault, review, answer);
      void this.run(convId, `Carl's answer to your hand-over of ${review.branch}: ${answer}. ${out.text}`, "user", { clientId, shown: answer, via: "answer" });
      return;
    }
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


  // ---------------------------------------------------------------- wakes and jobs

  private async tickWakes(): Promise<void> {
    if (shuttingDown) return;
    // Out of headroom on Carl's subscription: a wake is work the host starts by
    // itself, so it waits for the reset rather than burning a rejected call. The
    // wake is left where it is, so it fires once there is room again.
    const limit = this.d.backend.usageLimit?.();
    if (limit) {
      if (Date.now() - this.saidLimitAt > 10 * 60_000) {
        this.saidLimitAt = Date.now();
        this.log(`usage limit reached${limit.kind ? ` (${limit.kind})` : ""}: wakes wait${limit.resetsAt ? ` until ${new Date(limit.resetsAt).toISOString()}` : ""}`);
      }
      return;
    }
    const now = Date.now();
    const due = readWakes(this.d.vault).filter((w) => w.at <= now && !this.firing.has(w.id));
    for (const w of due) {
      const l = this.live.get(w.conv);
      if (l?.ask) continue; // waiting on Carl: the wake waits too
      // Held for the limit, and a turn is running (Carl wrote after the reset): that turn has it all.
      if (w.limit && l && !l.finished) continue;
      this.firing.add(w.id);
      removeWakes(this.d.vault, (x) => x.id === w.id);
      void this.fireWake(w).finally(() => this.firing.delete(w.id));
    }
  }

  private async fireWake(w: Wake): Promise<void> {
    const conv = await readConv(this.d.vault, w.conv);
    if (!conv) return;
    await patchMeta(this.d.vault, w.conv, { nextWakeAt: nextWakeFor(this.d.vault, w.conv) ?? undefined });
    this.log(`wake ${w.id} → ${w.conv}: ${w.reason}`);
    if (w.limit) {
      await this.run(w.conv, LIMIT_TEXT, "resume", { byCarl: !!w.byCarl, shown: LIMIT_SHOWN, ownTurn: true, limitTries: w.limit.tries }).catch((e) => this.log(`limit retry failed: ${e}`));
      return;
    }
    await this.run(w.conv, `Wake: ${w.reason}`, "wake", { byCarl: !!w.byCarl, pushWorkId: w.id, ownTurn: true, completion: { kind: "wake", id: w.id } }).catch((e) => this.log(`wake failed: ${e}`));
  }

  /** A job that ended wakes the conversation that started it. */
  async tickJobs(): Promise<void> {
    if (shuttingDown) return;
    let ended: ReturnType<typeof reapJobs> = [];
    try {
      ended = reapJobs(this.d.jobEnv);
    } catch (e) {
      this.log(`jobs: ${(e as Error).message}`);
    }
    if (ended.length) this.devSweep();
    this.jobActivity();
    this.closeDeadWorkerRows();
    for (const j of ended) {
      this.log(`job ${j.id} ended: ${j.state}${j.exit !== undefined ? ` (exit ${j.exit})` : ""}`);
      if (j.conv) this.jobRowEnded(j.conv, j.id, j.state === "finished" && j.exit === 0 ? "completed" : j.state === "stopped" ? "stopped" : "failed", j.state === "finished" ? `exit ${j.exit}` : j.state);
      if (!j.conv) continue;
      const conv = await readConv(this.d.vault, j.conv);
      if (!conv) continue;
      const how =
        j.state === "finished" ? `finished: exit ${j.exit}` : j.state === "timeout" ? "was stopped by its time limit" : j.state === "stopped" ? "was stopped" : "ended without an exit code (stopped, or killed: out of memory?)";
      const tail = j.tail.split("\n").slice(-30).join("\n").slice(-3000);
      // Concurrent job ends belong in the running turn's native follow-up queue,
      // not a second turn. Keep the trusted identity on that delivery as well.
      void this.run(j.conv, `Job ${j.id} ${how}.\n--- last output ---\n${tail || "(none)"}`, "wake", { byCarl: !!j.byCarl, pushWorkId: j.id, completion: { kind: "job", id: j.id } }).catch((e) => this.log(`job wake ${j.conv}: ${e}`));
    }
  }

}

function errText(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message ?? JSON.stringify(e)).slice(0, 500);
}


function validDevice(device: unknown): Interaction["device"] {
  return device === "laptop" || device === "phone" || device === "board" ? device : null;
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

