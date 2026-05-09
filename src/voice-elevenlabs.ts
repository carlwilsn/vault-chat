import { Conversation } from "@elevenlabs/client";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage, type Viewport } from "./store";

// Voice mode runs as an ElevenLabs Conversational AI session: their
// platform owns the audio loop (STT + LLM + TTS) and we provide the
// brain config (Claude), per-session prompt context, scroll-driven
// updates, and client-side read tools. Transcripts come back via
// SDK events and get appended to state.messages when the session
// ends.

const AGENT_NAME = "vault-chat";
// Default — overridable via Settings → ElevenLabs → Voice model.
// Stored in localStorage as `vault_chat_elevenlabs_llm`. Their LLM
// allowlist accepts both bare aliases (claude-sonnet-4-6) and dated
// forms (claude-sonnet-4-5@20250929); we use the bare alias for the
// newest models since it stays current as ElevenLabs rolls dates.
const DEFAULT_LLM = "claude-sonnet-4-6";
const LLM_STORAGE = "vault_chat_elevenlabs_llm";
const AGENT_LLM_AT_PROVISION = "vault_chat_elevenlabs_agent_llm";

function getCurrentLlm(): string {
  return localStorage.getItem(LLM_STORAGE) ?? DEFAULT_LLM;
}
const AGENT_ID_STORAGE = "vault_chat_elevenlabs_agent_id";
// Bump whenever the agent-create body changes in a way that affects
// the agent itself — tool schema, expects_response flags, override
// permissions. Mismatch with the cached agent triggers re-provision
// on next session, so updates roll out without manual intervention.
const AGENT_CONFIG_VERSION = "v2-expects-response";
const AGENT_VERSION_STORAGE = "vault_chat_elevenlabs_agent_config_version";
const VOICE_ID_STORAGE = "vault_chat_elevenlabs_voice";
const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb"; // Brian — Jarvis-adjacent baseline.
const SCROLL_DEBOUNCE_MS = 600;
const VIEWPORT_TEXT_CAP = 4000;

type ActiveConversation = Awaited<ReturnType<typeof Conversation.startSession>>;

let activeConversation: ActiveConversation | null = null;
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastViewportSent: string | null = null;

const READ_CAP = 8000;

// ElevenLabs's tool-parameter validator requires every property to
// carry a `description` (or `dynamic_variable` / `is_system_provided`
// / `constant_value`). Missing descriptions return HTTP 422 on
// agent-create with a per-property loc trail. Make sure every leaf
// property below has one.
const CLIENT_TOOL_DEFINITIONS = [
  {
    name: "Read",
    description:
      "Read a UTF-8 text file from disk and return its contents. Use absolute paths. Long files are truncated.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute path to the file to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "Glob",
    description:
      "Find files matching a glob pattern (e.g. '**/*.md'). Relative patterns resolve from the active vault root. Returns paths newest-first.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern relative to the vault root. Examples: '**/*.md', 'lectures/**/notes.md'.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description:
      "Regex search across files. Returns matching lines as 'path:line: text'. glob_filter restricts file types.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression to search for in file contents.",
        },
        path: {
          type: "string",
          description:
            "Optional directory or single file to search. Defaults to the vault root.",
        },
        glob_filter: {
          type: "string",
          description:
            "Optional filename glob to restrict matches, e.g. '*.md' or '*.tsx'.",
        },
        case_insensitive: {
          type: "boolean",
          description:
            "If true, the regex match ignores ASCII case. Defaults to false.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "ListDir",
    description:
      "List entries in a directory. Returns names with trailing slash on subdirectories.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory to list.",
        },
      },
      required: ["path"],
    },
  },
];

export async function startElevenLabsSession(): Promise<void> {
  if (activeConversation) return;
  const state = useStore.getState();
  const apiKey = state.serviceKeys.elevenlabs;
  if (!apiKey) {
    reportVoiceError(
      "Voice mode needs an ElevenLabs API key. Add one in Settings.",
    );
    return;
  }

  // "Connecting…" lights up the cockpit immediately so the user
  // knows the click registered. Cleared in onConnect (success) or
  // any of the error paths below.
  useStore.getState().setVoiceConnecting(true);

  // Pre-flight mic permission. WebView2 on Windows sometimes refuses
  // silently otherwise; this surfaces the failure visibly.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
  } catch (e) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError(
      `Microphone access denied or unavailable: ${(e as any)?.message ?? String(e)}. Check Windows Settings → Privacy → Microphone.`,
    );
    return;
  }

  const agentId = await ensureAgent(apiKey);
  if (!agentId) {
    useStore.getState().setVoiceConnecting(false);
    const err = getLastAgentCreateError();
    const detail = err
      ? `HTTP ${err.status}: ${truncate(err.body, 600)}`
      : "(no response captured)";
    reportVoiceError(
      `Couldn't provision the ElevenLabs agent.\n\n${detail}\n\nCommon causes: plan doesn't include Conversational AI, key lacks scope, or the LLM string is rejected.`,
    );
    return;
  }

  const signedUrl = await getSignedUrl(apiKey, agentId);
  if (!signedUrl) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError(
      "Couldn't get a signed conversation URL from ElevenLabs. The agent ID may be stale (try clearing localStorage `vault_chat_elevenlabs_agent_id`) or your account may have hit a rate limit.",
    );
    return;
  }

  lastViewportSent = null;

  const systemPrompt = buildSystemPrompt(state);
  const dynamicVariables = buildDynamicVariables(state);

  try {
    activeConversation = await Conversation.startSession({
      signedUrl,
      overrides: {
        agent: {
          prompt: { prompt: systemPrompt },
          firstMessage: "",
          language: "en",
        },
        tts: {
          voiceId:
            localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID,
        },
      },
      dynamicVariables,
      clientTools: buildClientToolHandlers(),
      onConnect: () => {
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
      },
      onDisconnect: () => {
        useStore.getState().appendMessage({
          role: "assistant",
          content: "Voice session ended.",
          system: true,
        });
        activeConversation = null;
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
      },
      onMessage: ({ message, role }) => {
        const text = (message ?? "").trim();
        if (!text) return;
        // Live append: each completed user/agent turn lands in the
        // chat pane as it arrives, not buffered until session end.
        // ElevenLabs sends whole messages (not token streams), so
        // there's no spam — one append per turn boundary.
        if (role === "user") {
          useStore.getState().appendMessage({ role: "user", content: text });
        } else if (role === "agent") {
          useStore
            .getState()
            .appendMessage({ role: "assistant", content: text });
        }
      },
      onModeChange: ({ mode }) => {
        useStore.getState().setVoiceListening(mode === "listening");
        useStore.getState().setVoiceSpeaking(mode === "speaking");
      },
      onError: (message: string) => {
        console.warn("[voice-eleven] session error:", message);
      },
    });
  } catch (e) {
    console.error("[voice-eleven] session start failed:", e);
    activeConversation = null;
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError(
      `Voice session failed to start: ${(e as any)?.message ?? String(e)}.`,
    );
  }
}

function reportVoiceError(message: string): void {
  console.warn("[voice-eleven]", message);
  useStore.getState().appendMessage({
    role: "assistant",
    content: `⚠️ Voice mode: ${message}`,
    system: true,
  });
}

export async function endElevenLabsSession(): Promise<void> {
  if (scrollDebounceTimer !== null) {
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = null;
  }
  const conv = activeConversation;
  activeConversation = null;
  if (!conv) return;
  try {
    await conv.endSession();
  } catch (e) {
    console.warn("[voice-eleven] end session failed:", e);
  }
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
}

export function pushViewportContextDebounced(): void {
  if (!activeConversation) return;
  if (scrollDebounceTimer !== null) clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(() => {
    scrollDebounceTimer = null;
    const conv = activeConversation;
    if (!conv) return;
    const state = useStore.getState();
    if (!state.followAlong) return;
    const text = buildViewportContextText(state);
    if (!text || text === lastViewportSent) return;
    lastViewportSent = text;
    try {
      conv.sendContextualUpdate(text);
    } catch (e) {
      console.warn("[voice-eleven] contextual update failed:", e);
    }
  }, SCROLL_DEBOUNCE_MS);
}

export function getInputLevels(n: number): number[] {
  if (!activeConversation) return new Array(n).fill(0);
  try {
    return binFrequencyData(activeConversation.getInputByteFrequencyData(), n);
  } catch {
    return new Array(n).fill(0);
  }
}

export function getOutputLevels(n: number): number[] {
  if (!activeConversation) return new Array(n).fill(0);
  try {
    return binFrequencyData(activeConversation.getOutputByteFrequencyData(), n);
  } catch {
    return new Array(n).fill(0);
  }
}

function binFrequencyData(data: Uint8Array, n: number): number[] {
  const out: number[] = [];
  const binsPerBar = Math.max(1, Math.floor(data.length / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < binsPerBar; j++) {
      sum += data[i * binsPerBar + j] ?? 0;
    }
    out.push(sum / binsPerBar / 255);
  }
  return out;
}


function buildSystemPrompt(state: ReturnType<typeof useStore.getState>): string {
  const vault = state.vaultPath ?? "(no vault)";
  const recentHistory = formatRecentHistory(state.messages, 8);
  const followNote = state.followAlong
    ? "Follow-along is on. The active document and viewport are in dynamic variables and will refresh via contextual updates as the user scrolls."
    : "Follow-along is off. The user is not asking about a specific document unless they name one.";
  return [
    "You are vault-chat speaking to the user via voice. Your output is converted to audio in real time.",
    "",
    "Speech rules:",
    "- Conversational. Short answers. Like talking to a friend.",
    "- No markdown formatting (no asterisks, no headers, no bullets, no code fences). Plain prose.",
    "- No emoji.",
    "- If asked to read content, call Read (or fall back to Glob/Grep) and speak it naturally — your text becomes audio.",
    "",
    `Vault root (absolute): ${vault}`,
    "",
    "Tool calling rules — CRITICAL:",
    "- Read, ListDir take ABSOLUTE paths. Construct them by joining the vault root with the relative file/folder name. Never pass bare filenames like 'study.md' — they will fail.",
    "- Glob takes a pattern relative to the vault root. To find study.md across the vault, call Glob with pattern '**/study.md'. To find any markdown, '**/*.md'.",
    "- Grep takes an optional path argument. Omit it to search the whole vault, or pass an absolute path under the vault root to scope the search.",
    "- If a tool returns '(no matches)' or '(empty)', that's a real result, not a failure. Try a different pattern or path before giving up.",
    "",
    `Examples for THIS vault:`,
    `- ListDir("${vault}")  → list the vault root`,
    `- Read("${vault}/study.md")  → read study.md if it's in the vault root`,
    `- Glob("**/study.md")  → find study.md anywhere in the vault`,
    `- Grep("gradient descent", undefined, "*.md")  → search markdown for "gradient descent"`,
    "",
    followNote,
    "",
    "{{viewport_context}}",
    "",
    recentHistory ? `Recent conversation context:\n${recentHistory}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDynamicVariables(
  state: ReturnType<typeof useStore.getState>,
): Record<string, string> {
  return {
    viewport_context: buildViewportContextText(state) || "(no document open)",
  };
}

function buildViewportContextText(
  state: ReturnType<typeof useStore.getState>,
): string {
  if (!state.followAlong) return "";
  const file = state.currentFile;
  if (!file) return "";
  const v: Viewport | null = state.viewport;
  if (v && v.path === file) {
    if (v.page !== undefined && v.pageText) {
      const total = v.totalPages ?? "?";
      return `Active document: ${file}\nViewing page ${v.page} of ${total}\nPage content:\n${truncate(v.pageText, VIEWPORT_TEXT_CAP)}`;
    }
    if (v.visibleText) {
      const pct =
        v.scrollRatio !== undefined
          ? Math.round(v.scrollRatio * 100)
          : null;
      const loc = pct !== null ? ` (scrolled ~${pct}%)` : "";
      return `Active document: ${file}${loc}\nVisible content:\n${truncate(v.visibleText, VIEWPORT_TEXT_CAP)}`;
    }
  }
  const fallback = (state.currentContent ?? "").trim();
  if (!fallback) {
    return `Active document: ${file} (no text content available; call Read for contents)`;
  }
  return `Active document: ${file}\nContent:\n${truncate(fallback, VIEWPORT_TEXT_CAP)}`;
}

function formatRecentHistory(messages: ChatMessage[], take: number): string {
  const recent = messages
    .filter((m) => !m.system && (m.role === "user" || m.role === "assistant"))
    .slice(-take);
  if (recent.length === 0) return "";
  return recent
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${truncate(m.content.trim(), 400)}`)
    .join("\n");
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

// ---- Agent provisioning ---------------------------------------------------

let lastAgentCreateError: { status: number; body: string } | null = null;

export function getLastAgentCreateError(): { status: number; body: string } | null {
  return lastAgentCreateError;
}

async function ensureAgent(apiKey: string): Promise<string | null> {
  const cached = localStorage.getItem(AGENT_ID_STORAGE);
  const provisionedWith = localStorage.getItem(AGENT_LLM_AT_PROVISION);
  const provisionedVersion = localStorage.getItem(AGENT_VERSION_STORAGE);
  const wantedLlm = getCurrentLlm();
  // Re-provision if either the LLM choice or the agent-config schema
  // has changed since this agent was created. (The orchestrator
  // caches both at agent level, so changes don't take effect on the
  // existing agent — we make a fresh one.)
  const stale =
    cached &&
    (provisionedWith !== wantedLlm ||
      provisionedVersion !== AGENT_CONFIG_VERSION);
  if (cached && !stale) return cached;
  if (stale) {
    localStorage.removeItem(AGENT_ID_STORAGE);
  }
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: AGENT_NAME,
        conversation_config: {
          agent: {
            first_message: "",
            language: "en",
            prompt: {
              prompt: "(per-session override)",
              llm: wantedLlm,
              tools: CLIENT_TOOL_DEFINITIONS.map((t) => ({
                type: "client",
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                // CRITICAL: defaults to false. When false, the SDK
                // calls our handler but doesn't pass the return
                // value back to the agent — every tool call
                // appears empty to the model. With this true the
                // agent actually receives and reasons over the
                // result string.
                expects_response: true,
                response_timeout_secs: 30,
              })),
            },
          },
          tts: {
            voice_id:
              localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID,
          },
        },
        // Per-session overrides must be explicitly enabled in the
        // agent's platform_settings or the orchestrator silently
        // ignores them at session start. Whitelist the ones we
        // actually use: prompt + first_message + language + voice_id.
        platform_settings: {
          overrides: {
            conversation_config_override: {
              agent: {
                prompt: { prompt: true },
                first_message: true,
                language: true,
              },
              tts: { voice_id: true },
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[voice-eleven] agent create failed:", res.status, body);
      lastAgentCreateError = { status: res.status, body };
      return null;
    }
    const json = (await res.json()) as { agent_id?: string };
    if (!json.agent_id) {
      console.error("[voice-eleven] agent create returned no agent_id:", json);
      lastAgentCreateError = { status: 0, body: JSON.stringify(json) };
      return null;
    }
    lastAgentCreateError = null;
    localStorage.setItem(AGENT_ID_STORAGE, json.agent_id);
    localStorage.setItem(AGENT_LLM_AT_PROVISION, wantedLlm);
    localStorage.setItem(AGENT_VERSION_STORAGE, AGENT_CONFIG_VERSION);
    return json.agent_id;
  } catch (e) {
    console.error("[voice-eleven] agent create exception:", e);
    lastAgentCreateError = { status: 0, body: (e as any)?.message ?? String(e) };
    return null;
  }
}

async function getSignedUrl(apiKey: string, agentId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      {
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[voice-eleven] signed url failed:", res.status, body);
      // Stale cached agent ID → clear it so the next start re-creates.
      if (res.status === 404 || res.status === 403) {
        localStorage.removeItem(AGENT_ID_STORAGE);
      }
      return null;
    }
    const json = (await res.json()) as { signed_url?: string };
    return json.signed_url ?? null;
  } catch (e) {
    console.error("[voice-eleven] signed url exception:", e);
    return null;
  }
}

// ---- Client tool implementations ----------------------------------------

// Wraps every tool handler with diagnostic logging — each call is
// console.log'd and pushed onto a transcript buffer that flushes to
// the chat pane on session end. Without this we have no visibility
// into what the voice agent was actually calling.
function logToolCall(name: string, args: unknown, result: string): void {
  const argsStr = JSON.stringify(args);
  const summary = result.length > 200 ? result.slice(0, 200) + "…" : result;
  console.log(`[voice-eleven] tool ${name}(${argsStr}) →`, summary);
  useStore.getState().appendMessage({
    role: "assistant",
    content: `🔧 ${name}(${argsStr})\n→ ${summary}`,
    system: true,
  });
}

function buildClientToolHandlers(): Record<
  string,
  (parameters: any) => Promise<string>
> {
  return {
    Read: async (args: { path: string }) => {
      let result: string;
      try {
        const raw = await invoke<string>("read_text_file", { path: args.path });
        result =
          raw.length > READ_CAP
            ? raw.slice(0, READ_CAP) + "\n…[truncated]"
            : raw;
      } catch (e) {
        result = `Error: ${(e as any)?.message ?? String(e)}`;
      }
      logToolCall("Read", args, result);
      return result;
    },
    Glob: async (args: { pattern: string }) => {
      const vault = useStore.getState().vaultPath;
      let result: string;
      if (!vault) {
        result = "Error: no active vault";
      } else {
        try {
          const results = await invoke<string[]>("glob_files", {
            pattern: args.pattern,
            cwd: vault,
          });
          if (!results.length) {
            result = "(no matches)";
          } else {
            const out = results.slice(0, 200).join("\n");
            result =
              results.length > 200
                ? out + `\n…(${results.length - 200} more)`
                : out;
          }
        } catch (e) {
          result = `Error: ${(e as any)?.message ?? String(e)}`;
        }
      }
      logToolCall("Glob", args, result);
      return result;
    },
    Grep: async (args: {
      pattern: string;
      path?: string;
      glob_filter?: string;
      case_insensitive?: boolean;
    }) => {
      const vault = useStore.getState().vaultPath;
      let result: string;
      if (!vault) {
        result = "Error: no active vault";
      } else {
        try {
          const results = await invoke<
            { path: string; line: number; text: string }[]
          >("grep_files", {
            pattern: args.pattern,
            path: args.path ?? vault,
            globFilter: args.glob_filter ?? null,
            caseInsensitive: args.case_insensitive ?? false,
            maxResults: 200,
          });
          if (!results.length) {
            result = "(no matches)";
          } else {
            result = results
              .slice(0, 100)
              .map((r) => `${r.path}:${r.line}: ${r.text}`)
              .join("\n");
          }
        } catch (e) {
          result = `Error: ${(e as any)?.message ?? String(e)}`;
        }
      }
      logToolCall("Grep", args, result);
      return result;
    },
    ListDir: async (args: { path: string }) => {
      let result: string;
      try {
        const entries = await invoke<{ name: string; is_dir: boolean }[]>(
          "list_dir",
          { path: args.path },
        );
        if (!entries.length) {
          result = "(empty)";
        } else {
          result = entries
            .map((e) => (e.is_dir ? `${e.name}/` : e.name))
            .join("\n");
        }
      } catch (e) {
        result = `Error: ${(e as any)?.message ?? String(e)}`;
      }
      logToolCall("ListDir", args, result);
      return result;
    },
  };
}
