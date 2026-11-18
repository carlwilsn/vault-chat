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

/** The filter the box's working copies use for `filter=lfs` (no git-lfs on the box). Plain node, no deps. Also a
 * long-running process filter (`process`), set as the repo's filter.lfs.process: git prefers a process filter over
 * clean/smudge, so without it a global git-lfs install (`git lfs install` sets filter.lfs.process) would take the box's
 * files over: smudge --skip leaves pointers in the working copy and git-lfs's pre-push hook fails every push to the
 * local bare repo. */
export const LFS_FILTER_SCRIPT = `// Written by vault-chat (server/lfsAttrs.ts): the box's Git LFS filter. clean stores a file's bytes in
// .git/lfs/objects and hands git the pointer; smudge hands the bytes back (the pointer itself when they are missing).
// "process" speaks git's long-running filter protocol (version 2) for both.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
const lfs = join(dirname(fileURLToPath(import.meta.url)), "lfs");
const RE = /^version https:\\/\\/git-lfs\\.github\\.com\\/spec\\/v1\\noid sha256:([0-9a-f]{64})\\nsize ([0-9]+)\\n$/;
const objPath = (oid) => join(lfs, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
const pointer = (oid, size) => "version https://git-lfs.github.com/spec/v1\\noid sha256:" + oid + "\\nsize " + size + "\\n";
async function cleanFrom(input) {
  mkdirSync(join(lfs, "tmp"), { recursive: true });
  const tmp = join(lfs, "tmp", randomBytes(8).toString("hex"));
  const out = createWriteStream(tmp);
  const h = createHash("sha256");
  let size = 0;
  const head = [];
  try {
    for await (const c of input) {
      h.update(c);
      size += c.length;
      if (size <= 1024) head.push(Buffer.from(c));
      if (!out.write(c)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw e;
  }
  const small = size <= 1024 ? Buffer.concat(head).toString("utf8") : null;
  if (small !== null && RE.test(small)) {
    rmSync(tmp, { force: true });
    return Buffer.from(small);
  }
  const oid = h.digest("hex");
  const dst = objPath(oid);
  if (existsSync(dst) && statSync(dst).size === size) rmSync(tmp, { force: true });
  else {
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(tmp, dst);
  }
  return Buffer.from(pointer(oid, size));
}
/** The bytes smudge gives back, as an iterable of chunks. */
async function smudgeFrom(input) {
  const chunks = [];
  let n = 0;
  for await (const c of input) {
    chunks.push(Buffer.from(c));
    n += c.length;
  }
  const buf = Buffer.concat(chunks);
  const m = n <= 1024 ? RE.exec(buf.toString("utf8")) : null;
  const obj = m ? objPath(m[1]) : null;
  if (obj && existsSync(obj) && statSync(obj).size === Number(m[2])) return createReadStream(obj);
  return [buf];
}
// git's long-running filter protocol: pkt-lines of 4 hex digits of length (with themselves), "0000" = flush.
const MAX_PKT = 65516;
const FLUSH = Buffer.from("0000");
async function put(b) {
  if (!process.stdout.write(b)) await new Promise((r) => process.stdout.once("drain", r));
}
const pkt = (d) => {
  const b = typeof d === "string" ? Buffer.from(d) : d;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
};
function pktReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  const need = async (n) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  };
  // A packet's data, null for a flush, undefined at the end of input.
  return async () => {
    if (!(await need(4))) {
      if (buf.length) throw new Error("input ended inside a pkt-line");
      return undefined;
    }
    const len = parseInt(buf.subarray(0, 4).toString("ascii"), 16);
    if (!Number.isFinite(len) || (len > 0 && len < 4)) throw new Error("bad pkt-line length");
    if (len === 0) {
      buf = buf.subarray(4);
      return null;
    }
    if (!(await need(len))) throw new Error("input ended inside a pkt-line");
    const data = Buffer.from(buf.subarray(4, len));
    buf = buf.subarray(len);
    return data;
  };
}
async function readList(read) {
  const out = [];
  for (;;) {
    const p = await read();
    if (p === undefined) return out.length ? Promise.reject(new Error("input ended inside a list")) : undefined;
    if (p === null) return out;
    out.push(p.toString("utf8").replace(/\\n$/, ""));
  }
}
/** One file's content packets, up to its flush; drain() reads what a failed command left. */
function contentOf(read) {
  let done = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      while (!done) {
        const p = await read();
        if (p === undefined) throw new Error("input ended inside a file's content");
        if (p === null) {
          done = true;
          return;
        }
        yield p;
      }
    },
    async drain() {
      for await (const _ of body) {
        /* skip */
      }
    },
  };
  return body;
}
async function serve() {
  const read = pktReader(process.stdin);
  const hello = await readList(read);
  if (!hello || hello[0] !== "git-filter-client" || !hello.includes("version=2")) throw new Error("not a git filter client (version 2)");
  await put(pkt("git-filter-server\\n"));
  await put(pkt("version=2\\n"));
  await put(FLUSH);
  const caps = await readList(read);
  if (!caps) return;
  for (const c of ["clean", "smudge"]) if (caps.includes("capability=" + c)) await put(pkt("capability=" + c + "\\n"));
  await put(FLUSH);
  for (;;) {
    const head = await readList(read);
    if (head === undefined) return;
    const cmd = (head.find((l) => l.startsWith("command=")) || "").slice(8);
    const path = (head.find((l) => l.startsWith("pathname=")) || "").slice(9);
    const body = contentOf(read);
    let result;
    try {
      if (cmd === "clean") result = [await cleanFrom(body)];
      else if (cmd === "smudge") result = await smudgeFrom(body);
      else throw new Error("unknown command " + JSON.stringify(cmd));
    } catch (e) {
      process.stderr.write("vault-chat lfs filter: " + cmd + " " + path + ": " + (e && e.message ? e.message : e) + "\\n");
      await body.drain();
      await put(pkt("status=error\\n"));
      await put(FLUSH);
      continue;
    }
    await put(pkt("status=success\\n"));
    await put(FLUSH);
    try {
      for await (const c of result) for (let i = 0; i < c.length; i += MAX_PKT) await put(pkt(c.subarray(i, i + MAX_PKT)));
      await put(FLUSH);
      await put(FLUSH); // status unchanged: success
    } catch (e) {
      // Mid-content: end the content and say it failed (git discards what it got).
      process.stderr.write("vault-chat lfs filter: " + cmd + " " + path + ": " + (e && e.message ? e.message : e) + "\\n");
      await put(FLUSH);
      await put(pkt("status=error\\n"));
      await put(FLUSH);
    }
  }
}
const mode = process.argv[2];
(mode === "process"
  ? serve()
  : mode === "clean"
    ? cleanFrom(process.stdin).then((b) => put(b))
    : smudgeFrom(process.stdin).then((r) => pipeline(r, process.stdout))
).catch((e) => {
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
  // process: overrides a global git-lfs install's filter.lfs.process, which git would otherwise prefer (see the script).
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
