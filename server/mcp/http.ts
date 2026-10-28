// Mount only after choosing the endpoint's authentication and scope policy.
// This module opens no listener and grants no loopback or "main vault" fallback.
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createToolServer, type BoundTools } from "./tools";

export type McpHttpOptions = {
  version: string;
  /** Exact HTTP Host values (including a port when present), for DNS rebinding
   * protection. This is not authentication. */
  allowedHosts: ReadonlySet<string>;
  /** Authenticate EVERY request and bind its permitted tools/host context. A
   * null result is denied before the SDK reads any request body. Do not derive
   * authority from MCP metadata or unvalidated caller-supplied thread ids. */
  bind: (request: IncomingMessage) => Promise<BoundTools | null>;
  /** Machine clients do not send Origin. Browser origins require an explicit
   * allowlist as well as authentication; no wildcard CORS. */
  allowedOrigins?: ReadonlySet<string>;
};

/** Standard stateless Streamable HTTP, using the official SDK. A fresh protocol
 * instance per HTTP request prevents one client's binding leaking to another.
 * Client-supplied MCP session ids are never treated as authentication. */
export function createMcpHttpHandler(options: McpHttpOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const hosts = new Set([...options.allowedHosts].map((host) => host.toLowerCase()));
  const origins = new Set(options.allowedOrigins ?? []);
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!hosts.has((req.headers.host ?? "").toLowerCase()) || (req.headers.origin !== undefined && !origins.has(req.headers.origin))) {
      res.writeHead(403).end();
      return;
    }
    let binding: BoundTools | null;
    try {
      binding = await options.bind(req);
    } catch {
      res.writeHead(503).end();
      return;
    }
    if (!binding) {
      res.writeHead(401).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer(binding, options.version);
      // The response owns this request's SDK resources. close() is idempotent.
      res.once("close", () => { void server?.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
      await (server ? server.close() : transport.close());
    }
  };
}
