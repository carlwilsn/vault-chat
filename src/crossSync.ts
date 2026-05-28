import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Conversation } from "./conversations";
import { ensureVaultId, readVaultId } from "./vaultId";

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
  // Ensure this vault has a stable id and register it with the local
  // daemon state map. The daemon may not be running yet — registration
  // is idempotent and lives in a separate static, so daemon_start
  // later picks it up automatically.
  try {
    const id = await ensureVaultId(vault);
    await invoke("daemon_register_vault", { vaultId: id, vaultPath: vault });
  } catch (e) {
    console.warn("[crosssync] vault registration failed:", e);
  }
  if (config.mode === "daemon") {
    try {
      await invoke("daemon_start", { listen: config.daemonListen });
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

// Indicates the daemon doesn't know this vault. Caller should fall
// back to local disk rather than treating it as a hard failure.
export class DaemonVaultNotFound extends Error {
  constructor(public vaultId: string) {
    super(`daemon does not serve vault id ${vaultId}`);
    this.name = "DaemonVaultNotFound";
  }
}

// Client-side: fetch the remote conversations snapshot for a
// specific vault. Used by readConversations when mode === "client".
// Throws DaemonVaultNotFound if the daemon doesn't know this vault
// — caller falls back to local disk.
export async function clientFetchConversations(
  vault: string,
): Promise<Conversation[]> {
  const url = getClientDaemonUrl();
  if (!url) throw new Error("daemon URL not configured");
  const id = await readVaultId(vault);
  if (!id) {
    // No id locally yet → can't ask the daemon for it. Caller falls
    // back to local disk; an id will be generated and propagated via
    // git auto-sync over time.
    throw new DaemonVaultNotFound("(no local vault-id)");
  }
  const res = await fetch(
    stripSlash(url) + `/vaults/${encodeURIComponent(id)}/conversations`,
  );
  if (res.status === 404) throw new DaemonVaultNotFound(id);
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
  vault: string,
  conversations: Conversation[],
): Promise<void> {
  const url = getClientDaemonUrl();
  if (!url) throw new Error("daemon URL not configured");
  const id = await readVaultId(vault);
  if (!id) throw new DaemonVaultNotFound("(no local vault-id)");
  const lines = conversations.map((c) => JSON.stringify(c));
  const res = await fetch(
    stripSlash(url) + `/vaults/${encodeURIComponent(id)}/conversations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lines),
    },
  );
  if (res.status === 404) throw new DaemonVaultNotFound(id);
  if (!res.ok) throw new Error(`daemon ${res.status}`);
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
