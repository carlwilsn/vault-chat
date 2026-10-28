// Real pinned pi factories, existing bubblewrap boundary, independent SDK client.
// No fake filesystem implementation, model spend, credentials or speakers.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { filesystemBinding, FILE_TOOLS } from "../mcp/filesystem";
import { McpRuntime } from "../mcp/runtime";
import { findBwrap } from "../engine/pi/install";
import { pdfPagesAnswer, pdfPagesSpec } from "../engine/extraTools";
import { makePdf, textPage } from "./pdfgen";

const root = mkdtempSync(join(tmpdir(), "vc-shared-files-"));
const vault = join(root, "vault"); mkdirSync(vault);
const secret = join(root, "protected"); mkdirSync(secret);
const readonly = join(vault, "readonly"); mkdirSync(readonly);
writeFileSync(join(secret, "canary.txt"), "HOST-CANARY-NEVER-TRANSPORT");
writeFileSync(join(readonly, "note.txt"), "immutable");
symlinkSync(secret, join(vault, "secret-link"));
symlinkSync(root, join(vault, "outside-link"));
const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
const cli = join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const bwrap = findBwrap();
if (!bwrap) throw new Error("Shared filesystem proof requires installed bubblewrap");
const sandbox = [bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--tmpfs", secret, "--ro-bind", readonly, readonly, "--"];
const runtime = new McpRuntime();
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await runtime.close(); rmSync(root, { recursive: true, force: true }); });
async function connect(allowed = FILE_TOOLS, canWrite = true, external = true, unsafe = false) {
  const fs = await filesystemBinding({ cli, node: process.execPath, script: resolve("server/engine/pi/ext/filesystem.mjs"), cwd: vault, home: root,
    outer: unsafe ? null : sandbox, shell: unsafe ? null : sandbox, denyRead: [secret, "/proc"], denyWrite: [readonly], allowed, root: external ? vault : undefined,
    env: () => ({ VC_TEST_COMMAND_KEY: "authorized-command-canary" }), fileWrite: async () => canWrite,
  });
  const scope = await runtime.bind({ ...fs,
    specs: [...fs.specs, pdfPagesSpec],
    call: (name, args, context) => name === "PdfPages" ? pdfPagesAnswer(vault, args) : fs.call(name, args, context),
    resources: [{ uri: "vault-chat://context/you", name: "Bound context", mimeType: "text/plain" }],
    readResource: async () => "Bound device: laptop; conversation: none. Focus: note.txt",
  }, {});
  const client = new Client({ name: "independent-filesystem-sdk", version: "test" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(scope.bootstrap.url), { requestInit: { headers: { Authorization: scope.bootstrap.authorization } } }));
  return client;
}
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

describe("one pi filesystem definition through standard MCP", () => {
  it("reads, writes, edits and discovers vault files; lists the actual mature schemas", async () => {
    const c = await connect();
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([...FILE_TOOLS.filter((n) => n !== "bash"), "PdfPages"]);
    const pi = await import(join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js"));
    expect(tools.find((t) => t.name === "edit")!.inputSchema).toEqual(pi.createAllToolDefinitions(vault).edit.parameters);
    expect((await c.callTool({ name: "write", arguments: { path: "note.txt", content: "Shared original" } })).isError).not.toBe(true);
    expect(text(await c.callTool({ name: "read", arguments: { path: "note.txt" } }))).toBe("Shared original");
    expect((await c.callTool({ name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "original", newText: "edited" }] } })).isError).not.toBe(true);
    expect(readFileSync(join(vault, "note.txt"), "utf8")).toBe("Shared edited");
    expect(text(await c.callTool({ name: "grep", arguments: { pattern: "Shared", path: "." } }))).toContain("Shared edited");
    expect(text(await c.callTool({ name: "find", arguments: { pattern: "*.txt", path: "." } }))).toContain("note.txt");
    expect(text(await c.callTool({ name: "ls", arguments: {} }))).toContain("note.txt");
  });

  it("never treats unsafe native test mode as external write authority", async () => {
    await expect(filesystemBinding({ cli, node: process.execPath, script: resolve("server/engine/pi/ext/filesystem.mjs"), cwd: vault, home: root,
      outer: null, shell: null, denyRead: [secret], denyWrite: [], allowed: FILE_TOOLS, root: vault,
      env: () => ({}), fileWrite: async () => true,
    })).rejects.toThrow(/requires the installed sandbox/);
  });

  it("rejects lexical/absolute/symlink escapes, protected reads, and protected writes", async () => {
    const c = await connect();
    for (const path of ["../protected/canary.txt", join(secret, "canary.txt"), "secret-link/canary.txt", "outside-link/protected/canary.txt", "/proc/self/environ"]) {
      const r = await c.callTool({ name: "read", arguments: { path } });
      expect(r.isError, path).toBe(true); expect(text(r)).not.toContain("HOST-CANARY-NEVER-TRANSPORT");
    }
    for (const path of ["../escape.txt", "outside-link/escape.txt", "secret-link/new.txt", "readonly/note.txt"]) {
      expect((await c.callTool({ name: "write", arguments: { path, content: "blocked" } })).isError, path).toBe(true);
    }
    const grep = await c.callTool({ name: "grep", arguments: { path: ".", pattern: "HOST-CANARY" } });
    expect(text(grep)).not.toContain("HOST-CANARY-NEVER-TRANSPORT");
    expect((await c.callTool({ name: "edit", arguments: { path: "readonly/note.txt", edits: [{ oldText: "immutable", newText: "blocked" }] } })).isError).toBe(true);
    const native = await connect(FILE_TOOLS, true, false);
    const protectedRead = await native.callTool({ name: "read", arguments: { path: join(secret, "canary.txt") } });
    expect(protectedRead.isError).toBe(true); expect(text(protectedRead)).not.toContain("HOST-CANARY-NEVER-TRANSPORT");
    expect(readFileSync(join(readonly, "note.txt"), "utf8")).toBe("immutable");
    await expect(c.callTool({ name: "bash", arguments: { command: "echo forbidden" } })).rejects.toThrow(/not available/);
  });

  it("read-only loadouts cannot write or bash; a voice talker must delegate even shell writes", async () => {
    const ro = await connect(["read", "grep", "find", "ls"], false, false);
    for (const name of ["write", "edit", "bash"]) await expect(ro.callTool({ name, arguments: {} })).rejects.toThrow(/not available/);
    const voice = await connect(FILE_TOOLS, false, false);
    for (const [name, args] of [["write", { path: "voice.txt", content: "no" }], ["edit", { path: "note.txt", edits: [{ oldText: "Shared", newText: "no" }] }], ["bash", { command: "touch voice.txt" }]] as const) {
      const r = await voice.callTool({ name, arguments: args }); expect(r.isError).toBe(true); expect(text(r)).toContain("Delegate");
    }
    const worker = await connect(FILE_TOOLS, true, false);
    const r = await worker.callTool({ name: "bash", arguments: { command: "printf '%s' \"$VC_TEST_COMMAND_KEY\"; printf worker > worker.txt", timeout: 5 } });
    expect(r.isError).not.toBe(true); expect(text(r)).toContain("authorized-command-canary");
    expect(readFileSync(join(vault, "worker.txt"), "utf8")).toBe("worker");
  });

  it.each([false, true])("SDK cancellation stops the actual command tree (unsafe native mode: %s)", async (unsafe) => {
    const c = await connect(FILE_TOOLS, true, false, unsafe);
    const marker = `began-${unsafe}.txt`, late = `late-${unsafe}.txt`;
    const controller = new AbortController();
    const pending = c.callTool({ name: "bash", arguments: { command: `printf began > ${marker}; sleep 2; printf escaped > ${late}` } }, undefined, { signal: controller.signal });
    const caught = expect(pending).rejects.toBeDefined();
    for (let i = 0; i < 100 && !existsSync(join(vault, marker)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(vault, marker))).toBe(true);
    controller.abort(); await caught;
    await new Promise((r) => setTimeout(r, 2300));
    expect(existsSync(join(vault, late))).toBe(false);
  });

  it("transports real PNG/JPEG/GIF/WebP/BMP images via the standard SDK", async () => {
    const require = createRequire(import.meta.url);
    const { createCanvas } = require("@napi-rs/canvas");
    const canvas = createCanvas(2, 2); canvas.getContext("2d").fillRect(0, 0, 2, 2);
    for (const [extension, mime] of [["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"]]) writeFileSync(join(vault, `image.${extension}`), canvas.toBuffer(mime));
    writeFileSync(join(vault, "image.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    const bmp = Buffer.alloc(58); bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(4, 34); writeFileSync(join(vault, "image.bmp"), bmp);
    const c = await connect();
    for (const extension of ["png", "jpg", "gif", "webp", "bmp"]) {
      const r = await c.callTool({ name: "read", arguments: { path: `image.${extension}` } });
      expect(r.isError, text(r)).not.toBe(true);
      const image: any = r.content.find((p: any) => p.type === "image");
      expect(image, `${extension}: ${text(r)}`).toBeDefined();
      expect(image.mimeType).toMatch(/^image\/(png|jpeg|gif|webp)$/);
      expect(Buffer.from(image.data, "base64").length).toBeGreaterThan(20);
    }
  });

  it("sends exactly the requested PDF slice as standard embedded bytes and exposes only bound context resources", async () => {
    writeFileSync(join(vault, "source.pdf"), makePdf([textPage("Unrequested", []), textPage("Requested slice", [])]));
    const c = await connect();
    const r = await c.callTool({ name: "PdfPages", arguments: { path: "source.pdf", pages: "2" } });
    const resource: any = r.content.find((p: any) => p.type === "resource");
    expect(resource.resource).toMatchObject({ mimeType: "application/pdf", uri: expect.stringMatching(/^vault-chat:\/\/pdf-pages\//) });
    const pdfjs = await import("pdfjs-dist");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(resource.resource.blob, "base64")), verbosity: 0 }).promise;
    try { expect(doc.numPages).toBe(1); const page = JSON.stringify(await (await doc.getPage(1)).getTextContent()); expect(page).toContain("Requested slice"); expect(page).not.toContain("Unrequested"); } finally { await doc.destroy(); }
    expect(text(r)).toContain("[PDF pages attached:"); // native provider contract retained
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual(["vault-chat://context/you"]);
    expect(JSON.stringify(await c.readResource({ uri: "vault-chat://context/you" }))).toContain("Bound device: laptop");
    await expect(c.readResource({ uri: "file:///proc/self/environ" })).rejects.toThrow(/unavailable/);
  });
});
