// [sync split] Mission-host relay. On a follower checkout (a content-writer
// machine — see lib.rs is_sync_follower), mission/worker/ask threads are owned
// by the mission host (the box). Typing into one here must NOT run a local
// executor turn: this machine may not author mission state (the sanitize pass
// would discard it) and the box would grind the same mission in parallel.
// Instead the message relays to the host's cockpit over HTTP — byte-for-byte
// the phone's contract (/message, /answer). The box appends the turn, its reply
// syncs back via git, and the local copy converges to the box's thread.
//
// A vault whose `.vault-chat/sync.json` names a box is always a follower, and
// the box URL comes from there: no token is needed through tailscale serve
// (the tailnet identity is the auth). A token set under Settings → Mission
// host is still sent when present. The POST goes through the engine
// (`box_post_json`) so the webview's CORS rules never apply.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { readBoxConfig } from "./vaultSync";

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

type Host = { url: string; token: string };

/** Where this vault's missions run: the sync.json box, else the URL + token
 *  from Settings → Mission host. Null when neither is set. */
export async function missionHostFor(vault: string | null): Promise<Host | null> {
  const s = useStore.getState();
  const box = vault ? await readBoxConfig(vault) : null;
  if (box) return { url: box.box, token: s.missionHostToken };
  if (s.missionHostUrl && s.missionHostToken) {
    return { url: s.missionHostUrl.replace(/\/+$/, ""), token: s.missionHostToken };
  }
  return null;
}

export async function missionHostConfigured(vault?: string | null): Promise<boolean> {
  return !!(await missionHostFor(vault ?? useStore.getState().vaultPath));
}

function newClientMsgId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** POST a phone-route payload to the mission host. */
async function postToHost(
  route: "/message" | "/answer",
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const host = await missionHostFor(useStore.getState().vaultPath);
  if (!host) return { ok: false, error: "no mission host configured" };
  try {
    const r = await invoke<{ status: number; body: string }>("box_post_json", {
      url: `${host.url}${route}`,
      body: JSON.stringify(payload),
      token: host.token || null,
    });
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(r.body) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    if (r.status < 200 || r.status >= 300 || d.error) {
      return {
        ok: false,
        error: String(d.error || `HTTP ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ""}`),
      };
    }
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Relay one message to the mission host, exactly like the phone's send. */
export async function relayMissionMessage(
  convId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  return postToHost("/message", { convId, text, clientMsgId: newClientMsgId("relay") });
}

/** Relay an answer to a mission that is waiting on Carl (AWAITING_USER) —
 *  the phone's tagged /answer, the only thing that resumes it on the box. */
export async function relayMissionAnswer(
  convId: string,
  text: string,
  extra?: { notifId?: string; askConvId?: string },
): Promise<{ ok: boolean; error?: string }> {
  return postToHost("/answer", {
    convId,
    text,
    clientMsgId: newClientMsgId("answer"),
    ...(extra?.notifId ? { notifId: extra.notifId } : {}),
    ...(extra?.askConvId ? { askConvId: extra.askConvId } : {}),
  });
}

/** Start an approved mission on the host — the phone's approval payload,
 *  `{mission:{title, goal}}` to /message. */
export async function relayStartMission(
  title: string,
  goal: string,
): Promise<{ ok: boolean; error?: string; convId?: string }> {
  const r = await postToHost("/message", { mission: { title, goal } });
  return {
    ok: r.ok,
    error: r.error,
    convId: typeof r.data?.convId === "string" ? r.data.convId : undefined,
  };
}

/** Approve a mission card: on a follower vault (a box is configured) the
 *  mission starts on the box; otherwise it starts here, as before. */
export async function approveMission(
  vault: string,
  goal: string,
  title: string,
): Promise<{ id?: string; relayed: boolean }> {
  if (await isFollowerVault(vault)) {
    const r = await relayStartMission(title, goal);
    if (!r.ok) throw new Error(`Couldn't start the mission on the box: ${r.error}`);
    return { id: r.convId, relayed: true };
  }
  const { startMission } = await import("./offVaultRun");
  const { id } = await startMission(vault, goal, title);
  return { id, relayed: false };
}
