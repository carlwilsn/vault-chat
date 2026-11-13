import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleChats, nextChatLevel, type PanelChat } from "../../src/threads.ts";

const mk = (n: number, over: Record<number, Partial<PanelChat>> = {}): PanelChat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, active: false, running: false, unread: false, at: n - i, ...over[i] }));

test("5 or fewer: all shown, no row", () => {
  const v = visibleChats(mk(5), 0);
  assert.equal(v.shown.length, 5);
  assert.equal(v.next, null);
});

test("more than 10: 5, then 10 (Show all), then everything", () => {
  const chats = mk(14);
  let lv = 0;
  let v = visibleChats(chats, lv);
  assert.deepEqual([v.shown.length, v.next], [5, "more"]);
  lv = nextChatLevel(14, lv);
  v = visibleChats(chats, lv);
  assert.deepEqual([v.shown.length, v.next], [10, "all"]);
  lv = nextChatLevel(14, lv);
  v = visibleChats(chats, lv);
  assert.deepEqual([v.shown.length, v.next], [14, null]);
});

test("10 or fewer: one step reveals the rest", () => {
  const chats = mk(8);
  assert.equal(visibleChats(chats, 0).shown.length, 5);
  const lv = nextChatLevel(8, 0);
  assert.deepEqual([visibleChats(chats, lv).shown.length, visibleChats(chats, lv).next], [8, null]);
  assert.equal(nextChatLevel(10, 0), 2);
});

test("open, working and unseen chats stay visible past the limit, in order", () => {
  const v = visibleChats(mk(20, { 12: { active: true }, 15: { running: true }, 18: { unread: true } }), 0);
  assert.deepEqual(v.shown.map((c) => c.id), ["c0", "c1", "c2", "c3", "c4", "c12", "c15", "c18"]);
  assert.equal(v.hidden, 12);
  assert.equal(v.next, "more");
});

test("a place that is closed forgets its Show more, however it closed, and when the list goes away", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/ChatsPanel.tsx", import.meta.url), "utf8");
  // An effect on `shown`, not only the toggle click: going to another place closes this one too.
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!shown\) chatLevels\.delete\(entry\.id\);[\s\S]*?\}, \[shown, entry\.id\]\)/);
});
