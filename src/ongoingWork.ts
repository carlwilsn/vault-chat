// The ongoing-work line: one quiet line on a conversation that is still
// working ("checking the run · next 3:40 · $1.20"), shown in the chat and in
// the chat list. Built only from the conversation's meta fields (`state`,
// `nextWakeAt`, `costUsd`) and its last ScheduleWake's reason — never guessed
// from text.
import type { Conversation } from "./conversations";

export type OngoingTone = "running" | "waiting" | "you" | "blocked" | "done";
export type Ongoing = { tone: OngoingTone; label: string; next?: string; cost?: string };

/** "3:40" today, "Tue 9:00" within a week, else "Oct 14". */
export function formatWake(at: number, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === n.toDateString()) return hm;
  if (at - now < 6 * 24 * 3600_000 && at > now) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatCost(usd: number | undefined): string | undefined {
  if (typeof usd !== "number" || !(usd > 0)) return undefined;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** The reason of the conversation's most recent ScheduleWake call, if any. */
export function lastWakeReason(c: Pick<Conversation, "messages">): string | undefined {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const calls = c.messages[i]?.toolCalls ?? [];
    for (let j = calls.length - 1; j >= 0; j--) {
      const t = calls[j]!;
      if (!/ScheduleWake/i.test(t.name)) continue;
      const r = (t.input as { reason?: unknown } | undefined)?.reason;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  }
  return undefined;
}

function lower(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Null when the conversation is not doing long work. `verdict`: a finished
 *  conversation's Done verdict shows here too (one of Carl's open choices). */
export function ongoingWork(
  c: Pick<Conversation, "state" | "nextWakeAt" | "costUsd" | "messages"> & { verdict?: Conversation["verdict"] },
  now = Date.now(),
  reason?: string,
  verdict = false,
): Ongoing | null {
  const cost = formatCost(c.costUsd);
  switch (c.state) {
    case "done": {
      const v = verdict ? c.verdict : undefined;
      if (!v) return null;
      const note = (v.notes ?? []).find((n) => n && n.trim());
      const word = v.verdict === "pass" ? "verifier passed" : v.verdict === "fail" ? "verifier failed" : "verifier unsure";
      return { tone: v.verdict === "pass" ? "done" : v.verdict === "fail" ? "blocked" : "waiting", label: `Done · ${word}${note ? ` — ${note.trim()}` : ""}`, cost };
    }
    case "running":
      return { tone: "running", label: "Working", cost };
    case "sleeping": {
      const why = reason ?? lastWakeReason(c);
      const next = c.nextWakeAt && c.nextWakeAt > now - 60_000 ? `next ${formatWake(c.nextWakeAt, now)}` : undefined;
      return { tone: "waiting", label: why ? lower(why) : "Waiting", next, cost };
    }
    case "waiting_user":
      return { tone: "you", label: "Waiting for you", cost };
    case "blocked":
      return { tone: "blocked", label: "Blocked", cost };
    default:
      return null;
  }
}

/** The line as plain text: "checking the run · next 3:40 · $1.20". */
export function ongoingText(o: Ongoing): string {
  return [o.label, o.next, o.cost].filter(Boolean).join(" · ");
}
