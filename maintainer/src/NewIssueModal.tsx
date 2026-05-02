import { useEffect, useRef, useState } from "react";
import { Bug, Sparkles, ListChecks, X, Send, ExternalLink } from "lucide-react";
import { createIssue } from "./github";
import { cn } from "./lib";

// "New issue" composer — file from the maintainer without having
// to open the main app. Same three categories as the underlying
// label scheme:
//   Bug      → auto-fix:queued    (one-shot fix from the agent)
//   Feature  → task:in-progress   (long-running iteration thread)
//   Maintainer → task:in-progress + maintainer scope auth marker
//      in the body so the agent knows it can edit /maintainer/.

type Kind = "bug" | "feature" | "maintainer";

const LABEL_FOR: Record<Kind, string> = {
  bug: "auto-fix:queued",
  feature: "task:in-progress",
  maintainer: "task:in-progress",
};

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; number: number; url: string }
  | { kind: "error"; message: string };

export function NewIssueModal({
  open,
  onClose,
  token,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
}) {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [kind, setKind] = useState<Kind>("bug");
  const [send, setSend] = useState<SendState>({ kind: "idle" });

  useEffect(() => {
    if (!open) return;
    setKind("bug");
    setSend({ kind: "idle" });
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && send.kind !== "sending") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, send.kind]);

  if (!open) return null;

  const file = async () => {
    const title = titleRef.current?.value.trim() ?? "";
    const rawBody = bodyRef.current?.value.trim() ?? "";
    if (!title) {
      setSend({ kind: "error", message: "Give it a title — even a rough one is fine." });
      return;
    }
    setSend({ kind: "sending" });
    const labelLine = `**Type:** ${kind === "bug" ? "Bug" : kind === "feature" ? "Feature" : "Maintainer change"}`;
    const scopeLine =
      kind === "maintainer"
        ? "\n\n[allow maintainer scope]"
        : "";
    const body = `${labelLine}\n\n${rawBody || "_(no description)_"}${scopeLine}\n\n---\n\n_Filed from the maintainer._`;
    try {
      const created = await createIssue(token, title, body, [LABEL_FOR[kind]]);
      setSend({ kind: "ok", number: created.number, url: created.html_url });
    } catch (e) {
      setSend({ kind: "error", message: (e as Error).message || "unknown error" });
    }
  };

  const sending = send.kind === "sending";
  const sentOk = send.kind === "ok";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (sending) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[540px] max-w-[92vw] rounded-xl border-2 border-indigo-500/40 bg-card shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-border bg-muted/30">
          <div className="px-4 py-2 text-[12px] font-medium text-foreground/90">New issue</div>
          <div className="ml-auto flex items-center pr-3 text-[10.5px] text-muted-foreground/80">
            Esc to close
          </div>
          <button
            onClick={onClose}
            disabled={sending}
            className="h-8 w-9 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {sentOk && send.kind === "ok" ? (
            <div className="space-y-3">
              <div className="text-[12.5px] text-foreground/90">
                ✅ Filed as{" "}
                <a
                  href={send.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-indigo-400 hover:underline inline-flex items-center gap-1"
                >
                  #{send.number}
                  <ExternalLink className="h-3 w-3" />
                </a>
                .{" "}
                {kind === "bug"
                  ? "The auto-fix agent will pick it up on its next run."
                  : "Iterate on it from the Tasks tab."}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="text-[12px] px-3 py-1.5 rounded bg-indigo-500 hover:bg-indigo-400 text-white"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="inline-flex rounded-md border border-border bg-background overflow-hidden text-[11.5px]">
                <KindButton active={kind === "bug"} onClick={() => setKind("bug")} icon={<Bug className="h-3 w-3" />}>
                  Bug
                </KindButton>
                <KindButton active={kind === "feature"} onClick={() => setKind("feature")} icon={<Sparkles className="h-3 w-3" />}>
                  Feature
                </KindButton>
                <KindButton active={kind === "maintainer"} onClick={() => setKind("maintainer")} icon={<ListChecks className="h-3 w-3" />}>
                  Maintainer
                </KindButton>
              </div>
              <div className="text-[10.5px] text-muted-foreground/80 leading-relaxed">
                {kind === "bug" && "Auto-fix queue. Agent ships overnight, you verify in Triage."}
                {kind === "feature" && "Long-running task. You iterate with the agent in the Tasks tab."}
                {kind === "maintainer" && "Long-running task that's allowed to edit the maintainer app's own code."}
              </div>
              <input
                ref={titleRef}
                type="text"
                placeholder="What's the issue or idea? (one line)"
                disabled={sending}
                className="w-full rounded border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
              />
              <textarea
                ref={bodyRef}
                placeholder="More detail if you have it…"
                rows={6}
                disabled={sending}
                className="w-full rounded border border-border bg-background px-3 py-2 text-[12.5px] outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50 resize-y"
              />
              {send.kind === "error" && (
                <div className="text-[11.5px] text-destructive leading-relaxed">{send.message}</div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  disabled={sending}
                  className="text-[12px] px-3 py-1.5 rounded hover:bg-accent/60 text-foreground disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void file()}
                  disabled={sending}
                  className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50"
                >
                  <Send className="h-3 w-3" />
                  {sending ? "Filing…" : `File ${kind === "bug" ? "bug" : kind === "feature" ? "feature" : "maintainer task"}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KindButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 transition-colors border-l border-border first:border-l-0",
        active ? "bg-indigo-500 text-white" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
