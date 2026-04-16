import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Trash2, Square, ArrowUp, ChevronDown, ChevronUp, Wrench, Sparkles } from "lucide-react";
import { dispatchChatAction } from "./sync";
import { useStore } from "./store";
import { findModel, MODELS } from "./providers";
import { loadSkills } from "./skills";
import { SettingsPane } from "./SettingsPane";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";

export function ChatPane() {
  const {
    vaultPath,
    messages,
    apiKeys,
    modelId,
    skills,
    busy,
    showSettings,
    tokenUsage,
    setSkills,
    setShowSettings,
    streamingText,
    liveTools,
  } = useStore();

  const [input, setInput] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeSpec = findModel(modelId);
  const activeKey = activeSpec ? apiKeys[activeSpec.provider] : undefined;
  const ready = Boolean(vaultPath && activeKey);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText, liveTools]);

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
            <div className="mx-auto h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
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

  const send = () => {
    if (!input.trim() || busy || !ready) return;
    const text = input.trim();
    setInput("");
    setShowSkillMenu(false);
    dispatchChatAction({ kind: "send", text });
  };

  const stop = () => dispatchChatAction({ kind: "stop" });
  const onClear = () => dispatchChatAction({ kind: "clear" });
  const onSelectModel = (id: string) => dispatchChatAction({ kind: "setModel", id });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !showSkillMenu) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") setShowSkillMenu(false);
  };

  const onInputChange = (v: string) => {
    setInput(v);
    setShowSkillMenu(v.startsWith("/") && !v.includes(" "));
  };

  const pickSkill = (name: string) => {
    setInput(`/${name} `);
    setShowSkillMenu(false);
    inputRef.current?.focus();
  };

  const filteredSkills = input.startsWith("/")
    ? skills.filter((s) => s.name.startsWith(input.slice(1).split(" ")[0]))
    : [];

  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative">
      <div className="flex-1 min-h-0 overflow-auto px-3 py-4 pb-8" ref={scrollRef}>
        <div className="max-w-[820px] mx-auto space-y-4">
        {messages.length === 0 && !streamingText && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 space-y-3">
            <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] text-foreground/90">Ready.</p>
              {skills.length > 0 ? (
                <p className="text-[11.5px] text-muted-foreground">
                  Type <kbd className="inline-flex items-center rounded border border-border bg-muted px-1 py-0 text-[10px] font-mono">/</kbd> to see {skills.length} skill{skills.length === 1 ? "" : "s"}
                </p>
              ) : (
                <p className="text-[11.5px] text-muted-foreground">Ask anything about this vault.</p>
              )}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}

        {(streamingText || liveTools.length > 0) && (
          <div className="space-y-2">
            {liveTools.length > 0 && (
              <div className="space-y-1">
                {liveTools.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground"
                  >
                    <Wrench className={cn("h-3 w-3", !t.result && "animate-pulse")} />
                    <span className="text-foreground/80">{t.name}</span>
                    <span className="opacity-60 truncate">
                      ({Object.keys(t.input).slice(0, 3).join(", ")})
                    </span>
                    {t.result ? <span className="text-emerald-500 ml-auto">✓</span> : <span className="opacity-40">…</span>}
                  </div>
                ))}
              </div>
            )}
            {streamingText && (
              <div className="prose-chat text-foreground/95">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex, rehypeHighlight]}
                >
                  {streamingText}
                </ReactMarkdown>
                <span className="inline-block w-1.5 h-3 bg-primary/70 ml-0.5 animate-pulse align-middle" />
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute -top-12 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent" />
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

        <div className="p-3 max-w-[820px] mx-auto w-full">
          <div className="relative flex items-end rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKey}
              placeholder={ready ? "Ask anything, or / for commands…" : "Open a vault first"}
              disabled={!ready || busy}
              rows={1}
              className="border-0 bg-transparent pr-11 min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2 !px-3"
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
          <div className="flex items-center justify-between px-1 pt-1.5 text-[11px] text-muted-foreground">
            <ModelPicker modelId={modelId} apiKeys={apiKeys} onSelect={onSelectModel} />
            <div className="flex items-center gap-2">
              {tokenUsage.total > 0 && (
                <div className="flex items-center gap-1.5" title={`${tokenUsage.prompt.toLocaleString()} in / ${tokenUsage.completion.toLocaleString()} out`}>
                  <TokenRing used={tokenUsage.total} limit={200000} size={14} />
                  <span>{formatTokens(tokenUsage.total)}</span>
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

function MessageBubble({
  message,
}: {
  message: { role: "user" | "assistant"; content: string; toolCalls?: { id?: string; name: string; input: any; result?: string }[] };
}) {
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
                "w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors",
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
