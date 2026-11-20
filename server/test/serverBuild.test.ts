// The box offers its accepted server build and the laptop's slot takes it (server/serverBuild.ts): checked against its
// hash, never a version that failed there, through the built bundle's fill-server-slot with the box address on stdin.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fillServerSlot, serverBuild, serverBuildRoute } from "../serverBuild";
import { fillSlotOnce } from "../../src/serverSlotFollow";

function aBuild(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "vc-sbuild-"));
  const path = join(dir, "vault-chat-server.mjs");
  writeFileSync(path, body);
  return { dir, path, sha: createHash("sha256").update(body).digest("hex") };
}

/** fetch answered by serverBuildRoute on `path`, as the box's routes do. */
const boxFetch = (path: string, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(String(url));
    const sub = new URL(String(url)).pathname.slice("/api/v2/server-build".length);
    const out = serverBuildRoute(sub, path);
    return out.bytes ? new Response(out.bytes) : new Response(JSON.stringify(out.json), { status: out.status });
  }) as unknown as typeof fetch;

describe("the box's server build in the laptop's slot", () => {
  it("the box names its build by its hash and serves its bytes", () => {
    const b = aBuild("// build one\n");
    expect(serverBuild(b.path)).toMatchObject({ version: b.sha.slice(0, 8), sha256: b.sha, size: 13 });
    expect(serverBuildRoute("/file", b.path).bytes?.toString()).toBe("// build one\n");
    expect(serverBuildRoute("/x", b.path).status).toBe(404);
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("the slot takes a new build once, checks its hash, and never one marked bad", async () => {
    const state = mkdtempSync(join(tmpdir(), "vc-slot-"));
    const b = aBuild("// build two\n");
    const seen: string[] = [];
    expect(await fillServerSlot(state, { url: "http://box.test/" }, boxFetch(b.path, seen))).toEqual({ version: b.sha.slice(0, 8), changed: true });
    const slots = join(state, "server-slots");
    expect(JSON.parse(readFileSync(join(slots, "current.json"), "utf8"))).toMatchObject({ version: b.sha.slice(0, 8), sha256: b.sha });
    expect(readFileSync(join(slots, b.sha.slice(0, 8), "vault-chat-server.mjs"), "utf8")).toBe("// build two\n");
    expect(await fillServerSlot(state, { url: "http://box.test" }, boxFetch(b.path))).toEqual({ version: b.sha.slice(0, 8), changed: false });
    expect(seen).toEqual(["http://box.test/api/v2/server-build", "http://box.test/api/v2/server-build/file"]);

    // A file that changed on the way: not taken.
    const c = aBuild("// build three\n");
    const lying = (async (url: string) => (String(url).endsWith("/file") ? new Response("// tampered\n") : boxFetch(c.path)(url))) as unknown as typeof fetch;
    await expect(fillServerSlot(state, { url: "http://box.test" }, lying)).rejects.toThrow(/did not match its hash/);
    expect(JSON.parse(readFileSync(join(slots, "current.json"), "utf8")).version).toBe(b.sha.slice(0, 8));

    // Marked bad on this laptop (it did not start here): never taken again.
    writeFileSync(join(slots, "bad.json"), JSON.stringify([c.sha.slice(0, 8)]));
    await expect(fillServerSlot(state, { url: "http://box.test" }, boxFetch(c.path))).rejects.toThrow(/failed here before/);
    for (const d of [state, b.dir, c.dir]) rmSync(d, { recursive: true, force: true });
  });

  it("the built bundle's fill-server-slot takes the box address on stdin and answers in one line", async () => {
    const bundle = join(__dirname, "..", "..", "dist-server", "vault-chat-server.mjs");
    expect(existsSync(bundle)).toBe(true);
    const b = aBuild("// the box's build\n");
    const srv = createServer((req, res) => {
      const out = serverBuildRoute((req.url ?? "").slice("/api/v2/server-build".length), b.path);
      res.statusCode = out.status;
      res.end(out.bytes ?? JSON.stringify(out.json));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const state = mkdtempSync(join(tmpdir(), "vc-slot-"));
    const r = await new Promise<string>((resolve) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const p = spawn(process.execPath, [bundle, "fill-server-slot", state], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.on("exit", () => resolve(out));
      p.stdin.end(JSON.stringify({ url: `http://127.0.0.1:${port}`, token: null }));
    });
    srv.close();
    expect(JSON.parse(r.trim().split("\n").at(-1)!)).toEqual({ ok: { version: b.sha.slice(0, 8), changed: true } });
    expect(existsSync(join(state, "server-slots", b.sha.slice(0, 8), "vault-chat-server.mjs"))).toBe(true);
    // No address: an error line, nothing else started.
    const none = spawnSync(process.execPath, [bundle, "fill-server-slot", state], { input: "{}", encoding: "utf8", timeout: 30_000 });
    expect(JSON.parse(none.stdout.trim())).toMatchObject({ error: expect.stringContaining("no box address") });
    rmSync(state, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("the laptop fills the slot only through a shell that has server_tool, and only from a box", async () => {
    const link = { url: "https://box.test", token: "t" };
    const calls: [string, string][] = [];
    const tool = async (task: string, input: string) => (calls.push([task, input]), { version: "12345678", changed: true });
    expect(await fillSlotOnce({ commands: async () => ["core_status"], link: async () => link, tool })).toMatch(/no server_tool/);
    expect(await fillSlotOnce({ commands: async () => ["server_tool"], link: async () => null, tool })).toBe("no box");
    expect(await fillSlotOnce({ commands: async () => ["server_tool"], link: async () => link, tool })).toMatch(/took .* 12345678/);
    expect(calls).toEqual([["fill-server-slot", JSON.stringify({ url: "https://box.test", token: "t" })]]);
  });
});
