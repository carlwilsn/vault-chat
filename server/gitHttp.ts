// Git smart HTTP at /git/<vault>.git/* — a CGI bridge to `git http-backend`,
// backed by the bare repo (contract: ~/vaults/<vault>.git). Auth is the
// server's (checked by the caller). A push through here is labelled
// VC_PUSHER=http so the bare repo's pre-receive hook can keep `box` box-only.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "./config";

export function isGitPath(pathname: string): boolean {
  return pathname.startsWith("/git/");
}

export function handleGitHttp(req: IncomingMessage, res: ServerResponse, url: URL, user: string, onPushed: () => void): void {
  const cfg = loadConfig();
  const m = /^\/git\/([^/]+?)(?:\.git)?(\/.*)?$/.exec(url.pathname);
  if (!m || m[1] !== cfg.vaultName || !existsSync(cfg.bareRepo)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such repository" }));
    return;
  }
  const rest = m[2] ?? "/";
  const pathInfo = `/${basename(cfg.bareRepo)}${rest}`;
  const isPush = rest === "/git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: dirname(cfg.bareRepo),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathInfo,
    REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: user,
    REMOTE_ADDR: req.socket.remoteAddress ?? "",
    GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
    VC_PUSHER: "http",
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);
  if (req.headers["content-length"]) env.CONTENT_LENGTH = String(req.headers["content-length"]);

  const child = spawn("git", ["http-backend"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  req.pipe(child.stdin);
  child.stdin.on("error", () => {});

  // Parse the CGI header block, then stream the body.
  let buf = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    let idx = buf.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (idx === -1) {
      idx = buf.indexOf("\n\n");
      sepLen = 2;
    }
    if (idx === -1) return;
    const head = buf.subarray(0, idx).toString("utf8");
    const body = buf.subarray(idx + sepLen);
    let status = 200;
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    for (const line of head.split(/\r?\n/)) {
      const c = line.indexOf(":");
      if (c === -1) continue;
      const k = line.slice(0, c).trim();
      const v = line.slice(c + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10) || 200;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    headersDone = true;
    if (body.length) res.write(body);
  });
  child.on("close", (code) => {
    if (!headersDone) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`git http-backend failed (exit ${code}): ${stderr}`);
      return;
    }
    res.end();
    if (isPush && req.method === "POST") onPushed();
  });
  child.on("error", (e) => {
    if (!headersDone) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`git http-backend: ${e.message}`);
    }
  });
}
