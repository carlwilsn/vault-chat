// /compact on the laptop, as Carl sees it (2026-11-12: "all I see is my context
// go down, I don't see anything in the chat and my message doesn't send"):
// the real store and box client against a box in memory (src/convlog/memoryBox.ts,
// the engine's answers), reached through the same native routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { MemoryBox } from "../../src/convlog/memoryBox.ts";
import { emptyPicture, foldInto } from "../../src/convlog/reduce.ts";
import { makeChatView } from "../../src/convlog/view.ts";

const vault = makeTempVault("vc-compact-");
const fake = installFakeTauri(vault);
const box = new MemoryBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function route(method: string, url: string, body?: string) {
  const u = new URL(url);
  const r = await box.route(method, u.pathname, u.searchParams, body ? JSON.parse(body) : undefined, 300);
  return { status: r?.status ?? 404, body: JSON.stringify(r?.body ?? { error: "not found" }) };
}
fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:9", vault: "v" }));
fake.setHandler("box_get_json", ({ url }) => route("GET", url));
fake.setHandler("box_post_json", ({ url, body }) => route("POST", url, body));

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const S = () => useStore.getState();

before(async () => {
  box.create("main", { title: "Main", source: "main", kind: "main" });
  box.append("main", [
    { role: "user", content: "a long talk about the essay", mid: "u-1" },
    { role: "assistant", content: "the essay plan, at length", usage: { context: 180_000 } },
  ]);
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  (await import("../../src/projects.ts")).openThread("main");
  await waitFor("Main open", () => S().messages.some((m) => m.content === "the essay plan, at length"));
  await waitFor("the dial", () => S().lastContext === 180_000);
});

after(() => bc.stopBoxChat());

test("/compact: the line at once, a message sent meanwhile shown waiting, then the divider, the new size, and the answer", async () => {
  await chat.sendMessage("/compact");
  // 1: the chat says it is summarizing, with the working indicator, at once.
  await waitFor("the summarizing line", () => S().messages.some((m) => m.system && m.working && m.content === "Summarizing the earlier conversation…"));
  assert.equal(box.intents.at(-1)!.type, "compact");
  // The /compact itself is a command, never a message of his.
  assert.ok(!S().messages.some((m) => m.content.startsWith("/compact")));

  // 2: what he sends now is his message at once, visibly waiting.
  await chat.sendMessage("and while you do that: MARKER-DURING");
  await waitFor("his message, waiting", () => S().messages.some((m) => m.role === "user" && m.content.includes("MARKER-DURING") && m.waiting));
  await waitFor("held by the box", () => box.picture("main")!.meta.pending?.length === 1);
  assert.equal(S().lastContext, 180_000, "until the summary lands, the size it had");

  // The summary lands.
  box.compacted("main", { before: 180_000, after: 12_400 });
  await waitFor("the divider", () => S().messages.some((m) => m.compaction?.summary.includes("down to 12,400")));
  assert.ok(!S().messages.some((m) => m.working), "the line is gone");
  // 3: the dial reads the new size at once.
  await waitFor("the dial moved", () => S().lastContext === 12_400);

  // His message runs right after the divider, and is answered.
  await waitFor("delivered", () => S().messages.some((m) => m.role === "user" && m.content.includes("MARKER-DURING") && !m.waiting && !m.boxPending));
  box.say("main", "Answering MARKER-DURING now.");
  box.endTurn("main");
  await waitFor("answered", () => S().messages.some((m) => m.content === "Answering MARKER-DURING now."));
  const order = S().messages.map((m) => (m.compaction ? "divider" : m.content));
  const at = order.indexOf("divider");
  assert.ok(at >= 0 && order.indexOf("and while you do that: MARKER-DURING") > at, JSON.stringify(order));
});

test("a summary whose size is not known: the dial says nothing rather than the old figure", async () => {
  await waitFor("idle", () => !S().busy);
  await chat.sendMessage("/compact");
  await waitFor("the line", () => S().messages.some((m) => m.working));
  box.compacted("main", {});
  await waitFor("the second divider", () => S().messages.filter((m) => m.compaction).length === 2);
  await waitFor("dial cleared", () => S().lastContext === 0);
});

test("a summary that fails says so in one line, and the line stops", async () => {
  await chat.sendMessage("/compact");
  await waitFor("the line", () => S().messages.some((m) => m.working));
  box.compacted("main", { fail: "API Error: 400 refused" });
  await waitFor("the failure", () => S().messages.some((m) => m.system && m.content === "Summarizing the earlier conversation failed: API Error: 400 refused"));
  assert.ok(!S().messages.some((m) => m.working));
});

test("the phone's fold draws the same: the working line, then the divider (one reducer, one projection)", () => {
  const b = new MemoryBox();
  b.create("c", { title: "x" });
  b.append("c", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", usage: { context: 90_000 } }]);
  b.intent({ type: "compact", convId: "c" });
  b.intent({ type: "compact", convId: "c" });
  const view = makeChatView();
  const during = view(foldInto(emptyPicture("c"), b.recs.filter((r) => r.conv === "c")));
  assert.deepEqual(during.messages.filter((m) => m.working).map((m) => m.content), ["Summarizing the earlier conversation…"]);
  b.compacted("c", { before: 90_000, after: 4_000 });
  const p = foldInto(emptyPicture("c"), b.recs.filter((r) => r.conv === "c"));
  const done = view(p);
  assert.equal(done.messages.filter((m) => m.working).length, 0);
  assert.equal(done.messages.filter((m) => m.compaction).length, 1);
  assert.equal(done.context, 4_000);
});
