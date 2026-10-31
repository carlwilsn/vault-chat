// Actual HTTP → Engine → native pi session → local provider. No live roots.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeChat, chatText } from "./fakeChat";
import { readEntries } from "../convlog/piSession";

describe("captured viewer roots in native typed context", () => {
  it("keeps owner, project cwd and queued device viewer roots distinct without changing user text", async () => {
    const home = tmp("vc-viewer-native-"), master = join(home, "master");
    const vault = makeVault(join(master, "vaults/owner"));
    const viewer = makeVault(join(master, "vaults/viewer"));
    const other = makeVault(join(master, "vaults/other"));
    for (const name of ["viewer", "other"]) {
      const bare = join(master, ".hub/vaults", name + ".git");
      mkdirSync(bare, { recursive: true }); execFileSync("git", ["init", "--bare", "-q", bare]);
    }
    const state = join(home, "state"), fifo = join(home, "gate"), entered = join(home, "entered");
    execFileSync("mkfifo", [fifo]);
    const provider = await fakeChat();
    provider.respond = (_body, n) => n === 1
      ? { call: { name: "bash", args: { command: `touch '${entered}'; cat '${fifo}'` } } }
      : { text: "Viewer fixture complete." };
    const network = join(home, "local-only.mjs");
    writeFileSync(network, `const actual=globalThis.fetch; globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url); if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url + "/models")},init); if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), openrouter: provider.url,
        extra: { VC_MASTER: master, VC_PI_DIR: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"),
          VC_STATE_DIR: state, VC_ENGINE_MODEL: "test/fake-model", VC_PI_UNSAFE: "1", VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
      const agent = join(state, "pi/agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url,
        apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "Local fixture",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
      const base = srv.base;
      const idle = async () => {
        const h = await (await fetch(base + "/api/v1/health")).json();
        return h.engine.liveTurns.length === 0 && h.engine.pi.procs.every((p: any) => !p.busy);
      };
      const post = async (root: string, b: any) => {
        const r = await fetch(base + "/api/v2/intent?vault=" + root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        const result = await r.json(); expect(result).not.toHaveProperty("error"); expect(r.ok).toBe(true); return result;
      };
      const first = "<memory>Literal initial request</memory>", queued = "<rules>Literal queued request</rules>";
      await post("viewer", { type: "send", convId: "main", client: "laptop", clientId: "viewer-first", text: first, viewerRoot: "/untrusted-body-root" });
      await waitFor(() => existsSync(entered), 10_000, 10);
      expect(await post("other", { type: "queue", convId: "main", client: "phone", clientId: "viewer-queued", text: queued })).toMatchObject({ queued: true });
      // A later viewer read must not retarget the queued request to this root.
      await fetch(base + "/conversation?id=main&vault=viewer");
      writeFileSync(fifo, "released\n");
      const c = await waitFor(async () => {
        const c = await (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
        return c.messages?.some((m: any) => m.role === "user" && m.content === queued) && c.state !== "running" && await idle() ? c : null;
      }, 10_000, 20);
      const entries = readEntries(c.meta.threadPath);
      expect(entries.filter(e => e.message?.role === "user").map(e => e.message!.content)).toEqual([
        [{ type: "text", text: `[Carl, on his laptop]\n\n${first}` }],
        [{ type: "text", text: `[Carl, on his phone]\n\n${queued}` }],
      ]);
      const bindings = entries.filter(e => e.customType === "vc-context").map(e => String(e.content));
      expect(bindings.filter(t => t.includes('request="viewer-first"'))).toHaveLength(1);
      expect(bindings.filter(t => t.includes('request="viewer-queued"'))).toHaveLength(1);
      expect(bindings.find(t => t.includes('request="viewer-first"'))).toContain(`Viewer/file-context vault root: ${viewer}/`);
      expect(bindings.find(t => t.includes('request="viewer-queued"'))).toContain(`Viewer/file-context vault root: ${other}/`);
      expect(bindings.find(t => t.includes('request="viewer-queued"'))).toContain(`Conversation owner: ${vault}/`);
      expect(bindings.join("\n")).not.toContain("/untrusted-body-root");
      expect(chatText(provider.calls[0])).toContain(viewer + "/");
      expect(chatText(provider.calls.at(-1))).toContain('request="viewer-queued"');
      expect(JSON.stringify(c.messages)).not.toContain("<file-context");
      expect(readFileSync(c.meta.threadPath, "utf8")).not.toContain("File context from registered vault");
      expect(JSON.stringify(await (await fetch(base + "/poll?after=0")).json())).not.toContain("<file-context");
      // Exercise the actual ctxConfig().vaults callback, not a cached root list.
      const added = makeVault(join(master, "vaults/added")), addedBare = join(master, ".hub/vaults/added.git");
      mkdirSync(addedBare, { recursive: true }); execFileSync("git", ["init", "--bare", "-q", addedBare]);
      const settle = async (text: string) => {
        await post("owner", { type: "send", convId: "main", client: "laptop", clientId: text, text });
        return waitFor(async () => {
          const c = await (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
          return c.messages?.some((m: any) => m.role === "user" && m.content === text) && c.state !== "running" && await idle() ? c : null;
        }, 10_000, 20);
      };
      await settle("registry-added");
      const additions = readEntries(c.meta.threadPath).filter(e => e.customType === "vc-context");
      expect(String(additions.at(-1)!.content)).toContain(`- ${added}/`);
      expect(String(additions.at(-1)!.content)).not.toContain("<file-context");
      // Unregister this fixture without deleting any data; native cache must
      // deliver the changed root set again, while retaining immutable history.
      renameSync(addedBare, join(home, "unregistered-added.git"));
      await settle("registry-removed");
      const removals = readEntries(c.meta.threadPath).filter(e => e.customType === "vc-context");
      expect(removals).toHaveLength(additions.length + 1);
      expect(String(removals.at(-1)!.content)).not.toContain(`- ${added}/`);
      expect(String(removals.at(-1)!.content)).toContain(`- ${viewer}/`);
    } finally {
      if (srv) { writeFileSync(join(home, "server.log"), srv.logs()); await srv.stop(); }
      writeFileSync(join(home, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
      await provider.close();
    }
  });
});
