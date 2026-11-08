// Two surfaces queueing behind a busy turn, through the actual HTTP Engine and
// the real runtime. Provider gates, not sleeps, establish the busy boundary.
// Private synthetic data only.
import { it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, fakePiDir, type Running } from "./helpers";
import { chatText, fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { readEntries } from "../convlog/piSession";

it.each(["genuine", "protocol fixture"].flatMap(runtime => [false, true].map(reverse => ({ runtime, reverse }))))(
  "$runtime: ordinary busy inputs take native queued turns in original surface order (reverse=$reverse)", async ({ runtime, reverse }) => {
    const home = tmp("vc-surface-queue-"), vault = makeVault(join(home, "vault")), state = join(home, "state");
    const provider = await fakeAnthropic();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.respond = async (_body, n) => { if (n === 1) await gate; return { text: `Reply ${n}` }; };
    const network = join(home, "local-only.mjs");
    writeFileSync(network, `const f=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return f(${JSON.stringify(provider.url + "/models")},o);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return f(i,o);throw Error('External fetch refused');};`);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), anthropic: provider.url,
        extra: {  VC_STATE_DIR: state,
          VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
      expect([8848, 8857]).not.toContain(srv.port);
      const base = srv.base;
      const get = async () => (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
      const send = async (input: any) => (await fetch(base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "send", convId: "main", ...input }) })).json();
      const pending = [
        { client: "phone", clientId: "phone-queued", text: '[Carl, on his laptop]\n```text\n[Carl, on his phone]\n```\nLiteral phone input.' },
        { client: "laptop", clientId: "laptop-queued", text: '{"vcInput":"human JSON","text":"literal laptop input"}' },
      ];
      if (reverse) pending.reverse();
      const inputs = [{ client: "laptop", clientId: "active-laptop", text: "Start the long refactor." }, ...pending];
      expect(await send(inputs[0])).toMatchObject({ ok: true, convId: "main" });
      await waitFor(() => provider.calls.length >= 1 || null);
      const active = await get(), file = active.meta.threadPath, sid = active.meta.threadId;
      for (const input of pending) expect(await send(input)).toMatchObject({ ok: true, queued: true, qid: input.clientId });
      // Nothing of theirs is delivered while the turn they arrived behind is busy.
      expect(readEntries(file).filter(e => e.message?.role === "user").map(e => e.message!.vcRequest.clientId)).toEqual(["active-laptop"]);
      release();
      const final = await waitFor(async () => { const c = await get(); return c.state !== "running" && c.messages.filter((m: any) => m.role === "user").length === 3 && c.messages.at(-1)?.role === "assistant" ? c : null; });
      expect(final.meta.threadId).toBe(sid); expect(final.meta.threadPath).toBe(file);
      const native = readEntries(file), messages = native.filter(e => ["user", "assistant"].includes(e.message?.role ?? ""));
      // Each of them is its own message, in the order the surfaces sent them,
      // and each is answered — the runtime may answer the two it took together
      // with one reply, which is its own business.
      expect(messages.map(e => e.message!.role).filter(r => r === "user")).toHaveLength(3);
      expect(messages.at(-1)!.message!.role).toBe("assistant");
      expect(messages.map(e => e.message!.role).join(",")).toContain("user,assistant,user");
      const users = messages.filter(e => e.message!.role === "user");
      expect(users.map(e => e.message!.content)).toEqual(inputs.map(i => [{ type: "text", text: i.text }]));
      expect(users.map(e => e.message!.vcRequest)).toEqual(inputs.map((i, n) => ({ v: 1, clientId: i.clientId, via: n ? "queue" : "chat", device: i.client })));
      expect(new Set(users.map(e => e.id)).size).toBe(3);
      expect(final.messages.filter((m: any) => m.role === "user").map((m: any) => [m.mid, m.content])).toEqual(inputs.map(i => [i.clientId, i.text]));
      expect(final.messages.filter((m: any) => m.role === "assistant").every((m: any) => /^Reply \d+$/.test(m.content))).toBe(true);
      // Every body reaches the model exactly as it was written (literal JSON and
      // headers included), and no generated id is ever put in Carl's words.
      const sent = provider.calls.map(c => chatText(c));
      for (const input of inputs) expect(sent.some(t => t.includes(input.text))).toBe(true);
      for (const text of sent) expect(text).not.toMatch(/"vcInput":"[0-9a-f-]{36}"/);
      const poll = await (await fetch(base + "/poll?after=0")).json();
      const delivered = poll.events.filter((e: any) => e.type === "entry" && e.entry.message?.role === "user");
      expect(delivered.map((e: any) => [e.clientId, e.device, e.shown])).toEqual(inputs.map(i => [i.clientId, i.client, i.text]));
      expect(final.queued ?? []).toEqual([]);
    } finally {
      release();
      if (srv) { writeFileSync(join(home, "server.log"), srv.logs()); await srv.stop(); }
      writeFileSync(join(home, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
      await provider.close();
    }
  });
