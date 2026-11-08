// pi's session files (session-format.md), read and — only where no pi process
// has the session open — written in pi's own format. A conversation's
// transcript is these files; the feed (./log.ts) only points into them.
//
// Writing: pi owns a session while a process has it open; then vault-chat's
// entries go through pi itself (the extension's /vc-note command appends a
// custom entry). With no pi on it (a voice-only conversation, a marker after a
// crash, an imported older conversation) this module appends pi-format entries
// itself, each a child of the file's last entry, as pi would.
import { constants as bufferConstants } from "node:buffer";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { lines, alignStart, MAX_RECOVERY_BYTES, checkpointRequired } from "./reader";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { PiEntry } from "../../src/convlog/protocol";
import { VC_NOTE, VC_VOICE } from "../../src/convlog/protocol";
// @ts-ignore a plain .mjs (the pi extension's helpers): the same words pi's extension writes
import { voiceLineContent } from "../engine/policy.mjs";

/** The entry types the transcript shows (or vault-chat's own); the rest (the session header, model and thinking-level changes, labels, names, usage) are pi's bookkeeping. */
export function shownEntry(e: PiEntry): boolean {
  if (e.type === "message") return e.message?.role === "user" || e.message?.role === "assistant" || e.message?.role === "toolResult";
  if (e.type === "compaction") return true;
  if (e.type === "custom") return e.customType === VC_NOTE;
  if (e.type === "custom_message") return e.customType === VC_VOICE;
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

// Native sessions belong to pi, not our canonical-root writer. Preserve native
// history semantics; only a single JSON string's actual V8 ceiling bounds a record.
const MAX_NATIVE_RECORD_BYTES = bufferConstants.MAX_STRING_LENGTH;

/** Explicit OFFLINE tooling only: sequential native decoding. Caller holds event
 * exclusion and verifies native-file identities. Yields one entry at a time,
 * never a whole-session array; malformed native entries fail offline proof. */
export function* offlineEntries(file: string): Generator<PiEntry> {
  for (const { text } of lines(file, 0, undefined, MAX_NATIVE_RECORD_BYTES)) {
    if (!text.trim()) continue;
    // Offline proof must not silently discard malformed native entries.
    const e = JSON.parse(text);
    if (e && typeof e.id === "string" && e.type !== "session") yield e;
  }
}

/** Every entry of a session file (no header), in append order: explicitly O(history).
 * suffixOnly is the intentionally bounded 16 MiB root pointer-cache lookup. */
export function readEntries(file: string, suffixOnly = false): PiEntry[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = suffixOnly ? alignStart(file, Math.max(0, size - MAX_RECOVERY_BYTES), size) : 0;
    const out: PiEntry[] = [];
    for (const { text } of lines(file, start, size, MAX_NATIVE_RECORD_BYTES)) out.push(...parseLines(text));
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return [];
  } finally { if (fd !== null) closeSync(fd); }
}

/** The new complete entries since the previous read. Bytes, not decoded string
 * fragments, own the offset; an interrupted UTF-8 codepoint is read again whole. */
export class SessionTail {
  private offset = 0;
  constructor(readonly file: string, from: "start" | "end" = "start") {
    if (from === "end") {
      let fd: number | null = null;
      try { fd = openSync(file, "r"); this.offset = fstatSync(fd).size; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      finally { if (fd !== null) closeSync(fd); }
    }
  }
  read(): PiEntry[] {
    let fd: number | null = null;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) throw checkpointRequired(this.file, "session truncated while active");
      const out: PiEntry[] = [];
      for (const { text, end } of lines(this.file, this.offset, size, MAX_NATIVE_RECORD_BYTES)) {
        out.push(...parseLines(text)); this.offset = end;
      }
      return out;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return [];
    } finally { if (fd !== null) closeSync(fd); }
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

/** A line said on a voice call as pi's extension writes it (a custom_message: in the model's context). */
export function vcVoice(data: { kind: "line"; role?: unknown; text?: unknown; [k: string]: unknown }): Omit<PiEntry, "id" | "parentId" | "timestamp"> {
  return { type: "custom_message", customType: VC_VOICE, content: voiceLineContent(data) as string, display: true, details: data };
}

/** A message entry in pi's format (an imported conversation). */
export function piMessage(message: Record<string, unknown>): Omit<PiEntry, "id" | "parentId" | "timestamp"> {
  return { type: "message", message: message as any };
}
