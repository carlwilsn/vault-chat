// Phone voice host. The box runs vault-chat 24/7; this keeps an always-ready
// HTTP server up (see src-tauri/src/voice_server.rs) and pushes the live voice
// context into it on a heartbeat. The user just opens the box's link on their
// phone, taps to talk, and is live — brain on the box, mic/speaker on the phone.
//
// The server only mints a session when context is present, so starting it
// before a vault/key exists is harmless (it answers 503 until ready).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildPhoneVoiceContext, buildClientToolHandlers, ensureVoiceConversation } from "./voice-elevenlabs";
import { useStore } from "./store";
import { vlog } from "./debugLog";

// The box relays each phone tool call here; we run the EXACT same handler the
// desktop voice agent uses (full parity — file ops, git, schedules, etc.) and
// hand the result back by request id.
let toolRelayWired = false;
// The conversation the current phone voice session writes into (transcripts +
// tool side-effects). Set at session start (voice:context).
let phoneVoiceConvId: string | null = null;
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
    const t0 = Date.now();
    let result = "";
    try {
      // Phone voice runs the brain on the box but has no thread of its own.
      // Open/seed a labeled voice conversation at session start so the spoken
      // turns (relayed via voice:transcript below) and any mission the agent
      // proposes land in one findable thread, surfaced in the conversation list.
      phoneVoiceConvId = ensureVoiceConversation();
      const ctx = await buildPhoneVoiceContext();
      if (ctx) result = JSON.stringify(ctx);
      // Log the failure modes — this build used to swallow errors silently, which
      // is why flaky voice starts had "no clear pattern". Now we can see which
      // path failed and how long it took.
      else vlog("voice.ctx.empty", { reqId, ms: Date.now() - t0, note: "no key/vault or agent provision failed" });
    } catch (e) {
      vlog("voice.ctx.error", { reqId, ms: Date.now() - t0, error: String(e) });
    }
    if (result) vlog("voice.ctx.ok", { reqId, ms: Date.now() - t0 });
    await invoke("voice_tool_respond", { reqId, result }).catch(() => {});
  });

  // Phone-voice transcript relay: the phone talks to ElevenLabs directly, so
  // each completed turn is POSTed to the box (/voice-transcript) and emitted
  // here. Append it to the session's voice conversation so the thread reads as
  // the real spoken exchange, not just tool markers.
  await listen<{ role?: string; text?: string }>("voice:transcript", (event) => {
    const t = (event.payload.text ?? "").trim();
    if (!t) return;
    const convId = phoneVoiceConvId ?? (phoneVoiceConvId = ensureVoiceConversation());
    useStore.getState().appendMessageToConversation(convId, {
      role: event.payload.role === "user" ? "user" : "assistant",
      content: t,
    });
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
  // The port can be briefly held by a previous instance — an auto-update
  // restart overlaps old and new processes, and a second launch can race a
  // closing first one. Giving up on the first EADDRINUSE left the voice/phone
  // host dead for the whole session (the "voice broke" report — os error
  // 10048 in the app log). Retry with backoff until the old holder exits.
  const ATTEMPTS = 15;
  let bound = false;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      await invoke("voice_server_start", { port: PORT, token: getToken() });
      bound = true;
      if (i > 0) vlog("phone-voice server bound after retry", { attempt: i + 1 });
      break;
    } catch (e) {
      if (i === 0) console.warn("[phone-voice] server start failed (will retry):", e);
      if (i === ATTEMPTS - 1) {
        vlog("phone-voice server start gave up", String(e).slice(0, 200));
        console.warn("[phone-voice] server start gave up after retries:", e);
      } else {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  if (!bound) {
    started = false;
    return;
  }
  await wireToolRelay();
  await pushContext();
  // Eagerly stand up the Tailscale HTTPS funnel (Rust `voice_server_url` runs
  // `tailscale serve --bg`) so the phone can reach this box over
  // https://<name>.ts.net the moment it connects. Without this the funnel was
  // only created as a side effect of the desktop Settings pane rendering
  // (getPhoneChatLink/getPhoneVoiceLink) — so until the user happened to open
  // Settings, the .ts.net host pointed nowhere and phone voice looped
  // "connecting…". Idempotent on the Rust side, so this is safe to fire on
  // every boot; fire-and-forget since `tailscale serve` can take a beat.
  void invoke("voice_server_url", { port: PORT }).catch(() => {});
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

/**
 * The phone CHAT link (the /phone PWA): same server, same token. The page
 * remembers the token in localStorage, so home-screen launches (which drop
 * the query string) keep working after the first open.
 */
export async function getPhoneChatLink(): Promise<string | null> {
  try {
    const base = await invoke<string | null>("voice_server_url", { port: PORT });
    if (!base) return null;
    return `${base}/phone?token=${getToken()}`;
  } catch {
    return null;
  }
}
