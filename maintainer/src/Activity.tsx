import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  type Issue,
  listIssuesByLabel,
  ghJson,
  OWNER,
  REPO,
} from "./github";
import { useStore, type Tab } from "./store";
import { cn, relativeTime } from "./lib";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type Bucket = {
  id: string;
  label: string;
  dot: string;
  actionLabel: string;
  jumpTab: Tab;
  issues: Issue[];
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function Activity({ token }: { token: string }) {
  const setTab = useStore((s) => s.setTab);
  const setTriageIssue = useStore((s) => (s as unknown as { setTriageIssue?: (n: number) => void }).setTriageIssue);
  const setTasksIssue = useStore((s) => (s as unknown as { setTasksIssue?: (n: number) => void }).setTasksIssue);
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const sinceMs = Date.now() - SEVEN_DAYS_MS;

      const [queued, awaiting, needsReview, agentError, taskInProgress, recentlyClosed] =
        await Promise.all([
          listIssuesByLabel(token, "auto-fix:queued").catch(() => [] as Issue[]),
          listIssuesByLabel(token, "auto-fix:awaiting-verification").catch(() => [] as Issue[]),
          listIssuesByLabel(token, "auto-fix:needs-review").catch(() => [] as Issue[]),
          listIssuesByLabel(token, "auto-fix:agent-error").catch(() => [] as Issue[]),
          listIssuesByLabel(token, "task:in-progress").catch(() => [] as Issue[]),
          ghJson<Issue[]>(
            `/repos/${OWNER}/${REPO}/issues?state=closed&per_page=50&sort=updated&direction=desc`,
            token,
          ).catch(() => [] as Issue[]),
        ]);

      const closedRecent = recentlyClosed.filter(
        (i) => Date.parse(i.updated_at) >= sinceMs,
      );

      const stuck = [
        ...needsReview.filter(
          (i) => !agentError.some((e) => e.number === i.number),
        ),
        ...agentError,
      ];

      const allBuckets: Bucket[] = [
        {
          id: "queued",
          label: "🔵 Queued / Running",
          dot: "bg-indigo-400",
          actionLabel: "view",
          jumpTab: "triage",
          issues: queued,
        },
        {
          id: "awaiting",
          label: "✅ Ready to verify",
          dot: "bg-emerald-500",
          actionLabel: "verify",
          jumpTab: "triage",
          issues: awaiting,
        },
        {
          id: "stuck",
          label: "🔴 Stuck",
          dot: "bg-rose-500",
          actionLabel: "help out",
          jumpTab: "triage",
          issues: stuck,
        },
        {
          id: "tasks",
          label: "🟡 Tasks in progress",
          dot: "bg-amber-400",
          actionLabel: "view",
          jumpTab: "tasks",
          issues: taskInProgress,
        },
        {
          id: "closed",
          label: "✔️ Recently closed",
          dot: "bg-muted-foreground",
          actionLabel: "view",
          jumpTab: "triage",
          issues: closedRecent,
        },
      ];

      setBuckets(allBuckets.filter((b) => b.issues.length > 0));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, [token]);

  const handleJump = (bucket: Bucket, issue: Issue) => {
    if (bucket.jumpTab === "triage" && setTriageIssue) {
      setTriageIssue(issue.number);
    } else if (bucket.jumpTab === "tasks" && setTasksIssue) {
      setTasksIssue(issue.number);
    }
    setTab(bucket.jumpTab);
  };

  return (
    <div className="p-4 max-w-[820px] space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Live pipeline
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      {buckets === null && !error && (
        <div className="text-[11.5px] text-muted-foreground italic">Loading…</div>
      )}
      {buckets !== null && buckets.length === 0 && (
        <div className="rounded border border-border bg-card/40 px-3 py-3 text-[12px] text-muted-foreground italic">
          Nothing active right now. All quiet.
        </div>
      )}
      {buckets !== null &&
        buckets.map((bucket) => (
          <section key={bucket.id} className="space-y-1.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {bucket.label}
            </div>
            <div className="rounded border border-border bg-card/40 divide-y divide-border/40">
              {bucket.issues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  dot={bucket.dot}
                  actionLabel={bucket.actionLabel}
                  onAction={() => handleJump(bucket, issue)}
                />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

function IssueRow({
  issue,
  dot,
  actionLabel,
  onAction,
}: {
  issue: Issue;
  dot: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dot)} />
      <span className="flex-1 min-w-0 text-foreground/90">
        {truncate(issue.title, 72)}
      </span>
      <span className="text-[10.5px] text-muted-foreground/70 shrink-0">
        {relativeTime(issue.updated_at)}
      </span>
      <button
        onClick={onAction}
        className="ml-1 text-[11px] text-indigo-400 hover:underline shrink-0"
      >
        {actionLabel}
      </button>
    </div>
  );
}
