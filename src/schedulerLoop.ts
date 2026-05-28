import { useStore } from "./store";
import {
  type Schedule,
  nextFireAt,
  readSchedules,
  writeSchedules,
} from "./schedules";
import { sendMessage } from "./chat-controller";
import { sendTelegramMessage } from "./telegram";

// Scheduler loop. One per active vault. Ticks every 30s; fires any
// schedule whose next-fire timestamp has passed since the last tick.
//
// Firing a schedule:
//   1. Resolve the target conversation (existing or fresh).
//   2. Make sure that conversation is the active one.
//   3. Call sendMessage with the prompt. The standard agent path
//      handles streaming, tool calls, and end-of-turn commit.
//   4. On completion (busy=false), apply on-completion flags (mark
//      unread, send to Telegram).

type ActiveLoop = {
  vault: string;
  cancel: () => void;
};

let active: ActiveLoop | null = null;
let schedules: Schedule[] = [];
const listeners = new Set<(s: Schedule[]) => void>();

function emit() {
  for (const l of listeners) l(schedules);
}

export function subscribeSchedules(fn: (s: Schedule[]) => void): () => void {
  listeners.add(fn);
  fn(schedules);
  return () => listeners.delete(fn);
}

export function getSchedules(): Schedule[] {
  return schedules;
}

export async function startSchedulerLoop(vault: string): Promise<void> {
  stopSchedulerLoop();
  schedules = await readSchedules(vault).catch(() => []);
  emit();
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    const now = Date.now();
    // Snapshot to avoid race with edits while iterating.
    const list = schedules.slice();
    for (const s of list) {
      if (!s.enabled) continue;
      const fireAt = nextFireAt(s, s.lastFiredAt ?? s.createdAt ?? 0);
      if (fireAt === null) continue;
      if (fireAt > now) continue;
      // It's due. Mark fired now (optimistic) so a slow agent run
      // doesn't cause re-fire on the next tick.
      const updated = { ...s, lastFiredAt: now };
      schedules = schedules.map((x) => (x.id === s.id ? updated : x));
      emit();
      void writeSchedules(vault, schedules).catch(() => {});
      void fireOnce(vault, updated).catch((e) =>
        console.warn("[scheduler] fire failed:", e),
      );
    }
  };

  // Tick frequently so the "imminent" pulse and time-of-day fires feel
  // responsive without being wasteful.
  const interval = window.setInterval(() => {
    void tick();
  }, 30_000);
  // Initial tick so opening the app right at fire time doesn't wait
  // 30s.
  void tick();

  active = {
    vault,
    cancel: () => {
      cancelled = true;
      window.clearInterval(interval);
    },
  };
}

export function stopSchedulerLoop(): void {
  if (active) {
    active.cancel();
    active = null;
  }
  schedules = [];
  emit();
}

async function fireOnce(vault: string, s: Schedule): Promise<void> {
  const store = useStore.getState();
  if (store.vaultPath !== vault) return;

  // Resolve the target conversation. We assume the caller has the
  // vault open — we don't fire across vaults.
  let conversationId: string;
  if (s.target.kind === "existing") {
    const targetId = s.target.conversationId;
    const exists = store.conversations.some((c) => c.id === targetId);
    if (!exists) {
      console.warn("[scheduler] target conversation gone, falling back to new");
      conversationId = createScheduledConversation(s);
    } else {
      conversationId = targetId;
    }
  } else {
    conversationId = createScheduledConversation(s);
  }
  useStore.getState().selectConversation(conversationId);

  // Snapshot the model selection and swap to the schedule's model;
  // restore after the run completes so the user's UI choice is
  // preserved.
  const prevModel = useStore.getState().modelId;
  if (s.modelId) useStore.getState().setModelId(s.modelId);

  // Subscribe so we can react when busy flips from true → false.
  let resolved = false;
  const completion = new Promise<void>((resolve) => {
    const unsub = useStore.subscribe((state, prev) => {
      if (prev.busy && !state.busy) {
        if (resolved) return;
        resolved = true;
        unsub();
        resolve();
      }
    });
    // If sendMessage early-returns before flipping busy, time out so we
    // never hang.
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsub();
      resolve();
    }, 25 * 60_000);
  });

  await sendMessage(s.prompt);
  await completion;

  // Restore model preference.
  if (s.modelId && useStore.getState().modelId === s.modelId) {
    useStore.getState().setModelId(prevModel);
  }

  // On-completion hooks.
  const stateAfter = useStore.getState();
  const finalConv = stateAfter.conversations.find((c) => c.id === conversationId);
  const lastAssistant = finalConv
    ? [...finalConv.messages].reverse().find((m) => m.role === "assistant")?.content
    : undefined;
  if (s.markUnreadOnFinish && stateAfter.activeConversationId !== conversationId) {
    useStore.setState({
      conversations: stateAfter.conversations.map((c) =>
        c.id === conversationId ? { ...c, unread: true } : c,
      ),
    });
  }
  if (s.sendViaTelegram && lastAssistant) {
    const tgChat = finalConv?.telegramChatId;
    if (tgChat !== undefined) {
      sendTelegramMessage(vault, tgChat, lastAssistant).catch((err) =>
        console.warn("[scheduler] telegram send failed:", err),
      );
    } else {
      console.warn(
        "[scheduler] sendViaTelegram is on but conversation has no chat_id",
      );
    }
  }
}

function createScheduledConversation(s: Schedule): string {
  const store = useStore.getState();
  const title = s.name?.trim() || formatDateTitle(s);
  const id = store.newConversation();
  useStore.setState({
    conversations: store.conversations
      ? useStore.getState().conversations.map((c) =>
          c.id === id ? { ...c, source: "scheduled", title } : c,
        )
      : useStore.getState().conversations,
  });
  return id;
}

function formatDateTitle(s: Schedule): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${s.prompt.split(/\s+/).slice(0, 4).join(" ") || "Scheduled run"} · ${date}`;
}

// CRUD ops that keep both memory and disk in sync.
export async function saveSchedule(
  vault: string,
  s: Schedule,
): Promise<void> {
  const idx = schedules.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    schedules = schedules.map((x) => (x.id === s.id ? s : x));
  } else {
    schedules = [...schedules, s];
  }
  emit();
  await writeSchedules(vault, schedules);
}

export async function deleteSchedule(vault: string, id: string): Promise<void> {
  schedules = schedules.filter((x) => x.id !== id);
  emit();
  await writeSchedules(vault, schedules);
}

export async function toggleSchedule(
  vault: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  schedules = schedules.map((x) => (x.id === id ? { ...x, enabled } : x));
  emit();
  await writeSchedules(vault, schedules);
}
