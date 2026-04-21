import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Trash2, Square, ArrowUp, ChevronDown, ChevronUp, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { dispatchChatAction } from "./sync";
import { useStore, MODEL_CONTEXT_LIMIT, type ChatMessage, type FileEntry, type LiveTool, type TodoItem } from "./store";
import { findModel, MODELS } from "./providers";
import { loadSkills } from "./skills";
import { isUnreadableAsText } from "./fileKind";
import { SettingsPane } from "./SettingsPane";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";

type MentionHit = { path: string; name: string; rel: string };

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
    if (f.is_dir) continue;
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

// Expand the chip-attached mentions into prepended context blocks with
// the file's content. Unreadable-as-text files (images, pdfs, unsupported)
// are mentioned by path only so the agent knows to fetch them explicitly.
async function expandAttachedMentions(
  text: string,
  mentions: Array<{ rel: string; path: string }>,
): Promise<string> {
  if (mentions.length === 0) return text;
  const blocks: string[] = [];
  for (const { rel, path } of mentions) {
    if (isUnreadableAsText(path)) {
      blocks.push(`@${rel} → ${path} (binary; ask to open explicitly)`);
      continue;
    }
    try {
      const content = await invoke<string>("read_text_file", { path });
      blocks.push(`--- @${rel} (${path}) ---\n${content}\n--- end ${rel} ---`);
    } catch (err) {
      blocks.push(`@${rel} → ${path} (failed to read: ${String(err)})`);
    }
  }
  if (blocks.length === 0) return text;
  return `${blocks.join("\n\n")}\n\n${text}`;
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
  const [input, setInput] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
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
  const activeKey = activeSpec ? apiKeys[activeSpec.provider] : undefined;
  const ready = Boolean(vaultPath && activeKey);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
    }
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
    if (busy || !ready) return;
    const text = input.trim();
    if (!text && mentions.length === 0) return;
    // Expand attached mentions into prepended context blocks so the
    // agent sees the files inline rather than having to Read each one.
    const expanded = await expandAttachedMentions(
      text,
      mentions.map((m) => ({ rel: m.rel, path: m.path })),
    );
    setInput("");
    setMentions([]);
    setShowSkillMenu(false);
    setFileMention(null);
    dispatchChatAction({ kind: "send", text: expanded });
  };

  const stop = () => dispatchChatAction({ kind: "stop" });
  const onClear = () => dispatchChatAction({ kind: "clear" });
  const onSelectModel = (id: string) => dispatchChatAction({ kind: "setModel", id });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Tab" && showSkillMenu && filteredSkills.length > 0) {
      e.preventDefault();
      pickSkill(filteredSkills[0].name);
      return;
    }
    // Backspace on empty input pops the most recent mention back into
    // the textarea as editable text — Gmail-style chip correction.
    if (e.key === "Backspace" && input === "" && mentions.length > 0) {
      e.preventDefault();
      restoreLastMention();
      return;
    }
    if (e.key === "Escape") setShowSkillMenu(false);
  };

  const onInputChange = (v: string) => {
    setInput(v);
    setShowSkillMenu(v.startsWith("/") && !v.includes(" "));
    // Detect an active @mention at the caret. Looking backwards for the
    // most recent @ that's either at the start or preceded by whitespace,
    // with no whitespace between @ and caret.
    const caret = inputRef.current?.selectionStart ?? v.length;
    const upToCaret = v.slice(0, caret);
    const atMatch = upToCaret.match(/(^|\s)@([^\s]*)$/);
    if (atMatch) {
      setFileMention({
        query: atMatch[2],
        start: caret - atMatch[2].length - 1, // index of '@'
      });
      setFileMentionIdx(0);
    } else {
      setFileMention(null);
    }
  };

  const pickSkill = (name: string) => {
    setInput(`/${name} `);
    setShowSkillMenu(false);
    inputRef.current?.focus();
  };

  const filteredSkills = input.startsWith("/")
    ? skills.filter((s) => s.name.startsWith(input.slice(1).split(" ")[0]))
    : [];

  const matchedFiles = fileMention
    ? filterFilesForMention(files, vaultPath, fileMention.query).slice(0, 8)
    : [];

  const pickMention = (hit: MentionHit) => {
    if (!fileMention) return;
    const rawAt = input.slice(fileMention.start, fileMention.start + 1 + fileMention.query.length);
    const before = input.slice(0, fileMention.start);
    const after = input.slice(fileMention.start + 1 + fileMention.query.length);
    // Strip the @query from the textarea — the chip above carries it now.
    const next = `${before}${after.replace(/^\s+/, "")}`.trimStart();
    setInput(next);
    setMentions((prev) => {
      if (prev.some((m) => m.path === hit.path)) return prev;
      return [...prev, { rel: hit.rel, path: hit.path, name: hit.name, raw: rawAt }];
    });
    setFileMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const removeMention = (path: string) => {
    setMentions((prev) => prev.filter((m) => m.path !== path));
  };

  const openMentionInViewer = async (path: string) => {
    try {
      const content = isUnreadableAsText(path)
        ? ""
        : await invoke<string>("read_text_file", { path });
      useStore.getState().setCurrentFile(path, content);
    } catch (err) {
      console.error("[mention] open failed:", err);
    }
  };

  // Backspace on empty input restores the most recent mention as
  // editable text. Mirrors the Gmail chip-input pattern: deleting a
  // token brings the raw characters back for a correction.
  const restoreLastMention = () => {
    if (mentions.length === 0) return;
    const last = mentions[mentions.length - 1];
    setMentions((prev) => prev.slice(0, -1));
    setInput(last.raw);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.setSelectionRange(last.raw.length, last.raw.length);
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
                {/* While streaming, skip rehypeHighlight — re-tokenizing
                    every code block in the growing buffer on every
                    flush is the main cause of UI-thread freezes on
                    long responses. Code blocks render unstyled until
                    the message finalizes (then the MessageBubble path
                    re-renders with the full plugin set). */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                >
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
                  (t.input ? JSON.stringify(t.input).length : 0) +
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
        {showSkillMenu && filteredSkills.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg">
            {filteredSkills.slice(0, 8).map((s) => (
              <div
                key={s.name}
                className="flex items-baseline gap-3 px-3 py-2 cursor-pointer hover:bg-accent border-b border-border/40 last:border-b-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSkill(s.name);
                }}
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
          <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg">
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

        <div className="p-3 max-w-[820px] mx-auto w-full">
          <div className="relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors">
            <MentionChips
              mentions={mentions}
              onOpen={openMentionInViewer}
              onRemove={removeMention}
            />
            <div className="relative flex items-end">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKey}
                placeholder={ready ? "Ask anything, or / for commands…" : "Open a vault first"}
                disabled={!ready}
                rows={1}
                className="border-0 bg-transparent min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2 !pl-3 !pr-11"
              />
              <div className="absolute right-3 bottom-2">
                {busy ? (
                  <Button size="icon" variant="secondary" onClick={stop} className="h-7 w-7 rounded-lg">
                    <Square className="h-3 w-3 fill-current" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onClick={send}
                    disabled={!ready || !input.trim()}
                    className="h-7 w-7 rounded-lg"
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
              {messages.length > 0 && (
                <button
                  onClick={onClear}
                  className="hover:text-foreground transition-colors"
                  title="Clear conversation"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
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
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words overflow-hidden">
          {message.content}
        </div>
      ) : (
        <div className="w-full space-y-2">
          <div className="prose-chat text-foreground/95">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
            >
              {message.content}
            </ReactMarkdown>
          </div>
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
                  t.status === "completed" && "bg-emerald-500",
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
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const label = mm > 0 ? `${mm}:${ss.toString().padStart(2, "0")}` : `${ss}s`;
  return (
    <span className="tabular-nums opacity-70" title="Agent running">
      {label}
    </span>
  );
}

// Attached-file chips above the input. Each chip represents a file the
// user summoned with @. Click opens it in the viewer; × detaches it.
function MentionChips({
  mentions,
  onOpen,
  onRemove,
}: {
  mentions: Array<{ rel: string; path: string; name: string }>;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  if (mentions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 pt-2">
      {mentions.map((m) => (
        <div
          key={m.path}
          className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-primary/15 border border-primary/30 text-[11px] text-foreground"
        >
          <button
            onClick={() => onOpen(m.path)}
            className="font-mono max-w-[240px] truncate hover:underline underline-offset-2"
            title={m.path}
          >
            @{m.rel}
          </button>
          <button
            onClick={() => onRemove(m.path)}
            className="h-4 w-4 flex items-center justify-center rounded-full hover:bg-primary/25 text-muted-foreground hover:text-foreground"
            title="Remove (or backspace on empty input to edit)"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" className="pointer-events-none">
              <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
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
  const ref = useRef<HTMLDivElement>(null);
  const available = MODELS.filter((m) => apiKeys[m.provider]);
  const current = findModel(modelId);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>{current?.label ?? modelId}</span>
        <ChevronUp className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 rounded-lg border border-border shadow-lg py-1 z-50 whitespace-nowrap"
          style={{ background: "hsl(var(--card))" }}
        >
          {available.map((m) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m.id); setOpen(false); }}
              className={cn(
                "block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors",
                m.id === modelId ? "text-foreground font-medium" : "text-muted-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
