// Standard SDK stateful Streamable HTTP. Transport state is not agent state.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createToolServer, type BoundTools } from "./tools";

export type HttpBinding = BoundTools & {
  /** Stable host-issued authority identity. Includes vault/device/conversation and
   * loadout. Not supplied by the MCP client or derived from its session id. */
  scopeId: string;
};
export type McpHttpOptions = {
  version: string;
  allowedHosts: ReadonlySet<string>;
  /** Authenticate every request, including GET/DELETE/cancellation. */
  bind: (request: IncomingMessage) => Promise<HttpBinding | null>;
  allowedOrigins?: ReadonlySet<string>;
  maxBodyBytes?: number;
  maxSessions?: number;
  maxRequestsPerSession?: number;
  idleMs?: number;
};

type Session = { scopeId: string; server: ReturnType<typeof createToolServer>; transport: StreamableHTTPServerTransport; touched: number; active: number };

export function createMcpHttpHandler(options: McpHttpOptions) {
  const hosts = new Set([...options.allowedHosts].map((host) => host.toLowerCase()));
  const origins = new Set(options.allowedOrigins ?? []);
  const sessions = new Map<string, Session>();
  const maxBody = options.maxBodyBytes ?? 2 * 1024 * 1024;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const drop = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    // SDK close aborts every in-flight request's signal.
    await session.server.close();
  };
  const timer = setInterval(() => {
    for (const [id, s] of sessions) if (!s.active && Date.now() - s.touched > idleMs) void drop(id);
  }, Math.min(idleMs, 60_000));
  timer.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (!hosts.has((req.headers.host ?? "").toLowerCase()) || (req.headers.origin !== undefined && !origins.has(req.headers.origin))) {
      res.writeHead(403).end(); return;
    }
    let binding: HttpBinding | null;
    try { binding = await options.bind(req); } catch { res.writeHead(503).end(); return; }
    if (!binding?.scopeId) { res.writeHead(401).end(); return; }
    const header = req.headers["mcp-session-id"];
    if (header !== undefined && typeof header !== "string") { res.writeHead(400).end(); return; }
    let session = header ? sessions.get(header) : undefined;
    if (header && (!session || session.scopeId !== binding.scopeId)) { res.writeHead(404).end(); return; }
    if (session && session.active >= (options.maxRequestsPerSession ?? 32)) { res.writeHead(429).end(); return; }
    // Bound before parsing: anonymous clients cannot consume the body budget.
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const part of req) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          bytes += chunk.length;
          if (bytes > maxBody) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { if (!res.headersSent) res.writeHead(400).end(); return; }
    }
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(body)) { res.writeHead(400).end(); return; }
      if (sessions.size >= (options.maxSessions ?? 256)) { res.writeHead(503).end(); return; }
      const server = createToolServer(binding, options.version);
      let id: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (value) => { id = value; sessions.set(value, session!); },
        onsessionclosed: (value) => { void drop(value); },
      });
      session = { scopeId: binding.scopeId, server, transport, touched: Date.now(), active: 0 };
      server.onclose = () => { if (id) sessions.delete(id); };
      await server.connect(transport);
    }
    session.active++;
    session.touched = Date.now();
    try {
      await session.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    } finally {
      session.active--;
      session.touched = Date.now();
    }
  };
  return Object.assign(handle, {
    /** Revocation is host-owned, including process exit; session id is never authority. */
    revoke: async (scopeId: string) => { await Promise.all([...sessions].filter(([, s]) => s.scopeId === scopeId).map(([id]) => drop(id))); },
    close: async () => { clearInterval(timer); await Promise.all([...sessions.keys()].map(drop)); },
  });
}
