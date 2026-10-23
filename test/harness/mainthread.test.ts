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

test("the panel: Main at the top, then the projects (each its one thread), then + New project; no list of chats", () => {
  const { entries, others } = threads.panelModel(
    [
      { id: "main", kind: "main", lastActivityAt: 5 },
      { id: "project-psych-221", kind: "project", lastActivityAt: 9, running: true },
      { id: "sep-1", kind: "separate", title: "a one-off", lastActivityAt: 7 },
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
  // Separate and older chats are only in the menu's "Older chats", newest first.
  assert.deepEqual(others.map((o) => o.id), ["sep-1", "old1"]);
  assert.equal(threads.threadKindOf({ id: "old1" }), "older");
  assert.equal(threads.isOlderChat({ id: "x", kind: "separate" }), false);
  assert.equal(threads.projectOfThread("project-psych-221"), "psych-221");
  assert.equal(threads.projectOfThread("project-../x"), null);
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

test("Clear is this surface's: blank on the next frame, nothing sent to the box, the box (and every other surface) keeps it all; it lasts across a restart", async () => {
  const intents0 = box.intents.length;
  const frames: string[][] = [];
  const unsub = useStore.subscribe((s) => frames.push(s.messages.map((m) => m.content)));
  chat.clearThread();
  await waitFor("blank", () => S().messages.length === 0, 300);
  unsub();
  assert.ok(frames.some((f) => f.length === 0));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(box.intents.length, intents0, "nothing went to the box");
  assert.ok(threads && box.picture("main").items.some((x: any) => String(x.text ?? "").includes("CLEARED-TEXT")), "the conversation still has it");
  // A new message shows as usual, and only it.
  await chat.sendMessage("a fresh start");
  await waitFor("fresh", () => S().messages.some((m) => m.content === "a fresh start" && !m.boxPending));
  box.stream("main", "assistant", "ok");
  box.endTurn("main");
  await waitFor("reply", () => S().messages.some((m) => m.content === "ok"));
  assert.deepEqual(S().messages.map((m) => m.content), ["a fresh start", "ok"]);
  // A restart of this client: still cleared here (kept on this device).
  bc.stopBoxChat();
  useStore.setState({ conversations: [], messages: [] } as any);
  await bc.startBoxChat(vault);
  await waitFor("reloaded", () => S().messages.some((m) => m.content === "ok"), 8000);
  assert.ok(!S().messages.some((m) => /CLEARED-TEXT|hello Main/.test(m.content)));
});

test("/compact is a command to the box, not a message", async () => {
  const sent0 = box.intents.length;
  await chat.sendMessage("/compact keep the essay plan");
  await waitFor("compact intent", () => box.intents.length > sent0);
  assert.deepEqual(box.intents.at(-1), { type: "compact", convId: "main", focus: "keep the essay plan", client: "laptop" });
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
