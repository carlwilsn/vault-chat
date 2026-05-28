import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { keychainGet, keychainSet, keychainDelete, KEY } from "./keychain";

// Telegram bot integration. Bot token is **per-vault** so each vault
// has its own bot (school = @wada_school_bot, summer = @wada_summer_bot,
// etc.). User ID is global since it identifies the same person across
// every vault. The Rust side runs the long-poll loop for whichever
// vault is currently open; switching vaults stops the old poller and
// starts a new one with the new vault's token.

export type TelegramConfig = {
  enabled: boolean;
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
};

// Stable short hash of a vault path used to key per-vault entries
// (both keychain and localStorage). Different vaults at different
// paths get different keys; the same vault keeps the same key
// across app restarts.
function vaultSlug(vault: string): string {
  let h = 5381;
  for (let i = 0; i < vault.length; i++) {
    h = ((h * 33) ^ vault.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function vaultTokenKey(vault: string): string {
  return `vault.${vaultSlug(vault)}.telegram_bot_token`;
}

function enabledFlagKey(vault: string): string {
  return `vault_chat_telegram_enabled_${vaultSlug(vault)}`;
}

// Migration: an older version stored the bot token at a global key
// and the enabled flag at a global localStorage entry. If a vault
// doesn't have its per-vault values yet but the global ones exist,
// inherit them on first read and clear the global so we don't
// "leak" the same token into every vault.
const LEGACY_GLOBAL_TOKEN_KEY = KEY.telegram_bot_token;
const LEGACY_ENABLED_FLAG = "vault_chat_telegram_enabled";
let migrationDone = false;
async function migrateIfNeeded(vault: string): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;
  try {
    const perVaultToken = await keychainGet(vaultTokenKey(vault));
    if (!perVaultToken) {
      const legacy = await keychainGet(LEGACY_GLOBAL_TOKEN_KEY);
      if (legacy) {
        await keychainSet(vaultTokenKey(vault), legacy);
        await keychainDelete(LEGACY_GLOBAL_TOKEN_KEY);
      }
    }
    if (localStorage.getItem(enabledFlagKey(vault)) === null) {
      const legacyEnabled = localStorage.getItem(LEGACY_ENABLED_FLAG);
      if (legacyEnabled !== null) {
        localStorage.setItem(enabledFlagKey(vault), legacyEnabled);
        localStorage.removeItem(LEGACY_ENABLED_FLAG);
      }
    }
  } catch (e) {
    console.warn("[telegram] migration failed:", e);
  }
}

export function readTelegramEnabled(vault: string | null): boolean {
  if (!vault) return false;
  return localStorage.getItem(enabledFlagKey(vault)) === "true";
}

export function writeTelegramEnabled(vault: string, v: boolean): void {
  localStorage.setItem(enabledFlagKey(vault), String(v));
}

export async function getTelegramCredentials(vault: string | null): Promise<{
  token: string | null;
  userId: string | null;
}> {
  if (!vault) {
    const userId = await keychainGet(KEY.telegram_user_id);
    return { token: null, userId };
  }
  await migrateIfNeeded(vault);
  const [token, userId] = await Promise.all([
    keychainGet(vaultTokenKey(vault)),
    keychainGet(KEY.telegram_user_id),
  ]);
  return { token, userId };
}

export async function setTelegramCredentials(
  vault: string,
  token: string,
  userId: string,
): Promise<void> {
  await keychainSet(vaultTokenKey(vault), token);
  await keychainSet(KEY.telegram_user_id, userId);
}

export async function clearTelegramCredentials(vault: string): Promise<void> {
  // Only clear the per-vault token; user ID stays since it's shared
  // across all vaults (same person on Telegram).
  await keychainDelete(vaultTokenKey(vault));
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

export async function startTelegramService(vault: string): Promise<void> {
  await ensureListeners();
  const { token, userId } = await getTelegramCredentials(vault);
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
  vault: string,
  chatId: number,
  text: string,
): Promise<void> {
  const { token } = await getTelegramCredentials(vault);
  if (!token) throw new Error("telegram: no bot token configured for this vault");
  await invoke("telegram_send_message", { botToken: token, chatId, text });
}

export async function refreshTelegramSnapshot(
  vault: string | null,
): Promise<TelegramSnapshot> {
  const { token, userId } = await getTelegramCredentials(vault);
  const running = await invoke<boolean>("telegram_running").catch(() => false);
  snapshot = {
    ...snapshot,
    hasCredentials: !!(token && userId),
    running,
  };
  emitStatus();
  return snapshot;
}
