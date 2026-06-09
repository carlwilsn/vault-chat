import { Conversation } from "@elevenlabs/client";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage, type Viewport, type FileEntry } from "./store";
import { buildNote } from "./notes";
import { gitCommitAll } from "./git";
import { loadVaultVoicePrompt, loadVaultNorthStar, northStarPromptBlock } from "./meta";
import { applyNotebookEdit, extractPdfText, stripNotebook, assertCanWrite } from "./tools";

// Voice mode runs as an ElevenLabs Conversational AI session: their
// platform owns the audio loop (STT + LLM + TTS) and we provide the
// brain config (Claude), per-session prompt context, scroll-driven
// updates, and client-side read tools. Transcripts come back via
// SDK events and get appended to state.messages when the session
// ends.

// WebKitGTK (Linux) can't play Web Audio on the current Ubuntu stack, so the
// agent's voice is routed to native playback in the Rust backend. The Rust
// command no-ops on other platforms (WebView2 / WKWebView), where the webview
// plays audio fine on its own.

// Hand an agent-audio chunk to the native player. The SDK's
// onAudio gives base64 PCM (16 kHz mono s16le) — exactly what the Rust
// command expects.
function playAgentAudioNative(audioBase64: string): void {
  if (!audioBase64) return;
  // Rust command is a no-op off Linux, so no platform gate needed.
  void invoke("agent_audio_play", { b64: audioBase64 }).catch(() => {});
}
function stopAgentAudioNative(): void {
  void invoke("agent_audio_stop").catch(() => {});
}

const AGENT_NAME = "vault-chat";
// Default — overridable via Settings → ElevenLabs → Voice model.
// Stored in localStorage as `vault_chat_elevenlabs_llm`. ElevenLabs Agents
// accept both bare aliases (claude-sonnet-4-6) and dated forms
// (claude-sonnet-4-5@20250929); we use the bare alias for the newest models
// since it stays current as ElevenLabs rolls dates. Gemini 2.5 Flash: native
// PDF + multimodal context, snappy TTFT for voice tempo — handles most
// lecture-narration / "what does this say" work without Pro-tier reasoning.
export const DEFAULT_LLM = "gemini-2.5-flash";
const LLM_STORAGE = "vault_chat_elevenlabs_llm";
const AGENT_LLM_AT_PROVISION = "vault_chat_elevenlabs_agent_llm";

// Models ElevenLabs Agents can actually run for voice — NOT every model the rest
// of the app supports. Agents runs no Claude Opus, and only specific Gemini tiers
// (no gemini-2.5-pro). Keep this in sync with the Settings voice-model dropdown.
// Verified against ElevenLabs' supported-LLM list + changelog (2026-06).
export const SUPPORTED_VOICE_LLMS = new Set<string>([
  "gemini-2.5-flash",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5@20250929",
  "claude-sonnet-4@20250514",
  "claude-3-7-sonnet",
  "claude-haiku-4-5-20251001",
]);

// A stored value outside the supported set (e.g. left over from before a model
// was dropped) falls back to the default, so voice never fails provisioning on a
// model ElevenLabs would reject.
function getCurrentLlm(): string {
  const stored = localStorage.getItem(LLM_STORAGE);
  return stored && SUPPORTED_VOICE_LLMS.has(stored) ? stored : DEFAULT_LLM;
}

// Gemini reads PDFs natively as part of the multimodal context we
// upload via pushPdfIfNeeded — it can see every page, diagram, and
// equation without any extraction tool. Registering PdfExtract for
// Gemini just confuses the agent: it sometimes forgets it has direct
// vision and reaches for the tool, burning a round-trip and getting
// degraded text-only output. Skip the tool (and the prompt section
// that tells the agent to use it) when running on Gemini. Other LLMs
// the ElevenLabs orchestrator supports — Claude, OpenAI — don't get
// the PDF blob piped to them the same way, so they keep the tool.
function isGeminiLlm(llm: string): boolean {
  return llm.toLowerCase().startsWith("gemini");
}
const AGENT_ID_STORAGE = "vault_chat_elevenlabs_agent_id";
// Bump whenever the agent-create body changes in a way that affects
// the agent itself — tool schema, expects_response flags, override
// permissions. Mismatch with the cached agent triggers re-provision
// on next session, so updates roll out without manual intervention.
const AGENT_CONFIG_VERSION = "v17-bash";
const AGENT_VERSION_STORAGE = "vault_chat_elevenlabs_agent_config_version";
const VOICE_ID_STORAGE = "vault_chat_elevenlabs_voice";
const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb"; // Brian — Jarvis-adjacent baseline.
const SCROLL_DEBOUNCE_MS = 600;
const VIEWPORT_TEXT_CAP = 4000;

type ActiveConversation = Awaited<ReturnType<typeof Conversation.startSession>>;

let activeConversation: ActiveConversation | null = null;
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastViewportSent: string | null = null;
// Tracked across the lifetime of one session — used at session end
// to decide whether to auto-commit + refresh the file tree, and to
// derive a useful commit subject from the user's first utterance.
let sessionMutationCount = 0;
let sessionFirstUserText: string | null = null;
// Store subscription that watches active-pane / current-file and
// pushes a contextual update when either changes. Set up at session
// start, torn down at session end.
let unsubscribeViewportWatch: (() => void) | null = null;

// FIFO queue of agent messages that haven't been flushed to the chat
// pane yet, plus a flag tracking whether a silence-wait is currently
// in flight. Multiple agent messages in rapid succession would
// previously cause the earlier one to flush *immediately* (so message
// N+1 could take the single pending slot), which raced the transcript
// ahead of the audio. Now each message takes its turn: one silence
// window per message, in order.
const pendingAgentQueue: string[] = [];
let agentQueueDraining = false;

async function drainAgentQueue(): Promise<void> {
  if (agentQueueDraining) return;
  agentQueueDraining = true;
  // Pin the conversation we started for. If the session swaps mid-
  // drain (disconnect → user re-toggles voice → new session), the
  // post-await iteration would otherwise consume the new session's
  // queued messages and append them under a stale silence-wait. Bail
  // out instead — onDisconnect's flushAgentQueueImmediate already
  // handled the old queue.
  const ownerConv = activeConversation;
  try {
    while (pendingAgentQueue.length > 0) {
      await waitForSpeechEnd();
      if (activeConversation !== ownerConv) break;
      const next = pendingAgentQueue.shift();
      if (next === undefined) break;
      useStore.getState().appendMessage({ role: "assistant", content: next });
    }
  } finally {
    agentQueueDraining = false;
  }
}

function flushAgentQueueImmediate(): void {
  while (pendingAgentQueue.length > 0) {
    const text = pendingAgentQueue.shift();
    if (text === undefined) break;
    useStore.getState().appendMessage({ role: "assistant", content: text });
  }
}

// Monotonic generation counter + target slot for ScrollTo coalescing.
// Every ScrollTo invocation bumps scrollGen and overwrites
// pendingScrollTarget; only the call whose myGen still matches when its
// silence-wait resolves actually applies the scroll. See ScrollTo
// handler for the why.
let scrollGen = 0;
let pendingScrollTarget: { path: string; anchor: string } | null = null;

// Matched to text-mode tools so the voice agent gets enough context to
// answer questions about a real-sized file. 8k was too small for
// notebooks (cell metadata ate the budget before any code showed up).
const READ_CAP = 24_000;
// PDFs page out fast and the agent needs room for the actual content,
// not just the first page or two. Still under text-mode's 60k.
const PDF_CAP = 30_000;

// ElevenLabs's tool-parameter validator requires every property to
// carry a `description` (or `dynamic_variable` / `is_system_provided`
// / `constant_value`). Missing descriptions return HTTP 422 on
// agent-create with a per-property loc trail. Make sure every leaf
// property below has one.
const CLIENT_TOOL_DEFINITIONS = [
  {
    name: "Read",
    description:
      "Read a UTF-8 text file from disk and return its contents. Use absolute paths. Long files are truncated. Jupyter notebooks (.ipynb) are returned as readable '# Cell N [type]\\n<source>' sections — outputs and metadata are stripped automatically.",
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
  {
    name: "Write",
    description:
      "Write a UTF-8 text file. Creates parent directories as needed; overwrites existing files. Use absolute paths under the vault root. Good for saving summaries, study guides, or other content the user asked you to record.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the file to write, under the vault root.",
        },
        contents: {
          type: "string",
          description:
            "Full UTF-8 content of the file. Plain markdown is usually the right choice.",
        },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "CreateNote",
    description:
      "Save a short entry to the user's notes scratchpad — visible later in their notes panel. Use when the user says 'remember this', 'jot that down', 'add a note', or you notice a thought worth saving for review. Keep it short, like a reminder; not an essay.",
    parameters: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "The note text — what the user would want to see when they review it later.",
        },
        source_path: {
          type: "string",
          description:
            "Optional absolute path to anchor the note to. Lets the note jump to that file later.",
        },
        source_anchor: {
          type: "string",
          description:
            "Optional location within the source — e.g. 'page=3' for PDFs or 'L42' for line 42.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "Edit",
    description:
      "Replace a string in an existing file. old_string must be unique in the file (or pass replace_all=true). Prefer Edit over Write for small tweaks to a large file — much safer than overwriting the whole thing.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to edit, under the vault root.",
        },
        old_string: {
          type: "string",
          description: "Exact text to find in the file. Include enough surrounding context to make it unique.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. Pass an empty string to delete the matched region.",
        },
        replace_all: {
          type: "boolean",
          description: "If true, replace every occurrence. Defaults to false (single unique match required).",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "NotebookEdit",
    description:
      "Cell-aware edit of a Jupyter notebook (.ipynb). Use this instead of Write/Edit on raw notebook JSON. action='append' tacks `source` onto the END of an existing cell (with a newline if needed) — PREFER THIS over 'replace' for adding an observation or one line, since you don't have to retype the cell. 'replace' rewrites a cell's full source. 'insert' adds a new cell at cell_index (use -1 to append at notebook end). 'delete' removes the cell. Cells are 0-indexed top-to-bottom.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the .ipynb file.",
        },
        action: {
          type: "string",
          description: "One of 'append', 'replace', 'insert', or 'delete'.",
        },
        cell_index: {
          type: "number",
          description: "0-based cell index. Use -1 with insert to append to the end.",
        },
        source: {
          type: "string",
          description: "New cell source. Required for replace and insert.",
        },
        cell_type: {
          type: "string",
          description: "Cell type for insert/replace: 'code', 'markdown', or 'raw'. Defaults to 'code' on insert; preserves the existing type on replace when omitted.",
        },
      },
      required: ["path", "action", "cell_index"],
    },
  },
  {
    name: "PdfExtract",
    description:
      "Extract text from a PDF file. Returns plain text grouped by page. Use `pages` to limit (e.g. '1', '1-5', '1,3,7-9'); omit for all pages. Call this — not Read — when the user asks about a .pdf file.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the PDF file.",
        },
        pages: {
          type: "string",
          description: "Optional page selection: '1', '1-5', '1,3,7-9'. Omit for all pages.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ScrollTo",
    description:
      "Move the user's viewport to a specific page or section of the file they're currently viewing. Use this to drive read-along sessions: advance to the next page when the user is ready, jump back to a page they want to revisit ('go back to the bubble diagram'), or anchor on a specific section. The user's eyes follow what you scroll to, so move deliberately and explain what you're doing. Works on PDFs (page numbers). For non-PDF files, omit `page` and pass an `anchor` heading slug. Returns the resulting page / anchor on success.",
    parameters: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "1-based PDF page number to scroll to. For PDFs only.",
        },
        anchor: {
          type: "string",
          description: "Optional anchor string (e.g., 'page=12' for PDFs, or a heading slug for markdown). Prefer `page` for PDFs; use `anchor` when targeting a section.",
        },
        path: {
          type: "string",
          description: "Optional absolute file path. Defaults to the user's currently active file when omitted — that's the normal case for read-along.",
        },
      },
      required: [],
    },
  },
  {
    name: "ListNotes",
    description:
      "List the user's saved notes (their scratchpad) for the current vault. Each note has an id, timestamp, status (open|resolved), anchored file path(s), and body. Use when the user asks 'what did I flag', 'what's in my notes', etc. Defaults to open notes; pass status='resolved' for the archive or 'all' for everything.",
    parameters: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: "Filter: 'open' (default), 'resolved', or 'all'.",
        },
        limit: {
          type: "number",
          description: "Maximum notes to return. Defaults to 50.",
        },
      },
      required: [],
    },
  },
  {
    name: "ResolveNote",
    description:
      "Mark a note as resolved. Call this when the user confirms an open note has been addressed ('I did that', 'we covered it', 'mark that done'). The note stays in history but drops out of the default Active view.",
    parameters: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The note id (from ListNotes output, in square brackets).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "WebFetch",
    description:
      "Fetch a URL over HTTPS and return the body as text. HTML is stripped to readable text. Use for documentation, articles, and API responses when you already know the URL. Follows redirects. Output is truncated.",
    parameters: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Fully-qualified URL starting with http:// or https://.",
        },
        max_chars: {
          type: "number",
          description: "Optional cap on returned text length. Defaults to 24000 for voice mode.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "WebSearch",
    description:
      "Search the web and return the top results (title, URL, snippet) plus a synthesized answer. Use when the user asks about current information or you don't know a specific URL. Prefer WebFetch if you already have the URL. Requires a Tavily API key configured in Settings.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        max_results: {
          type: "number",
          description: "Optional. Default 5, max 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "Bash",
    description:
      "Execute a shell command. Runs with the vault as the working directory by default. Returns stdout, stderr, and exit code. Voice mode has a hard ~30s ceiling per tool call (ElevenLabs response timeout) — for anything longer (git clone of a big repo, training, long pip install), background it: `nohup <cmd> > /tmp/run.log 2>&1 &` then poll the log file with separate Bash calls. May be disabled by the user (returns an error explaining how to enable).",
    parameters: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to run.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory. Defaults to the vault root.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds. Default 20000. Cap at ~25000 to stay under the platform tool-response ceiling.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "ReopenNote",
    description:
      "Mark a previously resolved note as open again. Use when the user realises an issue they'd closed isn't actually solved.",
    parameters: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The note id (from ListNotes output, in square brackets).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "GitLog",
    description:
      "Read recent git history from a repo inside the vault — including nested work repos. Use it to gauge real momentum from objective evidence: what was committed, when, and by whom. Returns oneline '<short-hash> <subject>' rows. The vault root is mostly autosave commits — the real work usually lives in nested repos, so target those.",
    parameters: {
      type: "object" as const,
      properties: {
        subdir: {
          type: "string",
          description:
            "Vault-relative path to the repo, e.g. 'DeepDL/bitnet-repro'. Use '' or '.' for the vault root.",
        },
        since: {
          type: "string",
          description: "Optional. Only commits newer than this, e.g. '10 days ago' or '2026-06-01'.",
        },
        author: {
          type: "string",
          description: "Optional. Filter to commits whose author matches this substring.",
        },
        max_count: {
          type: "number",
          description: "Optional. Max commits to return. Default 40, max 500.",
        },
      },
      required: ["subdir"],
    },
  },
  {
    name: "ListConversations",
    description:
      "List the other chats in this vault — useful for finding a specific conversation to peek into (see ReadConversation). Returns id, title, source, status, unread, last activity time, and message count for each. Excludes the current chat. Use when the user asks 'what other chats do I have', 'list my conversations', etc.",
    parameters: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Optional. Max conversations to return, sorted by recency. Default 20.",
        },
      },
      required: [],
    },
  },
  {
    name: "ReadConversation",
    description:
      "Read the recent history of another chat in this vault, including the most recent tool calls. Use when the user asks 'how is the X chat doing', 'what's the deep-dive chat working on', or similar monitoring questions. Pair with ListConversations to find the id. Returns the last N messages with role, content, and any tool-call summaries.",
    parameters: {
      type: "object" as const,
      properties: {
        conversation_id: {
          type: "string",
          description: "Conversation id from ListConversations.",
        },
        last_n: {
          type: "number",
          description: "Optional. How many recent messages to return. Default 12, max 50.",
        },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "ListSchedules",
    description:
      "List the scheduled prompts in this vault. Use to find a schedule's id before cancelling it, or to remind the user what they have set up. Returns id, name, prompt, recurrence, next-fire time, target, and enabled state.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "CancelSchedule",
    description:
      "Delete a schedule by id. Use when the user asks to cancel a reminder, stop a recurring brief, or undo a duplicate. Pair with ListSchedules to find the id.",
    parameters: {
      type: "object" as const,
      properties: {
        schedule_id: {
          type: "string",
          description: "The schedule id, from ListSchedules.",
        },
      },
      required: ["schedule_id"],
    },
  },
  {
    name: "Schedule",
    description:
      "Schedule a prompt to fire at a future time, either once or recurring. The prompt runs as a new turn in the CURRENT conversation when it fires. Use for reminders ('remind me at 9pm'), recurring briefs ('daily news at 8am'), or polling tasks. Exactly one of when_iso, daily_at, weekdays_at, or every_minutes must be set — that choice picks the recurrence. Fires while vault-chat is running with this vault available; if the app is closed at fire time, it fires on the next launch.",
    parameters: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description:
            "The text sent as the user's turn each time it fires. Phrase it as what you want the agent to do at fire time.",
        },
        description: {
          type: "string",
          description: "Optional short label shown in the Schedules panel.",
        },
        when_iso: {
          type: "string",
          description:
            "ONE-TIME fire. ISO 8601 local datetime e.g. '2026-05-29T21:30'. Compute from the current time.",
        },
        daily_at: {
          type: "string",
          description: "DAILY fire. Time of day in 'HH:MM' 24h format, e.g. '08:00'.",
        },
        weekdays_at: {
          type: "string",
          description: "WEEKDAYS-ONLY fire (Mon-Fri). Time in 'HH:MM' 24h format.",
        },
        every_minutes: {
          type: "number",
          description:
            "EVERY-N-MINUTES fire. Integer minutes between fires, minimum 5. Use sparingly — frequent fires burn API calls.",
        },
      },
      required: ["prompt"],
    },
  },
];

// Decide which conversation a starting voice session should run in.
// Voice always wants its own thread, so a session never appends onto a
// text chat. Reuse the active conversation ONLY when it's already a
// pure-voice thread (source "voice" — i.e. the mic was just toggled off
// and back on) or it's empty; otherwise spin up a fresh thread and tag
// it "voice". A typed turn later flips it back to "manual" (see
// chat-controller), so "source === voice" means "voice from start to end
// so far", which is exactly the resume condition the user wants.
function ensureVoiceConversation(): void {
  const s = useStore.getState();
  const active = s.activeConversationId
    ? s.conversations.find((c) => c.id === s.activeConversationId)
    : null;
  const reusable =
    !!active &&
    (active.source === "voice" ||
      (active.messages.length === 0 && s.messages.length === 0));
  if (reusable) {
    if (active!.source !== "voice") {
      useStore.setState({
        conversations: s.conversations.map((c) =>
          c.id === active!.id ? { ...c, source: "voice" } : c,
        ),
      });
    }
    return;
  }
  const id = useStore.getState().newConversation();
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) =>
      c.id === id ? { ...c, source: "voice" } : c,
    ),
  }));
}

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
    if (err && err.body.includes("voice_not_found")) {
      const failedVoice =
        localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID;
      reportVoiceError(
        `Voice ID ${failedVoice} isn't in your ElevenLabs library, so the agent can't be created with it. Two ways to fix: (1) open elevenlabs.io/app/voice-library, find that voice, click "Add to library" — then click the mic again; or (2) change the Voice ID in Settings to one already in your library (Brian — ${DEFAULT_VOICE_ID} — is the default and always works).`,
      );
      return;
    }
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
  sentPdfPaths.clear();
  sessionMutationCount = 0;
  sessionFirstUserText = null;

  // Voice runs in its own thread. Start fresh unless we're resuming a
  // pure-voice conversation (the user toggled the mic off and back on, so
  // the active thread is voice from start to end) or the active thread is
  // empty. Otherwise a voice session would tack its turns onto whatever
  // text chat happened to be open. Must run before the prompt build below
  // so the system prompt's recent-history reflects the chosen thread.
  ensureVoiceConversation();
  startViewportWatch();

  // Re-read after the possible conversation swap.
  const voiceState = useStore.getState();
  // Load the user-editable voice header from this vault's agent config
  // (.vault-chat/agent/voice.md). Empty string when missing →
  // buildSystemPrompt falls back to the built-in default header.
  const customHeader = await loadVaultVoicePrompt(voiceState.vaultPath);
  const northStar = await loadVaultNorthStar(voiceState.vaultPath);
  const systemPrompt = buildSystemPrompt(voiceState, customHeader, northStar);
  const dynamicVariables = buildDynamicVariables(voiceState);

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
      // Linux: the webview can't play Web Audio, so play the agent's voice
      // natively. Harmless no-op elsewhere (the webview plays it normally and
      // playAgentAudioNative/stopAgentAudioNative short-circuit off Linux).
      onAudio: (audioBase64: string) => {
        playAgentAudioNative(audioBase64);
      },
      onInterruption: () => {
        // Barge-in: drop buffered agent audio so it stops immediately.
        stopAgentAudioNative();
      },
      onConnect: () => {
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceThinking(false);
      },
      onDisconnect: () => {
        // Stop any native agent audio still playing/queued (Linux).
        stopAgentAudioNative();
        // Drain any agent text that was waiting for audio silence
        // before stamping the "session ended" marker — preserves
        // ordering between the last spoken turn and the end notice.
        flushAgentQueueImmediate();
        useStore.getState().appendMessage({
          role: "assistant",
          content: "Voice session ended.",
          system: true,
        });
        activeConversation = null;
        stopViewportWatch();
        // Flip the mic-button source of truth off so it matches
        // reality. Critical for end_call / end-phrase paths where
        // the click handler never ran. Idempotent for manual ends
        // (endElevenLabsSession already set it).
        useStore.setState({ voiceMode: false });
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceThinking(false);
        useStore.getState().setVoiceCurrentTool(null);
        stopThinkingWatcher();
        pendingScrollTarget = null;
        scrollGen++;
        // If anything got written / a note got saved, snapshot the
        // session as a single git commit and refresh the file tree.
        // Fire-and-forget — UI doesn't need to wait.
        void finalizeSessionMutations();
      },
      onMessage: ({ message, role }) => {
        const text = (message ?? "").trim();
        if (!text) return;
        // Live append: each completed user/agent turn lands in the
        // chat pane as it arrives, not buffered until session end.
        // ElevenLabs sends whole messages (not token streams), so
        // there's no spam — one append per turn boundary.
        if (role === "user") {
          if (sessionFirstUserText === null) sessionFirstUserText = text;
          useStore.getState().appendMessage({ role: "user", content: text });
          // User finished a turn — agent is now thinking until TTS
          // audio arrives. Drives the sine-wave visualizer; cleared
          // in onModeChange when mode flips to "speaking" (first
          // audio chunk arrives) or back to "listening" (barge-in).
          // 8s safety guard via setTimeout in case neither fires.
          useStore.getState().setVoiceThinking(true);
          armThinkingSafetyTimeout();
          // Client-side belt-and-suspenders for end_call. If the
          // whole utterance matches one of a few unambiguous end
          // phrases, hang up without waiting for the agent's
          // judgment. Conservative whitelist — won't match
          // ambiguous "I'm done talking about it" style phrases.
          if (looksLikeEnd(text)) {
            void endElevenLabsSession();
          }
        } else if (role === "agent") {
          // Queue and drain serially. onMessage fires on text-complete,
          // not audio-complete; appending now would race the transcript
          // ahead of the user's ears. Each queued message waits its
          // own silence window before landing in the chat so rapid-fire
          // turns flush in order, not all at once.
          pendingAgentQueue.push(text);
          void drainAgentQueue();
        }
      },
      onModeChange: ({ mode }) => {
        useStore.getState().setVoiceListening(mode === "listening");
        useStore.getState().setVoiceSpeaking(mode === "speaking");
        // Clear thinking the moment the first TTS chunk arrives — mode
        // flips listening → speaking in `handleAudio` at chunk arrival
        // per the SDK source. The wave hands off to the real output
        // spectrum on this transition.
        if (mode === "speaking") {
          useStore.getState().setVoiceThinking(false);
          stopThinkingWatcher();
        }
        // Barge-in path: when the user starts speaking, ElevenLabs
        // cuts the agent's TTS and flips mode to "listening". Commit
        // whatever was pending so the transcript reflects the partial
        // turn that was actually heard, and clear thinking since the
        // agent's response (if any) is no longer in flight.
        if (mode === "listening") {
          flushAgentQueueImmediate();
          useStore.getState().setVoiceThinking(false);
          stopThinkingWatcher();
        }
      },
      onError: (message: string) => {
        console.warn("[voice-eleven] session error:", message);
        // Surface to the chat pane so a silent drop has SOMETHING the
        // user can show us — otherwise "the convo dropped" is impossible
        // to diagnose without a dev console open.
        useStore.getState().appendMessage({
          role: "assistant",
          content: `Voice session error: ${message}`,
          system: true,
        });
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

// If the agent just wrote `path` and that path is currently open
// in any pane / as the single-pane current file, refresh the
// in-memory content — but only when the viewer is in VIEW mode.
// In edit mode the user's CodeMirror has its own state plus a
// debounced autosave; clobbering pane.content there races with
// the autosave (which holds a stale closure) and ends up writing
// the old content back over the agent's write. Path comparison
// normalises slashes so we don't miss matches because of forward
// vs backslash drift.
function refreshIfOpen(path: string, contents: string): void {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const target = norm(path);
  const store = useStore.getState();
  if (store.panes.length > 0) {
    for (const pane of store.panes) {
      if (norm(pane.file) === target && pane.mode === "view") {
        store.setPaneFile(pane.id, pane.file, contents);
      }
    }
  } else if (
    store.currentFile &&
    norm(store.currentFile) === target &&
    store.mode === "view"
  ) {
    store.reloadCurrent(path, contents);
  }
}

// Subscribes to the store and pushes a contextual update whenever
// the active pane / current file changes mid-session. Without this,
// switching pane focus in split view doesn't tell the agent — the
// per-viewer scroll listener only fires on actual scroll events.
function startViewportWatch(): void {
  let lastSig = "";
  unsubscribeViewportWatch = useStore.subscribe((state) => {
    const sig = `${state.activePaneId ?? ""}|${state.currentFile ?? ""}|${state.panes.map((p) => p.file).join(",")}`;
    if (sig === lastSig) return;
    lastSig = sig;
    pushViewportContextDebounced();
  });
}

function stopViewportWatch(): void {
  if (unsubscribeViewportWatch) {
    unsubscribeViewportWatch();
    unsubscribeViewportWatch = null;
  }
}

// Snapshot whatever the session wrote / noted into a single git
// commit so the user has the same "fall back to git" safety net
// they get from text-mode tool calls. Refreshes the file tree so
// newly-written files show up in the panel.
async function finalizeSessionMutations(): Promise<void> {
  const count = sessionMutationCount;
  const firstUser = sessionFirstUserText;
  sessionMutationCount = 0;
  sessionFirstUserText = null;
  if (count === 0) return;
  const vault = useStore.getState().vaultPath;
  if (!vault) return;
  const subject = firstUser
    ? `voice session: ${truncate(firstUser, 60)}`
    : "voice session";
  try {
    await gitCommitAll(vault, subject, true);
  } catch (e) {
    console.warn("[voice-eleven] auto-commit failed:", e);
  }
  try {
    const files = await invoke<FileEntry[]>("list_markdown_files", { vault });
    useStore.getState().setFiles(files);
  } catch (e) {
    console.warn("[voice-eleven] file tree refresh failed:", e);
  }
}

// Whole-utterance whitelist for client-side hang-up. Each entry has
// to match the entire transcribed turn (modulo trailing punctuation)
// so we don't false-positive on phrases that contain "bye" inside a
// longer sentence ("we said goodbye to that idea"). Add new phrases
// only if they're unambiguously a session-end signal.
const END_PHRASES = new Set([
  "goodbye",
  "bye",
  "bye bye",
  "okay bye",
  "ok bye",
  "alright bye",
  "thanks bye",
  "thank you bye",
  "we're done",
  "we are done",
  "i'm done",
  "im done",
  "i am done",
  "all done",
  "that's all",
  "thats all",
  "that is all",
  "that's all for now",
  "talk later",
  "talk to you later",
  "catch you later",
  "hang up",
  "end the call",
  "end this call",
  "end the conversation",
  "end this conversation",
  "end conversation",
]);

function looksLikeEnd(text: string): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/[.,!?]+$/g, "")
    .trim();
  return END_PHRASES.has(cleaned);
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
  // Commit any buffered agent text before tearing down — otherwise a
  // turn whose audio was still draining when the user hit "end" gets
  // dropped from the transcript.
  flushAgentQueueImmediate();
  const conv = activeConversation;
  activeConversation = null;
  // Cut audio synchronously before the async endSession() runs.
  // Without this, the user can keep speaking and the SDK keeps
  // streaming their audio to ElevenLabs until the WebSocket
  // actually closes — agent hears them and replies even though
  // they hit the mic toggle.
  if (conv) {
    try {
      conv.setMicMuted(true);
    } catch {}
  }
  // Clear voice state synchronously BEFORE the async endSession()
  // runs. Anything observing voiceMode flipping false (e.g.
  // waitForSpeechEnd's evaluate) now sees consistent state — no
  // window where voiceMode=false but voiceSpeaking is still true
  // from the prior turn.
  useStore.setState({ voiceMode: false });
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
  useStore.getState().setVoiceConnecting(false);
  useStore.getState().setVoiceCurrentTool(null);
  stopViewportWatch();
  if (!conv) return;
  try {
    await conv.endSession();
  } catch (e) {
    console.warn("[voice-eleven] end session failed:", e);
  }
}

// Gate primitive for "the agent has finished speaking this turn."
//
// Earlier versions of this code polled getOutputByteFrequencyData and
// resolved when amplitude dropped below a threshold for a window. That
// was wrong: the SDK's analyser sits post-gain after the audio worklet,
// so amplitude reads silent during the buffer-up phase at the start of
// every turn — the gate would fire BEFORE audio had played at all,
// which is what caused scrolls and chat text to race ahead of voice.
//
// Correct primitive: subscribe to `voiceSpeaking`, which the SDK
// derives from the audio worklet's drain signal (`handleAudio` →
// "speaking" on chunk arrival; worklet posts `finished:true` → mode
// "listening" when the buffer empties). This is the SDK's authoritative
// "audio is playing right now" flag.
//
// Wrinkle: mode can flip listening → speaking → listening multiple
// times within a single agent turn at inter-chunk gaps. So we require
// `voiceSpeaking` to stay false continuously for sustainedMs before
// resolving — distinguishes "real end-of-turn" from "tiny worklet gap
// between chunks." 250ms is enough to absorb chunk handoffs but short
// enough that post-turn actions feel snappy.
function waitForSpeechEnd(
  sustainedMs = 250,
  hardTimeoutMs = 30000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    // Whether we've observed voiceSpeaking flip true at least once.
    // Critical: this gate is often called *before* audio for the turn
    // starts arriving (tool calls can be dispatched ahead of the first
    // chunk). If we armed the sustained-false timer immediately when
    // speaking was already false, we'd resolve in 250ms — before TTS
    // had a chance to play. So we wait for the first audio chunk
    // (mode → speaking) before arming.
    let sawSpeaking = useStore.getState().voiceSpeaking;

    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
      clearTimeout(safetyTimer);
      resolve();
    };

    const evaluate = () => {
      const state = useStore.getState();
      // Session ended (manual end / disconnect / end_call). Don't sit
      // on the 30s hard timeout — there's no audio to wait for, and
      // any caller still parked here is blocking work that belongs to
      // a freshly-started next session. voiceMode is the source-of-
      // truth flag, flipped synchronously in endElevenLabsSession and
      // in onDisconnect.
      if (!state.voiceMode) {
        finish();
        return;
      }
      if (state.voiceSpeaking) {
        sawSpeaking = true;
        if (armTimer) {
          clearTimeout(armTimer);
          armTimer = null;
        }
      } else if (sawSpeaking && !armTimer) {
        armTimer = setTimeout(finish, sustainedMs);
      }
    };

    const safetyTimer = setTimeout(finish, hardTimeoutMs);
    const unsub = useStore.subscribe(evaluate);
    evaluate();
  });
}

// Safety net for voiceThinking: if neither mode → speaking nor
// barge-in fires within 8s of the user turn ending, force-clear the
// flag so the sine wave doesn't stick on screen forever. Normal path
// clears it inside onModeChange.
let thinkingSafetyTimeout: ReturnType<typeof setTimeout> | null = null;
function armThinkingSafetyTimeout(): void {
  stopThinkingWatcher();
  thinkingSafetyTimeout = setTimeout(() => {
    useStore.getState().setVoiceThinking(false);
    thinkingSafetyTimeout = null;
  }, 8000);
}
function stopThinkingWatcher(): void {
  if (thinkingSafetyTimeout !== null) {
    clearTimeout(thinkingSafetyTimeout);
    thinkingSafetyTimeout = null;
  }
}

// Tracks which PDF paths we've already uploaded to ElevenLabs during
// this session. We upload the WHOLE document once per file — Gemini
// (and Anthropic on the ElevenLabs side) accept PDF blobs natively and
// keep the doc in context, so per-page re-uploads burn tokens for
// nothing. The active page is communicated via the text contextual
// update path instead. Cleared on session end.
const sentPdfPaths = new Set<string>();
let pdfUploadInFlight = false;

// 50MB cap matches Gemini's per-PDF limit; ElevenLabs's conversation
// upload endpoint doesn't publish a cap, but going larger risks
// silent server-side rejection. Lectures are typically 5-20MB.
const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

// Ambient vision for voice mode: when the user opens a PDF, ship the
// full document to the live conversation so the agent's native LLM
// can see every page (text, equations, diagrams, layout — Gemini
// handles native PDFs without rasterizing). Skips if we've already
// sent this path this session. No-op for non-PDFs.
async function pushPdfIfNeeded(): Promise<void> {
  const conv = activeConversation;
  if (!conv) return;
  if (pdfUploadInFlight) return;
  const state = useStore.getState();
  if (!state.followAlong) return;
  const file = state.currentFile;
  if (!file) return;
  if (!file.toLowerCase().endsWith(".pdf")) return;
  if (sentPdfPaths.has(file)) return;

  pdfUploadInFlight = true;
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path: file });
    if (bytes.length > MAX_PDF_UPLOAD_BYTES) {
      console.warn(`[voice-eleven] PDF too large (${bytes.length} bytes) — skipping upload for ${file}`);
      sentPdfPaths.add(file); // mark so we don't retry every scroll
      return;
    }
    if (!activeConversation || activeConversation !== conv) return;
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    const { fileId } = await conv.uploadFile(blob);
    if (!activeConversation || activeConversation !== conv) return;
    const name = file.split(/[\\/]/).pop() ?? "document.pdf";
    conv.sendMultimodalMessage({
      text: `[The user has opened ${name}. The full PDF is attached for your reference — you can see every page including diagrams, equations, and layout. The viewport context will tell you which page they are currently viewing.]`,
      fileId,
    });
    sentPdfPaths.add(file);
  } catch (e) {
    console.warn("[voice-eleven] PDF upload failed:", e);
  } finally {
    pdfUploadInFlight = false;
  }
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
    if (text && text !== lastViewportSent) {
      lastViewportSent = text;
      try {
        conv.sendContextualUpdate(text);
      } catch (e) {
        console.warn("[voice-eleven] contextual update failed:", e);
      }
    }
    // Fire-and-forget the PDF push. Independent of the text update —
    // refocusing on the same PDF doesn't re-trigger an upload because
    // sentPdfPaths is a set.
    void pushPdfIfNeeded();
  }, SCROLL_DEBOUNCE_MS);
}

// Voice text panel uses these to send a typed reply into the live
// session (instead of speaking aloud) and to silence the mic while
// the panel is open. The agent still responds with TTS — only the
// user side flips from voice to text.

// Heads-up to the agent that we're composing a typed reply. Without
// this, the agent reads the muted-mic silence as a drop-off and
// escalates: a single "..." → "you still there?" → "I'll assume
// you've stepped away" → end_call. The contextual update is a system
// message in the SDK's vocabulary — the agent sees it but doesn't
// treat it as a user turn, so it just sits still and waits.
export function sendVoiceTypingHint(kind: "opened" | "still-typing"): void {
  const conv = activeConversation;
  if (!conv) return;
  const text =
    kind === "opened"
      ? "The user has opened the typed-input panel and is composing a reply. Stay silent. Do not check in, do not fill the silence, do not call end_call. Their typed message will arrive as a normal user turn — wait for it."
      : "The user is still typing in the panel. Keep waiting silently.";
  try {
    conv.sendContextualUpdate(text);
  } catch (e) {
    console.warn("[voice-eleven] typing-hint contextual update failed:", e);
  }
}

export function isVoiceSessionActive(): boolean {
  return activeConversation !== null;
}

export function setVoiceMicMuted(muted: boolean): void {
  const conv = activeConversation;
  if (!conv) return;
  try {
    conv.setMicMuted(muted);
  } catch (e) {
    console.warn("[voice-eleven] setMicMuted failed:", e);
  }
}

// Cut / restore the agent's TTS volume. Used by the text panel as a
// barge-in: the moment the user has typed enough characters to count
// as "intentionally interrupting" (>=2), we silence the agent so they
// can finish typing in peace. The server is still on its turn — when
// the user hits Enter, sendUserMessage triggers a real server-side
// interruption + new turn, and we restore volume so the next reply
// is audible.
export function setVoiceOutputMuted(muted: boolean): void {
  const conv = activeConversation;
  if (!conv) return;
  try {
    conv.setVolume({ volume: muted ? 0 : 1 });
  } catch (e) {
    console.warn("[voice-eleven] setVolume failed:", e);
  }
}

// Typed user turn. Mirrors what the SDK would emit when the user
// finishes speaking: append to chat, signal the "thinking" gate, and
// fire the user_message frame that triggers the agent's next turn
// (which naturally interrupts any TTS still playing).
export function sendVoiceUserText(text: string): boolean {
  const conv = activeConversation;
  if (!conv) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    conv.sendUserMessage(trimmed);
  } catch (e) {
    console.warn("[voice-eleven] sendUserMessage failed:", e);
    return false;
  }
  if (sessionFirstUserText === null) sessionFirstUserText = trimmed;
  useStore.getState().appendMessage({ role: "user", content: trimmed });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
}

// Typed user turn with an attached image (marquee capture). Uploads
// the blob, then sends a multimodal_message — same path pushPdfIfNeeded
// uses for ambient PDFs, but here it's a user turn that expects a
// reply rather than silent context.
export async function sendVoiceUserMultimodal(
  text: string,
  imageDataUrl: string,
): Promise<boolean> {
  const conv = activeConversation;
  if (!conv) return false;
  const trimmed = text.trim();
  try {
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();
    if (!activeConversation || activeConversation !== conv) return false;
    const { fileId } = await conv.uploadFile(blob);
    if (!activeConversation || activeConversation !== conv) return false;
    conv.sendMultimodalMessage({
      text: trimmed || undefined,
      fileId,
    });
  } catch (e) {
    console.warn("[voice-eleven] sendVoiceUserMultimodal failed:", e);
    return false;
  }
  const display = trimmed || "[image]";
  if (sessionFirstUserText === null) sessionFirstUserText = display;
  useStore.getState().appendMessage({ role: "user", content: display });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
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


// Built-in default for the personality / speech-rules header.
// Lives at the top of the system prompt and gets overridden if the
// user has a meta-vault `voice.md`. Kept as a constant + exported so
// users have a starting point if they want to fork it.
export const DEFAULT_VOICE_PROMPT_HEADER = `You are vault-chat. The user is talking to you with a microphone while they study.

You're a study companion, not a tour guide. The user is in charge of the session — you respond to where they take it. Be terse. Talk like a friend who happens to know the material, not like a teaching assistant filling time. It's fine to be quiet between turns. Real conversation tolerates silence.

CRITICAL — handling silence: the platform will prompt you to take a turn every ~30 seconds of user silence. This is automatic, NOT a signal that the user has left. Study sessions involve long reading and typing pauses. When you are prompted to speak but the user hasn't said anything new, call the skip_turn tool. Do not produce "you still there?" / "I'm here whenever" / "let me know when you're ready" / "I'll assume you've stepped away" filler. The user types replies in a side panel sometimes, which mutes their mic; that is not the user leaving. Only speak when the user has actually said or typed something for you to respond to.

Speech rules:
- Plain prose. No markdown — no asterisks, headers, bullets, code fences. No emoji.
- Short answers by default. Long-form is for when the user asks for depth.
- Open every response with a brief acknowledgment ("yeah", "sure", "mm", "got it", "one sec") so the user hears you immediately. Substance follows. The ack bridges the moment before the real answer arrives.
- Don't end your turn with "Want me to..." or "What would you like to next..." prompts. Answer and stop. If the user wants more, they'll ask.
- When asked to read content, call Read / Glob / Grep and speak it naturally.`;

// Compact file index for the system prompt. Voice mode struggles to
// "find" files when it has to guess paths from a name — dumping the
// real listing here gives the agent a direct map so it can construct
// absolute paths without a Glob round-trip. Cap is high enough for
// typical study vaults (~200 markdown + PDF + notebook files) without
// blowing up the prompt for huge ones.
const VAULT_INDEX_CAP = 250;

function buildVaultIndex(
  state: ReturnType<typeof useStore.getState>,
): string {
  const vault = state.vaultPath;
  if (!vault) return "";
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  const rels: string[] = [];
  for (const f of state.files) {
    if (f.is_dir || f.hidden || f.denied) continue;
    const np = f.path.replace(/\\/g, "/");
    const rel = np.startsWith(nv + "/") ? np.slice(nv.length + 1) : np;
    rels.push(rel);
  }
  if (rels.length === 0) return "";
  const shown = rels.slice(0, VAULT_INDEX_CAP);
  const more = rels.length > VAULT_INDEX_CAP
    ? `\n…(${rels.length - VAULT_INDEX_CAP} more files — use Glob to find them)`
    : "";
  return `Vault file index (${rels.length} files, ${shown.length} shown — all paths relative to vault root):\n${shown.join("\n")}${more}\n\nWhen the user names a file, prefer matching against this index FIRST before guessing or calling Glob. Construct absolute paths by joining the vault root with the relative path above.`;
}

/**
 * Gather the live voice context the box's phone-voice server needs to mint a
 * phone session: the ElevenLabs key + agent id, the system prompt + dynamic
 * variables (the vault context), the voice id, and the agent's tool names.
 * Reuses the exact same builders the desktop session uses, so the phone gets an
 * identical brain. Returns null when voice can't run yet (no key, no vault, or
 * the agent couldn't be provisioned).
 */
export async function buildPhoneVoiceContext(): Promise<{
  elKey: string;
  agentId: string;
  voiceId: string;
  systemPrompt: string;
  dynamicVariables: Record<string, string>;
  toolNames: string[];
  vault: string;
} | null> {
  const state = useStore.getState();
  const elKey = state.serviceKeys.elevenlabs;
  if (!elKey || !state.vaultPath) return null;
  const agentId = await ensureAgent(elKey);
  if (!agentId) return null;
  const customHeader = await loadVaultVoicePrompt(state.vaultPath);
  const northStar = await loadVaultNorthStar(state.vaultPath);
  return {
    elKey,
    agentId,
    voiceId: localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID,
    systemPrompt: buildSystemPrompt(state, customHeader, northStar),
    dynamicVariables: buildDynamicVariables(state),
    toolNames: Object.keys(buildClientToolHandlers()),
    vault: state.vaultPath,
  };
}

function buildSystemPrompt(
  state: ReturnType<typeof useStore.getState>,
  customHeader: string,
  northStar: string,
): string {
  const vault = state.vaultPath ?? "(no vault)";
  const recentHistory = formatRecentHistory(state.messages, 32);
  const followNote = state.followAlong
    ? "Follow-along is on. The active document and viewport are in dynamic variables and will refresh via contextual updates as the user scrolls."
    : "Follow-along is off. The user is not asking about a specific document unless they name one.";
  const header = customHeader.trim() || DEFAULT_VOICE_PROMPT_HEADER;
  const northStarBlock = northStarPromptBlock(northStar);
  const vaultIndex = buildVaultIndex(state);
  const gemini = isGeminiLlm(getCurrentLlm());
  // For Gemini the PDF blob is in the multimodal context — no
  // PdfExtract tool is registered, so the agent shouldn't be told
  // about it. For other LLMs (Claude / OpenAI on ElevenLabs) the
  // tool is the only way in.
  const pdfReadingLine = gemini
    ? "- PDFs: you can see them directly — the full document is in your multimodal context. Don't try to Read .pdf files as text; just look at the pages."
    : "- PdfExtract is how you read PDFs (Read won't work on .pdf). `pages` arg accepts '1', '1-5', '3,5,7'.";
  return [
    header,
    "",
    `Vault root (absolute): ${vault}`,
    "",
    northStarBlock ? `${northStarBlock}\n` : "",
    "Session start: do NOT open by greeting with an inventory. Never list, summarize, or read out the user's notes, files, or vault contents at the start of a session. Stay quiet until the user speaks; if you do open, keep it to one short line. Only call ListNotes when the user explicitly asks what they've flagged.",
    "",
    "Tools available to you:",
    "",
    "Reading & navigating files:",
    "- Read / ListDir take absolute paths — join the vault root with a relative path from the file index below. Bare filenames fail.",
    "- Glob takes a pattern relative to the vault root ('**/study.md', '**/*.md'). Case-insensitive, matches directories too — one call usually finds it.",
    "- Grep searches contents. Pass a path to scope, omit it for the whole vault.",
    pdfReadingLine,
    "",
    "Writing:",
    "- Write creates or overwrites a file. Plain markdown unless the extension implies otherwise. Stay inside the vault.",
    "- Edit replaces a unique string in an existing file — prefer over Write for small changes to large files.",
    "- NotebookEdit is the only safe way to touch .ipynb files. action='append' adds to a cell's end; 'replace' overwrites a cell; 'insert' adds a new cell at cell_index (-1 = end); 'delete' removes one. 0-based.",
    "",
    "Notes:",
    "- CreateNote saves a quick reminder when the user says 'remember', 'jot that down'. Keep notes brief.",
    "- ListNotes shows flagged items — only when the user asks for them; never to open a session. ResolveNote closes one when it's been addressed.",
    "",
    "Web:",
    "- WebFetch when you have a URL — reads the page as text.",
    "- WebSearch for current info or to find a URL. Requires a Tavily key; if missing the tool returns an error you can relay to the user.",
    "",
    "Shell:",
    "- Bash runs commands with the vault as cwd. Default timeout 20s; hard ceiling ~25s because the platform cuts off tool responses at 30s. For long-running things (cloning big repos, training runs, long installs), background with `nohup <cmd> > /tmp/run.log 2>&1 &` and poll the log file in later Bash calls.",
    "- Bash may be disabled in settings — if it returns an error to that effect, relay it to the user instead of trying to work around it.",
    "",
    "Document context (when a file is open):",
    "- You can see the full PDF the user has open — text, equations, diagrams, layout, all of it. Answer visual questions directly. Don't claim you can't see the screen.",
    "- The viewport context tells you which page they're currently on. When they say 'this', 'that math', 'explain this' — they mean their current page, not pages you recently discussed or pages that seem related. If they want a different page they'll name it.",
    "",
    "ScrollTo — moves the user's viewport to a page or anchor:",
    "- Reach for it when navigation is the natural response: they ask to move, they're going through pages with you, or you need to point at a different page to answer their question. Don't scroll just because you're mentioning another page — only when seeing it actually matters.",
    "- One ScrollTo per page transition, then narrate that page substantively before the next ScrollTo. Never fire multiple ScrollTo calls in a single response or chain them back-to-back — that races the viewport ahead of what you're saying.",
    "- Verbalize the move ('moving to page six, this one's about networking'). The viewport change applies at the next sentence boundary; keep talking through it.",
    "",
    "Misc:",
    "- '(no matches)' and '(empty)' are real results, not failures. Try a different angle.",
    "- Before guessing or Globbing, scan the Vault file index below — it has the real relative paths.",
    "- If Read errors 'No such file', Glob('**/<filename>') first, then Read the path Glob returns.",
    "- If a Read response ends with '…[truncated]' and you need more, narrow the target — don't pretend the tail doesn't exist.",
    "- If they speak while you're running a tool, briefly acknowledge ('one sec, still searching') and finish. Only abandon if they explicitly redirect.",
    "",
    `Examples for THIS vault:`,
    `- ListDir("${vault}")  → list the vault root`,
    `- Read("${vault}/study.md")  → read study.md if it's in the vault root`,
    `- Glob("**/study.md")  → find study.md anywhere in the vault`,
    `- Grep("gradient descent", undefined, "*.md")  → search markdown for "gradient descent"`,
    `- Write("${vault}/lectures/transformer-summary.md", "...")  → save a study summary`,
    `- CreateNote("review chapter 3 before next class")  → drop a quick reminder`,
    "",
    vaultIndex,
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

export function buildViewportContextText(
  state: ReturnType<typeof useStore.getState>,
): string {
  if (!state.followAlong) return "";
  const activeFile = state.currentFile;
  if (!activeFile) return "";

  const sections: string[] = [activeSectionFor(state, activeFile)];

  // Split view: include the OTHER pane(s) too so the agent knows
  // both files are visible. Marked OTHER vs ACTIVE so it can pick
  // the right one when the user says "this" or "that one".
  if (state.panes.length > 0) {
    for (const pane of state.panes) {
      if (pane.id === state.activePaneId) continue;
      const content = (pane.content ?? "").trim();
      const otherCap = 2000;
      sections.push(
        content
          ? `OTHER pane document: ${pane.file}\nContent:\n${truncate(content, otherCap)}`
          : `OTHER pane document: ${pane.file} (no text content)`,
      );
    }
  }

  return sections.join("\n\n---\n\n");
}

function activeSectionFor(
  state: ReturnType<typeof useStore.getState>,
  activeFile: string,
): string {
  const v: Viewport | null = state.viewport;
  if (v && v.path === activeFile) {
    if (v.page !== undefined && v.pageText) {
      const total = v.totalPages ?? "?";
      return `>>> USER IS CURRENTLY ON PAGE ${v.page} of ${total} of ${activeFile} <<<\nAny ambiguous reference ("this", "that", "this math", "what does this say") refers to PAGE ${v.page}, not other pages.\nPage ${v.page} text content:\n${truncate(v.pageText, VIEWPORT_TEXT_CAP)}`;
    }
    if (v.visibleText) {
      const pct =
        v.scrollRatio !== undefined ? Math.round(v.scrollRatio * 100) : null;
      const loc = pct !== null ? ` (scrolled ~${pct}%)` : "";
      return `>>> USER IS CURRENTLY VIEWING ${activeFile}${loc} <<<\nAny ambiguous reference refers to the visible portion below, not other parts of the document.\nVisible content:\n${truncate(v.visibleText, VIEWPORT_TEXT_CAP)}`;
    }
  }
  const fallback = (state.currentContent ?? "").trim();
  if (!fallback) {
    return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<< (no text content available; call Read for contents)`;
  }
  return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<<\nContent:\n${truncate(fallback, VIEWPORT_TEXT_CAP)}`;
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
              tools: [
                ...CLIENT_TOOL_DEFINITIONS
                  // Strip PdfExtract for Gemini — it reads PDFs from
                  // the multimodal blob directly, the tool is dead
                  // weight that occasionally distracts it.
                  .filter(
                    (t) =>
                      !(isGeminiLlm(wantedLlm) && t.name === "PdfExtract"),
                  )
                  .map((t) => ({
                  type: "client" as const,
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
                // NB: end_call is intentionally omitted. The agent
                // kept calling it after a few "you still there?"
                // check-ins on long study silences. Manual mic-off
                // + the client-side looksLikeEnd whitelist handle
                // every real "we're done" path.
                //
                // skip_turn: the actual lever for the check-in
                // problem. turn_timeout (max 30s) is platform-
                // enforced, so the agent gets prompted to take a
                // turn every 30s of user silence; the prompt rule
                // "don't produce a check-in" wasn't strong enough.
                // With skip_turn the agent has a concrete action to
                // take ("I have nothing to add → call skip_turn")
                // that produces actual silence instead of filler.
                { type: "system" as const, name: "skip_turn" },
              ],
            },
          },
          tts: {
            voice_id:
              localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID,
          },
          // ElevenLabs caps conversations at 10 minutes by default,
          // which is way too short for a study session — the platform
          // just hangs up with "Voice session ended." mid-explanation.
          // Bump to 2 hours.
          //
          // silence_end_call_timeout: -1 explicitly disables the
          // "user went quiet, hang up" behavior. The platform default
          // is supposedly -1 but at least some accounts seem to get
          // ~30s applied implicitly — setting it ourselves removes the
          // ambiguity. Study sessions involve long thinking pauses.
          conversation: {
            max_duration_seconds: 7200,
            silence_end_call_timeout: -1,
          },
          // turn_timeout is the duration ElevenLabs waits on user
          // silence before "re-engaging" the agent (prompting it for
          // another turn — which the LLM tends to fill with "you
          // still there?" check-ins, then escalates). Platform range
          // is 1-30s; not disable-able. Max it out so study pauses
          // breathe; the prompt also tells the agent to stay silent
          // when it IS re-engaged.
          turn: {
            turn_timeout: 30,
          },
          // Required for sendMultimodalMessage / file uploads to reach
          // the agent's LLM. Without `enabled: true` ElevenLabs accepts
          // the upload but doesn't forward the image content to the
          // model — multimodal messages would silently degrade to text.
          // Cap matches a normal study-session worth of slide flips;
          // we cache by (path, page) so practical churn is much lower.
          file_input: {
            enabled: true,
            max_files_per_conversation: 200,
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

// Convert a simple glob ('**', '*', '?') to a regex that matches the
// whole path. Used as a case-insensitive fallback for the voice Glob
// tool when the native, case-sensitive glob crate returns nothing —
// voice users say file names by sound, not by exact case, so 'hw3' has
// to match 'HW3'.
function globPatternToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // ** matches across path separators
      out += ".*";
      i += 2;
      if (pattern[i] === "/") i += 1;
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

// ---- Client tool implementations ----------------------------------------

// Format a path relative to the active vault, or fall back to the
// basename when the path lives outside the vault root. Keeps tool
// markers readable instead of dumping absolute Windows paths.
function relPath(path: string): string {
  if (!path) return "";
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(path).replace(/\/+$/, "");
  const vault = useStore.getState().vaultPath;
  if (vault) {
    const v = norm(vault).replace(/\/+$/, "");
    if (p === v) return ".";
    if (p.startsWith(v + "/")) return p.slice(v.length + 1);
  }
  const tail = p.split("/").pop();
  return tail || path;
}

// Render a one-line marker per tool — verb + target only, no JSON
// args, no result. Reads like a journal entry in the chat pane. No
// asterisks: ChatPane already wraps system messages in an italic
// span, so literal `*` would just render as text. Full result still
// goes to console.log for debugging.
function formatToolMarker(name: string, args: any): string {
  switch (name) {
    case "Read":
      return `Read ${relPath(args.path ?? "")}`;
    case "Write":
      return `Wrote ${relPath(args.path ?? "")}`;
    case "Edit":
      return `Edited ${relPath(args.path ?? "")}`;
    case "NotebookEdit": {
      const verb =
        args.action === "delete"
          ? "Deleted cell"
          : args.action === "insert"
            ? "Inserted cell"
            : args.action === "append"
              ? "Appended to cell"
              : "Edited cell";
      return `${verb} ${args.cell_index ?? "?"} in ${relPath(args.path ?? "")}`;
    }
    case "ListDir":
      return `Listed ${relPath(args.path ?? "")}`;
    case "Glob":
      return `Searched files matching "${args.pattern ?? ""}"`;
    case "Grep":
      return `Searched "${args.pattern ?? ""}"`;
    case "PdfExtract": {
      const pages = args.pages ? ` (pages ${args.pages})` : "";
      return `Extracted ${relPath(args.path ?? "")}${pages}`;
    }
    case "ScrollTo": {
      const where = typeof args.page === "number" ? `page ${args.page}` : (args.anchor ?? "?");
      return `Scrolled to ${where}`;
    }
    case "ListNotes":
      return `Listed ${args.status ?? "open"} notes`;
    case "ResolveNote":
      return `Resolved note ${args.id ?? ""}`;
    case "ReopenNote":
      return `Reopened note ${args.id ?? ""}`;
    case "GitLog":
      return `Read git log of ${args.subdir || "."}`;
    case "ListConversations":
      return `Listed conversations`;
    case "ReadConversation":
      return `Read conversation ${args.conversation_id ?? ""}`;
    case "ListSchedules":
      return `Listed schedules`;
    case "CancelSchedule":
      return `Cancelled schedule ${args.schedule_id ?? ""}`;
    case "Schedule":
      return `Scheduled "${String(args.prompt ?? "").slice(0, 50)}"`;
    case "CreateNote": {
      const text = (args.text ?? "").trim();
      const snip = text.length > 50 ? text.slice(0, 47) + "…" : text;
      return `Saved note "${snip}"`;
    }
    case "WebFetch":
      return `Fetched ${args.url ?? ""}`;
    case "WebSearch":
      return `Searched web for "${args.query ?? ""}"`;
    case "Bash": {
      const cmd = String(args.command ?? "").trim().replace(/\s+/g, " ");
      const snip = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
      return `$ ${snip}`;
    }
    default:
      return name;
  }
}

function logToolCall(name: string, args: any, result: string): void {
  const argsStr = JSON.stringify(args);
  const summary = result.length > 200 ? result.slice(0, 200) + "…" : result;
  console.log(`[voice-eleven] tool ${name}(${argsStr}) →`, summary);
  useStore.getState().appendMessage({
    role: "assistant",
    content: formatToolMarker(name, args),
    system: true,
  });
}

// Wraps a tool handler so the cockpit knows what's running. Sets
// voiceCurrentTool before the impl fires and clears it after, so
// the titlebar pill can show "Running ToolName…" while the work
// happens. Always logs to chat regardless of success/failure.
function withTracking<A>(
  name: string,
  impl: (args: A) => Promise<string>,
): (args: A) => Promise<string> {
  return async (args: A) => {
    useStore.getState().setVoiceCurrentTool(name);
    let result: string;
    try {
      result = await impl(args);
    } finally {
      useStore.getState().setVoiceCurrentTool(null);
    }
    logToolCall(name, args, result);
    return result;
  };
}

export function buildClientToolHandlers(): Record<
  string,
  (parameters: any) => Promise<string>
> {
  return {
    Read: withTracking("Read", async (args: { path: string }) => {
      try {
        const raw = await invoke<string>("read_text_file", { path: args.path });
        // .ipynb is JSON noise — strip to "# Cell N [type]\n<source>"
        // sections like text-mode does, otherwise notebook metadata
        // burns the whole READ_CAP before any actual code shows up.
        const isNotebook = /\.ipynb$/i.test(args.path);
        const text = isNotebook ? stripNotebook(raw) : raw;
        return text.length > READ_CAP
          ? text.slice(0, READ_CAP) + "\n…[truncated]"
          : text;
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
    }),
    Glob: withTracking("Glob", async (args: { pattern: string }) => {
      const vault = useStore.getState().vaultPath;
      if (!vault) return "Error: no active vault";
      try {
        const results = await invoke<string[]>("glob_files", {
          pattern: args.pattern,
          cwd: vault,
        });
        if (results.length > 0) {
          const out = results.slice(0, 200).join("\n");
          return results.length > 200
            ? out + `\n…(${results.length - 200} more)`
            : out;
        }
        // Fallback: native glob is case-sensitive and only returns
        // files, so 'hw3.ipynb' misses 'HW3.ipynb' and '**/HW3' misses
        // the HW3 directory. Scan state.files in JS with a
        // case-insensitive regex that also includes directories.
        const regex = globPatternToRegex(args.pattern);
        const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
        const fallback: string[] = [];
        for (const f of useStore.getState().files) {
          if (f.hidden || f.denied) continue;
          const np = f.path.replace(/\\/g, "/");
          const rel = np.startsWith(nv + "/") ? np.slice(nv.length + 1) : np;
          if (regex.test(rel)) fallback.push(f.path + (f.is_dir ? "/" : ""));
        }
        if (fallback.length === 0) return "(no matches)";
        const out = fallback.slice(0, 200).join("\n");
        return fallback.length > 200
          ? `${out}\n…(${fallback.length - 200} more) [case-insensitive fallback]`
          : `${out}\n[case-insensitive fallback]`;
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
    }),
    Grep: withTracking(
      "Grep",
      async (args: {
        pattern: string;
        path?: string;
        glob_filter?: string;
        case_insensitive?: boolean;
      }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
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
          if (!results.length) return "(no matches)";
          return results
            .slice(0, 100)
            .map((r) => `${r.path}:${r.line}: ${r.text}`)
            .join("\n");
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ListDir: withTracking("ListDir", async (args: { path: string }) => {
      try {
        const entries = await invoke<{ name: string; is_dir: boolean }[]>(
          "list_dir",
          { path: args.path },
        );
        if (!entries.length) return "(empty)";
        return entries
          .map((e) => (e.is_dir ? `${e.name}/` : e.name))
          .join("\n");
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
    }),
    Write: withTracking(
      "Write",
      async (args: { path: string; contents: string }) => {
        try {
          const v = useStore.getState().vaultPath;
          if (v) {
            try {
              await assertCanWrite(args.path, v);
            } catch (e) {
              return (e as Error).message;
            }
          }
          await invoke("write_text_file", {
            path: args.path,
            contents: args.contents,
          });
          sessionMutationCount++;
          // If the file the agent just wrote is currently open in a
          // viewer, push the new content into the store immediately
          // so the user sees the edit without having to re-open. We
          // use the bytes the agent supplied — same content the
          // file now contains on disk.
          refreshIfOpen(args.path, args.contents);
          return `Wrote ${args.path}`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    CreateNote: withTracking(
      "CreateNote",
      async (args: {
        text: string;
        source_path?: string;
        source_anchor?: string;
      }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
        const anchors = args.source_path
          ? [
              {
                source_path: args.source_path,
                source_kind: "code" as const,
                source_anchor: args.source_anchor ?? null,
                primary: true,
              },
            ]
          : [];
        try {
          const note = buildNote({ anchors, userDraft: args.text });
          await useStore.getState().addNote(note);
          sessionMutationCount++;
          return `Saved note ${note.id}.`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    Edit: withTracking(
      "Edit",
      async (args: {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      }) => {
        try {
          const v = useStore.getState().vaultPath;
          if (v) {
            try {
              await assertCanWrite(args.path, v);
            } catch (e) {
              return (e as Error).message;
            }
          }
          const summary = await invoke<string>("edit_text_file", {
            path: args.path,
            oldString: args.old_string,
            newString: args.new_string,
            replaceAll: args.replace_all ?? false,
          });
          sessionMutationCount++;
          // Re-read the file so any open viewer reflects the edit.
          try {
            const fresh = await invoke<string>("read_text_file", { path: args.path });
            refreshIfOpen(args.path, fresh);
          } catch {}
          return summary;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    NotebookEdit: withTracking(
      "NotebookEdit",
      async (args: {
        path: string;
        action: "replace" | "insert" | "delete" | "append";
        cell_index: number;
        source?: string;
        cell_type?: "code" | "markdown" | "raw";
      }) => {
        try {
          const v = useStore.getState().vaultPath;
          if (v) {
            try {
              await assertCanWrite(args.path, v);
            } catch (e) {
              return (e as Error).message;
            }
          }
          const raw = await invoke<string>("read_text_file", { path: args.path });
          const result = applyNotebookEdit(
            raw,
            args.action,
            args.cell_index,
            args.source,
            args.cell_type,
          );
          if (!result.ok) return `Error: ${result.error}`;
          await invoke("write_text_file", { path: args.path, contents: result.contents });
          sessionMutationCount++;
          refreshIfOpen(args.path, result.contents);
          return `${result.summary} in ${args.path}`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    PdfExtract: withTracking(
      "PdfExtract",
      async (args: { path: string; pages?: string }) => {
        try {
          const text = await extractPdfText(args.path, args.pages);
          return text.length > PDF_CAP
            ? text.slice(0, PDF_CAP) + "\n…[truncated]"
            : text;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ScrollTo: withTracking(
      "ScrollTo",
      async (args: { page?: number; anchor?: string; path?: string }) => {
        const state = useStore.getState();
        const targetPath = args.path ?? state.currentFile;
        if (!targetPath) return "Error: no file is currently open.";
        let anchor: string;
        if (typeof args.page === "number" && Number.isFinite(args.page)) {
          anchor = `page=${Math.max(1, Math.floor(args.page))}`;
        } else if (args.anchor && args.anchor.trim().length > 0) {
          anchor = args.anchor.trim();
        } else {
          return "Error: must provide either `page` (for PDFs) or `anchor` (for other file types).";
        }
        // Coalesce: if the agent emits multiple ScrollTo calls before
        // audio drains (common pattern — it "previews" the tour by
        // firing ScrollTo for every page it plans to mention), they'd
        // each wait for end-of-speech and then fire serially, marching
        // the viewport past the narration. Instead, only the LATEST
        // target wins. Earlier calls return immediately with a
        // superseded marker; the most-recent call is the one that
        // awaits speech end and applies. Result: no matter how many
        // scrolls queue up, exactly one viewport movement lands when
        // the agent actually stops talking.
        const myGen = ++scrollGen;
        pendingScrollTarget = { path: targetPath, anchor };
        await waitForSpeechEnd();
        if (myGen !== scrollGen) {
          return `Superseded by later ScrollTo`;
        }
        const target = pendingScrollTarget;
        pendingScrollTarget = null;
        if (!target) {
          return `Superseded by later ScrollTo`;
        }
        useStore.getState().requestScrollAnchor(target.path, target.anchor);
        return `Scrolled to ${target.anchor} in ${target.path}`;
      },
    ),
    ListNotes: withTracking(
      "ListNotes",
      async (args: { status?: "open" | "resolved" | "all"; limit?: number }) => {
        const status = args.status ?? "open";
        const limit = args.limit ?? 50;
        const notes = useStore.getState().notes;
        const filtered = notes.filter(
          (n) => status === "all" || n.status === status,
        );
        const sliced = filtered.slice(0, limit);
        if (sliced.length === 0) {
          return `No ${status === "all" ? "" : status + " "}notes.`;
        }
        const lines = sliced.map((n) => {
          const primary = n.anchors.find((a) => a.primary) ?? n.anchors[0];
          const anchor = primary
            ? `${primary.source_path.split("/").pop()}${primary.source_anchor ? ` (${primary.source_anchor})` : ""}`
            : "(no anchor)";
          const body =
            n.formatted ??
            n.user_draft ??
            (n.turns[0]?.content ?? "").slice(0, 160);
          return `[${n.id}] ${n.status} · ${anchor} · ${n.timestamp.slice(0, 16)}\n  ${body.replace(/\n+/g, " ")}`;
        });
        return `${filtered.length} note${filtered.length === 1 ? "" : "s"} (showing ${sliced.length}):\n\n${lines.join("\n\n")}`;
      },
    ),
    ResolveNote: withTracking(
      "ResolveNote",
      async (args: { id: string }) => {
        const n = useStore.getState().notes.find((n) => n.id === args.id);
        if (!n) return `No note with id "${args.id}".`;
        if (n.status === "resolved") {
          return `Note ${args.id} was already resolved.`;
        }
        try {
          await useStore.getState().setNoteStatus(args.id, "resolved");
          sessionMutationCount++;
          return `Resolved note ${args.id}.`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    WebFetch: withTracking(
      "WebFetch",
      async (args: { url: string; max_chars?: number }) => {
        try {
          // Voice context is smaller than text — cap tighter by default
          // so a long page doesn't blow the prompt budget.
          const cap = args.max_chars ?? 24_000;
          return await invoke<string>("http_fetch", {
            url: args.url,
            maxChars: cap,
          });
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    WebSearch: withTracking(
      "WebSearch",
      async (args: { query: string; max_results?: number }) => {
        const tavilyKey = useStore.getState().serviceKeys.tavily;
        if (!tavilyKey) {
          return "Error: WebSearch needs a Tavily API key — the user can add one in Settings.";
        }
        try {
          return await invoke<string>("tavily_search", {
            query: args.query,
            apiKey: tavilyKey,
            maxResults: args.max_results ?? null,
            includeAnswer: true,
          });
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    Bash: withTracking(
      "Bash",
      async (args: { command: string; cwd?: string; timeout_ms?: number }) => {
        const state = useStore.getState();
        if (state.bashDisabled) {
          return "Error: Bash is disabled in this app's settings. The user can enable it in Settings → Agent.";
        }
        const vault = state.vaultPath;
        if (!vault) return "Error: no active vault";
        // Mirror text-mode's best-effort path gates so the voice agent
        // can't trivially read denylisted or humanized files via shell
        // tricks. Same caveat as text mode: shell indirection can still
        // smuggle these — the gate is a tripwire, not a sandbox.
        try {
          const denyLines = await invoke<string[]>("read_deny_lines", { vault });
          const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
          for (const raw of denyLines) {
            const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            if (!rel) continue;
            if (args.command.includes(rel) || args.command.includes(`${nv}/${rel}`)) {
              return `Refused: command references restricted path '${rel}'.`;
            }
          }
        } catch {
          // No deny file or read failed — proceed.
        }
        try {
          const humanized = await invoke<string[]>("read_humanized", { vault });
          const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
          for (const raw of humanized) {
            const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            if (!rel) continue;
            if (args.command.includes(rel) || args.command.includes(`${nv}/${rel}`)) {
              return "Refused: command references a humanized file.";
            }
          }
        } catch {
          // proceed
        }
        // ElevenLabs caps tool response at 30s. Default 20s leaves
        // headroom; clamp at 25s so the agent can't accidentally
        // request a timeout that exceeds the platform ceiling.
        const timeout = Math.min(args.timeout_ms ?? 20_000, 25_000);
        try {
          const result = await invoke<{
            stdout: string;
            stderr: string;
            code: number;
            timed_out: boolean;
          }>("bash_exec", {
            command: args.command,
            cwd: args.cwd ?? vault,
            timeoutMs: timeout,
          });
          const cap = 8_000;
          const clip = (s: string) =>
            s.length > cap ? s.slice(0, cap) + "\n…[truncated]" : s;
          const parts: string[] = [];
          parts.push(`exit: ${result.code}${result.timed_out ? " (TIMED OUT)" : ""}`);
          if (result.stdout) parts.push(`stdout:\n${clip(result.stdout)}`);
          if (result.stderr) parts.push(`stderr:\n${clip(result.stderr)}`);
          return parts.join("\n");
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ReopenNote: withTracking("ReopenNote", async (args: { id: string }) => {
      const n = useStore.getState().notes.find((n) => n.id === args.id);
      if (!n) return `No note with id "${args.id}".`;
      if (n.status === "open") return `Note ${args.id} is already open.`;
      try {
        await useStore.getState().setNoteStatus(args.id, "open");
        sessionMutationCount++;
        return `Reopened note ${args.id}.`;
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
    }),
    GitLog: withTracking(
      "GitLog",
      async (args: {
        subdir: string;
        since?: string;
        author?: string;
        max_count?: number;
      }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
        try {
          const { gitLogSubdir } = await import("./git");
          const out = await gitLogSubdir(vault, args.subdir ?? ".", {
            since: args.since,
            author: args.author,
            maxCount: args.max_count,
          });
          return out.trim() === "" ? "(no commits match)" : out;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ListConversations: withTracking(
      "ListConversations",
      async (args: { limit?: number }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
        const current = useStore.getState().activeConversationId;
        const cap = Math.max(1, Math.min(100, args.limit ?? 20));
        try {
          const { readConversations } = await import("./conversations");
          const list = await readConversations(vault);
          const filtered = list
            .filter((c) => c.id !== current)
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .slice(0, cap);
          if (filtered.length === 0) return "(no other conversations)";
          const fmt = (ts: number) => {
            const diff = Date.now() - ts;
            const min = Math.floor(diff / 60_000);
            if (min < 60) return `${Math.max(0, min)}m ago`;
            const hr = Math.floor(min / 60);
            if (hr < 24) return `${hr}h ago`;
            return `${Math.floor(hr / 24)}d ago`;
          };
          return filtered
            .map((c) =>
              JSON.stringify({
                id: c.id,
                title: c.title || "(untitled)",
                source: c.source,
                status: c.status,
                unread: !!c.unread,
                messageCount: c.messages.length,
                lastActivity: fmt(c.lastActivityAt),
              }),
            )
            .join("\n");
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ReadConversation: withTracking(
      "ReadConversation",
      async (args: { conversation_id: string; last_n?: number }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
        const cap = Math.max(1, Math.min(50, args.last_n ?? 12));
        try {
          const { readConversations } = await import("./conversations");
          const list = await readConversations(vault);
          const conv = list.find((c) => c.id === args.conversation_id);
          if (!conv) return `Conversation not found: ${args.conversation_id}`;
          const tail = conv.messages.slice(-cap);
          const lines: string[] = [
            `# ${conv.title || "(untitled)"} [${conv.status}]`,
            `source: ${conv.source} · ${conv.messages.length} total messages`,
            ...tail.map((m) => {
              const content = (m.content ?? "").slice(0, 800);
              const tools =
                m.toolCalls && m.toolCalls.length > 0
                  ? `\n  tools: ${m.toolCalls
                      .map((t) => `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 80)})`)
                      .join(", ")}`
                  : "";
              return `[${m.role}${m.hidden ? " hidden" : ""}] ${content}${content.length === 800 ? "…" : ""}${tools}`;
            }),
          ];
          return lines.join("\n\n");
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ListSchedules: withTracking("ListSchedules", async () => {
      const vault = useStore.getState().vaultPath;
      if (!vault) return "Error: no active vault";
      try {
        const { readSchedules, nextFireAt, recurrenceLabel } = await import("./schedules");
        const list = await readSchedules(vault);
        if (list.length === 0) return "(no schedules set)";
        return list
          .map((s) => {
            const next = nextFireAt(s);
            return JSON.stringify({
              id: s.id,
              name: s.name || "(unnamed)",
              prompt: s.prompt.slice(0, 200),
              recurrence: recurrenceLabel(s.recurrence),
              time: s.time,
              date: s.date,
              nextFire: next ? new Date(next).toLocaleString() : "(none)",
              target:
                s.target.kind === "existing"
                  ? `chat:${s.target.conversationId}`
                  : "new chat",
              enabled: s.enabled,
              sendViaTelegram: s.sendViaTelegram,
            });
          })
          .join("\n");
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
    }),
    CancelSchedule: withTracking(
      "CancelSchedule",
      async (args: { schedule_id: string }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "Error: no active vault";
        try {
          const { readSchedules, writeSchedules } = await import("./schedules");
          const list = await readSchedules(vault);
          const target = list.find((s) => s.id === args.schedule_id);
          if (!target) return `No schedule with id ${args.schedule_id}.`;
          const next = list.filter((s) => s.id !== args.schedule_id);
          await writeSchedules(vault, next);
          return `Cancelled: ${target.name || target.prompt.slice(0, 60)}`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    Schedule: withTracking(
      "Schedule",
      async (args: {
        prompt: string;
        description?: string;
        when_iso?: string;
        daily_at?: string;
        weekdays_at?: string;
        every_minutes?: number;
      }) => {
        const state = useStore.getState();
        const vault = state.vaultPath;
        if (!vault) return "Error: no active vault";
        const conversationId = state.activeConversationId;
        if (!conversationId) {
          return "Schedule tool unavailable: no current conversation id.";
        }
        const { prompt, description, when_iso, daily_at, weekdays_at, every_minutes } = args;
        const recurrenceOptions = [
          when_iso ? "when_iso" : null,
          daily_at ? "daily_at" : null,
          weekdays_at ? "weekdays_at" : null,
          every_minutes ? "every_minutes" : null,
        ].filter(Boolean);
        if (recurrenceOptions.length === 0) {
          return "Set exactly one of when_iso, daily_at, weekdays_at, or every_minutes.";
        }
        if (recurrenceOptions.length > 1) {
          return `Set exactly one recurrence option (got ${recurrenceOptions.join(", ")}).`;
        }

        let recurrence: import("./schedules").Recurrence;
        let time = "08:00";
        let date: string | undefined;
        let fireDescription: string;

        if (when_iso) {
          const dt = new Date(when_iso);
          if (isNaN(dt.getTime())) {
            return `Invalid datetime '${when_iso}'. Use ISO local format like 2026-05-29T21:30.`;
          }
          if (dt.getTime() <= Date.now()) {
            return `Refusing to schedule in the past (${when_iso}). Pick a future time.`;
          }
          recurrence = { kind: "once" };
          date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
          time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
          fireDescription = `once at ${dt.toLocaleString()}`;
        } else if (daily_at) {
          if (!/^\d{1,2}:\d{2}$/.test(daily_at)) {
            return `Invalid daily_at '${daily_at}'. Use 'HH:MM' 24h format like 08:00.`;
          }
          recurrence = { kind: "daily" };
          time = daily_at.padStart(5, "0");
          fireDescription = `daily at ${time}`;
        } else if (weekdays_at) {
          if (!/^\d{1,2}:\d{2}$/.test(weekdays_at)) {
            return `Invalid weekdays_at '${weekdays_at}'. Use 'HH:MM' 24h format like 08:00.`;
          }
          recurrence = { kind: "weekdays" };
          time = weekdays_at.padStart(5, "0");
          fireDescription = `weekdays at ${time}`;
        } else {
          const n = every_minutes!;
          if (n < 5) {
            return `every_minutes minimum is 5 (got ${n}). Anything finer is just burning API calls.`;
          }
          recurrence = { kind: "every", minutes: n };
          fireDescription = `every ${n} minutes`;
        }

        try {
          const { readSchedules, writeSchedules, emptySchedule } = await import("./schedules");
          const list = await readSchedules(vault);
          const fresh = {
            ...emptySchedule(state.modelId),
            name: description ?? prompt.split(/\s+/).slice(0, 6).join(" "),
            prompt,
            recurrence,
            time,
            date,
            target: { kind: "existing" as const, conversationId },
            enabled: true,
            markUnreadOnFinish: true,
            sendViaTelegram: false,
          };
          await writeSchedules(vault, [...list, fresh]);
          return `Scheduled ${fireDescription}. Will fire as a turn in this conversation.`;
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
  };
}
