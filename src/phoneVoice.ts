// Phone voice host. The box runs vault-chat 24/7; this keeps an always-ready
// HTTP server up (see src-tauri/src/voice_server.rs) and pushes the live voice
// context into it on a heartbeat. The user just opens the box's link on their
// phone, taps to talk, and is live — brain on the box, mic/speaker on the phone.
//
// The server only mints a session when context is present, so starting it
// before a vault/key exists is harmless (it answers 503 until ready).

import { invoke } from "@tauri-apps/api/core";
import { buildPhoneVoiceContext } from "./voice-elevenlabs";

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
  await pushContext();
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
