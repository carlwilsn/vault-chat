/** Bounded byte readers. No read of a conversation log may allocate the file. */
import { openSync, closeSync, fstatSync, readSync, statSync, type Stats } from "node:fs";
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
export function checkpointRequired(file: string, reason: string): Error {
  return new Error(`Conversation checkpoint required: ${file}: ${reason}. Use offline checkpoint recovery with the writer stopped; history has not been discarded.`);
}
export type Position = { v: 1; dev: number; ino: number; offset: number; seq: number; birthtimeMs: number };
export function position(file: string, offset: number, seq = 0): Position {
  const s = statSync(file);
  return { v: 1, dev: s.dev, ino: s.ino, offset, seq, birthtimeMs: s.birthtimeMs };
}
/** Complete lines only; retain UTF-8 bytes until the newline, including across chunks.
 * A torn final line is left unread. An oversized record fails, never silently drops data. */
export function* lines(file: string, start = 0, end?: number, maxRecordBytes = MAX_RECORD_BYTES): Generator<{ text: string; end: number }> {
  const fd = openSync(file, "r");
  try {
    const size = Math.min(end ?? Infinity, fstatSync(fd).size);
    if (!Number.isSafeInteger(start) || start < 0 || start > size) throw checkpointRequired(file, "invalid byte position");
    let at = start, parts: Buffer[] = [], length = 0;
    while (at < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - at));
      const n = readSync(fd, buf, 0, buf.length, at);
      if (!n) break;
      let from = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 10) continue;
        length += i - from;
        if (length > maxRecordBytes) throw checkpointRequired(file, maxRecordBytes === MAX_RECORD_BYTES ? "record exceeds 8 MiB" : `record exceeds ${maxRecordBytes} bytes (JavaScript string ceiling)`);
        parts.push(buf.subarray(from, i));
        yield { text: Buffer.concat(parts, length).toString("utf8"), end: at + i + 1 };
        parts = []; length = 0; from = i + 1;
      }
      if (from < n) { parts.push(buf.subarray(from, n)); length += n - from; }
      if (length > maxRecordBytes) throw checkpointRequired(file, maxRecordBytes === MAX_RECORD_BYTES ? "record exceeds 8 MiB" : `record exceeds ${maxRecordBytes} bytes (JavaScript string ceiling)`);
      at += n;
    }
  } finally { closeSync(fd); }
}
/** Advance a suffix window to the next whole line without decoding its partial record. */
export function alignStart(file: string, start: number, size: number): number {
  // Skip the first partial line with byte scanning (it can be a huge historical record).
  let aligned = start;
  if (start) {
    const fd = openSync(file, "r");
    try {
      const b = Buffer.allocUnsafe(CHUNK);
      while (aligned < size) {
        const n = readSync(fd, b, 0, Math.min(b.length, size - aligned), aligned);
        if (!n) break;
        const nl = b.subarray(0, n).indexOf(10);
        if (nl >= 0) { aligned += nl + 1; break; }
        aligned += n;
      }
    } finally { closeSync(fd); }
  }
  return aligned;
}
/** Old checkpoints have only a sequence. Locate that boundary in a bounded suffix,
 * not by replaying/parsing the historical prefix. Never persist a guessed position. */
export function boundary(file: string, seq: number, size: number, conv?: string): number {
  const start = Math.max(0, size - MAX_RECOVERY_BYTES);
  const aligned = alignStart(file, start, size);
  for (const l of lines(file, aligned, size)) {
    // Normal canonical records start with seq; tolerate old field ordering.
    let s = /^\{"seq":(\d+),/.exec(l.text)?.[1];
    if (!s) { try { s = JSON.parse(l.text).seq; } catch { continue; } }
    if (Number(s) === seq) {
      if (conv !== undefined) {
        try { if (JSON.parse(l.text).conv !== conv) throw new Error("mismatch"); }
        catch { throw checkpointRequired(file, "legacy checkpoint conversation mismatch"); }
      }
      return l.end;
    }
  }
  throw checkpointRequired(file, "legacy checkpoint boundary is outside the 16 MiB migration window");
}
export function validatePosition(file: string, p: Position, seq: number, now: Stats = statSync(file)): void {
  if (p.v !== 1 || p.dev !== now.dev || p.ino !== now.ino || !Number.isSafeInteger(p.offset) || p.offset < 1 || p.offset > now.size)
    throw checkpointRequired(file, "log identity/size changed");
  if (p.seq !== seq || p.birthtimeMs !== now.birthtimeMs)
    throw checkpointRequired(file, "checkpoint position/sequence or generation mismatch");
  // The atomic checkpoint owns both picture.seq and its byte position. Do not read
  // the historical prefix to re-prove a boundary the single writer already committed.
}
