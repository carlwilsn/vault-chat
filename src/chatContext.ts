// The chat's context: how full the model's window is, and where the
// conversation was last summarized (compacted).
//
// Compaction is recorded IN the transcript as a quiet divider message
// (`system: true` + `compaction.summary`) placed before the messages kept
// verbatim. Everything above the divider stays in the transcript (messages are
// append-only on disk — the conversation file never shrinks), but the model
// sees only: the summary, then the messages after the divider. Because the
// summary rides on a message, it survives switching chats, reloads and sync —
// it used to live in one global store field that was cleared on every switch.
import type { ChatMessage } from "./store";
import { contextWindowFor, FALLBACK_CONTEXT_WINDOW } from "./providers";

export const COMPACTION_DIVIDER_TEXT = "Earlier conversation summarized";

/** Compact before the next message once the context passes this fraction of
 *  the model's window. */
export const COMPACT_THRESHOLD = 0.85;

export type ContextWindow = { tokens: number; known: boolean };

/** The model's real window (catalog), or the fallback when unknown. */
export function windowFor(modelId: string | null | undefined): ContextWindow {
  const w = contextWindowFor(modelId);
  return w ? { tokens: w, known: true } : { tokens: FALLBACK_CONTEXT_WINDOW, known: false };
}

/** A compaction divider — or the box's roll-over marker, which is the same
 *  thing to the reader: the earlier conversation was summarized here. */
export function isCompactionDivider(m: ChatMessage | undefined): boolean {
  return !!m && !!m.system && (typeof m.compaction?.summary === "string" || typeof m.rollover?.recap === "string");
}

/** The summary a divider carries (a compaction's summary, a roll-over's recap). */
export function dividerSummary(m: ChatMessage): string {
  return m.compaction?.summary ?? m.rollover?.recap ?? "";
}

/** Index of the newest compaction divider, or -1. */
export function lastCompactionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isCompactionDivider(messages[i])) return i;
  return -1;
}

/** What the model sees of a transcript: the latest summary (if any) and the
 *  messages after it. */
export function activeWindow(messages: ChatMessage[]): { summary: string | null; messages: ChatMessage[] } {
  const i = lastCompactionIndex(messages);
  if (i < 0) return { summary: null, messages };
  return { summary: dividerSummary(messages[i]!), messages: messages.slice(i + 1) };
}

/** Insert a divider carrying `summary` before the last `keep` messages. */
export function withCompactionDivider(messages: ChatMessage[], summary: string, keep: number): ChatMessage[] {
  const cut = Math.max(0, messages.length - keep);
  const divider: ChatMessage = {
    role: "assistant",
    system: true,
    content: COMPACTION_DIVIDER_TEXT,
    compaction: { summary, at: Date.now() },
  };
  return [...messages.slice(0, cut), divider, ...messages.slice(cut)];
}

/** The context size last reported for this transcript: the newest assistant
 *  turn's `usage.context`, unless a compaction came after it (then unknown
 *  until the next turn). Lets a reopened chat show its dial without a new turn. */
export function lastReportedContext(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isCompactionDivider(m)) return 0;
    if (m.role === "assistant" && !m.system && typeof m.usage?.context === "number" && m.usage.context > 0) return m.usage.context;
  }
  return 0;
}
