// The conversation log end to end: the real bundle, the engine on the fake pi
// (fakePiCli.mjs, pi's RPC protocol), a fake OpenRouter. What a client sees is
// exactly the log: /poll?after=N answers exactly the records after N at every
// N, a conversation's own records and its checkpoint are the same fold, a
// client's id comes back on its message, steer / queue / stop / answer are
// server operations with their own records, and a restart in the middle of a
// turn leaves the log intact: a client resumes from its cursor with no gap.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import { fold, rowFromPicture } from "../../src/convlog/reduce";
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
const ended = async (conv: string, n = 1) => (await recsOf(conv)).filter((r) => r.type === "turn.ended").length >= n;
const head = async () => (await get("/poll?after=latest")).next as number;
/** The reply of a turn started after `since` is streaming. */
const streaming = async (conv: string, since: number, n = 1) => (await recsOf(conv)).filter((x) => x.seq > since && x.type === "item.delta").length >= n;

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

describe("the log over HTTP", () => {
  let conv = "";

  it("a send: the client's id on Carl's message, the turn's records, the reply streamed", async () => {
    const r = await intent({ type: "send", clientId: "c-first-1", text: "What is a KV cache?" });
    expect(r.ok).toBe(true);
    conv = r.convId;
    await waitFor(() => ended(conv), 30_000);
    const recs = await recsOf(conv);
    expect(recs[0]).toMatchObject({ type: "conv.created" });
    expect(recs.find((x) => x.type === "item.started" && x.item.kind === "user")?.item).toMatchObject({ id: "c-first-1", text: "What is a KV cache?" });
    const types = recs.map((x) => x.type);
    expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("item.delta"));
    expect(types.at(-1) === "turn.ended" || types.includes("turn.ended")).toBe(true);
    const p = fold(recs, conv);
    expect(p.turn).toBeNull();
    expect(messagesOf(p).map((m) => [m.role, m.content])).toEqual([
      ["user", "What is a KV cache?"],
      ["assistant", "Here is the answer."],
    ]);
    // The same send again (a retry): nothing new.
    const again = await intent({ type: "send", convId: conv, clientId: "c-first-1", text: "What is a KV cache?" });
    expect(again.duplicate).toBe(true);
    expect((await recsOf(conv)).filter((x) => x.type === "item.started" && x.item.id === "c-first-1")).toHaveLength(1);
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
    // The head: nothing after it; a cursor beyond the head or from another log starts over.
    const head = await get("/poll?after=latest");
    expect(head.next).toBe(seqs.at(-1));
    expect((await get(`/poll?after=${head.next + 100}`)).reset).toBe(true);
    expect((await get(`/poll?after=1&epoch=not-this-log`)).reset).toBe(true);
    expect((await get(`/poll?after=1&epoch=${head.epoch}`)).reset).toBeUndefined();
  });

  it("a conversation's records, its checkpoint and the list row are the same fold", async () => {
    const own = await get(`/api/v2/conversations/${conv}/events?after=0`);
    const viaPoll = await recsOf(conv);
    expect(own.events).toEqual(viaPoll);
    const ck = await get(`/api/v2/conversations/${conv}/checkpoint`);
    expect(ck.picture).toEqual(JSON.parse(JSON.stringify(fold(own.events, conv))));
    // The tail after a checkpoint, folded on it, is the whole fold too.
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
    // Pending in the log until pi delivers them.
    const mid = fold(await recsOf(conv), conv);
    expect(mid.pending.map((x) => [x.id, x.kind])).toEqual([["c-steer-1", "steer"], ["c-queue-1", "queue"]]);
    await waitFor(() => ended(conv, 2), 60_000);
    const p = fold(await recsOf(conv), conv);
    expect(p.pending).toEqual([]);
    const users = p.items.filter((x) => x.kind === "user").map((x) => [x.id, x.via]);
    expect(users.slice(-3)).toEqual([["c-slow-1", "chat"], ["c-steer-1", "steer"], ["c-queue-1", "queue"]]);
    // Each of Carl's messages comes after a reply to the one before it (pi's order).
    const order = p.items.filter((x) => x.kind === "user" || x.kind === "assistant").map((x) => x.kind).slice(-6);
    expect(order).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("stop: the turn ends stopped, said once; a queued message pi never took is taken back", async () => {
    const h0 = await head();
    await intent({ type: "send", convId: conv, clientId: "c-slow-2", text: "[slow] A long one." });
    await waitFor(() => streaming(conv, h0), 15_000);
    await intent({ type: "queue", convId: conv, clientId: "c-queue-2", text: "Never delivered." });
    const r = await intent({ type: "stop", convId: conv });
    expect(r.ok).toBe(true);
    await waitFor(() => ended(conv, 3), 30_000);
    const recs = await recsOf(conv);
    const end = recs.filter((x) => x.type === "turn.ended").at(-1);
    expect(end.status).toBe("stopped");
    expect(recs.filter((x) => x.type === "pending.removed" && x.id === "c-queue-2").map((x) => x.reason)).toEqual(["stopped"]);
    const p = fold(recs, conv);
    expect(p.items.filter((x) => x.kind === "notice" && x.text === "Stopped.")).toHaveLength(1);
    expect(p.items.some((x) => x.id === "c-queue-2")).toBe(false);
    expect(p.items.every((x) => !["streaming", "running", "pending"].includes(x.status) || x.kind === "ask")).toBe(true);
  });

  it("AskUser: a question item, answered under the client's id; the turn goes on", async () => {
    or.script.push({ toolCall: { name: "AskUser", args: { question: "Apple or pear?", options: ["apple", "pear"] } } }, { text: "Pear it is." });
    await intent({ type: "send", convId: conv, clientId: "c-ask-1", text: "Pick a fruit with me." });
    await waitFor(async () => fold(await recsOf(conv), conv).items.some((x) => x.kind === "ask" && x.status === "pending"), 30_000);
    const a = await intent({ type: "answer", convId: conv, clientId: "c-ans-1", text: "pear" });
    expect(a.answered).toBe(true);
    await waitFor(() => ended(conv, 4), 30_000);
    const p = fold(await recsOf(conv), conv);
    const ask = p.items.find((x) => x.kind === "ask")!;
    expect(ask).toMatchObject({ status: "done", answer: "pear", question: "Apple or pear?", options: ["apple", "pear"] });
    const at = p.items.indexOf(ask);
    expect(p.items.slice(at + 1).find((x) => x.kind === "user")).toMatchObject({ id: "c-ans-1", via: "answer", text: "pear" });
    expect(p.items.filter((x) => x.kind === "assistant").at(-1)?.text).toBe("Pear it is.");
  });

  it("a restart in the middle of a turn: the log is intact, a client resumes from its cursor with no gap", async () => {
    const h0 = await head();
    await intent({ type: "send", convId: conv, clientId: "c-slow-3", text: "[slow] Keep talking while the box restarts." });
    await waitFor(() => streaming(conv, h0, 4), 20_000);
    const before = await all(0);
    const cursor = before.at(-1).seq;
    const epoch = (await get("/poll?after=latest")).epoch;
    // Killed mid-turn (no clean shutdown), then back.
    srv.proc.kill("SIGKILL");
    await srv.exited;
    srv = await startServer({ home, vault, secrets, openrouter: or.url });
    // Everything a client saw is still there, unchanged, in order.
    const again = await all(0);
    expect(again.slice(0, before.length)).toEqual(before);
    expect((await get("/poll?after=latest")).epoch).toBe(epoch);
    // The client that held `cursor` gets exactly what came after it: the cut, the resume.
    await waitFor(async () => (await all(cursor)).some((x) => x.conv === conv && x.type === "turn.ended" && x.status === "cut"), 20_000);
    const tail = await all(cursor);
    expect(tail.every((x) => x.seq > cursor)).toBe(true);
    const merged = [...before, ...tail];
    expect(new Set(merged.map((x) => x.seq)).size).toBe(merged.length);
    expect(merged.map((x) => x.seq)).toEqual((await all(0)).map((x) => x.seq).slice(0, merged.length));
    // The cut is said once, the turn resumed once.
    await waitFor(async () => {
      const p = fold(await recsOf(conv), conv);
      return p.turn === null && p.items.some((x) => x.kind === "wake" && x.wake === "resume") ? p : null;
    }, 60_000);
    const p = fold(await recsOf(conv), conv);
    expect(p.items.filter((x) => x.kind === "notice" && /Interrupted by a restart/.test(x.text ?? ""))).toHaveLength(1);
    expect(p.items.filter((x) => x.kind === "wake" && x.wake === "resume")).toHaveLength(1);
    // What streamed before the kill is still shown, closed (not lost, not streaming forever).
    const cut = p.items.filter((x) => x.kind === "assistant" && x.status === "stopped");
    expect(cut.length).toBeGreaterThan(0);
    expect(cut[0]!.text!.length).toBeGreaterThan(0);
  });
});
