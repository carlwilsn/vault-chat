// The feed end to end: the real bundle, the engine on the fake pi
// (fakePiCli.mjs: pi's RPC protocol, and its session file in pi's format), a
// fake OpenRouter. The transcript is pi's session file; what a client sees is
// the feed: /poll?after=N answers exactly the records after N at every N, a
// conversation's own records and its checkpoint are the same fold, a client's
// id comes back on its message, steer / queue / stop / answer are server
// operations mapped to pi's own, and a restart in the middle of a turn leaves
// the feed intact: a client resumes from its cursor with no gap, and what
// streamed before the kill is still shown.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import { fold, pendingOf, rowFromPicture, shown, isOpen } from "../../src/convlog/reduce";
import { messagesOf } from "../../src/convlog/view";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
let srv: Running;

const get = async (p: string) => (await fetch(srv.base + p)).json();
const intent = async (b: Record<string, unknown>) => {
  const r = await fetch(srv.base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.json();
};
/** Every record after `after`, following `more`. */
async function all(after = 0): Promise<any[]> {
  const out: any[] = [];
  let cur = after;
  for (;;) {
    const r = await get(`/poll?after=${cur}`);
    out.push(...r.events);
    if (!r.events.length || !r.more) return out;
    cur = r.next;
  }
}
const recsOf = async (conv: string) => (await all()).filter((r) => r.conv === conv);
const isEnd = (r: any) => r.type === "meta" && "running" in r.patch && r.patch.running === null;
const ended = async (conv: string, n = 1) => (await recsOf(conv)).filter(isEnd).length >= n;
const head = async () => (await get("/poll?after=latest")).next as number;
/** The reply of a turn started after `since` is streaming (pi's deltas in the feed). */
const streaming = async (conv: string, since: number, n = 1) => (await recsOf(conv)).filter((x) => x.seq > since && x.type === "live" && x.ev.assistantMessageEvent?.type === "text_delta").length >= n;

beforeAll(async () => {
  home = tmp("vclog-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("Here is the answer.");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
});

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("the feed over HTTP", () => {
  let conv = "";

  it("a send: the client's id on Carl's message (pi's own entry), the reply streamed, then pi's entry", async () => {
    const r = await intent({ type: "send", clientId: "c-first-1", text: "What is a KV cache?" });
    expect(r.ok).toBe(true);
    conv = r.convId;
    await waitFor(() => ended(conv), 30_000);
    const recs = await recsOf(conv);
    expect(recs[0]).toMatchObject({ type: "meta" });
    const userEntry = recs.find((x) => x.type === "entry" && x.entry.message?.role === "user");
    expect(userEntry).toMatchObject({ clientId: "c-first-1", shown: "What is a KV cache?", via: "chat" });
    // Running before anything streams; pi's deltas before pi's entry for that message.
    const at = (f: (x: any) => boolean) => recs.findIndex(f);
    expect(at((x) => x.type === "meta" && x.patch.running)).toBeLessThan(at((x) => x.type === "live"));
    expect(at((x) => x.type === "live" && x.ev.assistantMessageEvent?.type === "text_delta")).toBeLessThan(at((x) => x.type === "entry" && x.entry.message?.role === "assistant"));
    const p = fold(recs, conv);
    expect(p.meta.running).toBeUndefined();
    expect(messagesOf(p).map((m) => [m.role, m.content])).toEqual([
      ["user", "What is a KV cache?"],
      ["assistant", "Here is the answer."],
    ]);
    // The transcript is pi's session file: the pointers name it, the entries are pi's.
    const file = userEntry.file as string;
    expect(readFileSync(file, "utf8")).toContain('"type":"session"');
    const feedOnDisk = readFileSync(join(vault, ".vault-chat", "events", `${conv}.jsonl`), "utf8");
    // (pi's live events for the message in flight are kept; the message itself is pi's entry, pointed to.)
    const pointers = feedOnDisk.trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === "entry");
    expect(pointers.length).toBeGreaterThan(1);
    expect(pointers.every((x) => !("entry" in x) && x.file === file)).toBe(true);
    // The same send again (a retry): nothing new.
    const again = await intent({ type: "send", convId: conv, clientId: "c-first-1", text: "What is a KV cache?" });
    expect(again.duplicate).toBe(true);
    expect((await recsOf(conv)).filter((x) => x.type === "entry" && x.clientId === "c-first-1")).toHaveLength(1);
  });

  it("/poll?after=N answers exactly the records after N, at every N", async () => {
    const every = await all(0);
    const seqs = every.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let n = 0; n < seqs.at(-1)!; n++) {
      const got = await all(n);
      expect(got.map((r) => r.seq)).toEqual(seqs.filter((s) => s > n));
    }
    // The head: nothing after it; a cursor beyond the head or from another feed starts over.
    const h = await get("/poll?after=latest");
    expect(h.next).toBe(seqs.at(-1));
    expect((await get(`/poll?after=${h.next + 100}`)).reset).toBe(true);
    expect((await get(`/poll?after=1&epoch=not-this-log`)).reset).toBe(true);
    expect((await get(`/poll?after=1&epoch=${h.epoch}`)).reset).toBeUndefined();
  });

  it("a conversation's records, its checkpoint and the list row are the same fold", async () => {
    const own = await get(`/api/v2/conversations/${conv}/events?after=0`);
    const viaPoll = await recsOf(conv);
    expect(own.events).toEqual(viaPoll);
    const ck = await get(`/api/v2/conversations/${conv}/checkpoint`);
    expect(ck.picture).toEqual(JSON.parse(JSON.stringify(fold(own.events, conv))));
    const half = own.events.slice(0, Math.floor(own.events.length / 2));
    const tail = await get(`/api/v2/conversations/${conv}/events?after=${half.at(-1).seq}`);
    expect(JSON.parse(JSON.stringify((await import("../../src/convlog/reduce")).foldInto(fold(half, conv), tail.events)))).toEqual(ck.picture);
    const rows = await get("/api/v2/conversations");
    const row = rows.rows.find((x: any) => x.id === conv);
    expect(row).toEqual(JSON.parse(JSON.stringify(rowFromPicture(fold(own.events, conv)))));
  });

  it("steer and queue are pi's: pending, then Carl's message where pi delivers it, in every client's order", async () => {
    const h0 = await head();
    const r = await intent({ type: "send", convId: conv, clientId: "c-slow-1", text: "[slow] Walk me through it." });
    expect(r.ok).toBe(true);
    await waitFor(() => streaming(conv, h0), 15_000);
    const s = await intent({ type: "steer", convId: conv, clientId: "c-steer-1", text: "Shorter, please." });
    expect(s.steered).toBe(true);
    const q = await intent({ type: "queue", convId: conv, clientId: "c-queue-1", text: "Then give an example." });
    expect(q.queued).toBe(true);
    // Pending in the feed until pi delivers them.
    const mid = fold(await recsOf(conv), conv);
    expect(pendingOf(mid).map((x) => [x.id, x.kind])).toEqual([["c-steer-1", "steer"], ["c-queue-1", "queue"]]);
    await waitFor(() => ended(conv, 2), 60_000);
    const p = fold(await recsOf(conv), conv);
    expect(pendingOf(p)).toEqual([]);
    const users = p.items.filter((x) => x.kind === "user").map((x) => [x.id, x.via]);
    expect(users.slice(-3)).toEqual([["c-slow-1", "chat"], ["c-steer-1", "steer"], ["c-queue-1", "queue"]]);
    // Each of Carl's messages comes after a reply to the one before it (pi's order).
    const order = p.items.filter((x) => x.kind === "user" || x.kind === "assistant").map((x) => x.kind).slice(-6);
    expect(order).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("stop: the turn ends, said once; a queued message pi never took is no longer pending and never shown", async () => {
    const h0 = await head();
    await intent({ type: "send", convId: conv, clientId: "c-slow-2", text: "[slow] A long one." });
    await waitFor(() => streaming(conv, h0), 15_000);
    await intent({ type: "queue", convId: conv, clientId: "c-queue-2", text: "Never delivered." });
    expect(pendingOf(fold(await recsOf(conv), conv)).map((x) => x.id)).toEqual(["c-queue-2"]);
    const r = await intent({ type: "stop", convId: conv });
    expect(r.ok).toBe(true);
    await waitFor(() => ended(conv, 3), 30_000);
    const p = fold(await recsOf(conv), conv);
    expect(pendingOf(p)).toEqual([]);
    expect(p.items.filter((x) => x.kind === "notice" && x.text === "Stopped.")).toHaveLength(1);
    expect(p.items.some((x) => x.id === "c-queue-2")).toBe(false);
    expect(shown(p).some(isOpen)).toBe(false);
  });

  it("AskUser: the question waits; the answer is Carl's line under his client's id; the turn goes on", async () => {
    or.script.push({ toolCall: { name: "AskUser", args: { question: "Apple or pear?", options: ["apple", "pear"] } } }, { text: "Pear it is." });
    await intent({ type: "send", convId: conv, clientId: "c-ask-1", text: "Pick a fruit with me." });
    await waitFor(async () => !!fold(await recsOf(conv), conv).meta.asking, 30_000);
    const asking = fold(await recsOf(conv), conv).meta.asking!;
    expect(asking).toMatchObject({ question: "Apple or pear?", options: ["apple", "pear"] });
    const a = await intent({ type: "answer", convId: conv, clientId: "c-ans-1", text: "pear" });
    expect(a.answered).toBe(true);
    await waitFor(() => ended(conv, 4), 30_000);
    const p = fold(await recsOf(conv), conv);
    expect(p.meta.asking).toBeUndefined();
    const ask = p.items.find((x) => x.kind === "tool" && x.name === "AskUser")!;
    expect(ask).toMatchObject({ status: "done", result: "Carl answered: pear" });
    const at = p.items.indexOf(ask);
    expect(p.items.slice(at + 1).find((x) => x.kind === "user")).toMatchObject({ id: "c-ans-1", via: "answer", text: "pear" });
    expect(p.items.filter((x) => x.kind === "assistant").at(-1)?.text).toBe("Pear it is.");
  });

  it("a restart in the middle of a turn: the feed is intact, a client resumes from its cursor with no gap", async () => {
    const h0 = await head();
    await intent({ type: "send", convId: conv, clientId: "c-slow-3", text: "[slow] Keep talking while the box restarts." });
    await waitFor(() => streaming(conv, h0, 4), 20_000);
    const before = await all(0);
    const cursor = before.at(-1).seq;
    const epoch = (await get("/poll?after=latest")).epoch;
    const shownBefore = shown(fold(before.filter((x) => x.conv === conv), conv)).filter((x) => x.kind === "assistant").at(-1)!.text!;
    expect(shownBefore.length).toBeGreaterThan(0);
    // Killed mid-turn (no clean shutdown), then back.
    srv.proc.kill("SIGKILL");
    await srv.exited;
    srv = await startServer({ home, vault, secrets, openrouter: or.url });
    // Everything a client saw is still there, unchanged, in order.
    const again = await all(0);
    expect(again.slice(0, before.length)).toEqual(before);
    expect((await get("/poll?after=latest")).epoch).toBe(epoch);
    // The client that held `cursor` gets exactly what came after it: the turn's end, the line saying why, the resume.
    await waitFor(async () => (await all(cursor)).some((x) => x.conv === conv && x.type === "entry" && /Interrupted by a restart/.test(x.entry.data?.text ?? "")), 20_000);
    const tail = await all(cursor);
    expect(tail.every((x) => x.seq > cursor)).toBe(true);
    const merged = [...before, ...tail];
    expect(new Set(merged.map((x) => x.seq)).size).toBe(merged.length);
    expect(merged.map((x) => x.seq)).toEqual((await all(0)).map((x) => x.seq).slice(0, merged.length));
    // The cut is said once, the turn resumed once.
    await waitFor(async () => {
      const p = fold(await recsOf(conv), conv);
      return !p.meta.running && p.items.some((x) => x.kind === "user" && x.via === "resume") ? p : null;
    }, 60_000);
    const p = fold(await recsOf(conv), conv);
    expect(p.items.filter((x) => x.kind === "notice" && /Interrupted by a restart/.test(x.text ?? ""))).toHaveLength(1);
    expect(p.items.filter((x) => x.kind === "user" && x.via === "resume")).toHaveLength(1);
    // What streamed before the kill is still shown, closed (not lost, not streaming forever).
    const cut = p.items.filter((x) => x.kind === "assistant" && x.status === "stopped");
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.some((x) => (x.text ?? "").startsWith(shownBefore.slice(0, 10)))).toBe(true);
    expect(shown(p).some(isOpen)).toBe(false);
  });
});
