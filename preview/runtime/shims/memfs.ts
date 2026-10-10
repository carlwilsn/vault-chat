// In-memory stand-in for the slice of `node:fs` that server/commands/*.ts use.
// The preview reuses those node ports of lib.rs (same on-disk layouts, same
// error strings) against this memory FS, so nothing ever touches a real disk.
// A reload resets every write.
//
// Binary fixtures (PDFs, images) are "lazy": registered with a same-origin URL
// and fetched synchronously on first read, so a big PDF costs nothing until a
// scenario opens it.

type FileNode = { kind: "file"; data: Uint8Array | null; url?: string; size: number; mtimeMs: number };
type DirNode = { kind: "dir"; mtimeMs: number };
type Node = FileNode | DirNode;

const nodes = new Map<string, Node>();
const enc = new TextEncoder();
const dec = new TextDecoder();

let clock: () => number = () => Date.now();
export function setFsClock(fn: () => number): void {
  clock = fn;
}

export function norm(p: string): string {
  let s = String(p).replace(/\\/g, "/");
  const abs = s.startsWith("/");
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/") || (abs ? "/" : ".");
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function enoent(op: string, p: string): Error {
  const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

function ensureDirs(p: string): void {
  const segs = norm(p).split("/").filter(Boolean);
  let cur = "";
  for (const s of segs) {
    cur += "/" + s;
    const n = nodes.get(cur);
    if (!n) nodes.set(cur, { kind: "dir", mtimeMs: clock() });
    else if (n.kind !== "dir") throw new Error(`ENOTDIR: not a directory, mkdir '${cur}'`);
  }
}

function loadLazy(n: FileNode): Uint8Array {
  if (n.data) return n.data;
  if (!n.url) return (n.data = new Uint8Array());
  // Synchronous same-origin fetch: node's readFileSync is synchronous and the
  // ported commands call it that way. x-user-defined keeps raw bytes.
  const xhr = new XMLHttpRequest();
  xhr.open("GET", n.url, false);
  xhr.overrideMimeType("text/plain; charset=x-user-defined");
  xhr.send();
  if (xhr.status !== 200) throw new Error(`preview: lazy fixture ${n.url} → HTTP ${xhr.status}`);
  const t = xhr.responseText;
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0xff;
  n.data = out;
  n.size = out.length;
  return out;
}

// ---- seeding (used by the scenario loader) --------------------------------

export function seedText(path: string, text: string, mtimeMs?: number): void {
  const p = norm(path);
  ensureDirs(parentOf(p));
  const data = enc.encode(text);
  nodes.set(p, { kind: "file", data, size: data.length, mtimeMs: mtimeMs ?? clock() });
}

export function seedLazy(path: string, url: string, size: number, mtimeMs?: number): void {
  const p = norm(path);
  ensureDirs(parentOf(p));
  nodes.set(p, { kind: "file", data: null, url, size, mtimeMs: mtimeMs ?? clock() });
}

export function seedDir(path: string): void {
  ensureDirs(path);
}

export function resetFs(): void {
  nodes.clear();
}

/** Every file under `root` (relative paths), for the in-memory git. */
export function listFiles(root: string): string[] {
  const r = norm(root) + "/";
  const out: string[] = [];
  for (const [p, n] of nodes) if (n.kind === "file" && p.startsWith(r)) out.push(p.slice(r.length));
  return out.sort();
}

export function fileSize(path: string): number | null {
  const n = nodes.get(norm(path));
  return n && n.kind === "file" ? n.size : null;
}

export function readText(path: string): string | null {
  const n = nodes.get(norm(path));
  if (!n || n.kind !== "file") return null;
  return dec.decode(loadLazy(n));
}

export function isLazyBinary(path: string): boolean {
  const n = nodes.get(norm(path));
  return !!n && n.kind === "file" && !!n.url;
}

/** Same-origin URL that serves this file's bytes (for convertFileSrc). */
export function urlFor(path: string): string | null {
  const n = nodes.get(norm(path));
  if (!n || n.kind !== "file") return null;
  return n.url ?? null;
}

export function bytesOf(path: string): Uint8Array | null {
  const n = nodes.get(norm(path));
  if (!n || n.kind !== "file") return null;
  return loadLazy(n);
}

// ---- the node:fs surface ---------------------------------------------------

class Stats {
  constructor(private n: Node) {}
  isDirectory() {
    return this.n.kind === "dir";
  }
  isFile() {
    return this.n.kind === "file";
  }
  isSymbolicLink() {
    return false;
  }
  get size() {
    return this.n.kind === "file" ? this.n.size : 0;
  }
  get mtimeMs() {
    return this.n.mtimeMs;
  }
  get mtime() {
    return new Date(this.n.mtimeMs);
  }
}

class Dirent {
  constructor(public name: string, private n: Node) {}
  isDirectory() {
    return this.n.kind === "dir";
  }
  isFile() {
    return this.n.kind === "file";
  }
  isSymbolicLink() {
    return false;
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return enc.encode(String(data ?? ""));
}

export function existsSync(p: string): boolean {
  return nodes.has(norm(p));
}

export function statSync(p: string, opts?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const n = nodes.get(norm(p));
  if (!n) {
    if (opts && opts.throwIfNoEntry === false) return undefined;
    throw enoent("stat", p);
  }
  return new Stats(n);
}
export const lstatSync = statSync;

export function realpathSync(p: string): string {
  const k = norm(p);
  if (!nodes.has(k)) throw enoent("realpath", p);
  return k;
}

export function readFileSync(p: string, opts?: unknown): any {
  const n = nodes.get(norm(p));
  if (!n) throw enoent("open", p);
  if (n.kind !== "file") throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
  const bytes = loadLazy(n);
  const encoding = typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;
  return encoding ? dec.decode(bytes) : bytes;
}

export function writeFileSync(p: string, data: unknown): void {
  const k = norm(p);
  if (!nodes.has(parentOf(k))) throw enoent("open", p);
  const bytes = toBytes(data);
  nodes.set(k, { kind: "file", data: bytes, size: bytes.length, mtimeMs: clock() });
  touchParent(k);
}

export function appendFileSync(p: string, data: unknown): void {
  const k = norm(p);
  const n = nodes.get(k);
  if (n && n.kind === "file") {
    const prev = loadLazy(n);
    const add = toBytes(data);
    const out = new Uint8Array(prev.length + add.length);
    out.set(prev, 0);
    out.set(add, prev.length);
    nodes.set(k, { kind: "file", data: out, size: out.length, mtimeMs: clock() });
  } else {
    writeFileSync(p, data);
  }
}

export function mkdirSync(p: string, opts?: { recursive?: boolean }): void {
  const k = norm(p);
  if (opts?.recursive) return ensureDirs(k);
  if (nodes.has(k)) throw new Error(`EEXIST: file already exists, mkdir '${p}'`);
  if (!nodes.has(parentOf(k))) throw enoent("mkdir", p);
  nodes.set(k, { kind: "dir", mtimeMs: clock() });
}

export function readdirSync(p: string, opts?: { withFileTypes?: boolean }): any[] {
  const k = norm(p);
  const n = nodes.get(k);
  if (!n) throw enoent("scandir", p);
  if (n.kind !== "dir") throw new Error(`ENOTDIR: not a directory, scandir '${p}'`);
  const prefix = k === "/" ? "/" : k + "/";
  const out: Array<{ name: string; node: Node }> = [];
  for (const [path, node] of nodes) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    out.push({ name: rest, node });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return opts?.withFileTypes ? out.map((e) => new Dirent(e.name, e.node)) : out.map((e) => e.name);
}

export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void {
  const k = norm(p);
  const n = nodes.get(k);
  if (!n) {
    if (opts?.force) return;
    throw enoent("rm", p);
  }
  if (n.kind === "dir") {
    if (!opts?.recursive) throw new Error(`EISDIR: rm a directory without recursive '${p}'`);
    for (const key of [...nodes.keys()]) if (key.startsWith(k + "/")) nodes.delete(key);
  }
  nodes.delete(k);
  touchParent(k);
}
export const unlinkSync = (p: string) => rmSync(p);

export function renameSync(from: string, to: string): void {
  const a = norm(from);
  const b = norm(to);
  const n = nodes.get(a);
  if (!n) throw enoent("rename", from);
  ensureDirs(parentOf(b));
  if (n.kind === "dir") {
    for (const key of [...nodes.keys()]) {
      if (key === a || key.startsWith(a + "/")) {
        const v = nodes.get(key)!;
        nodes.delete(key);
        nodes.set(b + key.slice(a.length), v);
      }
    }
  } else {
    nodes.delete(a);
    nodes.set(b, { ...n, mtimeMs: clock() });
  }
}

export function copyFileSync(from: string, to: string): void {
  const n = nodes.get(norm(from));
  if (!n || n.kind !== "file") throw enoent("copyfile", from);
  const bytes = loadLazy(n);
  ensureDirs(parentOf(norm(to)));
  nodes.set(norm(to), { kind: "file", data: bytes.slice(), size: bytes.length, mtimeMs: clock() });
}

function touchParent(k: string): void {
  const d = nodes.get(parentOf(k));
  if (d) d.mtimeMs = clock();
}

export default {
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  renameSync,
  copyFileSync,
};
