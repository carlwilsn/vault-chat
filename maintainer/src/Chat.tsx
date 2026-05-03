import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Anthropic from "@anthropic-ai/sdk";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, AlertTriangle, Trash2, Wrench, ChevronDown, ExternalLink, Key, Eye, EyeOff, Copy, Check } from "lucide-react";
import { PLANNER_TOOLS, executeTool } from "./planner-tools";
import { OWNER, REPO } from "./github";
import { useStore } from "./store";
import { cn } from "./lib";

function maskKey(k: string): string {
  if (!k) return "(no key set)";
  if (k.length <= 12) return "•".repeat(k.length);
  return `${k.slice(0, 7)}${"•".repeat(8)}${k.slice(-4)}`;
}

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
- requeue_issue — FORCE-FIRE the implementer on any issue regardless of its current state. Use when Carl says "run #N again", "retry", "force-run", or when an item is stuck without progress. Toggles the auto-fix:queued label off and on; the re-add fires a fresh implementer session within seconds. Confirm the number first.

# How the implementer pipeline works (so you can answer Carl accurately)
- When an issue is labelled \`auto-fix:queued\`, the GitHub Actions \`implementer\` workflow fires immediately and spawns a fresh Claude session that processes that one issue end-to-end. There is no cron — "queued" means "running within seconds."
- The implementer's session runs on GitHub Actions, not on Carl's machine. Carl's only role is to verify in the Triage tab once the fix lands.
- If Carl asks "when will this run?" the answer is "any moment — the workflow fires on the label-add event." If you want to be precise, use list_workflow_runs(workflow="implementer.yml") to show the actual run.
- Don't speculate about cron schedules or "every few hours" cadence — that's wrong.

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

// Live tool entry while the agent is running
type LiveTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  startedAt: number;
};

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
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
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
  }, [messages, phase, liveTools]);

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

  const copyKey = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setKeyError(`Couldn't copy: ${(e as Error).message}`);
    }
  };

  const replaceKey = async () => {
    const v = apiKeyDraft.trim();
    if (!v) return;
    setSavingKey(true);
    try {
      await invoke("keychain_set", { key: ANTHROPIC_KEY, value: v });
      setApiKey(v);
      setApiKeyDraft("");
      setKeyRevealed(false);
      setKeyError(null);
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setSavingKey(false);
    }
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
    setLiveTools([]);
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

        // Show live tool ticker while tools are executing.
        const hopTools: LiveTool[] = toolUses.map((tu) => ({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          startedAt: Date.now(),
        }));
        setLiveTools(hopTools);

        for (const tu of toolUses) {
          const result = await executeTool(githubPat, tu.name, tu.input);
          resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          setLiveTools((prev) =>
            prev.map((t) => (t.id === tu.id ? { ...t, result } : t)),
          );
        }
        working = [...working, { role: "user", blocks: resultBlocks }];
        setMessages(working);
        setLiveTools([]);
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

  // Auto-grow textarea up to ~140px.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 140)}px`;
    }
  }, [input]);

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
      <div ref={transcriptRef} className="flex-1 min-h-0 overflow-auto px-4 py-4 space-y-3">
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
          />
        ))}
        {phase === "thinking" && liveTools.length > 0 && (
          <LiveToolTicker tools={liveTools} />
        )}
        {phase === "thinking" && liveTools.length === 0 && (
          <ThinkingIndicator />
        )}
        {typeof phase === "object" && "error" in phase && (
          <div className="text-[11.5px] text-destructive flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{phase.error}</span>
          </div>
        )}
      </div>
      <div className="border-t border-border bg-card/40 px-4 py-3 space-y-2">
        {showKeyPanel && (
          <div className="rounded border border-border bg-background/60 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Anthropic API key
              </div>
              <button
                onClick={() => {
                  setShowKeyPanel(false);
                  setKeyRevealed(false);
                  setApiKeyDraft("");
                  setKeyError(null);
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                close
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate font-mono text-[11.5px] bg-muted/40 px-2 py-1.5 rounded">
                {keyRevealed ? apiKey : maskKey(apiKey ?? "")}
              </code>
              <button
                onClick={() => setKeyRevealed((v) => !v)}
                className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
                title={keyRevealed ? "Hide" : "Reveal"}
              >
                {keyRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => void copyKey()}
                className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
                title="Copy to clipboard"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="text-[10.5px] text-muted-foreground/80 leading-relaxed">
              Paste this same key into{" "}
              <a
                href={`https://github.com/${OWNER}/${REPO}/settings/secrets/actions`}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline hover:text-foreground/80"
              >
                GitHub Secrets
              </a>{" "}
              as <span className="font-mono">ANTHROPIC_API_KEY</span> so the implementer workflow can run.
            </div>
            <div className="border-t border-border/60 pt-2 space-y-1.5">
              <div className="text-[11px] font-semibold text-muted-foreground">Replace key</div>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="sk-ant-…"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void replaceKey();
                  }}
                  className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-foreground/30"
                />
                <button
                  onClick={() => void replaceKey()}
                  disabled={!apiKeyDraft.trim() || savingKey}
                  className="text-[11.5px] px-2.5 py-1.5 rounded bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
                >
                  {savingKey ? "Saving…" : "Save"}
                </button>
              </div>
              {keyError && <div className="text-[10.5px] text-destructive">{keyError}</div>}
            </div>
          </div>
        )}
        <div className="relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask the Planner… (Enter to send, Shift+Enter newline)"
            rows={1}
            disabled={phase === "thinking"}
            className="w-full bg-transparent min-h-0 resize-none outline-none border-0 px-3 py-2.5 text-[12.5px] disabled:opacity-50 pr-12"
            style={{ maxHeight: "140px" }}
          />
          <div className="absolute right-2 bottom-2">
            <button
              onClick={() => void send()}
              disabled={phase === "thinking" || !input.trim()}
              className="inline-flex items-center justify-center h-7 w-7 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground/80">
          <span>{MODEL_ID}</span>
          <span>·</span>
          <button onClick={clearTranscript} className="inline-flex items-center gap-1 hover:text-foreground">
            <Trash2 className="h-3 w-3" /> clear conversation
          </button>
          <span>·</span>
          <button
            onClick={() => setShowKeyPanel((v) => !v)}
            className="inline-flex items-center gap-1 hover:text-foreground"
            title="View, copy, or replace your Anthropic API key"
          >
            <Key className="h-3 w-3" /> manage key
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
  // Group assistant tool_use blocks with the next user tool_result turn
  // so they render as a collapsible details block instead of scattered rows.
  const grouped: FlatBlock[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // Collect text blocks normally; batch all tool calls from an assistant
    // turn into a single ToolCallGroup block.
    const toolUses = m.blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    const textBlocks = m.blocks.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text");

    for (const b of textBlocks) {
      grouped.push({ role: m.role, block: b });
    }

    if (toolUses.length > 0 && m.role === "assistant") {
      // Find the matching result turn (next user message with tool_result blocks).
      const resultMsg = messages[i + 1];
      const results: Array<{ tool_use_id: string; content: string }> = [];
      if (resultMsg?.role === "user") {
        for (const rb of resultMsg.blocks) {
          if (rb.type === "tool_result") {
            results.push({ tool_use_id: rb.tool_use_id, content: rb.content });
          }
        }
      }
      grouped.push({
        role: "assistant",
        block: {
          type: "tool_use" as const,
          id: toolUses[0].id,
          name: toolUses.map((t) => t.name).join(", "),
          input: { _tools: toolUses, _results: results } as unknown as Record<string, unknown>,
        },
      });
      // Skip the result turn since we embedded it above.
      if (results.length > 0) i++;
    }
  }
  return grouped;
}

function BlockRow({ block: fb }: { block: FlatBlock }) {
  const { role, block } = fb;

  if (block.type === "text") {
    const isUser = role === "user";
    return (
      <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
        {isUser ? (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden">
            <Markdown text={block.text} isUser />
          </div>
        ) : (
          <div className="w-full prose-chat text-foreground/95">
            <Markdown text={block.text} isUser={false} />
          </div>
        )}
      </div>
    );
  }

  if (block.type === "tool_use") {
    const rawInput = block.input as { _tools?: Array<{ id: string; name: string; input: Record<string, unknown> }>; _results?: Array<{ tool_use_id: string; content: string }> };
    const tools = rawInput._tools ?? [];
    const results = rawInput._results ?? [];

    if (tools.length === 0) return null;

    const count = tools.length;
    return (
      <details className="group">
        <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
          <Wrench className="h-3 w-3" />
          <span>{count} tool call{count === 1 ? "" : "s"}</span>
        </summary>
        <div className="mt-2 space-y-2 pl-4 border-l border-border">
          {tools.map((t, j) => {
            const res = results.find((r) => r.tool_use_id === t.id);
            const issueLink = res?.content.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/);
            return (
              <div key={j} className="space-y-1">
                <div className="text-[11px] font-mono text-primary">{t.name}</div>
                <pre className="text-[10.5px] font-mono bg-muted/60 border border-border/40 rounded p-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(t.input, null, 2)}
                </pre>
                {res && (
                  <div className="space-y-0.5">
                    <pre className="text-[10.5px] font-mono bg-muted/30 border border-border/40 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                      {res.content.length > 1200 ? `${res.content.slice(0, 1200)}…` : res.content}
                    </pre>
                    {issueLink && (
                      <a
                        href={issueLink[0]}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-[10.5px] text-foreground/80 underline hover:text-foreground"
                      >
                        open <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  return null;
}

function Markdown({ text, isUser }: { text: string; isUser: boolean }) {
  if (isUser) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-1.5 last:mb-0 ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-1.5 last:mb-0 ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          code: ({ children }) => (
            <code className="font-mono text-[11.5px] rounded px-1 py-px bg-primary-foreground/20 text-primary-foreground">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="rounded p-2 my-1.5 text-[11.5px] overflow-x-auto bg-primary-foreground/15 font-mono">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline opacity-90 hover:opacity-100">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
        }}
      >
        {text}
      </ReactMarkdown>
    );
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 last:mb-0 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 last:mb-0 ml-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="text-base font-semibold mb-1.5 mt-3 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[14px] font-semibold mb-1.5 mt-3 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-[13px] font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline text-primary underline-offset-2 hover:opacity-80"
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
            <code className="font-mono text-[11.5px] rounded px-1.5 py-0.5 bg-muted text-foreground/90">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="rounded-lg p-3 my-2 text-[11.5px] overflow-x-auto bg-muted/60 border border-border/60 font-mono">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 pl-3 my-2 border-border text-muted-foreground">{children}</blockquote>
        ),
        hr: () => <hr className="my-4 border-border" />,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// Single-line ticker for live tool calls during execution.
function LiveToolTicker({ tools }: { tools: LiveTool[] }) {
  const latest = tools.find((t) => !t.result) ?? tools[tools.length - 1];
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
        <span className="opacity-70 truncate" title={summarizeInput(latest.input)}>
          {summarizeInput(latest.input)}
        </span>
      </span>
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

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1 text-foreground/80">
      <span className="relative inline-flex h-3 w-3 vc-pulse-drift">
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-a" />
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-b" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-current vc-pulse-core" />
      </span>
    </div>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([k]) => !k.startsWith("_"));
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
