// A chat this laptop cached that the box later deleted must leave on the next sync (after a reload or a
// restart of the session) and must never open from the cache. The box's list names deleted chats in a
// separate `deleted` field (server/http.ts), not as rows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-boxdelcache-");
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
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("conversations_write_all", () => {});
fake.setHandler("conversation_delete", () => {});

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const S = () => useStore.getState();
const has = (id: string) => S().conversations.some((c) => c.id === id);

before(async () => {
  await box.start();
  for (const id of ["gone1", "keep1"]) {
    box.create(id, id, Date.now() - 60_000);
    box.startTurn(id);
    box.user(id, "u-" + id, "question " + id);
    box.stream(id, "assistant", "answer " + id);
    box.endTurn(id);
  }
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("a cached chat the box deleted while the app was closed is dropped on the next sync, and not opened from the cache", async () => {
  const key = `box:${box.url}`;
  await waitFor("both cached", () => (bc.readBoxCache(key)?.rows ?? []).some((r) => r.id === "gone1") && has("gone1") && has("keep1"));
  S().selectConversation("gone1");
  await waitFor("picture cached", () => (bc.readBoxCache(key)?.pictures ?? []).some((p) => p.id === "gone1"));
  bc.stopBoxChat();
  // The box deletes it while this app is closed.
  box.emit("gone1", { type: "meta", patch: { deleted: true } } as any);
  const listed = await (await fetch(box.url + "/api/v2/conversations")).json();
  assert.ok(listed.deleted.includes("gone1") && !listed.rows.some((r: any) => r.id === "gone1"));
  // The app restarts: nothing in memory, the cache in localStorage.
  useStore.setState({ conversations: [], activeConversationId: null, messages: [] });
  await S().loadConversations();
  await waitFor("online again", () => S().boxChat?.on === true && S().boxChat?.reachable === true && has("keep1"));
  await waitFor("deleted chat gone", () => !has("gone1"));
  assert.ok(has("keep1"));
  assert.notEqual(S().activeConversationId, "gone1");
  // Never opened from a cache.
  S().selectConversation("gone1");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!has("gone1"), "a deleted chat does not come back by opening it");
  // The cache no longer holds it: a reload shows nothing of it.
  await waitFor("cache rewritten", () => !(bc.readBoxCache(key)?.rows ?? []).some((r) => r.id === "gone1"));
  assert.ok(!(bc.readBoxCache(key)?.pictures ?? []).some((p) => p.id === "gone1"));
});
