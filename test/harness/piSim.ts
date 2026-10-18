// TEST ONLY: plays pi's side of a session for the harness. Given pi's RPC
// events (server/test/fakePi.ts shorthand, or a recording of the real pi), it
// writes the session file as pi does (session-format.md: a message entry at
// each message_end, a toolResult at its message_end — or, where a script has
// no toolResult messages, at tool_execution_end — a compaction entry at
// compaction_end) and hands every event to the engine's feed (piFeed.ts), so
// what the feed records is exactly what the box would.
import fs from "node:fs";
import path from "node:path";
import { PiFeed, type Expected } from "../../server/engine/piFeed.ts";
import { appendEntries, newSessionFile, vcNote } from "../../server/convlog/piSession.ts";
import type { EventBody, PiEntry } from "../../src/convlog/protocol.ts";

/** pi's message timestamps: unique across every simulated session (an assistant message's blocks are named by it). */
let clock = 1_700_000_000_000;
const stamp = () => ++clock;

export class PiSim {
  readonly file: string;
  readonly pointed = new Set<string>();
  feed: PiFeed | null = null;
  private ts: number | null = null;

  constructor(
    dir: string,
    private emit: (b: EventBody) => void,
    name = `s${Math.random().toString(36).slice(2, 8)}`,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = newSessionFile(path.join(dir, `${name}.jsonl`), dir);
  }

  /** A turn's feed (one per turn, as the engine makes it). */
  open(o: { flushMs?: number; delivered?: (id: string) => void; expect?: Expected[] } = {}): PiFeed {
    this.feed = new PiFeed({ file: this.file, emit: this.emit, pointed: this.pointed, flushMs: o.flushMs ?? 0, delivered: o.delivered, now: () => (clock += 2_000) });
    for (const e of o.expect ?? []) this.feed.expect(e);
    return this.feed;
  }

  private write(e: Omit<PiEntry, "id" | "parentId" | "timestamp">): PiEntry {
    return appendEntries(this.file, [e])[0]!;
  }

  /** pi's events, in order: each persisted as pi does, then seen by the feed. */
  play(events: any[]): void {
    const results = events.some((e) => e.type === "message_end" && e.message?.role === "toolResult");
    for (const raw of events) {
      const ev = JSON.parse(JSON.stringify(raw));
      if ((ev.type === "message_start" || ev.type === "message_end") && ev.message) {
        if (ev.message.role === "assistant") {
          if (ev.type === "message_start" || this.ts === null) this.ts = typeof ev.message.timestamp === "number" ? ev.message.timestamp : stamp();
          ev.message.timestamp = this.ts;
        } else if (typeof ev.message.timestamp !== "number") ev.message.timestamp = stamp();
      }
      if (ev.type === "message_end" && ev.message) {
        this.write({ type: "message", message: ev.message });
        if (ev.message.role === "assistant") this.ts = null;
      } else if (ev.type === "tool_execution_end" && !results) {
        this.write({ type: "message", message: { role: "toolResult", toolCallId: ev.toolCallId, toolName: ev.toolName, content: ev.result?.content ?? [], isError: !!ev.isError, timestamp: stamp() } });
      } else if (ev.type === "compaction_end" && ev.result) {
        this.write({ type: "compaction", summary: ev.result.summary, firstKeptEntryId: ev.result.firstKeptEntryId ?? null, tokensBefore: ev.result.tokensBefore ?? 0 });
      }
      this.feed!.onPi(ev);
    }
  }

  /** vault-chat's own line, appended as the engine does when no pi holds the session. */
  note(data: { kind: "line" | "notice" | "divider"; clientId?: string; [k: string]: unknown }): void {
    const entry = this.write(vcNote(data));
    this.pointed.add(entry.id);
    this.emit({ type: "entry", file: this.file, entry, ...(data.clientId ? { clientId: data.clientId } : {}) });
  }

  close(): void {
    this.feed?.dispose();
    this.feed = null;
  }
}
