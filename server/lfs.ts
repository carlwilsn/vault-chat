// The Git LFS server for the box's repos, next to the git endpoint (server/gitHttp.ts), for the laptop's git-lfs:
//   POST <repo>.git/info/lfs/objects/batch     which objects to send / fetch (basic transfer)
//   PUT  <repo>.git/info/lfs/objects/<oid>     an object's bytes, checked against its sha256
//   GET  <repo>.git/info/lfs/objects/<oid>     an object's bytes
//   POST <repo>.git/info/lfs/verify            the box has it, whole
//   .../locks*                                 404 (no locking)
// <repo> is /git/<vault> (a vault's working copy) or /git/projects/<name>. Objects live in the working copy's
// .git/lfs/objects (git-lfs's own layout): the same store the box's filter (server/lfsAttrs.ts) reads on checkout
// and writes on commit, so an object the laptop sends is the bytes the box's working copy gets. Auth is the
// server's (checked by the caller); GitHub never sees any of it (the laptop's lfs.url names the box).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { validVaultName, vaultPaths } from "./sync";
import { masterDir, repoPaths, validRepoName } from "./master";

/** One object's cap: a screen recording or a model checkpoint, not a disk image. */
export const LFS_MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const LFS_JSON = "application/vnd.git-lfs+json";
const OID_RE = /^[0-9a-f]{64}$/;

const ROUTE_RE = /^(\/git\/(?:projects\/)?[^/]+?)(?:\.git)?\/info\/lfs(\/.*)?$/;

export function isLfsPath(pathname: string): boolean {
  return ROUTE_RE.test(pathname);
}

/** The working copy whose LFS store a /git/…/info/lfs path names (the repos the git endpoint serves). */
export function lfsRepo(pathname: string): string | null {
  const m = ROUTE_RE.exec(pathname);
  if (!m) return null;
  const pm = /^\/git\/projects\/([^/]+)$/.exec(m[1]!);
  if (pm) {
    const master = masterDir();
    const wc = master && validRepoName(pm[1]) ? repoPaths(master, "projects", pm[1]!).wc : "";
    return wc && existsSync(join(wc, ".git")) ? wc : null;
  }
  const name = m[1]!.slice("/git/".length);
  if (name.includes("/") || (name !== loadConfig().vaultName && !validVaultName(name))) return null;
  const wc = vaultPaths(name).vault;
  return existsSync(join(wc, ".git")) ? wc : null;
}

export function lfsObjectPath(wc: string, oid: string): string {
  return join(wc, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

function has(wc: string, oid: string, size?: number): boolean {
  try {
    const st = statSync(lfsObjectPath(wc, oid));
    return st.isFile() && (size === undefined || st.size === size);
  } catch {
    return false;
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": LFS_JSON });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** The URL the laptop reached this server at (tailscale serve keeps the Host; loopback is plain http). */
function originOf(req: IncomingMessage): string {
  const h = (k: string) => {
    const v = req.headers[k];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || "";
  };
  const host = h("x-forwarded-host") || h("host") || "localhost";
  const proto = h("x-forwarded-proto") || (/^(localhost|127\.|\[::1\])/i.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export async function handleLfs(req: IncomingMessage, res: ServerResponse, url: URL, repoOf: (pathname: string) => string | null = lfsRepo): Promise<void> {
  const m = ROUTE_RE.exec(url.pathname);
  const wc = m ? repoOf(url.pathname) : null;
  if (!m || !wc) return reply(res, 404, { message: "no such repository" });
  const rest = m[2] ?? "/";
  const base = `${originOf(req)}${m[1]}.git/info/lfs`;
  const method = req.method ?? "GET";

  if (rest === "/objects/batch" && method === "POST") {
    let body: any;
    try {
      body = await readJson(req);
    } catch (e) {
      return reply(res, 400, { message: `bad batch request: ${(e as Error).message}` });
    }
    const op = body?.operation;
    if (op !== "upload" && op !== "download") return reply(res, 422, { message: "operation must be upload or download" });
    const objects = Array.isArray(body.objects) ? body.objects : [];
    const out = objects.map((o: any) => {
      const oid = String(o?.oid ?? "");
      const size = Number(o?.size);
      if (!OID_RE.test(oid) || !Number.isSafeInteger(size) || size < 0) return { oid, size: o?.size, error: { code: 422, message: "invalid object" } };
      const href = `${base}/objects/${oid}`;
      if (op === "upload") {
        if (size > LFS_MAX_OBJECT_BYTES) return { oid, size, error: { code: 413, message: "object too large (8 GB cap)" } };
        if (has(wc, oid, size)) return { oid, size, authenticated: true };
        return { oid, size, authenticated: true, actions: { upload: { href, expires_in: 86400 }, verify: { href: `${base}/verify`, expires_in: 86400 } } };
      }
      if (!has(wc, oid, size)) return { oid, size, error: { code: 404, message: "object does not exist on the box" } };
      return { oid, size, authenticated: true, actions: { download: { href, expires_in: 86400 } } };
    });
    return reply(res, 200, { transfer: "basic", objects: out, hash_algo: "sha256" });
  }

  const om = /^\/objects\/([0-9a-f]{64})$/.exec(rest);
  if (om && method === "GET") {
    const oid = om[1]!;
    if (!has(wc, oid)) return reply(res, 404, { message: "object does not exist on the box" });
    const p = lfsObjectPath(wc, oid);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(statSync(p).size) });
    createReadStream(p).pipe(res);
    return;
  }
  if (om && method === "PUT") {
    const oid = om[1]!;
    const size = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 0) return reply(res, 411, { message: "Content-Length is required" });
    if (size > LFS_MAX_OBJECT_BYTES) return reply(res, 413, { message: "object too large (8 GB cap)" });
    const tmpDir = join(wc, ".git", "lfs", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `upload-${randomBytes(8).toString("hex")}`);
    const out = createWriteStream(tmp);
    const hash = createHash("sha256");
    let got = 0;
    const err = await new Promise<string | null>((resolve) => {
      let settled = false;
      const end = (e: string | null) => {
        if (!settled) {
          settled = true;
          resolve(e);
        }
      };
      req.on("data", (c: Buffer) => {
        got += c.length;
        hash.update(c);
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
    const digest = hash.digest("hex");
    if (err || digest !== oid) {
      out.destroy();
      rmSync(tmp, { force: true });
      return reply(res, 400, { message: err ?? `the bytes hash to ${digest}, not ${oid}` });
    }
    try {
      const dst = lfsObjectPath(wc, oid);
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(tmp, dst);
    } catch (e) {
      rmSync(tmp, { force: true });
      return reply(res, 500, { message: (e as Error).message });
    }
    res.writeHead(200);
    res.end();
    return;
  }
  if (rest === "/verify" && method === "POST") {
    let body: any;
    try {
      body = await readJson(req);
    } catch (e) {
      return reply(res, 400, { message: (e as Error).message });
    }
    const oid = String(body?.oid ?? "");
    const size = Number(body?.size);
    if (OID_RE.test(oid) && has(wc, oid, Number.isSafeInteger(size) ? size : undefined)) return reply(res, 200, { message: "ok" });
    return reply(res, 404, { message: "object does not exist on the box" });
  }
  if (rest.startsWith("/locks")) return reply(res, 404, { message: "the box does not support Git LFS locking" });
  return reply(res, 404, { message: "not found" });
}
