import { Conversation } from "@elevenlabs/client";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage, type Viewport, type FileEntry } from "./store";
import { buildNote } from "./notes";
import { gitCommitAll } from "./git";
import { loadMetaVoicePrompt } from "./meta";
import { applyNotebookEdit, extractPdfText, stripNotebook } from "./tools";

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
// Gemini 2.5 Pro: native PDF input (up to 1000 pages), strong math
// reasoning (AIME / GPQA Diamond near the top of the leaderboard), and
// 1M-token multimodal context that was specifically architected for
// long interleaved image+text workloads — exactly the read-along /
// lecture-study workload this app is built around. GA, no `-preview`
// rug-pull risk. Per-session LLM picker still works for swapping in
// claude-sonnet-4-6 / gemini-3.1-pro-preview / etc.
const DEFAULT_LLM = "gemini-2.5-pro";
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
const AGENT_CONFIG_VERSION = "v11-scrollto-pdf";
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
  startViewportWatch();

  // Load the user-editable voice header from the meta vault. Empty
  // string when the file is missing → buildSystemPrompt falls back
  // to the built-in default header.
  const customHeader = await loadMetaVoicePrompt();
  const systemPrompt = buildSystemPrompt(state, customHeader);
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
        stopViewportWatch();
        // Flip the mic-button source of truth off so it matches
        // reality. Critical for end_call / end-phrase paths where
        // the click handler never ran. Idempotent for manual ends
        // (endElevenLabsSession already set it).
        useStore.setState({ voiceMode: false });
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceCurrentTool(null);
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
          // Client-side belt-and-suspenders for end_call. If the
          // whole utterance matches one of a few unambiguous end
          // phrases, hang up without waiting for the agent's
          // judgment. Conservative whitelist — won't match
          // ambiguous "I'm done talking about it" style phrases.
          if (looksLikeEnd(text)) {
            void endElevenLabsSession();
          }
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
    store.reloadCurrent(contents);
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
    await gitCommitAll(vault, subject);
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
  // voiceMode is the source of truth for "is voice active". Set it
  // false here for both manual click-off and the looksLikeEnd /
  // end_call paths. onDisconnect also sets it (idempotent).
  useStore.setState({ voiceMode: false });
  if (!conv) return;
  try {
    await conv.endSession();
  } catch (e) {
    console.warn("[voice-eleven] end session failed:", e);
  }
  stopViewportWatch();
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
  useStore.getState().setVoiceConnecting(false);
  useStore.getState().setVoiceCurrentTool(null);
}

// Resolves when the voice agent's `voiceSpeaking` state flips to false,
// or after a safety timeout. Used by ScrollTo to align viewport
// movement with the end of the current audio segment so the user
// doesn't see the next page mid-sentence about the previous one.
function waitForSpeakingEnd(timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const unsub = useStore.subscribe((state) => {
      if (done) return;
      if (!state.voiceSpeaking) {
        done = true;
        unsub();
        resolve();
      }
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      unsub();
      resolve();
    }, timeoutMs);
  });
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
export const DEFAULT_VOICE_PROMPT_HEADER = `You are vault-chat speaking to the user via voice. Your output is converted to audio in real time.

Speech rules:
- Conversational. Short answers. Like talking to a friend.
- No markdown formatting (no asterisks, no headers, no bullets, no code fences). Plain prose.
- No emoji.
- If asked to read content, call Read (or fall back to Glob/Grep) and speak it naturally — your text becomes audio.`;

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

function buildSystemPrompt(
  state: ReturnType<typeof useStore.getState>,
  customHeader: string,
): string {
  const vault = state.vaultPath ?? "(no vault)";
  const recentHistory = formatRecentHistory(state.messages, 8);
  const followNote = state.followAlong
    ? "Follow-along is on. The active document and viewport are in dynamic variables and will refresh via contextual updates as the user scrolls."
    : "Follow-along is off. The user is not asking about a specific document unless they name one.";
  const header = customHeader.trim() || DEFAULT_VOICE_PROMPT_HEADER;
  const vaultIndex = buildVaultIndex(state);
  return [
    header,
    "",
    `Vault root (absolute): ${vault}`,
    "",
    "Tool calling rules — CRITICAL:",
    "- Read, ListDir, Write, Edit, NotebookEdit, PdfExtract take ABSOLUTE paths. Construct them by joining the vault root with the relative file/folder name. Never pass bare filenames like 'study.md' — they will fail.",
    "- Glob takes a pattern relative to the vault root. To find study.md across the vault, call Glob with pattern '**/study.md'. To find any markdown, '**/*.md'. Voice-mode Glob is case-insensitive and includes directories — 'hw3.ipynb' matches 'HW3.ipynb', and '**/HW3' matches the HW3 folder. So you don't need to try multiple case variants.",
    "- Grep takes an optional path argument. Omit it to search the whole vault, or pass an absolute path under the vault root to scope the search.",
    "- Write creates or overwrites a file with full contents. Use plain markdown unless the path's extension implies otherwise. Don't write outside the vault root.",
    "- Edit replaces a unique string in an existing file. Prefer Edit over Write when changing a small region of a large file — safer than overwriting. Include enough surrounding context in old_string to make it unique, or pass replace_all=true.",
    "- NotebookEdit is the ONLY way to safely change a .ipynb file — never Write/Edit raw notebook JSON. Use action='append' to add text to the END of an existing cell (the common case: adding an observation, a note, one more line) — much safer than 'replace' since you don't retype the cell. Use 'replace' only when rewriting a cell wholesale. 'insert' adds a NEW cell at cell_index (-1 = end). 'delete' removes a cell. cell_index is 0-based.",
    "- PdfExtract is how you read PDFs. The Read tool won't work on .pdf files. Use the `pages` argument ('1', '1-5', '3,5,7') when the user is on a specific page or you only need a section.",
    "- You are MULTIMODAL in this session. When the user opens a PDF, the FULL document is attached to your context — every page, with text, equations, diagrams, and layout preserved. You can reason across pages, reference what came earlier, and anticipate what's ahead. When the user asks 'what do you see', 'describe this', or anything visual — answer from the document directly. Never say 'I can't see your screen' or 'I'm not multimodal'. The viewport text context tells you which page the user is currently looking at.",
    "- ScrollTo moves the user's viewport. Use it to drive read-along sessions: when the user says 'let's go through this lecture', 'read along with me', 'walk me through this', or 'next page' — call ScrollTo to advance the page they're seeing, then narrate from the new page. When they say 'go back to X', 'wait, the slide about Y' — find the right page and ScrollTo it. CRITICAL TIMING: ScrollTo's visual movement is automatically synced to the end of your current sentence — when you call it mid-utterance, the page change waits for your audio to finish before applying. This means: finish your thought about the current page, THEN call ScrollTo, THEN start narrating the new page. The user will see the page flip at the natural breath between sentences, not mid-word. Don't call ScrollTo multiple times in quick succession unless you're doing a deliberate flip-through that the user explicitly asked for ('show me titles of the next five slides'). For normal read-along, one ScrollTo per page, followed by your narration of that page. If they interrupt with a question, answer it in context, then offer to resume.",
    "- CreateNote saves a short reminder to the user's notes panel — use it when the user says 'remember', 'jot that down', 'add a note', etc. Keep notes brief.",
    "- ListNotes shows what the user has flagged. Use when they ask 'what did I save', 'what notes do I have', 'what's open', etc. Defaults to open notes.",
    "- ResolveNote marks an open note as resolved — call it when the user confirms a flagged item has been addressed.",
    "- If a read tool returns '(no matches)' or '(empty)', that's a real result, not a failure. Try a different pattern or path before giving up.",
    "- Before guessing or calling Glob, scan the 'Vault file index' below for a match — those are the real relative paths in this vault. Join with the vault root for the absolute path. Only fall back to Glob('**/<filename>') if the index is empty, truncated, or you genuinely can't find a match.",
    "- If Read errors with 'No such file' or similar, the path is wrong — DON'T give up. Call Glob with '**/<filename>' to locate it (e.g. Glob('**/transformer.ipynb')), then Read the absolute path Glob returns.",
    "- If a Read response ends with '…[truncated]' and you need more, call Read again with a narrower target (Glob a specific section) or use Grep to jump to the part you actually need. Don't pretend the truncated tail doesn't exist.",
    "- Call end_call to hang up the conversation when the user clearly wraps things up — phrases like 'we're done', 'thanks, bye', 'talk later', 'I'm good'. Don't end on ambiguous pauses.",
    "- If the user speaks while you're running a tool (especially Write or Grep), don't drop the task. Briefly acknowledge them — 'one sec, I'm writing that' / 'still searching, hang on' — then finish the tool call and address what they said. Only abandon the task if they explicitly tell you to stop or change direction.",
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
      return `ACTIVE pane document: ${activeFile}\nViewing page ${v.page} of ${total}\nPage content:\n${truncate(v.pageText, VIEWPORT_TEXT_CAP)}`;
    }
    if (v.visibleText) {
      const pct =
        v.scrollRatio !== undefined ? Math.round(v.scrollRatio * 100) : null;
      const loc = pct !== null ? ` (scrolled ~${pct}%)` : "";
      return `ACTIVE pane document: ${activeFile}${loc}\nVisible content:\n${truncate(v.visibleText, VIEWPORT_TEXT_CAP)}`;
    }
  }
  const fallback = (state.currentContent ?? "").trim();
  if (!fallback) {
    return `ACTIVE pane document: ${activeFile} (no text content available; call Read for contents)`;
  }
  return `ACTIVE pane document: ${activeFile}\nContent:\n${truncate(fallback, VIEWPORT_TEXT_CAP)}`;
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
                ...CLIENT_TOOL_DEFINITIONS.map((t) => ({
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
                // Built-in system tool — lets the agent hang up the
                // call when the user signals they're done ("bye",
                // "we're done for now", "thanks, that's all"). No
                // implementation needed on our side; ElevenLabs
                // closes the WebSocket and onDisconnect fires.
                { type: "system" as const, name: "end_call" },
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

// Render a one-line italic marker per tool — verb + target only,
// no JSON args, no result. Reads like a journal entry in the chat
// pane. The full result still goes to console.log for debugging.
function formatToolMarker(name: string, args: any): string {
  switch (name) {
    case "Read":
      return `*Read ${relPath(args.path ?? "")}*`;
    case "Write":
      return `*Wrote ${relPath(args.path ?? "")}*`;
    case "Edit":
      return `*Edited ${relPath(args.path ?? "")}*`;
    case "NotebookEdit": {
      const verb =
        args.action === "delete"
          ? "Deleted cell"
          : args.action === "insert"
            ? "Inserted cell"
            : args.action === "append"
              ? "Appended to cell"
              : "Edited cell";
      return `*${verb} ${args.cell_index ?? "?"} in ${relPath(args.path ?? "")}*`;
    }
    case "ListDir":
      return `*Listed ${relPath(args.path ?? "")}*`;
    case "Glob":
      return `*Searched files matching "${args.pattern ?? ""}"*`;
    case "Grep":
      return `*Searched "${args.pattern ?? ""}"*`;
    case "PdfExtract": {
      const pages = args.pages ? ` (pages ${args.pages})` : "";
      return `*Extracted ${relPath(args.path ?? "")}${pages}*`;
    }
    case "ScrollTo": {
      const where = typeof args.page === "number" ? `page ${args.page}` : (args.anchor ?? "?");
      return `*Scrolled to ${where}*`;
    }
    case "ListNotes":
      return `*Listed ${args.status ?? "open"} notes*`;
    case "ResolveNote":
      return `*Resolved note ${args.id ?? ""}*`;
    case "CreateNote": {
      const text = (args.text ?? "").trim();
      const snip = text.length > 50 ? text.slice(0, 47) + "…" : text;
      return `*Saved note "${snip}"*`;
    }
    default:
      return `*${name}*`;
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

function buildClientToolHandlers(): Record<
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
        // If the agent is mid-sentence, defer the actual viewport
        // movement until TTS finishes. Otherwise the LLM emits the
        // tool call faster than the audio drains, and the user sees
        // the next page while still hearing about the previous one.
        // With expects_response: true on this tool, ElevenLabs holds
        // the agent's next utterance until we return — so the natural
        // pause-then-scroll-then-narrate cadence falls out for free.
        if (useStore.getState().voiceSpeaking) {
          await waitForSpeakingEnd();
        }
        useStore.getState().requestScrollAnchor(targetPath, anchor);
        return `Scrolled to ${anchor} in ${targetPath}`;
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
  };
}
