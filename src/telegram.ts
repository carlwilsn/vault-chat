import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { keychainGet, keychainSet, keychainDelete, KEY } from "./keychain";

// Telegram bot integration. Credentials live in the OS keychain
// (token + allowed user_id). The Rust side runs the long-poll loop;
// the frontend listens for `telegram:message` events and routes them
// into the conversations store.

export type TelegramConfig = {
  enabled: boolean;
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
};

const ENABLED_FLAG = "vault_chat_telegram_enabled";

export function readTelegramEnabled(): boolean {
  return localStorage.getItem(ENABLED_FLAG) === "true";
}

export function writeTelegramEnabled(v: boolean): void {
  localStorage.setItem(ENABLED_FLAG, String(v));
}

export async function getTelegramCredentials(): Promise<{
  token: string | null;
  userId: string | null;
}> {
  const [token, userId] = await Promise.all([
    keychainGet(KEY.telegram_bot_token),
    keychainGet(KEY.telegram_user_id),
  ]);
  return { token, userId };
}

export async function setTelegramCredentials(
  token: string,
  userId: string,
): Promise<void> {
  await keychainSet(KEY.telegram_bot_token, token);
  await keychainSet(KEY.telegram_user_id, userId);
}

export async function clearTelegramCredentials(): Promise<void> {
  await keychainDelete(KEY.telegram_bot_token);
  await keychainDelete(KEY.telegram_user_id);
}

export type TelegramInbound = {
  chat_id: number;
  from_user_id: number;
  from_username: string | null;
  text: string;
  message_id: number;
  timestamp: number;
};

export type TelegramStatusEvent = {
  running: boolean;
  bot_username: string | null;
  error: string | null;
};

export type TelegramSnapshot = {
  running: boolean;
  botUsername: string | null;
  error: string | null;
  hasCredentials: boolean;
};

let snapshot: TelegramSnapshot = {
  running: false,
  botUsername: null,
  error: null,
  hasCredentials: false,
};

const statusListeners = new Set<(s: TelegramSnapshot) => void>();
const inboundListeners = new Set<(m: TelegramInbound) => void>();

function emitStatus() {
  for (const l of statusListeners) l(snapshot);
}

export function subscribeTelegramStatus(
  fn: (s: TelegramSnapshot) => void,
): () => void {
  statusListeners.add(fn);
  fn(snapshot);
  return () => statusListeners.delete(fn);
}

export function subscribeTelegramInbound(
  fn: (m: TelegramInbound) => void,
): () => void {
  inboundListeners.add(fn);
  return () => inboundListeners.delete(fn);
}

export function getTelegramSnapshot(): TelegramSnapshot {
  return snapshot;
}

let unlistenStatus: UnlistenFn | null = null;
let unlistenMessage: UnlistenFn | null = null;

async function ensureListeners(): Promise<void> {
  if (unlistenStatus && unlistenMessage) return;
  unlistenStatus = await listen<TelegramStatusEvent>("telegram:status", (e) => {
    snapshot = {
      ...snapshot,
      running: e.payload.running,
      botUsername: e.payload.bot_username ?? snapshot.botUsername,
      error: e.payload.error,
    };
    emitStatus();
  });
  unlistenMessage = await listen<TelegramInbound>("telegram:message", (e) => {
    for (const l of inboundListeners) l(e.payload);
  });
}

export async function startTelegramService(): Promise<void> {
  await ensureListeners();
  const { token, userId } = await getTelegramCredentials();
  snapshot = { ...snapshot, hasCredentials: !!(token && userId) };
  emitStatus();
  if (!token || !userId) {
    snapshot = {
      ...snapshot,
      running: false,
      error: "missing credentials",
    };
    emitStatus();
    return;
  }
  try {
    await invoke("telegram_start", { botToken: token, userId });
  } catch (e) {
    snapshot = { ...snapshot, running: false, error: String(e) };
    emitStatus();
  }
}

export async function stopTelegramService(): Promise<void> {
  try {
    await invoke("telegram_stop");
  } catch (e) {
    console.warn("[telegram] stop failed:", e);
  }
  snapshot = { ...snapshot, running: false };
  emitStatus();
}

export async function testTelegramConnection(token: string): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const name = await invoke<string>("telegram_test", { botToken: token });
    return { ok: true, message: name };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
): Promise<void> {
  const { token } = await getTelegramCredentials();
  if (!token) throw new Error("telegram: no bot token configured");
  await invoke("telegram_send_message", { botToken: token, chatId, text });
}

export async function refreshTelegramSnapshot(): Promise<TelegramSnapshot> {
  const { token, userId } = await getTelegramCredentials();
  const running = await invoke<boolean>("telegram_running").catch(() => false);
  snapshot = {
    ...snapshot,
    hasCredentials: !!(token && userId),
    running,
  };
  emitStatus();
  return snapshot;
}
