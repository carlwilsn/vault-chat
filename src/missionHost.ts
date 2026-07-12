// [sync split] Mission-host relay. On a follower checkout (a content-writer
// machine — see lib.rs is_sync_follower), mission/worker/ask threads are owned
// by the mission host (the box). Typing into one here must NOT run a local
// executor turn: this machine may not author mission state (the sanitize pass
// would discard it) and the box would grind the same mission in parallel.
// Instead the message relays to the host's cockpit over HTTP — byte-for-byte
// the phone's contract (/message + X-Vault-Token). The box appends the turn,
// its reply syncs back via git, and the local optimistic copy converges to the
// box's canonical thread on the next pull.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";

const roleCache = new Map<string, { role: string; at: number }>();

/** Is this vault checkout a follower (content writer, not mission host)?
 *  Cached for a minute — the role marker is a per-checkout constant. */
export async function isFollowerVault(vault: string): Promise<boolean> {
  const hit = roleCache.get(vault);
  if (hit && Date.now() - hit.at < 60_000) return hit.role === "follower";
  let role = "writer";
  try {
    role = await invoke<string>("vault_sync_role", { vault });
  } catch {
    /* treat as writer — the safe default matches the box */
  }
  roleCache.set(vault, { role, at: Date.now() });
  return role === "follower";
}

export function missionHostConfigured(): boolean {
  const s = useStore.getState();
  return !!(s.missionHostUrl && s.missionHostToken);
}

/** Relay one message to the mission host, exactly like the phone's send. */
export async function relayMissionMessage(
  convId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const s = useStore.getState();
  if (!s.missionHostUrl || !s.missionHostToken) return { ok: false, error: "no mission host configured" };
  try {
    const clientMsgId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const r = await fetch(`${s.missionHostUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vault-Token": s.missionHostToken },
      body: JSON.stringify({ convId, text, clientMsgId }),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: unknown };
    if (!r.ok || d.error) return { ok: false, error: String(d.error || r.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
