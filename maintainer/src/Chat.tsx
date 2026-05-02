import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Anthropic from "@anthropic-ai/sdk";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, AlertTriangle, Trash2, Wrench, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { PLANNER_TOOLS, executeTool } from "./planner-tools";
import { useStore } from "./store";
import { cn } from "./lib";

// Planner agent — the CEO's read-only thinking partner. Conversational
// strategy + filing well-formed issues for the implementer to execute.
// Anthropic SDK runs in-browser; the API key is per-machine, no public
// exposure (this is a Tauri desktop app, not a web page).

const MODEL_ID = "claude-sonnet-4-6";
const STORAGE_KEY = "maintainer.planner.transcript.v1";
const ANTHROPIC_KEY = "service.anthropic_api_key";

const SYSTEM_PROMPT = `You are the Planner agent for vault-chat — a desktop app Carl (the user) uses as both a knowledge vault and an AI-coding workspace. Carl is the CEO and is non-technical-by-choice. You are his thinking partner and engineering manager.

# Your role
- Help Carl think through ideas, debug confusing situations, and decide what to build next.
- Read the codebase + GitHub issue state + workflow status to ground your answers in reality. Don't speculate when you can look.
- When a course of action is clear, propose filing an issue — but ONLY file after Carl explicitly says yes.
- Speak in plain English. Never mention file paths, function names, library names, or commit hashes in your replies unless Carl asks for technical detail. When Carl wants to know "what should we do?" answer in product/UX terms, not engineering terms.

# What you have access to
- list_files, read_file, grep — explore the codebase
- list_issues, read_issue — see what's queued, in flight, awaiting verification
- list_workflow_runs, list_releases — see what's been shipping
- file_issue — file a new issue (your main write tool). Hands work to the implementer agent.
- run_task_now — queue an existing task:in-progress issue for immediate execution. Use when Carl says "run #N now" or wants to kick off a stalled task. Always confirm the issue number first.

# How to behave
- Ask clarifying questions before jumping to solutions when intent is ambiguous.
- Surface tradeoffs in plain English when there's a real choice to make.
- Be opinionated. Recommend a path, don't just enumerate options.
- When Carl approves an issue to file, write the issue body in CEO-friendly language too — Carl will read it. Include a short "Why" and "What good looks like" so the implementer agent has clear acceptance criteria.

# Issue types when filing
- bug: small one-shot fix the implementer ships overnight (label: auto-fix:queued)
- feature: long-running iterative work (label: task:in-progress) — use this for bigger ideas
- maintainer-task: anything that touches /maintainer/ code (the rescue app)

Default to "feature" for anything that requires multiple decisions; default to "bug" for clearly-scoped fixes.`;

type Role = "user" | "assistant";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type Message = {
  role: Role;
  blocks: Block[];
  // For UI: collapse tool blocks by default
};

type Phase = "idle" | "thinking" | { error: string };

export function Chat() {
  const ghLogin = useStore((s) => s.ghLogin);
  // Re-read on mount; the GH PAT we already have for the rest of the
  // maintainer is enough for the read tools and file_issue. The
  // Anthropic key is separate.
  const githubPat = useStore((s) => s.githubPat) ?? "";
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Load API key + transcript on mount.
  useEffect(() => {
    (async () => {
      try {
        const k = await invoke<string | null>("keychain_get", { key: ANTHROPIC_KEY });
        setApiKey(k ?? null);
      } catch (e) {
        setKeyError(`Couldn't read key from keychain: ${(e as Error).message}`);
      }
    })();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Message[];
        if (Array.isArray(parsed)) setMessages(parsed);
      }
    } catch {
      // Ignore
    }
  }, []);

  // Persist transcript whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // localStorage full or disabled — non-fatal.
    }
  }, [messages]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  const saveApiKey = async () => {
    const v = apiKeyDraft.trim();
    if (!v) return;
    setSavingKey(true);
    try {
      await invoke("keychain_set", { key: ANTHROPIC_KEY, value: v });
      setApiKey(v);
      setApiKeyDraft("");
      setKeyError(null);
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setSavingKey(false);
    }
  };

  const clearTranscript = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const send = async () => {
    if (!apiKey) return;
    const text = input.trim();
    if (!text) return;
    if (phase === "thinking") return;
    setInput("");

    const next = [...messages, { role: "user" as Role, blocks: [{ type: "text", text } satisfies Block] }];
    setMessages(next);
    void runAgentLoop(next);
  };

  const runAgentLoop = async (history: Message[]) => {
    if (!apiKey) return;
    setPhase("thinking");
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    let working = [...history];
    try {
      // Iterate until the model stops requesting tools (max 10 hops to
      // keep a runaway loop from burning tokens).
      for (let hop = 0; hop < 10; hop++) {
        const apiMessages = working.map((m) => ({
          role: m.role,
          content: m.blocks.map(blockToApi),
        }));
        const resp = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: PLANNER_TOOLS as unknown as Anthropic.Tool[],
          messages: apiMessages as unknown as Anthropic.MessageParam[],
        });

        // Append the assistant turn (text + any tool_use blocks).
        const assistantBlocks: Block[] = [];
        for (const block of resp.content) {
          if (block.type === "text") {
            assistantBlocks.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            assistantBlocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: (block.input as Record<string, unknown>) ?? {},
            });
          }
        }
        working = [...working, { role: "assistant", blocks: assistantBlocks }];
        setMessages(working);

        if (resp.stop_reason !== "tool_use") {
          break;
        }

        // Execute every tool_use in this turn and append a single
        // user message containing all the tool_results.
        const toolUses = assistantBlocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
        const resultBlocks: Block[] = [];
        for (const tu of toolUses) {
          const result = await executeTool(githubPat, tu.name, tu.input);
          resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: result });
        }
        working = [...working, { role: "user", blocks: resultBlocks }];
        setMessages(working);
      }
      setPhase("idle");
    } catch (e) {
      setPhase({ error: (e as Error).message || "unknown error" });
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const toggleTool = (id: string) =>
    setExpandedTools((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------- render ----------

  if (apiKey === null) {
    // Setup screen: no key configured yet.
    return (
      <div className="p-6 max-w-[600px] mx-auto space-y-4">
        <div className="space-y-2">
          <h2 className="text-[14px] font-semibold text-foreground">
            Set up the Planner agent
          </h2>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            The Planner is your read-only thinking partner. It can browse the codebase,
            check what's queued, and help you decide what to build. Its only write power
            is filing well-formed issues for the implementer agent to execute.
          </p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            Get an Anthropic API key at{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline hover:text-foreground/80"
            >
              console.anthropic.com/settings/keys
            </a>
            . Stored in your OS keychain, never sent anywhere except Anthropic.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            placeholder="sk-ant-…"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveApiKey();
            }}
            className="flex-1 rounded border border-border bg-background px-3 py-2 text-[12.5px] outline-none focus:ring-1 focus:ring-foreground/30"
          />
          <button
            onClick={() => void saveApiKey()}
            disabled={!apiKeyDraft.trim() || savingKey}
            className="text-[12px] px-3 py-1.5 rounded bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {savingKey ? "Saving…" : "Save"}
          </button>
        </div>
        {keyError && <div className="text-[11.5px] text-destructive">{keyError}</div>}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div ref={transcriptRef} className="flex-1 min-h-0 overflow-auto px-4 py-4 space-y-2">
        {messages.length === 0 && (
          <div className="text-center py-12 space-y-2 text-muted-foreground">
            <Wrench className="h-6 w-6 mx-auto text-muted-foreground" />
            <div className="text-[13px] font-medium">Planner ready</div>
            <div className="text-[11.5px] max-w-[400px] mx-auto leading-relaxed">
              Ask "what should I work on?" or describe a problem. I'll look around the
              codebase and recommend a path. I won't ship anything — when you decide
              what to do, I file an issue and the implementer takes it from there.
              {ghLogin && <> · authenticated as <span className="font-mono">{ghLogin}</span></>}
            </div>
          </div>
        )}
        {flattenBlocks(messages).map((b, i) => (
          <BlockRow
            key={i}
            block={b}
            expandedTools={expandedTools}
            toggleTool={toggleTool}
          />
        ))}
        {phase === "thinking" && (
          <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground italic px-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/60 animate-pulse" />
            Thinking…
          </div>
        )}
        {typeof phase === "object" && "error" in phase && (
          <div className="text-[11.5px] text-destructive flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{phase.error}</span>
          </div>
        )}
      </div>
      <div className="border-t border-border bg-card/40 px-4 py-3 space-y-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask the Planner… (Enter to send, Shift+Enter newline)"
            rows={1}
            disabled={phase === "thinking"}
            className="flex-1 rounded border border-border bg-background px-3 py-2 text-[12.5px] outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-50 resize-y min-h-[36px] max-h-[140px]"
          />
          <button
            onClick={() => void send()}
            disabled={phase === "thinking" || !input.trim()}
            className="inline-flex items-center justify-center h-9 w-9 rounded bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground/80">
          <span>{MODEL_ID}</span>
          <span>·</span>
          <button onClick={clearTranscript} className="inline-flex items-center gap-1 hover:text-foreground">
            <Trash2 className="h-3 w-3" /> clear conversation
          </button>
          <span className="ml-auto">
            {messages.length} {messages.length === 1 ? "turn" : "turns"}
          </span>
        </div>
      </div>
    </div>
  );
}

// A single row in the flat transcript. Carries the originating role
// only so we can branch on user-text vs agent-text alignment; tool
// blocks never align right.
type FlatBlock = { role: Role; block: Block };

function flattenBlocks(messages: Message[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  for (const m of messages) {
    for (const b of m.blocks) out.push({ role: m.role, block: b });
  }
  return out;
}

function BlockRow({
  block: fb,
  expandedTools,
  toggleTool,
}: {
  block: FlatBlock;
  expandedTools: Set<string>;
  toggleTool: (id: string) => void;
}) {
  const { role, block } = fb;

  // Text from user → right side, slightly higher-contrast bubble.
  // Text from agent → left side, plain card.
  // Tool calls + results → left side, narrower & subtler (they belong
  // to the agent's stream of work, not the user).
  if (block.type === "text") {
    const isUser = role === "user";
    return (
      <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
        <div
          className={cn(
            "max-w-[80%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed prose-chat",
            isUser
              ? "bg-accent/70 border border-border/70 text-foreground"
              : "bg-card/40 border border-border/40 text-foreground/95",
          )}
        >
          <Markdown text={block.text} />
        </div>
      </div>
    );
  }

  if (block.type === "tool_use") {
    const expanded = expandedTools.has(block.id);
    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[70%] rounded-md border border-border/50 bg-background/40 text-[11.5px] overflow-hidden">
          <button
            onClick={() => toggleTool(block.id)}
            className="w-full flex items-center gap-1.5 px-2.5 py-1 text-left hover:bg-accent/30"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Wrench className="h-3 w-3 text-muted-foreground/80 shrink-0" />
            <span className="font-mono text-foreground/85">{block.name}</span>
            <span className="text-muted-foreground/70 truncate ml-1 font-mono text-[10.5px]">
              ({summarizeInput(block.input)})
            </span>
          </button>
          {expanded && (
            <pre className="px-2.5 py-1.5 text-[10.5px] bg-card/30 border-t border-border/40 overflow-auto max-h-[200px] font-mono whitespace-pre-wrap">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (block.type === "tool_result") {
    const expanded = expandedTools.has(block.tool_use_id + ":result");
    const issueLink = block.content.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/);
    const oneLine = block.content.split("\n")[0]?.slice(0, 100) ?? "";
    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[70%] rounded-md border border-border/50 bg-background/40 text-[11.5px] overflow-hidden ml-4">
          <button
            onClick={() => toggleTool(block.tool_use_id + ":result")}
            className="w-full flex items-center gap-1.5 px-2.5 py-1 text-left hover:bg-accent/30"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="text-muted-foreground/80 shrink-0">→</span>
            <span className="text-muted-foreground/70 truncate text-[10.5px]">{oneLine || "(empty)"}</span>
            {issueLink && (
              <a
                href={issueLink[0]}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-0.5 text-foreground/80 underline hover:text-foreground shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                open <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </button>
          {expanded && (
            <pre className="px-2.5 py-1.5 text-[10.5px] bg-card/30 border-t border-border/40 overflow-auto max-h-[300px] font-mono whitespace-pre-wrap">
              {block.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 last:mb-0 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 last:mb-0 ml-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="text-[15px] font-semibold mb-1.5 mt-2 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[14px] font-semibold mb-1.5 mt-2 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-[13px] font-semibold mb-1 mt-1.5 first:mt-0">{children}</h3>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline text-foreground hover:text-foreground/80"
          >
            {children}
          </a>
        ),
        code: ({ children, ...rest }) => {
          const isBlock = (rest as { className?: string }).className?.startsWith("language-");
          if (isBlock) {
            return (
              <code className="block font-mono text-[11.5px] whitespace-pre overflow-x-auto">
                {children}
              </code>
            );
          }
          return (
            <code className="font-mono text-[11.5px] rounded px-1 py-px bg-muted text-foreground/90">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="rounded-md p-2 my-1.5 text-[11.5px] overflow-x-auto bg-muted">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 pl-2 my-1.5 border-border">{children}</blockquote>
        ),
        hr: () => <hr className="my-2 border-border/50" />,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
    .join(", ");
}

function blockToApi(b: Block): unknown {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use")
    return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  if (b.type === "tool_result")
    return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content };
  return b;
}
