// One main conversation on the laptop (src/threads.ts): the left panel's structure (the same
// model on the laptop overlay, the fullscreen sidebar, the popout and the phone), Main as the
// default the app opens on, older chats read-only, and Clear: this surface's view blank on the very
// next frame (no divider, nothing to scroll back into), nothing sent to the box, kept on this device.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-main-");
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

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const threads = await import("../../src/threads.ts");
const S = () => useStore.getState();

before(async () => {
  await box.start();
  // The box at start: Main (kind main), a project's thread, and an older chat from before (no kind).
  box.create("main", "Main", Date.now() - 50_000);
  box.emit("main", { type: "meta", patch: { kind: "main", source: "main" } });
  box.startTurn("main");
  box.user("main", "u-m1", "the earlier topic, CLEARED-TEXT");
  box.stream("main", "assistant", "an answer about it");
  box.endTurn("main");
  box.create("project-coconut", "Coconut", Date.now() - 40_000);
  box.emit("project-coconut", { type: "meta", patch: { kind: "project", source: "project", project: "coconut" } });
  box.create("old1", "an older chat", Date.now() - 90_000);
  box.startTurn("old1");
  box.user("old1", "u-o1", "something from last week");
  box.endTurn("old1");
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("the panel: each place holds its chats, newest first; older chats stay in the menu", () => {
  const { entries, others } = threads.panelModel(
    [
      { id: "main", kind: "main", lastActivityAt: 5 },
      { id: "project-psych-221", kind: "project", lastActivityAt: 9, running: true },
      { id: "sep-1", kind: "separate", title: "a one-off", lastActivityAt: 7 },
      { id: "sep-2", kind: "separate", project: "psych-221", title: "problem set 4", lastActivityAt: 11 },
      { id: "sep-3", kind: "separate", project: "psych-221", lastActivityAt: 2 },
      { id: "old1", title: "older", lastActivityAt: 3 },
      { id: "old2", title: "gone", lastActivityAt: 8, deleted: true },
    ],
    [
      { slug: "psych-221", name: "Psych 221" },
      { slug: "coconut", name: "Coconut" },
    ],
    "project-psych-221",
  );
  assert.deepEqual(
    entries.map((e) => (e.type === "new-project" ? ["new-project"] : [e.type, e.id, e.title, e.active, e.running])),
    [
      ["main", "main", "Main", false, false],
      ["project", "project-coconut", "Coconut", false, false],
      ["project", "project-psych-221", "Psych 221", true, true],
      ["new-project"],
    ],
  );
  // Each place holds its own chats, newest first.
  const chatsOf = (id: string) => {
    const e = entries.find((x) => x.type !== "new-project" && x.id === id)!;
    return e.type === "new-project" ? [] : e.chats.map((c) => [c.id, c.title, c.active]);
  };
  assert.deepEqual(chatsOf("main"), [
    ["sep-1", "a one-off", false],
  ]);
  // Main's own thread is not listed (it cannot be deleted); the place still shows when Main is where he is / works.
  const onMain = threads.panelModel([{ id: "main", kind: "main", running: true }], [], "main").entries[0];
  assert.deepEqual([onMain.type === "main" && onMain.chats.length, onMain.type !== "new-project" && onMain.active, onMain.type !== "new-project" && onMain.running], [0, true, true]);
  for (const e of entries) if (e.type !== "new-project") assert.ok(e.chats.every((c) => !(c.id === "main" || c.id.startsWith("project-"))), "no undeletable thread row in " + e.id);
  // A project's own thread is not listed among its chats (it still opens, and its running/active show on the bar).
  assert.deepEqual(chatsOf("project-psych-221"), [
    ["sep-2", "problem set 4", false],
    ["sep-3", "New chat", false],
  ]);
  assert.deepEqual(chatsOf("project-coconut"), []);
  // A place is "active" when the chat Carl is in is one of its own.
  assert.equal(entries.find((e) => e.type === "project" && e.id === "project-psych-221")!.active, true);
  // Only the chats from before this model are in the menu, newest first.
  assert.deepEqual(others.map((o) => o.id), ["old1"]);
  assert.equal(threads.threadKindOf({ id: "old1" }), "older");
  assert.equal(threads.isOlderChat({ id: "x", kind: "separate" }), false);
  assert.equal(threads.projectOfThread("project-psych-221"), "psych-221");
  assert.equal(threads.projectOfThread("project-../x"), null);
  // Where a new chat belongs, and where a conversation already belongs.
  assert.equal(threads.placeThreadId({ slug: "psych-221" }), "project-psych-221");
  assert.equal(threads.placeThreadId(null), "main");
  assert.equal(threads.placeOf({ id: "sep-2", project: "psych-221" }), "psych-221");
  assert.equal(threads.placeOf({ id: "project-coconut" }), "coconut");
  assert.equal(threads.placeOf({ id: "sep-1" }), null);
});

test("the app opens on Main; a message with nothing chosen goes to Main", async () => {
  assert.equal(S().activeConversationId, "main");
  await waitFor("Main's thread", () => S().messages.some((m) => m.content.includes("CLEARED-TEXT")));
  await chat.sendMessage("hello Main");
  const sent = box.intents.at(-1)!;
  assert.equal(sent.type, "send");
  assert.equal(sent.convId, "main");
  await waitFor("echo", () => S().messages.some((m) => m.content === "hello Main" && !m.boxPending));
  box.stream("main", "assistant", "hi");
  box.endTurn("main");
  await waitFor("idle", () => !S().busy);
  // The kinds reach the list.
  assert.equal(S().conversations.find((c) => c.id === "main")?.kind, "main");
  assert.equal(S().conversations.find((c) => c.id === "project-coconut")?.kind, "project");
  assert.equal(S().conversations.find((c) => c.id === "old1")?.kind, undefined);
});

test("New chat: a fresh conversation in this place, and the one he was in is still there", async () => {
  const intents0 = box.intents.length;
  // Nothing is wiped and nothing is sent: the chat he was in keeps every word,
  // and the new one is simply the one he is in now.
  const was = S().activeConversationId;
  const id = chat.newChatHere();
  await waitFor("the new chat is open", () => S().activeConversationId === id && S().messages.length === 0, 300);
  assert.notEqual(id, was);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(box.intents.length, intents0, "nothing went to the box");
  assert.ok(box.picture("main").items.some((x: any) => String(x.text ?? "").includes("CLEARED-TEXT")), "the conversation he left still has it");
  assert.equal(S().conversations.find((c) => c.id === id)?.kind, "separate");
  // His first message in it starts it, and only it is shown.
  await chat.sendMessage("a fresh start");
  await waitFor("fresh", () => S().messages.some((m) => m.content === "a fresh start" && !m.boxPending));
  assert.equal(box.intents.at(-1)!.convId, id);
  box.stream(id, "assistant", "ok");
  box.endTurn(id);
  await waitFor("reply", () => S().messages.some((m) => m.content === "ok"));
  assert.deepEqual(S().messages.map((m) => m.content), ["a fresh start", "ok"]);
  // And the one he left opens again, whole.
  await import("../../src/projects").then((p) => p.openThread("main", "Main"));
  await waitFor("back in Main", () => S().messages.some((m) => m.content.includes("CLEARED-TEXT")), 8000);
});

test("/compact is a command to the box, not a message", async () => {
  const sent0 = box.intents.length;
  await chat.sendMessage("/compact keep the essay plan");
  await waitFor("compact intent", () => box.intents.length > sent0);
  assert.deepEqual({ ...box.intents.at(-1), rid: undefined }, { rid: undefined, type: "compact", convId: "main", focus: "keep the essay plan", client: "laptop" });
  assert.ok(!S().messages.some((m) => m.content.startsWith("/compact")));
});

test("an older chat opens read-only from Older chats; New separate chat makes a chat of kind separate", async () => {
  const projects = await import("../../src/projects.ts");
  projects.openThread("old1");
  await waitFor("older chat", () => S().messages.some((m) => m.content === "something from last week"));
  const c = S().conversations.find((x) => x.id === "old1")!;
  assert.equal(threads.isOlderChat(c), true);
  const id = S().newConversation();
  assert.equal(S().conversations.find((x) => x.id === id)?.kind, "separate");
  assert.equal(threads.threadKindOf(S().conversations.find((x) => x.id === id)!), "separate");
  projects.openThread("main");
  assert.equal(S().activeConversationId, "main");
});
