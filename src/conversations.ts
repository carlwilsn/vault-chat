import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./store";

export type ConversationSource =
  | "manual"
  | "scheduled"
  | "voice"
  | "phone"
  | "worker"
  // A mission thread: the dedicated supervisor that owns one user-approved
  // goal — it spawns and monitors that goal's workers and reports by Notify.
  // Created deterministically when the user approves a proposed mission (no
  // agent mints one); it lives on the Activity surface, not the chats list.
  | "mission";
export type ConversationStatus = "idle" | "running";

// [harness v2] Explicit mission lifecycle, replacing the old implicit
// (derived-from-fields) state. Transitions are stamped in code at the choke
// points: mint→RUNNING, AskUser(money/irreversible fork)→AWAITING_USER,
// verify→VERIFYING, CompleteMission→DONE, StopMission→KILLED. Gated behind
// harnessV2Enabled(); legacy readers ignore an unknown field harmlessly.
export type MissionState =
  | "PLANNING"
  | "RUNNING"
  | "AWAITING_USER"
  | "VERIFYING"
  | "DONE"
  | "KILLED";

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
  // they were computed at, so an unchanged thread isn't re-summarized. These
  // MUST be carried through readConversations (below) or they're stripped on
  // every read-modify-write — the same load-bearing trap as `mission`.
  taskSummary?: string;
  statusSummary?: string;
  summaryRev?: number;
  // Mode B of the cockpit transform: a short, Haiku-cleaned digest of the
  // thread's THINKING — what the worker/supervisor reasoned through and why —
  // for the Activity detail view. Cleaned, not the raw rambling chain. Computed
  // at turn completion alongside the summaries above; carried through
  // readConversations (below) like the rest.
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
  // phone, scheduled — gets a correct clock for free. Carried through
  // readConversations (below) like the other load-bearing fields.
  runStartedAt?: number;
  // The user has OPENED this thread at least once, so it earns a spot in the
  // recent-conversations list even when it'd normally be hidden there. Mission
  // and worker threads live on the Activity surface and stay OUT of the phone's
  // recent/Chats list by default; the moment you view one it flips surfaced and
  // joins recent so you can get back to it. Set on open from either surface and
  // synced, so viewing a worker on the phone also surfaces it on the desktop.
  surfaced?: boolean;
  // [harness v2] Explicit mission lifecycle state (see MissionState). Only set on
  // source "mission" threads. Like every other optional field on this type it
  // MUST be carried through readConversations below or it's silently stripped on
  // every append — the same load-bearing trap documented on `mission`.
  missionState?: MissionState;
  // [harness v2] True while this mission owns a live billing resource (a rented
  // GPU box). The deterministic cost guard (runWatcher) reads this so a mission
  // that has gone idle while still billing auto-terminates without an LLM turn.
  billing?: boolean;
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

export async function readConversations(vault: string): Promise<Conversation[]> {
  // Conversations live in the vault on local disk; git auto-sync
  // propagates them across machines.
  const lines = await invoke<string[]>("conversations_read", { vault });
  const out: Conversation[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Conversation;
      if (!parsed || typeof parsed.id !== "string") continue;
      // Normalize legacy / partial entries. `running` state never
      // survives a restart — anything mid-run when the app died is
      // back to idle now.
      out.push({
        id: parsed.id,
        title: parsed.title ?? "New chat",
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        status: "idle",
        createdAt: parsed.createdAt ?? Date.now(),
        lastActivityAt: parsed.lastActivityAt ?? parsed.createdAt ?? Date.now(),
        source: parsed.source ?? "manual",
        unread: parsed.unread ?? false,
        role: parsed.role,
        // The North Star tag MUST survive read-modify-write. Dropping it here
        // was a load-bearing bug: every message a worker/mission appended ran
        // through this read and stripped `mission`, so (a) Activity could no
        // longer group workers under their mission, and (b) after a reload a
        // mission's own tag was gone, so StartWorker's inheritance came up empty
        // and refused — the supervisor could spawn no workers at all.
        mission: parsed.mission,
        // Carry the presentation summaries through read-modify-write (same
        // load-bearing reason as `mission` — drop them and every appended
        // worker turn would strip the Activity surface back to raw slices).
        taskSummary: parsed.taskSummary,
        statusSummary: parsed.statusSummary,
        summaryRev: parsed.summaryRev,
        thinkingDigest: parsed.thinkingDigest,
        completedAt: parsed.completedAt,
        doneWhenDone: parsed.doneWhenDone,
        // Carry the run-start through read-modify-write so a thread that's
        // running on the active box still surfaces a correct elapsed clock on
        // another surface (phone / second machine). Status is forced idle on a
        // cold load, so a stale value here is harmless — the clock only renders
        // while the in-memory run is live.
        runStartedAt: parsed.runStartedAt,
        // Whether the user has viewed this thread (promotes it into recent).
        surfaced: parsed.surfaced,
        // [harness v2] Carry the mission lifecycle state + billing flag through
        // read-modify-write (same load-bearing trap as `mission` above — drop
        // them and every appended turn resets a mission's state/billing on disk).
        missionState: parsed.missionState,
        billing: parsed.billing,
      });
    } catch {
      // skip
    }
  }
  return out;
}

export async function writeConversations(
  vault: string,
  conversations: Conversation[],
): Promise<void> {
  // Persist messages, not in-flight stream state. The `status` field is
  // forced to 'idle' on read anyway.
  const lines = conversations.map((c) => JSON.stringify(c));
  await invoke("conversations_write_all", { vault, lines });
}

// Serialize read→modify→write cycles on the conversations store. write_all
// rewrites each conversation file from whatever the caller read, so two
// concurrent cycles interleave as lost updates ("0-message worker threads", a
// dropped mission brief, truncated worker logs). This lock is SHARED across
// every writer — the background runs in offVaultRun AND the store's debounced
// autosave — so a stale in-memory snapshot can't clobber a richer disk copy a
// background run just appended. Lives here (not offVaultRun) so the store can
// import it without a circular dependency.
let convChain: Promise<unknown> = Promise.resolve();
export function withConvLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = convChain.then(fn, fn);
  convChain = run.catch(() => undefined);
  return run;
}
