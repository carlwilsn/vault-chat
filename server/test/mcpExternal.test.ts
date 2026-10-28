import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createExternalMcpHandler } from "../mcp/external";
vi.mock("../auth", async (original) => ({
  ...await original<typeof import("../auth")>(),
  tailnetLoginOk: (req: any) => req.headers["tailscale-user-login"] === "carl@example.test",
  tokenOk: (req: any) => req.headers["x-vault-token"] === "test-only-credential",
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const bindings: unknown[] = [];
  const hosts = new Set<string>();
  const handler = createExternalMcpHandler({ version: "test", allowedHosts: hosts, bind: async (vault, context) => {
    bindings.push({ vault, ...context });
    if (vault !== "notes") return null;
    return { specs: [{ name: "Echo", description: "echo", inputSchema: { type: "object", properties: {} } }], call: async () => ({ ok: true, text: JSON.stringify(context) }) };
  } });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as {port: number}).port;
  // Host allowlist is captured at creation; expose the actual listener through
  // the configured private Host as a reverse proxy would.
  cleanups.push(async () => { await handler.close(); await new Promise<void>((r) => server.close(() => r())); });
  return { url: `http://127.0.0.1:${port}/mcp`, bindings };
}
const privateHeaders = { Host: "thinkbox.private.test", "tailscale-user-login": "carl@example.test", "x-forwarded-proto": "https", "x-vault-token": "test-only-credential" };
// Separate fixture with known Host independent of the ephemeral TCP port.
async function configured() {
  const bindings: unknown[] = [];
  let handler: ReturnType<typeof createExternalMcpHandler>;
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  handler = createExternalMcpHandler({ version: "test", allowedHosts: new Set([`127.0.0.1:${(server.address() as {port: number}).port}`, privateHeaders.Host]), bind: async (vault, context) => {
    bindings.push({ vault, ...context });
    return vault !== "notes" ? null : { specs: [{ name: "Echo", description: "echo", inputSchema: { type: "object", properties: {} } }], call: async () => ({ ok: true, text: JSON.stringify(context) }) };
  } });
  cleanups.push(async () => { await handler.close(); await new Promise<void>((r) => server.close(() => r())); });
  return { url: `http://127.0.0.1:${(server.address() as {port: number}).port}/mcp`, bindings };
}
describe("private external MCP authority", () => {
  it("denies a disabled endpoint, broad loopback, spoofed identity, cookies and missing explicit scope", async () => {
    const disabled = await fixture();
    expect((await fetch(disabled.url, { headers: privateHeaders })).status).toBe(403);
    const f = await configured();
    for (const headers of [
      { Host: privateHeaders.Host },
      { Host: privateHeaders.Host, "tailscale-user-login": "carl@example.test", "x-forwarded-proto": "https" },
      { Host: privateHeaders.Host, "tailscale-user-login": "carl@example.test", "x-forwarded-proto": "https", Cookie: "vc_token=test-only-credential" },
      privateHeaders,
    ]) expect((await fetch(f.url, { headers })).status).toBe(401);
    expect(f.bindings).toEqual([]);
  });
  it("a standard SDK client has an explicit device and no-conversation scope; sessions cannot switch device", async () => {
    const f = await configured();
    const scoped = `${f.url}?vault=notes&device=laptop&conversation=none`;
    const transport = new StreamableHTTPClientTransport(new URL(scoped), { requestInit: { headers: privateHeaders } });
    const client = new Client({ name: "external-test", version: "test" });
    cleanups.push(() => client.close()); await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["Echo"]);
    expect(await client.callTool({ name: "Echo", arguments: {} })).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ conversation: null, device: "laptop" }) }] });
    expect(f.bindings).toContainEqual({ vault: "notes", conversation: null, device: "laptop" });
    expect((await fetch(`${f.url}?vault=notes&device=board&conversation=none`, { headers: { ...privateHeaders, "mcp-session-id": transport.sessionId!, Accept: "text/event-stream" } })).status).toBe(404);
    expect((await fetch(`${f.url}?vault=missing&device=laptop&conversation=none`, { headers: privateHeaders })).status).toBe(401);
    expect((await fetch(scoped, { headers: { ...privateHeaders, Origin: "https://evil.example" } })).status).toBe(403);
  });
});
