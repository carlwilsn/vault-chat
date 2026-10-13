// The parts of a box-run (or local) conversation the chat shows beside the
// text: the model's thinking, AskUser options, the subagents a turn spawned,
// the Done verifier's verdict and what a reply cost. Quiet, in the chat's own
// vocabulary (the tool-call summary line, the plan card, the system line).
// Where Carl has a presentation choice to make, uiChoices.ts picks the option.
import { useState, useSyncExternalStore } from "react";
import { ChevronDown, Brain } from "lucide-react";
import type { Conversation } from "./conversations";
import type { ChatMessage } from "./store";
import { cn } from "./lib/utils";
import { formatCost } from "./ongoingWork";
import { uiChoice } from "./uiChoices";

export type SubagentRec = NonNullable<Conversation["subagents"]>[number];
export type Verdict = NonNullable<Conversation["verdict"]>;

// ---------------------------------------------------------------- thinking

const SHOW_KEY = "vc_show_thinking";
let showThinking = (() => {
  try {
    return localStorage.getItem(SHOW_KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();
function setShowThinking(v: boolean): void {
  showThinking = v;
  try {
    localStorage.setItem(SHOW_KEY, v ? "1" : "0");
  } catch {
    /* per-device convenience */
  }
  for (const l of listeners) l();
}
export function useShowThinking(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => showThinking,
  );
}

/** The reply's thinking: a collapsed "Thought" line ("line"), or hidden until
 *  the composer row's toggle is on ("toggle"). */
export function Thought({ text }: { text: string }) {
  const shown = useShowThinking();
  if (!text.trim()) return null;
  if (uiChoice("thinking") === "toggle") {
    if (!shown) return null;
    return (
      <div data-el="thinking" className="pl-3 border-l border-border text-[11.5px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap max-h-60 overflow-auto">
        {text}
      </div>
    );
  }
  return (
    <details className="group" data-el="thinking">
      <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        <span>Thought</span>
      </summary>
      <div className="mt-1.5 pl-4 border-l border-border text-[11.5px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap max-h-60 overflow-auto">{text}</div>
    </details>
  );
}

/** The composer row's toggle ("toggle" option only, and only when there is thinking to show). */
export function ThinkingToggle({ visible }: { visible: boolean }) {
  const shown = useShowThinking();
  if (uiChoice("thinking") !== "toggle" || !visible) return null;
  return (
    <button
      onClick={() => setShowThinking(!shown)}
      className={cn("flex items-center hover:text-foreground transition-colors", shown ? "text-foreground" : "text-muted-foreground")}
      title={shown ? "Hide thinking" : "Show thinking"}
      data-el="thinking-toggle"
      aria-pressed={shown}
    >
      <Brain className="h-3 w-3" />
    </button>
  );
}

// ---------------------------------------------------------------- AskUser

export type AskOption = NonNullable<ChatMessage["askOptions"]>[number];

/** The question's options. `live`: still the open fork (nothing answered after
 *  it); `chosen`: the answer given, shown as the pick. */
export function AskOptions({ options, live, chosen, onPick }: { options: AskOption[]; live: boolean; chosen: string; onPick: (answer: string) => void }) {
  const [picked, setPicked] = useState("");
  const pick = chosen || picked;
  const open = live && !pick;
  const shown = pick ? options.filter((o) => o.answer === pick) : options;
  const go = (o: AskOption) => {
    if (!open) return;
    setPicked(o.answer);
    onPick(o.answer);
  };
  if (uiChoice("ask") === "buttons") {
    return (
      <div className="flex flex-wrap gap-1.5" data-el="ask-options" data-live={open ? "1" : "0"}>
        {shown.map((o) => (
          <button
            key={o.answer}
            onClick={() => go(o)}
            disabled={!open}
            data-el="ask-option"
            title={o.body || o.title}
            className={cn(
              "h-7 px-2.5 rounded-lg border text-[12px] transition-colors",
              pick === o.answer ? "border-ring/50 bg-accent text-foreground" : "border-border text-foreground/90 hover:bg-accent/60",
              !open && pick !== o.answer && "opacity-60",
            )}
          >
            <span className="text-muted-foreground tabular-nums mr-1.5">{options.indexOf(o) + 1}</span>
            {o.title || o.answer}
            {pick === o.answer && <span className="ml-1.5 text-muted-foreground">✓</span>}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5" data-el="ask-options" data-live={open ? "1" : "0"}>
      {shown.map((o) => (
        <button
          key={o.answer}
          onClick={() => go(o)}
          disabled={!open}
          data-el="ask-option"
          className={cn(
            "block w-full text-left rounded-lg border px-3 py-2 transition-colors",
            pick === o.answer ? "border-ring/50 bg-accent/60" : o.primary ? "border-ring/30" : "border-border",
            open && "hover:bg-accent/60 cursor-pointer",
            !open && pick !== o.answer && "opacity-60",
          )}
        >
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
            <span className="min-w-0 flex-1">{o.title || o.answer}</span>
            <span className="shrink-0 text-[10.5px] font-normal text-muted-foreground">{pick === o.answer ? "✓ your call" : open ? "choose →" : ""}</span>
          </div>
          {o.body && <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{o.body}</div>}
        </button>
      ))}
    </div>
  );
}

/** The answer a later user turn gave to the options at `i` (verbatim option text), or "". */
export function chosenAnswer(messages: ChatMessage[], i: number): string {
  const opts = messages[i]?.askOptions ?? [];
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j]!;
    if (m.role !== "user" || m.hidden) continue;
    const t = (m.content ?? "").trim();
    if (opts.some((o) => o.answer === t)) return t;
  }
  return "";
}

// ---------------------------------------------------------------- subagents

function stateOf(s: SubagentRec): string {
  return String(s.state ?? s.status ?? "running");
}

function SubagentRow({ s, onControl }: { s: SubagentRec; onControl?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null> }) {
  const st = stateOf(s);
  const running = st === "running";
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const model = (s.model ?? "").split("/").pop();
  const cost = formatCost(s.costUsd);
  const control = async (op: "steer" | "stop", t?: string) => {
    if (!onControl) return;
    setErr("");
    const e = await onControl(s.threadId, op, t);
    if (e) setErr(e);
    else if (op === "steer") {
      setText("");
      setSteering(false);
    }
  };
  return (
    <li className="space-y-0.5" data-el="subagent" data-sid={s.threadId} data-state={st}>
      <div className="flex items-start gap-2 text-[12px] leading-relaxed">
        <span
          className={cn(
            "mt-[5px] h-2 w-2 shrink-0 rounded-full",
            running ? "bg-primary animate-pulse" : st === "completed" ? "bg-emerald-600" : "bg-destructive/70",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-foreground/90" title={s.task ?? s.prompt}>
          {s.task ?? s.prompt ?? "subagent"}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
          {[running ? "running" : st, model, cost].filter(Boolean).join(" · ")}
        </span>
        {running && onControl && (
          <span className="shrink-0 flex items-center gap-2 text-[10.5px]">
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setSteering((v) => !v)} data-el="subagent-steer">
              Steer
            </button>
            <button className="text-muted-foreground hover:text-destructive" onClick={() => void control("stop")} data-el="subagent-stop">
              Stop
            </button>
          </span>
        )}
      </div>
      {!running && s.summary && <div className="pl-4 text-[11.5px] leading-relaxed text-muted-foreground line-clamp-2" data-el="subagent-summary">{s.summary}</div>}
      {steering && running && (
        <form
          className="pl-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void control("steer", text.trim());
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Tell it…"
            className="w-full bg-transparent outline-none text-[11.5px] px-2 py-1 rounded border border-border focus:border-ring/40 placeholder:text-muted-foreground/60"
          />
        </form>
      )}
      {err && <div className="pl-4 text-[11px] text-destructive">{err}</div>}
    </li>
  );
}

/** Subagents as a card (in the thread) or a strip (above the composer). */
export function Subagents({
  list,
  variant,
  onControl,
}: {
  list: SubagentRec[];
  variant: "inline" | "strip";
  onControl?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
}) {
  if (!list.length) return null;
  const running = list.filter((s) => stateOf(s) === "running").length;
  return (
    <div
      data-el="subagents"
      data-variant={variant}
      className={cn(
        "rounded-md border border-border/60 bg-muted/30 space-y-1",
        variant === "inline" ? "p-2.5" : "px-2.5 py-1.5 mb-1.5 max-h-36 overflow-auto",
      )}
    >
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Subagents</span>
        <span className="font-mono">{running ? `${running} running` : `${list.length} done`}</span>
      </div>
      <ul className="space-y-1">
        {list.map((s) => (
          <SubagentRow key={s.threadId} s={s} onControl={onControl} />
        ))}
      </ul>
    </div>
  );
}

/** The subagents of one reply: by the spawning call's toolCallId (or the child ids it carries). */
export function subagentsOfMessage(m: ChatMessage, all: SubagentRec[]): SubagentRec[] {
  const calls = m.toolCalls ?? [];
  if (!calls.length || !all.length) return [];
  const ids = new Set(calls.flatMap((t) => t.subagents ?? []));
  const callIds = new Set(calls.map((t) => t.id).filter(Boolean));
  return all.filter((s) => ids.has(s.threadId) || (s.toolCallId && callIds.has(s.toolCallId)));
}

/** A legacy duplicate: the per-child "Subagent" record an older engine added beside the `subagent` call. */
export function isLegacySubagentRecord(t: { id?: string; name: string }): boolean {
  return t.name === "Subagent" && typeof t.id === "string" && t.id.startsWith("sub-");
}

// ---------------------------------------------------------------- verdict, cost

export function verdictText(v: Verdict): string {
  const word = v.verdict === "pass" ? "passed" : v.verdict === "fail" ? "failed" : "unsure";
  const note = (v.notes ?? []).find((n) => n && n.trim());
  return `Verifier ${word}${note ? ` — ${note.trim()}` : ""}`;
}

/** The Done verifier's verdict as the thread's last line ("thread" option). */
export function VerdictLine({ verdict }: { verdict: Verdict }) {
  return (
    <div
      data-el="verdict"
      data-verdict={verdict.verdict}
      className={cn("flex items-center justify-center gap-2 py-2 text-[11px]", verdict.verdict === "fail" ? "text-destructive" : "text-muted-foreground")}
    >
      <div className="h-px w-8 bg-border" />
      <span className="flex items-center gap-1.5 min-w-0">
        <span className={cn("inline-flex h-1.5 w-1.5 rounded-full shrink-0", verdict.verdict === "pass" ? "bg-emerald-600" : verdict.verdict === "fail" ? "bg-destructive" : "bg-muted-foreground/50")} />
        <span className="truncate">Done · {verdictText(verdict)}</span>
      </span>
      <div className="h-px w-8 bg-border" />
    </div>
  );
}

/** One reply's cost, quietly under it ("reply" option). */
export function ReplyCost({ m }: { m: ChatMessage }) {
  const usd = typeof m.costUsd === "number" ? m.costUsd : m.usage?.costUsd;
  const c = formatCost(usd);
  if (!c || uiChoice("cost") !== "reply") return null;
  return (
    <div className="text-[10.5px] text-muted-foreground/70 tabular-nums" data-el="reply-cost">
      {c}
    </div>
  );
}
