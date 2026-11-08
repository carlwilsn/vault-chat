// The feed end to end: the real bundle running the real Claude Code, its model
// answered by the scripted stand-in API. The transcript is the runtime's session
// file in pi's format (the clients read it unchanged); what a client sees is
// the feed: /poll?after=N answers exactly the records after N at every N, a
// conversation's own records and its checkpoint are the same fold, a client's
// id comes back on its message, steer / queue / stop / answer are server
// operations mapped to pi's own, and a restart in the middle of a turn leaves
// the feed intact: a client resumes from its cursor with no gap, and what
// streamed before the kill is still shown.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { fold, pendingOf, rowFromPicture, shown, isOpen } from "../../src/convlog/reduce";
import { RETRY_TEXT, messagesOf } from "../../src/convlog/view";

let home: string, vault: string, secrets: string;
let or: FakeApi;
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
/** Turn ends after a cursor: the runtime may answer two queued messages with one
 * reply, so how many turns a conversation has had is not a clock a test can read. */
const endedSince = async (conv: string, since: number, n = 1) => (await recsOf(conv)).filter((x) => x.seq > since && isEnd(x)).length >= n;
const head = async () => (await get("/poll?after=latest")).next as number;
/** The reply of a turn started after `since` is streaming (pi's deltas in the feed). */
const streaming = async (conv: string, since: number, n = 1) => (await recsOf(conv)).filter((x) => x.seq > since && x.type === "live" && x.ev.assistantMessageEvent?.type === "text_delta").length >= n;

beforeAll(async () => {
  home = tmp("vclog-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
  or = await fakeAnthropic("Here is the answer.");
  srv = await startServer({ home, vault, secrets, anthropic: or.url });
});

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("the feed over HTTP", () => {
  let conv = "";

  it("a send: the client's id on Carl's message (the runtime's own entry), the reply streamed, then its entry", async () => {
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
    // The transcript is the session file: the pointers name it, its entries are the runtime's own.
    const file = userEntry.file as string;
    expect(readFileSync(file, "utf8")).toContain('"type":"session"');
    // The host's own turn context is not a message of Carl's and is never shown:
    // it goes to the model with the turn, and the transcript holds his words.
    const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.some((e) => e.type === "custom" && e.data?.kind === "context")).toBe(false);
    expect(entries.filter((e) => e.message?.role === "user").map((e) => e.message.content)).toEqual([
      [{ type: "text", text: "What is a KV cache?" }],
    ]);
    // The vault's memory reaches the session (Claude Code loads it from the
    // CLAUDE.md the host writes, so it is in the cached part of the context).
    expect(JSON.stringify(or.calls.at(-1))).toContain(".vault-chat/MEMORY.md");
    const feedOnDisk = readFileSync(join(vault, ".vault-chat", "events", `${conv}.jsonl`), "utf8");
    // (pi's live events for the message in flight are kept; the message itself is pi's entry, pointed to.)
    const pointers = feedOnDisk.trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === "entry");
    expect(pointers.length).toBeGreaterThan(1);
    // (The feed stores the path it will resolve — relative, for a transcript inside the vault.)
    const base = file.split(/[\\/]/).pop()!;
    expect(pointers.every((x) => !("entry" in x) && String(x.file).endsWith(base))).toBe(true);
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

  it("ordinary legacy steer intent and queue both wait for native follow-ups, in every client's order", async () => {
    const h0 = await head();
    const r = await intent({ type: "send", convId: conv, clientId: "c-slow-1", text: "[slow] Walk me through it." });
    expect(r.ok).toBe(true);
    await waitFor(() => streaming(conv, h0), 15_000);
    const s = await intent({ type: "steer", convId: conv, clientId: "c-steer-1", text: "Shorter, please." });
    expect(s.queued).toBe(true);
    const q = await intent({ type: "queue", convId: conv, clientId: "c-queue-1", text: "Then give an example." });
    expect(q.queued).toBe(true);
    // Pending in the feed until the runtime delivers them.
    const mid = fold(await recsOf(conv), conv);
    expect(pendingOf(mid).map((x) => [x.id, x.kind])).toEqual([["c-steer-1", "queue"], ["c-queue-1", "queue"]]);
    // Both delivered AND answered: nothing pending, both turns ended, and the
    // last thing in the chat is a reply — the entry for a message the runtime
    // has just taken lands before the reply to it, so a fold in between shows
    // his words last and says nothing about whether they were answered.
    const p = await waitFor(async () => {
      const fresh = fold(await recsOf(conv), conv);
      if (pendingOf(fresh).length || !(await endedSince(conv, h0, 2))) return null;
      const kinds = fresh.items.filter((x) => x.kind === "user" || x.kind === "assistant");
      return kinds.at(-1)?.kind === "assistant" ? fresh : null;
    }, 60_000);
    expect(pendingOf(p)).toEqual([]);
    // All three are there, in the order his clients sent them — whether the
    // runtime took the two he queued as two messages or as one.
    const said = p.items.filter((x) => x.kind === "user").map((x) => x.text ?? "").join("\n");
    expect(said.indexOf("Walk me through it")).toBeGreaterThanOrEqual(0);
    expect(said.indexOf("Walk me through it")).toBeLessThan(said.indexOf("Shorter, please."));
    expect(said.indexOf("Shorter, please.")).toBeLessThan(said.indexOf("Then give an example."));
    expect(p.items.filter((x) => x.kind === "user" && x.id === "c-slow-1")).toHaveLength(1);
    // Nothing of Carl's is dropped or re-ordered, and the turn he interrupted
    // still answered before his next words were taken: the runtime may take the
    // two he queued together and answer them with one reply, which is its own
    // business — what must hold is that each of his messages is there, in order,
    // and that a reply follows the last of them.
    const order = p.items.filter((x) => x.kind === "user" || x.kind === "assistant").map((x) => x.kind);
    expect(order.at(-1)).toBe("assistant");
    expect(order.lastIndexOf("user")).toBeLessThan(order.length - 1);
  });

  it("stop: the turn ends, said once; a queued message the runtime never took is no longer pending and never shown", async () => {
    const h0 = await head();
    await intent({ type: "send", convId: conv, clientId: "c-slow-2", text: "[slow] A long one." });
    await waitFor(() => streaming(conv, h0), 15_000);
    await intent({ type: "queue", convId: conv, clientId: "c-queue-2", text: "Never delivered." });
    // Pending until the runtime takes it (claudeSession.test.ts pins that on the
    // session itself); here what matters is what the stop does with it.
    expect(pendingOf(fold(await recsOf(conv), conv)).map((x) => x.id)).toEqual(["c-queue-2"]);
    const r = await intent({ type: "stop", convId: conv });
    expect(r.ok).toBe(true);
    // The engine ends the turn (running: null) and only then writes the line that says why (after what the end
    // closed): under load a fold right after the end can come before "Stopped.". Wait for both.
    const stopped = (p: ReturnType<typeof fold>) => p.items.filter((x) => x.kind === "notice" && x.text === "Stopped.");
    await waitFor(async () => (await endedSince(conv, h0)) && stopped(fold(await recsOf(conv), conv)).length > 0, 30_000);
    const p = fold(await recsOf(conv), conv);
    expect(pendingOf(p)).toEqual([]);
    expect(stopped(p)).toHaveLength(1);
    expect(p.items.some((x) => x.id === "c-queue-2")).toBe(false);
    expect(shown(p).some(isOpen)).toBe(false);
  });

  it("AskUser: the question waits; the answer is Carl's line under his client's id; the turn goes on", async () => {
    const h0 = await head();
    or.script.push({ toolCall: { name: "AskUser", args: { question: "Apple or pear?", options: ["apple", "pear"] } } }, { text: "Pear it is." });
    await intent({ type: "send", convId: conv, clientId: "c-ask-1", text: "Pick a fruit with me." });
    await waitFor(async () => !!fold(await recsOf(conv), conv).meta.asking, 30_000);
    const asking = fold(await recsOf(conv), conv).meta.asking!;
    expect(asking).toMatchObject({ question: "Apple or pear?", options: ["apple", "pear"] });
    const a = await intent({ type: "answer", convId: conv, clientId: "c-ans-1", text: "pear" });
    expect(a.answered).toBe(true);
    await waitFor(() => endedSince(conv, h0), 30_000);
    const p = fold(await recsOf(conv), conv);
    expect(p.meta.asking).toBeUndefined();
    const ask = p.items.find((x) => x.kind === "tool" && x.name === "AskUser")!;
    expect(ask).toMatchObject({ status: "done", result: "Carl answered: pear" });
    const at = p.items.indexOf(ask);
    expect(p.items.slice(at + 1).find((x) => x.kind === "user")).toMatchObject({ id: "c-ans-1", via: "answer", text: "pear" });
    expect(p.items.filter((x) => x.kind === "assistant").at(-1)?.text).toBe("Pear it is.");
  });

  it("a dropped connection the runtime recovers from: the reply arrives and nothing of the failure is shown", async () => {
    const since = await head();
    // The endpoint closes the connection once (the box used to report this as
    // "Connection error."), then answers. Claude Code retries it itself.
    or.script.push({ drop: true }, { text: "Recovered answer." });
    await intent({ type: "send", convId: conv, clientId: "c-drop-1", text: "Explain attention briefly." });
    await waitFor(() => endedSince(conv, since), 60_000);
    const recs = await recsOf(conv);
    // Recovered: the reply, and nothing about the failure — no red line, and no
    // line saying it is retrying, because by the time Carl could read one it is
    // over. A blip must never put a failure in front of him.
    const after = messagesOf(fold(recs, conv));
    const mine = after.slice(after.findIndex((m) => m.mid === "c-drop-1"));
    expect(mine.map((m) => [m.role, m.content, !!m.failed])).toEqual([
      ["user", "Explain attention briefly.", false],
      ["assistant", "Recovered answer.", false],
    ]);
    expect(after.some((m) => /Connection error|Retrying/.test(m.content))).toBe(false);
    expect(after.filter((m) => m.failed)).toEqual([]);
  }, 90_000);

  it("a request that fails for good: one red line, said once, with Try again; Try again runs a turn that continues", async () => {
    const since = await head();
    // A failure the runtime does not retry (it retries a dropped connection for
    // as long as it takes, which is why that is not what this asks).
    or.respond = () => ({ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Connection error." } }) });
    await intent({ type: "send", convId: conv, clientId: "c-drop-2", text: "And multi-head attention?" });
    await waitFor(() => endedSince(conv, since), 60_000);
    let msgs = messagesOf(fold(await recsOf(conv), conv));
    const failed = msgs.filter((m) => m.failed);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ system: true, retry: true });
    expect(failed[0]!.content).toMatch(/^Couldn't get a reply/);
    expect(msgs.at(-1)).toBe(failed[0]);
    expect(msgs.some((m) => /Retrying/.test(m.content))).toBe(false);
    // Try again (what the laptop's and the phone's button send).
    const since2 = await head();
    or.respond = null;
    or.script.push({ text: "Multi-head attention runs several attentions in parallel." });
    const r = await intent({ type: "send", convId: conv, clientId: "c-retry-1", text: RETRY_TEXT, via: "retry" });
    expect(r.ok).toBe(true);
    await waitFor(() => endedSince(conv, since2), 60_000);
    msgs = messagesOf(fold(await recsOf(conv), conv));
    const at = msgs.findIndex((m) => m.failed);
    expect(msgs[at]!.retry).toBeUndefined();
    expect(msgs.slice(at + 1).map((m) => [m.role, m.content, !!m.system])).toEqual([
      ["user", "↻ Trying again", true],
      ["assistant", "Multi-head attention runs several attentions in parallel.", false],
    ]);
  }, 120_000);

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
    srv = await startServer({ home, vault, secrets, anthropic: or.url });
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
