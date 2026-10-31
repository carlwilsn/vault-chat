/** Fixed-size I/O for offline maintenance. Memory is bounded by one record, not log size. */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

export const digest = () => createHash("sha256");
export type File = Awaited<ReturnType<typeof open>>;
export const identity = (s: Awaited<ReturnType<typeof stat>>) => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, nlink: s.nlink });
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function writeAll(fd: File, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error("Short write");
    offset += bytesWritten;
  }
}
export async function syncDir(path: string) {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function hashFile(fd: File, bytes: number, copy?: File) {
  const hash = digest(), chunk = Buffer.alloc(256 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, bytes - offset), offset);
    if (!bytesRead) throw new Error("Unexpected EOF");
    offset += bytesRead;
    const data = chunk.subarray(0, bytesRead);
    hash.update(data);
    if (copy) await writeAll(copy, data);
  }
  return hash.digest("hex");
}
export async function* lines(fd: File, bytes: number, hash: ReturnType<typeof digest>, maxLine = 32 * 1024 * 1024) {
  let offset = 0, parts: Buffer[] = [], pending = 0;
  while (offset < bytes) {
    const chunk = Buffer.alloc(Math.min(256 * 1024, bytes - offset));
    const { bytesRead } = await fd.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) throw new Error("Unexpected EOF");
    offset += bytesRead;
    const data = chunk.subarray(0, bytesRead);
    hash.update(data);
    let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      const part = data.subarray(start, end + 1);
      if (pending + part.length - 1 > maxLine) throw new Error("Line exceeds 32MiB safety bound");
      yield parts.length ? Buffer.concat([...parts, part], pending + part.length) : part;
      parts = []; pending = 0; start = end + 1;
    }
    const tail = data.subarray(start);
    if (tail.length) { parts.push(tail); pending += tail.length; }
    if (pending > maxLine) throw new Error("Line exceeds 32MiB safety bound");
  }
  if (pending) throw new Error("Torn final record (possibly dangling UTF-8); refusing to discard bytes");
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
export const parseRecord = (line: Buffer) => JSON.parse(utf8.decode(line));
