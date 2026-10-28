// Protocol/scope integration tests, NOT real-app review proof. The HTTP tests
// use an independent official MCP Client and the real BoardLook file handler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server as HttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolServer, type BoundTools } from "../mcp/tools";
import { createMcpHttpHandler } from "../mcp/http";
import type { ToolSpec } from "../engine/pi/backend";
import { createBoard, lookBoard } from "../boards";

const root = mkdtempSync(join(tmpdir(), "vc-mcp-"));
let specs: ToolSpec[];
let boardSpec: ToolSpec;
beforeAll(async () => {
  process.env.VC_VAULT = join(root, "vault");
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_LOCALSTORAGE = join(root, "ls.json");
  mkdirSync(process.env.VC_VAULT, { recursive: true });
  await import("../shims/globals");
  // Consume the existing authoritative definitions, never a test-only schema.
  const catalog = await import("../engine/engine");
  specs = catalog.agentToolSpecs();
  boardSpec = specs.find((tool) => tool.name === "BoardLook")!;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function connected(binding: BoundTools) {
  const server = createToolServer(binding, "test");
  const client = new Client({ name: "independent-test-client", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("vault-chat's single catalog over MCP", () => {
  it("lists every existing schema/description unchanged and compiles them all", async () => {
    const c = await connected({ specs, call: async () => { throw new Error("must not execute on discovery"); } });
    try {
      const listed = (await c.client.listTools()).tools;
      expect(listed.length).toBe(specs.length);
      expect(new Set(listed.map((t) => t.name)).size).toBe(specs.length);
      for (const original of specs) {
        const tool = listed.find((t) => t.name === original.name)!;
        expect(tool.inputSchema).toEqual(original.inputSchema);
        expect(tool.description).toBe(original.description);
        expect(tool.annotations?.readOnlyHint).toBe(original.readOnly === true ? true : undefined);
      }
      expect(listed.some((t) => t.name.startsWith("__"))).toBe(false);
    } finally { await c.close(); }
  });

  it("rejects unknown tools and invalid arguments before dispatch", async () => {
    let calls = 0;
    const c = await connected({ specs: [boardSpec], call: async () => { calls++; return { ok: true, text: "unexpected" }; } });
    try {
      await expect(c.client.callTool({ name: "Show", arguments: {} })).rejects.toThrow(/not available/);
      await expect(c.client.callTool({ name: "BoardLook", arguments: { board: 42 } })).rejects.toThrow(/string/);
      await expect(c.client.callTool({ name: "BoardLook", arguments: { vault: "/another-vault", threadId: "another-thread" } })).rejects.toThrow(/additional properties/);
      expect(calls).toBe(0);
    } finally { await c.close(); }
  });

  it("preserves images and tool failure semantics", async () => {
    const image = { data: "aW1hZ2U=", mimeType: "image/png" };
    const c = await connected({ specs: [boardSpec], call: async () => ({ ok: false, text: "board unavailable", images: [image] }) });
    try {
      expect(await c.client.callTool({ name: "BoardLook" })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "board unavailable" }, { type: "image", ...image }],
      });
    } finally { await c.close(); }
  });

  it("returns thrown host errors as failed tool results, not successful text", async () => {
    const c = await connected({ specs: [boardSpec], call: async () => { throw new Error("storage unavailable"); } });
    try {
      expect(await c.client.callTool({ name: "BoardLook" })).toMatchObject({ isError: true, content: [{ type: "text", text: "BoardLook failed: storage unavailable" }] });
    } finally { await c.close(); }
  });

  it("snapshots the allowed schemas rather than sharing mutable caller state", async () => {
    const copy = structuredClone(boardSpec);
    const c = await connected({ specs: [copy], call: async () => ({ ok: true, text: "ok" }) });
    try {
      copy.name = "Show";
      (copy.inputSchema.properties as Record<string, unknown>).board = { type: "number" };
      const tools = (await c.client.listTools()).tools;
      expect(tools[0]?.name).toBe("BoardLook");
      await expect(c.client.callTool({ name: "BoardLook", arguments: { board: 1 } })).rejects.toThrow(/string/);
    } finally { await c.close(); }
  });

  it("forwards SDK cancellation to the bound operation", async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    const c = await connected({ specs: [boardSpec], call: async (_name, _args, context) => {
      expect(context.requestId).toBeDefined();
      started();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
      return { ok: false, text: "cancelled" };
    } });
    try {
      const controller = new AbortController();
      const call = c.client.callTool({ name: "BoardLook" }, undefined, { signal: controller.signal });
      const result = expect(call).rejects.toBeDefined();
      await began;
      controller.abort();
      await result;
      await aborted;
    } finally { await c.close(); }
  });

  it("fails closed on duplicate names, internal names and malformed schemas", () => {
    const call: BoundTools["call"] = async () => ({ ok: true, text: "unused" });
    expect(() => createToolServer({ specs: [boardSpec, boardSpec], call }, "test")).toThrow(/duplicate/);
    expect(() => createToolServer({ specs: [{ ...boardSpec, name: "__env" }], call }, "test")).toThrow(/Invalid/);
    expect(() => createToolServer({ specs: [{ ...boardSpec, inputSchema: { type: "string" } }], call }, "test")).toThrow(/object/);
  });
});

describe("standard Streamable HTTP with request-local authority", () => {
  let http: HttpServer;
  let url: string;
  let binds = 0;
  const clients: Client[] = [];
  const vaultA = join(root, "a");
  const vaultB = join(root, "b");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64");
  beforeAll(async () => {
    mkdirSync(vaultA, { recursive: true });
    mkdirSync(vaultB, { recursive: true });
    const board = createBoard(vaultA, "Only vault A's board").body as { slug: string };
    writeFileSync(join(vaultA, "boards", board.slug, "overview.png"), png);
    // Select an ephemeral port before creating the handler's exact Host allowlist.
    let current: ReturnType<typeof createMcpHttpHandler>;
    http = createServer((req, res) => { void current(req, res); });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}`;
    current = createMcpHttpHandler({
      version: "test", allowedHosts: new Set([`127.0.0.1:${port}`]),
      bind: async (req) => {
        binds++;
        // Test-only authentication/scope resolver, NOT production policy.
        if (req.headers["x-test-authorized"] !== "yes") return null;
        const vault = req.url === "/a" ? vaultA : req.url === "/b" ? vaultB : null;
        if (!vault) return null;
        return { specs: [boardSpec], call: async (_name, args) => lookBoard(vault, args.board) };
      },
    });
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  async function connect(path: string) {
    const client = new Client({ name: "outside-standard-client", version: "test" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + path), { requestInit: { headers: { "x-test-authorized": "yes" } } }));
    return client;
  }

  it("calls the real BoardLook handler and returns the actual saved PNG", async () => {
    const client = await connect("/a");
    const tool = (await client.listTools()).tools[0];
    expect(tool?.name).toBe("BoardLook");
    const result = await client.callTool({ name: "BoardLook" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Only vault A's board") }),
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]));
  });

  it("keeps concurrent callers in their bound vault, not an ambient main vault", async () => {
    const [a, b] = await Promise.all([connect("/a"), connect("/b")]);
    const [resultA, resultB] = await Promise.all([a.callTool({ name: "BoardLook" }), b.callTool({ name: "BoardLook" })]);
    expect(JSON.stringify(resultA)).toContain("Only vault A's board");
    expect(JSON.stringify(resultB)).not.toContain("Only vault A's board");
    expect(resultB.content).toEqual([{ type: "text", text: "Carl has no whiteboard boards yet." }]);
  });

  it("denies unauthenticated requests even if they claim an MCP session id", async () => {
    const response = await fetch(url + "/a", { method: "POST", headers: { "mcp-session-id": "claimed-session", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not grant authentication to another vault path", async () => {
    expect((await fetch(url + "/unknown", { headers: { "x-test-authorized": "yes" } })).status).toBe(401);
  });

  it("rejects browser origins and DNS-rebound Hosts before binding authority", async () => {
    const before = binds;
    expect((await fetch(url + "/a", { headers: { origin: "https://untrusted.example", "x-test-authorized": "yes" } })).status).toBe(403);
    // Node fetch normalizes Host to its URL; use a raw HTTP request to test rebinding.
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/a", { headers: { host: "untrusted.example", "x-test-authorized": "yes" } }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    expect(reboundStatus).toBe(403);
    expect(binds).toBe(before);
  });
});
