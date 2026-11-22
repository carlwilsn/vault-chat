// The history noun (report 24 §4, noun 5): what happened, read-only. Three records the box keeps, each searched here:
// - the app's parts' events (offer.event records in the vaults' event logs, src/offerHistory.ts: opened a file,
//   switched chat, …), with what the part's state was before, as far back as the log goes (server/offerLog.ts);
// - Carl's activity stream across his surfaces (Ctrl+L asks and answers, Ctrl+K edits, voice lines, captures, files
//   he opened, his messages in other chats; server/activity.ts), of which each turn's "you" layer shows ~45 minutes;
// - a thread's full raw transcript (pi's own session files, before any compaction or Clear; server/engine/history.ts).
// Its "actions" are searches: nothing here changes anything. Watched on the event log's offer events and on each
// activity append. Was the RecentActivity and SearchHistory tools and the box:history offer.
import { onActivity, searchActivity } from "../activity";
import { signalLog } from "../convlog/log";
import { OFFER_EVENT, searchOfferEvents, type OfferLogRecord } from "../offerLog";
import type { Noun } from "./index";

export type HistoryCtx = { vault: string; vaults?: () => string[]; conv?: string };

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/** One part's event as a line Carl could read. */
export function eventLine(r: OfferLogRecord): string {
  return `${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} ${r.device} ${r.plugin} ${r.event}${r.payload ? ` ${r.payload}` : ""}${r.before ? ` (before: ${r.before})` : ""}`;
}

/** A thread's raw transcript searched: `thread` "main", a project's name, or left out for the asking chat. */
async function searchTranscript(ctx: HistoryCtx, query: string, thread: string, limit?: number): Promise<{ ok: boolean; text: string }> {
  const { readConv } = await import("../engine/convs");
  const { MAIN_ID } = await import("../../src/threads");
  const { searchHistory } = await import("../engine/history");
  let target = ctx.conv ? await readConv(ctx.vault, ctx.conv) : null;
  if (thread) {
    const main = thread.toLowerCase() === "main";
    const slug = main ? null : (await import("../context")).findProject(thread)?.slug;
    if (!main && !slug) return { ok: false, text: `No thread "${thread}": "main" or a project's name.` };
    target = await readConv(ctx.vault, slug ? `project-${slug}` : MAIN_ID);
  }
  if (!target) return { ok: false, text: 'No thread to search: give thread ("main" or a project\'s name).' };
  return { ok: true, text: searchHistory(ctx.vault, target, query, limit) };
}

export function historyNoun(ctx: HistoryCtx): Noun {
  const logs = () => (ctx.vaults?.() ?? []).concat(ctx.vault);
  return {
    id: "history",
    name: "History",
    state: {
      recent: {
        description: "the newest 30 things Carl did in the app's parts (opened a file, switched chat, …); (before: …) is that part's state before it",
        read: () => searchOfferEvents(logs(), { limit: 30 }).map(eventLine),
      },
    },
    actions: {
      activity: {
        readOnly: true,
        description: "Carl's activity on all his surfaces (Ctrl+L asks and answers, Ctrl+K edits, voice, files he opened, his messages in other chats) past the ~45 min your turn shows: query words (empty: all), hours back (default 24, max 168)",
        args: obj({ query: str("words that must all appear"), hours: num("how far back"), limit: num("entries (default 30)") }),
        run: (a) => ({ ok: true, text: searchActivity(ctx.vault, { query: typeof a.query === "string" ? a.query : "", hours: Number(a.hours) || undefined, limit: Number(a.limit) || undefined }) }),
      },
      transcript: {
        readOnly: true,
        description: "search a thread's full raw transcript (everything said, before any compaction or Clear), newest first with times: when Carl refers to something your context no longer holds",
        args: obj({ query: str("words that must all appear"), thread: str('"main" or a project\'s name (default: this chat)'), limit: num("hits (default 12, max 40)") }, ["query"]),
        run: (a) => searchTranscript(ctx, String(a.query ?? ""), String(a.thread ?? "").trim(), Number(a.limit) || undefined),
      },
      search: {
        readOnly: true,
        description: "search the app's parts' events as far back as they go: every word of query in the part, event or its details; plugin narrows to one part (e.g. app/viewer); days limits how far back",
        args: obj({ query: str("words that must all appear"), plugin: str("a part, e.g. app/viewer"), days: num("how far back"), limit: num("entries (default 30)") }),
        run: (a) => {
          const hits = searchOfferEvents(logs(), { query: a.query as string, plugin: a.plugin as string, days: Number(a.days) || undefined, limit: Number(a.limit) || undefined });
          return { ok: true, text: hits.length ? hits.map(eventLine).join("\n") : "nothing matches" };
        },
      },
    },
    watch: (fn) => {
      const offAct = onActivity((vault) => vault === ctx.vault && fn());
      let offLog = () => {};
      try {
        offLog = signalLog(ctx.vault).onRecord((r) => {
          if ((r as { signal?: Record<string, unknown> }).signal?.type === OFFER_EVENT) fn();
        });
      } catch {
        /* no log for this vault: the activity alone */
      }
      return () => (offAct(), offLog());
    },
  };
}
