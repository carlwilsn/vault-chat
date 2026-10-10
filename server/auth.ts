// Request authorisation (contract):
//   • loopback — a request from 127.0.0.1/::1 that did NOT come through a
//     proxy. `tailscale serve` proxies to 127.0.0.1 too, so every tailnet
//     request also arrives from loopback; it is told apart by the forwarding
//     headers serve adds (X-Forwarded-For / -Host / -Proto) or its identity
//     header. Without this distinction "loopback" would admit the whole
//     tailnet (and a Funnel, if one were ever turned on).
//   • Tailscale-User-Login equal to an allowed login. Serve strips any
//     client-supplied copy of this header and sets it for tailnet users
//     (tagged devices and Funnel traffic get none) — tailscale.com/kb/1312.
//   • the existing phone token: X-Vault-Token header, vc_token cookie, or
//     ?token= (voice_server.rs:285 token_ok).
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config";

let token: string | null | undefined;

export function phoneToken(): string | null {
  if (token !== undefined) return token;
  try {
    const t = readFileSync(loadConfig().tokenPath, "utf8").trim();
    token = t || null;
  } catch {
    token = null;
  }
  return token;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

/** Direct local caller (the updater, curl on the box, the laptop's tests). */
export function isDirectLoopback(req: IncomingMessage): boolean {
  if (!isLoopbackAddr(req.socket.remoteAddress)) return false;
  return !header(req, "x-forwarded-for") && !header(req, "x-forwarded-host") && !header(req, "tailscale-user-login");
}

export function tokenOk(req: IncomingMessage, url: URL): boolean {
  const t = phoneToken();
  if (!t) return false;
  if (header(req, "x-vault-token") === t) return true;
  const cookie = header(req, "cookie") ?? "";
  for (const c of cookie.split(";")) {
    const kv = c.trim();
    if (kv.startsWith("vc_token=") && kv.slice("vc_token=".length) === t) return true;
  }
  return url.searchParams.get("token") === t;
}

export function tailnetLoginOk(req: IncomingMessage): boolean {
  const login = header(req, "tailscale-user-login");
  if (!login) return false;
  return loadConfig().allowedLogins.includes(login.trim().toLowerCase());
}

export type AuthResult = { ok: boolean; via: "loopback" | "tailscale" | "token" | null };

export function authorize(req: IncomingMessage, url: URL): AuthResult {
  if (isDirectLoopback(req)) return { ok: true, via: "loopback" };
  if (tailnetLoginOk(req)) return { ok: true, via: "tailscale" };
  if (tokenOk(req, url)) return { ok: true, via: "token" };
  return { ok: false, via: null };
}
