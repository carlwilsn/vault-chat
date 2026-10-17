// Box-mode chat against a fake box whose conversations are the REAL event log
// (test/harness/fakeBox.ts → server/convlog/log.ts). The laptop sends intents
// only; what it shows is the fold of the log (the one reducer) plus its own
// messages on their way, confirmed in place by id. It never writes a
// conversation, never runs a model, and after any outage or box restart its
// picture is exactly the box's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-boxchat-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}

fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
const writes: string[] = [];
fake.setHandler("conversations_write_all", () => void writes.push("write"));
fake.setHandler("conversation_delete", () => void writes.push("delete"));

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const { makeChatView } = await import("../../src/convlog/view.ts");

const S = () => useStore.getState();
const shown = () => S().messages.map((m) => [m.role, m.content]);
/** What the box's fold shows for a conversation (the laptop must equal it). */
const boxShows = (id: string) => (makeChatView()(box.picture(id), { split: false }).messages as any[]).map((m) => [m.role, m.content]);

before(async () => {
  await box.start();
  // An older chat the box already has.
  box.create("old1", "earlier", Date.now() - 60_000);
  box.startTurn("old1");
  box.emit("old1", { type: "item.started", item: { id: "u-old", kind: "user", status: "done", text: "earlier question", at: 0 } });
  box.stream("old1", "assistant", "earlier answer");
  box.tool("old1", "t1", "Read", { path: "a.md" });
  box.toolDone("old1", "t1", "x");
  box.endTurn("old1");
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("the list and an older chat come from the log: in its order, the tool calls folded", async () => {
  await waitFor("listed", () => S().conversations.some((c) => c.id === "old1"));
  S().selectConversation("old1");
  await waitFor("opened", () => S().messages.length === 3);
  assert.deepEqual(shown(), [
    ["user", "earlier question"],
    ["assistant", "earlier answer"],
    ["assistant", ""],
  ]);
  assert.deepEqual(S().messages[2]!.toolCalls?.map((t) => [t.name, t.result]), [["Read", "x"]]);
  assert.deepEqual(shown(), boxShows("old1"));
});

let c1 = "";
test("a send: shown at once under the client's id, confirmed in place by the box's echo; the reply streams, then lands", async () => {
  c1 = S().newConversation();
  box.pollDelay = 400; // the echo comes late: the message must never blink
  const frames: string[][] = [];
  const unsub = useStore.subscribe((s) => frames.push(s.messages.map((m) => m.content)));
  const p = chat.sendMessage("hello box");
  // At once, before the box has answered anything.
  await waitFor("optimistic", () => S().messages.some((m) => m.content === "hello box"));
  const mine = S().messages.find((m) => m.content === "hello box")!;
  assert.equal(mine.boxPending, true);
  await p;
  const sent = box.intents.at(-1)!;
  assert.equal(sent.type, "send");
  assert.equal(sent.convId, c1, "the client's own id for a new chat");
  assert.equal(sent.clientId, mine.mid);
  await waitFor("echo", () => S().messages.some((m) => m.mid === mine.mid && !m.boxPending));
  box.pollDelay = 0;
  unsub();
  const firstShown = frames.findIndex((f) => f.includes("hello box"));
  assert.ok(firstShown >= 0);
  assert.ok(frames.slice(firstShown).every((f) => f.filter((x) => x === "hello box").length === 1), "from the first frame on: never gone, never doubled");
  assert.equal(S().busy, true);
  // The reply streams in the live view, then is a message in the same update the stream empties.
  const s = box.open(c1, "assistant");
  s.delta("Hi ");
  await waitFor("streaming", () => S().streamingText === "Hi ");
  s.delta("Carl");
  await waitFor("streaming 2", () => S().streamingText === "Hi Carl");
  s.end();
  box.endTurn(c1);
  await waitFor("landed", () => !S().busy && S().messages.at(-1)?.content === "Hi Carl");
  assert.equal(S().streamingText, "");
  assert.deepEqual(shown(), boxShows(c1));
  assert.deepEqual(writes, [], "the laptop never writes a conversation");
});

test("the same message twice (a retry) is one message", async () => {
  const before = box.records(c1).length;
  const r = await fetch(`${box.url}/api/v2/intent?vault=v`, { method: "POST", body: JSON.stringify({ type: "send", convId: c1, clientId: box.intents.at(-1)!.clientId, text: "hello box" }) });
  assert.equal((await r.json()).duplicate, true);
  assert.equal(box.records(c1).length, before);
});

test("Enter while it runs steers, Tab queues: chips until the log has them, then Carl's message where pi delivers it", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("Go through the chapters.");
  await waitFor("running", () => S().busy);
  await chat.sendMidTurn("steer", "shorter please");
  await chat.sendMidTurn("queue", "then a summary");
  const [steer, queue] = box.intents.slice(-2);
  assert.deepEqual([steer.type, queue.type], ["steer", "queue"]);
  await waitFor("pending on the box", () => (S().conversations.find((c) => c.id === c1)?.queued ?? []).length === 2);
  assert.deepEqual(S().conversations.find((c) => c.id === c1)!.queued!.map((q) => [q.kind, q.text]), [["steer", "shorter please"], ["queue", "then a summary"]]);
  const pend = await import("../../src/pendingInput.ts");
  await waitFor("local chips gone (the log's chips show)", () => pend.pendingFor(c1).length === 0);
  // pi delivers the steer after the current step.
  box.stream(c1, "assistant", "Chapter one.");
  box.deliver(c1, steer.clientId);
  await waitFor("steer in place", () => S().messages.some((m) => m.mid === steer.clientId));
  const at = S().messages.findIndex((m) => m.mid === steer.clientId);
  assert.equal(S().messages[at - 1]!.content, "Chapter one.");
  // Taken back before delivery.
  assert.equal(await bc.boxUnqueue(c1, queue.clientId), true);
  await waitFor("taken back", () => (S().conversations.find((c) => c.id === c1)?.queued ?? []).length === 0);
  box.stream(c1, "assistant", "Short.");
  box.endTurn(c1);
  await waitFor("idle", () => !S().busy);
  assert.deepEqual(shown(), boxShows(c1));
  assert.ok(!S().messages.some((m) => m.content === "then a summary"));
});

test("Stop is the box's: its line in the log, nothing claimed here before it", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("a long job");
  await waitFor("running", () => S().busy);
  chat.stopAgent();
  await waitFor("stopped", () => !S().busy && S().messages.at(-1)?.content === "Stopped.");
  assert.equal(box.intents.at(-1)!.type, "stop");
  assert.deepEqual(shown(), boxShows(c1));
});

test("an open question: the next message is the answer (a decision), under the client's id", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("pick a fruit");
  await waitFor("running", () => S().busy);
  box.ask(c1, "Apple or pear?", ["apple", "pear"]);
  await waitFor("asking", () => !!S().conversations.find((c) => c.id === c1)?.pendingAsk);
  assert.equal(S().busy, false, "waiting on Carl is not 'running'");
  await chat.sendMessage("pear");
  const a = box.intents.at(-1)!;
  assert.equal(a.type, "answer");
  await waitFor("answer", () => S().messages.some((m) => m.mid === a.clientId && m.decision));
  box.stream(c1, "assistant", "Pear it is.");
  box.endTurn(c1);
  await waitFor("done", () => !S().busy && S().messages.at(-1)?.content === "Pear it is.");
  assert.deepEqual(shown(), boxShows(c1));
});

test("the box goes away mid-turn and comes back: exactly what was missed arrives, nothing re-fetched whole", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("keep going while I'm away");
  await waitFor("running", () => S().busy);
  const s = box.open(c1, "assistant");
  s.delta("part one, ");
  await waitFor("streamed", () => S().streamingText === "part one, ");
  box.down = true;
  await waitFor("unreachable", () => S().boxChat?.reachable === false, 15_000);
  // While it is away the turn goes on.
  s.delta("part two.");
  s.end();
  box.endTurn(c1);
  const listsBefore = box.seen.filter((x) => x.route === "GET /api/v2/conversations").length;
  box.down = false;
  bc._boxChatSession()!.kick();
  await waitFor("caught up", () => !S().busy && S().messages.at(-1)?.content === "part one, part two.", 15_000);
  assert.equal(box.seen.filter((x) => x.route === "GET /api/v2/conversations").length, listsBefore, "the cursor resumed: no resync");
  assert.deepEqual(shown(), boxShows(c1));
});

test("a send while the box is unreachable is never lost silently: said NOT sent", async () => {
  box.down = true;
  await waitFor("unreachable", () => S().boxChat?.reachable === false, 15_000);
  await chat.sendMessage("are you there?");
  // Carl's message stays, marked not sent (never dropped silently).
  assert.ok(S().messages.some((m) => m.boxLocal && m.role === "user" && m.content === "are you there?"));
  assert.ok(S().messages.some((m) => m.boxLocal && /NOT sent/.test(m.content)));
  box.down = false;
  bc._boxChatSession()!.kick();
  await waitFor("back", () => S().boxChat?.reachable === true, 15_000);
});

test("the box restarts (a new process on the same log): the client goes on from its cursor", async () => {
  box.restart();
  const lists = box.seen.filter((x) => x.route === "GET /api/v2/conversations").length;
  S().selectConversation(c1);
  await chat.sendMessage("after the restart");
  await waitFor("echo", () => S().messages.some((m) => m.content === "after the restart" && !m.boxPending));
  box.stream(c1, "assistant", "Still here.");
  box.endTurn(c1);
  await waitFor("reply", () => S().messages.at(-1)?.content === "Still here.");
  assert.equal(box.seen.filter((x) => x.route === "GET /api/v2/conversations").length, lists, "same log (epoch): no resync");
  assert.deepEqual(shown().filter((m) => !/NOT sent|are you there/.test(String(m[1]))), boxShows(c1));
});

test("Ctrl+K into the chat in box mode: the box writes the lines (an intent), shown at once", async () => {
  S().selectConversation(c1);
  assert.equal(await bc.boxLines([{ role: "user", text: "ctx", hidden: true }, { role: "user", text: "what is mAP50?" }, { role: "assistant", text: "mean average precision" }]), true);
  assert.equal(box.intents.at(-1)!.type, "lines");
  await waitFor("lines", () => S().messages.at(-1)?.content === "mean average precision" && !S().messages.at(-1)?.boxPending);
  assert.deepEqual(writes, []);
});

test("every request names the vault", () => {
  assert.ok(box.seen.length > 10);
  assert.ok(box.seen.every((x) => x.vault === "v"), JSON.stringify(box.seen.filter((x) => x.vault !== "v").slice(0, 3)));
});

test("a delete is an intent: gone from the list here and in the log", async () => {
  await S().deleteConversation("old1");
  assert.equal(box.intents.at(-1)!.type, "delete");
  await waitFor("gone", () => !S().conversations.some((c) => c.id === "old1"));
  assert.equal(box.picture("old1").meta.deleted, true);
  assert.deepEqual(writes, []);
});
