// The ongoing-work line (see ongoingWork.ts), in the chat list row and above
// the composer. The dot reuses the chat list's vocabulary: pulsing white =
// working, grey = waiting on its own schedule, accent = waiting for you, red =
// blocked.
import { useEffect, useState } from "react";
import type { Conversation } from "./conversations";
import { ongoingWork, ongoingText, type OngoingTone } from "./ongoingWork";
import { cn } from "./lib/utils";

function Dot({ tone }: { tone: OngoingTone }) {
  if (tone === "running") {
    return (
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
      </span>
    );
  }
  const color = tone === "blocked" ? "bg-destructive" : tone === "you" ? "bg-primary" : tone === "done" ? "bg-emerald-600" : "bg-muted-foreground/50";
  return <span className={cn("inline-flex h-1.5 w-1.5 rounded-full shrink-0", color)} />;
}

/** Re-render once a minute so "next 3:40" never goes stale on screen. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function OngoingLine({
  conversation,
  size = "row",
  className,
  verdict = false,
}: {
  conversation: Pick<Conversation, "state" | "nextWakeAt" | "costUsd" | "messages" | "verdict">;
  size?: "row" | "chat";
  className?: string;
  /** Show a finished conversation's Done verdict here. */
  verdict?: boolean;
}) {
  const now = useMinute();
  const o = ongoingWork(conversation, now, undefined, verdict);
  if (!o) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 min-w-0",
        size === "chat" ? "text-[11px]" : "text-[10.5px]",
        o.tone === "blocked" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      data-ongoing={o.tone}
      {...(o.tone === "done" || conversation.state === "done" ? { "data-el": "verdict" } : {})}
    >
      <Dot tone={o.tone} />
      <span className="truncate tabular-nums">{ongoingText(o)}</span>
    </div>
  );
}
