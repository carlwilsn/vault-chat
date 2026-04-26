// Phone bridge — listens for incoming voice requests from the Rust
// HTTP/WebSocket server and runs them through the existing agent
// pipeline. Maintains a phone-only conversation history that is
// independent of the desktop chat (so picking up the phone doesn't
// hijack whatever the user has on screen).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runAgent, type ChatTurn, type StreamEvent } from "./agent";
import { findModel, DEFAULT_MODEL_ID } from "./providers";
import { useStore } from "./store";

type PhoneRequest = { id: string; text: string; model: string };

let phoneHistory: ChatTurn[] = [];
let activeAbort: AbortController | null = null;
let activeId: string | null = null;

async function sendChunk(payload: Record<string, unknown>) {
  try {
    await invoke("phone_send_chunk", { chunk: JSON.stringify(payload) });
  } catch (e) {
    console.warn("[phone] send_chunk failed:", e);
  }
}

async function handleRequest(req: PhoneRequest) {
  // Cancel any in-flight turn — the phone always reflects the latest
  // user utterance.
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }

  const state = useStore.getState();
  const vault = state.vaultPath;
  if (!vault) {
    await sendChunk({ type: "error", id: req.id, message: "no vault open on desktop" });
    await sendChunk({ type: "done", id: req.id });
    return;
  }

  const spec = findModel(req.model) ?? findModel(DEFAULT_MODEL_ID);
  if (!spec) {
    await sendChunk({ type: "error", id: req.id, message: `unknown model: ${req.model}` });
    await sendChunk({ type: "done", id: req.id });
    return;
  }
  const apiKey = state.apiKeys[spec.provider];
  if (!apiKey) {
    await sendChunk({
      type: "error",
      id: req.id,
      message: `no ${spec.provider} API key configured`,
    });
    await sendChunk({ type: "done", id: req.id });
    return;
  }

  const tavilyKey = state.serviceKeys?.tavily;
  const ac = new AbortController();
  activeAbort = ac;
  activeId = req.id;

  // Append user turn to phone history. We commit the assistant turn
  // only after the run completes successfully — partial replies
  // shouldn't pollute future context if the stream errors midway.
  const historyForRun: ChatTurn[] = [...phoneHistory];

  let assistantText = "";

  const onEvent = (e: StreamEvent) => {
    if (activeId !== req.id) return; // superseded by a newer request
    switch (e.kind) {
      case "text":
        assistantText += e.delta;
        void sendChunk({ type: "text", id: req.id, delta: e.delta });
        break;
      case "tool_use":
        void sendChunk({ type: "tool", id: req.id, name: e.name });
        break;
      case "reasoning_start":
        void sendChunk({ type: "thinking", id: req.id });
        break;
      case "done":
        if (assistantText.trim()) {
          phoneHistory = [
            ...historyForRun,
            { role: "user", content: req.text },
            { role: "assistant", content: assistantText },
          ];
          // Cap at the most recent ~20 turns so prompt size stays sane
          // for a long-running phone session — the desktop has its own
          // compaction logic but the phone path doesn't need that.
          if (phoneHistory.length > 40) {
            phoneHistory = phoneHistory.slice(-40);
          }
        }
        void sendChunk({ type: "done", id: req.id });
        break;
      case "error":
        void sendChunk({ type: "error", id: req.id, message: e.message });
        break;
    }
  };

  try {
    await runAgent({
      modelId: spec.id,
      apiKey,
      vault,
      history: historyForRun,
      userMessage: req.text,
      onEvent,
      abortSignal: ac.signal,
      tavilyKey,
    });
  } catch (e: any) {
    await sendChunk({
      type: "error",
      id: req.id,
      message: e?.message ?? String(e),
    });
    await sendChunk({ type: "done", id: req.id });
  } finally {
    if (activeAbort === ac) activeAbort = null;
  }
}

export function installPhoneBridge() {
  void listen<PhoneRequest>("phone:request", (ev) => {
    void handleRequest(ev.payload);
  });
  void listen<{ id: string }>("phone:abort", () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
  });
  void listen("phone:reset", () => {
    phoneHistory = [];
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
  });
  console.log("[phone] bridge installed");
}
