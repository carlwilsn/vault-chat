/* ---- types -------------------------------------------------------------
   Ambient (global) types for the phone app: this file has no imports or
   exports, so its top-level `interface Window` augments the real global
   Window. Moved verbatim from phone.html's phone-ts block. ------------- */

interface Window {
  /** mock: re-arm the supervisor working->idle auto-play (see installMock) */
  __m1seq?: number;
  /** mock: re-arm the two-lane chat auto-play */
  __chatSeq?: number;
  /** iOS Safari's prefixed AudioContext */
  webkitAudioContext?: typeof AudioContext;
  /** preview harness: the scenario's MockDB (see mock.ts) */
  __VC_PREVIEW_DB__?: MockDB;
  /** preview: play the scripted box's next step (mock.ts) */
  __vcPhoneNext?: () => boolean;
  /** preview: what the page sent to the scripted box */
  __vcPhonePosts?: { url: string; method: string; body: any }[];
  /** KaTeX auto-render (bundled; set in main.tsx) */
  renderMathInElement?: (el: Element, opts?: unknown) => void;
}

interface Navigator {
  /** iOS PWA standalone flag */
  standalone?: boolean;
}

/** One conversation row from /conversations. voice_server.rs
    conversations_summary_json hand-picks these fields, so a new field the
    phone needs must be added there too. */
interface ConvSummary {
  id: string;
  title?: string;
  /** mission | worker | phone | manual | scheduled */
  source?: string;
  role?: string;
  mission?: string;
  goal?: string;
  preview?: string;
  msgCount?: number;
  lastActivityAt?: number;
  completedAt?: number | null;
  missionState?: string;
  taskSummary?: string;
  statusSummary?: string;
  thinkingDigest?: string;
  doneWhenDone?: string[];
  /** Phase 3: the project slug and the ongoing-work fields (server/phoneData.ts). */
  project?: string;
  state?: string;
  nextWakeAt?: number;
  costUsd?: number;
  wakeReason?: string;
}

/** A live run from /status (heartbeat-backed — the Activity board's truth;
    never gate live UI on /conversation status, it reads idle on disk). */
interface RunInfo {
  convId: string;
  title?: string;
  mission?: string;
  source?: string;
  lastTool?: string;
  lastProgressAt?: number;
}

interface ScheduleItem {
  id: string;
  name?: string;
  prompt?: string;
  label?: string;
  enabled?: boolean;
  lastFiredAt?: number;
  quietUnlessAlert?: boolean;
}

interface DeliberationOption {
  answer: string;
  title?: string;
  body?: string;
  primary?: boolean;
}

/** The redesigned AskUser: a decision + verbose option cards picked inline,
    plus an optional sample exchange for "talk it through". */
interface Deliberation {
  mission?: string;
  ask?: string;
  askLong?: string;
  options?: DeliberationOption[];
  exchange?: { role: string; text: string }[];
}

/** A feed item from /notifications — kind "ask" needs a reply, "info" is FYI. */
interface NotifItem {
  id: string;
  ts?: number;
  kind?: string;
  title?: string;
  intention?: string;
  icon?: string;
  cls?: string;
  summary?: string;
  body?: string;
  convId?: string;
  read?: boolean;
  answeredWith?: string;
  answeredAt?: number;
  deliberation?: Deliberation;
  /** the ask's own conversation (mock) */
  askConvId?: string;
  readAt?: number;
  followupConvId?: string;
}

/** An in-app note (notes.jsonl behind /notes). */
interface NoteItem {
  id: string;
  status?: string;
  timestamp?: string;
  last_updated?: string;
  title?: string | null;
  user_draft?: string;
  turns?: unknown[];
  anchors?: unknown[];
}

/** One step of a finished turn's cleaned timeline (message.timeline.steps). */
interface TimelineStep {
  thought?: string;
  action?: string;
  snag?: boolean;
}

interface ThreadMsg {
  role: string;
  content: string;
  tools?: string[];
  timeline?: { steps: TimelineStep[]; reply?: string };
  /** direct reply to a user-typed message — rendered as prose, never the thought-chain */
  direct?: boolean;
  /** an ask's recorded decision reply (the /answer path) */
  decision?: boolean;
  /** an ask turn's inline options */
  askOptions?: DeliberationOption[];
  hidden?: boolean;
  system?: boolean;
  /** server/phoneData.ts phoneExtras */
  thinking?: string;
  costUsd?: number;
  context?: number;
  window?: number;
  divider?: string;
  spawns?: string[];
  images?: string[];
  failed?: boolean;
}

interface ChatThread {
  id: string;
  title?: string;
  source?: string;
  status?: string;
  /** an ask thread: the mission it asks for, and its notification */
  askOf?: string;
  askNotifId?: string;
  messages: ThreadMsg[];
}

/** A live event from /poll (also what the mock's auto-play emits). */
interface PollEvent {
  type: string;
  convId?: string;
  text?: string;
  tool?: string;
  /** The live tool's path/command, shown beside its name (src/convDiff.ts). */
  toolArg?: string;
  steps?: TimelineStep[];
  status?: string;
  /** two-lane chat lifecycle: start | stream | end (coder: + activity) */
  phase?: string;
  /** coder live turn: which Talk-to-Claude thread this frame belongs to */
  thread?: string;
  /** coder activity pill: short label for the tool target */
  label?: string;
  /** coder end frame: the full result object (reply, ctx, cost, …) */
  result?: { reply?: string; [k: string]: unknown };
  startedAt?: number;
  /** message events carry the persisted turn inline */
  role?: string;
  content?: string;
  tools?: string[];
  title?: string;
  /** message events: an ask turn's inline options and decision flag */
  askOptions?: DeliberationOption[];
  decision?: boolean;
  /** message events: a system line, the reply's thinking and cost, a
      summarized-earlier divider's summary, the subagents it spawned, images */
  system?: boolean;
  thinking?: string;
  costUsd?: number;
  divider?: string;
  spawns?: string[];
  images?: string[];
  /** runtime events: the reply in pieces (src/streamWire.ts), the thinking's
      tail, the live context size and the model's window */
  offset?: number;
  delta?: string;
  len?: number;
  reasoning?: string;
  context?: number;
  window?: number;
}

/** The mock box (?mock=1) — fixture data behind a stubbed fetch. */
interface MockDB {
  vault: string;
  model: string;
  convs: ConvSummary[];
  runs: RunInfo[];
  schedules: ScheduleItem[];
  notifs: NotifItem[];
  notes: NoteItem[];
  threads: Record<string, ChatThread>;
  notifClearTs?: number;
  /** The vault's projects (GET /projects). */
  projects?: Array<{ slug: string; name: string }>;
  /** Projects deleted in the mock (restoreProject puts them back). */
  deletedProjects?: Array<{ slug: string; name: string }>;
  /** The box's other vaults (GET /api/v1/vaults lists them; ?vault=<name> shows one). */
  vaults?: Record<string, Partial<MockDB>>;
  /** preview: localStorage entries set before the page reads them (the UI choices) */
  ls?: Record<string, string>;
  /** preview: a scripted box — each __vcPhoneNext() applies one step and
      delivers its poll events (like the desktop's boxNext) */
  script?: PhoneStep[];
}

interface PhoneStep {
  events?: PollEvent[];
  /** messages the box now has at the end of a thread */
  append?: Record<string, ThreadMsg[]>;
  /** thread-level fields (state, verdict, todos, subagents, costUsd …) */
  meta?: Record<string, Record<string, unknown>>;
  runs?: RunInfo[];
}
