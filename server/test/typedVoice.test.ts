// Production routes -> genuine Pi 1.1 -> unpaid loopback provider -> existing
// New speak channel. Pipecat's actual TTSSpeakFrame collector is exercised by
// real-desktop.py; this test checks owner routing and the single native record.
import { expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { chatText } from "./fakeChat";
import { speechReady } from "../speakMath";
import { toSpeech } from "../speakable";

it("typed replies use their actual native answer once, independent of file viewer; OFF/end never start speech", async () => {
  const root = tmp("vc-typed-voice-"), master = join(root, "master");
  const owner = makeVault(join(master, "vaults/owner")), state = join(root, "state");
  const notes = Buffer.from('{"id":"human-note","status":"open","user_draft":"unchanged 🧩"}\n');
  mkdirSync(join(owner, ".vault-chat"), { recursive: true });
  writeFileSync(join(owner, ".vault-chat/notes.jsonl"), notes);
  const provider = await fakeAnthropic();
  const answer = "## Actual answer\nLiteral [Carl, on his laptop] is human text.\n\n```text\n# This header stays in the native answer\n```\n**Forty-two**, not another answer.";
  // The whole prompt, not its last user message: the runtime appends its own
  // system-reminder after Carl's words on a fresh session (see globalNotes).
  provider.respond = b => chatText(b).includes("OWNED-TYPED-") ? { text: answer } : { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Unowned inference refused"}}' };
  const guard = join(root, "local-only.mjs");
  writeFileSync(guard, `const real=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return real(${JSON.stringify(provider.url + "/models")},o);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('External requests refused');return real(i,o);};`);
  let srv: Running | undefined;
  const aborts: AbortController[] = [];
  try {
    srv = await startServer({ home: root, vault: owner, secrets: join(root, "empty-no-credentials"), anthropic: provider.url,
      extra: { VC_MASTER: master, VC_STATE_DIR: state,  VC_BWRAP: join(root, "absent-bwrap"), NODE_OPTIONS: `--import ${guard}`, PI_SKIP_VERSION_CHECK: "1" } });
    const post = async (p: string, body: unknown) => {
      const r = await fetch(srv!.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.ok).toBe(true); return r.json();
    };
    const get = async (p: string) => (await fetch(srv!.base + p)).json();
    const models = ["test/fake-model", "anthropic/claude-haiku-5.5"].map(id => ({ id, name: "Local unpaid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 }));
    await post("/api/v1/vaults", { name: "viewer" });
    const id = "sep-owned-typed";
    const checkpoint = async (conv = id) => (await get(`/api/v2/conversations/${conv}/checkpoint?vault=viewer`)).picture;
    let sends = 0;
    const send = async (suffix: string, client = "laptop", conv = id) => {
      const clientId = `owned-typed-${++sends}`;
      await post("/api/v2/intent?vault=viewer", { type: "send", convId: conv, client, clientId, text: "OWNED-TYPED-" + suffix });
      return waitFor(async () => { const p = await checkpoint(conv); return !p.meta.running && p.items.some((i: any) => i.id === clientId) && p.items.at(-1)?.kind === "assistant" ? p : null; }, 20000, 20);
    };
    const off = await send("OFF");
    const nativePrefix = readFileSync(off.meta.threadPath);
    expect((await get("/api/v1/brain/calls")).calls).toEqual([]);
    const call = await post("/api/v1/brain/call?vault=viewer", { convId: id, device: "laptop" });
    const channel = async () => {
      const ac = new AbortController(); aborts.push(ac);
      const response = await fetch(`${srv!.base}/api/v1/brain/call/${call.callId}/speak?vault=viewer`, { headers: { authorization: `Bearer ${call.token}` }, signal: ac.signal });
      expect(response.status).toBe(200);
      const output: any[] = [];
      const reading = (async () => {
        let partial = ""; const reader = response.body!.getReader();
        try { for (;;) { const r = await reader.read(); if (r.done) return; partial += new TextDecoder().decode(r.value); const lines = partial.split("\n"); partial = lines.pop()!; for (const line of lines) if (line.startsWith("data: ")) output.push(JSON.parse(line.slice(6))); } } catch { /* owned abort */ }
      })();
      return { output, ac, reading };
    };
    let stream = await channel();
    const current = await send("ACTIVE");
    await waitFor(() => stream.output.some(m => m.text), 5000, 10);
    await speechReady();
    expect(stream.output.filter(m => m.text).map(m => m.text)).toEqual([toSpeech(answer)]);
    expect(current.items.at(-1).text).toBe(answer);
    expect(current.meta.threadPath).toBe(off.meta.threadPath);
    // Unrelated threads and devices cannot borrow this conversation's live mouth.
    await send("OTHER-THREAD", "laptop", "sep-other-typed");
    await send("OTHER-DEVICE", "phone");
    await get("/poll?after=0&wait=0"); await checkpoint();
    expect(stream.output.filter(m => m.text)).toHaveLength(1);
    stream.ac.abort(); await stream.reading;
    stream = await channel();
    const reconnected = await send("RECONNECTED");
    await waitFor(() => stream.output.some(m => m.text), 5000, 10);
    expect(stream.output.filter(m => m.text).map(m => m.text)).toEqual([toSpeech(reconnected.items.at(-1).text)]);
    await post(`/api/v1/brain/call/${call.callId}/end`, {});
    await stream.reading;
    await send("AFTER-END");
    expect((await get("/api/v1/brain/calls")).calls).toEqual([]);
    expect(stream.output.filter(m => m.text)).toHaveLength(1);
    expect(provider.calls).toHaveLength(sends); // never a second speech inference
    expect(readFileSync(join(owner, ".vault-chat/notes.jsonl")).equals(notes)).toBe(true);
    expect((await checkpoint()).meta.threadPath).toBe(off.meta.threadPath);
    expect(readFileSync(off.meta.threadPath).subarray(0, nativePrefix.length).equals(nativePrefix)).toBe(true);
  } finally {
    for (const ac of aborts) ac.abort();
    writeFileSync(join(root, "server.log"), srv?.logs() ?? "no server");
    await srv?.stop(); await provider.close();
  }
});
