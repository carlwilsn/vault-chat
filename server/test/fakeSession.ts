// TEST ONLY: pi's session files for the engine tests' fake backends. The
// transcript is pi's session file (the feed points into it), so a fake backend
// must write one as pi does: `withPiSessions(backend, dir)` gives every thread
// it starts a session file; as a turn starts it sends pi's own events for the
// prompt (the user message, written as pi's entry; a test that plays that same
// message itself is not doubled); and it persists the pi events the test emits
// the way pi does (session-format.md): a message entry at each message_end (an
// assistant message's timestamp the same in its events and its entry), a
// toolResult at tool_execution_end, a compaction at compaction_end.
import type { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendEntries, newSessionFile } from "../convlog/piSession";

let clock = Date.now();
const stamp = () => (clock = Math.max(Date.now(), clock + 1));

type Sess = { file: string; ts: number | null; sentPrompt: string | null };

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c?.text ?? "").join(""));

export function withPiSessions<T extends EventEmitter>(b: T, dir: string): T {
  const anyB = b as any;
  const sessions = new Map<string, Sess>();
  let n = 0;
  const write = (s: Sess, e: any) => appendEntries(s.file, [e]);
  /** A thread's session: started here, or (a restarted server resuming it) found in the folder by its id. */
  const sess = (threadId: string): Sess | undefined => {
    let s = sessions.get(threadId);
    if (!s && existsSync(dir)) {
      const hit = readdirSync(dir).find((n) => n.includes(`_${threadId}-`));
      if (hit) sessions.set(threadId, (s = { file: join(dir, hit), ts: null, sentPrompt: null }));
    }
    return s;
  };
  const start = anyB.startThread?.bind(b);
  anyB.startThread = async (o: any) => {
    const r = await start(o);
    if (!r.ref) r.ref = newSessionFile(join(dir, `${Date.now()}_${r.threadId}-${++n}.jsonl`), dir);
    sessions.set(r.threadId, { file: r.ref, ts: null, sentPrompt: null });
    return r;
  };
  const turn = anyB.startTurn?.bind(b);
  anyB.startTurn = async (threadId: string, o: any) => {
    const r = await turn(threadId, o);
    const s = sess(threadId);
    if (s) {
      // pi sends the prompt's user message as the turn starts.
      const text = (o?.texts ?? []).filter(Boolean).join("\n\n");
      const message = { role: "user", content: [{ type: "text", text }], timestamp: stamp() };
      queueMicrotask(() => {
        for (const ev of [{ type: "message_start", message }, { type: "message_end", message }]) b.emit("event", { threadId, kind: "pi", ev });
        s.sentPrompt = text;
      });
    }
    return r;
  };
  if (typeof anyB.holds !== "function") anyB.holds = () => false;
  if (typeof anyB.note !== "function") anyB.note = async () => false;
  const emit = b.emit.bind(b);
  (b as any).emit = (name: string, e: any, ...rest: any[]) => {
    if (name === "event" && e?.kind === "pi" && e.ev) {
      const s = sess(e.threadId);
      if (s) {
        const ev = e.ev;
        // A test playing pi's user message for the prompt pi already sent: once is enough.
        if ((ev.type === "message_start" || ev.type === "message_end") && ev.message?.role === "user" && s.sentPrompt !== null && textOf(ev.message) === s.sentPrompt) {
          if (ev.type === "message_end") s.sentPrompt = null;
          return true;
        }
        if (ev.type !== "message_start" || ev.message?.role !== "user") s.sentPrompt = null;
        persist(s, ev);
      }
    }
    return emit(name, e, ...rest);
  };
  function persist(s: Sess, ev: any): void {
    const m = ev.message;
    if ((ev.type === "message_start" || ev.type === "message_end") && m) {
      if (m.role === "assistant") {
        if (ev.type === "message_start" || s.ts === null) s.ts = typeof m.timestamp === "number" ? m.timestamp : stamp();
        m.timestamp = s.ts;
      } else if (typeof m.timestamp !== "number") m.timestamp = stamp();
    }
    if (ev.type === "message_end" && m) {
      write(s, { type: "message", message: m });
      if (m.role === "assistant") s.ts = null;
    } else if (ev.type === "tool_execution_end") {
      write(s, { type: "message", message: { role: "toolResult", toolCallId: ev.toolCallId, toolName: ev.toolName, content: ev.result?.content ?? [], isError: !!ev.isError, timestamp: stamp() } });
    } else if (ev.type === "compaction_end" && ev.result) {
      write(s, { type: "compaction", summary: ev.result.summary, firstKeptEntryId: ev.result.firstKeptEntryId ?? null, tokensBefore: ev.result.tokensBefore ?? 0 });
    }
  }
  return b;
}
