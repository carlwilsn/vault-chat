// The agent's dev servers on Carl's devices: `Show {url: "http://localhost:5173"}` opens
// https://<the box on the tailnet>:5173/ on his laptop or phone, live, hot reload included.
//
//   which ports  only a loopback port a StartJob job of this vault listens on (its process is in the job's
//                systemd unit, `vc-job-<id>`: /proc/<pid>/cgroup, its socket in /proc/net/tcp{,6}). Never this
//                server's own port, the voice pipeline, the key store or any other service: those are not in a
//                job, and the server's own ports are refused by name too.
//   the way in   `tailscale serve --https=<port>` (run in the foreground by this server: the entry goes away with
//                it) → a proxy of ours on 127.0.0.1:<ephemeral> → the dev server. Tailnet only, never Funnel. Each
//                dev server gets its own origin (its absolute paths and its websocket just work, no base path),
//                and the proxy lets in only what every other route lets in (server/auth.ts: Carl's tailnet login,
//                or the token cookie/header). The token and the tailnet identity headers are taken off the
//                request before it reaches the agent's server.
//   hot reload   websocket upgrades are proxied byte for byte; Host and Origin say localhost:<port>, as the dev
//                server expects (Vite refuses other hosts).
//   in the app   the laptop's viewer shows a dev server as an iframe in the app's own page (src/plugins/viewer/WebPane.tsx),
//                so it moves and resizes with the app. The proxy lets the app's origins frame it (and only them: its
//                X-Frame-Options and any frame-ancestors give way to `frame-ancestors 'self' <app origins>`), and into
//                a page the app's frame asks for (Sec-Fetch-Dest: iframe) it puts FRAME_SCRIPT, which tells the app
//                where the page is and its title (the pane's address and title row, for the workspace noun's watch).
//   lifetime     opened by Show, and by `restore` for every port a running job of the vault listens on (at server
//                start, so a pane survives a box restart, and each job tick); the proxy and the serve entry go when
//                the port stops being the job's (the job ended or was stopped), and with this process.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { authorize, phoneToken } from "./auth";
import { PAGE_SNAP_BRIDGE } from "../src/pageSnap";

// ---------------------------------------------------------------- which ports are the agent's

/** `all`: bound to every address (0.0.0.0 or ::), so reachable on the tailnet without the proxy's login check. */
export type Listener = { port: number; host: string; inode: string; all?: boolean };

/** Listening TCP sockets on loopback or every address (a dev server bound to 0.0.0.0 is reachable on loopback too). */
export function listeners(proc = "/proc"): Listener[] {
  const out: Listener[] = [];
  for (const [file, v6] of [["tcp", false], ["tcp6", true]] as const) {
    let text = "";
    try {
      text = readFileSync(join(proc, "net", file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue; // 0A = LISTEN
      const [hexIp, hexPort] = f[1]!.split(":");
      const host = v6 ? ipv6(hexIp!) : ipv4(hexIp!);
      if (!host) continue;
      const all = v6 ? hexIp === "00000000000000000000000000000000" : hexIp === "00000000";
      out.push({ port: parseInt(hexPort!, 16), host, inode: f[9]!, ...(all ? { all } : {}) });
    }
  }
  return out;
}

function ipv4(hex: string): string | null {
  if (hex.length !== 8) return null;
  const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).reverse();
  const ip = b.join(".");
  if (ip === "0.0.0.0") return "127.0.0.1";
  return b[0] === 127 ? ip : null;
}

function ipv6(hex: string): string | null {
  if (hex === "00000000000000000000000000000000") return "127.0.0.1"; // :: (every address)
  if (hex === "00000000000000000000000001000000") return "::1";
  // ::ffff:127.x.x.x
  if (hex.startsWith("0000000000000000FFFF0000")) return ipv4(hex.slice(24));
  return null;
}

/** The StartJob job ids each process belongs to, by its systemd unit (vc-job-<id>.service). */
export function jobPids(proc = "/proc"): Map<number, string> {
  const out = new Map<number, string>();
  let pids: string[] = [];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const p of pids) {
    let cg = "";
    try {
      cg = readFileSync(join(proc, p, "cgroup"), "utf8");
    } catch {
      continue;
    }
    const m = /\/vc-job-([a-z0-9-]+)\.service(?:\/|$)/m.exec(cg);
    if (m) out.set(Number(p), m[1]!);
  }
  return out;
}

/** port → {job id, the loopback address to reach it on, `all`: some socket of it listens on every address}:
 *  the loopback ports StartJob jobs listen on. */
export function jobPorts(proc = "/proc"): Map<number, { job: string; host: string; all?: boolean }> {
  const socks = new Map<string, Listener>();
  for (const l of listeners(proc)) socks.set(l.inode, l);
  const out = new Map<number, { job: string; host: string; all?: boolean }>();
  if (!socks.size) return out;
  for (const [pid, job] of jobPids(proc)) {
    let fds: string[] = [];
    try {
      fds = readdirSync(join(proc, String(pid), "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = readlinkSync(join(proc, String(pid), "fd", fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      const l = m ? socks.get(m[1]!) : undefined;
      if (!l) continue;
      const had = out.get(l.port);
      const all = !!(had?.all || l.all);
      const host = had && !(had.host !== "127.0.0.1" && l.host === "127.0.0.1") ? had.host : l.host;
      out.set(l.port, { job, host, ...(all ? { all } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the proxy

const STRIP_HEADERS = ["x-vault-token", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info", "tailscale-app-capabilities"];

/** The request's headers for the dev server: no token, no identity, Host and Origin as on the box itself. */
export function forwardHeaders(h: IncomingMessage["headers"], port: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !STRIP_HEADERS.includes(k.toLowerCase())) out[k] = v;
  const cookie = typeof h.cookie === "string" ? h.cookie.split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith("vc_token=")).join("; ") : "";
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  out.host = `localhost:${port}`;
  if (h.origin) out.origin = `http://localhost:${port}`;
  return out;
}

/** The request path with the token taken out of its query. */
export function forwardPath(raw: string | undefined): string {
  const u = new URL(raw ?? "/", "http://x");
  const t = phoneToken();
  if (t && u.searchParams.get("token") === t) u.searchParams.delete("token");
  return u.pathname + u.search;
}

/** The app's own origins (the Tauri webview: Windows http(s)://tauri.localhost, macOS tauri://localhost): the only
 *  pages besides the dev server itself that may frame it. */
export const APP_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

/** The message FRAME_SCRIPT posts to the app: {vcFrame: "at", url, title}. */
export const FRAME_MESSAGE = "at";
/** Its second message, what the page shows (the workspace noun's read of a dev pane):
 *  {vcFrame: "page", url, title, text, errors, failed}. */
export const FRAME_PAGE_MESSAGE = "page";
/** Bounds on that report: the visible text (characters), console errors and failed requests (the last ones kept). */
export const FRAME_PAGE_LIMITS = { text: 8000, errors: 20, failed: 30 } as const;

/** Put in a page the app's pane frames (only when the app itself is its parent, never in a frame the page nests): posts
 *  the page's address and title to the app on load, title change and in-page navigation. It also reports what Carl
 *  sees in it, so the agent can read it (parity: a read, not a picture): its visible text (trimmed, bounded), console
 *  errors and uncaught errors, and requests that failed (status and address: fetch, XHR, and scripts / styles / images
 *  by the resource timing), at most every 2 s after the page changes. It listens to nothing; PAGE_SNAP_BRIDGE (put in
 *  beside it) answers the window drawing's request for a picture. The parent is an app origin (frame-ancestors says
 *  so); ancestorOrigins names which. */
export function frameScript(origins: string[] = APP_ORIGINS): string {
  const L = FRAME_PAGE_LIMITS;
  return `<script>(function(){try{if(window.top===window||window.parent!==window.top)return;var A=${JSON.stringify(origins)},o=location.ancestorOrigins&&location.ancestorOrigins[0],T=o&&A.indexOf(o)>=0?[o]:A,P=window.parent,last="";function post(m){for(var i=0;i<T.length;i++)try{P.postMessage(m,T[i])}catch(e){}}function say(){var u=location.href,t=document.title||"";if(u+" "+t===last)return;last=u+" "+t;post({vcFrame:${JSON.stringify(FRAME_MESSAGE)},url:u,title:t});page()}` +
    // What the page shows: errors, failed requests and its text, sent when something changed, at most every 2 s.
    `var E=[],F=[],pt=0,pl=0,ps="",W=window,ST=W.setTimeout,C=W.console;function now(){return Date.now()}function clip(x,n){x=String(x);return x.length>n?x.slice(0,n)+"\\u2026":x}function str(a){try{if(a&&a.stack)return String(a.stack);if(a&&a.message)return String(a.message);if(a&&typeof a==="object")return JSON.stringify(a)}catch(e){}return String(a)}function abs(u){try{return new URL(u,location.href).href}catch(e){return String(u)}}function err(m){m=clip(m,400);if(E.length&&E[E.length-1]===m)return;E.push(m);if(E.length>${L.errors})E.shift();page()}function fail(st,u,how){u=clip(abs(u),300);for(var i=0;i<F.length;i++)if(F[i].url===u&&F[i].status===st)return;var f={status:st,url:u};if(how)f.how=how;F.push(f);if(F.length>${L.failed})F.shift();page()}` +
    `function text(){var b=document.body;if(!b)return "";var x=String(b.innerText||b.textContent||"").replace(/[ \\t\\u00a0]+/g," ").replace(/ *\\n\\s*/g,"\\n").trim();return x}function send(){pt=0;pl=now();var x=text(),m={vcFrame:${JSON.stringify(FRAME_PAGE_MESSAGE)},url:location.href,title:document.title||"",text:clip(x,${L.text}),textLength:x.length,errors:E.slice(),failed:F.slice()},j=JSON.stringify(m);if(j===ps)return;ps=j;post(m)}function page(){if(pt||!ST)return;pt=ST(send,Math.max(600,2000-(now()-pl)))}` +
    `if(C&&C.error){var ce=C.error;C.error=function(){try{err([].map.call(arguments,str).join(" "))}catch(e){}return ce.apply(this,arguments)}}addEventListener("error",function(e){var t=e&&e.target;if(t&&t!==W&&t.tagName){var s=t.src||t.href;if(s)fail(0,s,"load "+String(t.tagName).toLowerCase());return}err((e&&e.message||"error")+(e&&e.filename?" ("+e.filename+":"+e.lineno+")":""))},true);addEventListener("unhandledrejection",function(e){var r=e&&e.reason;if(r&&r.name==="AbortError")return;err("unhandled rejection: "+str(r))});` +
    `if(W.fetch){var of=W.fetch;W.fetch=function(i,q){var u=typeof i==="string"?i:i&&i.url||String(i),m=q&&q.method||i&&i.method||"GET";return of.apply(this,arguments).then(function(r){if(r&&!r.ok&&r.type!=="opaque")fail(r.status,r.url||u,m);return r},function(x){if(!(x&&x.name==="AbortError"))fail(0,u,m+": "+clip(str(x),120));throw x})}}` +
    `var X=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(X){var xo=X.open,xs=X.send;X.open=function(m,u){this.__vc=[m,u];return xo.apply(this,arguments)};X.send=function(){var x=this;try{x.addEventListener("loadend",function(){if(x.status===0||x.status>=400)fail(x.status,x.responseURL||x.__vc&&x.__vc[1]||"",x.__vc&&x.__vc[0]||"GET")})}catch(e){}return xs.apply(this,arguments)}}` +
    `if(W.PerformanceObserver)try{new PerformanceObserver(function(l){l.getEntries().forEach(function(n){if(n.responseStatus>=400&&n.initiatorType!=="fetch"&&n.initiatorType!=="xmlhttprequest")fail(n.responseStatus,n.name,n.initiatorType)})}).observe({type:"resource",buffered:true})}catch(e){}` +
    `["pushState","replaceState"].forEach(function(k){var f=history[k];history[k]=function(){var r=f.apply(this,arguments);setTimeout(say,0);return r}});addEventListener("popstate",say);addEventListener("hashchange",say);addEventListener("DOMContentLoaded",function(){say();page();var h=document.querySelector("head");if(h&&W.MutationObserver)new MutationObserver(say).observe(h,{subtree:true,childList:true,characterData:true});if(document.body&&W.MutationObserver)new MutationObserver(page).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true})});addEventListener("load",function(){say();page()});say()}catch(e){}})();</script>${PAGE_SNAP_BRIDGE}`;
}

/** A page's HTML with FRAME_SCRIPT in its head (after <head>, else after the doctype / <html>, else first). */
export function withFrameScript(html: string, origins: string[] = APP_ORIGINS): string {
  const tag = frameScript(origins);
  const m = /<head(?:\s[^>]*)?>/i.exec(html) ?? /<html(?:\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
}

/** The dev server's response headers, framable by the app: no X-Frame-Options, its own frame-ancestors dropped and
 *  ours (`'self'` and the app's origins) set instead. */
export function framableHeaders(h: IncomingMessage["headers"], origins: string[] = APP_ORIGINS): IncomingMessage["headers"] {
  const out: IncomingMessage["headers"] = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === "x-frame-options") continue;
    if (key === "content-security-policy") {
      const kept = (Array.isArray(v) ? v : [v ?? ""]).map((x) => String(x).split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d)).join("; ")).filter(Boolean);
      if (kept.length) out[key] = kept;
      continue;
    }
    out[key] = v;
  }
  const ours = `frame-ancestors 'self' ${origins.join(" ")}`;
  const csp = out["content-security-policy"];
  out["content-security-policy"] = csp ? [...(Array.isArray(csp) ? csp : [csp]), ours] : ours;
  return out;
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>Not signed in</title><p style="font:15px system-ui;padding:24px">This is a dev server on Carl's box. Open it from the vault-chat app on one of his devices.</p>`;

/** A proxy to the dev server at host:port, on 127.0.0.1:<ephemeral>. `auth`: is this request Carl's? `origins`: who
 *  may frame it (the app's). */
export function proxyServer(target: { host: string; port: number }, auth: (req: IncomingMessage) => boolean = (req) => authorize(req, new URL(req.url ?? "/", "http://x")).ok, origins: string[] = APP_ORIGINS): Server {
  const server = createServer((req, res) => {
    if (!auth(req)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(DENIED);
      return;
    }
    // A page the app's pane frames gets FRAME_SCRIPT: asked for unencoded, so it can be put in.
    const framed = req.headers["sec-fetch-dest"] === "iframe" && (req.method === "GET" || req.method === "HEAD");
    const fwd = forwardHeaders(req.headers, target.port);
    if (framed) fwd["accept-encoding"] = "identity";
    const up = httpRequest({ host: target.host, port: target.port, method: req.method, path: forwardPath(req.url), headers: fwd }, (r) => {
      const headers = framableHeaders(r.headers, origins);
      // A redirect to http://localhost:<port>/x stays on this origin.
      const loc = headers.location;
      if (typeof loc === "string") headers.location = loc.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${target.port}(?=/|$)`), "") || "/";
      const enc = String(headers["content-encoding"] ?? "identity").toLowerCase();
      if (framed && req.method === "GET" && /^text\/html/i.test(String(headers["content-type"] ?? "")) && enc === "identity") {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => {
          const body = Buffer.from(withFrameScript(Buffer.concat(parts).toString("utf8"), origins), "utf8");
          delete headers["content-length"];
          delete headers["transfer-encoding"];
          delete headers.etag; // the same bytes from the dev server are not the same page any more
          res.writeHead(r.statusCode ?? 200, r.statusMessage, { ...headers, "content-length": String(body.length) });
          res.end(body);
        });
        r.on("error", () => res.destroy());
        return;
      }
      res.writeHead(r.statusCode ?? 502, r.statusMessage, headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`The dev server on port ${target.port} did not answer (${e.message}). Is it still running?`);
    });
    req.pipe(up);
  });
  server.on("upgrade", (req, sock, head) => {
    if (!auth(req)) {
      sock.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = connect(target.port, target.host, () => {
      const h = forwardHeaders(req.headers, target.port);
      const lines = [`${req.method} ${forwardPath(req.url)} HTTP/1.1`];
      for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${x}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    const end = () => {
      up.destroy();
      sock.destroy();
    };
    up.on("error", end);
    sock.on("error", end);
    up.on("close", end);
    sock.on("close", end);
  });
  return server;
}

// ---------------------------------------------------------------- tailscale serve

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

let tsBin: string | null | undefined;
/** The tailscale CLI: $VC_TAILSCALE, PATH, then the NixOS system profile. */
export function findTailscale(): string | null {
  if (tsBin !== undefined) return tsBin;
  if (process.env.VC_TAILSCALE !== undefined) return (tsBin = process.env.VC_TAILSCALE && isFile(process.env.VC_TAILSCALE) ? process.env.VC_TAILSCALE : null);
  for (const d of [...(process.env.PATH ?? "").split(delimiter), "/run/current-system/sw/bin", "/usr/bin", "/usr/local/bin"]) {
    const p = join(d, process.platform === "win32" ? "tailscale.exe" : "tailscale");
    if (d && isFile(p)) return (tsBin = p);
  }
  return (tsBin = null);
}

export type Exposer = {
  /** The tailnet origin a port is served on (https://box.tailnet.ts.net:<port>), once `serve` is up. */
  open(port: number, to: number): Promise<{ origin: string } | { error: string }>;
  close(port: number): void;
};

/** The ports a `tailscale serve status --json` serves: its own TCP entries and every foreground session's. */
export function servedPorts(st: any): Set<number> {
  const out = new Set<number>();
  const add = (tcp: unknown) => {
    if (tcp && typeof tcp === "object") for (const k of Object.keys(tcp)) if (Number(k)) out.add(Number(k));
  };
  add(st?.TCP);
  for (const f of Object.values(st?.Foreground ?? {})) add((f as any)?.TCP);
  return out;
}

/** This machine's exact private HTTPS hostname, from the local Tailscale daemon.
 * Read-only discovery shared by development previews and the MCP Host guard. */
export function tailscaleDnsName(bin: string): string | null {
  const r = spawnSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  try {
    const n = String(JSON.parse(r.stdout).Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    return n || null;
  } catch {
    return null;
  }
}

/** `tailscale serve --https=<port> http://127.0.0.1:<to>`, in the foreground: the entry lives as long as the child. */
export function tailscaleExposer(bin: string): Exposer {
  const kids = new Map<number, ChildProcess>();
  const ts = (args: string[]) => spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  let dns: string | null = null;
  const dnsName = (): string | null => {
    if (dns) return dns;
    return (dns = tailscaleDnsName(bin));
  };
  const served = (port: number): boolean => {
    const r = ts(["serve", "status", "--json"]);
    try {
      return servedPorts(JSON.parse(r.stdout || "{}")).has(port);
    } catch {
      return false;
    }
  };
  return {
    async open(port, to) {
      const host = dnsName();
      if (!host) return { error: "this box's tailnet name is unknown (tailscale status)" };
      if (served(port)) return { error: `port ${port} is already served on the tailnet by something else (tailscale serve status)` };
      let err = "";
      let said = "";
      const kid = spawn(bin, ["serve", `--https=${port}`, `http://127.0.0.1:${to}`], { stdio: ["ignore", "pipe", "pipe"] });
      kid.stdout?.on("data", (c) => (said += c));
      kid.stderr?.on("data", (c) => (err += c));
      let exited = false;
      kid.on("exit", () => {
        exited = true;
        if (kids.get(port) === kid) kids.delete(port);
      });
      kid.on("error", (e) => (err += e.message));
      kids.set(port, kid);
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        if (exited) return { error: `tailscale serve refused: ${err.trim().slice(0, 300) || "it exited"}` };
        // It says "Available within your tailnet: https://<host>:<port>/" once the entry is in.
        if (said.includes(`${host}:${port}`) || served(port)) return { origin: `https://${host}:${port}` };
        await new Promise((r) => setTimeout(r, 250));
      }
      kid.kill();
      return { error: "tailscale serve did not come up within 10 s" };
    },
    close(port) {
      const k = kids.get(port);
      kids.delete(port);
      k?.kill("SIGTERM");
    },
  };
}

// ---------------------------------------------------------------- the manager

export type DevDeps = {
  /** port → its job: the loopback ports StartJob jobs listen on (default: /proc). */
  ports?: () => Map<number, { job: string; host: string }>;
  /** How a port reaches Carl's devices (default: tailscale serve; null: no tailscale here). */
  exposer?: Exposer | null;
  /** Ports never proxied, whatever listens there (this server, the voice pipeline). */
  refuse?: number[];
  /** Request authorisation (default server/auth.ts). */
  auth?: (req: IncomingMessage) => boolean;
};

type Open = { port: number; job: string; server: Server; origin: string };

export class DevProxies {
  private open = new Map<number, Open>();
  private pending = new Map<number, Promise<{ origin: string } | { error: string }>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private d: DevDeps = {}) {}

  private ports() {
    return (this.d.ports ?? (() => jobPorts()))();
  }
  private exposer(): Exposer | null {
    if (this.d.exposer !== undefined) return this.d.exposer;
    const bin = findTailscale();
    return (this.d.exposer = bin ? tailscaleExposer(bin) : null);
  }

  /** The origin Carl's devices reach `port` on, or why not. `jobs`: the ids of this vault's jobs (another vault's are not its). */
  async url(port: number, jobs: Set<string>): Promise<{ origin: string; job: string } | { error: string }> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${port} is not a port` };
    if ((this.d.refuse ?? []).includes(port)) return { error: `port ${port} is this server's own (or the voice pipeline's): never proxied` };
    const owner = this.ports().get(port);
    if (!owner) return { error: `nothing that StartJob started listens on port ${port} on the box (only a dev server you started with StartJob is proxied — never the server itself, the key store or another service). Start it with StartJob (e.g. "npm run dev"), wait until its log says it is ready, then Show it again.` };
    if (!jobs.has(owner.job)) return { error: `port ${port} belongs to job ${owner.job}, which is not this vault's` };
    const have = this.open.get(port);
    if (have && have.job === owner.job) return { origin: have.origin, job: owner.job };
    if (have) this.close(port);
    let p = this.pending.get(port);
    if (!p) {
      p = this.start(port, owner).finally(() => this.pending.delete(port));
      this.pending.set(port, p);
    }
    const r = await p;
    return "error" in r ? r : { origin: r.origin, job: owner.job };
  }

  private async start(port: number, owner: { job: string; host: string }): Promise<{ origin: string } | { error: string }> {
    const ex = this.exposer();
    if (!ex) return { error: "tailscale is not on this box, so its dev servers can't reach Carl's devices" };
    const server = proxyServer({ host: owner.host, port }, this.d.auth);
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
    const to = (server.address() as AddressInfo).port;
    const r = await ex.open(port, to);
    if ("error" in r) {
      server.close();
      return r;
    }
    this.open.set(port, { port, job: owner.job, server, origin: r.origin });
    console.log(`[dev] port ${port} (job ${owner.job}) on ${r.origin}`);
    this.watch();
    return r;
  }

  close(port: number): void {
    const o = this.open.get(port);
    if (!o) return;
    this.open.delete(port);
    this.d.exposer?.close(port);
    o.server.close();
    o.server.closeAllConnections?.();
    console.log(`[dev] port ${port} closed`);
  }

  /** Close what no job listens on any more. */
  sweep(): void {
    if (!this.open.size) return;
    const now = this.ports();
    for (const o of [...this.open.values()]) if (now.get(o.port)?.job !== o.job) this.close(o.port);
  }

  /** Ports whose opening failed lately (port → {job, until}): not tried again by `restore` before then. */
  private failed = new Map<number, { job: string; until: number }>();

  /** Open the proxy for every port `jobs` (this vault's running StartJob jobs) listen on that has none: at server
   *  start (a job that outlived a restart keeps its tailnet address, so a pane showing it still loads) and each job
   *  tick (a job that started listening since). The same checks as `url`; a port that failed waits a minute. */
  async restore(jobs: Set<string>): Promise<{ port: number; job: string; origin?: string; error?: string }[]> {
    if (!jobs.size) return [];
    const out: { port: number; job: string; origin?: string; error?: string }[] = [];
    const now = Date.now();
    for (const [port, owner] of this.ports()) {
      if (!jobs.has(owner.job) || (this.d.refuse ?? []).includes(port)) continue;
      if (this.open.get(port)?.job === owner.job || this.pending.has(port)) continue;
      const f = this.failed.get(port);
      if (f && f.job === owner.job && f.until > now) continue;
      const r = await this.url(port, jobs);
      if ("error" in r) {
        this.failed.set(port, { job: owner.job, until: Date.now() + 60_000 });
        console.log(`[dev] port ${port} (job ${owner.job}) not reopened: ${r.error}`);
        out.push({ port, job: owner.job, error: r.error });
      } else {
        this.failed.delete(port);
        out.push({ port, job: owner.job, origin: r.origin });
      }
    }
    return out;
  }

  /** What is proxied now (tests, health). */
  list(): { port: number; job: string; origin: string }[] {
    return [...this.open.values()].map(({ port, job, origin }) => ({ port, job, origin }));
  }

  closeAll(): void {
    for (const p of [...this.open.keys()]) this.close(p);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        /* next time */
      }
      if (!this.open.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 10_000);
    this.timer.unref?.();
  }
}

let shared: DevProxies | null = null;
/** This server's one set of dev proxies. */
export function devProxies(refuse: number[] = []): DevProxies {
  if (!shared) {
    shared = new DevProxies({ refuse });
    process.on("exit", () => shared?.closeAll());
  }
  return shared;
}

/** The line a job's row and JobStatus give when it listens on every address (0.0.0.0): it works, but on the tailnet
 *  that port answers without Carl's login, so the agent is told to restart it on 127.0.0.1. Empty when none does. */
export function exposedNote(ports: number[]): string {
  if (!ports.length) return "";
  const list = ports.join(", ");
  return `Port ${list} listens on all interfaces (0.0.0.0), so on the tailnet it answers without Carl's login. Restart it on localhost: stop it (box:jobs stop), then StartJob again with --host 127.0.0.1 (or without --host; Vite's default is localhost). Show still opens it through the box.`;
}

/** Common dev servers read these for the address they bind: StartJob sets them (an explicit flag still wins). */
export const DEV_HOST_ENV: Record<string, string> = { HOST: "127.0.0.1" };

/** A command that asks for every interface (`--host` alone or 0.0.0.0, `-H 0.0.0.0`, `--bind 0.0.0.0`, `--hostname 0.0.0.0`). */
export function asksAllInterfaces(cmd: string): boolean {
  const end = String.raw`(?=\s|$|[;&|)'"])`;
  return (
    new RegExp(String.raw`(?:^|\s)(?:--host|--hostname|--bind|-H|-b)(?:[= ]+['"]?(?:0\.0\.0\.0|::|\[::\]|true)['"]?${end})`).test(cmd) ||
    // `--host` with no value (Vite: every interface).
    new RegExp(String.raw`(?:^|\s)--host(?=\s+-|\s*$|\s*[;&|)])`).test(cmd)
  );
}

/** "http://localhost:5173/x?y" → {port: 5173, path: "/x?y"}; null when it is not a loopback address. */
export function loopbackUrl(raw: string): { port: number; path: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!(h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h))) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { port, path: u.pathname + u.search + u.hash };
}
