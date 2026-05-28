import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Conversation } from "./conversations";

// Cross-machine sync. One machine runs in "daemon" mode (HTTP server
// hosting conversations.jsonl); other machines connect as "client",
// pulling the snapshot and pushing local edits back.
//
// Standalone mode is the default — both knobs off, app behaves
// exactly like before.

export type CrossSyncMode = "standalone" | "daemon" | "client";

export type CrossSyncConfig = {
  mode: CrossSyncMode;
  daemonListen: string;
  tailscaleHostname: string;
  daemonUrl: string;
};

export const DEFAULT_CROSS_SYNC_CONFIG: CrossSyncConfig = {
  mode: "standalone",
  daemonListen: "0.0.0.0:4173",
  tailscaleHostname: "",
  daemonUrl: "",
};

const STORAGE = "vault_chat_cross_sync";

export function readCrossSyncConfig(): CrossSyncConfig {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return DEFAULT_CROSS_SYNC_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CrossSyncConfig>;
    return { ...DEFAULT_CROSS_SYNC_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CROSS_SYNC_CONFIG;
  }
}

export function writeCrossSyncConfig(patch: Partial<CrossSyncConfig>): CrossSyncConfig {
  const current = readCrossSyncConfig();
  const merged = { ...current, ...patch };
  localStorage.setItem(STORAGE, JSON.stringify(merged));
  return merged;
}

export type CrossSyncSnapshot = {
  mode: CrossSyncMode;
  running: boolean;
  clients: number;
  listen: string | null;
  error: string | null;
  tailscaleHostname: string | null;
};

let snapshot: CrossSyncSnapshot = {
  mode: "standalone",
  running: false,
  clients: 0,
  listen: null,
  error: null,
  tailscaleHostname: null,
};
const listeners = new Set<(s: CrossSyncSnapshot) => void>();

function emit() {
  for (const l of listeners) l(snapshot);
}

export function subscribeCrossSyncStatus(
  fn: (s: CrossSyncSnapshot) => void,
): () => void {
  listeners.add(fn);
  fn(snapshot);
  return () => listeners.delete(fn);
}

let unlisten: UnlistenFn | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<{
    running: boolean;
    clients: number;
    listen: string | null;
    error: string | null;
  }>("daemon:status", (e) => {
    snapshot = {
      ...snapshot,
      running: e.payload.running,
      clients: e.payload.clients,
      listen: e.payload.listen,
      error: e.payload.error,
    };
    emit();
  });
}

export async function startCrossSync(vault: string): Promise<void> {
  await ensureListener();
  const config = readCrossSyncConfig();
  snapshot = { ...snapshot, mode: config.mode };
  emit();
  if (config.mode === "daemon") {
    try {
      await invoke("daemon_start", { listen: config.daemonListen, vault });
    } catch (e) {
      snapshot = { ...snapshot, error: String(e), running: false };
      emit();
    }
  } else if (config.mode === "client") {
    // Client mode pulls the daemon's snapshot on demand. The conversations
    // store sync calls in the store look at the snapshot below to decide
    // whether to fetch remotely instead of writing locally.
    if (!config.daemonUrl) {
      snapshot = { ...snapshot, error: "daemon URL not configured" };
      emit();
    }
  }
}

export async function stopCrossSync(): Promise<void> {
  await invoke("daemon_stop").catch(() => {});
  snapshot = { ...snapshot, running: false, clients: 0 };
  emit();
}

export async function probeTailscaleHostname(): Promise<string | null> {
  try {
    return await invoke<string | null>("tailscale_hostname");
  } catch {
    return null;
  }
}

export function isClientMode(): boolean {
  return readCrossSyncConfig().mode === "client";
}

export function getClientDaemonUrl(): string {
  return readCrossSyncConfig().daemonUrl;
}

// Client-side: fetch the remote conversations snapshot. Used by the
// frontend when mode === "client" instead of reading local disk.
export async function clientFetchConversations(): Promise<Conversation[]> {
  const url = getClientDaemonUrl();
  if (!url) throw new Error("daemon URL not configured");
  const res = await fetch(stripSlash(url) + "/conversations");
  if (!res.ok) throw new Error(`daemon ${res.status}`);
  const lines = (await res.json()) as string[];
  const out: Conversation[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Conversation;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // skip
    }
  }
  return out;
}

export async function clientPushConversations(
  conversations: Conversation[],
): Promise<void> {
  const url = getClientDaemonUrl();
  if (!url) throw new Error("daemon URL not configured");
  const lines = conversations.map((c) => JSON.stringify(c));
  const res = await fetch(stripSlash(url) + "/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(lines),
  });
  if (!res.ok) throw new Error(`daemon ${res.status}`);
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
