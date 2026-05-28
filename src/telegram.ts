import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { keychainGet, keychainSet, keychainDelete, KEY } from "./keychain";

// Telegram bot integration — per-vault. Each vault has its own bot;
// the Rust side runs one long-polling task per (bot_token, vault)
// pair simultaneously, so multiple vaults' bots can be active at
// once regardless of which vault has the UI's current focus.
//
// Inbound `telegram:message` events are tagged with vault_id so the
// JS handler can route the message to the right vault's
// conversations even when that vault isn't the one open in the UI.

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

// Registry of all vaults that have ever turned telegram on, so the
// app can start their pollers on launch without having to open each
// vault. Maintained as a JSON array of vault paths in localStorage.
const ENABLED_VAULTS_REGISTRY = "vault_chat_telegram_enabled_vaults";

export function getEnabledTelegramVaults(): string[] {
  try {
    const raw = localStorage.getItem(ENABLED_VAULTS_REGISTRY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function setEnabledTelegramVaults(list: string[]): void {
  localStorage.setItem(ENABLED_VAULTS_REGISTRY, JSON.stringify(list));
}

function addEnabledVault(vault: string): void {
  const list = getEnabledTelegramVaults();
  if (!list.includes(vault)) {
    setEnabledTelegramVaults([...list, vault]);
  }
}

function removeEnabledVault(vault: string): void {
  setEnabledTelegramVaults(getEnabledTelegramVaults().filter((v) => v !== vault));
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
        if (legacyEnabled === "true") addEnabledVault(vault);
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
  if (v) addEnabledVault(vault);
  else removeEnabledVault(vault);
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
  vault_id: string;
};

export type TelegramStatusEvent = {
  running: boolean;
  bot_username: string | null;
  error: string | null;
  vault_id: string;
};

export type TelegramSnapshot = {
  running: boolean;
  botUsername: string | null;
  error: string | null;
  hasCredentials: boolean;
};

const DEFAULT_SNAPSHOT: TelegramSnapshot = {
  running: false,
  botUsername: null,
  error: null,
  hasCredentials: false,
};

// Per-vault snapshot cache. Subscribers register against a specific
// vault and only get updates for that vault.
const snapshots = new Map<string, TelegramSnapshot>();
const statusListeners = new Map<string, Set<(s: TelegramSnapshot) => void>>();
const inboundListeners = new Set<(m: TelegramInbound) => void>();

function emitStatus(vault: string) {
  const snap = snapshots.get(vault) ?? DEFAULT_SNAPSHOT;
  const set = statusListeners.get(vault);
  if (set) for (const fn of set) fn(snap);
}

function patchSnapshot(vault: string, patch: Partial<TelegramSnapshot>) {
  const current = snapshots.get(vault) ?? DEFAULT_SNAPSHOT;
  snapshots.set(vault, { ...current, ...patch });
  emitStatus(vault);
}

export function subscribeTelegramStatus(
  vault: string | null,
  fn: (s: TelegramSnapshot) => void,
): () => void {
  if (!vault) {
    fn(DEFAULT_SNAPSHOT);
    return () => {};
  }
  let set = statusListeners.get(vault);
  if (!set) {
    set = new Set();
    statusListeners.set(vault, set);
  }
  set.add(fn);
  fn(snapshots.get(vault) ?? DEFAULT_SNAPSHOT);
  return () => {
    set?.delete(fn);
  };
}

export function subscribeTelegramInbound(
  fn: (m: TelegramInbound) => void,
): () => void {
  inboundListeners.add(fn);
  return () => inboundListeners.delete(fn);
}

export function getTelegramSnapshot(vault: string | null): TelegramSnapshot {
  if (!vault) return DEFAULT_SNAPSHOT;
  return snapshots.get(vault) ?? DEFAULT_SNAPSHOT;
}

let unlistenStatus: UnlistenFn | null = null;
let unlistenMessage: UnlistenFn | null = null;

async function ensureListeners(): Promise<void> {
  if (unlistenStatus && unlistenMessage) return;
  unlistenStatus = await listen<TelegramStatusEvent>("telegram:status", (e) => {
    const v = e.payload.vault_id;
    if (!v) return;
    patchSnapshot(v, {
      running: e.payload.running,
      botUsername: e.payload.bot_username ?? snapshots.get(v)?.botUsername ?? null,
      error: e.payload.error,
    });
  });
  unlistenMessage = await listen<TelegramInbound>("telegram:message", (e) => {
    for (const l of inboundListeners) l(e.payload);
  });
}

export async function startTelegramService(vault: string): Promise<void> {
  await ensureListeners();
  const { token, userId } = await getTelegramCredentials(vault);
  patchSnapshot(vault, { hasCredentials: !!(token && userId) });
  if (!token || !userId) {
    patchSnapshot(vault, { running: false, error: "missing credentials" });
    return;
  }
  try {
    await invoke("telegram_start", {
      botToken: token,
      userId,
      vaultId: vault,
    });
  } catch (e) {
    patchSnapshot(vault, { running: false, error: String(e) });
  }
}

export async function stopTelegramService(vault: string | null): Promise<void> {
  // null vault = stop everything; useful at app shutdown.
  if (!vault) {
    try {
      await invoke("telegram_stop", { botToken: null });
    } catch (e) {
      console.warn("[telegram] stop-all failed:", e);
    }
    for (const v of snapshots.keys()) patchSnapshot(v, { running: false });
    return;
  }
  const { token } = await getTelegramCredentials(vault);
  try {
    await invoke("telegram_stop", { botToken: token ?? null });
  } catch (e) {
    console.warn("[telegram] stop failed:", e);
  }
  patchSnapshot(vault, { running: false });
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
  if (!vault) return DEFAULT_SNAPSHOT;
  const { token, userId } = await getTelegramCredentials(vault);
  const running = await invoke<boolean>("telegram_running", {
    botToken: token ?? null,
  }).catch(() => false);
  patchSnapshot(vault, { hasCredentials: !!(token && userId), running });
  return snapshots.get(vault) ?? DEFAULT_SNAPSHOT;
}
