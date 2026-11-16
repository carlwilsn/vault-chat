// External MCP reuses existing private-path identity AND the existing laptop/
// phone credential. Tailscale Serve identity headers alone are insufficient:
// untrusted shell processes can reach loopback and forge proxy headers.
import type { IncomingMessage } from "node:http";
import { isDirectLoopback, tailnetLoginOk, tokenOk } from "../auth";
import type { BoundTools } from "./tools";
import { createMcpHttpHandler } from "./http";

export type ExternalContext = { conversation: string | null; device: "laptop" | "phone" | "board" };
export type ExternalMcpOptions = {
  version: string;
  /** Explicit private service Host values, never a caller-derived allowlist. */
  allowedHosts: ReadonlySet<string>;
  bind: (vault: string, context: ExternalContext) => Promise<BoundTools | null>;
};
function bearer(value: string | string[] | undefined): string | undefined {
  const m = typeof value === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(value) : null;
  return m ? m[1] : undefined;
}
export function createExternalMcpHandler(options: ExternalMcpOptions) {
  return createMcpHttpHandler({
    version: options.version, allowedHosts: options.allowedHosts,
    bind: async (req) => {
      if (isDirectLoopback(req) || !tailnetLoginOk(req) || req.headers["x-forwarded-proto"] !== "https") return null;
      // Header credential only: no URL tokens, browser cookies or ambient login.
      // No credential value is copied to tool arguments, metadata, files or logs.
      // The same credential is taken as X-Vault-Token or as a standard
      // `Authorization: Bearer`, so a client that can only send a bearer token
      // (most MCP clients, not only Claude Code) can connect too.
      const credentialRequest = { headers: { "x-vault-token": req.headers["x-vault-token"] ?? bearer(req.headers.authorization) } } as unknown as IncomingMessage;
      if (!tokenOk(credentialRequest, new URL("http://localhost/"))) return null;
      const url = new URL(req.url ?? "/", "http://localhost/");
      const vault = url.searchParams.get("vault");
      const conversation = url.searchParams.get("conversation");
      const device = url.searchParams.get("device");
      if (!vault || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(vault) || !conversation || !["laptop", "phone", "board"].includes(device ?? "")) return null;
      if (conversation !== "none" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(conversation)) return null;
      const binding = await options.bind(vault, { conversation: conversation === "none" ? null : conversation, device: device as ExternalContext["device"] });
      return binding ? {
        ...binding,
        scopeId: JSON.stringify([String(req.headers["tailscale-user-login"]).trim().toLowerCase(), vault, device, conversation]),
      } : null;
    },
  });
}
