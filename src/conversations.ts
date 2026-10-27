import type { ChatMessage } from "./store";

export type ConversationSource =
  | "manual"
  | "scheduled"
  | "voice"
  | "phone"
  // One main conversation (src/threads.ts): Main and a project's thread.
  | "main"
  | "project"
  | "worker"
  // A mission thread: the dedicated supervisor that owns one user-approved
  // goal — it spawns and monitors that goal's workers and reports by Notify.
  // Created deterministically when the user approves a proposed mission (no
  // agent mints one); it lives on the Activity surface, not the chats list.
  | "mission"
  // [ask redesign] A notification's OWN conversation — minted when an AskUser
  // fires (and lazily for an info alert the user follows up on). Isolated from
  // the mission thread by construction (the spillover fix): the user talks to a
  // dedicated ask agent here; option cards relay the decision to the waiting
  // mission via the tagged /answer path. Lives behind the alert card, not the
  // chats list.
  | "ask";
export type ConversationStatus = "idle" | "running";

// [harness v2] Explicit mission lifecycle, replacing the old implicit
// (derived-from-fields) state. Transitions are stamped in code at the choke
// points: mint→RUNNING, AskUser(money/irreversible fork)→AWAITING_USER (sticky
// until a genuine user reply), CompleteMission→DONE, StopMission→KILLED. Gated
// behind harnessV2Enabled(); legacy readers ignore an unknown field harmlessly.
// (No VERIFYING state: verification gates run synchronously inside
// markDoneWhen/completeMission, so there is never a moment it would describe.)
export type MissionState =
  | "PLANNING"
  | "RUNNING"
  | "AWAITING_USER"
  | "DONE"
  | "KILLED";

// One advisory auditor verdict on a mission (see Conversation.audits).
// pass: true/false = the auditor's judgment; null = the auditor could not run
// (no model, timeout, error) — recorded so "unaudited" is visible, not hidden.
export type MissionAudit = {
  at: number;
  by: "MarkDoneWhen" | "CompleteMission";
  criterion: string;
  pass: boolean | null;
  reason?: string;
  evidence?: string;
};

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  status: ConversationStatus;
  createdAt: number;
  lastActivityAt: number;
  source: ConversationSource;
  unread: boolean;
  // Special roles. "supervisor" threads get the vault's supervisor.md
  // orchestrator prompt on every turn (the phone app's Supervisor button
  // binds to the one conversation carrying this).
  role?: "supervisor";
  // The North Star this thread serves. Workers are never standalone: every
  // one belongs to a mission (the user-approved goal that spawned it), and
  // surfaces group workers under their mission. Set on source "worker" (the
  // mission it serves) and on source "mission" (its own title — the group key
  // its workers share).
  mission?: string;
  // Phone-presentation summaries (Mode A of the cockpit transform layer). At
  // each worker/mission turn completion a fast model distills the thread into
  // two clean one-liners: what it was asked to do (`taskSummary`) and what it's
  // doing / has done now (`statusSummary`). The Activity surface shows these
  // instead of a raw slice of the task input. `summaryRev` is the message count
  // they were computed at, so an unchanged thread isn't re-summarized.
  taskSummary?: string;
  statusSummary?: string;
  summaryRev?: number;
  // Mode B of the cockpit transform: a short, Haiku-cleaned digest of the
  // thread's THINKING — what the worker/supervisor reasoned through and why —
  // for the Activity detail view. Cleaned, not the raw rambling chain. Computed
  // at turn completion alongside the summaries above.
  thinkingDigest?: string;
  // When a mission is finished, its supervisor stamps this (via CompleteMission).
  // A completed mission drops off the Activity page — the missing terminal state
  // that left done missions lingering for 48h. The thread is kept (not deleted)
  // so the user can still open the finished mission; it just leaves the surface.
  completedAt?: number;
  // The "Done when" criteria the supervisor has VERIFIED met so far (matched to
  // the brief's bullets). Drives per-criterion checkoff in the mission spec, so
  // the user watches progress accrue one bullet at a time — set via MarkDoneWhen.
  doneWhenDone?: string[];
  // When the CURRENT run for this thread began (epoch ms), stamped on the
  // idle→running edge and cleared when the run ends. This is the single source
  // of truth for the "thinking" elapsed clock: it counts from when the prompt
  // was sent and stays continuous across leave/return, reload, and phone↔desktop
  // — NOT from when the thread was last opened. Lives on the Conversation (not a
  // transient view buffer) so EVERY source — manual, voice, mission, worker,
  // phone, scheduled — gets a correct clock for free.
  runStartedAt?: number;
  // The user has OPENED this thread at least once, so it earns a spot in the
  // recent-conversations list even when it'd normally be hidden there. Mission
  // and worker threads live on the Activity surface and stay OUT of the phone's
  // recent/Chats list by default; the moment you view one it flips surfaced and
  // joins recent so you can get back to it. Set on open from either surface and
  // synced, so viewing a worker on the phone also surfaces it on the desktop.
  surfaced?: boolean;
  // [harness v2] Explicit mission lifecycle state (see MissionState). Only set on
  // source "mission" threads.
  missionState?: MissionState;
  // Model spend on THIS thread so far, in USD: the sum of OpenRouter's
  // server-reported `usage.cost` over every model call its turns made
  // (including mid-run compaction and sub-agents). Each assistant message also
  // carries its own turn's `costUsd`. A mission's total = this + its workers'
  // + its ask threads' (see computeMissionCost).
  costUsd?: number;
  // Model calls whose response carried no cost (direct-provider keys, or an
  // OpenRouter response without usage) — so a total is never silently partial.
  costMissingCalls?: number;
  // [completion gate] The evidence auditor's verdicts. ADVISORY: recorded for
  // the user to see, never blocking — MarkDoneWhen checks a criterion off and
  // CompleteMission completes (with evidence) whatever the auditor says.
  audits?: MissionAudit[];
  // [ask redesign] Set on source "ask" threads only. `askOf` points at the
  // conversation the notification came FROM (the mission whose supervisor is
  // waiting — the deterministic relay target); `askNotifId` is the notification
  // this thread belongs to. Once the user commits a decision, `askDecided` +
  // `askDecidedAt` record WHAT was decided and when — the receipt for the
  // Archive card. [unified ask] The thread stays TALKABLE after (deciding
  // records the call, it does not close the conversation).
  askOf?: string;
  askNotifId?: string;
  askDecided?: string;
  askDecidedAt?: number;
  // [ask-object] Auto-defer (Stage 4b): the declared fallback + stakes + the
  // deadline after which an UNANSWERED low-stakes ask self-defers ("Not now" on
  // the user's behalf, resuming the mission on its onDefer branch). Only set
  // when the ask opted in with a timeout; a high-stakes ask never carries a live
  // deadline (only the user may end it).
  askStakes?: "low" | "high";
  askOnDefer?: string;
  askDeadlineAt?: number;
  // [engine, Phase 2] The box's engine (pi): the thread behind this
  // conversation, its project, keep-going mode, wake and lifecycle state, an
  // open question, the Done verifier's verdict and a roll-over recap.
  threadId?: string;
  threadPath?: string;
  project?: string;
  working?: boolean;
  nextWakeAt?: number;
  state?: "idle" | "running" | "sleeping" | "waiting_user" | "blocked" | "done";
  pendingAsk?: { question: string; options?: string[]; at: number; notifId?: string };
  // [box] Messages Carl sent while a turn ran, not delivered by pi yet (the log's pending): a steer, or queued.
  queued?: { id: string; text: string; kind?: "steer" | "queue" }[];
  verdict?: { verdict: "pass" | "fail" | "unsure"; notes: string[]; at: number; summary?: string };
  recap?: string;
  // Subagents this conversation spawned (children: task, model, state, cost; for later display).
  /** kind "job": a StartJob job (a dev server, a build): Stop, no Steer. */
  subagents?: { threadId: string; kind?: string; prompt?: string; task?: string; title?: string; expect?: "short" | "long"; background?: boolean; agent?: string; model?: string; status?: string; state?: string; costUsd?: number; startedAt?: number; endedAt?: number; path?: string; sessionFile?: string; summary?: string; toolCallId?: string; activity?: string; steps?: number; said?: string; activityAt?: number }[];
  // The agent's to-do list for this conversation (TodoWrite, box and laptop).
  todos?: import("./store").TodoItem[];
  // [box mode, in memory] The box model's context window (for the dial).
  contextWindow?: number;
  // One main conversation (src/threads.ts): "main" | "project" | "separate"; none: an older chat (archived, read-only).
  kind?: string;
  // Carl cleared this thread's view and the box is still saving and compacting behind it.
  clearing?: boolean;
};


export function newConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 12);
  }
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Stable per-MESSAGE id, minted at creation. Foundation (release 1) of the
// message-identity cure: once every new message carries a `mid`, a later release
// can dedupe by id and replace the fragile "longer array wins" merge with an
// id-aware, compaction-watermark-bounded merge — without which duplicates can't
// be told apart from real repeats. INERT for now: nothing reads `mid` yet, it
// just rides on disk (Rust reconstruct/write_all are JSON passthroughs, so it
// survives), propagating to every machine before any merge logic depends on it.
export function newMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 12);
  }
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyConversation(): Conversation {
  const now = Date.now();
  return {
    id: newConversationId(),
    title: "New chat",
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivityAt: now,
    source: "manual",
    unread: false,
  };
}


export function deriveConversationTitle(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user" || m.hidden) continue;
    const trimmed = (m.content ?? "").trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/)[0]!;
    return firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57) + "…";
  }
  return "New chat";
}

export function conversationPreview(c: Conversation): string {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.hidden) continue;
    const text = (m.content ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    return text.length <= 120 ? text : text.slice(0, 117) + "…";
  }
  return "";
}

// Threads from the old missions system (supervisor, workers, ask threads).
// The system is gone; the threads stay as read-only history ("Archived
// missions" at the bottom of the chat list).
const ARCHIVED_SOURCES: ReadonlySet<string> = new Set(["mission", "worker", "ask"]);
export function isArchivedThread(c: { source: string }): boolean {
  return ARCHIVED_SOURCES.has(c.source);
}
export const ARCHIVED_THREAD = "Archived mission thread — read only. Start a new chat to go on.";

/** An older chat from before one main conversation (src/threads.ts): kept readable, not continued here. */
export const OLDER_CHAT = "An older chat — read only. Main and your projects carry on from the left panel.";
