// Phone voice host. The box runs vault-chat 24/7; this keeps an always-ready
// HTTP server up (see src-tauri/src/voice_server.rs) and pushes the live voice
// context into it on a heartbeat. The user just opens the box's link on their
// phone, taps to talk, and is live — brain on the box, mic/speaker on the phone.
//
// The server only mints a session when context is present, so starting it
// before a vault/key exists is harmless (it answers 503 until ready).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildPhoneVoiceContext, buildClientToolHandlers } from "./voice-elevenlabs";
import { useStore } from "./store";

// The box relays each phone tool call here; we run the EXACT same handler the
// desktop voice agent uses (full parity — file ops, git, schedules, etc.) and
// hand the result back by request id.
let toolRelayWired = false;
async function wireToolRelay(): Promise<void> {
  if (toolRelayWired) return;
  toolRelayWired = true;
  await listen<{ reqId: string; name: string; arguments: unknown }>("voice:tool", async (event) => {
    const { reqId, name, arguments: args } = event.payload;
    let result = "";
    try {
      const handlers = buildClientToolHandlers() as Record<string, (p: unknown) => unknown>;
      const fn = handlers[name];
      if (!fn) {
        result = `error: tool "${name}" is not available`;
      } else {
        const r = await fn(args);
        result = r == null ? "" : typeof r === "string" ? r : JSON.stringify(r);
      }
    } catch (e) {
      result = "error: " + String(e);
    }
    await invoke("voice_tool_respond", { reqId, result }).catch(() => {});
  });
  // On-demand context: the box asks for FRESH context at /session time (kills
  // the 503 push-timing window; the phone connects with the current document
  // state). Empty result → the box falls back to its cached push / 503s.
  await listen<{ reqId: string }>("voice:context", async (event) => {
    const { reqId } = event.payload;
    let result = "";
    try {
      const ctx = await buildPhoneVoiceContext();
      if (ctx) result = JSON.stringify(ctx);
    } catch {
      /* answer empty — box falls back */
    }
    await invoke("voice_tool_respond", { reqId, result }).catch(() => {});
  });
}

// Fixed port so the link is stable. High, unprivileged, unlikely to clash.
const PORT = 8848;
const TOKEN_KEY = "vault_chat_phone_voice_token";

/** Stable per-machine secret. Generated once; part of the phone link. */
function getToken(): string {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    t = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

let started = false;

async function pushContext(): Promise<void> {
  try {
    const ctx = await buildPhoneVoiceContext();
    if (!ctx) return; // no vault/key yet — try again next beat
    await invoke("voice_set_context", {
      elKey: ctx.elKey,
      agentId: ctx.agentId,
      voiceId: ctx.voiceId,
      systemPrompt: ctx.systemPrompt,
      dynamicVars: ctx.dynamicVariables,
      toolNames: ctx.toolNames,
      vault: ctx.vault,
    });
  } catch (e) {
    console.warn("[phone-voice] context push failed:", e);
  }
}

/** Start the always-ready phone-voice host: the server + a context heartbeat. */
export async function startPhoneVoiceHost(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await invoke("voice_server_start", { port: PORT, token: getToken() });
  } catch (e) {
    console.warn("[phone-voice] server start failed:", e);
    started = false;
    return;
  }
  await wireToolRelay();
  await pushContext();
  // Push the instant the vault opens/switches or the ElevenLabs key changes —
  // that's the moment the host first has something to serve, and waiting for the
  // next heartbeat is exactly what caused the phone's transient 503s.
  let lastVault = useStore.getState().vaultPath;
  let lastKey = useStore.getState().serviceKeys.elevenlabs;
  useStore.subscribe((s) => {
    if (s.vaultPath !== lastVault || s.serviceKeys.elevenlabs !== lastKey) {
      lastVault = s.vaultPath;
      lastKey = s.serviceKeys.elevenlabs;
      void pushContext();
    }
  });
  // Heartbeat backstop (e.g. the agent/context drifts during a long session).
  window.setInterval(() => {
    void pushContext();
  }, 20_000);
}

/**
 * The phone link to show in Settings: this machine's Tailscale URL + the token.
 * Null when Tailscale isn't reachable (the user can still use the box hostname).
 */
export async function getPhoneVoiceLink(): Promise<string | null> {
  try {
    const base = await invoke<string | null>("voice_server_url", { port: PORT });
    if (!base) return null;
    return `${base}/voice?token=${getToken()}`;
  } catch {
    return null;
  }
}
