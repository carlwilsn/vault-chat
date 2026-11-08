// Bounded HTTP/native contract for the combined reset + startup source.
// Actual bundle/Engine/PiBackend/pi 1.1.0; only the provider is local fakeChat.
// Not browser, installed-service, compaction-timing, or delivery proof.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { chatText } from "./fakeChat";
import { readEntries } from "../convlog/piSession";

describe("cross-surface native API startup contract", () => {
  it("keeps context separate, literal tagged user text visible, one native session and the reset's thin SubmitChange schema", async () => {
    const home = tmp("vc-native-api-"), vault = makeVault(join(home, "vault"));
    const state = join(home, "state"), canary = "COMBINED_NATIVE_CONTEXT_CANARY";
    mkdirSync(join(vault, ".vault-chat"), { recursive: true });
    writeFileSync(join(vault, ".vault-chat/MEMORY.md"), `# Memory\n\n- ${canary}\n`);
    const provider = await fakeAnthropic();
    provider.respond = () => ({ text: "Local native contract response." });
    const network = join(home, "local-only.mjs"), outbound = join(home, "outbound.jsonl");
    writeFileSync(outbound, "");
    // Same boundary as the native App proof: public catalog fixture only;
    // all other non-loopback fetches fail closed in server AND native children.
    writeFileSync(network, `
import {appendFileSync} from 'node:fs';
const actual=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url + "/models")},init);
 if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);
 appendFileSync(${JSON.stringify(outbound)},JSON.stringify({origin:u.origin,path:u.pathname})+'\\n');
 throw Error('Native API fixture refuses external fetch');
};`);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), anthropic: provider.url,
        extra: { VC_STATE_DIR: state, VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
      expect(srv.proc.exitCode).toBeNull();
      expect(srv.port).toBeGreaterThan(0);
      expect([8848, 8857]).not.toContain(srv.port);
      const health = await (await fetch(srv.base + "/api/v1/health")).json();
      expect(health.engine.claude.state).toBe("up");
      expect(health.engine.version).toBe("1.1.0");
        apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "Local contract",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
      const base = srv.base;
      const conversation = async () => (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
      const genuine = ["<memory>Literal user words, not injected context.</memory>", "Phone follows the same conversation."];
      const surfaces = ["laptop", "phone"];
      let sid: string | undefined, path: string | undefined;
      for (const [i, text] of genuine.entries()) {
        const r = await fetch(base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "send", convId: "main", client: surfaces[i], clientId: `native-api-${i}`, text }) });
        expect(r.ok).toBe(true);
        expect(await r.json()).toMatchObject({ ok: true, convId: "main" });
        const c = await waitFor(async () => {
          const c = await conversation();
          return c.messages?.filter((m: any) => m.role === "assistant" && m.content === "Local native contract response.").length === i + 1 && c.state !== "running" ? c : null;
        }, 10_000, 20);
        sid ??= c.meta.threadId; path ??= c.meta.threadPath;
        expect(c.meta.threadId).toBe(sid); expect(c.meta.threadPath).toBe(path);
        expect(c.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(genuine.slice(0, i + 1));
        expect(JSON.stringify(c.messages)).not.toContain(canary);
      }
      const entries = readEntries(path!);
      const contexts = entries.filter(e => e.customType === "vc-context");
      expect(contexts.length).toBeGreaterThan(0);
      for (const context of contexts) expect(context).toMatchObject({ type: "custom_message", display: false });
      expect(entries.filter(e => e.message?.role === "user").map(e => e.message!.content)).toEqual(genuine.map(text => [{ type: "text", text }]));
      expect(entries.filter(e => e.message?.role === "user").map(e => e.message!.vcRequest)).toEqual(
        surfaces.map((device, i) => ({ v: 1, clientId: `native-api-${i}`, via: "chat", device })));
      expect(provider.calls).toHaveLength(2);
      for (const call of provider.calls) {
        expect(chatText(call).split(canary).length - 1).toBe(1);
        const submit = call.tools.find((t: any) => t.function.name === "mcp__vault_chat__SubmitChange");
        expect(Object.keys(submit.function.parameters.properties).sort()).toEqual(["branch", "title"]);
      }
      const feed = await (await fetch(base + "/poll?after=0")).json();
      expect(JSON.stringify(feed.events)).not.toContain(canary);
      for (let i = 0; i < 2; i++) expect(feed.events.some((e: any) => e.type === "entry" && e.clientId === `native-api-${i}` && e.entry.message?.role === "user")).toBe(true);
      expect(JSON.parse(readFileSync(path!, "utf8").split("\n")[0]!).id).toBe(sid);
      expect(readFileSync(outbound, "utf8")).toBe("");
    } finally {
      if (srv) { writeFileSync(join(home, "server.log"), srv.logs()); await srv.stop(); }
      writeFileSync(join(home, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
      await provider.close(); // Synthetic evidence retained even on failure.
    }
  });
});
