// Files over 50 MB go through git as Git LFS pointers; their bytes live on the box (server/lfs.ts serves them to
// the laptop's git-lfs at <repo>.git/info/lfs). Chosen by size, never by pattern: every such file gets its own
// line in a managed block of the repo's root .gitattributes, kept in step by both sync sides (here for the box,
// src-tauri/src/box_sync.rs for the laptop: same block, same lines). GitHub only ever gets the pointers.
//
// The box has no git-lfs: its working copy uses the filter below (node, no dependencies), which stores a file's
// bytes in .git/lfs/objects (the same layout git-lfs uses, and the store server/lfs.ts serves) and gives the
// working copy the real file back on checkout, so the agent reads the video, not a pointer.
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** A file larger than this goes through Git LFS. */
export const LFS_MIN_BYTES = 50 * 1024 * 1024;
export const LFS_ATTRS = "filter=lfs diff=lfs merge=lfs -text";
export const LFS_BLOCK_BEGIN = "# >>> vault-chat: files over 50 MB, stored with Git LFS on the box";
export const LFS_BLOCK_END = "# <<< vault-chat: files over 50 MB";
/** Both sides add lines at once: the block merges by union (a stale line is dropped at the next staging). */
const SELF_UNION = "/.gitattributes merge=union";

/** The .gitattributes line that sends exactly `path` (repo-relative, forward slashes) through LFS. */
export function lfsAttrLine(path: string): string {
  let p = "/" + path.replace(/[\\*?[]/g, "\\$&");
  if (/[\s"]/.test(p)) p = `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
  return `${p} ${LFS_ATTRS}`;
}

/** The path an lfsAttrLine names, or null. */
export function parseLfsAttrLine(line: string): string | null {
  const suffix = " " + LFS_ATTRS;
  if (!line.endsWith(suffix)) return null;
  let p = line.slice(0, -suffix.length).trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    let o = "";
    const s = p.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c !== "\\" || i + 1 >= s.length) {
        o += c;
        continue;
      }
      const n = s[++i]!;
      o += n === "t" ? "\t" : n === "n" ? "\n" : n;
    }
    p = o;
  }
  if (!p.startsWith("/")) return null;
  let out = "";
  for (let i = 1; i < p.length; i++) {
    if (p[i] === "\\" && i + 1 < p.length) i++;
    out += p[i];
  }
  return out || null;
}

function sizeOf(repo: string, rel: string): number {
  try {
    const st = statSync(join(repo, rel));
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/** The paths the managed block names now. */
export function lfsTrackedPaths(repo: string): string[] {
  let cur = "";
  try {
    cur = readFileSync(join(repo, ".gitattributes"), "utf8");
  } catch {
    return [];
  }
  const out = new Set<string>();
  let inside = false;
  for (const raw of cur.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (l === LFS_BLOCK_BEGIN) inside = true;
    else if (l === LFS_BLOCK_END) inside = false;
    else if (inside) {
      const p = parseLfsAttrLine(l);
      if (p) out.add(p);
    }
  }
  return [...out];
}

/** Rewrite the managed block: the files it named that are still over 50 MB, plus `big`. A deleted, renamed or
 * shrunk file loses its line (it then goes through git as usual). Returns whether .gitattributes changed. */
export function syncLfsAttributes(repo: string, big: string[]): boolean {
  const file = join(repo, ".gitattributes");
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    /* none yet */
  }
  const kept: string[] = [];
  const named: string[] = [];
  let hasBlock = false;
  let inside = false;
  for (const raw of cur.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (l === LFS_BLOCK_BEGIN) {
      inside = true;
      hasBlock = true;
      continue;
    }
    if (l === LFS_BLOCK_END) {
      inside = false;
      continue;
    }
    if (inside) {
      const p = parseLfsAttrLine(l);
      if (p) named.push(p);
      continue;
    }
    kept.push(raw);
  }
  // In the order the block has them, new ones last (the laptop does the same: no rewrite back and forth).
  const want: string[] = [];
  for (const p of [...named.filter((p) => sizeOf(repo, p) > LFS_MIN_BYTES), ...big]) {
    if (!/[\n\r]/.test(p) && !want.includes(p)) want.push(p);
  }
  if (want.length === named.length && want.every((p, i) => p === named[i]) && (hasBlock || !want.length)) return false;
  let next = kept.join("\n").replace(/\n+$/, "");
  if (next) next += "\n";
  if (want.length) {
    next += [LFS_BLOCK_BEGIN, SELF_UNION, ...want.map(lfsAttrLine), LFS_BLOCK_END].join("\n") + "\n";
  }
  if (next === cur) return false;
  writeFileSync(file, next);
  return true;
}

/** The filter the box's working copies use for `filter=lfs` (no git-lfs on the box). Plain node, no deps. */
export const LFS_FILTER_SCRIPT = `// Written by vault-chat (server/lfsAttrs.ts): the box's Git LFS filter. clean stores a file's bytes in
// .git/lfs/objects and hands git the pointer; smudge hands the bytes back (the pointer itself when they are missing).
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
const lfs = join(dirname(fileURLToPath(import.meta.url)), "lfs");
const RE = /^version https:\\/\\/git-lfs\\.github\\.com\\/spec\\/v1\\noid sha256:([0-9a-f]{64})\\nsize ([0-9]+)\\n$/;
const objPath = (oid) => join(lfs, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
const pointer = (oid, size) => "version https://git-lfs.github.com/spec/v1\\noid sha256:" + oid + "\\nsize " + size + "\\n";
// git's filter.lfs.process wins over clean/smudge: a machine with git-lfs installed system-wide sets it, and
// would bypass this store (and leave git-lfs hooks that block the push to the local hub). So this script is
// the process filter too (git's long-running filter protocol, version 2).
async function cleanTo(input, write) {
  mkdirSync(join(lfs, "tmp"), { recursive: true });
  const tmp = join(lfs, "tmp", randomBytes(8).toString("hex"));
  const out = createWriteStream(tmp);
  try {
    const h = createHash("sha256");
    let size = 0;
    const head = [];
    for await (const c of input) {
      h.update(c);
      size += c.length;
      if (size <= 1024) head.push(c);
      if (!out.write(c)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    const small = size <= 1024 ? Buffer.concat(head).toString("utf8") : null;
    if (small !== null && RE.test(small)) {
      rmSync(tmp, { force: true });
      return small;
    }
    const oid = h.digest("hex");
    const dst = objPath(oid);
    if (existsSync(dst) && statSync(dst).size === size) rmSync(tmp, { force: true });
    else {
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(tmp, dst);
    }
    return pointer(oid, size);
  } catch (e) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw e;
  }
}
/** What smudge gives back for these input bytes: the object's path, or the bytes themselves. */
function smudgeSource(buf) {
  const m = buf.length <= 1024 ? RE.exec(buf.toString("utf8")) : null;
  const obj = m ? objPath(m[1]) : null;
  return obj && existsSync(obj) && statSync(obj).size === Number(m[2]) ? obj : null;
}
async function collect(input) {
  const chunks = [];
  for await (const c of input) chunks.push(c);
  return Buffer.concat(chunks);
}
async function clean() {
  process.stdout.write(await cleanTo(process.stdin));
}
async function smudge() {
  const buf = await collect(process.stdin);
  const obj = smudgeSource(buf);
  if (obj) await pipeline(createReadStream(obj), process.stdout);
  else process.stdout.write(buf);
}
// ---- long-running filter protocol (gitprotocol-common pkt-line, gitattributes "Long Running Filter Process") ----
const MAX_PKT = 65516;
function pktReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  async function need(n) {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  }
  /** A packet's payload, null for a flush, undefined at end of input (before any byte of a packet). */
  return async function read() {
    if (!(await need(4))) {
      if (buf.length) throw new Error("truncated pkt-line header");
      return undefined;
    }
    const len = parseInt(buf.subarray(0, 4).toString("ascii"), 16);
    if (!Number.isFinite(len) || (len !== 0 && len < 4)) throw new Error("bad pkt-line length");
    if (len === 0) {
      buf = buf.subarray(4);
      return null;
    }
    if (!(await need(len))) throw new Error("truncated pkt-line");
    const data = buf.subarray(4, len);
    buf = buf.subarray(len);
    return data;
  };
}
async function writeOut(b) {
  if (!process.stdout.write(b)) await new Promise((r) => process.stdout.once("drain", r));
}
async function pkt(data) {
  const b = typeof data === "string" ? Buffer.from(data) : data;
  for (let i = 0; i < b.length || i === 0; i += MAX_PKT) {
    const part = b.subarray(i, i + MAX_PKT);
    await writeOut(Buffer.concat([Buffer.from((part.length + 4).toString(16).padStart(4, "0")), part]));
    if (!b.length) break;
  }
}
const flush = () => writeOut(Buffer.from("0000"));
async function readList(read) {
  const out = [];
  for (;;) {
    const p = await read();
    if (p === undefined) return out.length ? out : undefined;
    if (p === null) return out;
    out.push(p.toString("utf8").replace(/\\n$/, ""));
  }
}
function contentOf(read) {
  const st = { done: false };
  st.chunks = (async function* () {
    for (;;) {
      const p = await read();
      if (p === undefined) throw new Error("input ended inside content");
      if (p === null) {
        st.done = true;
        return;
      }
      yield p;
    }
  })();
  return st;
}
async function serve() {
  const read = pktReader(process.stdin);
  const hello = await readList(read);
  if (!hello || hello[0] !== "git-filter-client" || !hello.includes("version=2")) throw new Error("not a git filter client: " + JSON.stringify(hello));
  await pkt("git-filter-server\\n");
  await pkt("version=2\\n");
  await flush();
  const caps = (await readList(read)) || [];
  for (const c of ["clean", "smudge"]) if (caps.includes("capability=" + c)) await pkt("capability=" + c + "\\n");
  await flush();
  for (;;) {
    const head = await readList(read);
    if (head === undefined) return;
    const kv = Object.fromEntries(head.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const cmd = kv.command;
    let result = null;
    let err = null;
    const content = contentOf(read);
    try {
      if (cmd === "clean") result = Buffer.from(await cleanTo(content.chunks));
      else {
        const buf = await collect(content.chunks);
        if (cmd === "smudge") result = smudgeSource(buf) || buf;
        else err = "unknown command " + cmd;
      }
    } catch (e) {
      err = e && e.message ? e.message : String(e);
      // The rest of this file's content is still on the wire: read past it to stay in step with git.
      while (!content.done) {
        const p = await read();
        if (p === undefined) throw e;
        if (p === null) content.done = true;
      }
    }
    if (err !== null) {
      process.stderr.write("vault-chat lfs filter: " + (kv.pathname || "") + ": " + err + "\\n");
      await pkt("status=error\\n");
      await flush();
      continue;
    }
    await pkt("status=success\\n");
    await flush();
    try {
      if (typeof result === "string") {
        for await (const c of createReadStream(result, { highWaterMark: MAX_PKT })) await pkt(c);
      } else {
        for (let i = 0; i < result.length; i += MAX_PKT) await pkt(result.subarray(i, i + MAX_PKT));
      }
      await flush();
      await flush(); // status unchanged
    } catch (e) {
      process.stderr.write("vault-chat lfs filter: " + (kv.pathname || "") + ": " + (e && e.message ? e.message : e) + "\\n");
      await flush();
      await pkt("status=error\\n");
      await flush();
    }
  }
}
const mode = process.argv[2];
(mode === "process" ? serve() : mode === "clean" ? clean() : smudge()).catch((e) => {
  process.stderr.write("vault-chat lfs filter: " + (e && e.message ? e.message : e) + "\\n");
  process.exit(1);
});
`;

export const LFS_FILTER_NAME = "vault-chat-lfs-filter.mjs";

function shQuote(s: string): string {
  return `"${s.replace(/\\/g, "/").replace(/(["$\`])/g, "\\$1")}"`;
}

/** The filter commands the box configures for a repo's .git. */
export function lfsFilterConfig(gitDir: string, node = process.execPath): Record<string, string> {
  const base = `${shQuote(node)} ${shQuote(join(gitDir, LFS_FILTER_NAME))}`;
  return { "filter.lfs.clean": `${base} clean`, "filter.lfs.smudge": `${base} smudge`, "filter.lfs.process": `${base} process`, "filter.lfs.required": "true" };
}

/** Write the filter script into `<repo>/.git` when it differs (a file read when it does not). */
export function writeLfsFilterScript(repo: string): string {
  const gitDir = join(repo, ".git");
  const p = join(gitDir, LFS_FILTER_NAME);
  let cur: string | null = null;
  try {
    cur = readFileSync(p, "utf8");
  } catch {
    /* none */
  }
  if (cur !== LFS_FILTER_SCRIPT) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, LFS_FILTER_SCRIPT);
  }
  return gitDir;
}

/** Lines of `.git/info/exclude` the old big-file rule wrote for one file (`/<escaped path>`), now over 50 MB:
 * they leave the exclude file, so the file goes through LFS like any other big file. Returns their paths. */
export function releaseExcludedBig(repo: string, skip: (rel: string) => boolean = () => false): string[] {
  const p = join(repo, ".git", "info", "exclude");
  if (!existsSync(p)) return [];
  const cur = readFileSync(p, "utf8");
  const freed: string[] = [];
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of cur.split("\n")) {
    const l = raw.replace(/\r$/, "");
    // The laptop's old managed block (src-tauri box_sync.rs), in case a box repo ever had one.
    if (l === "# >>> vault-chat: files over 50 MB, kept out of git") {
      inBlock = true;
      continue;
    }
    if (inBlock && l === "# <<< vault-chat") {
      inBlock = false;
      continue;
    }
    if (l.startsWith("/") && !l.endsWith("/")) {
      let rel = "";
      for (let i = 1; i < l.length; i++) {
        if (l[i] === "\\" && i + 1 < l.length) i++;
        rel += l[i];
      }
      if (!skip(rel) && sizeOf(repo, rel) > LFS_MIN_BYTES) {
        freed.push(rel);
        continue;
      }
    }
    if (inBlock) continue;
    kept.push(raw);
  }
  if (freed.length) writeFileSync(p, kept.join("\n"));
  return freed;
}
