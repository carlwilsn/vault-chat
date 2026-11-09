// Files over 50 MB: git never carries them (server/git.ts, src-tauri/src/box_sync.rs), so the laptop
// sends each one's bytes straight to the box's working copy here, next to the git endpoint:
//   PUT /bigfile/<vault>?path=<rel>&mtime=<ms>            a vault (its working copy)
//   PUT /bigfile/projects/<name>?path=<rel>&mtime=<ms>    a project in the vault-chat folder
// The body is the raw file (Content-Length required). It streams to a temp file inside the repo's
// .git (same disk, never seen by `git status`), and only a whole file is moved into place, after its
// path went into the repo's .git/info/exclude: the box's own sync never stages it nor alerts on it.
// The box has the file; GitHub does not (it stays out of git everywhere). Auth is the server's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config";
import { excludeLocally, MAX_FILE_BYTES, runGit, withRepoLock } from "./git";
import { validVaultName, vaultPaths } from "./sync";
import { masterDir, repoPaths, validRepoName } from "./master";

/** One file's cap: a screen recording or a model checkpoint, not a disk image. */
export const BIGFILE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export function isBigFilePath(pathname: string): boolean {
  return pathname.startsWith("/bigfile/");
}

/** The working copy a /bigfile/ path names, the same repos the git endpoint serves (server/gitHttp.ts). */
export function bigFileRepo(pathname: string): string | null {
  const pm = /^\/bigfile\/projects\/([^/]+)$/.exec(pathname);
  if (pm) {
    const m = masterDir();
    const wc = m && validRepoName(pm[1]) ? repoPaths(m, "projects", pm[1]!).wc : "";
    return wc && existsSync(join(wc, ".git")) ? wc : null;
  }
  const vm = /^\/bigfile\/([^/]+)$/.exec(pathname);
  if (!vm) return null;
  const name = vm[1]!;
  if (name !== loadConfig().vaultName && !validVaultName(name)) return null;
  const wc = vaultPaths(name).vault;
  return existsSync(join(wc, ".git")) ? wc : null;
}

/** A vault-relative path the laptop may write: forward slashes, no `..`, never inside .git. */
export function cleanRelPath(raw: unknown): string | null {
  const p = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.length > 1024 || /[\u0000-\u001f]/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  if (parts[0]!.toLowerCase() === ".git") return null;
  return p;
}

function inside(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleBigFile(req: IncomingMessage, res: ServerResponse, url: URL, repoOf: (pathname: string) => string | null = bigFileRepo): Promise<void> {
  if (req.method !== "PUT") return reply(res, 405, { error: "PUT a file's bytes" });
  const wc = repoOf(url.pathname);
  if (!wc) return reply(res, 404, { error: "no such repository" });
  const rel = cleanRelPath(url.searchParams.get("path"));
  if (!rel) return reply(res, 400, { error: "a path inside the repository is required" });
  const size = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(size) || size < 0) return reply(res, 411, { error: "Content-Length is required" });
  // Smaller files go through git; letting them in here would race the sync with an untracked copy.
  if (size <= MAX_FILE_BYTES) return reply(res, 400, { error: "files up to 50 MB go through git" });
  if (size > BIGFILE_MAX_BYTES) return reply(res, 413, { error: "file too large (8 GB cap)" });

  const root = realpathSync(wc);
  const dest = join(root, ...rel.split("/"));
  // The nearest folder that exists must resolve inside the repo (no symlink out of it).
  let probe = dirname(dest);
  while (!existsSync(probe) && inside(root, dirname(probe)) && dirname(probe) !== probe) probe = dirname(probe);
  if (!inside(root, realpathSync(probe))) return reply(res, 403, { error: "outside the repository" });
  if (existsSync(dest) && !statSync(dest).isFile()) return reply(res, 409, { error: "not a file" });
  // A file git tracks on the box stays git's: never overwrite it behind the sync's back.
  const tracked = await runGit(root, ["ls-files", "--", rel]);
  if (tracked.code === 0 && tracked.stdout.trim()) return reply(res, 409, { error: `${rel} is tracked in git on the box` });

  const tmpDir = join(root, ".git", "vault-chat-bigfiles");
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${randomBytes(8).toString("hex")}.part`);
  const out = createWriteStream(tmp);
  let got = 0;
  const done = await new Promise<string | null>((resolve) => {
    let settled = false;
    const end = (err: string | null) => {
      if (!settled) {
        settled = true;
        resolve(err);
      }
    };
    req.on("data", (c: Buffer) => {
      got += c.length;
      if (got > size) {
        end("more bytes than Content-Length");
        req.destroy();
      }
    });
    req.on("aborted", () => end("the upload was cut off"));
    req.on("error", (e) => end(e.message));
    out.on("error", (e) => end(e.message));
    out.on("finish", () => end(got === size ? null : `got ${got} of ${size} bytes`));
    req.pipe(out);
  });
  if (done) {
    out.destroy();
    rmSync(tmp, { force: true });
    return reply(res, 400, { error: done });
  }
  try {
    await withRepoLock(root, async () => {
      excludeLocally(root, rel);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
    });
    const mtime = Number(url.searchParams.get("mtime"));
    if (Number.isFinite(mtime) && mtime > 0) utimesSync(dest, new Date(), new Date(mtime));
  } catch (e) {
    rmSync(tmp, { force: true });
    return reply(res, 500, { error: (e as Error).message });
  }
  return reply(res, 200, { ok: true, path: rel, size: got, abs: dest.split(sep).join("/") });
}
