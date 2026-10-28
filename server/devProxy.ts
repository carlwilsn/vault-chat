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
//   lifetime     the proxy and the serve entry go when the port stops being the job's (the job ended or was
//                stopped), and with this process.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { authorize, phoneToken } from "./auth";

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

const DENIED = `<!doctype html><meta charset="utf-8"><title>Not signed in</title><p style="font:15px system-ui;padding:24px">This is a dev server on Carl's box. Open it from the vault-chat app on one of his devices.</p>`;

/** A proxy to the dev server at host:port, on 127.0.0.1:<ephemeral>. `auth`: is this request Carl's? */
export function proxyServer(target: { host: string; port: number }, auth: (req: IncomingMessage) => boolean = (req) => authorize(req, new URL(req.url ?? "/", "http://x")).ok): Server {
  const server = createServer((req, res) => {
    if (!auth(req)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(DENIED);
      return;
    }
    const up = httpRequest({ host: target.host, port: target.port, method: req.method, path: forwardPath(req.url), headers: forwardHeaders(req.headers, target.port) }, (r) => {
      const headers = { ...r.headers };
      // A redirect to http://localhost:<port>/x stays on this origin.
      const loc = headers.location;
      if (typeof loc === "string") headers.location = loc.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${target.port}(?=/|$)`), "") || "/";
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

/** `tailscale serve --https=<port> http://127.0.0.1:<to>`, in the foreground: the entry lives as long as the child. */
export function tailscaleExposer(bin: string): Exposer {
  const kids = new Map<number, ChildProcess>();
  const ts = (args: string[]) => spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  let dns: string | null = null;
  const dnsName = (): string | null => {
    if (dns) return dns;
    const r = ts(["status", "--json"]);
    try {
      const n = String(JSON.parse(r.stdout).Self?.DNSName ?? "").replace(/\.$/, "");
      return (dns = n || null);
    } catch {
      return null;
    }
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
  return `Port ${list} listens on all interfaces (0.0.0.0), so on the tailnet it answers without Carl's login. Restart it on localhost: JobStop it, then StartJob again with --host 127.0.0.1 (or without --host; Vite's default is localhost). Show still opens it through the box.`;
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
