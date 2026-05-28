import { sendMessage } from "./chat-controller";
import { useStore } from "./store";
import { sendTelegramMessage } from "./telegram";

// Async background tasks ("Let it run" mode). When a chat is put into
// autonomous mode, the loop generates the agent's next turn on its own
// after each completed response until one of the stop conditions is
// met. Telemetry surface: a strip in the composer with step count,
// wall-clock, and a Stop button.

export type AsyncConfig = {
  maxSteps: number;
  maxWallClockMin: number;
  pingOnFinish: boolean;
};

export const DEFAULT_ASYNC_CONFIG: AsyncConfig = {
  maxSteps: 40,
  maxWallClockMin: 15,
  pingOnFinish: true,
};

const STORAGE = "vault_chat_async_config";

export function readAsyncConfig(): AsyncConfig {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return DEFAULT_ASYNC_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AsyncConfig>;
    return { ...DEFAULT_ASYNC_CONFIG, ...parsed };
  } catch {
    return DEFAULT_ASYNC_CONFIG;
  }
}

export function writeAsyncConfig(patch: Partial<AsyncConfig>): AsyncConfig {
  const current = readAsyncConfig();
  const merged = { ...current, ...patch };
  localStorage.setItem(STORAGE, JSON.stringify(merged));
  return merged;
}

export type AsyncStatus = {
  active: boolean;
  conversationId: string | null;
  step: number;
  maxSteps: number;
  startedAt: number;
  maxWallClockMin: number;
};

let status: AsyncStatus = {
  active: false,
  conversationId: null,
  step: 0,
  maxSteps: 0,
  startedAt: 0,
  maxWallClockMin: 0,
};
const listeners = new Set<(s: AsyncStatus) => void>();

function emit() {
  for (const l of listeners) l(status);
}

export function subscribeAsyncStatus(fn: (s: AsyncStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function getAsyncStatus(): AsyncStatus {
  return status;
}

let cancelled = false;

export async function startAsyncRun(conversationId: string): Promise<void> {
  const config = readAsyncConfig();
  cancelled = false;
  status = {
    active: true,
    conversationId,
    step: 0,
    maxSteps: config.maxSteps,
    startedAt: Date.now(),
    maxWallClockMin: config.maxWallClockMin,
  };
  emit();
  useStore.getState().setConversationAutoMode(conversationId, true);
  void runLoop(config);
}

export function stopAsyncRun(): void {
  cancelled = true;
  const convId = status.conversationId;
  if (convId) useStore.getState().setConversationAutoMode(convId, false);
  status = { ...status, active: false };
  emit();
}

async function runLoop(config: AsyncConfig): Promise<void> {
  const convId = status.conversationId;
  if (!convId) {
    stopAsyncRun();
    return;
  }
  const deadline = Date.now() + config.maxWallClockMin * 60_000;
  while (!cancelled && status.step < config.maxSteps) {
    if (Date.now() > deadline) break;
    const store = useStore.getState();
    if (store.activeConversationId !== convId) {
      // The user switched chats — pause autonomy on this conversation.
      // Resuming requires re-clicking "Let it run".
      break;
    }
    // Wait until the agent isn't busy (the previous turn finished).
    if (store.busy) {
      await waitForIdle();
      if (cancelled) break;
    }
    // Inspect the most recent assistant message. If it contains a
    // done signal, stop cleanly.
    const last = lastAssistantContent(store);
    if (last && hasDoneSignal(last)) break;
    if (status.step === 0 && last == null) {
      // No history yet — nothing to continue.
      break;
    }
    status = { ...status, step: status.step + 1 };
    emit();
    // Hidden user turn that nudges the agent forward. Marked hidden so
    // the chat panel doesn't render a row of "continue" bubbles.
    await sendContinueTurn();
    if (cancelled) break;
    await waitForIdle();
  }
  if (!cancelled) {
    onCompletion(convId, config);
  }
  cancelled = false;
  if (status.conversationId)
    useStore.getState().setConversationAutoMode(status.conversationId, false);
  status = { ...status, active: false };
  emit();
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    const unsub = useStore.subscribe((state, prev) => {
      if (prev.busy && !state.busy) {
        unsub();
        resolve();
      } else if (!state.busy) {
        unsub();
        resolve();
      }
    });
    setTimeout(() => {
      unsub();
      resolve();
    }, 30 * 60_000);
  });
}

async function sendContinueTurn(): Promise<void> {
  // The whole nudge goes in as the hidden preamble — no visible
  // "continue" bubble cluttering the chat. chat-controller's
  // sendMessage skips the visible-bubble append when text is empty
  // and the preamble is non-empty, so the only on-screen turn is the
  // agent's reply.
  const preamble =
    "AUTONOMOUS MODE\n\nYou are running in autonomous mode. The user has stepped away. Continue making progress on the open task. When you're done, end your reply with the literal token `(done)` on its own line so the loop knows to stop. Don't ask the user clarifying questions — make a judgement call and proceed.";
  await sendMessage("", preamble);
}

function lastAssistantContent(state: ReturnType<typeof useStore.getState>): string | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.role === "assistant" && !m.system) return m.content;
  }
  return null;
}

const DONE_RE = /\(\s*done\s*\)|<\s*done\s*\/?\s*>/i;
function hasDoneSignal(text: string): boolean {
  return DONE_RE.test(text);
}

function onCompletion(convId: string, config: AsyncConfig): void {
  const store = useStore.getState();
  const active = store.activeConversationId === convId;
  if (config.pingOnFinish && !active) {
    useStore.setState({
      conversations: store.conversations.map((c) =>
        c.id === convId ? { ...c, unread: true } : c,
      ),
    });
  }
  if (config.pingOnFinish) {
    const conv = store.conversations.find((c) => c.id === convId);
    const tg = conv?.telegramChatId;
    const last = lastAssistantContent(store);
    if (tg !== undefined && last) {
      const title = conv?.title ?? "Async chat";
      const firstLine = last.split("\n").find((l) => l.trim().length > 0) ?? "";
      const msg = `[${title}]\n${firstLine.slice(0, 280)}`;
      sendTelegramMessage(tg, msg).catch((e) =>
        console.warn("[async] telegram ping failed:", e),
      );
    }
  }
}
