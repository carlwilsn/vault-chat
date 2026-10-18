import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage, type Viewport, type FileEntry } from "./store";
import { buildNote } from "./notes";
import { gitCommitAll } from "./git";
import { loadVaultVoicePrompt, loadVaultNorthStar, northStarPromptBlock, loadVaultMemoryIndex, vaultMemoryPromptBlock, loadVaultVoiceTools, type VaultVoiceTool } from "./meta";
// `Conversation` (the value) is the ElevenLabs SDK class imported above; alias
// our thread type so the names don't collide.
import { emptyConversation, type Conversation as ConvThread } from "./conversations";
import { applyNotebookEdit, readPdf, stripNotebook, assertCanWrite } from "./tools";
import { loadSessionContext } from "./context";
import { loadSkills, skillPromptIndex } from "./skills";
import { voiceLineEntry, voiceToolEntry } from "./activityCore";
import { cachedVoiceMath, displayVoiceMath, prefetchVoiceMath } from "./voiceMath";
import { MAX_IMAGE_UPLOAD_BYTES, VoiceImagePusher, lookingAtNote, sendFilesMessage, shrinkImage, thumbDataUrl, voiceImageMime, type PushResult } from "./voiceImages";
import { fileKind, isUnreadableAsText } from "./fileKind";
import { awaitScroll } from "./scrollTarget";
import { stripAudioTags } from "./voiceTags";
import { QuietGate } from "./voiceQuiet";
import { RECONNECT_NUDGE, RECONNECTING_LINE, TimeoutRetry, VoiceTurnStats, couldntReconnectLine, isLlmTimeoutClose, plainCloseReason, reconnectRecap } from "./voiceTimeout";
import { vlog } from "./debugLog";
import { VoiceHealth, connectionOptions, pickTransport, type HealthEvent, type Transport } from "./voiceHealth";
import { DEFAULT_VOICE_LLM, isVoiceLlm, llmInfo, normalizeVoiceLlm, reasoningEffortFor, voiceLlmList, type VoiceLlmInfo } from "./voiceLlms";

// The shared context stream (src/activity.ts), when voice runs on this laptop:
// the box records its own sessions (server/voice.ts). Loaded lazily — the box
// bundles this module too.
function recordLocalVoice(e: Parameters<typeof import("./activity").recordActivity>[1] | null): void {
  if (!e) return;
  const vault = useStore.getState().vaultPath;
  void import("./activity").then((a) => a.recordActivity(vault, e)).catch(() => undefined);
}

// Voice mode runs as an ElevenLabs Conversational AI session: their
// platform owns the audio loop (STT + LLM + TTS) and we provide the
// brain config (Claude), per-session prompt context, scroll-driven
// updates, and client-side read tools. Transcripts come back via
// SDK events and get appended to state.messages when the session
// ends.

// WebKitGTK (Linux) can't play Web Audio on the current Ubuntu stack, so there
// voice runs over the WebSocket transport and the agent's voice is routed to
// native playback in the Rust backend (16 kHz PCM chunks). Everywhere else voice
// runs over WebRTC (ElevenLabs' recommended transport) and the SDK plays it —
// no audio code of ours on that path.

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

// Box mode: the session's lines are saved on the box as they land (voiceBox.ts
// voiceTranscriptMirror). Null when voice runs here.
let transcriptMirror: { push: (m: ChatMessage) => unknown; id?: () => string; done?: () => Promise<unknown> } | null = null;
// The live session's chats: its own thread (box mode: the box's id once the
// first line made it) and the one it started from — SetProject's target.
let voiceChats: { own: () => string | null; from: string | null; local?: string } | null = null;
// The box's vault root (absolute paths in the box's prompt) — mapped back to
// this vault for ScrollTo.
let boxVaultRoot: string | null = null;
function voiceAppend(m: ChatMessage): void {
  if (m.role === "assistant" && !m.system && typeof m.content === "string") {
    const content = stripAudioTags(m.content);
    if (!content) return;
    if (content !== m.content) m = { ...m, content };
  }
  // Box mode: the line is the box's to write (its voice conversation's log); this client shows it
  // under the same id until the log brings it (voiceBox.ts) — it never writes a box conversation.
  if (transcriptMirror) {
    void transcriptMirror.push(m);
    return;
  }
  // A tool call: the chat's tool row (its marker is only for the box's older readers).
  if (m.toolCalls?.length) {
    useStore.getState().appendMessage({ role: "assistant", content: "", toolCalls: m.toolCalls });
    return;
  }
  // Spoken math shows as notation (voiceMath.ts): already formatted (the agent's
  // lines are prefetched while their audio plays), or formatted when it returns.
  const shown = m.system ? undefined : cachedVoiceMath(String(m.content ?? ""));
  useStore.getState().appendMessage(shown ? { ...m, display: shown } : m);
  if (shown === undefined && !m.system) {
    const last = useStore.getState().messages[useStore.getState().messages.length - 1];
    if (last && last.content === m.content) displayVoiceMath(last);
  }
  if (!m.system && (m.role === "user" || m.role === "assistant")) {
    recordLocalVoice(voiceLineEntry(m.role, String(m.content ?? ""), useStore.getState().activeConversationId));
  }
}
// The voice model — Settings → Models → Voice; stored as `vault_chat_elevenlabs_llm`.
// The ids, the default and the old-id mapping are src/voiceLlms.ts; what each
// model can take (images, documents) comes from ElevenLabs' own list.
export const DEFAULT_LLM = DEFAULT_VOICE_LLM;
const LLM_STORAGE = "vault_chat_elevenlabs_llm";
const AGENT_LLM_KEY = "vault_chat_elevenlabs_agent_llm";

/** Every id a client may send (current, and old ones that map to a current one). */
export const SUPPORTED_VOICE_LLMS = { has: (v: string) => isVoiceLlm(v) };

// A stored old id maps to the nearest current one; nothing stored is the default.
function getCurrentLlm(): string {
  return normalizeVoiceLlm(localStorage.getItem(LLM_STORAGE));
}

/** What the current model takes, from the cached list (sync; null = not known yet). */
function cachedLlmInfo(llm: string): VoiceLlmInfo | null {
  try {
    const raw = localStorage.getItem("vault_chat_elevenlabs_llm_list");
    return raw ? llmInfo((JSON.parse(raw) as { list: VoiceLlmInfo[] }).list, llm) : null;
  } catch {
    return null;
  }
}
/** The model reads an uploaded PDF itself (else it gets PdfExtract and no upload). */
function readsDocuments(llm: string): boolean {
  return cachedLlmInfo(llm)?.documents === true;
}
/** The model sees uploaded images (unknown counts as yes, as before the list). */
function seesImages(llm: string): boolean {
  return cachedLlmInfo(llm)?.images !== false;
}
const AGENT_ID_KEY = "vault_chat_elevenlabs_agent_id";
// Bump whenever the agent-create body changes in a way that affects
// the agent itself — tool schema, expects_response flags, override
// permissions. Mismatch with the cached agent triggers re-provision
// on next session, so updates roll out without manual intervention.
const AGENT_CONFIG_VERSION = "v27-cascade";
const AGENT_VERSION_KEY = "vault_chat_elevenlabs_agent_config_version";
// Signature of the per-vault custom tools baked into the cached agent. Custom
// tools are part of the agent's tool schema (provisioned at create time), so a
// tool added/removed/edited in the vault must force a re-provision the same way
// an LLM or config-version change does — otherwise voice keeps offering the old
// set. Mismatch with the live signature triggers a rebuild on next ensureAgent.
const AGENT_TOOLS_SIG_KEY = "vault_chat_elevenlabs_agent_tools_sig";
// The voice the provisioned agent speaks with. The session also overrides it
// (platform_settings allows tts.voice_id), but the agent's own voice is set too
// (PATCH), so the voice never rests on the override alone and ElevenLabs says
// at once, in words, when it refuses a voice.
const AGENT_VOICE_KEY = "vault_chat_elevenlabs_agent_voice";

// Custom voice tools per vault, refreshed on every ensureAgent (the
// provisioning authority). buildClientToolHandlers / buildSystemPrompt read
// them synchronously — ensureAgent always runs first on every voice path
// (desktop session start, phone /session context build, launch + heartbeat), so
// they're warm by the time tools are called. Keyed by vault: the box builds
// sessions for several vaults at once, and one vault's tools must never reach
// another's session.
const voiceToolCache = new Map<string, VaultVoiceTool[]>();
function toolsFor(vault: string | null | undefined): VaultVoiceTool[] {
  return (vault && voiceToolCache.get(vault)) || [];
}

// A stable fingerprint of the custom tool set — names + parameter shapes — so a
// changed vault re-provisions the agent. Order-independent: sort by name.
function voiceToolsSignature(tools: VaultVoiceTool[]): string {
  return tools
    .map((t) => `${t.name}:${JSON.stringify(t.parameters)}`)
    .sort()
    .join("|");
}

// Load the active vault's custom tools and refresh the module cache. Returns the
// list so callers can build the agent's tool schema from the same snapshot the
// handlers will use. Degrades to [] (built-ins only) on any failure.
async function refreshVoiceTools(vaultOverride?: string): Promise<VaultVoiceTool[]> {
  const vault = vaultOverride ?? useStore.getState().vaultPath;
  // (On the box the same tools are provisioned; server/voice.ts runs them in
  // its sandbox with only their declared keys — these execute()s run nowhere there.)
  try {
    const tools = await loadVaultVoiceTools(vault);
    if (vault) voiceToolCache.set(vault, tools);
    return tools;
  } catch (e) {
    console.warn("[voice-eleven] custom tool load failed:", e);
    if (vault) voiceToolCache.set(vault, []);
    return [];
  }
}
const VOICE_ID_STORAGE = "vault_chat_elevenlabs_voice";
const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb"; // Brian — Jarvis-adjacent baseline.
const SCROLL_DEBOUNCE_MS = 600;
const VIEWPORT_TEXT_CAP = 4000;

type ActiveConversation = VoiceConversation;

let activeConversation: ActiveConversation | null = null;
// The SDK's entry point ([tests] replaceable: a mocked SDK).
let voiceSdk: { startSession(o: any): Promise<any> } = Conversation;
/** [tests] Replace the ElevenLabs SDK's Conversation (null: the real one). */
export function setVoiceSdkForTests(sdk: { startSession(o: any): Promise<any> } | null): void {
  voiceSdk = sdk ?? Conversation;
}
// The live session's transport; WebSocket on Linux is the one with native playback.
let activeTransport: Transport | null = null;
const nativePlayback = () => activeTransport === "websocket" && isLinuxWebview();
function isLinuxWebview(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Linux/.test(ua) && !/Android/.test(ua);
}
// A call ElevenLabs closed because the model timed out reconnects once (voiceTimeout.ts).
const timeoutRetry = new TimeoutRetry();
// Each turn's time to the first response and the session's size, for the log.
const turnStats = new VoiceTurnStats();
// While a timeout reconnect runs: a failed start is said once, in the reconnect's own words.
let reconnecting: { error: string | null } | null = null;
let restartForTests: ((recap: string) => Promise<void>) | null = null;
/** [tests] Replace the reconnect's session start (null: the real one). */
export function setVoiceRestartForTests(fn: ((recap: string) => Promise<void>) | null): void {
  restartForTests = fn;
}
function logTurn(data: Record<string, unknown> | null): void {
  if (data) vlog("voice turn", { ...data, images: imagePusher.uploaded });
}
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
      voiceAppend({ role: "assistant", content: next });
    }
  } finally {
    agentQueueDraining = false;
  }
}

function flushAgentQueueImmediate(): void {
  while (pendingAgentQueue.length > 0) {
    const text = pendingAgentQueue.shift();
    if (text === undefined) break;
    voiceAppend({ role: "assistant", content: text });
  }
}

// Monotonic generation counter + target slot for ScrollTo coalescing.
// Every ScrollTo invocation bumps scrollGen and overwrites
// pendingScrollTarget; only the call whose myGen still matches when its
// silence-wait resolves actually applies the scroll. See ScrollTo
// handler for the why.
let scrollGen = 0;
let pendingScrollTarget: { path: string; anchor: string } | null = null;
// ScrollTo's budget, inside ElevenLabs' 30 s for a client tool: the words playing, then the viewer's answer.
const SCROLL_SPEECH_WAIT_MS = 8000;
const SCROLL_SPEECH_START_MS = 1200;
const SCROLL_ANSWER_MS = 9000;

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** Move the viewer of `path` (opened first when it is not on screen) and say what happened, in the viewer's words. */
async function scrollViewer(path: string, anchor: string): Promise<string> {
  const s = useStore.getState();
  const name = path.split(/[\\/]/).pop() ?? path;
  const shown = [s.currentFile, ...s.panes.map((p) => p.file)].find((f): f is string => !!f && samePath(f, path));
  if (shown) path = shown;
  else {
    try {
      const content = isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path });
      s.setCurrentFile(path, content);
    } catch (e) {
      return `Error: couldn't open ${name}: ${(e as Error)?.message ?? String(e)}`;
    }
  }
  const kind = fileKind(path).kind;
  // HTML, markdown (reading view) and PDF answer with where they moved, or why they could not.
  const answers = kind === "html" || kind === "markdown" || kind === "pdf";
  const answer = answers ? awaitScroll(path, anchor, SCROLL_ANSWER_MS) : null;
  useStore.getState().requestScrollAnchor(path, anchor);
  if (!answer) return `Scrolled to ${anchor} in ${name}`;
  return (await answer) ?? `Error: the viewer of ${name} did not answer in ${SCROLL_ANSWER_MS / 1000} s (is it still loading?). Try again in a moment.`;
}

// Matched to text-mode tools so the voice agent gets enough context to
// answer questions about a real-sized file. 8k was too small for
// notebooks (cell metadata ate the budget before any code showed up).
const READ_CAP = 24_000;

// ElevenLabs's tool-parameter validator requires every property to
// carry a `description` (or `dynamic_variable` / `is_system_provided`
// / `constant_value`). Missing descriptions return HTTP 422 on
// agent-create with a per-property loc trail. Make sure every leaf
// property below has one.
export const CLIENT_TOOL_DEFINITIONS = [
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
      "Read text from a PDF: the page count plus the pages asked for (default 1-3), capped at 12000 chars. Use page ranges; never read a whole long PDF at once. Call this — not Read — when the user asks about a .pdf file.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the PDF file.",
        },
        pages: {
          type: "string",
          description: "Optional page selection: '1', '4-8', '1,3,7-9'. Default '1-3'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ScrollTo",
    description:
      "Move the user's viewport to a specific page or section of the file they're currently viewing. Use this to drive read-along sessions: advance to the next page when the user is ready, jump back to a page they want to revisit ('go back to the bubble diagram'), or anchor on a specific section. The user's eyes follow what you scroll to, so move deliberately and explain what you're doing. Works on PDFs (a page number, or a phrase in the PDF), web pages (.html) and markdown: pass `anchor` as a heading's text ('Value iteration'), its #id or slug, or a phrase that appears on the page — the first place it appears is shown. On a hash-routed page, a section in its navigation is followed. Returns where it moved; if nothing matches, an error listing the nearest headings — retry with one of those.",
    parameters: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "1-based PDF page number to scroll to. For PDFs only.",
        },
        anchor: {
          type: "string",
          description: "Where to go: a heading's text, its #id or slug, or a phrase on the page (for a PDF: a phrase, or 'page=12'). Prefer `page` for PDF pages.",
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
    name: "ShowFile",
    description:
      "Open a file in the user's viewer — 'pull up the diagram', 'show me that photo'. Images are attached to your context so you can see them; a PDF arrives whole. Returns what was opened.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file (vault root + a path from the file index).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "LookAtScreen",
    description:
      "See the user's screen right now, read on their machine at call time — call it for 'what's this?', 'look at this', 'can you see it?', and whenever they say they pasted, wrote or changed something. Returns the open file's path and the part in view (with whether there is more above/below), the text in view, and attaches every image in view exactly as shown (unsaved and unsynced edits included). Earlier looks may be out of date; look again after a change.",
    parameters: {
      type: "object" as const,
      properties: {},
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
  // Hand-off to the box's main agent (server/voice.ts; only when the vault runs
  // on a box — elsewhere these answer that there is no box).
  {
    name: "AskAgent",
    description:
      "Hand a task to the main agent on the box (it has a shell, the whole vault, subagents and hours of compute). Use for long or heavy work: research, multi-step edits, runs, anything over a minute. Starts a new chat with the task, or continues one when conversationId is given. Returns the conversationId — keep it to check on the work with AgentStatus.",
    parameters: {
      type: "object" as const,
      properties: {
        task: { type: "string", description: "What the agent should do, in full — it does not hear this voice conversation." },
        project: {
          type: "string",
          description: "Optional. Starts the agent's work as a project with this name — creates the project if it is new (or files the work under the existing one).",
        },
        conversationId: { type: "string", description: "Optional. Continue this agent chat instead of starting a new one." },
      },
      required: ["task"],
    },
  },
  {
    name: "SetProject",
    description:
      "Put this chat (the voice conversation; before anything was said, the chat the session started from) into a project, creating the project if it is new. Use when the user says to file this under a project, start a project, or move this to a project. An empty name takes it out of its project.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The project's name (an existing one, or a new one to create)." },
      },
      required: ["name"],
    },
  },
  {
    name: "AgentStatus",
    description:
      "How a chat handed to the main agent is going: its state (working, waiting for an answer, sleeping, idle), what it is doing now, and its last reply.",
    parameters: {
      type: "object" as const,
      properties: {
        conversationId: { type: "string", description: "The conversationId AskAgent returned." },
      },
      required: ["conversationId"],
    },
  },
];

/** The built-in voice tools by name (custom vault tools are not among them). */
export const BUILTIN_VOICE_TOOL_NAMES: string[] = CLIENT_TOOL_DEFINITIONS.map((t) => t.name);
/** Tools that act on the viewer: they stay in the client even when the vault runs on a box. */
export const LOCAL_VOICE_TOOLS = new Set(["ScrollTo", "ShowFile", "LookAtScreen", "SetProject"]);
/** A voice tool run elsewhere (the box): name + args -> the result the agent hears. */
export type RemoteVoiceTool = (name: string, args: any) => Promise<string>;

// Decide which conversation a starting voice session should run in.
// Voice always wants its own thread, so a session never appends onto a
// text chat. Reuse the active conversation ONLY when it's already a
// pure-voice thread (source "voice" — i.e. the mic was just toggled off
// and back on) or it's empty; otherwise spin up a fresh thread and tag
// it "voice". A typed turn later flips it back to "manual" (see
// chat-controller), so "source === voice" means "voice from start to end
// so far", which is exactly the resume condition the user wants.
export function ensureVoiceConversation(opts?: { stealFocus?: boolean; convId?: string }): string {
  // Desktop voice (the user is sitting at THIS app) wants the voice thread to
  // become the active pane — that's the whole point of toggling the mic. Phone
  // voice does NOT: it runs the brain on the box (see phoneVoice.ts), but the
  // box is itself a desktop client someone may be looking at, so claiming its
  // active pane yanks that user onto a thread they didn't open. Default true to
  // preserve the desktop behavior; the phone passes false.
  const stealFocus = opts?.stealFocus !== false;
  const s = useStore.getState();

  if (!stealFocus) {
    // If the phone passed the current convId, reuse that thread so voice
    // transcripts land where the user left off, not in a fresh orphan.
    if (opts?.convId) {
      const existing = s.conversations.find((c) => c.id === opts.convId);
      if (existing) return existing.id;
    }
    // No convId or not found — prepend a fresh labeled voice thread.
    const fresh: ConvThread = { ...emptyConversation(), source: "voice" };
    useStore.setState({ conversations: [fresh, ...s.conversations] });
    return fresh.id;
  }

  const active = s.activeConversationId
    ? s.conversations.find((c) => c.id === s.activeConversationId)
    : null;
  // Toggling voice CONTINUES the conversation you're already in — "turn this
  // conversation into voice / pick up where I left off" (note a582595d). The
  // spoken turns land in the same thread and the agent already has its context
  // (the system prompt seeds recent history from it). To start a NEW voice
  // conversation instead, open a fresh chat first, then talk — an empty active
  // thread is adopted as the voice scratch below. Only relabel a FRESH thread to
  // source "voice"; a thread with real history keeps its origin so it stays the
  // same conversation, now continued by voice.
  if (active) {
    const isFreshScratch =
      active.source !== "voice" &&
      active.messages.length === 0 &&
      s.messages.length === 0;
    if (isFreshScratch) {
      useStore.setState({
        conversations: s.conversations.map((c) =>
          c.id === active.id ? { ...c, source: "voice" } : c,
        ),
      });
    }
    return active.id;
  }
  const id = useStore.getState().newConversation();
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) =>
      c.id === id ? { ...c, source: "voice" } : c,
    ),
  }));
  return id;
}

function isMicProblem(e: unknown): boolean {
  return /NotAllowed|NotFound|NotReadable|Overconstrained|Permission|microphone/i.test(`${(e as any)?.name ?? ""} ${(e as any)?.message ?? String(e)}`);
}

export async function startElevenLabsSession(opts?: { recap?: string }): Promise<void> {
  if (activeConversation) return;
  const state = useStore.getState();
  const apiKey = state.serviceKeys.elevenlabs;
  // Box mode: the box's agent and key (one agent, one key place); its tools
  // run there. This laptop's own agent only when the box doesn't answer.
  const { boxVoice, boxVoiceSession, voiceTranscriptMirror } = await import("./voiceBox");
  let box = await boxVoice(state.vaultPath);
  if (!box && !apiKey) {
    reportVoiceError(
      "Voice mode needs an ElevenLabs API key. Add one in Settings.",
    );
    return;
  }

  // "Connecting…" lights up the cockpit immediately so the user
  // knows the click registered. Cleared in onConnect (success) or
  // any of the error paths below.
  useStore.getState().setVoiceConnecting(true);

  // No mic pre-flight of our own: the SDK opens the one mic stream (a second
  // getUserMedia here could leave Windows capturing with other settings); a
  // refused mic surfaces from startSession below, in the same words.

  let boxSession: import("./voiceBox").BoxVoiceSession | null = null;
  if (box) {
    const r = await boxVoiceSession(box, state.activeConversationId);
    if (r.session) boxSession = r.session;
    else if (r.unsupported) box = null; // no voice for this vault on the box: voice runs here
    else if (!r.unreachable || !apiKey) {
      useStore.getState().setVoiceConnecting(false);
      reportVoiceError(`The box couldn't start voice: ${r.error ?? "no answer"}.${r.unreachable ? " (It isn't reachable, and this laptop has no ElevenLabs key of its own.)" : ""}`);
      return;
    } else console.warn("[voice-eleven] box unreachable; voice runs on this laptop's agent:", r.error);
  }
  if (!box && !apiKey) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError("Voice mode needs an ElevenLabs API key. Add one in Settings.");
    return;
  }

  // Credentials for both transports: a WebRTC conversation token (preferred)
  // and a signed URL (WebSocket: Linux, or the fallback).
  let signedUrl: string | null = null;
  let conversationToken: string | null = null;
  if (boxSession) {
    signedUrl = boxSession.signedUrl ?? null;
    conversationToken = boxSession.conversationToken ?? null;
  } else {
  // A desktop mic-tap is user intent — always clear a tripped breaker so the
  // user can retry after fixing the config, even if the box heartbeat left it open.
  resetAgentCreateBreaker();
  const agentId = await ensureAgent(apiKey!);
  if (!agentId) {
    useStore.getState().setVoiceConnecting(false);
    const err = getLastAgentCreateError();
    const refusedVoice = err && /^voice [A-Za-z0-9]+: /.exec(err.body);
    if (err && refusedVoice && !err.body.includes("voice_not_found")) {
      reportVoiceError(`ElevenLabs won't use the voice you picked (${err.body.slice(6, refusedVoice[0].length - 2)}) for the voice agent: ${truncate(err.body.slice(refusedVoice[0].length), 400)}. Pick another voice in Settings → Voice.`);
      return;
    }
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

  [signedUrl, conversationToken] = await Promise.all([getSignedUrl(apiKey!, agentId), getConversationToken(apiKey!, agentId)]);
  if (!signedUrl && !conversationToken) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError(
      "Couldn't get a conversation token or signed URL from ElevenLabs. The agent ID may be stale (try clearing localStorage `vault_chat_elevenlabs_agent_id`) or your account may have hit a rate limit.",
    );
    return;
  }
  }
  let override: string | null = null;
  try {
    override = localStorage.getItem("vault_chat_voice_transport");
  } catch {
    /* no storage */
  }
  const picked = pickTransport({ ua: navigator.userAgent, override, hasToken: !!conversationToken, hasSignedUrl: !!signedUrl });
  if (!picked) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError("ElevenLabs gave no way to connect (no conversation token, no signed URL).");
    return;
  }
  let transport: Transport = picked;

  lastViewportSent = null;
  sentPdfPaths.clear();
  imagePusher.reset();
  quietGate.reset();
  sessionMutationCount = 0;
  sessionFirstUserText = null;
  resetAgentEnvelope();
  stopHealthWatch();

  // Voice runs in its own thread. Start fresh unless we're resuming a
  // pure-voice conversation (the user toggled the mic off and back on, so
  // the active thread is voice from start to end) or the active thread is
  // empty. Otherwise a voice session would tack its turns onto whatever
  // text chat happened to be open. Must run before the prompt build below
  // so the system prompt's recent-history reflects the chosen thread.
  // Box mode: voice gets a thread of its own (never an engine chat), saved on
  // the box line by line; a voice thread the box already has is continued.
  const fromConvId = useStore.getState().activeConversationId;
  if (box) {
    const cur = useStore.getState().conversations.find((c) => c.id === fromConvId);
    if (!cur || cur.source !== "voice") useStore.getState().newConversation();
  }
  const voiceConvId = ensureVoiceConversation();
  transcriptMirror = box ? voiceTranscriptMirror(box, voiceConvId, fromConvId) : null;
  {
    const mirror = transcriptMirror;
    voiceChats = { own: () => mirror?.id?.() ?? voiceConvId, from: fromConvId, local: voiceConvId };
  }
  boxVaultRoot = boxSession?.vaultRoot ?? null;
  startViewportWatch();

  // Re-read after the possible conversation swap.
  const voiceState = useStore.getState();
  // Load the user-editable voice header from this vault's agent config
  // (.vault-chat/agent/voice.md). Empty string when missing →
  // buildSystemPrompt falls back to the built-in default header.
  const customHeader = await loadVaultVoicePrompt(voiceState.vaultPath);
  const northStar = await loadVaultNorthStar(voiceState.vaultPath);
  const promptContext = await loadVoicePromptContext(voiceState.vaultPath);
  // Box mode: the vault's tools run on the box, and AskAgent reaches its agent.
  const remote = box?.tool ?? null;
  // Voice on this laptop: the shared stream (what Carl did lately, the project's memory) from here.
  let shared = "";
  if (!boxSession) {
    const a = await import("./activity");
    shared = a.sharedContextText(await a.sharedContextFor(voiceState.vaultPath));
  }
  const basePrompt = boxSession?.systemPrompt ?? buildSystemPrompt(voiceState, customHeader, northStar, promptContext, undefined, !!remote) + (shared ? `

${shared}` : "");
  // A reconnect after a timeout: what was in flight, and to carry on in small steps.
  const systemPrompt = opts?.recap ? `${basePrompt}\n\n${opts.recap}` : basePrompt;
  turnStats.startSession(systemPrompt.length);
  vlog("voice session", { promptChars: systemPrompt.length, llm: getCurrentLlm(), box: !!boxSession, reconnect: !!opts?.recap, transport });
  const dynamicVariables = buildDynamicVariables(voiceState);
  const voiceId = boxSession?.voiceId ?? localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID;
  // One line per start, so a report of "the voice didn't work" has the voice it asked for.
  console.info(`[voice-eleven] starting: voice ${voiceId}, ${boxSession ? "the box's agent" : "this laptop's agent"}`);

  try {
    activeTransport = transport;
    const startedAt = Date.now();
    const start = () => voiceSdk.startSession({
      // The mic is the system default (the SDK's own); its label is logged at start ("voice mic").
      ...connectionOptions(transport, { conversationToken, signedUrl }),
      overrides: {
        agent: {
          prompt: { prompt: systemPrompt },
          firstMessage: "",
          language: "en",
        },
        tts: { voiceId },
      },
      dynamicVariables,
      clientTools: buildClientToolHandlers(remote ?? undefined, boxSession?.toolNames),
      // Agent audio arrived (the health watch compares it with what plays).
      // Linux (WebSocket): the webview can't play Web Audio, so the chunk is
      // played natively and feeds the bars' envelope. WebRTC: the SDK plays it.
      onAudio: (audioBase64: string) => {
        health.audioReceived(Date.now());
        if (!nativePlayback()) return;
        playAgentAudioNative(audioBase64);
        try {
          pushAgentEnvelope(audioBase64);
        } catch {}
      },
      onInterruption: () => {
        // "It cut out and said a different sentence": a barge-in ElevenLabs
        // detected (the user's voice — or, on WebSocket, the agent's own echo).
        vlog("voice interruption", { transport, heldPushes: quietGate.pending });
        if (nativePlayback()) {
          stopAgentAudioNative();
          resetAgentEnvelope();
        }
      },
      onStatusChange: ({ status }: { status: string }) => vlog("voice status", { status, transport }),
      onConversationMetadata: (m: any) =>
        vlog("voice metadata", { conversationId: m?.conversation_id, inFormat: m?.user_input_audio_format, outFormat: m?.agent_output_audio_format }),
      onConnect: ({ conversationId }: { conversationId?: string } = {}) => {
        vlog("voice connected", { transport, conversationId, connectMs: Date.now() - startedAt });
        useStore.setState({ voiceError: null });
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceThinking(false);
      },
      onDisconnect: (details?: any) => {
        // Every close, ours included, with its reason (one ended at 01:07 with no trace).
        vlog("voice closed", {
          transport,
          reason: details?.reason,
          message: details?.message,
          closeCode: details?.closeCode ?? details?.context?.code,
          closeReason: details?.closeReason ?? details?.context?.reason,
          context: details?.context?.type,
          afterMs: Date.now() - startedAt,
          ...turnStats.atClose(),
        });
        voiceSessionClosed(details);
      },
      onMessage: ({ message, role }: { message: string; role: string }) => {
        // The agent's audio tags ("[excited]") shaped the audio; the transcript drops them.
        const raw = (message ?? "").trim();
        const text = role === "agent" ? stripAudioTags(raw) : raw;
        if (!text) return;
        // Live append: each completed user/agent turn lands in the
        // chat pane as it arrives, not buffered until session end.
        // ElevenLabs sends whole messages (not token streams), so
        // there's no spam — one append per turn boundary.
        if (role === "user") {
          // Our own reconnect nudge is not Carl's line.
          if (text === RECONNECT_NUDGE) return;
          const heardAt = Date.now();
          turnStats.userTurn(text, heardAt, health.userTranscript(heardAt));
          // Heard: a later deaf spell gets its own re-acquire before any line.
          micRecoveries = 0;
          if (sessionFirstUserText === null) sessionFirstUserText = text;
          voiceAppend({ role: "user", content: text });
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
          if (text === SOFT_TIMEOUT_MESSAGE) turnStats.fillerSpoken();
          else logTurn(turnStats.firstResponse("text", Date.now(), text.length));
          // Queue and drain serially. onMessage fires on text-complete,
          // not audio-complete; appending now would race the transcript
          // ahead of the user's ears. Each queued message waits its
          // own silence window before landing in the chat so rapid-fire
          // turns flush in order, not all at once.
          pendingAgentQueue.push(text);
          // Its math is formatted while the audio plays, so the line lands rendered.
          prefetchVoiceMath(text);
          void drainAgentQueue();
        }
      },
      onModeChange: ({ mode }: { mode: string }) => {
        useStore.getState().setVoiceListening(mode === "listening");
        useStore.getState().setVoiceSpeaking(mode === "speaking");
        // Clear thinking the moment the first TTS chunk arrives — mode
        // flips listening → speaking in `handleAudio` at chunk arrival
        // per the SDK source. The wave hands off to the real output
        // spectrum on this transition.
        // The turn's timing is logged when audio is audibly playing (the health watch), not here.
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
          // Linux envelope: mode leaves "speaking" once the buffer drained (or a
          // barge-in cut it), so any unconsumed tail is stale. Drop it.
          if (nativePlayback()) resetAgentEnvelope();
        }
      },
      onError: (message: string) => {
        console.warn("[voice-eleven] session error:", message);
        // The composer's waves turn red until the next start or connect.
        useStore.setState({ voiceError: message });
        // Surface to the chat pane so a silent drop has SOMETHING the
        // user can show us — otherwise "the convo dropped" is impossible
        // to diagnose without a dev console open.
        voiceAppend({
          role: "assistant",
          content: `Voice session error: ${message}`,
          system: true,
        });
      },
    });
    let conv: ActiveConversation;
    try {
      conv = await start();
    } catch (e) {
      // WebRTC refused (a network that blocks it): once more over WebSocket, when there's a signed URL.
      if (transport !== "webrtc" || !signedUrl || isMicProblem(e)) throw e;
      vlog("voice transport fallback", { from: "webrtc", error: String((e as Error)?.message ?? e).slice(0, 300) });
      transport = "websocket";
      activeTransport = transport;
      conv = await start();
    }
    activeConversation = conv;
    // The connection's health, from the SDK's own meters (voiceHealth.ts).
    void startHealthWatch(conv, transport);
    // The thread's recent images (its own, or — a fresh voice thread — the chat
    // it started from): this ElevenLabs conversation has never seen them.
    {
      const st = useStore.getState();
      const own = st.messages.some((m) => !m.system) ? st.messages : (st.conversations.find((c) => c.id === fromConvId)?.messages ?? []);
      // A reconnect: only the newest (the recap carries the words; LookAtScreen sees the rest).
      void pushThreadImages(own, st.vaultPath, opts?.recap ? 1 : 3).catch((e) => console.warn("[voice-eleven] thread images:", e));
    }
    // Reconnected after a timeout: the agent picks the request back up (the recap is in its prompt).
    if (opts?.recap) {
      try {
        conv.sendUserMessage(RECONNECT_NUDGE);
      } catch (e) {
        console.warn("[voice-eleven] reconnect nudge failed:", e);
      }
    }
  } catch (e) {
    console.error("[voice-eleven] session start failed:", e);
    activeConversation = null;
    activeTransport = null;
    stopHealthWatch();
    const msg = (e as any)?.message ?? String(e);
    useStore.getState().setVoiceConnecting(false);
    if (isMicProblem(e)) {
      reportVoiceError(`Microphone access denied or unavailable: ${msg}. Check Windows Settings → Privacy → Microphone, and the system's default input device.`);
      return;
    }
    reportVoiceError(`Voice session failed to start: ${msg}.`);
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

/** Why ElevenLabs closed the session, or "" for a normal end (ours, or the agent's 1000). */
/** The session closed (onDisconnect). A close because the model timed out
 *  reconnects once, with a recap, keeping the call on; a second one soon after
 *  ends it with one plain line. Anything else ends it as before. */
export function voiceSessionClosed(details?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }): void {
  const why = disconnectReason(details);
  const timeout = !!why && isLlmTimeoutClose(details);
  // Lines the agent had queued land before any notice (they were said first).
  flushAgentQueueImmediate();
  const retry = timeout && timeoutRetry.take();
  let recap = "";
  if (timeout) {
    vlog("voice timeout", { why, retry, ...turnStats.atClose(), images: imagePusher.uploaded });
    console.error("[voice-eleven] session closed:", why, retry ? "(reconnecting once)" : "(the reconnect timed out too)");
    const st = useStore.getState();
    const local = voiceChats?.local;
    const lines = local && local !== st.activeConversationId ? (st.conversations.find((c) => c.id === local)?.messages ?? []) : st.messages;
    recap = reconnectRecap(lines);
    voiceAppend({ role: "assistant", content: retry ? RECONNECTING_LINE : couldntReconnectLine(plainCloseReason(details)), system: true });
  } else if (why) {
    // A close that wasn't ours says why (a refused voice or override closes
    // the socket with a reason, and it used to end with no trace at all).
    console.error("[voice-eleven] session closed:", why);
    voiceAppend({ role: "assistant", content: `Voice session closed by ElevenLabs: ${why}`, system: true });
  }
  // Stop any native agent audio still playing/queued (Linux).
  if (nativePlayback()) stopAgentAudioNative();
  resetAgentEnvelope();
  stopHealthWatch();
  activeTransport = null;
  if (!retry) {
    voiceAppend({
      role: "assistant",
      content: "Voice session ended.",
      system: true,
    });
  }
  transcriptMirror = null;
  quietGate.reset();
  voiceChats = null;
  activeConversation = null;
  stopViewportWatch();
  // Flip the mic-button source of truth off so it matches
  // reality. Critical for end_call / end-phrase paths where
  // the click handler never ran. Idempotent for manual ends
  // (endElevenLabsSession already set it). A reconnect keeps it on.
  useStore.setState({ voiceMode: retry, voiceMicMuted: false });
  useStore.getState().setVoiceConnecting(retry);
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
  if (retry) void reconnectAfterTimeout(recap);
}

async function reconnectAfterTimeout(recap: string): Promise<void> {
  const r = { error: null as string | null };
  reconnecting = r;
  try {
    await (restartForTests ?? ((x: string) => startElevenLabsSession({ recap: x })))(recap);
  } catch (e) {
    r.error = (e as Error)?.message ?? String(e);
  } finally {
    reconnecting = null;
  }
  if (activeConversation) return;
  // The retry didn't connect: one plain line, and the call is off.
  const msg = couldntReconnectLine(r.error ?? "no answer from ElevenLabs");
  vlog("voice reconnect failed", { error: r.error });
  voiceAppend({ role: "assistant", content: msg, system: true });
  voiceAppend({ role: "assistant", content: "Voice session ended.", system: true });
  useStore.setState({ voiceMode: false, voiceMicMuted: false, voiceError: msg });
  useStore.getState().setVoiceConnecting(false);
}

export function disconnectReason(d?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }): string {
  if (!d || d.reason === "user") return "";
  if (d.reason === "agent" && (d.closeCode === undefined || d.closeCode === 1000) && !d.closeReason) return "";
  return [d.message, d.closeReason, d.closeCode !== undefined ? `code ${d.closeCode}` : ""].filter(Boolean).join(" — ") || String(d.reason ?? "unknown");
}

function reportVoiceError(message: string): void {
  // An error line on every failed start (the app log mirrors console.error).
  console.error("[voice-eleven] voice start failed:", message);
  // A timeout reconnect says its own one line (couldntReconnectLine).
  if (reconnecting) {
    reconnecting.error = message;
    return;
  }
  // The composer's waves turn red (VoiceCockpit's InlineVoiceWaves) until the
  // next start attempt or a successful connect.
  useStore.setState({ voiceError: message });
  voiceAppend({
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
  timeoutRetry.reset();
  const conv = activeConversation;
  activeConversation = null;
  stopHealthWatch();
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
  useStore.setState({ voiceMode: false, voiceMicMuted: false });
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

/** The mic button and Ctrl+D: start a session, or end the live one. voiceMode
 *  goes on at once so the click shows; startElevenLabsSession's error paths and
 *  onDisconnect turn it off again. */
export function toggleVoice(): void {
  if (!useStore.getState().voiceMode) {
    // A retry: the red waves go back to normal while it connects.
    useStore.setState({ voiceMode: true, voiceError: null });
    void startElevenLabsSession();
  } else {
    void endElevenLabsSession();
  }
}

/** [preview harness] Run the live-session paths against a scripted ElevenLabs
 *  conversation (the preview has no mic or ElevenLabs): levels, image uploads,
 *  mute, end. Null ends it as onDisconnect would. `line` lands a finished
 *  line as onMessage does (the agent's math prefetched while it "speaks"). */
export function adoptVoiceSessionForPreview(conv: unknown): { line: (role: "user" | "agent", text: string) => void } {
  const line = (role: "user" | "agent", text: string) => {
    if (role === "agent") prefetchVoiceMath(text);
    voiceAppend({ role: role === "user" ? "user" : "assistant", content: text });
  };
  if (conv) {
    activeConversation = conv as ActiveConversation;
    // The session runs in the conversation that is open (as a desktop start continues it).
    const id = useStore.getState().activeConversationId;
    voiceChats = { own: () => id, from: id, local: id ?? undefined };
    sentPdfPaths.clear();
    imagePusher.reset();
    useStore.setState({ voiceMode: true, voiceMicMuted: false });
    useStore.getState().setVoiceConnecting(false);
    startViewportWatch();
  } else {
    activeConversation = null;
    voiceChats = null;
    stopViewportWatch();
    useStore.setState({ voiceMode: false, voiceMicMuted: false });
  }
  return { line };
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
  // Speech that has not started by then is not coming (the call came before any words): go on.
  startWithinMs = 0,
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
    if (startWithinMs > 0) setTimeout(() => !sawSpeaking && finish(), startWithinMs);
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
  // Only to a model that reads documents (else it has PdfExtract).
  if (!readsDocuments(getCurrentLlm())) return;

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
    // A user turn for the agent: never while it speaks.
    await quietGate.quiet(60_000);
    if (!activeConversation || activeConversation !== conv) return;
    const name = file.split(/[\\/]/).pop() ?? "document.pdf";
    sendFilesMessage(conv, `[The user has opened ${name}. The full PDF is attached for your reference — you can see every page including diagrams, equations, and layout. The viewport context will tell you which page they are currently viewing.]`, [fileId]);
    sentPdfPaths.add(file);
  } catch (e) {
    console.warn("[voice-eleven] PDF upload failed:", e);
  } finally {
    pdfUploadInFlight = false;
  }
}

// Images: the same ambient vision for an image the user has open, shows via
// ShowFile, or asks about with LookAtScreen (voiceImages.ts: once per key a
// session, size-capped). In box mode the image is in the vault on both sides,
// so it is read here.
const imagePusher = new VoiceImagePusher();

type FileConv = {
  uploadFile(b: Blob): Promise<{ fileId: string }>;
  sendMultimodalMessage(m: { text?: string; fileId: string }): void;
};

// sendFilesMessage lives in voiceImages.ts (the board's voice sends with it too).
export { sendFilesMessage };

/** The image pusher's sink: uploads through the SDK, sends in the current shape. */
function fileSink(conv: FileConv): import("./voiceImages").VoiceImageSink & { sendFiles(text: string | undefined, ids: string[]): void } {
  return {
    uploadFile: (b) => conv.uploadFile(b),
    sendMultimodalMessage: (m) => sendFilesMessage(conv, m.text, [m.fileId]),
    sendFiles: (text, ids) => sendFilesMessage(conv, text, ids),
  };
}
// Our own pushes (contextual updates, uploads) wait while the agent speaks — an
// upload is a user turn and cut its reply off mid-sentence (voiceQuiet.ts).
const quietGate = new QuietGate(() => useStore.getState().voiceSpeaking);
{
  // voiceSpeaking is the SDK's mode (onModeChange): speaking holds, the end of it flushes.
  let was = useStore.getState().voiceSpeaking;
  useStore.subscribe((st) => {
    if (st.voiceSpeaking === was) return;
    was = st.voiceSpeaking;
    quietGate.modeChanged();
  });
}
/** [tests] Pushes held until the agent stops speaking. */
export function heldVoicePushes(): number {
  return quietGate.pending;
}
/** How long a tool's own image push may wait for the agent to stop talking. */
const TOOL_PUSH_WAIT_MS = 10_000;

/** Send the image file at `path` to the live voice conversation (once a session). */
export async function pushVoiceImageFile(path: string, extra?: string): Promise<PushResult | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  const mime = voiceImageMime(path);
  if (!mime) return "unsupported";
  if (!seesImages(getCurrentLlm())) return "unsupported";
  if (imagePusher.has(path)) return "duplicate";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return "failed";
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const name = path.split(/[\\/]/).pop() ?? path;
    return await imagePusher.push(fileSink(conv), path, blob, lookingAtNote(name, extra), () => activeConversation === conv);
  } catch (e) {
    console.warn("[voice-eleven] image read failed:", e);
    return "failed";
  }
}

/** Send an image already in memory (a capture of the screen) under `key`. */
export async function pushVoiceImageDataUrl(key: string, dataUrl: string, name: string, extra?: string): Promise<PushResult | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return "failed";
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return await imagePusher.push(fileSink(conv), key, blob, lookingAtNote(name, extra), () => activeConversation === conv);
  } catch (e) {
    console.warn("[voice-eleven] capture push failed:", e);
    return "failed";
  }
}

/** Several captured images (data URLs) to the live session in one message, each
 *  once (by content: a changed picture is new). One result per item. */
export async function pushVoiceImagesNow(items: { key: string; dataUrl: string }[], note: string): Promise<PushResult[] | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return items.map(() => "failed");
  const blobs = await Promise.all(items.map(async (it) => ({ key: it.key, blob: await (await fetch(it.dataUrl)).blob() })));
  return imagePusher.pushMany(fileSink(conv), blobs, note, () => activeConversation === conv);
}

/** LookAtScreen from the page: the focused pane as it is on screen now (screenLook.ts). */
async function lookAtScreenFromPane(pane: import("./screenLook").LookEl): Promise<string> {
  const { lookInPane, imageKey } = await import("./screenLook");
  const look = await lookInPane(pane);
  const file = look.file || useStore.getState().currentFile || "";
  const name = relPath(file) || "the open file";
  const more = look.above && look.below ? " There is more above and below: this is only the part in view." : look.above ? " There is more above: this is only the part in view." : look.below ? " There is more below: this is only the part in view." : "";
  const lines = [`The user's screen right now (read off their screen on this machine just now — not a synced copy): ${name} is open${look.mode ? ` (${look.mode})` : ""}, showing ${look.region}.${more}`];
  lines.push(look.text ? `Text in view:\n${look.text}` : "No text in view.");
  if (!look.images.length) lines.push("No images in view.");
  else if (!seesImages(getCurrentLlm())) {
    lines.push(`${look.images.length} image(s) in view (${look.images.map((i) => i.label).join(", ")}), but the voice model can't see images — ask the user what they show, or switch to a model that can.`);
  } else {
    const n = look.images.length;
    const res = await pushVoiceImagesNow(
      look.images.map((i) => ({ key: imageKey(i.dataUrl), dataUrl: i.dataUrl })),
      `[The user's screen now: ${name}, ${look.region} — the ${n === 1 ? "image" : `${n} images`} in view, top to bottom, attached. You can see them. Don't describe them unless asked.]`,
    );
    const why = (r: PushResult | "no-session") => (r === "too-large" ? "too large to upload" : r === "unsupported" ? "not an image the model takes" : r === "no-session" ? "no live voice session" : "the upload to ElevenLabs failed");
    lines.push(
      `Images in view, top to bottom (${n}):\n` +
        look.images
          .map((im, i) => {
            const r = res === "no-session" ? "no-session" : res[i]!;
            const state = r === "sent" ? "attached now" : r === "duplicate" ? "already in your context, unchanged" : `couldn't attach (${why(r)})`;
            return `${i + 1}. ${im.label}${im.partial ? " (partly in view)" : ""} — ${state}`;
          })
          .join("\n"),
    );
  }
  if (look.failed.length) lines.push(`Couldn't capture: ${look.failed.join("; ")}.`);
  lines.push("This is exactly what is on the screen now; an image you saw earlier may be out of date.");
  if (fileKind(file).kind === "pdf") void pushPdfIfNeeded();
  return lines.join("\n");
}

// An absolute path on this machine for a path the agent gave: the box's vault
// root mapped to this vault, a vault-relative one joined to it.
function localPathFor(p: string | undefined): string | null {
  const state = useStore.getState();
  let path = (p ?? "").trim();
  if (!path) return null;
  if (boxVaultRoot && state.vaultPath && path.startsWith(boxVaultRoot)) {
    path = path.slice(boxVaultRoot.length).replace(/^[\\/]+/, "");
  }
  if (!/^([a-z]:[\\/]|[\\/])/i.test(path) && state.vaultPath) {
    path = `${state.vaultPath.replace(/[\\/]+$/, "")}/${path}`;
  }
  return path;
}

// A small copy of an image for the thread (fullscreen chat shows what the
// agent opened there), or null.
async function readImageThumb(path: string): Promise<string | null> {
  const mime = voiceImageMime(path);
  if (!mime) return null;
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    return await thumbDataUrl(new Blob([new Uint8Array(bytes)], { type: mime }));
  } catch {
    return null;
  }
}

// The PDF page on screen as a PNG, from the viewer's own canvas (null when
// the viewer isn't showing it — fullscreen chat, another file).
function capturePdfPage(page: number): string | null {
  try {
    const c = document.querySelector<HTMLCanvasElement>(`canvas.pdf-page[data-page="${page}"]`);
    if (!c || !c.width) return null;
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

// The image the user has open (follow-along), pushed like the PDF.
async function pushImageIfNeeded(): Promise<void> {
  const state = useStore.getState();
  if (!activeConversation || !state.followAlong) return;
  const file = state.currentFile;
  if (!file || fileKind(file).kind !== "image") return;
  await pushVoiceImageFile(file);
}

export function pushViewportContextDebounced(): void {
  if (!activeConversation) return;
  if (scrollDebounceTimer !== null) clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(() => {
    scrollDebounceTimer = null;
    // Held while the agent speaks; only the latest viewport goes when it stops.
    quietGate.run("viewport", () => {
      const conv = activeConversation;
      if (!conv) return;
      const state = useStore.getState();
      if (!state.followAlong) return;
      const text = buildViewportContextText(state);
      if (text && text !== lastViewportSent) {
        lastViewportSent = text;
        try {
          // A stable context id: the newer viewport replaces the older (never a user turn).
          conv.sendContextualUpdate(text, { contextId: "viewport" });
        } catch (e) {
          console.warn("[voice-eleven] contextual update failed:", e);
        }
      }
      // Fire-and-forget the PDF push. Independent of the text update —
      // refocusing on the same PDF doesn't re-trigger an upload because
      // sentPdfPaths is a set.
      void pushPdfIfNeeded();
      void pushImageIfNeeded();
    });
  }, SCROLL_DEBOUNCE_MS);
}

/** At a session's start (a new start, a reconnect, a resumed thread): the most
 *  recent images in the thread — sent by Carl, or shown in it — go to the new
 *  ElevenLabs conversation, which has never seen them (the prompt carries the
 *  words only). One message, ≤ 3 images, newest last. */
export async function pushThreadImages(messages: ChatMessage[], vault: string | null, max = 3): Promise<PushResult[] | "no-session" | "none"> {
  const picked: { att: import("./store").ChatAttachment; who: string }[] = [];
  for (const m of messages.slice(-24).reverse()) {
    for (const a of m.attachments ?? []) {
      if (picked.length >= max) break;
      picked.push({ att: a, who: m.role === "user" ? "the user sent" : "shown in the chat" });
    }
    if (picked.length >= max) break;
  }
  picked.reverse();
  const items: { key: string; dataUrl: string }[] = [];
  const { imageKey } = await import("./screenLook");
  for (const p of picked) {
    let url = p.att.imageDataUrl && p.att.imageDataUrl.startsWith("data:image/") ? p.att.imageDataUrl : "";
    const rel = p.att.capturedFilePath ?? p.att.sourcePath;
    if (!url && rel && vault) {
      const abs = /^([a-z]:[\\/]|[\\/])/i.test(rel) ? rel : `${vault.replace(/[\\/]+$/, "")}/${rel}`;
      const mime = voiceImageMime(abs);
      try {
        if (mime) url = bytesToDataUrl(new Uint8Array(await invoke<number[]>("read_binary_file", { path: abs })), mime);
      } catch {
        /* not on this machine (yet): left out */
      }
    }
    if (url) items.push({ key: imageKey(url), dataUrl: url });
  }
  if (!items.length) return "none";
  return pushVoiceImagesNow(
    items,
    `[Earlier in this conversation (before this call), ${items.length === 1 ? "this image was" : `these ${items.length} images were`} shared in the chat, oldest first — attached so you can see them. Say nothing about them now; wait for the user.]`,
  );
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
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
  quietGate.run("typing", () => {
    if (activeConversation !== conv) return;
    try {
      conv.sendContextualUpdate(text, { contextId: "typing" });
    } catch (e) {
      console.warn("[voice-eleven] typing-hint contextual update failed:", e);
    }
  });
}

/** A short line for the voice agent to say at the next natural pause (the board
 *  inbox: "<title> is in your board inbox"). Held while the agent speaks
 *  (quietGate), then handed over as a contextual update asking for one short
 *  sentence; it never interrupts and is never a user turn. No session: dropped. */
export function announceAtNextPause(line: string): void {
  const conv = activeConversation;
  if (!conv || !line.trim()) return;
  quietGate.run(`announce:${line}`, () => {
    if (activeConversation !== conv) return;
    try {
      conv.sendContextualUpdate(`Heads-up for Carl, to mention in one short sentence at the next natural pause (do not interrupt him): ${line.trim()}`);
    } catch (e) {
      console.warn("[voice-eleven] announce failed:", e);
    }
  });
}

export function isVoiceSessionActive(): boolean {
  return activeConversation !== null;
}

/** A live voice session runs in conversation `id` (its own thread; box mode: the box's id or the local one before the rekey). */
export function voiceSessionOn(id: string | null | undefined): boolean {
  if (!activeConversation || !voiceChats || !id) return false;
  return id === voiceChats.own() || id === voiceChats.local;
}

/** Carl's composer send while voice is live on this conversation: one agent,
 *  so it is HIS TURN in the voice conversation — text as a user message,
 *  images uploaded and sent with it (one multimodal message), and written to
 *  the thread like any of his lines (the text agent reads it later). The text
 *  agent starts no turn. False when there is no session (the caller sends as
 *  usual). */
export async function sendComposerToVoice(text: string, attachments?: import("./store").ChatAttachment[]): Promise<boolean> {
  const conv = activeConversation;
  if (!conv) return false;
  // The composer's "[attached: @x → path]" footer stays: it names the files for the agent.
  const said = text.trim();
  const images = (attachments ?? []).filter((a) => typeof a.imageDataUrl === "string" && a.imageDataUrl.startsWith("data:image/")).slice(0, 5);
  if (!said && !images.length) return false;
  const shown = said || (images.length === 1 ? "[image]" : `[${images.length} images]`);
  // The thread first: his line shows at once, the image with it.
  voiceAppend({ role: "user", content: shown, ...(attachments?.length ? { attachments } : {}) });
  if (sessionFirstUserText === null) sessionFirstUserText = shown;
  let problem = "";
  try {
    if (images.length && seesImages(getCurrentLlm())) {
      const ids: string[] = [];
      for (const im of images) {
        try {
          const blob = await (await fetch(im.imageDataUrl)).blob();
          const body = blob.size > MAX_IMAGE_UPLOAD_BYTES ? await shrinkImage(blob) : blob;
          if (!body) throw new Error("too large to upload");
          if (activeConversation !== conv) return true;
          ids.push((await conv.uploadFile(body)).fileId);
        } catch (e) {
          problem = `an image couldn't be uploaded to the voice session (${(e as Error)?.message ?? String(e)})`;
        }
      }
      if (activeConversation !== conv) return true;
      if (ids.length) {
        const note = problem ? `${said ? `${said}\n\n` : ""}[${problem}.]` : said || `[The user sent ${ids.length === 1 ? "this image" : "these images"} in the chat.]`;
        sendFilesMessage(conv, note, ids);
      } else conv.sendUserMessage(`${said ? `${said}\n\n` : ""}[The user sent ${images.length === 1 ? "an image" : `${images.length} images`} in the chat, but ${problem || "it couldn't be uploaded"}. Tell them that plainly.]`);
    } else if (images.length) {
      conv.sendUserMessage(`${said ? `${said}\n\n` : ""}[The user sent ${images.length === 1 ? "an image" : `${images.length} images`} in the chat; the voice model can't see images. Say so, and ask what it shows.]`);
    } else {
      conv.sendUserMessage(said);
    }
  } catch (e) {
    console.error("[voice-eleven] composer → voice failed:", e);
    voiceAppend({ role: "assistant", content: `Couldn't hand that to the voice session: ${(e as Error)?.message ?? String(e)}`, system: true });
    return true;
  }
  if (problem) voiceAppend({ role: "assistant", content: `Voice: ${problem}.`, system: true });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
}

export function setVoiceMicMuted(muted: boolean): void {
  const conv = activeConversation;
  if (!conv) return;
  try {
    conv.setMicMuted(muted);
    useStore.setState({ voiceMicMuted: muted });
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
  voiceAppend({ role: "user", content: trimmed });
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
    sendFilesMessage(conv, trimmed || undefined, [fileId]);
  } catch (e) {
    console.warn("[voice-eleven] sendVoiceUserMultimodal failed:", e);
    return false;
  }
  const display = trimmed || "[image]";
  if (sessionFirstUserText === null) sessionFirstUserText = display;
  voiceAppend({ role: "user", content: display });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
}

/**
 * One frame of the voice waves' raw levels (0..1 per bar). Two sources, picked
 * per frame:
 *   • speaking → TTS output spectrum, or the chunk-derived playback envelope
 *     when the analyser reads dead (suspended AudioContext / buffer-up — the
 *     documented unreliable cases)
 *   • otherwise → live mic input (idle / listening / silent gaps)
 * While voiceSpeaking is on, the mic is NEVER the source: bars tracking the
 * user's ambient noise during the agent's turn is exactly the "wave out of sync
 * with the voice" desync (note 852e435b). No synthesized motion: a fake
 * "thinking" wave reads as ongoing audio after the user barges in. The chat
 * popout gets these from the main window (sync.ts), where voice runs.
 */
export function voiceBarLevels(n: number): number[] {
  const s = useStore.getState();
  const out = s.voiceSpeaking ? getOutputLevels(n) : null;
  // Polled every speaking frame regardless of which source wins — polling
  // advances the envelope's playback cursor, so it stays in sync for the
  // frames where the analyser flakes out.
  const env = s.voiceSpeaking && nativePlayback() ? getAgentEnvelopeLevels(n) : null;
  const outActive = out !== null && out.reduce((a, b) => a + b, 0) > 0.05;
  // A muted mic is honestly silent, whatever the analyser still reads.
  return outActive && out ? out : env !== null ? env : s.voiceMicMuted ? new Array(n).fill(0) : getInputLevels(n);
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

// ---- The call's health (voiceHealth.ts), from the SDK's own meters ---------
//
// One sampler per live call reads the SDK's input and output levels; the
// detectors decide, this acts: a deaf or dead mic is re-acquired once through
// the SDK (changeInputDevice), then said in one plain line; audio arriving but
// not audible is logged and playback nudged (LiveKit's startAudio, a suspended
// context resumed); the first audible agent audio closes the turn's timing.
// Every step lands in the app log (vlog): the reports that prompted this had no
// trace of why a call went deaf or silent.
const health = new VoiceHealth((e) => onHealthEvent(e));
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthConv: ActiveConversation | null = null;
let healthCleanup: (() => void)[] = [];
let micRecoveries = 0;
export const MIC_UNHEARD_LINE = "vault-chat isn't receiving your microphone. Check the system's default input device.";

/** [best-effort, diagnostics] The SDK's live pieces it doesn't expose publicly:
 *  the LiveKit room (WebRTC), the mic track, the WebSocket path's audio contexts.
 *  Any of them may be missing; nothing depends on them but logs and nudges. */
function sdkParts(conv: ActiveConversation | null): { room: any; track: MediaStreamTrack | null; contexts: AudioContext[] } {
  const c = conv as any;
  const room = c?.connection?.getRoom?.() ?? null;
  let track: MediaStreamTrack | null = null;
  try {
    track = room?.localParticipant?.getTrackPublication?.("microphone")?.track?.mediaStreamTrack ?? c?.input?.inputStream?.getAudioTracks?.()[0] ?? null;
  } catch {
    track = null;
  }
  const contexts = [c?.input?.context, c?.output?.context].filter((x) => x && typeof x.state === "string");
  return { room, track, contexts };
}

/** The mic the SDK captures: its label and device id (logged at every start and switch). */
async function micInfo(conv: ActiveConversation | null): Promise<Record<string, unknown>> {
  const { track } = sdkParts(conv);
  if (!track) return { mic: null };
  const settings = (track.getSettings?.() ?? {}) as MediaTrackSettings;
  return {
    mic: track.label || null,
    micId: settings.deviceId ? String(settings.deviceId).slice(0, 12) : null,
    micState: track.readyState,
    echoCancellation: settings.echoCancellation,
  };
}

async function startHealthWatch(conv: ActiveConversation, transport: Transport): Promise<void> {
  stopHealthWatch();
  healthConv = conv;
  micRecoveries = 0;
  health.connected(Date.now());
  vlog("voice mic", { transport, ...(await micInfo(conv)) });
  if (healthConv !== conv) return;
  watchMicTrack(conv);
  // The output device or mic set changed (a headset plugged, a Bluetooth profile switch).
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (md?.addEventListener) {
    const onDevices = () => void devicesChanged(conv);
    md.addEventListener("devicechange", onDevices);
    healthCleanup.push(() => md.removeEventListener("devicechange", onDevices));
  }
  const { room, contexts } = sdkParts(conv);
  for (const ctx of contexts) {
    const onState = () => vlog("voice audio context", { state: ctx.state, rate: ctx.sampleRate });
    ctx.addEventListener?.("statechange", onState);
    healthCleanup.push(() => ctx.removeEventListener?.("statechange", onState));
  }
  if (room?.on) {
    // LiveKit's own events (string names: livekit-client RoomEvent).
    const events: [string, (...a: any[]) => void][] = [
      ["audioPlaybackChanged", () => vlog("voice playback allowed", { canPlay: room.canPlaybackAudio })],
      ["reconnecting", () => vlog("voice transport reconnecting", {})],
      ["reconnected", () => vlog("voice transport reconnected", {})],
      ["mediaDevicesError", (e: unknown) => vlog("voice media device error", { error: String((e as Error)?.message ?? e) })],
      ["connectionQualityChanged", (q: unknown, p: any) => p?.isLocal && q === "poor" && vlog("voice connection poor", {})],
    ];
    for (const [ev, fn] of events) {
      room.on(ev, fn);
      healthCleanup.push(() => room.off?.(ev, fn));
    }
  }
  healthTimer = setInterval(() => sampleHealth(conv), 100);
}

function stopHealthWatch(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  for (const f of healthCleanup.splice(0)) {
    try {
      f();
    } catch {
      /* already gone */
    }
  }
  healthConv = null;
}

const watchedTracks = new WeakSet<MediaStreamTrack>();
function watchMicTrack(conv: ActiveConversation): void {
  const { track } = sdkParts(conv);
  if (!track?.addEventListener || watchedTracks.has(track)) return;
  watchedTracks.add(track);
  const onEnded = () => {
    if (healthConv !== conv) return;
    vlog("voice mic ended", { mic: track.label || null });
    void recoverMic(conv, "the microphone track ended");
  };
  track.addEventListener("ended", onEnded);
  healthCleanup.push(() => {
    track.removeEventListener("ended", onEnded);
    watchedTracks.delete(track);
  });
}

async function devicesChanged(conv: ActiveConversation): Promise<void> {
  if (healthConv !== conv) return;
  let inputs: MediaDeviceInfo[] = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
  } catch {
    /* can't list */
  }
  const { track } = sdkParts(conv);
  const id = (track?.getSettings?.() ?? {}).deviceId;
  const stillThere = !id || inputs.some((d) => d.kind === "audioinput" && d.deviceId === id);
  vlog("voice devices changed", {
    inputs: inputs.filter((d) => d.kind === "audioinput").map((d) => d.label || "?").slice(0, 8),
    outputs: inputs.filter((d) => d.kind === "audiooutput").map((d) => d.label || "?").slice(0, 8),
    micState: track?.readyState ?? null,
    micStillThere: stillThere,
  });
  if (track?.readyState === "ended" || !stillThere) await recoverMic(conv, "the microphone went away");
}

/** Re-acquire the mic once through the SDK; a second failure in the call is said plainly. */
async function recoverMic(conv: ActiveConversation, why: string): Promise<void> {
  if (healthConv !== conv || activeConversation !== conv) return;
  micRecoveries++;
  if (micRecoveries === 1) {
    try {
      await conv.changeInputDevice({ inputDeviceId: "default" });
      if (healthConv !== conv) return;
      health.micReset(Date.now());
      watchMicTrack(conv);
      vlog("voice mic reacquired", { why, ...(await micInfo(conv)) });
      return;
    } catch (e) {
      vlog("voice mic reacquire failed", { why, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  if (micRecoveries <= 2) {
    console.error("[voice-eleven] microphone not reaching ElevenLabs:", why);
    voiceAppend({ role: "assistant", content: MIC_UNHEARD_LINE, system: true });
  }
}

function sampleHealth(conv: ActiveConversation): void {
  if (healthConv !== conv || activeConversation !== conv) return;
  const now = Date.now();
  let input = 0;
  let output = 0;
  try {
    input = conv.getInputVolume();
    output = conv.getOutputVolume();
  } catch {
    return;
  }
  const st = useStore.getState();
  const { room } = sdkParts(conv);
  health.sample({
    now,
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    muted: st.voiceMicMuted,
    speaking: st.voiceSpeaking,
    playbackBlocked: room ? room.canPlaybackAudio === false : false,
  });
  logTurn(turnStats.noAudio(now));
}

function onHealthEvent(e: HealthEvent): void {
  const conv = healthConv;
  switch (e.kind) {
    case "first-audio":
      logTurn(turnStats.audioPlaying(e.at));
      return;
    case "mic-dead":
      vlog("voice mic silent", { ms: e.ms, transport: activeTransport });
      if (conv) void micInfo(conv).then((m) => vlog("voice mic", m)).finally(() => recoverMic(conv, "the microphone reads silent"));
      return;
    case "mic-unheard":
      vlog("voice mic unheard", { speechMs: e.speechMs, waitedMs: e.waitedMs, transport: activeTransport });
      if (conv) void recoverMic(conv, "speech the meter saw got no transcript");
      return;
    case "silent-playback": {
      const { room, contexts } = sdkParts(conv);
      vlog("voice silent playback", {
        ms: e.ms,
        transport: activeTransport,
        canPlay: room ? room.canPlaybackAudio : null,
        contexts: contexts.map((c) => c.state),
      });
      // Nudge playback the SDK's own way: LiveKit's startAudio, a suspended context resumed.
      void room?.startAudio?.().catch(() => undefined);
      for (const c of contexts) if (c.state === "suspended") void c.resume().catch(() => undefined);
      return;
    }
    case "playback-resumed":
      vlog("voice playback resumed", { silentMs: e.silentMs });
      return;
  }
}

/** [tests] Feed one health sample now (the sampler's 100 ms tick). */
export function sampleVoiceHealthForTests(): void {
  if (activeConversation) sampleHealth(activeConversation);
}

// ---- Agent-audio playback envelope (visualizer) ---------------------------
//
// getOutputByteFrequencyData is the natural source for the speaking bars, but
// it's unreliable: the SDK's analyser sits post-gain on an AudioContext that
// can stay suspended (webviews) or read silent through the buffer-up phase —
// the same trap waitForSpeechEnd documents above. When it read dead while
// `voiceSpeaking` said audio WAS playing, the cockpit fell back to the MIC
// spectrum — bars tracking the user's ambient noise during the agent's turn is
// exactly the "wave out of sync with the voice" report (note 852e435b).
//
// This envelope is the honest replacement: onAudio hands us the real PCM the
// agent plays (16 kHz mono s16le, per the native-playback path at the top of
// this file), we slice it into per-50ms RMS levels, and replay the queue at
// wall-clock rate while the SDK's playback window (`voiceSpeaking`) is open.
// The crucial subtlety: chunks ARRIVE much faster than real time (the platform
// streams a whole turn into the client buffer in a burst), so the queue runs
// ahead of the ear — the cursor, advanced by elapsed time, is what stays in
// sync with what's audible. When mode flips back to "listening" the worklet
// buffer has drained, i.e. everything that arrived has been heard — the reset
// there drops any stale cursor lag so it can't animate silence.
const ENVELOPE_SLICE_MS = 50;
const ENVELOPE_SLICE_BYTES = (16_000 * 2 * ENVELOPE_SLICE_MS) / 1000;
let agentEnvelope: number[] = [];
let agentEnvelopePos = 0; // playback cursor, in (fractional) slices
let agentEnvelopeClock = 0; // last poll timestamp; 0 = cursor parked

function resetAgentEnvelope(): void {
  agentEnvelope = [];
  agentEnvelopePos = 0;
  agentEnvelopeClock = 0;
}

// Slice a base64 PCM16 chunk into per-ENVELOPE_SLICE_MS RMS levels (0..1) and
// queue them. If the payload ever isn't PCM16 the numbers are still
// energy-correlated, so the bars degrade gracefully rather than freeze.
function pushAgentEnvelope(audioBase64: string): void {
  const s = atob(audioBase64);
  for (let off = 0; off + 1 < s.length; off += ENVELOPE_SLICE_BYTES) {
    const end = Math.min(s.length, off + ENVELOPE_SLICE_BYTES);
    let sum = 0;
    let count = 0;
    // Every 2nd sample — plenty of resolution for a loudness meter.
    for (let i = off; i + 1 < end; i += 4) {
      let v = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8);
      if (v >= 32768) v -= 65536;
      sum += v * v;
      count++;
    }
    const rms = count ? Math.sqrt(sum / count) / 32768 : 0;
    // ×4 gain matches speech RMS (~0.1-0.2 of full scale) to the 0..1 bars.
    agentEnvelope.push(Math.min(1, rms * 4));
  }
  // Compact the consumed prefix so a long monologue can't grow the queue.
  const consumed = Math.floor(agentEnvelopePos);
  if (consumed > 400) {
    agentEnvelope.splice(0, consumed);
    agentEnvelopePos -= consumed;
  }
}

// Level of the slice that is audibly playing right now. Advances the cursor by
// wall-clock time between polls; holds the last slice if the cursor briefly
// outruns arrival (network stall — mode flips to listening right after anyway).
function agentEnvelopeLevel(): number {
  const now = performance.now();
  // Clamp a big gap (first poll of a turn, tab was throttled) to one slice so
  // the cursor can't leap past audio that hasn't played.
  const dt = agentEnvelopeClock ? Math.min(now - agentEnvelopeClock, 200) : 0;
  agentEnvelopeClock = now;
  agentEnvelopePos += dt / ENVELOPE_SLICE_MS;
  if (agentEnvelope.length === 0) return 0;
  return agentEnvelope[Math.min(agentEnvelope.length - 1, Math.floor(agentEnvelopePos))];
}

// Envelope shaped into a centre hump so the scalar level reads like a spectrum
// next to the analyser-driven bars it substitutes for. Poll once per frame
// while `voiceSpeaking` — polling is what advances the playback cursor.
export function getAgentEnvelopeLevels(n: number): number[] {
  const lvl = agentEnvelopeLevel();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const shape = 0.55 + 0.45 * Math.sin((i / (n - 1)) * Math.PI);
    out.push(lvl * shape);
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

// Always in the prompt, under any header (a vault's own voice.md replaces the
// header, not these): the voice was sycophantic and claimed things it can't do
// ("[excited] Yes, it absolutely does!" to a question whose answer was no).
export const VOICE_HONESTY_RULES = `Honesty — accurate over agreeable:
- No flattery or hype. Never "great question", "absolutely", "fantastic idea", "you're so right", "I love that". Calm, even tone; don't perform excitement or any other emotion.
- If the user is wrong, say so plainly and give the correct answer. Disagree when it's warranted. If the true answer to a yes/no question is no, say no.
- Never claim a tool or a capability you don't have, and never guess what one does. If you're not sure, say "I'm not sure" — then check with a tool if one can tell you.
- Your tools, exactly: Read, ListDir, Glob, Grep (the vault's files); Write, Edit, NotebookEdit (change them); PdfExtract (a PDF's text); ScrollTo, ShowFile, LookAtScreen (the user's screen); CreateNote, ListNotes, ResolveNote (notes); WebFetch, WebSearch (the web); Bash (a shell in the vault); SetProject (put this chat into a project, creating it if new); and, when the vault runs on a box, AskAgent and AgentStatus — hand work to the main agent (a separate, stronger agent with hours of compute) and check on it. AskAgent's project starts that work as a project; it is not itself a project.`;

// Compact file index for the system prompt. Voice mode struggles to
// "find" files when it has to guess paths from a name — dumping the
// real listing here gives the agent a direct map so it can construct
// absolute paths without a Glob round-trip. Cap is high enough for
// typical study vaults (~200 markdown + PDF + notebook files) without
// blowing up the prompt for huge ones.
const VAULT_INDEX_CAP = 250;

function buildVaultIndex(
  state: ReturnType<typeof useStore.getState>,
  // Vault-relative paths from elsewhere (the box has no file tree: git's list).
  given?: string[],
): string {
  const vault = state.vaultPath;
  if (!vault) return "";
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  const rels: string[] = given ? [...given] : [];
  for (const f of given ? [] : state.files) {
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
 *
 * `convId` is the thread the phone session is ATTACHED to (the conversation
 * open in the cockpit — /session posts it, the voice:context relay hands it
 * here). The recent-history block in the system prompt must come from THAT
 * thread: `state.messages` is whatever conversation happens to be focused on
 * the box's own desktop pane, so seeding from it left the phone's voice agent
 * blind to the very thread its transcripts land in (note dfe39eb4 — "voice
 * mode is not able to see conversations… even though the messages land in the
 * same thread"). No convId (standalone /voice page, heartbeat cache) means a
 * fresh voice thread gets minted at session start, so the honest history is
 * none at all — not some other thread's.
 */
export async function buildPhoneVoiceContext(
  convId?: string,
  // On the box: `vault` another vault than the store's (its working copy, with
  // `history` read from its own conversations), `slot` its agent's cache slot.
  opts?: { agentOnBox?: boolean; fileIndex?: string[]; vault?: string; history?: ChatMessage[]; slot?: string },
): Promise<{
  elKey: string;
  agentId: string;
  voiceId: string;
  systemPrompt: string;
  dynamicVariables: Record<string, string>;
  toolNames: string[];
  vault: string;
} | null> {
  const live = useStore.getState();
  const other = !!opts?.vault && opts.vault !== live.vaultPath;
  const state = other
    ? ({ ...live, vaultPath: opts!.vault!, files: [], messages: [], conversations: [], activeConversationId: null } as typeof live)
    : live;
  const elKey = state.serviceKeys.elevenlabs;
  if (!elKey || !state.vaultPath) return null;
  // Run the agent check and the prompt-context file reads CONCURRENTLY — this
  // build sits on the phone /session critical path (a ~12s relay budget), so
  // serializing a network call behind a fan-out of vault reads is what made
  // voice start flaky when the box was busy.
  const [agentId, customHeader, northStar, promptContext] = await Promise.all([
    ensureAgent(elKey, { vault: state.vaultPath, slot: opts?.slot }),
    loadVaultVoicePrompt(state.vaultPath),
    loadVaultNorthStar(state.vaultPath),
    loadVoicePromptContext(state.vaultPath),
  ]);
  if (!agentId) return null;
  // This vault's tools, by name of the vault (never whichever vault loaded last).
  const vaultTools = toolsFor(state.vaultPath);
  // Resolve the attached thread's messages. The ACTIVE conversation's stored
  // entry only mirrors the live top-level `messages` buffer on certain sync
  // points, so when the phone is attached to the box's active thread, read the
  // live buffer directly — the stored copy can lag it.
  const attached = convId
    ? state.conversations.find((c) => c.id === convId)
    : undefined;
  const historyMessages = opts?.history
    ? opts.history
    : attached
      ? attached.id === state.activeConversationId
        ? state.messages
        : attached.messages
      : [];
  return {
    elKey,
    agentId,
    voiceId: localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID,
    systemPrompt: buildSystemPrompt(state, customHeader, northStar, promptContext, historyMessages, opts?.agentOnBox, opts?.fileIndex, vaultTools),
    dynamicVariables: buildDynamicVariables(state),
    toolNames: Object.keys(buildClientToolHandlers(undefined, undefined, vaultTools)),
    vault: state.vaultPath,
  };
}

// Voice prompt parity with the chat assistant: the same operating rules
// (LEARNING_RULES / AGENTS / CLAUDE / goal files), the same long-term memory
// index, and the same skills index. Loaded once per session start and threaded
// into the system-prompt override — voice was previously the only surface that
// reasoned without these. Each loader degrades to empty on failure.
export type VoicePromptContext = {
  sessionContext: string;
  memoryBlock: string;
  skillsIndex: string;
};

// Provision the ElevenLabs agent at app launch (when a key exists) so voice is
// ready on the first mic-tap. ensureAgent used to run only on mic-tap, so after
// an app update — which bumps AGENT_CONFIG_VERSION and forces a re-provision —
// voice could appear broken until you opened the mic, and previously wouldn't
// pick up until a Settings visit. Idempotent: returns the cached agent unless
// stale. No-op when no key is configured.
export async function initVoiceAgentOnLaunch(): Promise<void> {
  const key = useStore.getState().serviceKeys.elevenlabs;
  if (!key) return;
  try {
    await ensureAgent(key);
  } catch (e) {
    console.warn("[voice-eleven] launch agent init failed:", e);
  }
}

export async function loadVoicePromptContext(
  vault: string | null,
): Promise<VoicePromptContext> {
  if (!vault) return { sessionContext: "", memoryBlock: "", skillsIndex: "" };
  const [sessionContext, memoryIndex, skills] = await Promise.all([
    loadSessionContext(vault).catch(() => ""),
    loadVaultMemoryIndex(vault).catch(() => ""),
    loadSkills(vault).catch(() => []),
  ]);
  // Bound each block: the chat agent sends these to Anthropic uncapped, but the
  // voice prompt is an ElevenLabs session-start override with a tighter ceiling,
  // and loadSessionContext can pull in large goal ledgers. Keep voice readable
  // and the override well under any platform limit; the full files are still one
  // Read away if the agent needs them.
  const cap = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + "\n…[truncated for voice]" : s;
  return {
    sessionContext: cap(sessionContext, 6000),
    memoryBlock: cap(vaultMemoryPromptBlock(memoryIndex), 3000),
    skillsIndex: cap(skills.length ? skillPromptIndex(skills) : "", 2000),
  };
}

// Current-date anchor — same rationale as the chat agent's nowNote. Without it
// the voice agent has no reliable "now" and infers the date from file contents
// or git history.
function voiceNowNote(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const stamp = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: tz,
    }).format(new Date());
    return `Current date and time: ${stamp}. Trust THIS as "now"/"today" — never infer the date from file contents or git history.`;
  } catch {
    return "";
  }
}

export function buildSystemPrompt(
  state: ReturnType<typeof useStore.getState>,
  customHeader: string,
  northStar: string,
  extra?: VoicePromptContext,
  // History source override. Desktop sessions run IN the active conversation,
  // so the default (`state.messages`) is the right thread. Phone sessions are
  // attached to an explicit convId whose messages live in `state.conversations`
  // — buildPhoneVoiceContext resolves that thread and passes it here so the
  // agent sees the history of the thread its transcripts land in.
  historyMessages?: ChatMessage[],
  // The vault runs on a box: the tools run there and AskAgent hands work to its agent.
  agentOnBox?: boolean,
  fileIndex?: string[],
  // The vault's own tools (default: the store vault's).
  tools?: VaultVoiceTool[],
): string {
  const vault = state.vaultPath ?? "(no vault)";
  const recentHistory = formatRecentHistory(historyMessages ?? state.messages, 24);
  const followNote = state.followAlong
    ? "Follow-along is on. The active document and viewport are in dynamic variables and will refresh via contextual updates as the user scrolls."
    : "Follow-along is off. The user is not asking about a specific document unless they name one.";
  const header = customHeader.trim() || DEFAULT_VOICE_PROMPT_HEADER;
  const northStarBlock = northStarPromptBlock(northStar);
  const vaultIndex = buildVaultIndex(state, fileIndex);
  // A model that reads uploaded documents (ElevenLabs' list says so) gets the
  // open PDF itself and no PdfExtract tool; the others read PDFs through the tool.
  const docs = readsDocuments(getCurrentLlm());
  const pdfReadingLine = docs
    ? "- PDFs: you can see them directly — the full document is in your multimodal context. Don't try to Read .pdf files as text; just look at the pages."
    : "- PdfExtract is how you read PDFs (Read won't work on .pdf). `pages` arg accepts '1', '1-5', '3,5,7'.";
  // The user's per-vault custom tools — same set the text agent loads. List them
  // by name + description so voice discovers them the way the text agent does;
  // their full schemas reach the model via the agent provisioning in ensureAgent.
  const vaultTools = tools ?? toolsFor(state.vaultPath);
  const customToolsBlock = vaultTools.length
    ? [
        "Custom tools for THIS vault (added by the user — call them exactly like the built-ins above):",
        ...vaultTools.map((t) => `- ${t.name}: ${t.description}`),
      ].join("\n")
    : "";
  return [
    header,
    "",
    VOICE_HONESTY_RULES,
    "",
    `Vault root (absolute): ${vault}`,
    voiceNowNote(),
    "",
    northStarBlock ? `${northStarBlock}\n` : "",
    extra?.sessionContext ? `${extra.sessionContext}\n` : "",
    extra?.memoryBlock ? `${extra.memoryBlock}\n` : "",
    extra?.skillsIndex ? `${extra.skillsIndex}\n` : "",
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
    "- Edit replaces a unique string in an existing file — prefer over Write for small changes to large files. When the user wants a term changed EVERYWHERE / in every case / throughout (e.g. swap one word for another across a note), pass replace_all=true — a plain Edit only touches the FIRST match and silently leaves the rest, which reads to the user as 'you didn't get every case'. After any sweeping change, Read the file back and confirm every occurrence landed before you say it's done.",
    "- Keep each Write or Edit short (a section, not a whole note). A big rewrite in one call takes too long to produce and the call drops: do it as several Edits, one section at a time, saying what you're doing between them — or hand it to AskAgent when there is one.",
    "- NotebookEdit is the only safe way to touch .ipynb files. action='append' adds to a cell's end; 'replace' overwrites a cell; 'insert' adds a new cell at cell_index (-1 = end); 'delete' removes one. 0-based.",
    "",
    "Notes:",
    "- CreateNote saves a quick reminder when the user says 'remember', 'jot that down'. Keep notes brief.",
    "- ListNotes shows flagged items — only when the user asks for them; never to open a session. ResolveNote closes one when it's been addressed.",
    "",
    "Projects:",
    "- You CAN create and assign projects: SetProject {name} puts this chat into that project, creating it if it is new — no confirmation needed, the user asked you. Never say you have no project tool.",
    "",
    "Web:",
    "- WebFetch when you have a URL — reads the page as text.",
    "- WebSearch for current info or to find a URL. Requires a Tavily key; if missing the tool returns an error you can relay to the user.",
    "",
    customToolsBlock ? `${customToolsBlock}\n` : "",
    agentOnBox
      ? [
          "The main agent (the vault runs on a box):",
          "- Your tools run on the box, against its copy of the vault; your writes sync like any agent edit.",
          "- For long or heavy work (research, many edits, builds, anything over a minute), don't grind through it yourself: hand it to the agent with AskAgent (a full task description — it doesn't hear this call), tell the user it's on it, and offer to report back. Keep the conversationId.",
          "- When the user asks how it's going, or you offered to report back, call AgentStatus and summarise it in a sentence or two.",
          "- To start the agent's work as a project, pass AskAgent's project (the project's name; a new name creates the project).",
          "",
        ].join("\n")
      : "",
    "Shell:",
    "- Bash runs commands with the vault as cwd. Default timeout 20s; hard ceiling ~25s because the platform cuts off tool responses at 30s. For long-running things (cloning big repos, training runs, long installs), background with `nohup <cmd> > /tmp/run.log 2>&1 &` and poll the log file in later Bash calls.",
    "- Bash may be disabled in settings — if it returns an error to that effect, relay it to the user instead of trying to work around it.",
    "",
    "Document context (when a file is open):",
    "- You can see the full PDF the user has open — text, equations, diagrams, layout, all of it. Answer visual questions directly. Don't claim you can't see the screen.",
    "- The viewport context tells you which page they're currently on. When they say 'this', 'that math', 'explain this' — they mean their current page, not pages you recently discussed or pages that seem related. If they want a different page they'll name it.",
    "",
    "Seeing what the user sees:",
    "- When the user opens an image, it is attached to your context with a short note — you can see it.",
    "- ShowFile opens a file for the user ('pull up the figure'). An image you show is attached for you too.",
    "- LookAtScreen reads their screen right now, on their machine: the open file, the part in view, its text and every image in view (attached as shown — typing and pastes not yet saved or synced included). Call it whenever they say 'look at this', 'what's this?', or that they pasted, wrote or changed something; call it again after any change — an image you saw earlier may be out of date. It is newer than any file you Read.",
    "- Anything they send in this chat while you talk (typed text, pasted images, files) comes to you as their turn; images arrive attached — you can see them.",
    "- You can see images and their screen. Never ask them to refresh, re-paste, re-attach, or 'send it in the chat' — look (LookAtScreen) instead. If a look fails, say exactly what failed (the tool's words); never blame syncing.",
    "",
    "Math: what you say is spoken AND shown in the chat, where spoken math is rendered as notation automatically. Say equations in words ('alpha plus beta squared', 'x sub i over n'); never write LaTeX, symbols or dollar signs — they are read aloud literally.",
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
    recentHistory
      ? `Recent conversation context (earlier turns of THIS same thread, oldest first — the user may refer back to them):\n${recentHistory}`
      : "",
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

// Newest-last so the freshest turns sit closest to the live conversation. The
// per-message cap keeps single walls of text from eating the block; the total
// budget keeps a 32-turn thread of long messages under the ElevenLabs
// session-override ceiling (same rationale as the caps in
// loadVoicePromptContext). When the budget bites, the OLDEST turns drop first.
export const HISTORY_TOTAL_CHAR_BUDGET = 6000;

function formatRecentHistory(messages: ChatMessage[], take: number): string {
  const recent = messages
    .filter((m) => !m.system && (m.role === "user" || m.role === "assistant"))
    .slice(-take);
  if (recent.length === 0) return "";
  const lines = recent.map((m) => {
    const n = m.attachments?.length ?? 0;
    // An image sent with the line is said (its pixels arrive as an attachment at the start: pushThreadImages).
    const att = n ? ` [sent ${n === 1 ? "an image" : `${n} images`}]` : "";
    return `${m.role === "user" ? "User" : "You"}: ${truncate(m.content.trim(), 300)}${att}`;
  });
  // Trim from the front (oldest) until the newest turns fit the budget.
  let total = lines.reduce((a, l) => a + l.length + 1, 0);
  let start = 0;
  while (start < lines.length - 1 && total > HISTORY_TOTAL_CHAR_BUDGET) {
    total -= lines[start].length + 1;
    start++;
  }
  return lines.slice(start).join("\n");
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

// ---- Agent provisioning ---------------------------------------------------

let lastAgentCreateError: { status: number; body: string } | null = null;

export function getLastAgentCreateError(): { status: number; body: string } | null {
  return lastAgentCreateError;
}

// Circuit breaker for non-transient agent-create failures. A 422 (bad payload —
// e.g. a voice/LLM/tool-schema the platform rejects) will fail identically
// forever; the phone host's 20s heartbeat would otherwise re-POST it ~3/min
// indefinitely (the observed 965 calls / 5h with no user signal). After
// AGENT_CREATE_MAX_4XX consecutive non-transient 4xx failures we trip the
// breaker: ensureAgent returns null without hitting the network until a
// user-initiated path calls resetAgentCreateBreaker(). 408/429 are transient
// (timeout / rate-limit) and DON'T count — they may clear on their own.
const AGENT_CREATE_MAX_4XX = 3;
let agentCreate4xxStreak = 0;
let agentCreateBreakerTripped = false;
export function resetAgentCreateBreaker(): void {
  agentCreate4xxStreak = 0;
  agentCreateBreakerTripped = false;
}
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429;
}

// One provisioned agent per slot: the box keeps one per vault (each vault's own
// tools), so switching vaults never re-creates an agent. No slot: the laptop's.
const slotKey = (name: string, slot?: string) => (slot ? `${name}:${slot}` : name);

/** Filler the agent says while a slow model is still thinking (soft timeout): short and neutral. */
const SOFT_TIMEOUT_MESSAGE = "One sec.";
/** Back-channel words that never interrupt the agent ("yeah" while it talks is listening, not a new turn). */
export const INTERRUPTION_IGNORE_TERMS = ["yeah", "yep", "mm", "mhm", "mm-hm", "uh-huh", "ok", "okay", "right", "sure"];
/** When the chosen model is down: Claude Haiku, then a small GPT (ElevenLabs' default chain starts with Gemini). */
export const BACKUP_LLMS = ["claude-haiku-4-5", "gpt-4.1-mini"];
/** Seconds each model in the cascade gets before the next one is tried (ElevenLabs: 2–15, default 4).
 *  At the default 4 s a turn whose answer is a tool call with a long argument (rewrite
 *  a note) missed it on every model, and ElevenLabs closed the call ("LLM Cascade
 *  Error: TimeoutError", 1002); the soft-timeout filler covers the wait from 3 s. */
export const CASCADE_TIMEOUT_SECONDS = 15;
/** Files (images, PDFs) kept whole in the model's context; older ones are summarised and freed. */
export const FILES_IN_MEMORY = 4;

/** The agent ElevenLabs creates for vault-chat (POST /v1/convai/agents/create).
 *  `info` is the model's row in ElevenLabs' list (what it can take, its reasoning). */
export function buildAgentCreateBody(o: {
  llm: string;
  info: VoiceLlmInfo | null;
  customTools: { name: string; description: string; parameters: unknown }[];
  voiceId: string;
}): Record<string, unknown> {
  const readsDocs = o.info?.documents === true;
  const effort = reasoningEffortFor(o.info);
  return {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        prompt: {
          prompt: "(per-session override)",
          llm: o.llm,
          // Even and factual, not performative (Carl: the voice was sycophantic).
          temperature: 0.4,
          // A spoken reply wants no thinking: "none" when the model offers it, else its lowest.
          ...(effort ? { reasoning_effort: effort } : {}),
          backup_llm_config: { preference: "override", order: BACKUP_LLMS },
          cascade_timeout_seconds: CASCADE_TIMEOUT_SECONDS,
          tools: [
            ...CLIENT_TOOL_DEFINITIONS
              // A model that reads the PDF itself (an uploaded document) doesn't need PdfExtract —
              // the tool is dead weight that occasionally distracts it.
              .filter((t) => !(readsDocs && t.name === "PdfExtract"))
              // A custom vault tool with the same name as a built-in wins
              // (matches the text agent's { ...builtin, ...custom } merge).
              .filter((t) => !o.customTools.some((c) => c.name === t.name))
              .map((t) => ({
                type: "client" as const,
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                // CRITICAL: defaults to false — without it the agent never sees the tool's result.
                expects_response: true,
                response_timeout_secs: 30,
              })),
            // The vault's own tools — the same ones the text agent loads.
            ...o.customTools.map((t) => ({
              type: "client" as const,
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              expects_response: true,
              response_timeout_secs: 30,
            })),
            // NB: end_call is intentionally omitted (it hung up on long study
            // silences). skip_turn is the lever for the 30 s re-engage: the agent
            // has a concrete "nothing to add" action instead of filler.
            { type: "system" as const, name: "skip_turn" },
          ],
        },
      },
      // A natural, low-latency voice, NOT the expressive mode: expressive_mode
      // (on by default) makes the model write "[excited]"-style audio tags and
      // perform emotions. src/voiceTags.ts still strips any from the transcript.
      tts: {
        // English agents must use flash or turbo v2 (ElevenLabs refuses v2_5 with a 400).
        model_id: "eleven_flash_v2",
        expressive_mode: false,
        voice_id: o.voiceId,
      },
      // Two hours (the 10-minute default hung up mid-explanation); never hang up on silence.
      conversation: {
        max_duration_seconds: 7200,
        silence_end_call_timeout: -1,
        // Uploads (PDFs, images) reach the model only with file input on.
        // Only the newest few stay whole in context (a look's images are one stacked picture).
        file_input: { enabled: true, max_files_in_memory: FILES_IN_MEMORY, max_files_per_conversation: 40 },
      },
      turn: {
        // Silence before ElevenLabs re-engages the agent (max 30 s; skip_turn answers it).
        turn_timeout: 30,
        turn_model: "turn_v3",
        // Wait for the user to finish (study talk has pauses); back-channel words don't interrupt.
        turn_eagerness: "patient",
        interruption_ignore_terms: INTERRUPTION_IGNORE_TERMS,
        merge_with_default_ignore_terms: true,
        // Start the reply while the end of the turn is being confirmed (lower latency).
        speculative_turn: true,
        soft_timeout_config: { timeout_seconds: 3, message: SOFT_TIMEOUT_MESSAGE },
      },
      // Another voice in the room (a video, someone nearby) is not the user barging in.
      vad: { background_voice_detection: true },
      asr: { provider: "scribe_realtime" },
    },
    // Per-session overrides must be enabled here or they are silently ignored.
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true },
        },
      },
    },
  };
}

async function ensureAgent(apiKey: string, opts?: { vault?: string; slot?: string }): Promise<string | null> {
  const AGENT_ID_STORAGE = slotKey(AGENT_ID_KEY, opts?.slot);
  const AGENT_LLM_AT_PROVISION = slotKey(AGENT_LLM_KEY, opts?.slot);
  const AGENT_VERSION_STORAGE = slotKey(AGENT_VERSION_KEY, opts?.slot);
  const AGENT_TOOLS_SIG_STORAGE = slotKey(AGENT_TOOLS_SIG_KEY, opts?.slot);
  const AGENT_VOICE_STORAGE = slotKey(AGENT_VOICE_KEY, opts?.slot);
  const wantedVoice = localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID;
  // Refresh the custom-tool snapshot first — this also warms the cache that
  // buildClientToolHandlers / buildSystemPrompt read synchronously, and the
  // signature joins the staleness check so adding a vault tool re-provisions.
  const customTools = await refreshVoiceTools(opts?.vault);
  const toolsSig = voiceToolsSignature(customTools);
  const cached = localStorage.getItem(AGENT_ID_STORAGE);
  const provisionedWith = localStorage.getItem(AGENT_LLM_AT_PROVISION);
  const provisionedVersion = localStorage.getItem(AGENT_VERSION_STORAGE);
  const provisionedTools = localStorage.getItem(AGENT_TOOLS_SIG_STORAGE);
  const wantedLlm = getCurrentLlm();
  // Re-provision if the LLM choice, the agent-config schema, or the vault's
  // custom tool set has changed since this agent was created. (The orchestrator
  // caches all of these at agent level, so changes don't take effect on the
  // existing agent — we make a fresh one.)
  const stale =
    cached &&
    (provisionedWith !== wantedLlm ||
      provisionedVersion !== AGENT_CONFIG_VERSION ||
      provisionedTools !== toolsSig);
  if (cached && !stale) {
    if (localStorage.getItem(AGENT_VOICE_STORAGE) === wantedVoice) return cached;
    // Another voice was picked: make it the agent's own.
    const r = await setAgentVoice(apiKey, cached, wantedVoice);
    if (r.ok) {
      localStorage.setItem(AGENT_VOICE_STORAGE, wantedVoice);
      return cached;
    }
    if (r.status === 404) localStorage.removeItem(AGENT_ID_STORAGE); // gone: a fresh agent below
    else if (r.status >= 400 && r.status < 500 && !isTransientStatus(r.status)) {
      // ElevenLabs refuses this voice for this agent: say so; never start with another voice silently.
      lastAgentCreateError = { status: r.status, body: `voice ${wantedVoice}: ${r.body}` };
      console.error("[voice-eleven] the agent's voice was refused:", wantedVoice, r.status, r.body);
      return null;
    } else {
      // Unreachable or a server error: the session's override still carries the voice.
      console.warn("[voice-eleven] couldn't set the agent's voice (the session override carries it):", r.status, r.body);
      return cached;
    }
  }
  // Breaker is open: a recent payload kept failing non-transiently. Don't
  // re-POST the same body. lastAgentCreateError is preserved so a user-facing
  // path can describe it.
  if (agentCreateBreakerTripped) return null;
  if (stale) {
    localStorage.removeItem(AGENT_ID_STORAGE);
  }
  // What ElevenLabs says this model takes (images, documents) and how it reasons.
  const llmList = await voiceLlmList(apiKey);
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildAgentCreateBody({ llm: wantedLlm, info: llmInfo(llmList, wantedLlm), customTools, voiceId: wantedVoice })),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[voice-eleven] agent create failed:", res.status, body);
      lastAgentCreateError = { status: res.status, body };
      // Count only non-transient 4xx (bad payload). 408/429 are transient and
      // left alone so a flaky window self-heals; 5xx is a server problem we let
      // the heartbeat keep probing — it's not a permanently-bad request.
      if (res.status >= 400 && res.status < 500 && !isTransientStatus(res.status)) {
        agentCreate4xxStreak += 1;
        if (agentCreate4xxStreak >= AGENT_CREATE_MAX_4XX) {
          agentCreateBreakerTripped = true;
          console.warn(
            "[voice-eleven] agent-create breaker tripped after",
            agentCreate4xxStreak,
            "non-transient 4xx",
          );
        }
      }
      return null;
    }
    const json = (await res.json()) as { agent_id?: string };
    if (!json.agent_id) {
      console.error("[voice-eleven] agent create returned no agent_id:", json);
      lastAgentCreateError = { status: 0, body: JSON.stringify(json) };
      return null;
    }
    lastAgentCreateError = null;
    agentCreate4xxStreak = 0;
    agentCreateBreakerTripped = false;
    localStorage.setItem(AGENT_ID_STORAGE, json.agent_id);
    localStorage.setItem(AGENT_LLM_AT_PROVISION, wantedLlm);
    localStorage.setItem(AGENT_VERSION_STORAGE, AGENT_CONFIG_VERSION);
    localStorage.setItem(AGENT_TOOLS_SIG_STORAGE, toolsSig);
    localStorage.setItem(AGENT_VOICE_STORAGE, wantedVoice);
    return json.agent_id;
  } catch (e) {
    console.error("[voice-eleven] agent create exception:", e);
    lastAgentCreateError = { status: 0, body: (e as any)?.message ?? String(e) };
    return null;
  }
}

/** PATCH the provisioned agent's voice (conversation_config.tts.voice_id). */
async function setAgentVoice(apiKey: string, agentId: string, voiceId: string): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_config: { tts: { voice_id: voiceId } } }),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text().catch(() => "") };
  } catch (e) {
    return { ok: false, status: 0, body: (e as Error)?.message ?? String(e) };
  }
}

export async function getSignedUrl(apiKey: string, agentId: string, slot?: string): Promise<string | null> {
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
        localStorage.removeItem(slotKey(AGENT_ID_KEY, slot));
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

/** A WebRTC conversation token for the agent (ElevenLabs' recommended transport:
 *  built-in echo cancellation, jitter buffer, noise suppression). Minted with the
 *  key exactly as the signed URL is; null when ElevenLabs refuses. */
export async function getConversationToken(apiKey: string, agentId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      console.error("[voice-eleven] conversation token failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as { token?: string };
    return typeof json.token === "string" && json.token ? json.token : null;
  } catch (e) {
    console.error("[voice-eleven] conversation token exception:", e);
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
    case "CreateNote": {
      const text = (args.text ?? "").trim();
      const snip = text.length > 50 ? text.slice(0, 47) + "…" : text;
      return `Saved note "${snip}"`;
    }
    case "WebFetch":
      return `Fetched ${args.url ?? ""}`;
    case "WebSearch":
      return `Searched web for "${args.query ?? ""}"`;
    case "AskAgent": {
      const task = String(args.task ?? "").trim().replace(/\s+/g, " ");
      return `Handed to the agent: "${task.length > 70 ? task.slice(0, 67) + "…" : task}"`;
    }
    case "AgentStatus":
      return `Checked on the agent`;
    case "SetProject":
      return String(args.name ?? "").trim() ? `Put this chat in the project "${String(args.name).trim()}"` : "Took this chat out of its project";
    case "Bash": {
      const cmd = String(args.command ?? "").trim().replace(/\s+/g, " ");
      const snip = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
      return `$ ${snip}`;
    }
    default:
      return name;
  }
}

function logToolCall(name: string, args: any, result: string, where = ""): void {
  // Names and sizes only (the app log captures this line): never the arguments' or the result's text.
  const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : null;
  console.log(`[voice-eleven] tool ${name}(${Object.keys(args ?? {}).join(",")}${path ? ` path=${path}` : ""}) → ${result.length} chars${/^error/i.test(result) ? " (error)" : ""}`);
  // Ran here (not on the box, which records its own): what it changed, into the shared stream.
  if (!where) recordLocalVoice(voiceToolEntry(name, args, result, useStore.getState().vaultPath));
  // Shown as a tool row, like the text agent's calls (name, input, result).
  voiceAppend({
    role: "assistant",
    content: formatToolMarker(name, args) + where,
    system: true,
    toolCalls: [{ name, input: args ?? {}, result: result.length > 4000 ? result.slice(0, 4000) + "…" : result }],
  });
}

/** SetProject: this session's chat into project `name` (created when new; "" = out of its project).
 *  Its own thread once it has lines (box mode: the box's copy), else the chat it started from. */
export async function setVoiceChatProject(name: unknown): Promise<string> {
  const want = typeof name === "string" ? name.trim() : "";
  await transcriptMirror?.done?.();
  const s = useStore.getState();
  const own = voiceChats?.own() ?? null;
  const ownConv = own ? s.conversations.find((c) => c.id === own) : undefined;
  const ownMsgs = ownConv ? (s.activeConversationId === own ? s.messages : ownConv.messages) : [];
  const target = own && ownMsgs.some((m) => !m.system) ? own : (voiceChats?.from ?? own ?? s.activeConversationId);
  if (!target) return "Error: there is no chat to put into a project.";
  const p = await import("./projects");
  const known = await p.listProjects(s.vaultPath).catch(() => []);
  const r = await p.setConversationProject(target, want || null, known);
  if (!r.ok) return `Error: ${r.error}`;
  if (!r.slug) return "Done — this chat is no longer in a project.";
  const isNew = !known.some((k) => k.slug === r.slug);
  return `Done — this chat is now in the project "${want || r.slug}"${isNew ? " (a new project)" : ""}.`;
}

// Wraps a tool handler so the cockpit knows what's running. Sets
// voiceCurrentTool before the impl fires and clears it after, so
// the titlebar pill can show "Running ToolName…" while the work
// happens. Always logs to chat regardless of success/failure.
function safeLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function withTracking<A>(
  name: string,
  impl: (args: A) => Promise<string>,
  // Shown after the marker: where the tool ran when it was not here (" · on the box").
  where = "",
): (args: A) => Promise<string> {
  return async (args: A) => {
    useStore.getState().setVoiceCurrentTool(name);
    logTurn(turnStats.firstResponse(`tool:${name}`, Date.now(), safeLen(args)));
    let result: string;
    try {
      result = await impl(args);
    } finally {
      useStore.getState().setVoiceCurrentTool(null);
    }
    turnStats.toolResult(name, result.length);
    turnStats.images = imagePusher.uploaded;
    logToolCall(name, args, result, where);
    return result;
  };
}

export function buildClientToolHandlers(
  remote?: RemoteVoiceTool,
  remoteNames?: string[],
  // The vault's own tools (default: the store vault's).
  vaultTools: VaultVoiceTool[] = toolsFor(useStore.getState().vaultPath),
): Record<
  string,
  (parameters: any) => Promise<string>
> {
  const handlers: Record<string, (parameters: any) => Promise<string>> = {
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
          // Same page-range rules as the chat tool (tools.ts readPdf).
          return await readPdf(args.path, { pages: args.pages });
        } catch (e) {
          return `Error: ${(e as any)?.message ?? String(e)}`;
        }
      },
    ),
    ScrollTo: withTracking(
      "ScrollTo",
      async (args: { page?: number; anchor?: string; path?: string }) => {
        const state = useStore.getState();
        // A vault-relative path (the box's tools answer with those) is joined to this vault.
        if (args.path && boxVaultRoot && state.vaultPath && args.path.startsWith(boxVaultRoot)) {
          args = { ...args, path: args.path.slice(boxVaultRoot.length).replace(/^[\\/]+/, "") };
        }
        const rel = args.path && !/^([a-z]:[\\/]|[\\/])/i.test(args.path) && state.vaultPath;
        const targetPath = rel ? `${state.vaultPath!.replace(/[\\/]+$/, "")}/${args.path}` : (args.path ?? state.currentFile);
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
        // The move lands with the words already playing — but never long: ElevenLabs gives a
        // client tool 30 s, and a turn that opens with ScrollTo has nothing playing at all
        // (waiting the old full 30 s for speech that never came timed every such call out).
        await waitForSpeechEnd(250, SCROLL_SPEECH_WAIT_MS, SCROLL_SPEECH_START_MS);
        if (myGen !== scrollGen) {
          return `Superseded by later ScrollTo`;
        }
        const target = pendingScrollTarget;
        pendingScrollTarget = null;
        if (!target) {
          return `Superseded by later ScrollTo`;
        }
        return scrollViewer(target.path, target.anchor);
      },
    ),
    ShowFile: withTracking("ShowFile", async (args: { path?: string }) => {
      const path = localPathFor(args.path);
      if (!path) return "Error: path is required.";
      const name = path.split(/[\\/]/).pop() ?? path;
      const kind = fileKind(path).kind;
      try {
        const content = isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path });
        useStore.getState().setCurrentFile(path, content);
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
      if (kind !== "image") return `Opened ${name} for the user.`;
      // Fullscreen chat has no viewer: the image shows in the thread instead.
      const s = useStore.getState();
      if (s.chatFullscreen && !s.popoutOpen) {
        const thumb = await readImageThumb(path);
        if (thumb) voiceAppend({ role: "assistant", content: `Showing ${name}`, attachments: [{ imageDataUrl: thumb, sourcePath: path }] });
      }
      const r = await pushVoiceImageFile(path);
      return r === "sent" || r === "duplicate"
        ? `Showing ${name}. The image is attached — you can see it.`
        : `Showing ${name}, but the image couldn't be attached (${r}).`;
    }),
    SetProject: withTracking("SetProject", (args: { name?: string }) => setVoiceChatProject(args?.name)),
    LookAtScreen: withTracking("LookAtScreen", async () => {
      const state = useStore.getState();
      const file = state.currentFile;
      // The focused pane as it is on screen, read here at call time.
      const { focusedPane } = await import("./screenLook");
      const pane = focusedPane(file);
      if (pane) {
        try {
          return await lookAtScreenFromPane(pane);
        } catch (e) {
          console.error("[voice-eleven] LookAtScreen capture failed:", e);
          return `Error: the screen capture failed on the user's machine (${(e as Error)?.message ?? String(e)}). Tell the user it failed; it isn't a sync problem.`;
        }
      }
      if (!file) return "Nothing is open on the user's screen.";
      const name = file.split(/[\\/]/).pop() ?? file;
      const kind = fileKind(file).kind;
      if (kind === "image") {
        const r = await pushVoiceImageFile(file);
        if (r === "sent") return `Attached ${name} — you can see it now.`;
        if (r === "duplicate") return `${name} is already in your context — look at it.`;
        return `Couldn't attach ${name} (${r}).`;
      }
      if (kind === "pdf") {
        const page = state.viewport?.path === file ? state.viewport.page : undefined;
        const shot = page ? capturePdfPage(page) : null;
        if (shot && page) {
          const r = await pushVoiceImageDataUrl(`${file}#page=${page}`, shot, name, `page ${page}`);
          if (r === "sent" || r === "duplicate") return `Attached page ${page} of ${name} as the user sees it.`;
        }
        void pushPdfIfNeeded();
        return `The whole PDF ${name} is in your context${page ? `; the user is on page ${page}` : ""}.`;
      }
      const text = buildViewportContextText(state);
      return text || `${name} is open, but nothing in view can be read.`;
    }),
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
  };

  // Custom per-vault tools, from the snapshot ensureAgent loaded (which always
  // runs first on every voice path). Same execute the text agent uses, wrapped
  // in withTracking so they show in the cockpit pill and chat log like built-ins.
  // A custom tool sharing a built-in's name overrides it — matching both the
  // text agent's merge order and the agent schema filter in ensureAgent.
  const noBox = async () => "Error: the vault isn't connected to a box, so there is no main agent to hand work to. Do it here, or ask the user to connect the box.";
  handlers.AskAgent = withTracking("AskAgent", noBox);
  handlers.AgentStatus = withTracking("AgentStatus", noBox);

  // Box mode: every built-in that reads or writes the vault runs on the box
  // (server/voice.ts); the ones that move the user's screen stay here.
  // The vault's own tools: here, or on the box (in its sandbox) in box mode —
  // together with any the box's agent offers that this laptop hasn't loaded.
  const customs = new Set<string>([...vaultTools.map((t) => t.name), ...(remote ? (remoteNames ?? []) : [])]);
  if (remote) {
    for (const name of new Set([...BUILTIN_VOICE_TOOL_NAMES, ...customs])) {
      if (LOCAL_VOICE_TOOLS.has(name)) continue;
      handlers[name] = withTracking(name, (args: unknown) => remote(name, args), " · on the box");
    }
  } else {
    for (const t of vaultTools) {
      handlers[t.name] = withTracking(t.name, (args: unknown) => t.execute(args));
    }
  }

  return handlers;
}
