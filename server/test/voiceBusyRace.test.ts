// Genuine pinned Pi + production HTTP/native queue + bot.py's real ResultFlow.
// Owned unpaid provider and inert TTSSpeakFrame collector only; never opens media.
import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeChat, lastUser } from "./fakeChat";
import { makeVault, ROOT, startServer, tmp, waitFor, type Running } from "./helpers";

const pi = process.env.VC_TEST_PI_DIR;
const python = process.env.VC_TEST_VOICE_PYTHON ?? (pi ? join(pi, "../../voice/venv/bin/python") : "");
it.skipIf(!pi || !existsSync(python))("busy voice beats native follow-ups; overtaken and ended completions cannot close or speak into the next answer", async () => {
  const root = tmp("vc-voice-race-"), vault = makeVault(join(root, "vault")), state = join(root, "state");
  const provider = await fakeChat();
  const held = new Map<string, () => void>();
  const arrived = new Set<string>();
  provider.respond = async b => {
    const user = lastUser(b);
    if (user.includes("OWNED-RACE-BUSY")) {
      return { call: { name: "bash", args: { command: "echo started > foreground-started; sleep 15; echo finished > foreground-result" } }, noCost: true };
    }
    for (const label of ["OBSOLETE", "ENDED"]) if (user.includes("OWNED-RACE-" + label)) {
      arrived.add(label);
      await new Promise<void>(resolve => held.set(label, resolve));
      return { text: `Stale ${label} answer must not escape.`, noCost: true };
    }
    if (user.includes("OWNED-RACE-QUEUED")) return { text: "Queued typed answer.", noCost: true };
    if (user.includes("OWNED-RACE-FRESH")) return { text: "Fresh typed answer.", noCost: true };
    if (user.includes("OWNED-RACE-NOW")) return { text: "Current spoken answer.", noCost: true };
    return { status: 503, body: "Unowned inference refused" };
  };
  const guard = join(root, "local-only.mjs");
  writeFileSync(guard, `const f=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return f(${JSON.stringify(provider.url + "/models")},o);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('External inference refused');return f(i,o);};`);
  let srv: Running | undefined, collector: ChildProcess | undefined, collectorLog = "";
  const aborts: AbortController[] = [];
  const collect = join(root, "collector"); mkdirSync(collect);
  try {
    srv = await startServer({ bundle: process.env.VC_VOICE_BUSY_BUNDLE, home: root, vault, secrets: join(root, "empty-credentials"), openrouter: provider.url,
      extra: { VC_PI_DIR: pi!, VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: state,
        NODE_OPTIONS: `--import ${guard}`, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
    const post = async (path: string, body: unknown) => {
      const r = await fetch(srv!.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.ok).toBe(true); return r.json();
    };
    const agent = join(state, "pi/agent"); mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const models = ["test/fake-model", "anthropic/claude-haiku-5.5"].map(id => ({ id, name: "Local unpaid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 }));
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url, apiKey: "synthetic-local-only", api: "openai-completions", models } } }));
    const owner = "sep-owned-voice-race";
    const checkpoint = async () => (await (await fetch(srv!.base + `/api/v2/conversations/${owner}/checkpoint`)).json() as any).picture;
    await post("/message", { convId: owner, text: "OWNED-RACE-BUSY", client: "laptop" });
    await waitFor(() => existsSync(join(vault, "foreground-started")), 30000, 20);
    const before = await checkpoint(), prefix = readFileSync(before.meta.threadPath);
    await post("/message", { convId: owner, text: "OWNED-RACE-QUEUED", client: "laptop", clientMsgId: "owned-queued" });
    expect((await checkpoint()).meta.pending.map((p: any) => p.id)).toEqual(["owned-queued"]);
    const call = await post("/api/v1/brain/call", { convId: owner, device: "laptop" });
    collector = spawn(python!, [join(ROOT, "voice-pipeline/test_native_speech.py"), "--collect-native"], { stdio: ["pipe", "ignore", "pipe"] });
    collector.stderr!.on("data", b => { collectorLog += b; });
    collector.stdin!.end(JSON.stringify({ base: srv.base, id: call.callId, token: call.token, work: collect }) + "\n");
    const collectorExit = new Promise<number | null>(resolve => collector!.once("exit", resolve));
    await waitFor(() => existsSync(join(collect, "ready")), 30000, 20);
    const messages: { role: string; content: string }[] = [];
    const begin = async (text: string, capability = call) => {
      messages.push({ role: "user", content: text });
      const ac = new AbortController(); aborts.push(ac);
      const started = performance.now();
      const response = await fetch(srv!.base + "/v1/chat/completions", { method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${capability.token}` }, body: JSON.stringify({ stream: true, messages }) });
      expect(response.ok).toBe(true);
      const result = response.text().then(raw => {
        const pieces = raw.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
          .map(l => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "");
        return { text: pieces.join(""), done: raw.split("data: [DONE]").length - 1, ms: performance.now() - started };
      });
      return { result, ac };
    };
    expect(existsSync(join(vault, "foreground-result"))).toBe(false);
    const first = await (await begin("OWNED-RACE-NOW first independent question?")).result;
    console.log("VOICE_NATIVE_FIRST " + JSON.stringify(first));
    expect(first.text).toBe("Current spoken answer."); expect(first.done).toBe(1); expect(first.ms).toBeLessThan(1500);
    await waitFor(() => existsSync(join(collect, "held")), 10000, 20);
    await waitFor(async () => (await checkpoint()).items.some((i: any) => i.kind === "assistant" && i.text === "Queued typed answer."), 10000, 20);
    const obsolete = await begin("OWNED-RACE-OBSOLETE independent question?");
    await waitFor(() => arrived.has("OBSOLETE"), 10000, 10);
    const current = await begin("OWNED-RACE-NOW second independent question?");
    // Old provider is STILL held. No fabricated native end/delivery event or timeout release.
    const second = await current.result;
    expect(second.text).toBe("Current spoken answer."); expect(second.done).toBe(1); expect(second.ms).toBeLessThan(1500);
    expect((await obsolete.result).text).toBe("");
    held.get("OBSOLETE")!();
    writeFileSync(join(collect, "release"), "");
    await post("/message", { convId: owner, text: "OWNED-RACE-FRESH", client: "laptop" });
    const dispatched = () => existsSync(join(collect, "dispatch.json")) ? JSON.parse(readFileSync(join(collect, "dispatch.json"), "utf8")) : [];
    // Positive control: the SAME real ResultFlow must drain its stale candidate
    // and then dispatch a current native answer, not merely fail/disconnect.
    await waitFor(() => dispatched().includes("Fresh typed answer."), 10000, 20);
    expect(dispatched()).toEqual(["Fresh typed answer."]);
    const ended = await begin("OWNED-RACE-ENDED question before call ends?");
    await waitFor(() => arrived.has("ENDED"), 10000, 10);
    const cancelled = ended.result.catch(error => {
      expect(error.name).toBe("AbortError"); return null;
    });
    ended.ac.abort();
    expect(await cancelled).toBeNull();
    await post(`/api/v1/brain/call/${call.callId}/end`, {});
    writeFileSync(join(collect, "release"), "");
    writeFileSync(join(collect, "stop"), "");
    expect(await collectorExit).toBe(0);
    writeFileSync(join(root, "collector.log"), collectorLog);
    // Cancellation/end must not transfer the obsolete completion into a new call.
    const nextCall = await post("/api/v1/brain/call", { convId: owner, device: "laptop" });
    const third = await (await begin("OWNED-RACE-NOW after end?", nextCall)).result;
    expect(third.text).toBe("Current spoken answer."); expect(third.done).toBe(1); expect(third.ms).toBeLessThan(1500);
    // The ended call's provider stayed blocked throughout replacement and its answer.
    held.get("ENDED")!();
    await post(`/api/v1/brain/call/${nextCall.callId}/end`, {});
    const after = await checkpoint();
    expect(after.meta.threadPath).toBe(before.meta.threadPath);
    expect(readFileSync(before.meta.threadPath).subarray(0, prefix.length).equals(prefix)).toBe(true);
    const users = after.items.filter((i: any) => i.kind === "user").map((i: any) => i.text);
    for (const text of ["OWNED-RACE-BUSY", "OWNED-RACE-QUEUED", "OWNED-RACE-FRESH", ...messages.map(m => m.content)]) expect(users.filter((t: string) => t === text)).toHaveLength(1);
    expect(users.indexOf(messages[0].content)).toBeLessThan(users.indexOf("OWNED-RACE-QUEUED"));
    expect(dispatched()).toEqual(["Fresh typed answer."]);
    console.log("VOICE_NATIVE_RACE " + JSON.stringify({ first, second, third, dispatch: dispatched(), sameSession: true, root }));
  } finally {
    for (const release of held.values()) release();
    for (const ac of aborts) ac.abort();
    writeFileSync(join(collect, "release"), ""); writeFileSync(join(collect, "stop"), "");
    collector?.kill();
    writeFileSync(join(root, "collector.log"), collectorLog);
    writeFileSync(join(root, "server.log"), srv?.logs() ?? "no server");
    await srv?.stop(); await provider.close();
  }
});
