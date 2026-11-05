// Actual bundle/Engine/PiBackend/Pi 1.1.0, unpaid loopback provider.
// Reproduce the native A ordering: held foreground -> FIRST -> SECOND ->
// Send now SECOND -> immediate provider response. A public Pi input hook
// gives FIRST an 80ms arrival delay, deterministically exposing the same
// enqueue-after-settle race. Only our generated host extension is instrumented;
// the pinned SDK/dependencies remain read-only. Not installed/UI proof.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeChat, lastUser } from "./fakeChat";
import { addWake } from "../engine/wakes";
import { readEntries } from "../convlog/piSession";
import { voiceCallRules } from "../voiceBrain";

describe("native Pi interrupt-and-send queue contract", () => {
  it("delivers SECOND then FIRST exactly once through native Pi, including the phone binding", async () => {
    const home = tmp("vc-native-queue-"), vault = makeVault(join(home, "vault"));
    const state = join(home, "state"), canary = "COMBINED_NATIVE_CONTEXT_CANARY";
    mkdirSync(join(vault, ".vault-chat"), { recursive: true });
    writeFileSync(join(vault, ".vault-chat/MEMORY.md"), `# Memory\n\n- ${canary}\n`);
    const provider = await fakeChat();
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
    const streams: AbortController[] = [];
    try {
      srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), openrouter: provider.url,
        extra: { VC_PI_DIR: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"),
          VC_STATE_DIR: state, VC_ENGINE_MODEL: "test/fake-model", VC_PI_UNSAFE: "1", VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
      expect(srv.proc.exitCode).toBeNull();
      expect(srv.port).toBeGreaterThan(0);
      expect([8848, 8857]).not.toContain(srv.port);
      const health = await (await fetch(srv.base + "/api/v1/health")).json();
      expect(health.engine.pi.state).toBe("up");
      expect(health.engine.version).toBe("1.1.0");
      const agent = join(state, "pi/agent");
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url,
        apiKey: "synthetic-local-only", api: "openai-completions", models: ["test/fake-model", "anthropic/claude-haiku-5.5"].map(id => ({ id, name: "Local contract",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 })) } } }));
      // Public input hook on our OWN generated extension, never SDK mutation.
      const extension=join(state,"pi/ext/vc.mjs");
      writeFileSync(extension,readFileSync(extension,"utf8").replace("export default function vaultChat(pi) {",`export default function vaultChat(pi) {
        pi.on("input",async e=>{if(e.text.includes("QUEUE-FIRST")) await new Promise(r=>setTimeout(r,80));});`));
      const base = srv.base;
      const cases = [
        { type: "send", client: "laptop" },
        { type: "queue", client: "phone" },
        { type: "queue", client: "phone", source: "voice", via: "voice", continues: true },
      ];
      for (const [iteration, arrival] of cases.entries()) {
        const id = `sep-native-queue-${iteration}`;
        const conversation = async () => (await fetch(base + `/conversation?id=${id}&full=1&n=200`)).json();
        const picture = async () => (await (await fetch(base + `/api/v2/conversations/${id}/checkpoint`)).json()).picture;
        const post = async (body: any) => (await fetch(base + "/api/v2/intent", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ convId: id, ...body }),
        })).json();
        const callsBefore = provider.calls.length;
        provider.respond = body => {
          const last = lastUser(body);
          if (last.startsWith("Wake:")) {
            if (body.messages.at(-1)?.role === "tool") return { text: "wake refusal checked" };
            return { call: { name: "BoardSend", args: { title: "Not human permission", parts: [{ kind: "math", markdown: "$x$" }] } } };
          }
          return { text: last.includes("QUEUE-FIRST") ? "FIRST native reply." : "SECOND native reply.", ...(last.includes("QUEUE-HOLD") ? { delayMs: 3000 } : {}) };
        };
        expect(await post({ type: "send", client: "laptop", clientId: "hold", text: "QUEUE-HOLD" })).toMatchObject({ ok: true });
        await waitFor(() => provider.calls.length > callsBefore ? true : null, 10000, 10);
        // The call is owned by this exact native conversation. Queuing FIRST
        // cannot borrow it; only FIRST's real delivery can change speech owner.
        const call = await (await fetch(base + "/api/v1/brain/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ convId: id, device: "phone" }) })).json();
        const ac = new AbortController(); streams.push(ac);
        const response = await fetch(base + `/api/v1/brain/call/${call.callId}/speak`, { headers: { authorization: `Bearer ${call.token}` }, signal: ac.signal });
        expect(response.status).toBe(200);
        const speech: any[] = [];
        const reading = (async () => {
          const reader = response.body!.getReader(); let pending = "";
          try { for (;;) { const r = await reader.read(); if (r.done) break; pending += new TextDecoder().decode(r.value); const lines = pending.split("\n"); pending = lines.pop()!; for (const line of lines) if (line.startsWith("data: ")) speech.push(JSON.parse(line.slice(6))); } } catch { /* private stream cleanup */ }
        })();
        expect(await post({ ...arrival, clientId: "first", text: "QUEUE-FIRST" })).toMatchObject({ ok: true });
        expect(await post({ type: "send", client: "laptop", clientId: "second", text: "QUEUE-SECOND" })).toMatchObject({ ok: true });
        expect((await picture()).meta.pending.map((p: any) => p.id)).toEqual(["first", "second"]);
        expect(await post({ type: "now", id: "second" })).toMatchObject({ ok: true });
        const c = await waitFor(async () => {
          const c = await conversation(), p = await picture();
          return !p.meta.running && !p.meta.pending && c.messages.some((m: any) => m.mid === "first") ? c : null;
        }, 10000, 10);
        const firstSurface = arrival.source === "voice" ? "a voice call (phone)" : `his ${arrival.client}`;
        const expected = ["[Carl, on his laptop]\n\nQUEUE-HOLD", `${voiceCallRules("phone")}\n\n[Carl, on his laptop]\n\nQUEUE-SECOND`, `[Carl, on ${firstSurface}]\n\nQUEUE-FIRST`];
        expect(readEntries(c.meta.threadPath).filter(e => e.message?.role === "user").map(e => e.message!.content))
          .toEqual(expected.map(text => [{ type: "text", text }]));
        expect(c.messages.filter((m: any) => m.role === "user").map((m: any) => m.mid)).toEqual(["hold", "second", "first"]);
        const ownCalls = provider.calls.slice(callsBefore);
        // Selected SECOND gets its answer before FIRST follows: no native steer
        // may leap ahead and merge FIRST into that selected provider response.
        const selectedCall = ownCalls.find(b => lastUser(b).includes("QUEUE-SECOND"));
        expect(selectedCall).toBeDefined();
        const selectedHumans = selectedCall.messages.filter((m: any) => m.role === "user");
        expect(JSON.stringify(selectedHumans.filter((m: any) => !JSON.stringify(m.content).includes("<you>"))))
          .not.toContain("QUEUE-FIRST");
        const lastInput = provider.calls.slice(callsBefore).at(-1).messages.filter((m: any) => m.role === "user")
          .flatMap((m: any) => typeof m.content === "string" ? [m.content] : m.content.map((x: any) => x.text));
        for (const text of expected) expect(lastInput.filter((x: string) => x === text)).toHaveLength(1);
        const events = (await (await fetch(base + "/poll?after=0")).json()).events.filter((e: any) => e.conv === id);
        const delivered = new Set<string>();
        for (const event of events) {
          if (event.type === "entry" && event.clientId) delivered.add(event.clientId);
          if (event.type === "meta" && "pending" in event.patch) {
            const pending = event.patch.pending ?? [];
            for (const clientId of ["first", "second"]) {
              if (!pending.some((p: any) => p.id === clientId) && delivered.has("hold") &&
                  events.some((e: any) => e.seq < event.seq && e.patch?.pending?.some((p: any) => p.id === clientId))) {
                expect(delivered.has(clientId), `${clientId} cleared before native delivery`).toBe(true);
              }
            }
          }
        }
        const humanEntries = events.filter((e: any) => e.type === "entry" && ["first", "second"].includes(e.clientId));
        expect(humanEntries.map((e: any) => [e.clientId, e.device])).toEqual([["second", "laptop"], ["first", arrival.client]]);
        if (arrival.client === "phone") await waitFor(() => speech.some(m => m.text === "FIRST native reply.") ? true : null, 5000, 10);
        await fetch(base + `/api/v1/brain/call/${call.callId}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        await reading;
        expect(speech.filter(m => m.text).map(m => m.text)).toEqual(arrival.client === "phone" ? ["FIRST native reply."] : []);
        // Exercise the production durable wake path on this private fixture.
        // Its iPad words are NOT a delivered human request or a new device.
        addWake(vault, { conv: id, at: Date.now(), reason: "send to iPad", byCarl: true });
        await waitFor(async () => {
          const c = await conversation(), p = await picture();
          return !p.meta.running && c.messages.some((m: any) => m.role === "assistant" && m.content === "wake refusal checked") ? c : null;
        }, 10000, 20);
        expect((await picture()).items.some((m: any) => m.kind === "user" && m.via === "wake")).toBe(true);
        const results = readEntries(c.meta.threadPath).filter(e => e.message?.role === "toolResult");
        expect(JSON.stringify(results.at(-1)?.message?.content)).toContain("Not sent to the board");
        expect((await (await fetch(base + "/api/v1/inbox")).json()).entries).toEqual([]);
      }
      expect(readFileSync(outbound, "utf8")).toBe("");
    } finally {
      for (const ac of streams) ac.abort();
      if (srv) { writeFileSync(join(home, "server.log"), srv.logs()); await srv.stop(); }
      writeFileSync(join(home, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
      await provider.close(); // Synthetic evidence retained even on failure.
    }
  });
});
