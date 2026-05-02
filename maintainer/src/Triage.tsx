import { useEffect, useState } from "react";
import {
  RefreshCw,
  RotateCw,
  ExternalLink,
  X as XIcon,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  type Issue,
  type IssueComment,
  listIssuesByLabel,
  listIssueComments,
  postIssueComment,
  setIssueLabels,
  closeIssue,
} from "./github";
import { useStore } from "./store";
import { cn, relativeTime } from "./lib";

// Triage tab — the morning briefing surface for issues that need
// the user's attention. Two sections:
//
//   Ready to verify   — agent shipped a fix, user confirms it works
//   Needs your help   — agent couldn't land cleanly, needs guidance
//
// Cards are written in user-words (not GitHub-issue jargon): the
// issue title is what they typed, the verification steps come from
// the agent's most recent comment. Three actions per card depending
// on section: looks-good / not-quite-right / forget-about-it for
// verify; re-queue-with-note / forget for help.

const LABEL_AWAITING = "auto-fix:awaiting-verification";
const LABEL_NEEDS_REVIEW = "auto-fix:needs-review";
const LABEL_AGENT_ERROR = "auto-fix:agent-error";
const LABEL_QUEUED = "auto-fix:queued";
const ALL_AUTOFIX = [LABEL_QUEUED, LABEL_AWAITING, LABEL_NEEDS_REVIEW, LABEL_AGENT_ERROR];

type ActionState = "idle" | "running" | { error: string };

type IssueWithLatest = {
  issue: Issue;
  latestAgentComment: IssueComment | null;
};

export function Triage({ token }: { token: string }) {
  const ghLogin = useStore((s) => s.ghLogin);
  const [verify, setVerify] = useState<IssueWithLatest[] | null>(null);
  const [help, setHelp] = useState<IssueWithLatest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<Record<number, string>>({});
  const [actions, setActions] = useState<Record<number, ActionState>>({});
  const [confirmClose, setConfirmClose] = useState<Record<number, boolean>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const refresh = async () => {
    try {
      const [awaiting, needsReview, agentError] = await Promise.all([
        listIssuesByLabel(token, LABEL_AWAITING),
        listIssuesByLabel(token, LABEL_NEEDS_REVIEW),
        listIssuesByLabel(token, LABEL_AGENT_ERROR),
      ]);
      // Pull latest agent comment per issue so we can show the
      // verification steps without making the user click "details."
      const enrich = async (issues: Issue[]): Promise<IssueWithLatest[]> =>
        Promise.all(
          issues.map(async (issue) => {
            if (issue.comments === 0) return { issue, latestAgentComment: null };
            try {
              const cs = await listIssueComments(token, issue.number);
              // Last comment that's NOT the user — that's the agent.
              const latest = [...cs].reverse().find((c) => !ghLogin || c.user.login !== ghLogin);
              return { issue, latestAgentComment: latest ?? null };
            } catch {
              return { issue, latestAgentComment: null };
            }
          }),
        );
      const v = await enrich(awaiting);
      // Help section dedupes across the two labels.
      const helpMap = new Map<number, Issue>();
      for (const i of [...needsReview, ...agentError]) helpMap.set(i.number, i);
      const h = await enrich(Array.from(helpMap.values()));
      v.sort((a, b) => Date.parse(b.issue.updated_at) - Date.parse(a.issue.updated_at));
      h.sort((a, b) => Date.parse(b.issue.updated_at) - Date.parse(a.issue.updated_at));
      setVerify(v);
      setHelp(h);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ghLogin]);

  // Optimistic local hide. The GitHub API is slow (1–3s round-trip);
  // awaiting it before updating UI feels like the click did nothing.
  // Hide the row instantly, fire the API in the background, restore
  // with an error indicator if it fails.
  const hideOptimistic = (issueNumber: number) => {
    setVerify((v) => v?.filter((x) => x.issue.number !== issueNumber) ?? null);
    setHelp((h) => h?.filter((x) => x.issue.number !== issueNumber) ?? null);
  };

  const armOrCloseAsCompleted = async (issue: Issue) => {
    if (!confirmClose[issue.number]) {
      setConfirmClose((m) => ({ ...m, [issue.number]: true }));
      setTimeout(() => setConfirmClose((m) => {
        if (!m[issue.number]) return m;
        const n = { ...m };
        delete n[issue.number];
        return n;
      }), 3000);
      return;
    }
    setConfirmClose((m) => {
      const n = { ...m };
      delete n[issue.number];
      return n;
    });
    hideOptimistic(issue.number);
    try {
      await closeIssue(token, issue.number, "completed");
    } catch (e) {
      // Roll back: re-fetch the truth from GitHub so we don't lose
      // visibility of items that didn't actually close.
      setActions((m) => ({ ...m, [issue.number]: { error: (e as Error).message } }));
      void refresh();
    }
  };

  const armOrCloseAsNotPlanned = async (issue: Issue) => {
    if (!confirmClose[issue.number]) {
      setConfirmClose((m) => ({ ...m, [issue.number]: true }));
      setTimeout(() => setConfirmClose((m) => {
        if (!m[issue.number]) return m;
        const n = { ...m };
        delete n[issue.number];
        return n;
      }), 3000);
      return;
    }
    setConfirmClose((m) => {
      const n = { ...m };
      delete n[issue.number];
      return n;
    });
    hideOptimistic(issue.number);
    try {
      await closeIssue(token, issue.number, "not_planned");
    } catch (e) {
      setActions((m) => ({ ...m, [issue.number]: { error: (e as Error).message } }));
      void refresh();
    }
  };

  const reQueue = async (issue: Issue) => {
    const note = (guidance[issue.number] ?? "").trim();
    hideOptimistic(issue.number);
    setGuidance((g) => {
      const { [issue.number]: _drop, ...rest } = g;
      return rest;
    });
    try {
      if (note) {
        await postIssueComment(
          token,
          issue.number,
          `**Guidance from user before re-queue (via maintainer):**\n\n${note}`,
        );
      }
      const keep = issue.labels.map((l) => l.name).filter((n) => !ALL_AUTOFIX.includes(n));
      await setIssueLabels(token, issue.number, [...keep, LABEL_QUEUED]);
    } catch (e) {
      setActions((m) => ({ ...m, [issue.number]: { error: (e as Error).message } }));
      void refresh();
    }
  };

  const skipForNow = (n: number) => setSkipped((s) => new Set([...s, n]));
  const toggleExpand = (n: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const visibleVerify = (verify ?? []).filter((v) => !skipped.has(v.issue.number));

  return (
    <div className="p-4 max-w-[820px] space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Triage
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>

      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      {(verify === null || help === null) && !error && (
        <div className="text-[11.5px] text-muted-foreground italic">Loading…</div>
      )}

      {/* READY TO VERIFY */}
      {verify !== null && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-emerald-500">
              Ready to verify
            </h3>
            <span className="text-[10.5px] text-muted-foreground/80">
              {visibleVerify.length === 0
                ? "Nothing's waiting on you"
                : `${visibleVerify.length} ${visibleVerify.length === 1 ? "item" : "items"} agent shipped — your turn to check`}
            </span>
          </div>
          {visibleVerify.length === 0 && (
            <div className="rounded border border-border bg-card/40 px-3 py-3 text-[12px] text-muted-foreground italic">
              All clear. When the agent ships fixes overnight, they'll show up here.
            </div>
          )}
          {visibleVerify.map((v) => {
            const a = actions[v.issue.number] ?? "idle";
            const stError = typeof a === "object" && "error" in a ? a.error : null;
            return (
              <VerifyCard
                key={v.issue.number}
                v={v}
                a={a}
                stError={stError}
                expanded={expanded.has(v.issue.number)}
                confirmClose={!!confirmClose[v.issue.number]}
                onToggleExpand={() => toggleExpand(v.issue.number)}
                onLooksGood={() => void armOrCloseAsCompleted(v.issue)}
                onForget={() => void armOrCloseAsNotPlanned(v.issue)}
                onSkip={() => skipForNow(v.issue.number)}
                guidance={guidance[v.issue.number] ?? ""}
                setGuidance={(s) => setGuidance((g) => ({ ...g, [v.issue.number]: s }))}
                onReQueue={() => void reQueue(v.issue)}
              />
            );
          })}
        </section>
      )}

      {/* NEEDS YOUR HELP */}
      {help !== null && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-500">
              Needs your help
            </h3>
            <span className="text-[10.5px] text-muted-foreground/80">
              {help.length === 0
                ? "Agent isn't stuck on anything right now"
                : `${help.length} ${help.length === 1 ? "item" : "items"} the agent couldn't land — needs your guidance`}
            </span>
          </div>
          {help.length === 0 && (
            <div className="rounded border border-border bg-card/40 px-3 py-3 text-[12px] text-muted-foreground italic">
              No stuck items. Tidy.
            </div>
          )}
          {help.map((h) => {
            const a = actions[h.issue.number] ?? "idle";
            const stError = typeof a === "object" && "error" in a ? a.error : null;
            return (
              <HelpCard
                key={h.issue.number}
                v={h}
                a={a}
                stError={stError}
                expanded={expanded.has(h.issue.number)}
                confirmClose={!!confirmClose[h.issue.number]}
                onToggleExpand={() => toggleExpand(h.issue.number)}
                guidance={guidance[h.issue.number] ?? ""}
                setGuidance={(s) => setGuidance((g) => ({ ...g, [h.issue.number]: s }))}
                onReQueue={() => void reQueue(h.issue)}
                onForget={() => void armOrCloseAsNotPlanned(h.issue)}
              />
            );
          })}
        </section>
      )}
    </div>
  );
}

function trimIssueBody(body: string | null): string {
  if (!body) return "";
  // Strip the in-app footer (everything from the last "---" onward).
  const parts = body.split(/^---$/m);
  if (parts.length >= 2) return parts.slice(0, -1).join("---").trim();
  return body.trim();
}

function VerifyCard({
  v,
  a,
  stError,
  expanded,
  confirmClose,
  onToggleExpand,
  onLooksGood,
  onForget,
  onSkip,
  guidance,
  setGuidance,
  onReQueue,
}: {
  v: IssueWithLatest;
  a: ActionState;
  stError: string | null;
  expanded: boolean;
  confirmClose: boolean;
  onToggleExpand: () => void;
  onLooksGood: () => void;
  onForget: () => void;
  onSkip: () => void;
  guidance: string;
  setGuidance: (s: string) => void;
  onReQueue: () => void;
}) {
  const running = a === "running";
  const agentSaid = v.latestAgentComment?.body ?? "";
  return (
    <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
      <div className="space-y-0.5">
        <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
          You said:
        </div>
        <div className="text-[13px] font-medium text-foreground/95">{v.issue.title}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {relativeTime(v.issue.created_at)}
        </div>
      </div>
      {agentSaid && (
        <div className="rounded bg-background/60 border border-border/60 p-2.5 text-[12.5px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
          {agentSaid}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onLooksGood}
          disabled={running}
          className={cn(
            "inline-flex items-center gap-1.5 text-[11.5px] px-3 py-1 rounded border transition-colors disabled:opacity-50",
            confirmClose
              ? "bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-400"
              : "bg-emerald-500 hover:bg-emerald-400 text-white border-emerald-500",
          )}
        >
          <Check className="h-3 w-3" />
          {running ? "Closing…" : confirmClose ? "Sure?" : "Looks good — close it"}
        </button>
        <details className="inline-block">
          <summary className="list-none inline-flex items-center gap-1 text-[11.5px] px-3 py-1 rounded border border-border bg-background/60 hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer">
            <RotateCw className="h-3 w-3" />
            Not quite right — try again
          </summary>
          <div className="pt-2 space-y-2">
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="What's still off? The agent will read this and try a different approach."
              rows={3}
              disabled={running}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50 resize-y"
            />
            <button
              onClick={onReQueue}
              disabled={running}
              className="inline-flex items-center gap-1 text-[11.5px] px-3 py-1 rounded bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50"
            >
              <RotateCw className="h-3 w-3" />
              {running ? "Re-queueing…" : "Re-queue with note"}
            </button>
          </div>
        </details>
        <button
          onClick={onForget}
          disabled={running}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] px-3 py-1 rounded border transition-colors disabled:opacity-50",
            confirmClose
              ? "bg-rose-500 text-white border-rose-500 hover:bg-rose-400"
              : "bg-background/60 text-muted-foreground border-border hover:bg-accent",
          )}
        >
          <XIcon className="h-3 w-3" />
          {confirmClose ? "Sure?" : "Forget about it"}
        </button>
        <button
          onClick={onSkip}
          disabled={running}
          className="text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          skip for now
        </button>
        <div className="ml-auto flex items-center gap-2">
          {stError && <span className="text-[11px] text-destructive truncate max-w-[200px]">{stError}</span>}
          <button
            onClick={onToggleExpand}
            className="text-[10.5px] text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-0.5"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            details
          </button>
        </div>
      </div>
      {expanded && (
        <div className="pt-2 border-t border-border/40 space-y-2 text-[11.5px] text-muted-foreground/90">
          <div className="whitespace-pre-wrap">{trimIssueBody(v.issue.body)}</div>
          <a
            href={v.issue.html_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-indigo-400 hover:underline"
          >
            View on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}

function HelpCard({
  v,
  a,
  stError,
  expanded,
  confirmClose,
  onToggleExpand,
  guidance,
  setGuidance,
  onReQueue,
  onForget,
}: {
  v: IssueWithLatest;
  a: ActionState;
  stError: string | null;
  expanded: boolean;
  confirmClose: boolean;
  onToggleExpand: () => void;
  guidance: string;
  setGuidance: (s: string) => void;
  onReQueue: () => void;
  onForget: () => void;
}) {
  const running = a === "running";
  const agentSaid = v.latestAgentComment?.body ?? "";
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <div className="space-y-0.5">
        <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
          You said:
        </div>
        <div className="text-[13px] font-medium text-foreground/95">{v.issue.title}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          filed {relativeTime(v.issue.created_at)} · agent's stuck
        </div>
      </div>
      {agentSaid && (
        <div className="rounded bg-background/60 border border-border/60 p-2.5 text-[12.5px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
          {agentSaid}
        </div>
      )}
      <textarea
        value={guidance}
        onChange={(e) => setGuidance(e.target.value)}
        placeholder="Tell the agent what to try differently…"
        rows={3}
        disabled={running}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50 resize-y"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onReQueue}
          disabled={running}
          className="inline-flex items-center gap-1 text-[11.5px] px-3 py-1 rounded bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50"
        >
          <RotateCw className="h-3 w-3" />
          {running ? "Re-queueing…" : guidance.trim() ? "Re-queue with note" : "Re-queue"}
        </button>
        <button
          onClick={onForget}
          disabled={running}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] px-3 py-1 rounded border transition-colors disabled:opacity-50",
            confirmClose
              ? "bg-rose-500 text-white border-rose-500 hover:bg-rose-400"
              : "bg-background/60 text-muted-foreground border-border hover:bg-accent",
          )}
        >
          <XIcon className="h-3 w-3" />
          {confirmClose ? "Sure?" : "Forget about it"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {stError && <span className="text-[11px] text-destructive truncate max-w-[200px]">{stError}</span>}
          <button
            onClick={onToggleExpand}
            className="text-[10.5px] text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-0.5"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            details
          </button>
        </div>
      </div>
      {expanded && (
        <div className="pt-2 border-t border-border/40 space-y-2 text-[11.5px] text-muted-foreground/90">
          <div className="whitespace-pre-wrap">{trimIssueBody(v.issue.body)}</div>
          <a
            href={v.issue.html_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-indigo-400 hover:underline"
          >
            View on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}
