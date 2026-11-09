// On restart the app reopens the chat Carl was last in; if that chat is gone, a new chat under Main.
// And a place he collapsed stays collapsed (src/placeOpen.ts), kept on this machine per vault.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-restore-");
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
const po = await import("../../src/placeOpen.ts");
const S = () => useStore.getState();

before(async () => {
  await box.start();
  box.create("main", "Main", Date.now() - 50_000);
  box.emit("main", { type: "meta", patch: { kind: "main", source: "main" } });
  box.create("chat-kept", "A chat he was in", Date.now() - 10_000);
  box.emit("chat-kept", { type: "meta", patch: { kind: "separate" } });
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

async function restart(lastIn: string): Promise<void> {
  bc.stopBoxChat();
  localStorage.setItem("vault_chat_active_conv", lastIn);
  useStore.setState({ vaultPath: null, conversations: [], activeConversationId: null });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
}

test("restart reopens the separate chat he was last in", async () => {
  await restart("chat-kept");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(S().activeConversationId, "chat-kept");
});

test("restart on a chat that is gone starts a new chat under Main", async () => {
  await restart("chat-deleted-meanwhile");
  await waitFor("a new chat", () => S().activeConversationId !== "chat-deleted-meanwhile");
  const c = S().conversations.find((x) => x.id === S().activeConversationId);
  assert.equal(c?.kind, "separate");
  assert.ok(!c?.project, "under Main, not a project");
});

test("a collapsed place stays collapsed, per vault, across a reload of the store", () => {
  assert.equal(po.placeOpen(vault, "main"), null);
  po.setPlaceOpen(vault, "main", false);
  po.setPlaceOpen(vault, "project-x", true);
  const kept = JSON.parse(localStorage.getItem("vault_chat_place_open") ?? "{}");
  assert.deepEqual(kept[vault], { main: false, "project-x": true });
  assert.equal(po.placeOpen(vault, "main"), false);
  assert.equal(po.placeOpen("/another/vault", "main"), null);
});
