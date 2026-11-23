// The chat's live tail as rows (src/chatRows.ts): what shows under the transcript while the agent works, moved here
// unchanged from ChatPane.tsx and registered as the built-in renderers of four kinds:
//   live-tool           the one-line ticker of the turn's tool calls (the running one, else the newest; its output)
//   reasoning           the reasoning as it streams (until the reply's text starts)
//   stream              the reply as it streams
//   thinking-indicator  the working pulse (with "Thinking" while nothing shows yet)
// A vault plugin draws any of them its own way (api.host.chat.row("stream", …)); app/chat-rows offers them (renderers,
// and the tail on screen now as its `live` state).
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Wrench } from "lucide-react";
import { StreamingMarkdown } from "../../Markdown";
import type { LiveTool } from "../../store";
import { cn } from "../../lib/utils";
import { registerBuiltin } from "../../chatRows";
import { Row, chatComponents } from "./rows";

type Live = { silent: boolean; activeTool?: string; streaming: boolean; reasoning: boolean; liveChars: number };

/** What streams now: the tail's rows (each drawn by its kind's renderer). The DOM is the chat pane's as it was. */
export function LiveTail({ text, reasoning, tools, busy }: { text: string; reasoning: string; tools: LiveTool[]; busy: boolean }) {
  const live: Live | null = busy
    ? {
        silent: !text && !reasoning && tools.length === 0,
        activeTool: tools.find((t) => !t.result)?.name,
        streaming: !!text,
        reasoning: !!reasoning && !text,
        liveChars:
          text.length +
          reasoning.length +
          tools.reduce(
            (n, t) =>
              n +
              // Prefer the live char count from streaming tool-input
              // deltas; fall back to the finalized input size once
              // the tool-call resolves (and inputChars is 0/undefined).
              (t.inputChars && t.inputChars > 0 ? t.inputChars : t.input ? JSON.stringify(t.input).length : 0) +
              (t.result ? t.result.length : 0),
            0,
          ),
      }
    : null;
  return (
    <>
      {(text || reasoning || tools.length > 0) && (
        <div className="space-y-2">
          {tools.length > 0 && <Row kind="live-tool" props={{ tools }} data={{ kind: "live-tool", tools }} />}
          {reasoning && !text && <Row kind="reasoning" props={{ text: reasoning }} data={{ kind: "reasoning", text: reasoning }} />}
          {text && <Row kind="stream" props={{ text }} data={{ kind: "stream", text }} />}
        </div>
      )}
      {live && <Row kind="thinking-indicator" props={live} data={{ kind: "thinking-indicator", live }} />}
    </>
  );
}

/** The reply as it streams. Finished blocks render once each with the full pipeline; only the open tail re-renders per
 *  flush (re-rendering the whole growing reply every flush was O(N²) and locked the main thread). */
function StreamRow({ text }: { text: string }) {
  return (
    <div className="prose-chat text-foreground/95" data-el="stream">
      <StreamingMarkdown text={text} components={chatComponents} />
    </div>
  );
}

function toolSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const primary = input.path ?? input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.from ?? null;
  if (primary != null && typeof primary !== "object") {
    const extra = input.to != null ? ` → ${input.to}` : input.old_string != null ? ` (edit)` : input.glob_filter != null ? ` [${input.glob_filter}]` : "";
    return `${primary}${extra}`;
  }
  const first = Object.values(input)[0];
  return typeof first === "object" || first == null ? "" : String(first);
}

// Single-line ticker for live tool calls. Instead of stacking every
// tool invocation, it shows only the most recent one, cross-fading
// between entries as they arrive. A small count in the corner makes it
// clear more than one tool has run in this turn.
function LiveToolTicker({ tools }: { tools: LiveTool[] }) {
  // Prefer showing a still-running tool over the most-recently-added one.
  // Otherwise a fast-completing tool added late (e.g. a Read) hides a
  // slow tool that started first (e.g. a Bash subprocess).
  const latest = tools.find((t) => !t.result) ?? tools[tools.length - 1];
  if (!latest) return null;
  const running = !latest.result;
  // A subagent call waiting on its children: the background-tasks chip shows them moving, not a bare timer.
  if (running && latest.name === "subagent") return null;
  return (
    <div className="space-y-1">
    <div data-el="live-tool" className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground overflow-hidden">
      <Wrench className={cn("h-3 w-3 shrink-0", running && "animate-pulse")} />
      <span key={latest.id} className="live-tool-flip flex min-w-0 flex-1 items-center gap-2">
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
      {running ? <span className="opacity-40 shrink-0">…</span> : <span className="text-emerald-500 shrink-0">✓</span>}
    </div>
    {running && latest.partial && (
      <pre data-el="live-tool-output" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border/40 bg-muted/30 p-2 text-[10.5px] font-mono text-muted-foreground">
        {latest.partial}
      </pre>
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
      <button data-offer="app/chat-rows.toolRows" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 w-full px-2.5 py-1 text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3 rotate-180" />}
        <span className="italic">Thinking…</span>
      </button>
      {open && (
        <div ref={tailRef} className="px-2.5 pb-2 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground/80 leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

export function ThinkingIndicator({ liveChars, silent }: { silent?: boolean; activeTool?: string; streaming?: boolean; reasoning?: boolean; liveChars?: number }) {
  // No raw token count: it said nothing about the work (Carl). The pulse alone says it runs.
  void liveChars;
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
    </div>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

registerBuiltin("live-tool", LiveToolTicker);
registerBuiltin("reasoning", ReasoningStream);
registerBuiltin("stream", StreamRow);
registerBuiltin("thinking-indicator", ThinkingIndicator);
