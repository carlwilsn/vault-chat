// Host-owned, revocable process capabilities. Only the pi extension receives
// the bootstrap over a private fd; no credential in argv/env/files or shell env.
// Loopback is a network address, NOT authority. External auth is a separate
// explicit binding policy using the same standard HTTP adapter/catalog.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createMcpHttpHandler, type HttpBinding } from "./http";

export type ProcessServices = {
  you?: (since: number | null) => Promise<{ text: string; until: number }>;
  env?: () => Record<string, string>;
  fileWrite?: () => Promise<boolean>;
};
type Scope = { binding: HttpBinding; services: ProcessServices };
export type ProcessBootstrap = { url: string; authorization: string };

export class McpRuntime {
  private scopes = new Map<string, Scope>();
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private handler: ReturnType<typeof createMcpHttpHandler> | null = null;
  private origin = "";

  private start(): Promise<void> {
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void (async () => {
        if (req.url === "/mcp") return this.handler!(req, res);
        res.setHeader("Cache-Control", "no-store");
        if (req.headers.host !== this.origin.slice(7) || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
        const scope = this.scopes.get(String(req.headers.authorization ?? ""));
        if (!scope) { res.writeHead(401).end(); return; }
        // Not MCP resources/tools: these are enforced extension services only.
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const part of req) {
          const chunk = Buffer.from(part);
          bytes += chunk.length;
          if (bytes > 4096) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        let body: any;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
        let result: unknown;
        if (req.url === "/context/you" && scope.services.you) {
          const n = body?.since;
          result = await scope.services.you(typeof n === "number" && Number.isFinite(n) ? n : null);
        } else if (req.url === "/context/env" && scope.services.env) result = { env: scope.services.env() };
        else if (req.url === "/context/file-write" && scope.services.fileWrite) result = { allowed: await scope.services.fileWrite() };
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      })().catch(() => { if (!res.headersSent) res.writeHead(503).end(); else res.end(); }); });
      this.server = server;
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        this.origin = `http://${host}`;
        this.handler = createMcpHttpHandler({ version: "1", allowedHosts: new Set([host]), bind: async (req) => this.scopes.get(String(req.headers.authorization ?? ""))?.binding ?? null });
        resolve();
      });
    });
  }

  async bind(binding: Omit<HttpBinding, "scopeId">, services: ProcessServices): Promise<{ bootstrap: ProcessBootstrap; revoke: () => Promise<void> }> {
    await this.start();
    const authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
    const scopeId = randomUUID();
    this.scopes.set(authorization, { binding: { ...binding, scopeId }, services });
    return {
      bootstrap: { url: `${this.origin}/mcp`, authorization },
      revoke: async () => { this.scopes.delete(authorization); await this.handler?.revoke(scopeId); },
    };
  }

  async close(): Promise<void> {
    this.scopes.clear();
    await this.handler?.close();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
