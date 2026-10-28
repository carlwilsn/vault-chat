// The built server's NORMAL /mcp mount and real existing-token loader, not the
// internal per-process capability or a mocked auth adapter. Daemon discovery
// and the model backend are fixtures; no model runs. This is not live HTTPS.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, fakeOpenRouter, makeVault, startServer, tmp, type FakeOpenRouter, type Running } from "./helpers";
import { findBwrap } from "../engine/pi/install";

const HOST = "thinkbox.tailbb647d.ts.net";
const TOKEN = "isolated-mcp-deployment-test-only";
const headers = { Host: HOST, "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "carwilson0929@gmail.com", "X-Vault-Token": TOKEN };

describe("built server MCP on its default private route", () => {
  let home: string;
  let srv: Running;
  let proxy: Server;
  let router: FakeOpenRouter;
  let url: string;
  beforeAll(async () => {
    vi.stubEnv("VC_MCP_HOSTS", undefined);
    home = tmp();
    const vault = makeVault(join(home, "notes"));
    const cli = join(home, "tailscale-status.cjs");
    writeFileSync(cli, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'status --json') process.exit(1);\nconsole.log(JSON.stringify({Self:{DNSName:'${HOST}.'}}));\n`, { mode: 0o700 });
    const bwrap = findBwrap();
    if (!bwrap) throw new Error("Default private-route proof requires installed bubblewrap");
    router = await fakeOpenRouter();
    srv = await startServer({ home, vault, secrets: join(home, "no-key-store"), token: TOKEN, openrouter: router.url,
      extra: { VC_TAILSCALE: cli, VC_VAULT_NAME: "notes", VC_PI_UNSAFE: "0", VC_BWRAP: bwrap } });
    // A real loopback reverse-proxy hop preserves the private Host as Serve
    // does. fetch/undici may discard a caller-supplied Host header, so do not
    // silently allow the ephemeral loopback Host just to make this test pass.
    proxy = createServer((req, res) => {
      const forwarded = { ...req.headers, host: String(req.headers["x-test-proxy-host"] ?? HOST) };
      delete forwarded["x-test-proxy-host"];
      const upstream = request(srv.base + req.url, { method: req.method, headers: forwarded }, (answer) => {
        res.writeHead(answer.statusCode!, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/mcp?vault=notes&device=laptop&conversation=none`;
  });
  afterAll(async () => {
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await srv?.stop();
    await router?.close();
    if (home) cleanup(home);
    vi.unstubAllEnvs();
  });

  it("discovers its Host by default and accepts the existing credential through the ordinary mount", async () => {
    const probe = await fetch(url, { headers });
    expect(probe.status, srv.logs()).toBe(400); // authenticated, but not initialized
    const client = new Client({ name: "isolated-private-route", version: "test" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("BoardLook");
      expect(tools).toContain("read");
      expect(tools).not.toContain("bash");
      const result = await client.callTool({ name: "BoardLook", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toMatch(/board/i);
    } finally { await client.close(); }
    expect(srv.logs()).not.toContain(TOKEN);
  });

  it("does not admit loopback, wrong Hosts, missing/wrong credentials or missing private identity", async () => {
    expect((await fetch(`${srv.base}/mcp`)).status).toBe(403);
    for (const h of [
      { ...headers, "x-test-proxy-host": "evil.example" },
      { ...headers, "X-Vault-Token": "wrong" },
      { ...headers, "X-Vault-Token": "" },
      { ...headers, "tailscale-user-login": "" },
      { ...headers, "tailscale-user-login": "someone-else@example.test" },
      { ...headers, "x-forwarded-proto": "http" },
      { ...headers, "X-Vault-Token": "", Cookie: `vc_token=${TOKEN}` },
    ]) expect([401, 403]).toContain((await fetch(url, { headers: h })).status);
    expect((await fetch(url.split("?")[0]!, { headers })).status).toBe(401);
    expect((await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${url}&token=${TOKEN}`, { headers: { ...headers, "X-Vault-Token": "" } })).status).toBe(401);
  });
});
