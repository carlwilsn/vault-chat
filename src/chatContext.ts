// Where the box summarized a conversation (a roll-over, or a compaction from
// before the box), and the context size last reported for it. The divider is
// a quiet message in the transcript (`system: true` with `compaction.summary`
// or `rollover.recap`); the messages after it are what the model sees.
import type { ChatMessage } from "./store";

export const COMPACTION_DIVIDER_TEXT = "Earlier conversation summarized";

/** A compaction divider — or the box's roll-over marker, which is the same
 *  thing to the reader: the earlier conversation was summarized here. */
export function isCompactionDivider(m: ChatMessage | undefined): boolean {
  return !!m && !!m.system && (typeof m.compaction?.summary === "string" || typeof m.rollover?.recap === "string");
}

/** The summary a divider carries (a compaction's summary, a roll-over's recap). */
export function dividerSummary(m: ChatMessage): string {
  return m.compaction?.summary ?? m.rollover?.recap ?? "";
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
