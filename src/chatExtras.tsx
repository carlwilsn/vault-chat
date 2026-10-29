// The parts of a box-run (or local) conversation the chat shows beside the
// text: the model's thinking, AskUser options, the subagents a turn spawned,
// the Done verifier's verdict and what a reply cost. Quiet, in the chat's own
// vocabulary (the tool-call summary line, the plan card, the system line).
// Where Carl has a presentation choice to make, uiChoices.ts picks the option.
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Conversation } from "./conversations";
import type { ChatMessage } from "./store";
import { cn } from "./lib/utils";
import { formatCost } from "./ongoingWork";
import { uiChoice } from "./uiChoices";
import { elapsedText, taskActivity, taskElapsed, taskName, taskState, tasksSummary, type TaskState } from "./backgroundTasks";

export type SubagentRec = NonNullable<Conversation["subagents"]>[number];
export type Verdict = NonNullable<Conversation["verdict"]>;

// ---------------------------------------------------------------- thinking

/** The reply's thinking: a collapsed "Thought" line (click to read). */
export function Thought({ text }: { text: string }) {
  if (!text.trim()) return null;
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

/** The box writes an AskUser's options into the text too ("1. …\n2. …", for
 *  clients that don't draw them); where they are drawn, that list goes. */
export function withoutOptionList(content: string, options: AskOption[]): string {
  const list = options.map((o, i) => `${i + 1}. ${o.answer}`).join("\n");
  return content.endsWith(list) ? content.slice(0, -list.length).trimEnd() : content;
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

// ---------------------------------------------------------------- background tasks

/** Re-render every second while `on` (a running task's elapsed time). */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** The live pulse of a running task (quiet: one dot breathing), or its end's dot. */
function TaskDot({ state }: { state: TaskState }) {
  if (state === "running")
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0" data-el="task-pulse">
        <span className="absolute inset-0 rounded-full bg-primary opacity-60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  return <span className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", state === "done" ? "bg-emerald-600" : state === "stopped" ? "bg-muted-foreground/50" : "bg-destructive/70")} />;
}

function TaskRow({ s, now, onControl }: { s: SubagentRec; now: number; onControl?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null> }) {
  const st = taskState(s);
  const running = st === "running";
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
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
    <li className="space-y-0.5" data-el="task" data-sid={s.threadId} data-state={st}>
      <div className="flex items-center gap-2 text-[12px] leading-relaxed">
        <TaskDot state={st} />
        <span className="min-w-0 flex-1 truncate text-foreground/90" title={s.task ?? s.prompt}>
          {taskName(s)}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums" data-el="task-elapsed">
          {elapsedText(taskElapsed(s, now))}
        </span>
        {running && onControl && (
          <span className="shrink-0 flex items-center gap-2 text-[10.5px]">
            {s.kind !== "job" && (
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setSteering((v) => !v)} data-el="task-steer">
                Steer
              </button>
            )}
            <button className="text-muted-foreground hover:text-destructive" onClick={() => void control("stop")} data-el="task-stop">
              Stop
            </button>
          </span>
        )}
      </div>
      <div className={cn("pl-4 text-[11px] truncate", running ? "text-muted-foreground" : "text-muted-foreground/70")} data-el="task-activity" title={s.said || undefined}>
        {taskActivity(s)}
      </div>
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
            data-el="task-steer-input"
            className="w-full bg-transparent outline-none text-[11.5px] px-2 py-1 rounded border border-border focus:border-ring/40 placeholder:text-muted-foreground/60"
          />
        </form>
      )}
      {err && <div className="pl-4 text-[11px] text-destructive">{err}</div>}
    </li>
  );
}

/** Background tasks as Claude Code shows them: one compact chip ("2 background tasks: 1 running, 1 done", and the
 *  newest running task's latest step while one runs); a click opens the list. In the thread under the reply that
 *  started them ("inline") or above the composer ("strip"). */
export function Subagents({
  list,
  variant,
  onControl,
  defaultOpen,
}: {
  list: SubagentRec[];
  variant: "inline" | "strip";
  onControl?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
  /** Start opened (the chip starts closed; tests). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const running = list.filter((s) => taskState(s) === "running");
  const now = useTick(running.length > 0);
  const box = useRef<HTMLDivElement>(null);
  // Open only while he looks: Esc or a click anywhere else folds it back to its one line.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // This Esc only folds the list (it never also stops the agent).
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  if (!list.length) return null;
  const lead = running[running.length - 1];
  return (
    <div ref={box} data-el="subagents" data-variant={variant} data-open={open ? "1" : "0"} data-running={running.length} className={cn("rounded-md border border-border/60 bg-muted/30", variant === "strip" && "mb-1.5")}>
      <button type="button" onClick={() => setOpen((v) => !v)} data-el="tasks-chip" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground min-w-0">
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-0" : "-rotate-90")} />
        {lead ? <TaskDot state="running" /> : null}
        <span className="shrink-0" data-el="tasks-summary">
          {tasksSummary(list)}
        </span>
        {lead && !open && (
          <span className="min-w-0 truncate opacity-80" data-el="tasks-lead">
            · {taskActivity(lead)} · {elapsedText(taskElapsed(lead, now))}
          </span>
        )}
      </button>
      {open && (
        <ul className={cn("space-y-1.5 px-2.5 pb-2", variant === "strip" && "max-h-48 overflow-auto")}>
          {list.map((s) => (
            <TaskRow key={s.threadId} s={s} now={now} onControl={onControl} />
          ))}
        </ul>
      )}
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
