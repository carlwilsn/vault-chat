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

// Cheaper-default model for Telegram runs. The agent in a Telegram
// chat doesn't need to do heavy reasoning — short replies, light
// tool use. Default Haiku 4.5 keeps cost down for recurring
// schedules (daily briefs, hourly polls). User can override in
// Settings → Telegram. Global, not per-vault — your phone is the
// same constraint regardless of which vault is responding.
const TELEGRAM_MODEL_KEY = "vault_chat_telegram_model";
export const DEFAULT_TELEGRAM_MODEL = "claude-haiku-4-5-20251001";

export function getTelegramModelId(): string {
  const raw = localStorage.getItem(TELEGRAM_MODEL_KEY) ?? DEFAULT_TELEGRAM_MODEL;
  // Migrate the bare-alias I shipped in the previous Telegram-model
  // commit to the catalog-correct dated id, so findModel resolves it.
  // Without this, anyone who saved the broken default in localStorage
  // before this fix would silently get no replies until they reset.
  if (raw === "claude-haiku-4-5") return "claude-haiku-4-5-20251001";
  return raw;
}

export function setTelegramModelId(modelId: string): void {
  localStorage.setItem(TELEGRAM_MODEL_KEY, modelId);
}

export type TelegramInbound = {
  chat_id: number;
  from_user_id: number;
  from_username: string | null;
  text: string;
  message_id: number;
  timestamp: number;
  vault_id: string;
  photo_file_ids: string[];
};

// Download a Telegram photo by file_id and save it inside the
// target vault. Returns the absolute path. Caller can read the
// bytes and build a ChatAttachment with imageDataUrl + capturedFilePath.
export async function downloadTelegramPhoto(
  vault: string,
  fileId: string,
): Promise<string> {
  const { token } = await getTelegramCredentials(vault);
  if (!token) throw new Error("telegram: no bot token configured for this vault");
  return await invoke<string>("telegram_download_file", {
    botToken: token,
    fileId,
    vault,
  });
}

// Build a ChatAttachment from a downloaded image file. Reads the
// bytes via read_binary_file and encodes as a base64 data URL.
export async function readImageAsAttachment(
  absPath: string,
): Promise<{ imageDataUrl: string; capturedFilePath: string }> {
  const bytes = await invoke<number[]>("read_binary_file", { path: absPath });
  // Telegram defaults to jpeg for downsized photo sizes; cheap mime
  // sniff on the magic bytes catches png/jpeg/webp without us
  // shipping a real decoder.
  const mime = sniffImageMime(bytes);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  return {
    imageDataUrl: `data:${mime};base64,${b64}`,
    capturedFilePath: absPath,
  };
}

function sniffImageMime(bytes: number[]): string {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return "image/webp";
    }
  }
  return "image/jpeg";
}

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

export async function sendTelegramPhoto(
  vault: string,
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<void> {
  const { token } = await getTelegramCredentials(vault);
  if (!token) throw new Error("telegram: no bot token configured for this vault");
  await invoke("telegram_send_photo", {
    botToken: token,
    chatId,
    filePath,
    caption: caption ?? null,
  });
}

// Pull markdown image references out of an assistant reply so we can
// upload them as Telegram photos instead of letting them ship as
// literal `![alt](path)` text. Returns the cleaned text plus the
// list of (alt, path) tuples to upload separately.
export function extractTelegramImages(
  reply: string,
): { text: string; images: { alt: string; path: string }[] } {
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const images: { alt: string; path: string }[] = [];
  const text = reply.replace(re, (_match, alt: string, path: string) => {
    images.push({ alt: alt.trim(), path: path.trim() });
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), images };
}

// Resolve an agent-emitted path against the vault root. The agent
// might write absolute paths, paths relative to the vault root, or
// (rarely) bare filenames. We try absolute first, then vault-rooted.
// Returns the first one that exists on disk, or null if neither
// resolves to a real file.
export async function resolveImagePathForTelegram(
  vault: string,
  path: string,
): Promise<string | null> {
  const candidates: string[] = [];
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbsolute) {
    candidates.push(path);
  } else {
    candidates.push(`${vault}/${path}`);
    candidates.push(`${vault}/${path.replace(/^\.\//, "")}`);
  }
  for (const p of candidates) {
    try {
      const exists = await invoke<boolean>("path_exists", { path: p });
      if (exists) return p;
    } catch {
      // path_exists not available or threw — try next candidate
    }
  }
  return null;
}

// Split a markdown table row into trimmed cells, dropping the empty
// cells that leading/trailing pipes produce.
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

// A markdown table's delimiter row, e.g. `|---|:--:|`. Must contain a
// pipe (so a bare `---` horizontal rule isn't mistaken for one) and
// every cell must be only dashes/colons.
function isTableDelimiter(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

// Telegram renders no markdown tables — a `| a | b |` grid arrives as
// raw pipe-and-dash mush, and column alignment is hopeless on a phone
// anyway. Convert each table into labeled `Header: value` blocks (one
// block per data row), which reads cleanly at any width. Runs before
// the inline strips so cell contents (bold, links) get cleaned after.
function tablesToText(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (header?.includes("|") && delim !== undefined && isTableDelimiter(delim)) {
      const headers = splitTableRow(header);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      if (rows.length === 0) {
        // Header-only table — just emit its cells as one line.
        out.push(headers.filter(Boolean).join(" — "));
      } else {
        const blocks = rows.map((cells) =>
          headers
            .map((h, k) => {
              const v = (cells[k] ?? "").trim();
              if (!v) return null;
              return h ? `${h}: ${v}` : v;
            })
            .filter(Boolean)
            .join("\n"),
        );
        out.push(blocks.join("\n\n"));
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

// Strip markdown syntax from text destined for Telegram. Even with
// "plain text only" in the system prompt, smaller models (Haiku) emit
// markdown anyway; without this the phone sees literal asterisks /
// hashes / backticks. Catches the common shapes — perfect parsing
// not required, just less-broken output than raw.
export function stripMarkdownForTelegram(text: string): string {
  // Tables first: turn each grid into labeled per-row blocks while the
  // pipe/delimiter structure is still intact. The inline strips below
  // then clean any markdown inside the cells.
  let s = tablesToText(text);
  // Code fences: keep the inner code, drop the fence + language tag.
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) => code.trim());
  // Inline code `foo` → foo
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Bold **foo** / __foo__ → foo
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  // Italic *foo* / _foo_ → foo. Apply after bold so we don't munch
  // bold's leftover singletons.
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1$2");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1$2");
  // ATX headers `# foo`, `## foo` → foo
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Blockquote `> foo` → foo
  s = s.replace(/^>\s+/gm, "");
  // Unordered list `- foo` / `* foo` / `+ foo` → • foo (one bullet
  // char is more telegram-friendly than dropping it entirely, since
  // it preserves the list visually)
  s = s.replace(/^[\s]*[-*+]\s+/gm, "• ");
  // Ordered list `1. foo` → 1. foo (leave alone — looks fine plain)
  // Links [text](url) → text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
    // Skip the image syntax — those should already be extracted
    // before this runs.
    label.startsWith("!") ? "" : `${label} (${url})`,
  );
  // Collapse extra blank lines that the strips may have left behind.
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Convenience: take an agent's full reply text, split out any image
// references, upload them as photos, strip markdown from the
// remaining text, and send it as a regular message.
export async function sendTelegramReplyWithImages(
  vault: string,
  chatId: number,
  reply: string,
): Promise<void> {
  const { text, images } = extractTelegramImages(reply);
  for (const img of images) {
    const resolved = await resolveImagePathForTelegram(vault, img.path);
    if (!resolved) {
      console.warn(
        `[telegram] image not found, falling back to text: ${img.path}`,
      );
      await sendTelegramMessage(
        vault,
        chatId,
        `(image not found: ${img.path})`,
      ).catch(() => {});
      continue;
    }
    await sendTelegramPhoto(vault, chatId, resolved, img.alt).catch((e) =>
      console.warn(`[telegram] photo upload failed for ${resolved}:`, e),
    );
  }
  if (text) {
    await sendTelegramMessage(vault, chatId, stripMarkdownForTelegram(text));
  }
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
