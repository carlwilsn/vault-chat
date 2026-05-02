import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  type WorkflowRun,
  listIssuesByLabel,
  listWorkflowRuns,
  ghJson,
  OWNER,
  REPO,
} from "./github";
import { useStore, type Tab } from "./store";
import { cn, relativeTime } from "./lib";

// Activity tab — chronological feed of "what happened with my project
// today." Combines three event sources into one stream:
//
//   1. Issue label changes (queued → awaiting-verification, etc.) —
//      derived from issues with a recently-updated timestamp.
//   2. Workflow runs (ship, ship-maintainer) — release status.
//   3. Comments by the agent — especially [BLOCKED ON USER] markers.
//
// CEO framing: each row is one plain-English sentence. Click jumps
// straight to the relevant card in another tab. No commit hashes,
// no workflow IDs in the user-facing text.

type ActivityKind = "shipped" | "needs-review" | "blocked" | "released" | "build-failed";

type ActivityItem = {
  kind: ActivityKind;
  when: number; // ms since epoch
  text: string;
  jumpTo?: { tab: Tab; issueNumber?: number };
  href?: string;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function Activity({ token }: { token: string }) {
  const ghLogin = useStore((s) => s.ghLogin);
  const setTab = useStore((s) => s.setTab);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const sinceMs = Date.now() - SEVEN_DAYS_MS;
      const since = new Date(sinceMs).toISOString();
      const events: ActivityItem[] = [];

      // 1. Recently-updated issues by label, mapped to user-facing
      //    state. Issues touched in the last week show up.
      const [awaiting, needsReview, agentError] = await Promise.all([
        listIssuesByLabel(token, "auto-fix:awaiting-verification"),
        listIssuesByLabel(token, "auto-fix:needs-review"),
        listIssuesByLabel(token, "auto-fix:agent-error"),
      ]);
      for (const i of awaiting) {
        const t = Date.parse(i.updated_at);
        if (t < sinceMs) continue;
        events.push({
          kind: "shipped",
          when: t,
          text: `Agent shipped a fix for "${truncate(i.title, 60)}." Your turn to verify.`,
          jumpTo: { tab: "triage", issueNumber: i.number },
        });
      }
      for (const i of [...needsReview, ...agentError]) {
        const t = Date.parse(i.updated_at);
        if (t < sinceMs) continue;
        events.push({
          kind: "needs-review",
          when: t,
          text: `Agent couldn't land a fix for "${truncate(i.title, 60)}" — needs your guidance.`,
          jumpTo: { tab: "triage", issueNumber: i.number },
        });
      }

      // 2. Recent ship + ship-maintainer workflow runs.
      const [shipRuns, maintRuns] = await Promise.all([
        listWorkflowRuns(token, "ship.yml", 10).catch(() => [] as WorkflowRun[]),
        listWorkflowRuns(token, "ship-maintainer.yml", 10).catch(() => [] as WorkflowRun[]),
      ]);
      for (const r of [...shipRuns, ...maintRuns]) {
        const t = Date.parse(r.updated_at);
        if (t < sinceMs) continue;
        if (r.status !== "completed") continue;
        const which = shipRuns.includes(r) ? "main app" : "maintainer";
        if (r.conclusion === "success") {
          events.push({
            kind: "released",
            when: t,
            text: `A new ${which} release went out.`,
            href: r.html_url,
          });
        } else if (r.conclusion === "failure") {
          events.push({
            kind: "build-failed",
            when: t,
            text: `A ${which} build failed — no release published.`,
            href: r.html_url,
          });
        }
      }

      // 3. Tasks where the agent posted [BLOCKED ON USER] in the most
      //    recent comment — surface as "you're up."
      try {
        const tasks = await listIssuesByLabel(token, "task:in-progress");
        for (const i of tasks) {
          if (i.comments === 0) continue;
          // Cheap signal: only fetch comments if the issue updated_at
          // is within the window AND has comments.
          if (Date.parse(i.updated_at) < sinceMs) continue;
          const cs = await ghJson<Array<{ body: string; user: { login: string }; created_at: string }>>(
            `/repos/${OWNER}/${REPO}/issues/${i.number}/comments?per_page=100`,
            token,
          ).catch(() => []);
          if (cs.length === 0) continue;
          const last = cs[cs.length - 1];
          const isUserReply = ghLogin && last.user.login === ghLogin;
          if (isUserReply) continue; // user's already replied; not "you're up"
          if (!last.body.includes("[BLOCKED ON USER]")) continue;
          events.push({
            kind: "blocked",
            when: Date.parse(last.created_at),
            text: `Agent posted a question on "${truncate(i.title, 60)}." You're up.`,
            jumpTo: { tab: "tasks", issueNumber: i.number },
          });
        }
      } catch {
        // Non-fatal — tasks API can fail without nuking the rest.
      }

      events.sort((a, b) => b.when - a.when);
      setItems(events);
      setError(null);
      // Silence the `since` variable warning — we already used sinceMs above
      void since;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ghLogin]);

  const grouped = useMemo(() => groupByDay(items ?? []), [items]);

  return (
    <div className="p-4 max-w-[820px] space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Last 7 days
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      {items === null && !error && (
        <div className="text-[11.5px] text-muted-foreground italic">Loading…</div>
      )}
      {items && items.length === 0 && (
        <div className="rounded border border-border bg-card/40 px-3 py-3 text-[12px] text-muted-foreground italic">
          Nothing's happened in the last week. Quiet stretch.
        </div>
      )}
      {grouped.map(([day, dayItems]) => (
        <section key={day} className="space-y-1.5">
          <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
            {day}
          </div>
          <div className="rounded border border-border bg-card/40 divide-y divide-border/40">
            {dayItems.map((it, idx) => (
              <ActivityRow key={idx} item={it} onJump={(tab) => setTab(tab)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ActivityRow({
  item,
  onJump,
}: {
  item: ActivityItem;
  onJump: (tab: Tab) => void;
}) {
  const dot = colorForKind(item.kind);
  const action = item.jumpTo ? (
    <button
      onClick={() => onJump(item.jumpTo!.tab)}
      className="ml-auto text-[11px] text-indigo-400 hover:underline shrink-0"
    >
      {labelForKind(item.kind)}
    </button>
  ) : item.href ? (
    <a
      href={item.href}
      target="_blank"
      rel="noreferrer"
      className="ml-auto text-[11px] text-muted-foreground hover:text-foreground shrink-0"
    >
      details
    </a>
  ) : null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dot)} />
      <span className="text-muted-foreground/80 font-mono text-[10.5px] shrink-0">
        {timeOfDay(item.when)}
      </span>
      <span className="flex-1 min-w-0 text-foreground/90">{item.text}</span>
      {action}
    </div>
  );
}

function colorForKind(k: ActivityKind): string {
  switch (k) {
    case "shipped":
      return "bg-emerald-500";
    case "blocked":
      return "bg-amber-500";
    case "needs-review":
      return "bg-amber-500";
    case "released":
      return "bg-indigo-400";
    case "build-failed":
      return "bg-rose-500";
  }
}

function labelForKind(k: ActivityKind): string {
  switch (k) {
    case "shipped":
      return "verify";
    case "blocked":
      return "open";
    case "needs-review":
      return "help out";
    default:
      return "view";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function timeOfDay(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h < 12 ? "am" : "pm";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m}${ampm}`;
}

function groupByDay(items: ActivityItem[]): Array<[string, ActivityItem[]]> {
  const groups = new Map<string, ActivityItem[]>();
  for (const it of items) {
    const key = dayLabel(it.when);
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  return Array.from(groups.entries());
}

function dayLabel(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return relativeTime(d.toISOString()).replace(" ago", " ago");
  return d.toLocaleDateString();
}
