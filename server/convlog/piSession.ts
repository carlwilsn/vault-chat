// pi's session files (session-format.md), read and — only where no pi process
// has the session open — written in pi's own format. A conversation's
// transcript is these files; the feed (./log.ts) only points into them.
//
// Writing: pi owns a session while a process has it open; then vault-chat's
// entries go through pi itself (the extension's /vc-note command appends a
// custom entry). With no pi on it (a voice-only conversation, a marker after a
// crash, an imported older conversation) this module appends pi-format entries
// itself, each a child of the file's last entry, as pi would.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { PiEntry } from "../../src/convlog/protocol";
import { VC_NOTE } from "../../src/convlog/protocol";

/** The entry types the transcript shows (or vault-chat's own); the rest (the session header, model and thinking-level changes, labels, names, usage) are pi's bookkeeping. */
export function shownEntry(e: PiEntry): boolean {
  if (e.type === "message") return e.message?.role === "user" || e.message?.role === "assistant" || e.message?.role === "toolResult";
  if (e.type === "compaction") return true;
  if (e.type === "custom") return e.customType === VC_NOTE;
  return false;
}

function parseLines(raw: string): PiEntry[] {
  const out: PiEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v.id === "string" && v.type !== "session") out.push(v);
    } catch {
      /* a line pi is still writing */
    }
  }
  return out;
}

/** Every entry of a session file (no header), in append order. */
export function readEntries(file: string): PiEntry[] {
  try {
    return parseLines(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** The new entries of a session file since the last read (pi appends whole lines). */
export class SessionTail {
  private offset = 0;
  private carry = "";
  constructor(readonly file: string, from: "start" | "end" = "start") {
    if (from === "end") {
      try {
        this.offset = readFileSync(file).length;
      } catch {
        this.offset = 0;
      }
    }
  }
  read(): PiEntry[] {
    let fd: number | null = null;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.carry + buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      this.carry = cut < 0 ? text : text.slice(cut + 1);
      return parseLines(cut < 0 ? "" : text.slice(0, cut));
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

const entryId = () => randomBytes(4).toString("hex");

/** A new session file in pi's format (its header) at `file`, for entries no pi writes. */
export function newSessionFile(file: string, cwd: string, id = randomUUID()): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n");
  return file;
}

function lastId(file: string): string | null {
  const es = readEntries(file);
  return es.length ? es[es.length - 1]!.id : null;
}

/** Append entries to a session no pi process has open, each the child of the one before (pi's tree). */
export function appendEntries(file: string, entries: Omit<PiEntry, "id" | "parentId" | "timestamp">[]): PiEntry[] {
  if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true });
  let parent = lastId(file);
  const out: PiEntry[] = [];
  let lines = "";
  for (const e of entries) {
    const full = { ...e, id: entryId(), parentId: parent, timestamp: new Date().toISOString() } as PiEntry;
    parent = full.id;
    out.push(full);
    lines += JSON.stringify(full) + "\n";
  }
  appendFileSync(file, lines);
  return out;
}

/** A vault-chat entry (a line, a notice, a divider) as a pi custom entry. */
export function vcNote(data: { kind: "line" | "notice" | "divider" | "tool"; [k: string]: unknown }): Omit<PiEntry, "id" | "parentId" | "timestamp"> {
  return { type: "custom", customType: VC_NOTE, data };
}

/** A message entry in pi's format (an imported conversation). */
export function piMessage(message: Record<string, unknown>): Omit<PiEntry, "id" | "parentId" | "timestamp"> {
  return { type: "message", message: message as any };
}
