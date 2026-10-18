import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { localPathFromUrl } from "./mdPipeline";
import { planDone, planIndex } from "./planPlace";
import { Plus, Square, ArrowUp, ChevronDown, ChevronUp, Wrench, X, MessageSquare, Mic, Paperclip, Scan, AtSign } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePending, type PendingKind } from "./pendingInput";
import { voiceImageMime } from "./voiceImages";
import { fileKind } from "./fileKind";
import { invoke } from "@tauri-apps/api/core";
import { dispatchChatAction, isPopout } from "./sync";
import { COMPACT_THRESHOLD, COMPACTION_DIVIDER_TEXT, windowFor, isCompactionDivider, dividerSummary } from "./chatContext";
import { useStore, type ChatMessage, type FileEntry, type LiveTool, type TodoItem } from "./store";
import { buildViewportContextText, toggleVoice } from "./voice-elevenlabs";
import { InlineVoiceWaves } from "./VoiceCockpit";
import { findModel, AUTO_MODEL_ID } from "./providers";
import { loadSkills } from "./skills";
import { isUnreadableAsText } from "./fileKind";
import { SettingsPane } from "./SettingsPane";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";
import { BOX_UNREACHABLE, boxAnswer, boxChatOn, boxSubagent } from "./boxChat";
import {
  AskOptions,
  ReplyCost,
  Subagents,
  Thought,
  VerdictLine,
  chosenAnswer,
  isLegacySubagentRecord,
  subagentsOfMessage,
  withoutOptionList,
  type SubagentRec,
} from "./chatExtras";
import { uiChoice } from "./uiChoices";
import { formatCost } from "./ongoingWork";
import { OngoingLine } from "./OngoingLine";
import { isArchivedThread, ARCHIVED_THREAD } from "./conversations";

type MentionHit = { path: string; name: string; rel: string };
const NO_SUBAGENTS: SubagentRec[] = [];

// Markdown (math, tables, code, safe HTML, URLs) renders through the shared
// pipeline (Markdown.tsx / mdPipeline.ts): data:image URLs and Windows
// absolute paths pass its URL check, so ChatImage can load them.

// Render images in chat bubbles the same way MarkdownView does for
// vault files: data:/blob:/http(s) URLs go straight to the DOM; file
// paths get read off disk and turned into blob URLs so the Tauri
// webview can actually display them (file:// is blocked). Relative
// paths are resolved against the active vault root, so an agent reply
// like `![chart](./assets/forecast.png)` or `![cap](.vault-chat/
// captures/foo.png)` renders. Without this override, react-markdown
// handed the raw src to the DOM and the image silently failed to load.
const ChatImage = memo(function ChatImage({
  src,
  alt,
  ...rest
}: ComponentPropsWithoutRef<"img">) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const [url, setUrl] = useState<string | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!src) return;
    setFailedPath(null);
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setUrl(src);
      return;
    }
    const cleaned = localPathFromUrl(src);
    const isAbs = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned);
    if (!isAbs && !vaultPath) return;
    const sep = (vaultPath ?? "").includes("\\") ? "\\" : "/";
    const primary = isAbs
      ? cleaned
      : `${vaultPath}${sep}${cleaned.replace(/^\.\/+/, "")}`;

    // Fallback candidates for relative paths whose direct resolution
    // misses. The common shape: the agent ran a script in a subdir of
    // the vault, then emitted `![alt](output.png)` — relative to its
    // cwd, not the vault root. Search the vault file index by basename
    // and try those locations too. Cheap (single linear scan of an
    // already-cached list) and bounded (we take at most a few hits).
    const candidates: string[] = [primary];
    if (!isAbs) {
      const basename = cleaned.replace(/^\.\/+/, "").split(/[\\/]/).pop() ?? "";
      if (basename) {
        const hits = files
          .filter((f) => !f.is_dir && f.name === basename)
          .slice(0, 5)
          .map((f) => f.path);
        for (const h of hits) {
          if (!candidates.includes(h)) candidates.push(h);
        }
      }
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      for (const path of candidates) {
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path });
          if (cancelled) return;
          const dot = path.lastIndexOf(".");
          const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
          const mime =
            ext === "svg"
              ? "image/svg+xml"
              : ext === "jpg" || ext === "jpeg"
                ? "image/jpeg"
                : ext === "png"
                  ? "image/png"
                  : ext === "gif"
                    ? "image/gif"
                    : ext === "webp"
                      ? "image/webp"
                      : ext === "bmp"
                        ? "image/bmp"
                        : ext === "ico"
                          ? "image/x-icon"
                          : `image/${ext || "png"}`;
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
          return;
        } catch {
          // try next candidate
        }
      }
      if (!cancelled) {
        console.warn("[chat] image load failed:", primary);
        setFailedPath(primary);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, vaultPath, files]);

  if (!url) {
    // Honest fallback: make it obvious this is a failed image load, not
    // intentional bracket text. The old `[alt]` rendering was visually
    // indistinguishable from a literal markdown footnote/reference and
    // gave no signal that anything went wrong.
    return (
      <span className="text-muted-foreground italic text-[11.5px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block">
        ⚠ image not found: {failedPath ?? src}
        {alt ? ` (${alt})` : ""}
      </span>
    );
  }
  return <img src={url} alt={alt} {...rest} />;
});

const chatComponents = { img: ChatImage } as const;

// Persist a chat-pane capture's PNG bytes to disk so the agent can
// reference it from tools like `Write` (e.g. building a markdown file
// that embeds the screenshot). Returns the vault-relative path on
// success, or null on any failure — capture data URLs already render
// in the bubble regardless, so a write failure is non-fatal.
//
// Files land in `<vault>/.vault-chat/captures/`; an app-start sweep
// prunes anything older than CAPTURE_RETENTION_HOURS, so we don't
// retain user data past the active session.
async function saveCaptureToDisk(
  vault: string,
  imageDataUrl: string,
): Promise<string | null> {
  try {
    const m = imageDataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : m[1].toLowerCase();
    const b64 = m[2];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Timestamp + short random suffix so two near-simultaneous
    // captures never collide before write_binary_file_unique's
    // " (1)" rename kicks in.
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/T/, "_")
      .slice(0, 19);
    const suffix = Math.random().toString(36).slice(2, 7);
    const name = `capture-${ts}-${suffix}.${ext}`;
    const dir = `${vault}/.vault-chat/captures`;
    const absPath = await invoke<string>("write_binary_file_unique", {
      dir,
      name,
      bytes: Array.from(bytes),
    });
    if (absPath.startsWith(vault + "/")) {
      return absPath.slice(vault.length + 1);
    }
    return absPath;
  } catch (e) {
    console.warn("[capture] disk save failed:", e);
    return null;
  }
}

// Fuzzy-ish file picker for @mentions. Query matches against file name
// first (startsWith > contains), then against the relative path as a
// fallback. Folders are excluded — attaching a whole folder isn't a
// well-defined action (use grep / list instead via the agent).
function filterFilesForMention(
  files: FileEntry[],
  vaultPath: string | null,
  query: string,
): MentionHit[] {
  if (!vaultPath) return [];
  const q = query.toLowerCase();
  const hits: Array<MentionHit & { score: number }> = [];
  for (const f of files) {
    // Folders are selectable now so the agent can ListDir/Glob into
    // them — they land as path-only mentions.
    if (f.hidden) continue;
    const rel = f.path.startsWith(vaultPath + "/")
      ? f.path.slice(vaultPath.length + 1)
      : f.path;
    const nameLower = f.name.toLowerCase();
    const relLower = rel.toLowerCase();
    let score: number;
    if (!q) score = 10;
    // Tiers first (name prefix > name contains > path contains), closeness
    // within a tier — the old flat scores let a long prefix match sink below
    // a contains match, and a late contains match below a path match.
    else if (nameLower.startsWith(q)) score = 3000 - Math.min(999, nameLower.length - q.length);
    else if (nameLower.includes(q)) score = 2000 - Math.min(999, nameLower.indexOf(q));
    else if (relLower.includes(q)) score = 1000 - Math.min(999, relLower.indexOf(q));
    else continue;
    hits.push({ path: f.path, name: f.name, rel, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.map(({ score: _s, ...h }) => h);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a context preamble out of attached mentions. Returns an empty
// string when there's nothing to attach. Unreadable-as-text files
// (images, pdfs, unsupported) are listed by path only so the agent knows
// to fetch them explicitly via Read / PdfExtract.
async function buildMentionPreamble(
  mentions: Array<{ rel: string; path: string; isDir?: boolean }>,
): Promise<string> {
  if (mentions.length === 0) return "";
  const blocks: string[] = [];
  for (const { rel, path, isDir } of mentions) {
    if (isDir) {
      blocks.push(
        `@${rel}/ — absolute path: ${path} (directory — use ListDir/Glob/Grep to inspect contents)`,
      );
      continue;
    }
    if (isUnreadableAsText(path)) {
      const ext = (path.split(".").pop() ?? "").toLowerCase();
      blocks.push(`@${rel} — absolute path: ${path} (binary ${ext}, contents not inlined)`);
      continue;
    }
    try {
      const content = await invoke<string>("read_text_file", { path });
      blocks.push(`@${rel} — absolute path: ${path}\n\n${content}`);
    } catch (err) {
      blocks.push(`@${rel} — absolute path: ${path} (read failed: ${String(err)})`);
    }
  }
  const preamble = [
    "FILE ATTACHMENTS",
    "The user attached the following files with @-mentions. The absolute paths below are the ground truth — you already know where each file is. DO NOT run Glob, Grep, or any other tool to search for these files. If the user's question can be answered from the path or the inlined content, answer directly.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
  // Names only: the app log captures console.info, and it never holds a file's contents.
  console.info(`[@ref] attaching ${mentions.length} file(s): ${mentions.map((m) => m.rel).join(", ")}`.slice(0, 300));
  return preamble;
}

export function ChatPane() {
  // Per-field selectors so the pane only re-renders when the field it
  // actually reads changes. Destructuring the whole store was causing
  // every keystroke to rebuild the entire message list because the
  // agent's streamingText/liveTools updates were waking this component
  // 60+ times per second.
  const vaultPath = useStore((s) => s.vaultPath);
  const messages = useStore((s) => s.messages);
  const apiKeys = useStore((s) => s.apiKeys);
  const modelId = useStore((s) => s.modelId);
  const skills = useStore((s) => s.skills);
  const busy = useStore((s) => s.busy);
  const showSettings = useStore((s) => s.showSettings);
  const lastContext = useStore((s) => s.lastContext);
  // Re-read the window when the catalog (re)loads — it carries the windows.
  const catalog = useStore((s) => s.catalog);
  const boxWindow = useStore((s) => (s.boxChat?.on ? s.conversations.find((c) => c.id === s.activeConversationId)?.contextWindow : undefined));
  // Box mode: the box's model window (reported with its usage), not the laptop's pick.
  const ctxWindow = useMemo(() => (boxWindow ? { tokens: boxWindow, known: true } : windowFor(modelId)), [modelId, catalog, boxWindow]);
  const compacting = useStore((s) => s.compacting);
  const setSkills = useStore((s) => s.setSkills);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const streamingText = useStore((s) => s.streamingText);
  const streamingReasoning = useStore((s) => s.streamingReasoning);
  const liveTools = useStore((s) => s.liveTools);
  const agentTodos = useStore((s) => s.agentTodos);
  const files = useStore((s) => s.files);
  const currentFile = useStore((s) => s.currentFile);
  const panes = useStore((s) => s.panes);
  const chatPaneLastCapture = useStore((s) => s.chatPaneLastCapture);
  const setChatPaneLastCapture = useStore((s) => s.setChatPaneLastCapture);
  const setChatPaneCapturePending = useStore((s) => s.setChatPaneCapturePending);
  // Hooks for the saved-chats popover. Must live above the early
  // `showSettings`/`!activeKey` returns below — React's Rules of Hooks
  // require the same hook-call order on every render, and putting these
  // after the returns means they get skipped when settings is open then
  // run when it closes (React error #310).
  const setShowChatsPanel = useStore((s) => s.setShowChatsPanel);
  const showChatsPanel = useStore((s) => s.showChatsPanel);
  const conversations = useStore((s) => s.conversations);
  const activeConversationId = useStore((s) => s.activeConversationId);
  // Indicator is for chats you *can't see* — alerts that a background
  // conversation is still running. Suppressed on the active chat since
  // the user is already watching it.
  const offscreenChats = conversations.filter((c) => c.id !== activeConversationId);
  // Aggregate state of the chats you can't see: "running" (something is still
  // thinking) takes priority, else "unseen" (a background chat finished and you
  // haven't looked). Mirrors the per-row dot so the collapsed Chats button
  // distinguishes generating from done-but-unseen.
  const indicatorKind: "running" | "unseen" | null = offscreenChats.some(
    (c) => c.status === "running",
  )
    ? "running"
    : offscreenChats.some((c) => c.unread)
      ? "unseen"
      : null;
  // Fullscreen chat shows the chats as its left sidebar (FullscreenChat.tsx),
  // so the button opens and closes that; the docked layout keeps the overlay.
  // The popout window is the fullscreen chat.
  const chatFullscreen = useStore((s) => isPopout || (s.chatFullscreen && !s.popoutOpen));
  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const chatsShown = chatFullscreen ? chatSidebarOpen : showChatsPanel;
  // Fullscreen chat: voice replaces the composer with its waves (VoiceCockpit).
  const voiceMode = useStore((s) => s.voiceMode);
  const voiceError = useStore((s) => s.voiceError);
  // The empty chat's greeting, like the phone's — one per conversation.
  const greeting = useMemo(() => {
    const g = ["Welcome back!", "He returns!", "Ready to work?", "Welcome, sir.", "At your service."];
    return g[Math.floor(Math.random() * g.length)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);
  const voiceBar = false; // fullscreen voice lives in the bottom strip (VoiceStrip); the composer stays
  const [plusOpen, setPlusOpen] = useState(false);
  const toggleChatsPanel = () =>
    chatFullscreen ? useStore.getState().toggleChatSidebar() : setShowChatsPanel(!showChatsPanel);
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  // Messages sent while the agent works, until delivered (pendingInput.ts).
  const localPending = usePending(activeConversationId);
  // What the thread shows beside the text (chatExtras.tsx; uiChoices.ts picks
  // where each goes while Carl decides). Stable props, so the bubbles' memo
  // holds while a reply streams.
  const subagents = activeConv?.subagents ?? NO_SUBAGENTS;
  const subagentsInline = uiChoice("subagents") === "inline";
  const spawnsAt = useMemo(
    () => messages.map((m) => {
      const r = subagentsOfMessage(m, subagents);
      return r.length ? r : undefined;
    }),
    [messages, subagents],
  );
  // The strip shows the newest spawn (one `subagent` call's children).
  const latestSpawn = useMemo(() => {
    const last = subagents[subagents.length - 1];
    return last ? subagents.filter((x) => (x.toolCallId ?? "") === (last.toolCallId ?? "")) : NO_SUBAGENTS;
  }, [subagents]);
  const unplacedSubagents = useMemo(() => {
    const placed = new Set(spawnsAt.flatMap((r) => (r ?? []).map((x) => x.threadId)));
    return subagents.filter((x) => !placed.has(x.threadId));
  }, [spawnsAt, subagents]);
  const answerAsk = useCallback((answer: string) => {
    const id = useStore.getState().activeConversationId;
    if (boxChatOn() && id) void boxAnswer(id, answer);
    else dispatchChatAction({ kind: "send", text: answer });
  }, []);
  const controlSubagent = useCallback((sid: string, op: "steer" | "stop", text?: string) => {
    const id = useStore.getState().activeConversationId;
    return id ? boxSubagent(id, sid, op, text) : Promise.resolve<string | null>("No conversation.");
  }, []);
  const [pendingImages, setPendingImages] = useState<
    Array<{
      imageDataUrl: string;
      sourcePath?: string;
      sourceAnchor?: string | null;
      capturedFilePath?: string;
    }>
  >([]);
  useEffect(() => {
    if (!chatPaneLastCapture) return;
    const cap = chatPaneLastCapture;
    setChatPaneLastCapture(null);
    // Append immediately with the data URL so the thumbnail is instant;
    // disk save runs async and patches the entry with capturedFilePath
    // when ready. Sending before the patch lands is fine — the agent
    // still sees the image via the data URL, just without a path
    // reference for tool calls.
    setPendingImages((prev) => [
      ...prev,
      {
        imageDataUrl: cap.imageDataUrl,
        sourcePath: cap.sourcePath,
        sourceAnchor: cap.sourceAnchor,
      },
    ]);
    if (vaultPath) {
      void saveCaptureToDisk(vaultPath, cap.imageDataUrl).then((rel) => {
        if (!rel) return;
        setPendingImages((prev) =>
          prev.map((img) =>
            img.imageDataUrl === cap.imageDataUrl && !img.capturedFilePath
              ? { ...img, capturedFilePath: rel }
              : img,
          ),
        );
      });
    }
  }, [chatPaneLastCapture, setChatPaneLastCapture, vaultPath]);
  const [input, setInput] = useState("");
  // Skill menu opens on a /word-boundary token at the caret — same
  // shape as fileMention so it can appear mid-message, not just at
  // input start. start is the index of the "/".
  const [skillMention, setSkillMention] = useState<{ query: string; start: number } | null>(null);
  const [skillMentionIdx, setSkillMentionIdx] = useState(0);
  const [fileMention, setFileMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMentionIdx, setFileMentionIdx] = useState(0);
  // Mentions live outside the textarea once picked: chips above the
  // input own them. Each entry remembers the original "@query" raw
  // text so backspacing on empty input can restore it for edits.
  const [mentions, setMentions] = useState<
    Array<{ rel: string; path: string; name: string; raw: string }>
  >([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Track whether the user is pinned near the bottom. If they scroll up
  // mid-stream, stop auto-scrolling so they can read older messages in
  // peace. Re-pins automatically when they scroll back to the bottom.
  const pinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const activeSpec = findModel(modelId);
  // Auto mode is "active" if any provider has a key — routing picks
  // the right one at send-time. Without this, `activeKey` is undefined
  // for the "auto" sentinel and the chat pane shows "Set up a provider".
  const activeKey =
    modelId === AUTO_MODEL_ID
      ? Object.values(apiKeys).find(Boolean)
      : activeSpec
        ? apiKeys[activeSpec.provider]
        : undefined;
  // [phase 2] Box mode: the agent runs on the box — no laptop key needed, and
  // the composer is off (with the reason) while the box can't be reached.
  const boxChat = useStore((s) => s.boxChat);
  const boxDown = !!boxChat?.on && boxChat.reachable === false;
  const archived = !!activeConv && isArchivedThread(activeConv);
  const ready = Boolean(vaultPath && (activeKey || boxChat?.on)) && !boxDown && !archived;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      // streamingText flushes ~5 Hz. Smooth-scrolling on top of every
      // flush stacks animations and fights the layout grow, which reads
      // as stutter. Snap instantly during stream — the eye sees a
      // smooth flow because tokens land in quick succession.
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, liveTools]);

  // The thread's box shrinks when something appears above the composer (the
  // pinned plan, the subagent strip): stay at the bottom if we were there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the user sends a new message, re-pin so their own turn scrolls
  // into view even if they had scrolled away during the previous stream.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [messages.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    pinnedToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom && (busy || streamingText.length > 0));
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    if (vaultPath) {
      loadSkills(vaultPath).then(setSkills).catch(() => setSkills([]));
    } else {
      setSkills([]);
    }
  }, [vaultPath, setSkills]);

  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("vc-focus-composer", onFocus);
    return () => window.removeEventListener("vc-focus-composer", onFocus);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Reset to the natural `rows={1}` height first. When the input is
    // empty we stop here — measuring scrollHeight on an empty textarea
    // before layout settles can return a stale value (the previous
    // height of the element), which made the box render unnaturally
    // tall on mount and reset on first keystroke. Only grow when there
    // is actual content to fit.
    el.style.height = "auto";
    if (input.length === 0) return;
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  if (showSettings) return <SettingsPane />;

  if (!activeKey && !boxChat?.on) {
    return (
      <div className="h-full flex flex-col bg-card border-l border-border">
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="max-w-[280px] text-center space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-[14px] font-semibold">Set up a provider</h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                Paste an API key to start. Claude, GPT, or Gemini — swap any time.
              </p>
            </div>
            <Button onClick={() => setShowSettings(true)} className="w-full">
              Open settings
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const todos: TodoItem[] = activeConv?.todos?.length ? activeConv.todos : agentTodos;
  const planInline = todos.length > 0 && uiChoice("todos") === "inline";
  const planAt = planInline ? planIndex(messages, busy) : -1;
  const verdict = activeConv?.state === "done" ? activeConv.verdict : undefined;
  const totalCost = uiChoice("cost") === "total" ? formatCost(activeConv?.costUsd ?? messages.reduce((n, m) => n + (m.costUsd ?? m.usage?.costUsd ?? 0), 0)) : undefined;
  let lastVisible = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i]!.hidden && !messages[i]!.system) { lastVisible = i; break; }

  // While the agent works the composer stays open: Enter steers the running
  // turn (at its next step), Tab queues a follow-up for after it, Esc stops
  // (pendingInput.ts; chips above the composer until delivered).
  const send = async (mid?: PendingKind) => {
    if (!ready) return;
    const text = input.trim();
    if (!text && pendingImages.length === 0) return;
    const actionKind: "send" | PendingKind = busy ? mid ?? "steer" : "send";
    // Resolve every @name token in the text — not just the ones picked
    // from the dropdown. Users type @name manually all the time, and
    // without resolution the agent just sees a literal "@foo.md" and
    // has to go hunting for the file. Start from the already-tracked
    // mentions (which carry the exact picked path for disambiguation)
    // and backfill anything else by basename match against the files
    // list.
    const tokens = Array.from(text.matchAll(/(?:^|\s)@([\w][\w./-]*)/g)).map((m) => m[1]);
    const byPath = new Map<string, { rel: string; path: string; isDir?: boolean }>();
    for (const m of mentions) {
      const f = files.find((f) => f.path === m.path);
      byPath.set(m.path, { rel: m.rel, path: m.path, isDir: f?.is_dir ?? false });
    }
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (mentions.some((m) => m.name.toLowerCase() === lower)) continue;
      // Case-insensitive basename match — users type however they type.
      const hits = files.filter((f) => !f.hidden && f.name.toLowerCase() === lower);
      if (hits.length === 0) {
        console.warn(`[@ref] no vault entry matched "${tok}" — agent will see only the literal token`);
      }
      for (const h of hits) {
        if (!byPath.has(h.path)) {
          const rel = vaultPath && h.path.startsWith(vaultPath + "/")
            ? h.path.slice(vaultPath.length + 1)
            : h.path;
          byPath.set(h.path, { rel, path: h.path, isDir: h.is_dir });
        }
      }
    }
    const resolved = Array.from(byPath.values());
    const mentionPreamble = await buildMentionPreamble(resolved);
    const viewportCtx = buildViewportContextText(useStore.getState());
    const contextPreamble = [mentionPreamble, viewportCtx].filter(Boolean).join("\n\n---\n\n");
    // Belt-and-suspenders: append the resolved paths as a footer on
    // the user turn too. Hidden preamble alone wasn't enough — some
    // models re-search with Glob even when the path is in context.
    // Footer is stripped from the bubble render below.
    const pathFooter =
      resolved.length > 0
        ? `\n\n[attached: ${resolved.map((r) => `@${r.rel.split("/").pop()} → ${r.path}`).join(", ")}]`
        : "";
    const imagesToSend = pendingImages;
    setInput("");
    setMentions([]);
    setSkillMention(null);
    setFileMention(null);
    setPendingImages([]);
    dispatchChatAction({
      kind: actionKind,
      text: text + pathFooter,
      contextPreamble: contextPreamble || undefined,
      attachments: imagesToSend.length > 0 ? imagesToSend : undefined,
    });
  };

  const stop = () => dispatchChatAction({ kind: "stop" });

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Snapshot items synchronously — clipboardData is invalidated as
    // soon as the handler returns, so we can't read items inside
    // FileReader callbacks. Collect blobs first, then promote them
    // to data URLs and batch-append in one setState to avoid losing
    // a paste-then-Enter race (if the user hits send before all
    // readers fire, only the resolved ones land).
    const blobs: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) blobs.push(file);
    }
    if (blobs.length === 0) return;
    e.preventDefault();
    Promise.all(
      blobs.map(
        (b) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(b);
          }),
      ),
    ).then((urls) => {
      const additions = urls.filter(Boolean).map((u) => ({ imageDataUrl: u }));
      if (additions.length > 0) setPendingImages((prev) => [...prev, ...additions]);
    });
  };
  const onSelectModel = (id: string) => dispatchChatAction({ kind: "setModel", id });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMention && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillMentionIdx((i) => Math.min(i + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const hit = filteredSkills[skillMentionIdx] ?? filteredSkills[0];
        pickSkill(hit.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSkillMention(null);
        return;
      }
    }
    if (fileMention && matchedFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.min(i + 1, matchedFiles.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const hit = matchedFiles[fileMentionIdx] ?? matchedFiles[0];
        pickMention(hit);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Never fire mid-IME-composition (e.g. CJK candidate selection) — the
      // Enter that commits a composition must not send the message.
      if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
      e.preventDefault();
      void send(busy ? "steer" : undefined);
      return;
    }
    if (busy && e.key === "Tab" && !e.shiftKey && (input.trim() || pendingImages.length > 0)) {
      e.preventDefault();
      void send("queue");
      return;
    }
    if (busy && e.key === "Escape") {
      e.preventDefault();
      stop();
    }
  };
  // Pending chips: this machine's (local mode, or a box message in flight) and
  // what the box's log holds as pending for this conversation (a steer or a
  // queued message pi has not delivered yet).
  const boxQueued = activeConv?.queued ?? [];
  const onBox = new Set(boxQueued.map((q) => q.id));
  const chips = [
    ...localPending.filter((p) => !(p.qid && onBox.has(p.qid))).map((p) => ({ id: p.id, kind: p.kind, text: p.text, sending: !!p.sending })),
    ...boxQueued.map((q) => ({ id: `box:${activeConv!.id}:${q.id}`, kind: (q.kind ?? "queue") as PendingKind, text: q.text, sending: false })),
  ];
  const editChip = (c: { id: string; text: string }) => {
    dispatchChatAction({ kind: "unqueue", id: c.id });
    setInput((prev) => (prev.trim() ? `${c.text}\n${prev}` : c.text));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onInputChange = (v: string) => {
    setInput(v);
    const caret = inputRef.current?.selectionStart ?? v.length;
    const upToCaret = v.slice(0, caret);

    // /skill tokens at caret — same shape as @mentions so skills can
    // be invoked anywhere in the message, not only at input start.
    const slashMatch = upToCaret.match(/(^|\s)\/([\w-]*)$/);
    if (slashMatch) {
      setSkillMention({
        query: slashMatch[2],
        start: caret - slashMatch[2].length - 1,
      });
      setSkillMentionIdx(0);
    } else {
      setSkillMention(null);
    }

    // @file tokens at caret.
    const atMatch = upToCaret.match(/(^|\s)@([^\s]*)$/);
    if (atMatch) {
      setFileMention({
        query: atMatch[2],
        start: caret - atMatch[2].length - 1,
      });
      setFileMentionIdx(0);
    } else {
      setFileMention(null);
    }

    // Drop any tracked mention whose @name no longer appears in the
    // text — the user deleted it inline. Lookahead-based terminator so
    // "@foo.pdf?" / "@foo.md," still count as a mention.
    setMentions((prev) =>
      prev.filter((m) =>
        new RegExp(`(^|\\s)@${escapeRegExp(m.name)}(?![\\w./-])`).test(v),
      ),
    );
  };

  const pickSkill = (name: string) => {
    if (!skillMention) {
      // Fallback: no caret ref (programmatic invoke). Insert at end.
      const next = input.length ? `${input.replace(/\s+$/, "")} /${name} ` : `/${name} `;
      setInput(next);
      setSkillMention(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const before = input.slice(0, skillMention.start);
    const after = input.slice(skillMention.start + 1 + skillMention.query.length);
    const insertion = `/${name} `;
    const next = `${before}${insertion}${after.replace(/^\s+/, "")}`;
    setInput(next);
    setSkillMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length + insertion.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const filteredSkills = skillMention
    ? skills.filter((s) => s.name.startsWith(skillMention.query))
    : [];

  const matchedFiles = fileMention
    ? filterFilesForMention(files, vaultPath, fileMention.query).slice(0, 8)
    : [];

  const pickMention = (hit: MentionHit) => {
    if (!fileMention) return;
    const before = input.slice(0, fileMention.start);
    const after = input.slice(fileMention.start + 1 + fileMention.query.length);
    // Keep the @name inline in the textarea — no chip. The mentions
    // array still tracks the exact path so send() can resolve basenames
    // to their source even when two files share a name.
    const insertion = `@${hit.name} `;
    const next = `${before}${insertion}${after.replace(/^\s+/, "")}`;
    setInput(next);
    setMentions((prev) => {
      if (prev.some((m) => m.path === hit.path)) return prev;
      return [...prev, { rel: hit.rel, path: hit.path, name: hit.name, raw: `@${hit.name}` }];
    });
    setFileMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length + insertion.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  // Fullscreen's + menu. Every path the composer already has, in one place:
  // files from disk (images as attachments, the rest as @-references), a
  // region of the open file (the marquee — over the chat, since fullscreen has
  // no viewer), and the @ picker for vault files.
  const capturable = (() => {
    const paths: string[] = [];
    if (currentFile) paths.push(currentFile);
    for (const p of panes) if (p.file) paths.push(p.file);
    return paths.some((p) => {
      const k = fileKind(p).kind;
      return k === "pdf" || k === "html" || k === "image";
    });
  })();
  const addFiles = async () => {
    setPlusOpen(false);
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({ multiple: true, directory: false, defaultPath: vaultPath ?? undefined });
    } catch (e) {
      console.warn("[attach] file dialog failed:", e);
      return;
    }
    const paths = (picked == null ? [] : Array.isArray(picked) ? picked : [picked]).map((p) => p.replace(/\\/g, "/"));
    const refs: Array<{ rel: string; path: string; name: string; raw: string }> = [];
    for (const path of paths) {
      const name = path.split("/").pop() ?? path;
      const mime = voiceImageMime(path);
      if (mime) {
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path });
          const url = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => rej(r.error);
            r.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mime }));
          });
          setPendingImages((prev) => [...prev, { imageDataUrl: url, sourcePath: path }]);
          continue;
        } catch (e) {
          console.warn("[attach] image read failed:", e);
        }
      }
      const rel = vaultPath && path.startsWith(vaultPath + "/") ? path.slice(vaultPath.length + 1) : path;
      refs.push({ rel, path, name, raw: `@${name}` });
    }
    if (refs.length) {
      setMentions((prev) => [...prev, ...refs.filter((r) => !prev.some((m) => m.path === r.path))]);
      setInput((prev) => `${prev}${prev && !/\s$/.test(prev) ? " " : ""}${refs.map((r) => r.raw).join(" ")} `);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const captureRegion = () => {
    setPlusOpen(false);
    if (!capturable) return;
    const s = useStore.getState();
    s.setEditPromptCapturePending(false);
    s.setNoteCapturePending(false);
    s.setVoiceCapturePending(false);
    // Popout: the main window runs the marquee and bounces the image back.
    if (isPopout) {
      dispatchChatAction({ kind: "startCapture" });
      return;
    }
    setChatPaneCapturePending(true);
    // Fullscreen has no viewer: App.tsx shows the open file over the chat and
    // starts the marquee there. Otherwise the marquee runs on the viewer.
    window.dispatchEvent(new CustomEvent(chatFullscreen ? "vc-fullscreen-capture" : "vc-marquee-toggle"));
  };
  const mentionVaultFile = () => {
    setPlusOpen(false);
    const el = inputRef.current;
    const v = `${input}${input && !/\s$/.test(input) ? " " : ""}@`;
    if (el) {
      el.value = v;
      el.setSelectionRange(v.length, v.length);
      el.focus();
    }
    onInputChange(v);
  };

  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative">
      {/* Projects are set in the chats panel (a row's folder action), not here. */}
      {totalCost && (
        <div className="shrink-0 px-3 pt-2">
          <div className="max-w-[820px] mx-auto flex items-center">
            {totalCost && (
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" data-el="total-cost" title="What this conversation has cost so far">
                {totalCost}
              </span>
            )}
          </div>
        </div>
      )}
      <div
        className="flex-1 min-h-0 overflow-auto px-3 py-4 pb-8 relative"
        ref={scrollRef}
        onScroll={onScroll}
      >
        <div className="max-w-[820px] mx-auto space-y-4">
        {messages.length === 0 && !streamingText && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" data-el="greeting">
            <p className="text-[22px] font-semibold text-foreground/90">{greeting}</p>
          </div>
        )}

        {messages.map((m, i) =>
          m.hidden ? null : (
            <Fragment key={i}>
              <MessageBubble
                message={m}
                askLive={!!m.askOptions?.length && i === lastVisible && !busy}
                askChosen={m.askOptions?.length ? chosenAnswer(messages, i) : undefined}
                onAsk={answerAsk}
                spawns={subagentsInline ? spawnsAt[i] : undefined}
                onSubagent={controlSubagent}
              />
              {/* The plan sits with the turn that last wrote it (planPlace.ts). */}
              {planInline && i === planAt && <AgentTodoList todos={todos} />}
            </Fragment>
          ),
        )}

        {subagentsInline && unplacedSubagents.length > 0 && <Subagents list={unplacedSubagents} variant="inline" onControl={controlSubagent} />}

        {compacting && (
          <div className="flex items-center justify-center gap-2 py-2 text-[11.5px] text-muted-foreground">
            <span>Compacting conversation…</span>
          </div>
        )}

        {planInline && planAt < 0 && <AgentTodoList todos={todos} />}

        {verdict && uiChoice("verdict") === "thread" && <VerdictLine verdict={verdict} />}

        {/* Running, nothing streamed yet: the model is thinking without showing it
            (OpenAI-family reasoning via OpenRouter streams none). Gone at the first
            text, thinking or tool line. */}

        {(streamingText || streamingReasoning || liveTools.length > 0) && (
          <div className="space-y-2">
            {liveTools.length > 0 && <LiveToolTicker tools={liveTools} />}
            {streamingReasoning && !streamingText && (
              <ReasoningStream text={streamingReasoning} />
            )}
            {streamingText && (
              <div className="prose-chat text-foreground/95" data-el="stream">
                {/* Finished blocks render once each with the full
                    pipeline; only the open tail re-renders per flush
                    (re-rendering the whole growing reply every flush
                    was O(N²) and locked the main thread). */}
                <StreamingMarkdown text={streamingText} components={chatComponents} />
              </div>
            )}
          </div>
        )}

        {busy && (
          <ThinkingIndicator
            silent={!compacting && !streamingText && !streamingReasoning && liveTools.length === 0}
            activeTool={liveTools.find((t) => !t.result)?.name}
            streaming={!!streamingText}
            reasoning={!!streamingReasoning && !streamingText}
            liveChars={
              streamingText.length +
              streamingReasoning.length +
              liveTools.reduce(
                (n, t) =>
                  n +
                  // Prefer the live char count from streaming tool-input
                  // deltas; fall back to the finalized input size once
                  // the tool-call resolves (and inputChars is 0/undefined).
                  (t.inputChars && t.inputChars > 0
                    ? t.inputChars
                    : t.input
                      ? JSON.stringify(t.input).length
                      : 0) +
                  (t.result ? t.result.length : 0),
                0,
              )
            }
          />
        )}
        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute -top-12 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent" />
        {showJumpToLatest && (
          <button
            onClick={jumpToLatest}
            className="absolute -top-10 left-1/2 -translate-x-1/2 h-7 px-3 flex items-center gap-1.5 rounded-full border border-border bg-card shadow-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/60 z-10"
            title="Jump to latest"
          >
            <ChevronDown className="h-3 w-3" />
            new messages
          </button>
        )}

        <div className="p-3 max-w-[820px] mx-auto w-full">
          {!subagentsInline && latestSpawn.length > 0 && <Subagents list={latestSpawn} variant="strip" onControl={controlSubagent} />}
          {todos.length > 0 && uiChoice("todos") === "pinned" && (busy || todos.some((t) => t.status !== "completed")) && (
            <div className="mb-1.5 max-h-40 overflow-auto" data-el="todos-pinned">
              <AgentTodoList todos={todos} />
            </div>
          )}
          {activeConv && (
            <OngoingLine
              conversation={{ ...activeConv, messages, ...(uiChoice("cost") !== "reply" ? { costUsd: undefined } : {}) }}
              size="chat"
              className="px-1 pb-1.5"
              verdict={uiChoice("verdict") === "ongoing"}
            />
          )}
          {chips.length > 0 && !voiceBar && (
            <div className="mb-1.5 flex flex-col gap-1" data-el="pending-chips">
              {chips.map((c) => (
                <div
                  key={c.id}
                  data-el="pending"
                  data-kind={c.kind}
                  className="group flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 pl-2.5 pr-1 py-1 text-[12px]"
                >
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">
                    {c.kind === "steer" ? "Steering · next step" : "Queued · after this turn"}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-foreground/90">{c.text}</span>
                  {!c.sending && (
                    <>
                      <button
                        onClick={() => editChip(c)}
                        className="h-5 px-1.5 rounded text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-accent/60"
                        title="Edit — back into the composer"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => dispatchChatAction({ kind: "unqueue", id: c.id })}
                        className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60"
                        title="Remove"
                        data-el="pending-remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {(
          <div className="relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors">
            {skillMention && filteredSkills.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg z-10">
                {filteredSkills.slice(0, 8).map((s, i) => (
                  <div
                    key={s.name}
                    className={cn(
                      "flex items-baseline gap-3 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0",
                      i === skillMentionIdx ? "bg-accent" : "hover:bg-accent/60",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSkill(s.name);
                    }}
                    onMouseEnter={() => setSkillMentionIdx(i)}
                  >
                    <span className="text-primary font-mono text-[12.5px] font-medium shrink-0">/{s.name}</span>
                    {s.description && (
                      <span className="text-muted-foreground text-[11px] truncate">
                        {s.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {fileMention && matchedFiles.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg z-10">
                {matchedFiles.map((f, i) => (
                  <div
                    key={f.path}
                    className={cn(
                      "flex items-baseline gap-3 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0",
                      i === fileMentionIdx ? "bg-accent" : "hover:bg-accent/60",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(f);
                    }}
                    onMouseEnter={() => setFileMentionIdx(i)}
                  >
                    <span className="text-primary font-mono text-[12.5px] font-medium shrink-0 max-w-[50%] truncate">
                      {f.name}
                    </span>
                    <span className="text-muted-foreground text-[11px] truncate font-mono">
                      {f.rel}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-2">
                {pendingImages.map((img, i) => {
                  const name = img.sourcePath?.split("/").pop();
                  return (
                    <div key={i} className="relative group flex flex-col items-start gap-0.5">
                      <img
                        src={img.imageDataUrl}
                        alt={`captured ${i + 1}`}
                        className="max-h-[72px] rounded border border-border/60"
                      />
                      {name && (
                        <span className="text-[9.5px] text-muted-foreground font-mono">
                          {name}
                          {img.sourceAnchor ? ` · ${img.sourceAnchor}` : ""}
                        </span>
                      )}
                      <button
                        onClick={() =>
                          setPendingImages((prev) => prev.filter((_, j) => j !== i))
                        }
                        className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                        title="Remove"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="relative flex items-end">
              {(
                <div className="absolute left-2 bottom-2 z-10">
                  <button
                    onClick={() => setPlusOpen((o) => !o)}
                    disabled={!ready}
                    data-el="composer-plus"
                    className={cn(
                      "h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed",
                      plusOpen && "bg-accent/60 text-foreground",
                    )}
                    title="Add files, capture a region, or mention a vault file"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {plusOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onMouseDown={() => setPlusOpen(false)} />
                      <div
                        data-el="composer-plus-menu"
                        className="absolute bottom-full left-0 mb-1.5 z-20 w-60 rounded-lg border border-border bg-popover p-1 shadow-lg text-[12.5px]"
                      >
                        <PlusItem icon={<Paperclip className="h-3.5 w-3.5" />} label="Add photos & files" onClick={() => void addFiles()} />
                        <PlusItem
                          icon={<Scan className="h-3.5 w-3.5" />}
                          label="Capture a region"
                          hint={capturable ? "Drag over the open file" : "Open a PDF, HTML file or image first"}
                          disabled={!capturable || busy}
                          onClick={captureRegion}
                        />
                        <PlusItem icon={<AtSign className="h-3.5 w-3.5" />} label="Mention a vault file" onClick={mentionVaultFile} />
                      </div>
                    </>
                  )}
                </div>
              )}
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKey}
                onPaste={onPaste}
                placeholder={archived ? ARCHIVED_THREAD : boxDown ? BOX_UNREACHABLE : !ready ? "Open a vault first" : busy ? "Enter to steer · Tab to queue · Esc to stop" : "Ask anything, or / for commands…"}
                disabled={!ready}
                rows={1}
                className={cn("border-0 bg-transparent min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2", chatFullscreen && (voiceMode || voiceError) ? "!pr-32" : "!pr-20", "!pl-11")}
              />
              <div className="absolute right-3 bottom-2 flex items-center gap-1">
                {chatFullscreen && <InlineVoiceWaves />}
                {chatFullscreen && (
                  <button
                    // Voice runs in the main window (the popout's mic asks it).
                    onClick={isPopout ? () => dispatchChatAction({ kind: "toggleVoice" }) : toggleVoice}
                    disabled={!vaultPath}
                    data-el="composer-voice"
                    className={cn(
                      "h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/60 hover:text-foreground disabled:opacity-40",
                      voiceMode ? "text-foreground" : "text-muted-foreground",
                    )}
                    title={voiceMode ? "Voice on — Ctrl+D to turn off" : "Voice (Ctrl+D)"}
                  >
                    <Mic className="h-3.5 w-3.5" strokeWidth={voiceMode ? 2.5 : 2} />
                  </button>
                )}
                {/* Two states for the trailing button group:
                    - idle: just the Send arrow.
                    - busy: just the Stop square (Send is hidden entirely). */}
                {busy && (
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={stop}
                    className="h-7 w-7 rounded-lg"
                    title="Stop the agent"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </Button>
                )}
                {!busy && (
                  <Button
                    size="icon"
                    onClick={() => void send()}
                    disabled={!ready || (!input.trim() && pendingImages.length === 0)}
                    className="h-7 w-7 rounded-lg"
                    title="Send"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
          )}
          {!voiceBar && (
          <div className="flex items-center justify-between px-1 pt-1.5 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-3 min-w-0">
              <ModelPicker modelId={modelId} apiKeys={apiKeys} onSelect={onSelectModel} />
            </div>
            <div className="flex items-center gap-2">
              {busy && <ElapsedTimer />}
              {lastContext > 0 && (
                <div
                  className="flex items-center gap-1.5"
                  title={contextTitle(lastContext, ctxWindow)}
                >
                  <TokenRing used={lastContext} limit={ctxWindow.tokens} size={14} />
                  <span>{formatTokens(lastContext)}</span>
                </div>
              )}
              {!isPopout && !chatFullscreen && (
                <button
                  onClick={toggleChatsPanel}
                  className={`relative flex items-center gap-1 text-[11px] hover:text-foreground transition-colors ${
                    chatsShown ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                  title="Chats — switch, see history, see what's running"
                >
                  <MessageSquare className="h-3 w-3" />
                  <span>Chats</span>
                  {indicatorKind && (
                    <span
                      className="relative inline-flex h-1.5 w-1.5 ml-0.5"
                      title={
                        indicatorKind === "running"
                          ? "A background chat is thinking"
                          : "A background chat finished — unseen"
                      }
                    >
                      {indicatorKind === "running" ? (
                        // White, pulsing = a background chat is still thinking.
                        <>
                          <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
                        </>
                      ) : (
                        // Solid accent = a background chat finished, unseen.
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </span>
                  )}
                </button>
              )}
              {!chatFullscreen && (
                <button
                  onClick={() => useStore.getState().newConversation()}
                  className="hover:text-foreground transition-colors"
                  title="New chat"
                >
                  <Plus className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}


function PlusItem({ icon, label, hint, disabled, onClick }: { icon: React.ReactNode; label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-accent/60 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

function toolSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const primary =
    input.path ??
    input.file_path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.query ??
    input.from ??
    null;
  if (primary != null && typeof primary !== "object") {
    const extra =
      input.to != null ? ` → ${input.to}` :
      input.old_string != null ? ` (edit)` :
      input.glob_filter != null ? ` [${input.glob_filter}]` :
      "";
    return `${primary}${extra}`;
  }
  const first = Object.values(input)[0];
  return typeof first === "object" || first == null ? "" : String(first);
}

// Strip the trailing "[attached: ...]" footer that ChatPane appends to
// user turns so the agent sees resolved @-ref paths. The footer is
// meant for the model, not the user's own bubble.
function stripAttachedFooter(src: string): string {
  return src.replace(/\n*\[attached:[^\]]*\]\s*$/, "");
}

export const MessageBubble = memo(function MessageBubble({
  message,
  askLive = false,
  askChosen = "",
  onAsk,
  spawns,
  onSubagent,
}: {
  message: ChatMessage;
  /** AskUser options on this reply: still the open fork, and the answer given. */
  askLive?: boolean;
  askChosen?: string;
  onAsk?: (answer: string) => void;
  /** The subagents this reply's `subagent` call spawned (inline option). */
  spawns?: SubagentRec[];
  onSubagent?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
}) {
  const calls = (message.toolCalls ?? []).filter((t) => !isLegacySubagentRecord(t));
  if (isCompactionDivider(message)) {
    return <CompactionDivider message={message} />;
  }
  if (message.system) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
        <div className="h-px w-8 bg-border" />
        <span className="italic">{message.content}</span>
        <div className="h-px w-8 bg-border" />
      </div>
    );
  }
  const isUser = message.role === "user";
  return (
    <div className={cn("flex flex-col gap-1.5", isUser && "items-end")}>
      {isUser ? (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden prose-user">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1.5">
              {message.attachments.map((a, i) => {
                const name = a.sourcePath?.split("/").pop();
                return (
                  <div key={i} className="flex flex-col items-start gap-0.5">
                    <img
                      src={a.imageDataUrl}
                      alt={`captured ${i + 1}`}
                      className="max-h-[160px] rounded"
                    />
                    {name && (
                      <span className="text-[9.5px] opacity-80 font-mono">
                        {name}
                        {a.sourceAnchor ? ` · ${a.sourceAnchor}` : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Markdown source={stripAttachedFooter(message.display ?? message.content)} profile="user" components={chatComponents} />
        </div>
      ) : (
        <div className="w-full space-y-2">
          {message.thinking && <Thought text={message.thinking} />}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2" data-el="shown-images">
              {message.attachments.map((a, i) => (
                <img key={i} src={a.imageDataUrl} alt={a.sourcePath?.split("/").pop() ?? `image ${i + 1}`} className="max-h-[260px] max-w-full rounded-lg border border-border/60" />
              ))}
            </div>
          )}
          <div className="prose-chat text-foreground/95">
            <Markdown
              source={message.askOptions?.length ? withoutOptionList(message.content, message.askOptions) : (message.display ?? message.content)}
              profile="chat"
              components={chatComponents}
            />
          </div>
          {onAsk && message.askOptions && message.askOptions.length > 0 && <AskOptions options={message.askOptions} live={askLive} chosen={askChosen} onPick={onAsk} />}
          {calls.length > 0 && (
            <details className="group" data-el="tool-calls">
              <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                <Wrench className="h-3 w-3" />
                <span>{calls.length} tool call{calls.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="mt-2 space-y-2 pl-4 border-l border-border">
                {calls.map((t, j) => (
                  <div key={j} className="space-y-1">
                    <div className="text-[11px] font-mono text-primary">{t.name}</div>
                    <pre className="text-[10.5px] font-mono bg-muted/60 border border-border/40 rounded p-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(t.input, null, 2)}
                    </pre>
                    {t.result && (
                      <pre className="text-[10.5px] font-mono bg-muted/30 border border-border/40 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                        {t.result.length > 1200 ? `${t.result.slice(0, 1200)}…` : t.result}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          {spawns && spawns.length > 0 && <Subagents list={spawns} variant="inline" onControl={onSubagent} />}
          <ReplyCost m={message} />
        </div>
      )}
    </div>
  );
});

// Where the earlier conversation was summarized: the quiet system-line divider,
// whose summary expands like a tool-call list.
function CompactionDivider({ message }: { message: ChatMessage }) {
  // A compaction and the box's roll-over read the same: earlier, summarized here.
  return (
    <details className="group py-2" data-el="divider">
      <summary className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
        <div className="h-px w-8 bg-border" />
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        <span className="italic">{COMPACTION_DIVIDER_TEXT}</span>
        <div className="h-px w-8 bg-border" />
      </summary>
      <div className="mt-2 pl-4 border-l border-border prose-chat text-[12px] text-muted-foreground">
        <Markdown source={dividerSummary(message)} profile="chat" components={chatComponents} />
      </div>
    </details>
  );
}

// Compact visual of the agent's current plan. Shows one row per todo,
// uses different glyphs/styles for pending / in_progress / completed.
// The agent maintains this list via the TodoWrite tool.
function AgentTodoList({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const [open, setOpen] = useState(false);
  // Every step done: one quiet line (click for the steps).
  if (planDone(todos) && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-el="todos-done"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        title="Show the plan's steps"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600/70" />
        Plan · {done}/{todos.length} done
      </button>
    );
  }
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1" data-el="todos">
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Plan</span>
        <span className="font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => {
          const label =
            t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return (
            <li
              key={i}
              className="flex items-start gap-2 text-[12px] leading-relaxed"
            >
              <span
                className={cn(
                  "mt-[5px] h-2 w-2 shrink-0 rounded-full",
                  t.status === "completed" && "bg-emerald-600",
                  t.status === "in_progress" && "bg-primary animate-pulse",
                  t.status === "pending" && "bg-muted-foreground/40",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  t.status === "completed" && "line-through text-muted-foreground",
                  t.status === "in_progress" && "text-foreground",
                  t.status === "pending" && "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Single-line ticker for live tool calls. Instead of stacking every
// tool invocation, it shows only the most recent one, cross-fading
// between entries as they arrive. A small count in the corner makes it
// clear more than one tool has run in this turn.
function LiveToolTicker({ tools }: { tools: LiveTool[] }) {
  // Prefer showing a still-running tool over the most-recently-added one.
  // Otherwise a fast-completing tool added late (e.g. a Read) hides a
  // slow tool that started first (e.g. a Bash subprocess).
  const latest =
    tools.find((t) => !t.result) ?? tools[tools.length - 1];
  if (!latest) return null;
  const total = tools.length;
  const done = tools.filter((t) => t.result).length;
  const running = !latest.result;
  return (
    <div data-el="live-tool" className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground overflow-hidden">
      <Wrench className={cn("h-3 w-3 shrink-0", running && "animate-pulse")} />
      <span
        key={latest.id}
        className="live-tool-flip flex min-w-0 flex-1 items-center gap-2"
      >
        <span className="text-foreground/80 shrink-0">{latest.name}</span>
        <span className="opacity-70 truncate" title={toolSummary(latest.input)}>
          {toolSummary(latest.input)}
        </span>
      </span>
      {running && latest.startedAt && <ToolElapsed startedAt={latest.startedAt} />}
      {running && latest.etaSeconds && latest.etaSeconds >= 15 && (
        <span className="shrink-0 tabular-nums opacity-50" title="Estimated by Haiku">
          ~{formatEta(latest.etaSeconds)} expected
        </span>
      )}
      {total > 1 && (
        <span className="shrink-0 opacity-50">
          {done}/{total}
        </span>
      )}
      {running ? (
        <span className="opacity-40 shrink-0">…</span>
      ) : (
        <span className="text-emerald-500 shrink-0">✓</span>
      )}
    </div>
  );
}

function ToolElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - startedAt) / 1000);
  if (s < 1) return null;
  return <span className="shrink-0 tabular-nums opacity-50">{s}s</span>;
}

function ReasoningStream({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [text, open]);
  return (
    <div data-el="live-thinking" className="rounded-md border border-border/40 bg-muted/30 text-[11.5px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1 text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3 rotate-180" />}
        <span className="italic">Thinking…</span>
      </button>
      {open && (
        <div
          ref={tailRef}
          className="px-2.5 pb-2 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground/80 leading-relaxed"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ElapsedTimer() {
  // Count from the run's real start so leaving and returning to a running
  // thread shows continuous elapsed time, not a restart from 0. The start lives
  // on the conversation itself (`runStartedAt`, stamped when the prompt was
  // sent), so it's correct for EVERY source — manual, voice, mission, worker,
  // phone — and survives open/close and reload. Falls back to the global
  // busyStartedAt, then to mount time, if a start somehow wasn't recorded.
  const startedAt = useStore((s) => {
    const active = s.conversations.find((c) => c.id === s.activeConversationId);
    return active?.runStartedAt ?? s.busyStartedAt;
  });
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = startedAt ?? Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const label = mm > 0 ? `${mm}:${ss.toString().padStart(2, "0")}` : `${ss}s`;
  return (
    <span className="tabular-nums opacity-70" title="Agent running">
      {label}
    </span>
  );
}

export function ThinkingIndicator({
  liveChars,
  silent,
}: {
  silent?: boolean;
  activeTool?: string;
  streaming?: boolean;
  reasoning?: boolean;
  liveChars?: number;
}) {
  // Live token estimate while streaming. Per-turn usage isn't available
  // until the "done" event fires, so we approximate from character count
  // — Claude / GPT tokenizers average roughly 4 chars/token on English.
  const liveTokens = liveChars ? Math.max(1, Math.round(liveChars / 4)) : 0;
  return (
    <div className="flex items-center gap-2 py-1 text-foreground/80">
      <span className="relative inline-flex h-3 w-3 vc-pulse-drift">
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-a" />
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-b" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-current vc-pulse-core" />
      </span>
      {/* Thinking with nothing to show yet: one quiet shimmering word beside the pulse. */}
      {silent && (
        <span data-el="live-thinking" data-silent="" className="vc-shimmer text-[13px]">
          Thinking
        </span>
      )}
      {!silent && liveTokens > 0 && (
        <span className="text-[10.5px] font-mono tabular-nums text-muted-foreground">
          {formatTokens(liveTokens)} tokens
        </span>
      )}
    </div>
  );
}

function TokenRing({ used, limit, size }: { used: number; limit: number; size: number }) {
  const r = (size - 2) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(used / limit, 1);
  const color = pct < 0.5 ? "hsl(var(--muted-foreground))" : pct < 0.8 ? "hsl(40, 90%, 55%)" : "hsl(0, 72%, 58%)";
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={1.5} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={1.5}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function contextTitle(used: number, w: { tokens: number; known: boolean }): string {
  const pct = Math.round((used / w.tokens) * 100);
  const of = w.known ? `${w.tokens.toLocaleString()}` : `~${w.tokens.toLocaleString()} (window unknown)`;
  const next = used > COMPACT_THRESHOLD * w.tokens ? "\nThe next message first summarizes the earlier conversation." : "";
  return `Context: ${used.toLocaleString()} of ${of} tokens (${pct}%)${next}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

function ModelPicker({
  modelId,
  apiKeys,
  onSelect,
}: {
  modelId: string;
  apiKeys: Partial<Record<string, string>>;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalog = useStore((s) => s.catalog);
  const available = catalog.filter((m) => apiKeys[m.provider]);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? available.filter((m) => {
        const hay = `${m.provider} ${m.id} ${m.label}`.toLowerCase();
        return q.split(/\s+/).every((t) => hay.includes(t));
      })
    : available;
  const isAuto = modelId === AUTO_MODEL_ID;
  const current = isAuto ? null : findModel(modelId);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    // Auto-focus the search when the menu opens.
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>
          {isAuto ? "Auto" : (current?.label ?? modelId)}
        </span>
        <ChevronUp className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col">
          <div className="p-1.5 border-b border-border/60">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && filtered.length > 0) {
                  e.preventDefault();
                  onSelect(filtered[0].id);
                  setOpen(false);
                }
              }}
              placeholder="Search models…"
              className="w-full bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="py-1 max-h-64 overflow-auto">
            {/* Auto option — always pinned at the top, hidden when searching */}
            {!q && (
              <>
                <button
                  onClick={() => { onSelect(AUTO_MODEL_ID); setOpen(false); }}
                  className={cn(
                    "block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors",
                    isAuto ? "font-medium" : "text-muted-foreground"
                  )}
                  title="Routes each message to a fast or full model based on complexity"
                >
                  Auto <span className="opacity-60 text-[10px]">— smart routing</span>
                </button>
                <div className="mx-2 border-t border-border/40 my-1" />
              </>
            )}
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground italic">
                No matches
              </div>
            ) : (
              filtered.map((m) => (
                <button
                  key={`${m.provider}:${m.id}`}
                  onClick={() => { onSelect(m.id); setOpen(false); }}
                  className={cn(
                    "block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors truncate",
                    m.id === modelId ? "text-foreground font-medium" : "text-muted-foreground"
                  )}
                  title={`${m.provider} · ${m.id}`}
                >
                  {m.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
