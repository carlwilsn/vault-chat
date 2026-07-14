// Phone chat host. The box runs vault-chat 24/7; the embedded server
// (src-tauri/src/voice_server.rs) serves the /phone PWA and relays its
// traffic here over the same reqId machinery phone voice uses. This module:
//
//   • runs phone messages as background agent turns (parallel to the
//     foreground, never steals desktop focus) with queue-then-auto-run
//     semantics when the target thread is mid-run — the Telegram
//     "message absorbed, no reply until you text again" hole doesn't exist
//     on this surface;
//   • forwards store diffs (streaming text, new messages, status flips) to
//     the phone's SSE stream via phone_broadcast;
//   • answers /status from the heartbeat file + run registry — a glance,
//     not a model turn;
//   • implements Web Push entirely with WebCrypto (RFC 8291 aes128gcm +
//     VAPID ES256). Rust only stores subscriptions and does the raw POST,
//     so push costs zero new native dependencies.
//
// Phone-sourced runs use the desktop default model, NOT the cheap Telegram
// brain — the phone page is a full-fidelity surface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore, type ChatMessage } from "./store";
import { abortRun, activeRuns } from "./runRegistry";
import { emptyConversation, deriveConversationTitle, type Conversation } from "./conversations";
import { isCrashBubble } from "./errfmt";
import { twoLaneMissionChatEnabled } from "./harness";

const STREAM_TAIL = 6_000;
const MSG_CAP = 20_000;

function respond(reqId: string, result: unknown): void {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  void invoke("voice_tool_respond", { reqId, result: s }).catch(() => {});
}

function broadcast(event: Record<string, unknown>): void {
  void invoke("phone_broadcast", { json: JSON.stringify(event) }).catch(() => {});
}

// ---- inbound: run a phone message ----

// Messages that arrived while their thread was mid-run. Flushed (joined into
// one turn) the moment the run ends — see the status-flip handler below.
const queued = new Map<string, string[]>();

// Worker conversation ids we've already sent a "worker done" notification for.
// A worker runs many turns (initial + AskWorker kicks + duplicate wakes), each
// ending → onRunEnded; without this, a single worker pinged the user several
// times (the old 5x "Worker finished — …" spam). Dedupe so each worker notifies
// exactly once. In-memory is enough: after a box restart a finished worker has
// no live run to end, so it can't re-fire.
const notifiedWorkers = new Set<string>();

// Coalesce identical (title, body) notifications fired within this window. The
// dark-alarm triple-fires the same record within one second (two scheduler
// loops + path-variant vault keys), and parallel worker-done events arrive as
// separate pings; both collapse to one feed entry here. In-memory is enough —
// the box is the sole active writer, so this Map sees every real notify().
const NOTIF_COALESCE_MS = 60_000;
const recentNotifs = new Map<string, number>(); // dedup-key -> last ts
function isDuplicateNotif(key: string, now: number): boolean {
  const prev = recentNotifs.get(key);
  if (prev !== undefined && now - prev < NOTIF_COALESCE_MS) return true;
  recentNotifs.set(key, now);
  // Cheap bounded sweep: evict stale keys so the map stays small.
  if (recentNotifs.size > 64) {
    for (const [k, t] of recentNotifs) {
      if (now - t >= NOTIF_COALESCE_MS) recentNotifs.delete(k);
    }
  }
  return false;
}

function isThreadBusy(conv: Conversation): boolean {
  const s = useStore.getState();
  return (
    conv.status === "running" ||
    (s.activeConversationId === conv.id && s.busy)
  );
}

// Idempotency for phone sends. The phone tags each send with a clientMsgId; a
// flaky network or the PWA service worker can deliver the same POST twice, and
// for a NEW chat each delivery would otherwise mint a fresh conversation and
// re-run the message (the "my message got sent twice" bug). Collapse duplicate
// ids to a single execution: a concurrent or slightly-later duplicate awaits and
// returns the FIRST call's result (same convId), so the user gets exactly one
// turn. Successful results linger briefly so a late retry still dedupes; an
// error result is evicted at once so a genuine retry can re-attempt.
const inflightSends = new Map<string, Promise<Record<string, unknown>>>();
function dedupedPhoneMessage(
  clientMsgId: string | undefined,
  convId: string | null,
  text: string,
  supervisor: boolean,
  answer = false,
): Promise<Record<string, unknown>> {
  if (!clientMsgId) return handlePhoneMessage(convId, text, supervisor, answer);
  const existing = inflightSends.get(clientMsgId);
  if (existing) return existing;
  const p = handlePhoneMessage(convId, text, supervisor, answer);
  inflightSends.set(clientMsgId, p);
  p.then(
    (res) => {
      if (res && (res as { error?: unknown }).error) inflightSends.delete(clientMsgId);
      else setTimeout(() => inflightSends.delete(clientMsgId), 60_000);
    },
    () => inflightSends.delete(clientMsgId),
  );
  return p;
}

async function handlePhoneMessage(
  convId: string | null,
  text: string,
  supervisor = false,
  // [AskUser redesign] `answer` = this is a TAGGED answer to an AWAITING_USER
  // mission (a tapped option or committed free-form reply via /answer), not a
  // plain chat message. Only a tagged answer clears the wait + resumes.
  answer = false,
): Promise<Record<string, unknown>> {
  const s = useStore.getState();
  if (!s.vaultPath) return { error: "no vault open on the box" };
  if (!s.conversationsLoaded) return { error: "box is still loading conversations — retry in a few seconds" };
  const trimmed = text.trim();
  if (!trimmed) return { error: "empty message" };

  let conv: Conversation | undefined;
  if (convId) {
    conv = s.conversations.find((c) => c.id === convId);
    if (!conv) {
      // The phone lists and opens threads straight from disk (the /conversations
      // and /conversation endpoints read the files fresh on every call), but
      // this lookup uses the in-memory store — which can lag disk: a thread
      // synced in from another machine, written since the box last loaded, or
      // dropped by a load race. The phone showed it, so it IS on disk; pull it
      // in (non-destructive — doesn't disturb the box's active view) and retry
      // before giving up with "not found".
      await useStore.getState().refreshConversationFromDisk(s.vaultPath, convId).catch(() => {});
      conv = useStore.getState().conversations.find((c) => c.id === convId);
    }
    if (!conv) return { error: `conversation ${convId} not found` };
  } else if (supervisor) {
    // Cockpit chats: every new thread IS the agent — a fresh conversation
    // carrying role "supervisor" so its turns get the vault's supervisor.md
    // orchestrator prompt (chat-controller passes supervisorMode for
    // role === "supervisor") without the Telegram brevity contract. Fresh
    // each time, per the open-to-a-new-chat design; old threads stay in
    // the menu's recents.
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "phone",
      role: "supervisor",
      title: deriveConversationTitle([{ role: "user", content: trimmed }]),
    };
    useStore.setState({ conversations: [fresh, ...useStore.getState().conversations] });
    conv = fresh;
  } else {
    // Fresh thread. Built inline (NOT newConversation()) so the desktop's
    // focus never jumps — same pattern as the Telegram inbound handler.
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "phone",
      title: deriveConversationTitle([{ role: "user", content: trimmed }]),
    };
    useStore.setState({ conversations: [fresh, ...useStore.getState().conversations] });
    conv = fresh;
  }

  // [ask redesign] A message to an ask thread runs the dedicated ask agent —
  // its own conversation, its own persona, physically incapable of touching
  // the mission thread. [unified ask] A DECIDED ask stays talkable (note: the
  // user keeps talking after making the call — the decision is recorded, the
  // conversation is not over); the busy guard blocks a second turn while the
  // agent is still answering the last one (block-until-done, note 4bd29abb).
  if (conv.source === "ask") {
    const { isRunActive } = await import("./runRegistry");
    if (isRunActive(conv.id + "#chat"))
      return { error: "still answering your last message — wait for it to finish" };
    const { runAskTurn } = await import("./offVaultRun");
    void runAskTurn(s.vaultPath, conv.id, trimmed).catch((e) =>
      console.warn("[phone-app] ask turn failed:", e),
    );
    return { ok: true, convId: conv.id, ask: true };
  }

  // [AskUser redesign] A TAGGED answer (a tapped option or a committed free-form
  // reply, arriving via /answer) is the ONLY thing that resumes an AWAITING_USER
  // mission. Route it straight to the executor with opts.answer so clearAwait
  // flips AWAITING_USER→RUNNING and the mission resumes with the answer fed in.
  // (Falls through to the normal mission path for a non-awaiting mission — a
  // tagged answer to a mission that isn't waiting is just a normal steer.)
  if (answer && conv.source === "mission") {
    const { runWorkerTurn } = await import("./offVaultRun");
    // [unified ask] A formal answer to a COMPLETE mission is meaningless —
    // there's no waiting decision to consume it (a stale card tapped after the
    // run closed). Downgrade to a plain steer: the supervisor still hears it
    // and replies, but no answer semantics and — via missionDone below — no
    // "answered" marker or decision receipt gets stamped on the archive.
    if (conv.missionState === "DONE" || conv.missionState === "KILLED" || conv.completedAt) {
      void runWorkerTurn(s.vaultPath, conv.id, trimmed, {
        modelId: useStore.getState().supervisorModelId,
        direct: true,
      }).catch((e) => console.warn("[phone-app] post-completion steer failed:", e));
      return { ok: true, convId: conv.id, missionDone: true };
    }
    void runWorkerTurn(s.vaultPath, conv.id, trimmed, {
      modelId: useStore.getState().supervisorModelId,
      direct: true,
      answer: true,
    }).catch((e) => console.warn("[phone-app] answer turn failed:", e));
    return { ok: true, convId: conv.id, answered: true };
  }

  // [AskUser redesign] A plain chat message to a mission that is AWAITING_USER is
  // PROBING — "talk it through" — NOT the answer. The ask stays pending until a
  // tagged answer arrives via /answer. This branch is UNCONDITIONAL on the mission
  // being AWAITING_USER (not gated on the two-lane flag) so the shipping-critical
  // invariant "an untagged message never clears the wait" holds regardless of the
  // flag: with two-lane ON, the conversational front replies (real probing); with
  // it OFF, we record the message but run NOTHING (the executor path would end its
  // turn stamping RUNNING via direct:true and silently clear the wait). Either way
  // missionState stays AWAITING_USER.
  if (conv.source === "mission" && conv.missionState === "AWAITING_USER") {
    if (twoLaneMissionChatEnabled()) {
      const { runMissionChatTurn } = await import("./offVaultRun");
      void runMissionChatTurn(s.vaultPath, conv.id, trimmed).catch((e) =>
        console.warn("[phone-app] deliberation probe failed:", e),
      );
      return { ok: true, convId: conv.id, probe: true };
    }
    // Two-lane off: durably record the probe message without running a turn, so
    // the ask is preserved and the executor picks the message up when it next runs
    // (on the tagged answer). Never route to the executor here — that would clear
    // the wait.
    const { appendUserMessageOnly } = await import("./offVaultRun");
    await appendUserMessageOnly(s.vaultPath, conv.id, trimmed).catch((e) =>
      console.warn("[phone-app] probe record failed:", e),
    );
    return { ok: true, convId: conv.id, probe: true, recordedOnly: true };
  }

  // Two-lane mission chat: when the mission's executor is BUSY, don't queue the
  // message silently behind its turn — answer immediately via the conversational
  // front (the assistant persona, reading a snapshot of the executor's live
  // state). The executor keeps working and picks the message up from the thread
  // on its next turn. Idle missions fall through to the executor directly (the
  // mission block below).
  if (conv.source === "mission" && twoLaneMissionChatEnabled() && isThreadBusy(conv)) {
    const { runMissionChatTurn } = await import("./offVaultRun");
    void runMissionChatTurn(s.vaultPath, conv.id, trimmed).catch((e) =>
      console.warn("[phone-app] mission chat turn failed:", e),
    );
    return { ok: true, convId: conv.id };
  }

  if (isThreadBusy(conv)) {
    const q = queued.get(conv.id) ?? [];
    q.push(trimmed);
    queued.set(conv.id, q);
    return { ok: true, convId: conv.id, queued: true };
  }

  // A MISSION (supervisor) thread is written by two paths — the user's messages
  // AND its own self-scheduled wakes. The wake path is disk-lock based
  // (runWorkerTurn) and refreshes the in-memory store from disk; if the user's
  // message only lived in memory (chat-controller's off-target append + deferred
  // autosave), a concurrent wake's refresh CLOBBERED it — the "message I sent to
  // the supervisor vanished" bug. Route mission messages through the SAME
  // disk-lock path so the user's turn is durably persisted before anything else
  // can refresh over it.
  if (conv.source === "mission") {
    const { runWorkerTurn } = await import("./offVaultRun");
    // The user typed this straight to the supervisor — its reply stays natural
    // prose (direct), not a cleaned thought-chain.
    void runWorkerTurn(s.vaultPath, conv.id, trimmed, {
      modelId: useStore.getState().supervisorModelId,
      direct: true,
    }).catch((e) => console.warn("[phone-app] supervisor turn failed:", e));
    return { ok: true, convId: conv.id };
  }

  const { sendMessage } = await import("./chat-controller");
  void sendMessage(trimmed, undefined, undefined, conv.id).catch((e) =>
    console.warn("[phone-app] agent run failed:", e),
  );
  return { ok: true, convId: conv.id };
}

// ---- inbound: structured mission approval (deterministic — zero model tokens) ----
// The phone approved a proposed plan. Approval is a CODE path, not a natural-
// language instruction the model re-interprets: we mint the mission directly
// from the plan data. Its own supervisor then spawns and runs the workers.
async function handlePhoneStartMission(mission: {
  title?: string;
  goal?: string;
}): Promise<Record<string, unknown>> {
  const s = useStore.getState();
  if (!s.vaultPath) return { error: "no vault open on the box" };
  if (!s.conversationsLoaded)
    return { error: "box is still loading conversations — retry in a few seconds" };
  const goal = String(mission.goal ?? "").trim();
  const title =
    String(mission.title ?? "").trim() || goal.split("\n")[0]!.slice(0, 60) || "Mission";
  if (!goal) return { error: "empty mission brief" };
  const { startMission } = await import("./offVaultRun");
  const { id } = await startMission(s.vaultPath, goal, title);
  return { ok: true, convId: id, mission: title };
}

// ---- inbound: status snapshot (deterministic — zero model tokens) ----

type HeartbeatFile = Record<string, { lastProgressAt: number; lastTool?: string; running: boolean }>;

async function statusSnapshot(): Promise<Record<string, unknown>> {
  const s = useStore.getState();
  if (!s.vaultPath) return { error: "no vault open on the box" };
  let hb: HeartbeatFile = {};
  try {
    const raw = await invoke<string>("read_text_file", {
      path: `${s.vaultPath}/.vault-chat/run-heartbeat.json`,
    });
    hb = JSON.parse(raw) ?? {};
  } catch {
    /* no heartbeat file yet */
  }
  const runningIds = new Set<string>(activeRuns());
  for (const c of s.conversations) {
    if (c.status === "running") runningIds.add(c.id);
  }
  if (s.busy && s.activeConversationId) runningIds.add(s.activeConversationId);
  const runs = [...runningIds].map((id) => {
    const c = s.conversations.find((x) => x.id === id);
    const beat = hb[id];
    return {
      convId: id,
      title: c?.title ?? id,
      mission: c?.mission ?? "",
      source: c?.source ?? "",
      lastTool: beat?.lastTool,
      lastProgressAt: beat?.lastProgressAt,
    };
  });
  let schedules: { name: string; detail: string }[] = [];
  try {
    const { getSchedules } = await import("./schedulerLoop");
    schedules = getSchedules().map((sc: any) => ({
      name: String(sc.name ?? sc.prompt ?? "schedule").slice(0, 60),
      detail:
        (sc.enabled === false ? "disabled" : "enabled") +
        (sc.quietUnlessAlert ? " · quiet-unless-ALERT" : ""),
    }));
  } catch {
    /* scheduler not loaded */
  }
  const vaultName = s.vaultPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? s.vaultPath;
  // App version, so the phone can show what the box is actually running —
  // "did the box pick up the update yet" stops being guesswork.
  let version = "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    /* version stays unknown */
  }
  return { vault: vaultName, model: s.modelId, version, runs, schedules };
}

// ---- outbound: store diffs → SSE ----

type ConvSnap = { status: string; msgCount: number; title: string };
let snaps = new Map<string, ConvSnap>();
let lastStreamSent = new Map<string, string>();
let diffTimer: number | null = null;

function toolNames(m: ChatMessage): string[] {
  return (m.toolCalls ?? []).map((t) => t.name);
}

function runDiff(): void {
  diffTimer = null;
  const s = useStore.getState();
  const next = new Map<string, ConvSnap>();
  for (const c of s.conversations) {
    const prev = snaps.get(c.id);
    const visible = c.messages.filter((m) => !m.hidden);
    next.set(c.id, { status: c.status, msgCount: visible.length, title: c.title });
    if (!prev) continue; // newly-seen conv: list view refreshes via status events
    // New finalized messages.
    if (visible.length > prev.msgCount) {
      for (const m of visible.slice(prev.msgCount)) {
        broadcast({
          type: "message",
          convId: c.id,
          role: m.role,
          content: (m.content ?? "").slice(0, MSG_CAP),
          tools: toolNames(m),
          // [unified ask] Inline option cards ride the live message event too,
          // so a presence-gated ask renders its tappable cards the moment the
          // reply lands — not only on a thread reopen.
          ...(m.askOptions && m.askOptions.length ? { askOptions: m.askOptions } : {}),
          ...(m.decision ? { decision: true } : {}),
        });
      }
    }
    if (c.title !== prev.title) {
      broadcast({ type: "title", convId: c.id, title: c.title });
    }
    // Status transitions.
    if (c.status !== prev.status) {
      broadcast({ type: "status", convId: c.id, status: c.status });
      if (prev.status === "running" && c.status === "idle") {
        lastStreamSent.delete(c.id);
        void onRunEnded(c.id);
      }
    }
  }
  snaps = next;

  // Streaming progress: background runs mirror into convRuntime; the
  // foreground run streams into the global view for the active conversation.
  // Keyed on text AND current tool — a worker grinding through tool calls
  // with no prose yet must still show signs of life on the phone (the old
  // text-only gate left its thread a silent "running…" for minutes).
  // Per-conversation run-start, so the phone can render an elapsed clock that
  // counts from when the prompt was sent — the same start the desktop uses,
  // continuous across leave/return.
  const startedAtById = new Map(s.conversations.map((c) => [c.id, c.runStartedAt]));
  for (const [id, rt] of Object.entries(s.convRuntime)) {
    const text = (rt.streamingText ?? "").slice(-STREAM_TAIL);
    const tool = rt.liveTools?.length ? rt.liveTools[rt.liveTools.length - 1]!.name : "";
    // The live thought-by-thought timeline for this run - the phone renders it
    // as a growing list so a thread opened mid-run shows it working step by step.
    const steps = (rt.liveSteps ?? []).slice(-40);
    const lastAction = steps.length ? steps[steps.length - 1]!.action : "";
    const sig = [tool, text, steps.length, lastAction].join("|");
    if ((text || tool || steps.length) && lastStreamSent.get(id) !== sig) {
      lastStreamSent.set(id, sig);
      broadcast({ type: "runtime", convId: id, text, tool, steps, startedAt: startedAtById.get(id) ?? rt.startedAt });
    }
  }
  if (s.busy && s.activeConversationId && (s.streamingText || s.liveTools.length)) {
    const id = s.activeConversationId;
    const text = s.streamingText.slice(-STREAM_TAIL);
    const tool = s.liveTools.length ? s.liveTools[s.liveTools.length - 1]!.name : "";
    const sig = tool + "\u0000" + text;
    if (lastStreamSent.get(id) !== sig) {
      lastStreamSent.set(id, sig);
      broadcast({ type: "runtime", convId: id, text, tool, startedAt: startedAtById.get(id) ?? s.busyStartedAt ?? undefined });
    }
  }
}

async function onRunEnded(convId: string): Promise<void> {
  // 1) Flush messages that queued up while the thread was busy. The user's OWN
  // message must NEVER be blended into worker-wake plumbing — joining them made
  // the user's bubble read "How's it going  Your worker … just finished…" (the
  // bug the user hit). Flush the user's messages first as their own turn, then
  // re-queue the worker wakes so the next onRunEnded batches them into one
  // review turn — two clean, separate turns instead of one merged blob.
  const q = queued.get(convId);
  if (q && q.length > 0) {
    const isWake = (t: string) => /^Your worker "/.test(t);
    const userMsgs = q.filter((t) => !isWake(t));
    const wakes = q.filter(isWake);
    const isUserGroup = userMsgs.length > 0;
    const group = isUserGroup ? userMsgs : wakes;
    const leftover = isUserGroup ? wakes : [];
    if (leftover.length) queued.set(convId, leftover);
    else queued.delete(convId);
    const text = group.join("\n\n");
    const conv = useStore.getState().conversations.find((c) => c.id === convId);
    if (conv?.source === "mission") {
      // Same durable disk-lock path as a direct mission message (above). A
      // user-message flush is a direct reply (natural prose); a wake flush is
      // background review (cleaned into the thought-chain).
      const { runWorkerTurn } = await import("./offVaultRun");
      void runWorkerTurn(useStore.getState().vaultPath!, convId, text, {
        modelId: useStore.getState().supervisorModelId,
        direct: isUserGroup,
      }).catch((e) => console.warn("[phone-app] queued supervisor flush failed:", e));
    } else {
      const { sendMessage } = await import("./chat-controller");
      void sendMessage(text, undefined, undefined, convId).catch((e) =>
        console.warn("[phone-app] queued send failed:", e),
      );
    }
    return; // the follow-up run's completion flushes any leftover wakes
  }
  // 2) A finished worker reports UP, not out: its completion wakes its
  // MISSION thread, which reviews the result and decides — verify, steer,
  // respawn, or (only when it genuinely needs the user) Notify/AskUser. The
  // user hears from supervisors, not from every worker. Legacy workers with
  // no mission thread keep the old direct ping as the safety net so nothing
  // ever finishes silently.
  const s = useStore.getState();
  const c = s.conversations.find((x) => x.id === convId);
  if (!c) return;
  if (c.source === "worker") {
    // Use the worker's last SUBSTANTIVE turn — its real deliverable — not an
    // empty trailing turn, which produced the meaningless "Last output: finished."
    // the user flagged (the wake reported "finished" as if that were the work).
    const lastSubstantive = [...c.messages]
      .reverse()
      .find((m) => m.role === "assistant" && !m.hidden && (m.content ?? "").trim());
    const last = [...c.messages].reverse().find((m) => m.role === "assistant" && !m.hidden);
    // A turn flagged `failed` errored mid-run — it has NO verified deliverable, so
    // it must never be announced as "done … completed its task" (the false "worker
    // done" with no file on disk the user flagged). Report it honestly instead.
    // FAILED if the persisted flag is set OR the final reply (or the substantive
    // turn we'd otherwise show) is a crash bubble ("[object Object]" / a ⚠️ line)
    // — historical rows and text-event errors lack the flag but are still crashes.
    const failed = !!last?.failed || isCrashBubble(last?.content);
    const subContent = lastSubstantive?.content ?? "";
    // Blank a crash-bubble body so the `if (!body)` fallback below names the tools
    // instead — a success card can never read the literal "[object Object]".
    let body = (isCrashBubble(subContent) ? "" : subContent).trim().replace(/\s+/g, " ").slice(0, 180);
    if (!body) {
      // No prose anywhere — name what it last ran; never a bare "finished".
      const names = (last?.toolCalls ?? []).map((t) => t.name);
      body = names.length ? `ran ${[...new Set(names)].slice(0, 5).join(", ")}` : "completed its task";
    }
    // (a) Tell the user this worker finished — ONCE per worker (dedupe by convId;
    // the old bug was each worker pinging several times per turn-end / wake).
    // Frame it by OUTCOME: a clean finish is a "done" deliverable card; a crash is
    // an honest "failed" card — never dress a crash up as a delivered result.
    if (!notifiedWorkers.has(convId)) {
      notifiedWorkers.add(convId);
      if (failed) {
        const errLine = ((last?.content || "").match(/⚠️[^\n]*/)?.[0] || body || "the run errored")
          .replace(/^⚠️\s*/, "")
          .slice(0, 180);
        void notify("info", `Worker failed — ${c.title}`, errLine, convId, {
          intention: `Worker failed${c.mission ? " · " + c.mission : ""}`,
          summary: errLine.slice(0, 200),
          icon: "⚠️",
          cls: "r",
        });
      } else {
        const { summarizeForAlert } = await import("./alert-summary");
        const sum = await summarizeForAlert(last?.content ?? body, useStore.getState().apiKeys).catch(() => null);
        void notify("info", sum?.title || `Worker done — ${c.title}`, sum?.body || body, convId, {
          intention: `Worker deliverable${c.mission ? " · " + c.mission : ""}`,
          summary: (sum?.body || body).slice(0, 200),
          icon: "✓",
          cls: "g",
        });
      }
    }
    // (b) Report UP to the mission so its supervisor reviews + continues — UNLESS
    // the mission is already complete. A late worker-finish must not re-wake a
    // retired mission (that's what kept the supervisor running extra turns and
    // re-calling CompleteMission after it was already done).
    const missionKey = (c.mission ?? "").trim();
    const missionConv = missionKey
      ? s.conversations.find(
          (x) =>
            x.source === "mission" &&
            (x.mission ?? x.title).trim() === missionKey &&
            x.id !== convId,
        )
      : undefined;
    if (missionConv && !missionConv.completedAt) {
      const wake = failed
        ? `Your worker "${c.title}" (id ${convId}) FAILED its turn — it errored and produced no verified deliverable. Error: ${body}\n\n` +
          `Do NOT treat this as done. Decide: respawn it with a fix, do the irreducible part yourself in this thread, or — only if you can't resolve it — bring the user in. Before trusting ANY claimed file, verify it exists on disk (ls/Read) — a crashed worker can report "completed" with nothing written.`
        : `Your worker "${c.title}" (id ${convId}) just finished its turn. Last output: ${body}\n\n` +
          `Review its thread and decide: verified done, steer it (AskWorker), respawn with learnings, or — only if you can't resolve it yourself — bring the user in. Before marking done, verify any claimed deliverable exists on disk.`;
      // Decide queue-vs-run on the mission's CURRENT status, not the snapshot
      // `s` captured at the top of this function — there is an `await`
      // (summarizeForAlert) between that snapshot and here, and the mission's OWN
      // setup turn can go running→idle during it. Using the stale "running"
      // status queued the wake AFTER the mission's idle transition had already
      // fired onRunEnded and flushed an empty queue, so the queued wake never
      // flushed and a failed worker never woke its supervisor to recover (the
      // worker-recover deadlock, surfaced by G3 when a quota-fallback pushed the
      // worker's finish into that race window).
      const missionNow =
        useStore.getState().conversations.find((x) => x.id === missionConv.id) ?? missionConv;
      if (isThreadBusy(missionNow)) {
        // Mission is mid-turn (likely the very AskWorker that drove this
        // worker). Queue the wake — it flushes when the mission's run ends.
        const q = queued.get(missionConv.id) ?? [];
        q.push(wake);
        queued.set(missionConv.id, q);
      } else {
        // Durable disk-lock path (same as a phone message / queued flush to a
        // mission) so the wake can't be clobbered by a concurrent refresh.
        const { runWorkerTurn } = await import("./offVaultRun");
        void runWorkerTurn(useStore.getState().vaultPath!, missionConv.id, wake, {
          modelId: useStore.getState().supervisorModelId,
        }).catch((e) => console.warn("[phone-app] mission wake failed:", e));
      }
    }
  }
}

// ---- the agent→you channel: record + push + live-update, one call ----
// Every notification is (a) appended to <vault>/.vault-chat/notifications.jsonl
// (the Alerts tab reads this), (b) delivered as Web Push, and (c) broadcast so
// an open phone page updates its badge live.
export type NotifyExtra = {
  intention?: string;
  summary?: string;
  icon?: string;
  cls?: string;
  // [AskUser redesign] Structured deliberation payload for an "ask" notification.
  // When present, the cockpit renders the richer "Needs you" deliberation card +
  // inline-option sheet from REAL ask data (not just ?mock=1). Passed straight
  // through notifications.jsonl → the box's notifications_json → the phone.
  deliberation?: {
    mission?: string;
    ask: string;
    askLong?: string;
    // [ask-object] The declared fallback if the user doesn't answer (Not now /
    // timeout), and how consequential the fork is. `stakes:"high"` means a
    // no-answer must STAND DOWN, never auto-proceed.
    stakes?: "low" | "high";
    onDefer?: string;
    // [ask-object 4b] Minutes to wait before a low-stakes ask self-defers.
    timeoutMin?: number;
    options?: { answer: string; title: string; body: string; primary?: boolean }[];
  };
};
export async function notify(
  kind: "info" | "ask",
  title: string,
  body: string,
  convId?: string,
  extra?: NotifyExtra,
): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return;
  const rec: Record<string, unknown> = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ts: Date.now(),
    kind,
    title: title.slice(0, 90),
    // The Alerts sheet renders + scrolls the full body, so don't guillotine a
    // summary mid-word (the "…[SECONDARY" cutoff). Keep it generous here; the
    // push text below is truncated separately to a notification-sized line.
    body: body.slice(0, 2000),
    convId,
  };
  // Structured-deliverable fields. Alerts renders these directly (a real
  // intention line + summary) instead of guessing a category from the title.
  // All optional and backward-compatible: notifications_json on the box passes
  // any extra fields straight through, and the page falls back to derived
  // values when they're absent.
  if (extra?.intention) rec.intention = String(extra.intention).slice(0, 90);
  if (extra?.summary) rec.summary = String(extra.summary).slice(0, 200);
  if (extra?.icon) rec.icon = String(extra.icon).slice(0, 4);
  if (extra?.cls) rec.cls = String(extra.cls).slice(0, 4);
  // [AskUser redesign] Carry the structured deliberation payload verbatim so the
  // cockpit renders the option cards from real ask data. Bounded lengths so a
  // verbose option set can't bloat the feed/push, but generous — the sheet shows
  // the full option bodies. Only for "ask" notifications with real options.
  if (extra?.deliberation && Array.isArray(extra.deliberation.options) && extra.deliberation.options.length) {
    const d = extra.deliberation;
    rec.deliberation = {
      mission: d.mission ? String(d.mission).slice(0, 90) : undefined,
      ask: String(d.ask || "").slice(0, 600),
      askLong: d.askLong ? String(d.askLong).slice(0, 1200) : undefined,
      ...(d.stakes === "high" || d.stakes === "low" ? { stakes: d.stakes } : {}),
      ...(d.onDefer && String(d.onDefer).trim() ? { onDefer: String(d.onDefer).trim().slice(0, 300) } : {}),
      options: d.options!.slice(0, 6).map((o) => ({
        // 200, not 80: the answer text is relayed VERBATIM as the user's
        // message when tapped — an 80-char cap once delivered "…then t"
        // (truncated mid-word) to the waiting supervisor.
        answer: String(o.answer || "").slice(0, 200),
        title: String(o.title || o.answer || "").slice(0, 120),
        body: String(o.body || "").slice(0, 800),
        ...(o.primary ? { primary: true } : {}),
      })),
    };
  }
  // Quality floor: a stringified error object must never reach the feed/push as
  // the literal "[object Object]" (it was even mislabeled as success). Blank it
  // so the title carries the signal instead of junk.
  if (rec.body === "[object Object]") rec.body = "";
  if (rec.summary === "[object Object]") rec.summary = "";
  // [ask redesign] Every ask gets its OWN conversation, minted here — isolated
  // from the mission thread by construction (the spillover fix). The phone's
  // deliberation sheet attaches THIS thread; the notification keeps convId (the
  // mission) as the deterministic /answer relay target and gains askConvId (the
  // conversation surface). Mint failure is non-fatal: the card still renders
  // and options still answer; only the talk-it-through surface degrades.
  // Coalesce a byte-identical re-fire inside the 60s window (dark-alarm
  // triple-fire, parallel worker pings) before it hits feed + push. Key on
  // kind+convId+title+body — NOT title+body alone: two different threads asking
  // the SAME stock AskUser question must each surface their own card, or the
  // second asker (which already ended its turn awaiting a reply routed to its
  // convId) would deadlock on a card that never appeared. The ask-thread mint
  // below sits AFTER this gate — the probe run proved a doubled AskUser call
  // mints an orphan thread when the mint runs first (the notification deduped,
  // the mint didn't).
  const dupKey = `${kind} ${convId ?? ""} ${rec.title as string} ${rec.body as string}`;
  if (isDuplicateNotif(dupKey, rec.ts as number)) return;
  if (kind === "ask") {
    try {
      const { mintAskConversation } = await import("./offVaultRun");
      const missionLabel = convId
        ? useStore.getState().conversations.find((c) => c.id === convId)?.mission ||
          useStore.getState().conversations.find((c) => c.id === convId)?.title
        : undefined;
      const dlbMin = Number(extra?.deliberation?.timeoutMin);
      rec.askConvId = await mintAskConversation(vault, {
        missionConvId: convId,
        notifId: rec.id as string,
        title: (title || "Needs your call").slice(0, 90),
        mission: missionLabel,
        question: body,
        options: extra?.deliberation?.options,
        stakes: extra?.deliberation?.stakes,
        onDefer: extra?.deliberation?.onDefer,
        // Arm a self-defer deadline only when the ask gave a positive timeout.
        deadlineAt: Number.isFinite(dlbMin) && dlbMin > 0 ? Date.now() + dlbMin * 60_000 : undefined,
        kind: "ask",
      });
    } catch (e) {
      console.warn("[notify] ask-conversation mint failed (non-fatal):", e);
    }
  }
  // Latest ask wins, BY CONSTRUCTION: a conversation has at most ONE pending ask.
  // A new "ask" retires any earlier unanswered asks for the same thread (append
  // read markers — same append-only shape the phone's swipe writes). Without this
  // the self-test deadlock stacked 3 live cards for one decision; the user tapped
  // several, each tap woke another turn, and the thread filled with duplicate
  // replies. The supervisor only ever honors the newest ask anyway.
  if (kind === "ask" && convId) {
    try {
      const raw = await invoke<string>("read_text_file", {
        path: `${vault}/.vault-chat/notifications.jsonl`,
      }).catch(() => "");
      const readIds = new Set<string>();
      const priorAsks: string[] = [];
      for (const line of String(raw || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let v: { type?: string; id?: string; kind?: string; convId?: string };
        try { v = JSON.parse(line); } catch { continue; }
        if (v.type === "read" && v.id) { readIds.add(v.id); continue; }
        if (v.type) continue; // hide/clear markers
        if (v.kind === "ask" && v.convId === convId && v.id) priorAsks.push(v.id);
      }
      for (const id of priorAsks.filter((i) => !readIds.has(i))) {
        await invoke("notification_add", {
          vault,
          json: JSON.stringify({ type: "read", id, ts: Date.now() }),
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[notify] ask supersede failed (non-fatal):", e);
    }
  }
  await invoke("notification_add", { vault, json: JSON.stringify(rec) }).catch(() => {});
  broadcast({ type: "notif" });
  // The push itself stays one notification-sized line; the full body lives in
  // the feed. Carry the conversation id in the url so a tapped notification
  // deep-links to the asking thread (the service worker + phone.html read
  // ?conv=), instead of just re-focusing whatever chat was open last — the
  // wrong-conversation bug the PROXY spend-fork surfaced.
  // [ask redesign] An ask's push deep-links to the ASK surface (?ask=<notifId>
  // → the deliberation sheet over its own thread) — never to the mission thread,
  // which silently re-bound the main composer (spillover vector B3). Info
  // pushes keep the ?conv deep-link.
  const pushUrl =
    kind === "ask"
      ? `/phone?ask=${encodeURIComponent(rec.id as string)}`
      : convId
        ? `/phone?conv=${encodeURIComponent(convId)}`
        : "/phone";
  await sendPush(rec.title as string, (rec.body as string).slice(0, 180), pushUrl).catch(() => {});
}

// ---- Web Push: VAPID + RFC 8291 (aes128gcm), all WebCrypto ----

const te = new TextEncoder();

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64uDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64Encode(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const VAPID_STORE_KEY = "vault_chat_vapid_keys";
// Repo-facing contact, required by the push services' VAPID spec.
const VAPID_SUB = "mailto:carlwilson2027@u.northwestern.edu";

type VapidKeys = { privKey: CryptoKey; pubB64u: string };
let vapidCache: VapidKeys | null = null;

async function ensureVapid(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  const stored = localStorage.getItem(VAPID_STORE_KEY);
  if (stored) {
    try {
      const { priv, pubRaw } = JSON.parse(stored);
      const privKey = await crypto.subtle.importKey(
        "jwk",
        priv,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      vapidCache = { privKey, pubB64u: pubRaw };
      return vapidCache;
    } catch {
      /* regenerate below */
    }
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pubRaw = b64uEncode(await crypto.subtle.exportKey("raw", pair.publicKey));
  localStorage.setItem(VAPID_STORE_KEY, JSON.stringify({ priv: privJwk, pubRaw }));
  vapidCache = { privKey: pair.privateKey, pubB64u: pubRaw };
  return vapidCache;
}

const jwtCache = new Map<string, { jwt: string; exp: number }>();

async function vapidJwt(audience: string): Promise<string> {
  const hit = jwtCache.get(audience);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.exp - now > 600) return hit.jwt;
  const { privKey } = await ensureVapid();
  const exp = now + 12 * 3600;
  const header = b64uEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    te.encode(JSON.stringify({ aud: audience, exp, sub: VAPID_SUB })),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA emits the raw r||s form — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    te.encode(signingInput),
  );
  const jwt = `${signingInput}.${b64uEncode(sig)}`;
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bits,
  );
  return new Uint8Array(out);
}

/// RFC 8291 message encryption (aes128gcm content coding, single record).
async function encryptForSub(
  sub: { keys: { p256dh: string; auth: string } },
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPub = b64uDecode(sub.keys.p256dh); // 65-byte raw P-256 point
  const authSecret = b64uDecode(sub.keys.auth); // 16 bytes
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256),
  );
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  const keyInfo = concatBytes(te.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 96);

  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 = padding delimiter for the final (only) record.
  const padded = concatBytes(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, padded as BufferSource),
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** Deliver a notification to every registered phone. Quietly prunes dead
 * subscriptions (404/410). Returns how many deliveries were attempted. */
export async function sendPush(title: string, body: string, url = "/phone"): Promise<number> {
  let subs: any[] = [];
  try {
    subs = JSON.parse(await invoke<string>("phone_push_subs"));
  } catch {
    return 0;
  }
  if (!Array.isArray(subs) || subs.length === 0) return 0;
  const { pubB64u } = await ensureVapid();
  const payload = te.encode(
    JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 400), url, tag: "vault-chat" }),
  );
  let sent = 0;
  for (const sub of subs) {
    try {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;
      const aud = new URL(sub.endpoint).origin;
      const jwt = await vapidJwt(aud);
      const bodyBytes = await encryptForSub(sub, payload);
      const status = await invoke<number>("push_post", {
        endpoint: sub.endpoint,
        headers: [
          ["TTL", "43200"],
          ["Urgency", "high"],
          ["Content-Encoding", "aes128gcm"],
          ["Content-Type", "application/octet-stream"],
          ["Authorization", `vapid t=${jwt}, k=${pubB64u}`],
        ],
        bodyB64: b64Encode(bodyBytes),
      });
      if (status === 404 || status === 410) {
        void invoke("phone_push_unsub", { endpoint: sub.endpoint }).catch(() => {});
      } else if (status >= 200 && status < 300) {
        sent++;
      } else {
        console.warn("[phone-push] push service answered", status);
      }
    } catch (e) {
      console.warn("[phone-push] delivery failed:", e);
    }
  }
  return sent;
}

// A briefing title is only acceptable if it reads like a headline — not raw
// chain-of-thought ("Re-reading the operating files…"), a content-less
// placeholder ("(done)", "no"), or a one-word echo. When the model headline OR
// the first-line fallback fails this test, we drop to the schedule's own name
// rather than ship monologue (the CoT/one-word coach titles the user flagged).
function looksLikeBadTitle(s: string): boolean {
  const t = (s ?? "").trim();
  if (!t) return true;
  const low = t.toLowerCase();
  if (t.split(/\s+/).length < 2 || t.length < 6) return true;
  if (/^(\[object object\]|\(done\)|\(no reply\)|finished\.?)(?:\b|$)/.test(low)) return true;
  // Genuine narration openers only — NOT "first/checking/reading/looking at"
  // (those head valid headlines like "Checking in: week 2", "First milestone").
  if (!/[.!?]$/.test(t) && /^(re-?reading|let me|okay|now i|i'?ll|i am|going to|let's|alright)\b/.test(low)) return true;
  return false;
}

/** Surface a finished SCHEDULED briefing in the notification feed + push.
 * Called from the scheduler paths (chat-controller / offVaultRun) for ANY
 * scheduled run that delivers — coach, supervisor report, any recurring job;
 * NOT a normal chat or a worker/mission reply. The caller passes the already-
 * CLEANED deliverable (the turn's closing message, never the raw "let me re-read
 * the files…" narration), which this runs through the general alert summarizer
 * for a clean headline + a few sentences. The full text stays one tap away via
 * "Open thread" (convId).
 *
 * `fallbackTitle` is the schedule's own name (the scheduled conversation's
 * title, e.g. "Daily coach"): when no fast model is available to summarize — the
 * box with a degraded keyring is the real trigger — this is a far better, clean
 * headline than a raw truncation of the deliverable's first line (which read as
 * a wall of text / leaked narration). The deliverable still fills the body. */
export async function mirrorPushNotify(text: string, convId?: string, fallbackTitle?: string): Promise<void> {
  const raw = text.trim();
  if (!raw) return;
  const apiKeys = useStore.getState().apiKeys;
  const { summarizeForAlert } = await import("./alert-summary");
  const sum = await summarizeForAlert(raw, apiKeys).catch(() => null);
  // Clean-boundary excerpt for the no-model fallback (no fast model on the box,
  // or the summarizer errored): end at the last sentence boundary in the window,
  // else the last word — never a mid-word chop, the "just the tip N characters"
  // complaint. When the model summary exists it's used as-is.
  const clip = (s: string, n: number): string => {
    const t = (s ?? "").trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (stop >= n * 0.5) return cut.slice(0, stop + 1).trim();
    const sp = cut.lastIndexOf(" ");
    return (sp > 0 ? cut.slice(0, sp) : cut).trim() + "…";
  };
  // Title precedence: model headline → the schedule's own name → a clipped first
  // line as a last resort. The schedule name keeps the headline clean and short
  // even on a box that can't run the summarizer.
  const modelTitle = sum?.title && !looksLikeBadTitle(sum.title) ? sum.title : "";
  const firstLine = clip(raw.split("\n")[0]?.trim() || "", 90);
  const title =
    modelTitle ||
    fallbackTitle?.trim() ||
    (looksLikeBadTitle(firstLine) ? "" : firstLine) ||
    "New briefing";
  const body = sum?.body || clip(raw, 1800);
  await notify("info", title, body, convId, {
    intention: "Scheduled briefing",
    summary: sum?.body ? sum.body.slice(0, 200) : clip(raw, 200),
    icon: "✦",
    cls: "g",
  });
}

// ---- wiring ----

let started = false;

// ---- note titles (box-side, disk-based) ----
// Generate Note.title (a short scannable headline distinct from the body) for
// notes that lack one, on the box where the API keys live. DISK-based on
// purpose: the box's in-memory notes can be empty/unloaded, and a store-based
// writeAllNotes would then blank the file — so we read the jsonl fresh, patch,
// and re-read right before writing to avoid clobbering a concurrent change. A
// single file read when everything is already titled, so it's safe to poll; and
// because it titles per-line it self-heals an untitled duplicate that a
// cross-machine union-merge adds back.
// Collapse the duplicate physical lines that merge=union accumulates in
// notes.jsonl (a status flip rewrites the row; two machines editing concurrently
// each leave one). readNotes already dedupes on read so the count is always
// correct, but the file would grow unbounded — this rewrites it to the deduped
// set. Idempotent: a no-op write-skip when already compact, so it's safe on the
// same launch+poll cadence as the title backfill. Box-only on purpose: the box
// is the sole active writer (see sync architecture), so a follower rewriting
// here would just churn history.
async function compactNotesOnBox(): Promise<void> {
  const vault = useStore.getState().vaultPath ?? "";
  if (!vault) return;
  try {
    const { compactNotes } = await import("./notes");
    const collapsed = await compactNotes(vault);
    if (collapsed > 0) console.log(`[phone-app] compacted notes.jsonl: −${collapsed} duplicate line(s)`);
  } catch (e) {
    console.warn("[phone-app] compactNotes failed:", e);
  }
}

let titlingInFlight = false;
async function ensureNoteTitles(vault: string): Promise<void> {
  if (!vault || titlingInFlight) return;
  titlingInFlight = true;
  try {
    const { readNotes, writeAllNotes, titleableText } = await import("./notes");
    const disk = await readNotes(vault);
    const todo = disk
      .filter((n) => (n.title == null || n.title === "") && titleableText(n))
      .slice(0, 12);
    if (!todo.length) return;
    const { pickFastModel } = await import("./eta-estimator");
    const fast = pickFastModel(useStore.getState().apiKeys);
    if (!fast) return;
    const { titleForNote } = await import("./notes-format");
    const titles = new Map<string, string>();
    for (const n of todo) {
      try {
        const t = await titleForNote(n, fast.spec, fast.apiKey);
        if (t) titles.set(n.id, t);
      } catch (e) {
        console.warn("[phone-app] note title gen failed:", e);
      }
    }
    if (!titles.size) return;
    // Re-read so a note created/edited while we were generating isn't lost.
    const fresh = await readNotes(vault);
    let changed = false;
    const updated = fresh.map((n) => {
      if ((n.title == null || n.title === "") && titles.has(n.id)) {
        changed = true;
        return { ...n, title: titles.get(n.id)! };
      }
      return n;
    });
    if (changed) await writeAllNotes(vault, updated);
  } catch (e) {
    console.warn("[phone-app] ensureNoteTitles failed:", e);
  } finally {
    titlingInFlight = false;
  }
}

export async function startPhoneAppHost(): Promise<void> {
  if (started) return;
  started = true;

  // Backfill note headlines shortly after launch, then poll — cheap (one file
  // read) when everything is titled, and it catches notes synced in from other
  // machines as well as ones jotted on the phone.
  setTimeout(() => {
    void compactNotesOnBox();
    void ensureNoteTitles(useStore.getState().vaultPath ?? "");
  }, 8_000);
  setInterval(() => {
    void compactNotesOnBox();
    void ensureNoteTitles(useStore.getState().vaultPath ?? "");
  }, 5 * 60_000);

  // Hand the server our VAPID public key so the page can subscribe.
  void ensureVapid()
    .then(({ pubB64u }) => invoke("phone_set_vapid", { key: pubB64u }))
    .catch((e) => console.warn("[phone-app] vapid init failed:", e));

  await listen<{
    reqId: string;
    convId?: string | null;
    text?: string;
    supervisor?: boolean;
    mission?: { title?: string; goal?: string };
    clientMsgId?: string;
  }>("phone:msg", async (event) => {
    const { reqId, convId, text, supervisor, mission, clientMsgId } = event.payload;
    try {
      // Structured approval payload → mint the mission deterministically.
      if (mission && (mission.goal || mission.title)) {
        respond(reqId, await handlePhoneStartMission(mission));
        return;
      }
      respond(
        reqId,
        await dedupedPhoneMessage(clientMsgId, convId ?? null, String(text ?? ""), !!supervisor),
      );
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // [AskUser redesign] The TAGGED answer channel: a tapped option or a committed
  // free-form reply to a "Needs you" ask. Distinct from /message so a plain chat
  // message (probing / talking it through) can NOT accidentally resolve the ask —
  // only a tagged answer clears AWAITING_USER and resumes the executor with the
  // answer fed in. Routes through the SAME deduped handler with answer=true.
  await listen<{
    reqId: string;
    convId?: string | null;
    text?: string;
    clientMsgId?: string;
    notifId?: string;
    askConvId?: string;
    defer?: boolean;
    onDefer?: string;
  }>("phone:answer", async (event) => {
    const { reqId, convId, text, clientMsgId, notifId, askConvId, defer, onDefer } = event.payload;
    try {
      const t = String(text ?? "").trim();
      if (!convId || (!t && !defer)) {
        respond(reqId, { error: "answer needs a convId and non-empty text" });
        return;
      }
      // [ask-object] "Not now" is the ask's single terminal ALONGSIDE answering:
      // it ends the ask without picking an option and — crucially — RESUMES the
      // parked mission (clears AWAITING_USER) instead of stranding it forever the
      // way a swiped-away card used to. The injected turn tells the executor to
      // fall back to what it declared when it raised the ask (act on a named
      // default, or stand down for anything high-stakes/irreversible). The
      // recorded decision is the short "Not now" for the card + archive.
      const onDeferTxt = String(onDefer ?? "").trim();
      const injected = defer
        ? "[NOT NOW] I'm deferring this decision — I did not pick any of the options. Don't wait on me further, and don't re-raise the same ask. " +
          (onDeferTxt
            ? `The fallback you declared when you raised it: “${onDeferTxt.slice(0, 300)}”. Do that now if it's an action; if it's a hold, or this ask was high-stakes/irreversible, stand down and don't act. Say plainly what you're doing.`
            : "Fall back to what you decided when you raised it: if you named a default action for no-answer, take it now; if this needs my explicit go and I haven't given it (a spend, or anything irreversible or high-stakes), do NOT act — stand down or hold, and say plainly what you're doing.")
        : t;
      const recorded = defer ? "Not now" : t;
      const res = await dedupedPhoneMessage(clientMsgId, convId, injected, false, /* answer */ true);
      // Durably record WHICH answer settled this ask — an append-only "answered"
      // marker keyed to the notification id. notifications_json folds it into the
      // card as answeredWith/answeredAt (and treats it as read), so the Archive
      // shows the decision that was made, not just that an ask once existed.
      // Skipped when the send failed or deduped to an error — a phantom "decided"
      // stamp on an ask whose answer never ran would lie to the archive. ALSO
      // skipped when the mission was already complete (missionDone): the tap
      // was downgraded to a plain steer — a "decision" record for a closed
      // mission would be a lie too.
      if (notifId && !(res as { error?: unknown }).error && !(res as { missionDone?: boolean }).missionDone) {
        const vault = useStore.getState().vaultPath;
        if (vault) {
          await invoke("notification_add", {
            vault,
            json: JSON.stringify({ type: "answered", id: notifId, answer: recorded.slice(0, 160), ts: Date.now() }),
          }).catch(() => {});
          broadcast({ type: "notif" });
        }
      }
      // [ask redesign] Pin the decision receipt into the ask's own thread —
      // after the answer was accepted, same no-phantom-stamp rule as the
      // marker above. [unified ask] The thread stays talkable after; the stamp
      // is the record, not a freeze. No receipt for a missionDone downgrade.
      if (askConvId && !(res as { error?: unknown }).error && !(res as { missionDone?: boolean }).missionDone) {
        const vault = useStore.getState().vaultPath;
        if (vault) {
          const { stampAskDecided } = await import("./offVaultRun");
          await stampAskDecided(vault, askConvId, recorded).catch((e) =>
            console.warn("[phone-app] ask-decided stamp failed:", e),
          );
        }
      }
      respond(reqId, res);
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // [ask redesign] Lazy follow-up thread for an INFO alert: minted on the
  // user's FIRST message about that alert, then reused (a "followup" marker in
  // notifications.jsonl records the binding; notifications_json folds it into
  // the card as followupConvId). The first message runs the ask agent
  // immediately, so one round-trip both creates the thread and answers.
  await listen<{
    reqId: string;
    notifId?: string;
    title?: string;
    body?: string;
    convId?: string;
    text?: string;
  }>("phone:alert-followup", async (event) => {
    const { reqId, notifId, title, body, convId, text } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open on the box" });
        return;
      }
      const t = String(text ?? "").trim();
      if (!notifId) {
        respond(reqId, { error: "follow-up needs a notifId" });
        return;
      }
      const { mintAskConversation, runAskTurn } = await import("./offVaultRun");
      const missionLabel = convId
        ? s.conversations.find((c) => c.id === convId)?.mission ||
          s.conversations.find((c) => c.id === convId)?.title
        : undefined;
      const askConvId = await mintAskConversation(s.vaultPath, {
        missionConvId: convId || undefined,
        notifId,
        title: `Re: ${(title || "alert").slice(0, 80)}`,
        mission: missionLabel,
        question: [title, body].filter(Boolean).join(" — ").slice(0, 1200),
        kind: "info",
      });
      await invoke("notification_add", {
        vault: s.vaultPath,
        json: JSON.stringify({ type: "followup", id: notifId, convId: askConvId, ts: Date.now() }),
      }).catch(() => {});
      broadcast({ type: "notif" });
      // Mint-only when no text: the phone attaches the fresh thread and sends
      // the first message through the normal /message path.
      if (t) {
        void runAskTurn(s.vaultPath, askConvId, t).catch((e) =>
          console.warn("[phone-app] alert follow-up turn failed:", e),
        );
      }
      respond(reqId, { ok: true, convId: askConvId });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Full schedule list for the phone's drawer — read fresh from disk so the
  // phone sees the same truth as the SchedulesPanel.
  await listen<{ reqId: string }>("phone:schedules", async (event) => {
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(event.payload.reqId, { error: "no vault open" });
        return;
      }
      const { readSchedules, recurrenceLabel, shortTimeLabel } = await import("./schedules");
      const list = await readSchedules(s.vaultPath);
      respond(event.payload.reqId, {
        schedules: list.map((sc) => ({
          id: sc.id,
          name: sc.name || sc.prompt.split(/\s+/).slice(0, 5).join(" ") || "Schedule",
          prompt: sc.prompt.slice(0, 200),
          label: `${recurrenceLabel(sc.recurrence)} · ${shortTimeLabel(sc)}`,
          enabled: sc.enabled,
          lastFiredAt: sc.lastFiredAt,
          quietUnlessAlert: !!sc.quietUnlessAlert,
          // One-offs are the agent's own self-scheduled wakes (it sets a one-time
          // Schedule for its next check, which self-destructs after firing).
          // Those are background plumbing, not something the user monitors — the
          // phone hides them from the Scheduled list.
          once: sc.recurrence.kind === "once",
        })),
      });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  // Toggle / delete a schedule from the phone. Uses the scheduler's own CRUD
  // so the in-memory loop and the SchedulesPanel stay in sync.
  await listen<{ reqId: string; action?: string; id?: string; enabled?: boolean }>(
    "phone:schedule",
    async (event) => {
      const { reqId, action, id, enabled } = event.payload;
      try {
        const s = useStore.getState();
        if (!s.vaultPath || !id) {
          respond(reqId, { error: "no vault open or missing id" });
          return;
        }
        const { toggleSchedule, deleteSchedule } = await import("./schedulerLoop");
        if (action === "toggle") {
          await toggleSchedule(s.vaultPath, id, !!enabled);
          respond(reqId, { ok: true });
        } else if (action === "delete") {
          await deleteSchedule(s.vaultPath, id);
          respond(reqId, { ok: true });
        } else {
          respond(reqId, { error: `unknown action ${action}` });
        }
      } catch (e) {
        respond(reqId, { error: String(e) });
      }
    },
  );

  // Capture a new note from the phone. Pure text capture (no anchors) — the same
  // shape the desktop's quick-note and the voice CreateNote produce. addNote
  // appends to notes.jsonl and updates the in-memory store, so it shows up on the
  // desktop live and on the phone's next /notes fetch.
  await listen<{ reqId: string; text?: string }>("phone:note", async (event) => {
    const { reqId, text } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const t = (text ?? "").trim();
      if (!t) {
        respond(reqId, { error: "empty note" });
        return;
      }
      const { buildNote } = await import("./notes");
      const note = buildNote({ anchors: [], userDraft: t });
      await s.addNote(note);
      respond(reqId, { ok: true, id: note.id });
      // Give the new note a scannable headline (best-effort, off the response path).
      void ensureNoteTitles(s.vaultPath);
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // [experience-log] The phone streams UI events (card renders, option taps, send
  // outcomes, errors) so a bug report is a REPLAY of the real session rather than
  // a description. Append them to client-events.jsonl. STRICTLY best-effort —
  // always respond ok, never throw; logging must never affect the app.
  await listen<{ reqId: string; [k: string]: unknown }>("phone:client-event", async (event) => {
    const { reqId, ...ev } = event.payload as { reqId: string; [k: string]: unknown };
    try {
      const s = useStore.getState();
      if (s.vaultPath) {
        await invoke("client_event_append", { vault: s.vaultPath, line: JSON.stringify(ev) }).catch(() => {});
      }
    } catch {
      /* logging must never surface */
    }
    respond(reqId, { ok: true });
  });

  // Resolve / reopen a note from the phone (swipe-to-resolve). Apply the change
  // against the FRESHEST on-disk notes — never the box's in-memory store, which
  // can be empty or stale (a store-based rewrite would then blank the file). We
  // bump last_updated so the cross-machine union merge keeps this status change
  // as the winner over an older copy on another machine.
  await listen<{ reqId: string; id?: string; status?: string }>(
    "phone:note-status",
    async (event) => {
      const { reqId, id, status } = event.payload;
      try {
        const s = useStore.getState();
        if (!s.vaultPath) {
          respond(reqId, { error: "no vault open" });
          return;
        }
        const noteId = (id ?? "").trim();
        if (!noteId) {
          respond(reqId, { error: "missing note id" });
          return;
        }
        const next: "open" | "resolved" = status === "open" ? "open" : "resolved";
        const { readNotes, writeAllNotes } = await import("./notes");
        const disk = await readNotes(s.vaultPath);
        const now = new Date().toISOString();
        let found = false;
        const updated = disk.map((n) =>
          n.id === noteId ? ((found = true), { ...n, status: next, last_updated: now }) : n,
        );
        if (!found) {
          respond(reqId, { error: "note not found" });
          return;
        }
        await writeAllNotes(s.vaultPath, updated);
        // Keep the box's in-memory store coherent if notes are loaded there.
        if (s.notesLoaded) {
          useStore.setState((st) => ({
            notes: st.notes.map((n) =>
              n.id === noteId ? { ...n, status: next, last_updated: now } : n,
            ),
          }));
        }
        respond(reqId, { ok: true, id: noteId, status: next });
      } catch (e) {
        respond(reqId, { error: String(e) });
      }
    },
  );

  // Edit a note's text from the phone (swipe right → edit sheet, note 002c8029).
  // Same freshest-on-disk contract as note-status: apply against readNotes, bump
  // last_updated so the edit wins the cross-machine union merge, and clear the
  // AI headline so it regenerates to match the new content.
  await listen<{ reqId: string; id?: string; text?: string }>("phone:note-edit", async (event) => {
    const { reqId, id, text } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const noteId = (id ?? "").trim();
      const t = (text ?? "").trim();
      if (!noteId) {
        respond(reqId, { error: "missing note id" });
        return;
      }
      if (!t) {
        respond(reqId, { error: "empty note text" });
        return;
      }
      const { readNotes, writeAllNotes } = await import("./notes");
      const disk = await readNotes(s.vaultPath);
      const now = new Date().toISOString();
      let found = false;
      const updated = disk.map((n) =>
        n.id === noteId ? ((found = true), { ...n, user_draft: t, title: null, last_updated: now }) : n,
      );
      if (!found) {
        respond(reqId, { error: "note not found" });
        return;
      }
      await writeAllNotes(s.vaultPath, updated);
      if (s.notesLoaded) {
        useStore.setState((st) => ({
          notes: st.notes.map((n) =>
            n.id === noteId ? { ...n, user_draft: t, title: null, last_updated: now } : n,
          ),
        }));
      }
      respond(reqId, { ok: true, id: noteId });
      // Re-headline off the response path — the edited body needs a fresh title.
      void ensureNoteTitles(s.vaultPath);
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Empty the resolved pile from the phone (the "Clear all" in Resolved Notes).
  // Flip every resolved note to the terminal `cleared` status against the
  // FRESHEST on-disk notes — never a filter-and-rewrite, which would drop the
  // rows and let the union merge resurrect them from another machine's copy
  // (the schedule-tombstone trap). A bumped last_updated + cleared > resolved
  // (preferredNote) makes the clear win the cross-machine merge.
  await listen<{ reqId: string }>("phone:notes-clear-resolved", async (event) => {
    const { reqId } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const { readNotes, writeAllNotes } = await import("./notes");
      const disk = await readNotes(s.vaultPath);
      const now = new Date().toISOString();
      let cleared = 0;
      const updated = disk.map((n) =>
        n.status === "resolved"
          ? ((cleared += 1), { ...n, status: "cleared" as const, last_updated: now })
          : n,
      );
      if (cleared > 0) await writeAllNotes(s.vaultPath, updated);
      // Keep the box's in-memory store coherent if notes are loaded there.
      if (cleared > 0 && s.notesLoaded) {
        useStore.setState((st) => ({
          notes: st.notes.map((n) =>
            n.status === "resolved" ? { ...n, status: "cleared" as const, last_updated: now } : n,
          ),
        }));
      }
      respond(reqId, { ok: true, cleared });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // The phone opened a thread — promote it into the recent/Chats list. Mission
  // and worker threads live on Activity and stay out of recent by default; the
  // moment the user views one it flips `surfaced` and joins recent so they can
  // get back to it. Setting it on the conversations list triggers the store's
  // debounced autosave, which persists + syncs it (so a worker surfaced on the
  // phone also shows in the desktop's list). No-op for already-surfaced threads
  // and for normal chats (manual/voice/phone), which are in recent regardless.
  await listen<{ reqId: string; convId?: string }>("phone:surface", async (event) => {
    const { reqId, convId } = event.payload;
    try {
      const s = useStore.getState();
      const conv = convId ? s.conversations.find((c) => c.id === convId) : undefined;
      // Worker/mission threads live on Activity and stay out of recent by
      // default. Opening one both surfaces it AND bumps lastActivityAt so it
      // pins to the TOP of recent — matching the desktop's selectConversation,
      // and the note's ask ("pin that chat to top … instead it disappears").
      // Bump on every open (not just first surface) so re-opening re-pins.
      const isWorkerOrMission =
        !!conv && (conv.source === "worker" || conv.source === "mission");
      if (isWorkerOrMission) {
        useStore.setState((st) => ({
          conversations: st.conversations.map((c) =>
            c.id === convId
              ? { ...c, surfaced: true, lastActivityAt: Date.now() }
              : c,
          ),
        }));
      }
      respond(reqId, { ok: true });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Vault-only resolver for routes that read disk directly (/conversations,
  // /file) — works even when no ElevenLabs key exists for the voice context.
  await listen<{ reqId: string }>("phone:vault", (event) => {
    respond(event.payload.reqId, useStore.getState().vaultPath ?? "");
  });

  await listen<{ reqId: string }>("phone:status", async (event) => {
    try {
      respond(event.payload.reqId, await statusSnapshot());
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  await listen<{ reqId: string; convId?: string | null }>("phone:kill", async (event) => {
    const { reqId, convId } = event.payload;
    try {
      if (convId) {
        const hit = abortRun(convId);
        // Only claim idle when nothing was actually running. If we DID abort a
        // live run, it may be mid-tool-call and keep going until that tool
        // returns — its REAL end broadcasts idle via runDiff. Broadcasting idle
        // prematurely here was the bug: the phone flipped between stopped and
        // running and the user couldn't tell whether it was truly off.
        if (!hit) broadcast({ type: "status", convId, status: "idle" });
        // Stopping a MISSION tears the whole thing down — supervisor, its
        // workers, its scheduled wakes — and tombstone-deletes them so it
        // actually disappears for every client and can't resurrect (via a
        // worker-finish wake, a scheduled wake, or a git-sync pull).
        const stopped = useStore.getState().conversations.find((c) => c.id === convId);
        const vault = useStore.getState().vaultPath;
        if (stopped?.source === "mission" && vault) {
          const { stopAndDeleteMission } = await import("./offVaultRun");
          await stopAndDeleteMission(vault, convId).catch((e) =>
            console.warn("[phone-app] stop mission failed:", e),
          );
        }
        respond(reqId, {
          ok: true,
          result: hit
            ? "Stopped — interrupting now (an in-flight command is killed)."
            : "Nothing running on that thread.",
        });
      } else {
        const ids = activeRuns();
        let n = 0;
        for (const id of ids) {
          if (abortRun(id)) {
            n++;
            broadcast({ type: "status", convId: id, status: "idle" });
          }
        }
        respond(reqId, { ok: true, result: n ? `Stopped ${n} run(s).` : "Nothing running." });
      }
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Purge the chats list: tombstone-delete every idle assistant chat. Workers
  // and missions are untouched (Activity owns them), as is anything mid-run.
  await listen<{ reqId: string }>("phone:clearchats", async (event) => {
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(event.payload.reqId, { error: "no vault open" });
        return;
      }
      const victims = s.conversations.filter(
        (c) =>
          c.source !== "worker" &&
          c.source !== "mission" &&
          c.status !== "running" &&
          !(s.busy && s.activeConversationId === c.id),
      );
      // Await the tombstone writes before acking: the phone refreshes its chats
      // list as soon as this responds, and a fire-and-forget delete let that
      // refresh re-read the still-on-disk chats before their tombstones flushed.
      const del = useStore.getState().deleteConversation;
      await Promise.all(victims.map((v) => del(v.id)));
      respond(event.payload.reqId, { ok: true, cleared: victims.length });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  await listen<{ reqId: string }>("phone:pushtest", async (event) => {
    try {
      const n = await sendPush("vault-chat", "Test notification from the box. Push works.");
      respond(event.payload.reqId, n > 0 ? { ok: true } : { error: "no subscriptions registered (or all deliveries failed — check the box console)" });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  // Store → SSE forwarding, debounced. The diff is cheap (length/status
  // compares) and only runs 4×/sec at worst during a streaming turn.
  let prevConvs = useStore.getState().conversations;
  let prevRuntime = useStore.getState().convRuntime;
  let prevStreaming = "";
  useStore.subscribe((s) => {
    if (
      s.conversations === prevConvs &&
      s.convRuntime === prevRuntime &&
      s.streamingText === prevStreaming
    ) {
      return;
    }
    prevConvs = s.conversations;
    prevRuntime = s.convRuntime;
    prevStreaming = s.streamingText;
    if (diffTimer === null) {
      diffTimer = window.setTimeout(runDiff, 250);
    }
  });
  // Seed the snapshot so a fresh boot doesn't replay the whole history.
  runDiff();
}
