// Box-mode chat against a fake box whose conversations are the REAL event log
// (test/harness/fakeBox.ts → server/convlog/log.ts). The laptop sends intents
// only; what it shows is the fold of the log (the one reducer) plus its own
// messages on their way, confirmed in place by id. It never writes a
// conversation, never runs a model, and after any outage or box restart its
// picture is exactly the box's.
import { test, before, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
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
  box.user("old1", "u-old", "earlier question");
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
  const release = box.holdPolls();
  const frames: string[][] = [];
  const unsub = useStore.subscribe((s) => frames.push(s.messages.map((m) => m.content)));
  try {
    const p = chat.sendMessage("hello box");
    // The box accepts the POST while ALL poll responses (even an already-waiting
    // poll) are held. HTTP acknowledgement is not the authoritative log echo.
    await waitFor("optimistic", () => S().messages.some((m) => m.content === "hello box"));
    const mine = S().messages.find((m) => m.content === "hello box")!;
    assert.equal(mine.boxPending, true);
    await p;
    const sent = box.intents.at(-1)!;
    assert.equal(sent.type, "send");
    assert.equal(sent.convId, c1, "the client's own id for a new chat");
    assert.equal(sent.clientId, mine.mid);
    assert.ok(boxShows(c1).some(([role, text]) => role === "user" && text === "hello box"), "the authoritative echo already exists on the box");
    assert.equal(S().messages.find((m) => m.mid === mine.mid)?.boxPending, true, "POST accepted, but still pending until its log echo arrives");
    release();
    await waitFor("echo", () => S().messages.some((m) => m.mid === mine.mid && !m.boxPending));
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
  } finally {
    release();
    unsub();
    if (box.picture(c1).meta.running) box.endTurn(c1);
  }
});

test("the same message twice (a retry) is one message", async () => {
  const before = box.records(c1).length;
  const r = await fetch(`${box.url}/api/v2/intent?vault=v`, { method: "POST", body: JSON.stringify({ type: "send", convId: c1, clientId: box.intents.at(-1)!.clientId, text: "hello box" }) });
  assert.equal((await r.json()).duplicate, true);
  assert.equal(box.records(c1).length, before);
});

const waitingOf = () => S().messages.filter((m) => m.waiting).map((m) => m.content);

test("a message while it runs goes in at once (Claude Code): shown as sent, marked waiting until pi takes it at the next step, then the log's message where pi put it", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("Go through the chapters.");
  await waitFor("running", () => S().busy);
  const p = chat.sendMessage("shorter please");
  // At once, in the thread (no chip above the composer), before the box answered.
  await waitFor("shown as sent", () => S().messages.at(-1)?.content === "shorter please");
  assert.equal(S().messages.at(-1)!.waiting, true);
  await p;
  const steer = box.intents.at(-1)!;
  assert.equal(steer.type, "steer", "pi's steer: in at the agent's next step");
  await waitFor("pending on the box", () => (S().conversations.find((c) => c.id === c1)?.queued ?? []).length === 1);
  await chat.sendMessage("then a summary");
  const second = box.intents.at(-1)!;
  assert.equal(second.type, "steer");
  assert.deepEqual(waitingOf(), ["shorter please", "then a summary"], "each shown once, in order, waiting");
  // pi takes the first after the current step: it is the log's message there, not waiting any more.
  box.stream(c1, "assistant", "Chapter one.");
  box.deliver(c1, steer.clientId);
  await waitFor("delivered in place", () => S().messages.some((m) => m.mid === steer.clientId && !m.waiting && !m.boxPending));
  const at = S().messages.findIndex((m) => m.mid === steer.clientId);
  assert.equal(S().messages[at - 1]!.content, "Chapter one.");
  assert.equal(S().messages.filter((m) => m.content === "shorter please").length, 1, "never doubled");
  assert.deepEqual(waitingOf(), ["then a summary"]);
  // Cancel (or Edit) on the bubble takes it back before pi reads it.
  assert.equal(await chat.takeBack(c1, second.clientId), true);
  await waitFor("taken back", () => !S().messages.some((m) => m.content === "then a summary"));
  box.stream(c1, "assistant", "Short.");
  box.endTurn(c1);
  await waitFor("idle", () => !S().busy);
  assert.deepEqual(shown(), boxShows(c1));
});

test("Send now on a waiting message: the box cuts the step and the message starts the next turn at once (no Stopped line)", async () => {
  S().selectConversation(c1);
  await chat.sendMessage("Read all the chapters.");
  await waitFor("running", () => S().busy);
  box.stream(c1, "assistant", "Reading chapter one…");
  await chat.sendMessage("actually just chapter two");
  const m = box.intents.at(-1)!;
  await waitFor("waiting", () => waitingOf().includes("actually just chapter two") && (S().conversations.find((c) => c.id === c1)?.queued ?? []).length === 1);
  assert.equal(await chat.sendNow(c1, m.clientId), true);
  assert.deepEqual([box.intents.at(-1)!.type, box.intents.at(-1)!.id], ["now", m.clientId]);
  await waitFor("delivered as the next turn", () => S().messages.some((x) => x.mid === m.clientId && !x.waiting && !x.boxPending));
  assert.equal(S().busy, true, "the agent goes on, now answering it");
  assert.ok(!S().messages.some((x) => x.content === "Stopped."), "Send now is not a Stop");
  box.stream(c1, "assistant", "Chapter two only.");
  box.endTurn(c1);
  await waitFor("idle", () => !S().busy);
  assert.deepEqual(shown(), boxShows(c1));
});

test("a waiting message from another surface shows the same way; a Stop that drops a waiting message says so (never silently lost)", async () => {
  // Its own chat: the line it leaves is this laptop's own (the box's log has no such line).
  const c1 = S().newConversation();
  await chat.sendMessage("Long job.");
  await waitFor("running", () => S().busy);
  const r = await fetch(`${box.url}/api/v2/intent?vault=v`, { method: "POST", body: JSON.stringify({ type: "steer", convId: c1, clientId: "phone-1", text: "from my phone" }) });
  assert.equal((await r.json()).steered, true);
  await waitFor("the phone's message, waiting", () => waitingOf().includes("from my phone"));
  await chat.sendMessage("and from the laptop");
  await waitFor("both waiting", () => waitingOf().length === 2);
  chat.stopAgent();
  await waitFor("stopped", () => !S().busy && S().messages.some((x) => x.content === "Stopped."));
  await waitFor("dropped, said", () => S().messages.some((x) => /Not delivered: the turn was stopped/.test(x.content)), 8000);
  assert.ok(S().messages.some((x) => x.content === "and from the laptop" && x.boxLocal), "the text stays, marked not delivered");
  assert.ok(!S().messages.some((x) => x.waiting), "nothing still claims to be waiting");
});

test("an attached file from outside the vault (a PDF from Downloads): its bytes go to the box with the message; the agent gets the box's path, never this laptop's", async () => {
  const af = await import("../../src/attachFiles.ts");
  // A dropped / picked file outside the vault; the composer reads it when attached.
  const pdf = new Blob([Buffer.from("%PDF-1.4\n% Discussion 5 notes\n")]);
  const got = await af.attachBlob("Discussion_5_Supplementary Notes.pdf", pdf);
  assert.ok(got.ok);
  // An @ of a path on this laptop, typed or pasted, is found (quoted when it has spaces).
  const typed = 'read @"C:\\Users\\wada2\\Downloads\\Discussion_5_Supplementary Notes.pdf" please';
  assert.deepEqual(af.pathMentions(typed).map((x) => x.path), ["C:\\Users\\wada2\\Downloads\\Discussion_5_Supplementary Notes.pdf"]);
  assert.equal(af.insideVault("C:/Users/wada2/Downloads/x.pdf", "C:/Users/wada2/github/school2"), false);
  assert.equal(af.insideVault("c:/users/wada2/github/school2/Physics/x.pdf", "C:/Users/wada2/github/school2"), true);
  // Too big: refused when attached, with the reason.
  const big = await af.attachBlob("huge.pdf", new Blob([new Uint8Array(26 * 1024 * 1024)]));
  assert.ok(!big.ok && /at most 25 MB/.test(big.error));
  const c1 = S().newConversation();
  if (!got.ok) throw new Error("not attached");
  await chat.sendMessage("summarise this\n\n[files: Discussion_5_Supplementary Notes.pdf]", undefined, undefined, undefined, [got.file]);
  const sent = box.intents.at(-1)!;
  assert.equal(sent.type, "send");
  assert.equal(sent.files.length, 1);
  assert.match(sent.files[0], /^\.vault-chat\/attachments\/\d{4}-\d{2}-\d{2}\/Discussion_5_Supplementary Notes\.pdf$/);
  const onBox = fs.readFileSync(path.join(box.attachVault, ...sent.files[0].split("/")), "utf8");
  assert.match(onBox, /Discussion 5 notes/, "the bytes are on the box");
  assert.ok(!JSON.stringify(sent).includes("Downloads"), "no path on this laptop goes to the box");
  assert.ok(S().messages.some((m) => m.mid === sent.clientId));
  box.endTurn(c1);
  await waitFor("idle", () => !S().busy);
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

test("a rename is an intent: the new title in the list here and in the log, marked as Carl's", async () => {
  const { renameChat } = await import("../../src/chatDelete.ts");
  assert.equal(await renameChat("old1", "  Renamed   by Carl "), null);
  assert.equal(box.intents.at(-1)!.type, "renameConversation");
  await waitFor("renamed", () => S().conversations.some((c) => c.id === "old1" && c.title === "Renamed by Carl"));
  assert.equal(box.picture("old1").meta.titleBy, "carl");
  assert.equal(await renameChat("main", "x"), "Main keeps its name");
  assert.deepEqual(writes, []);
});

test("a delete is an intent: gone from the list here and in the log", async () => {
  await S().deleteConversation("old1");
  assert.equal(box.intents.at(-1)!.type, "delete");
  await waitFor("gone", () => !S().conversations.some((c) => c.id === "old1"));
  assert.equal(box.picture("old1").meta.deleted, true);
  assert.deepEqual(writes, []);
});


test("cache waits for feed quiescence, keeps its exact old cursor, and cancels on stop", async () => {
  const key = `box:${box.url}`;
  await waitFor("first warm snapshot", () => bc.readBoxCache(key) !== null);
  const first = bc.readBoxCache(key)!;
  const original = localStorage.getItem("vault-chat:box-log:" + key);
  // Longer than two old throttle intervals, with genuine records on the feed.
  for (let n = 0; n < 5; n++) {
    box.emit(c1, { type: "meta", patch: { title: `cache burst ${n}` } });
    await waitFor("progress projected", () => S().conversations.some(c => c.id === c1 && c.title === `cache burst ${n}`));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(localStorage.getItem("vault-chat:box-log:" + key), original, "no recurring full-history serialization/write during progress");
  }
  await waitFor("quiet snapshot", () => (bc.readBoxCache(key)?.cursor ?? 0) > first.cursor);
  const quiet = bc.readBoxCache(key)!;
  assert.equal(quiet.epoch, first.epoch);
  assert.equal(quiet.rows.find(r => r.id === c1)?.title, "cache burst 4");
  assert.deepEqual(quiet.pictures.find(p => p.id === c1), JSON.parse(JSON.stringify(box.picture(c1))), "whole picture, not a truncated prefix with a current cursor");
  // Reopen the exact older snapshot while offline; reconnect must replay the
  // tail from THAT cursor, not claim the new one without its records.
  bc.stopBoxChat();
  localStorage.setItem("vault-chat:box-log:" + key, original!);
  box.down = true;
  await bc.startBoxChat(vault);
  assert.equal(bc._boxChatSession()!.picture(c1)?.seq, first.pictures.find(p => p.id === c1)?.seq);
  assert.deepEqual(bc.readBoxCache(key), first);
  box.down = false;
  bc._boxChatSession()!.kick();
  await waitFor("old cursor caught up", () => S().conversations.some(c => c.id === c1 && c.title === "cache burst 4"));
  assert.deepEqual(JSON.parse(JSON.stringify(bc._boxChatSession()!.picture(c1))), JSON.parse(JSON.stringify(box.picture(c1))));
  const beforeStop = localStorage.getItem("vault-chat:box-log:" + key);
  bc.stopBoxChat();
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(localStorage.getItem("vault-chat:box-log:" + key), beforeStop, "a stopped session cannot write a pending snapshot");
});

test("cache quota failure is attempted once per connection, never changes the live history or old offline cursor", async () => {
  const key = "vault-chat:box-log:box:" + box.url;
  const old = localStorage.getItem(key);
  const setItem = localStorage.setItem;
  let attempts = 0;
  localStorage.setItem = (k, v) => {
    if (k === key) { attempts++; throw new DOMException("owned quota fixture", "QuotaExceededError"); }
    setItem(k, v);
  };
  try {
    await bc.startBoxChat(vault);
    await waitFor("first failed cache write", () => attempts === 1);
    for (let n = 0; n < 2; n++) {
      box.emit(c1, { type: "meta", patch: { title: `after quota ${n}` } });
      await waitFor("live progress after quota", () => S().conversations.some(c => c.id === c1 && c.title === `after quota ${n}`));
      await new Promise(r => setTimeout(r, 1700));
    }
    assert.equal(attempts, 1, "no repeated serialization/storage after quota failure");
    assert.equal(localStorage.getItem(key), old, "previous offline snapshot and exact cursor survive");
    assert.deepEqual(JSON.parse(JSON.stringify(bc._boxChatSession()!.picture(c1))), JSON.parse(JSON.stringify(box.picture(c1))));
  } finally {
    localStorage.setItem = setItem;
    bc.stopBoxChat();
  }
});
