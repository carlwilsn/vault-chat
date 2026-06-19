import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { preprocessMarkdownMath } from "./mdMath";
import { Plus, Square, ArrowUp, ChevronDown, ChevronUp, Wrench, Camera, X, MessageSquare } from "lucide-react";
import { fileKind } from "./fileKind";
import { invoke } from "@tauri-apps/api/core";
import { dispatchChatAction, isPopout } from "./sync";
import { useStore, MODEL_CONTEXT_LIMIT, type ChatMessage, type FileEntry, type LiveTool, type TodoItem } from "./store";
import { buildViewportContextText } from "./voice-elevenlabs";
import { findModel, AUTO_MODEL_ID } from "./providers";
import { loadSkills } from "./skills";
import { isUnreadableAsText } from "./fileKind";
import { SettingsPane } from "./SettingsPane";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";

type MentionHit = { path: string; name: string; rel: string };

// Lenient KaTeX options shared across every renderer in the app:
// `strict: "ignore"` silences unicode-in-math-mode and similar
// pedantic warnings; `errorColor: currentColor` makes rare
// unrecoverable parse errors blend in with body text instead of
// glaring red.
const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;

// Pass data:image/… URLs through; everything else falls back to the
// built-in sanitizer. react-markdown's default strips data: URLs as
// unsafe, which kills images promoted from marquee asks into chat.
//
// Also rescue Windows absolute paths (`C:/Users/...`, `C:\Users\...`).
// defaultUrlTransform sees the `C:` prefix as a protocol — and `c` is
// not in its safelist (`http|https|ircs?|mailto|xmpp`) — so it strips
// the URL to empty. That's the most common shape an agent emits for an
// image in a local-files app: the absolute path to a PNG it just
// generated. ChatImage handles the actual bytes-from-disk load via
// read_binary_file, so passing the string through here is harmless.
const allowImageDataUrls = (url: string): string => {
  if (url.startsWith("data:image/")) return url;
  if (/^[a-zA-Z]:[\\/]/.test(url)) return url;
  return defaultUrlTransform(url);
};

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
    const cleaned = src.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
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
    else if (nameLower.startsWith(q)) score = 100 - Math.abs(nameLower.length - q.length);
    else if (nameLower.includes(q)) score = 60 - nameLower.indexOf(q);
    else if (relLower.includes(q)) score = 30 - relLower.indexOf(q);
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
  console.info(`[@ref] attaching ${mentions.length} file(s):\n${preamble}`);
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
  const toggleChatsPanel = () => setShowChatsPanel(!showChatsPanel);
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
  const ready = Boolean(vaultPath && activeKey);

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

  if (!activeKey) {
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

  const send = async () => {
    if (!ready) return;
    const text = input.trim();
    if (!text && pendingImages.length === 0) return;
    // While the agent is mid-generation, "send" interrupts: capture
    // the partial response as a final assistant turn, abort the
    // current call, then send the new user message as a fresh turn.
    // See chat-controller's interruptAndSend.
    const actionKind: "send" | "interrupt" = busy ? "interrupt" : "send";
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
      if (!busy) send();
    }
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

  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative">
      <div
        className="flex-1 min-h-0 overflow-auto px-3 py-4 pb-8 relative"
        ref={scrollRef}
        onScroll={onScroll}
      >
        <div className="max-w-[820px] mx-auto space-y-4">
        {messages.length === 0 && !streamingText && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 space-y-3">
            <p className="text-[13px] text-foreground/90">Ready.</p>
          </div>
        )}

        {messages.map((m, i) =>
          m.hidden ? null : <MessageBubble key={i} message={m} />,
        )}

        {compacting && (
          <div className="flex items-center justify-center gap-2 py-2 text-[11.5px] text-muted-foreground">
            <span>Compacting conversation…</span>
          </div>
        )}

        {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}

        {(streamingText || streamingReasoning || liveTools.length > 0) && (
          <div className="space-y-2">
            {liveTools.length > 0 && <LiveToolTicker tools={liveTools} />}
            {streamingReasoning && !streamingText && (
              <ReasoningStream text={streamingReasoning} />
            )}
            {streamingText && (
              <div className="prose-chat text-foreground/95">
                {/* While streaming, skip rehypeHighlight AND
                    remarkMath/rehypeKatex — re-tokenizing every code
                    block AND re-rendering every $$…$$ from scratch on
                    every flush is O(N²) over the growing buffer and
                    locks the main thread on long responses (most
                    visible with high-throughput providers like Opus
                    4.6 fast on OpenRouter). Code blocks render
                    unstyled and math renders as raw $$ during the
                    stream; both snap to their final form once the
                    MessageBubble path re-renders the finalized
                    message with the full plugin set. */}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streamingText}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {busy && (
          <ThinkingIndicator
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
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKey}
                onPaste={onPaste}
                placeholder={ready ? "Ask anything, or / for commands…" : "Open a vault first"}
                disabled={!ready}
                rows={1}
                className="border-0 bg-transparent min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2 !pl-3 !pr-20"
              />
              <div className="absolute right-3 bottom-2 flex items-center gap-1">
                {!busy && (() => {
                  // Union of what's open in main's panes — synced to
                  // the popout via state broadcast. If any visible
                  // file is marquee-capable, enable Capture.
                  const paths: string[] = [];
                  if (currentFile) paths.push(currentFile);
                  for (const p of panes) if (p.file) paths.push(p.file);
                  const canMarquee = paths.some((p) => {
                    const k = fileKind(p).kind;
                    return k === "pdf" || k === "html" || k === "image";
                  });
                  return (
                    <button
                      onClick={() => {
                        if (!canMarquee) return;
                        // In popout: route via chat:action; main
                        // fires the marquee on its own window and
                        // bounces the resulting image back.
                        if (isPopout) {
                          dispatchChatAction({ kind: "startCapture" });
                          return;
                        }
                        const s = useStore.getState();
                        s.setEditPromptCapturePending(false);
                        s.setNoteCapturePending(false);
                        setChatPaneCapturePending(true);
                        window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
                      }}
                      disabled={!ready || !canMarquee}
                      className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        canMarquee
                          ? isPopout
                            ? "Capture region from main window's current viewer"
                            : "Capture region from the current viewer"
                          : "Open a PDF, HTML file, or image to capture a region"
                      }
                    >
                      <Camera className="h-3.5 w-3.5" />
                    </button>
                  );
                })()}
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
                    onClick={send}
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
          <div className="flex items-center justify-between px-1 pt-1.5 text-[11px] text-muted-foreground">
            <ModelPicker modelId={modelId} apiKeys={apiKeys} onSelect={onSelectModel} />
            <div className="flex items-center gap-2">
              {busy && <ElapsedTimer />}
              {lastContext > 0 && (
                <div
                  className="flex items-center gap-1.5"
                  title={`Context: ${lastContext.toLocaleString()} / ${MODEL_CONTEXT_LIMIT.toLocaleString()} tokens`}
                >
                  <TokenRing used={lastContext} limit={MODEL_CONTEXT_LIMIT} size={14} />
                  <span>{formatTokens(lastContext)}</span>
                </div>
              )}
              {!isPopout && (
                <button
                  onClick={toggleChatsPanel}
                  className={`relative flex items-center gap-1 text-[11px] hover:text-foreground transition-colors ${
                    showChatsPanel ? "text-foreground font-medium" : "text-muted-foreground"
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
                        <>
                          <span className="absolute inset-0 rounded-full bg-primary opacity-60 animate-ping" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                        </>
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={() => useStore.getState().newConversation()}
                className="hover:text-foreground transition-colors"
                title="New chat"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function toolSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const primary =
    input.path ??
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

// ---- Mission proposal cards ----
// The agent's ProposeMission tool makes chat-controller inject a canonical
// ```plan fenced block into the reply (same block the phone cockpit renders as
// an Approve card). On the desktop ChatPane we render that block as a card with
// an "Approve & run" button that mints the mission deterministically — matching
// the phone's behavior so a chat here has the same mission powers as the phone.
type PlanSeg =
  | { kind: "md"; text: string }
  | { kind: "plan"; title: string; tasks: string[]; desc: string };

function parsePlanBlock(body: string): { title: string; tasks: string[]; desc: string } {
  let title = "";
  const tasks: string[] = [];
  const desc: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^title:\s*(.+)$/i);
    if (m) {
      title = m[1].trim();
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      tasks.push(t.replace(/^[-*]\s+/, ""));
      continue;
    }
    desc.push(t);
  }
  return { title, tasks, desc: desc.join(" ") };
}

// Split assistant content into markdown runs and ```plan cards, preserving
// order. Whitespace-only markdown runs (the gaps around a block) are dropped so
// they don't render empty paragraphs.
function segmentAssistant(content: string): PlanSeg[] {
  const segs: PlanSeg[] = [];
  const re = /```plan[ \t]*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(last, m.index);
    if (before.trim()) segs.push({ kind: "md", text: before });
    segs.push({ kind: "plan", ...parsePlanBlock(m[1]) });
    last = re.lastIndex;
  }
  if (last === 0) return [{ kind: "md", text: content }];
  const after = content.slice(last);
  if (after.trim()) segs.push({ kind: "md", text: after });
  return segs;
}

function PlanCard({ title, tasks, desc }: { title: string; tasks: string[]; desc: string }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const [state, setState] = useState<"idle" | "approving" | "approved">("idle");
  const [err, setErr] = useState<string | null>(null);

  const approve = async () => {
    if (!vaultPath || state !== "idle") return;
    setState("approving");
    setErr(null);
    try {
      // Same goal shape the phone hands to startMission on approval, so the
      // mission brief (and its "Done when" checklist) reads identically.
      const goal = [
        title,
        desc,
        tasks.length
          ? "Done when (each defines completion — likely one worker each, but split or merge as you see fit):\n" +
            tasks.map((t) => `- ${t}`).join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const { startMission } = await import("./offVaultRun");
      await startMission(vaultPath, goal, title || "Mission");
      setState("approved");
    } catch (e) {
      setState("idle");
      setErr(String((e as { message?: string })?.message ?? e));
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-muted/30 p-3.5 space-y-2.5",
        state === "approved" && "opacity-60",
      )}
    >
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground font-semibold">
        {state === "approved" ? "Mission created · running" : "Proposed mission · approve to start"}
      </div>
      {title && <div className="text-[14px] font-semibold leading-snug">{title}</div>}
      {desc && <div className="text-[12.5px] text-muted-foreground leading-relaxed">{desc}</div>}
      {tasks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/80">Done when</div>
          <ul className="space-y-1">
            {tasks.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                <span className="min-w-0">{t}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state !== "approved" && (
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            onClick={approve}
            disabled={state === "approving" || !vaultPath}
            className="h-8 px-4 text-[12.5px]"
          >
            {state === "approving" ? "Starting…" : "Approve & run"}
          </Button>
          {err && <span className="text-[11px] text-destructive">{err}</span>}
        </div>
      )}
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: ChatMessage;
}) {
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
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
            rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
            urlTransform={allowImageDataUrls}
            components={chatComponents}
          >
            {preprocessMarkdownMath(stripAttachedFooter(message.content))}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="w-full space-y-2">
          {segmentAssistant(message.content).map((seg, idx) =>
            seg.kind === "plan" ? (
              <PlanCard key={idx} title={seg.title} desc={seg.desc} tasks={seg.tasks} />
            ) : (
              <div key={idx} className="prose-chat text-foreground/95">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
                  urlTransform={allowImageDataUrls}
                  components={chatComponents}
                >
                  {preprocessMarkdownMath(seg.text)}
                </ReactMarkdown>
              </div>
            ),
          )}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <details className="group">
              <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                <Wrench className="h-3 w-3" />
                <span>{message.toolCalls.length} tool call{message.toolCalls.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="mt-2 space-y-2 pl-4 border-l border-border">
                {message.toolCalls.map((t, j) => (
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
        </div>
      )}
    </div>
  );
});

// Compact visual of the agent's current plan. Shows one row per todo,
// uses different glyphs/styles for pending / in_progress / completed.
// The agent maintains this list via the TodoWrite tool.
function AgentTodoList({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1">
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
    <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground overflow-hidden">
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
    <div className="rounded-md border border-border/40 bg-muted/30 text-[11.5px]">
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
  // Count from the run's real start (store) so leaving and returning to a
  // running thread shows continuous elapsed time, not a restart from 0.
  // Falls back to mount time if the start wasn't recorded.
  const busyStartedAt = useStore((s) => s.busyStartedAt);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = busyStartedAt ?? Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [busyStartedAt]);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const label = mm > 0 ? `${mm}:${ss.toString().padStart(2, "0")}` : `${ss}s`;
  return (
    <span className="tabular-nums opacity-70" title="Agent running">
      {label}
    </span>
  );
}

function ThinkingIndicator({
  liveChars,
}: {
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
      {liveTokens > 0 && (
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
