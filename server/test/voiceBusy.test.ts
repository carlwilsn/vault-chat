// Actual compiled server + installed Pi 1.1 + local unpaid provider, New's
// real completion protocol. No fake engine, audio, STT/TTS, or live vault.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, makeVault, startServer, waitFor, type Running } from "./helpers";
import { fakeChat, lastUser, lastToolResult, type ChatStep } from "./fakeChat";

const pi = process.env.VC_TEST_PI_DIR;
describe.skipIf(!pi)("busy New voice, actual Pi", () => {
  it.each(["foreground", "subagent"])("%s: Send now preserves background work and answers each current turn once", async (mode) => {
    const root = tmp("vc-voice-busy-");
    const vault = makeVault(join(root, "vault"));
    const state = join(root, "state");
    const provider = await fakeChat();
    const firstUser = (b: any) => {
      const m = b.messages.find((m: any) => m.role === "user");
      return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("\n");
    };
    provider.respond = (b): ChatStep => {
      if (firstUser(b)?.startsWith("Task:")) {
        return lastToolResult(b) === null
          ? { call: { name: "bash", args: { command: "echo started > child-started; sleep 6; echo preserved > child-result" } }, noCost: true }
          : { text: "Owned child finished safely.", noCost: true };
      }
      const user = lastUser(b);
      if (user.includes("OWNED-VOICE-ONE")) return { text: "Current answer one.", noCost: true };
      if (user.includes("OWNED-VOICE-TWO")) return { text: "Current answer two.", noCost: true };
      if (user.startsWith("Delegated work ")) return { text: "Owned work report received.", noCost: true };
      if (user.includes("OWNED-BUSY")) {
        const results = b.messages.filter((m: any) => m.role === "tool").length;
        if (!results) return mode === "subagent"
          ? { call: { name: "subagent", args: { agent: "worker", task: "OWNED-CHILD complete the local shell work" } }, noCost: true }
          : { call: { name: "Delegate", args: { title: "Owned slow work", task: "OWNED-CHILD complete the local shell work" } }, noCost: true };
        if (mode === "foreground" && results === 1) return { call: { name: "bash", args: { command: "echo started > foreground-started; sleep 6; echo done > foreground-result" } }, noCost: true };
        return { text: "Old foreground returned.", delayMs: mode === "subagent" ? 6000 : 0, noCost: true };
      }
      return { status: 503, body: "Unowned inference refused" };
    };
    // Only local requests are possible, including catalog bootstrapping.
    const guard = join(root, "local-only.mjs");
    writeFileSync(guard, `const f=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return f(${JSON.stringify(provider.url + "/models")},o);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Paid/external request refused');return f(i,o);};`);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home: root, vault, secrets: join(root, "empty-secrets"), openrouter: provider.url,
        bundle: process.env.VC_VOICE_BUSY_BUNDLE,
        extra: { VC_PI_DIR: pi!, VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: state,
          NODE_OPTIONS: `--import ${guard}`, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
      const post = async (p: string, b: unknown) => {
        const r = await fetch(srv!.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        expect(r.ok).toBe(true); return r.json();
      };
      const health: any = await (await fetch(srv.base + "/api/v1/health")).json();
      expect(health.engine.version).toBe("1.1.0");
      const agent = join(state, "pi", "agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      const models = ["test/fake-model", "anthropic/claude-haiku-5.5"].map(id => ({ id, name: "Local unpaid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 }));
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url, apiKey: "synthetic-local-only", api: "openai-completions", models } } }));
      const owner = "sep-owned-voice-busy";
      await post("/message", { convId: owner, text: "OWNED-BUSY finish the work", client: "laptop" });
      await waitFor(() => existsSync(join(vault, "child-started")) && (mode === "subagent" || existsSync(join(vault, "foreground-started"))), 30000, 20);
      const conv = async () => {
        const { picture } = await (await fetch(srv!.base + `/api/v2/conversations/${owner}/checkpoint`)).json() as any;
        return { meta: picture.meta, messages: picture.items.map((m: any) => ({ role: m.kind, content: m.text ?? "" })) };
      };
      const before = await conv();
      const call = await post("/api/v1/brain/call", { convId: owner, device: "phone" });
      const messages: any[] = [];
      const turn = async (text: string) => {
        messages.push({ role: "user", content: text });
        const start = performance.now();
        const r = await fetch(srv!.base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${call.token}` }, body: JSON.stringify({ stream: true, messages }) });
        const reader = r.body!.getReader();
        let raw = "", pending = "", textOut = "", firstMs: number | null = null;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          const chunk = new TextDecoder().decode(value); raw += chunk; pending += chunk;
          const lines = pending.split("\n"); pending = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            const piece = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
            if (piece) { firstMs ??= performance.now() - start; textOut += piece; }
          }
        }
        return { firstMs, text: textOut, doneCount: raw.split("data: [DONE]").length - 1 };
      };
      const one = await turn("OWNED-VOICE-ONE independent question?");
      const childDoneAtFirst = existsSync(join(vault, "child-result"));
      const two = await turn("OWNED-VOICE-TWO another independent question?");
      await waitFor(() => existsSync(join(vault, "child-result")), 15000, 20);
      await waitFor(async () => JSON.stringify((await conv()).messages).includes("Delegated work finished"), 15000, 20);
      const after = await conv();
      const live = await (await fetch(srv.base + "/api/v1/brain/calls")).json() as any;
      expect(live.calls).toHaveLength(1);
      expect(live.calls[0].convId).toBe(owner);
      await post(`/api/v1/brain/call/${call.callId}/end`, {});
      const result = { mode, root, one, two, childDoneAtFirst, preservedWork: readFileSync(join(vault, "child-result"), "utf8").trim(),
        sameSession: before.meta.threadPath === after.meta.threadPath,
        models: provider.calls.filter(b => lastUser(b).includes("OWNED-VOICE")).map(b => b.model),
        currentUserCounts: ["OWNED-VOICE-ONE", "OWNED-VOICE-TWO"].map(s => after.messages.filter((m: any) => m.role === "user" && m.content.includes(s)).length) };
      console.log("VOICE_BUSY_MEASURE " + JSON.stringify(result));
      expect(result.preservedWork).toBe("preserved");
      expect(before.meta.threadPath).toBeTruthy();
      expect(result.sameSession).toBe(true);
      expect(result.currentUserCounts).toEqual([1, 1]);
      expect(one.text).toBe("Current answer one.");
      expect(two.text).toBe("Current answer two.");
      expect([one.doneCount, two.doneCount]).toEqual([1, 1]);
      expect(childDoneAtFirst).toBe(false);
      expect(one.firstMs).not.toBeNull(); expect(one.firstMs!).toBeLessThan(1500);
      expect(two.firstMs).not.toBeNull(); expect(two.firstMs!).toBeLessThan(1500);
      expect(result.models.every((m: string) => m === "anthropic/claude-haiku-5.5")).toBe(true);
    } finally {
      writeFileSync(join(root, "server.log"), srv?.logs() ?? "no server");
      writeFileSync(join(root, "provider.json"), JSON.stringify(provider.calls));
      await srv?.stop(); await provider.close(); // Synthetic evidence retained on failure too.
    }
  });
});
