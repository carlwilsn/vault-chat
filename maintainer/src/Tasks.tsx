import { useEffect, useState } from "react";
import { ChevronLeft, RefreshCw, Send, ExternalLink } from "lucide-react";
import {
  type Issue,
  type IssueComment,
  listIssuesByLabel,
  listIssueComments,
  postIssueComment,
} from "./github";
import { useStore } from "./store";
import { cn, relativeTime } from "./lib";

// Tasks tab — long-running collaboration threads, one per
// `task:in-progress` issue. Click a task → see the full comment
// thread + a reply box. Sending a reply posts a comment to GitHub;
// the `task-resume` workflow picks up the `issue_comment` event
// (when implemented) and wakes the agent for the next iteration.
//
// "Waiting on you" status is derived from the latest comment: if
// the agent's last comment ended with [BLOCKED ON USER], we
// surface the row as needing attention.

const BLOCKED_MARKER = "[BLOCKED ON USER]";

type TaskStatus = "waiting-you" | "waiting-agent" | "fresh";

function statusFor(_issue: Issue, comments: IssueComment[] | undefined, ghLogin: string | null): TaskStatus {
  if (!comments || comments.length === 0) return "fresh";
  const last = comments[comments.length - 1];
  const userIsCarl = ghLogin && last.user.login === ghLogin;
  if (userIsCarl) return "waiting-agent";
  if (last.body.includes(BLOCKED_MARKER)) return "waiting-you";
  return "waiting-agent";
}

export function Tasks({ token }: { token: string }) {
  const ghLogin = useStore((s) => s.ghLogin);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commentsByIssue, setCommentsByIssue] = useState<Record<number, IssueComment[]>>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const refresh = async () => {
    try {
      const list = await listIssuesByLabel(token, "task:in-progress", "open");
      setIssues(list);
      setError(null);
      // Prefetch comments for all so we can compute status badges.
      const cmap: Record<number, IssueComment[]> = {};
      await Promise.all(
        list.map(async (i) => {
          if (i.comments === 0) {
            cmap[i.number] = [];
            return;
          }
          try {
            cmap[i.number] = await listIssueComments(token, i.number);
          } catch {
            cmap[i.number] = [];
          }
        }),
      );
      setCommentsByIssue(cmap);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const active = issues?.find((i) => i.number === activeId) ?? null;
  const activeComments = active ? commentsByIssue[active.number] ?? [] : [];

  const sendReply = async () => {
    if (!active) return;
    const body = reply.trim();
    if (!body) return;
    setSending(true);
    try {
      await postIssueComment(token, active.number, body);
      setReply("");
      // Refresh just this thread.
      const fresh = await listIssueComments(token, active.number);
      setCommentsByIssue((m) => ({ ...m, [active.number]: fresh }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (active) {
    return (
      <div className="p-4 max-w-[820px] space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveId(null)}
            className="text-[12px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Back to tasks
          </button>
          <a
            href={active.html_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[11px] text-indigo-400 hover:underline inline-flex items-center gap-1"
          >
            #{active.number} on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <h1 className="text-[14px] font-semibold text-foreground/95">{active.title}</h1>
        <div className="space-y-2">
          {/* Issue body as the first turn */}
          <CommentCard
            author={active.user.login}
            createdAt={active.created_at}
            body={active.body ?? ""}
            isOriginal
          />
          {activeComments.map((c) => (
            <CommentCard
              key={c.id}
              author={c.user.login}
              createdAt={c.created_at}
              body={c.body}
              isUser={!!ghLogin && c.user.login === ghLogin}
            />
          ))}
        </div>
        <div className="border-t border-border pt-3 space-y-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply — agent picks up the next time the task-resume workflow fires."
            rows={4}
            disabled={sending}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-[12.5px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50 resize-y"
          />
          <div className="flex justify-end">
            <button
              onClick={() => void sendReply()}
              disabled={sending || reply.trim().length === 0}
              className="inline-flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 text-white text-[12px] px-3 py-1.5 rounded disabled:opacity-50"
            >
              <Send className="h-3 w-3" />
              {sending ? "Posting…" : "Send reply"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-[820px] space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Open tasks
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>
      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
        Long-running feature/idea threads filed via{" "}
        <code className="font-mono bg-muted px-1 rounded text-[10.5px]">Ctrl+G → Feature</code>{" "}
        in the main app. Reply here to advance the conversation.
      </p>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      <div className="rounded border border-border bg-card/40 divide-y divide-border/40">
        {issues === null && !error && (
          <div className="px-3 py-2 text-[11.5px] text-muted-foreground italic">Loading…</div>
        )}
        {issues && issues.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-muted-foreground italic">
            No open tasks. File one from the main app's feedback popup with the Feature toggle on.
          </div>
        )}
        {issues && issues.map((i) => {
          const cs = commentsByIssue[i.number];
          const status = statusFor(i, cs, ghLogin);
          return (
            <button
              key={i.number}
              onClick={() => setActiveId(i.number)}
              className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-start gap-2 text-[12.5px]"
            >
              <StatusPill status={status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{i.title}</span>
                  <span className="text-[10.5px] text-muted-foreground/80 font-mono shrink-0">
                    #{i.number}
                  </span>
                </div>
                <div className="text-[10.5px] text-muted-foreground/80">
                  filed {relativeTime(i.created_at)}
                  {i.comments > 0 && ` · ${i.comments} comment${i.comments === 1 ? "" : "s"}`}
                  {i.updated_at !== i.created_at && ` · updated ${relativeTime(i.updated_at)}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: TaskStatus }) {
  const cfg: Record<TaskStatus, { label: string; cls: string }> = {
    "waiting-you": { label: "you're up", cls: "bg-amber-500/15 text-amber-500 border-amber-500/40" },
    "waiting-agent": { label: "agent", cls: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30" },
    fresh: { label: "fresh", cls: "bg-muted text-muted-foreground border-border" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold",
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

function CommentCard({
  author,
  createdAt,
  body,
  isOriginal,
  isUser,
}: {
  author: string;
  createdAt: string;
  body: string;
  isOriginal?: boolean;
  isUser?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded border bg-card/40 p-3",
        isOriginal ? "border-indigo-500/30" : "border-border",
        isUser && "bg-indigo-500/5",
      )}
    >
      <div className="text-[10.5px] text-muted-foreground/90 font-mono mb-1">
        {author} · {relativeTime(createdAt)}
        {isOriginal && " · original post"}
      </div>
      <div className="text-[12.5px] text-foreground/90 whitespace-pre-wrap leading-relaxed">{body}</div>
    </div>
  );
}
