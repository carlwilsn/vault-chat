import { useEffect, useState } from "react";
import { RefreshCw, RotateCw, ExternalLink } from "lucide-react";
import {
  type Issue,
  listIssuesByLabel,
  postIssueComment,
  setIssueLabels,
} from "./github";
import { cn, relativeTime } from "./lib";

// Triage tab — issues the auto-fix agent kicked back as
// `auto-fix:needs-review` or `auto-fix:agent-error`. Each row gets a
// guidance textarea + Re-queue button. Sending re-labels the issue
// to `auto-fix:queued` (and posts the guidance as a comment first
// so the agent reads it on the next run).

const LABEL_NEEDS_REVIEW = "auto-fix:needs-review";
const LABEL_AGENT_ERROR = "auto-fix:agent-error";
const LABEL_QUEUED = "auto-fix:queued";
const ALL_AUTOFIX = [
  LABEL_QUEUED,
  "auto-fix:awaiting-verification",
  LABEL_NEEDS_REVIEW,
  LABEL_AGENT_ERROR,
];

type ActionState = "idle" | "running" | { error: string };

export function Triage({ token }: { token: string }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<Record<number, string>>({});
  const [actions, setActions] = useState<Record<number, ActionState>>({});

  const refresh = async () => {
    try {
      const [needsReview, agentError] = await Promise.all([
        listIssuesByLabel(token, LABEL_NEEDS_REVIEW),
        listIssuesByLabel(token, LABEL_AGENT_ERROR),
      ]);
      // Dedupe by number in case an issue carries both labels.
      const map = new Map<number, Issue>();
      for (const i of [...needsReview, ...agentError]) map.set(i.number, i);
      setIssues(Array.from(map.values()).sort((a, b) => b.number - a.number));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const reQueue = async (issue: Issue) => {
    setActions((m) => ({ ...m, [issue.number]: "running" }));
    try {
      const note = (guidance[issue.number] ?? "").trim();
      if (note) {
        await postIssueComment(
          token,
          issue.number,
          `**Guidance from user before re-queue (via maintainer):**\n\n${note}`,
        );
      }
      const keep = issue.labels
        .map((l) => l.name)
        .filter((n) => !ALL_AUTOFIX.includes(n));
      await setIssueLabels(token, issue.number, [...keep, LABEL_QUEUED]);
      await refresh();
      setGuidance((g) => {
        const { [issue.number]: _, ...rest } = g;
        return rest;
      });
      setActions((m) => ({ ...m, [issue.number]: "idle" }));
    } catch (e) {
      setActions((m) => ({ ...m, [issue.number]: { error: (e as Error).message } }));
    }
  };

  return (
    <div className="p-4 max-w-[820px] space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Needs review / agent error
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>
      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
        Bugs the auto-fix agent couldn't land cleanly. Add guidance, re-queue, and the
        agent will pick it up on its next routine run.
      </p>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      <div className="space-y-2">
        {issues === null && !error && (
          <div className="px-3 py-2 text-[11.5px] text-muted-foreground italic">Loading…</div>
        )}
        {issues && issues.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-muted-foreground italic">
            Nothing in the queue. Tidy.
          </div>
        )}
        {issues && issues.map((i) => {
          const isAgentError = i.labels.some((l) => l.name === LABEL_AGENT_ERROR);
          const a = actions[i.number] ?? "idle";
          const stError = typeof a === "object" && "error" in a ? a.error : null;
          return (
            <div
              key={i.number}
              className="rounded border border-border bg-card/40 p-3 space-y-2"
            >
              <div className="flex items-start gap-2 text-[12.5px]">
                <span className={cn(
                  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold",
                  isAgentError
                    ? "bg-rose-500/15 text-rose-400 border-rose-500/40"
                    : "bg-amber-500/15 text-amber-500 border-amber-500/40",
                )}>
                  {isAgentError ? "agent err" : "review"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{i.title}</span>
                    <span className="text-[10.5px] text-muted-foreground/80 font-mono shrink-0">
                      #{i.number}
                    </span>
                  </div>
                  <div className="text-[10.5px] text-muted-foreground/80">
                    filed {relativeTime(i.created_at)} · updated {relativeTime(i.updated_at)}
                  </div>
                </div>
                <a
                  href={i.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline inline-flex items-center gap-0.5 text-[11px] shrink-0"
                >
                  open <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <textarea
                value={guidance[i.number] ?? ""}
                onChange={(e) => setGuidance((g) => ({ ...g, [i.number]: e.target.value }))}
                placeholder="Optional: leave a note for the agent before re-queueing…"
                rows={3}
                disabled={a === "running"}
                className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void reQueue(i)}
                  disabled={a === "running"}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border bg-indigo-500 hover:bg-indigo-400 text-white border-indigo-500 disabled:opacity-50"
                >
                  <RotateCw className="h-3 w-3" />
                  {a === "running" ? "Re-queueing…" : (guidance[i.number] ?? "").trim() ? "Re-queue with note" : "Re-queue"}
                </button>
                {stError && <span className="text-[11px] text-destructive truncate">{stError}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
