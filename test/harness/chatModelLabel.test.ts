// The composer's model and effort labels read the conversation's own fields from
// the box's log, so a pick shows at once and again after a reload (Carl: "the
// effort and model selection don't work or persist").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-chatmodel-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", async ({ url }) => ({ status: 200, body: await (await fetch(url)).text() }));
fake.setHandler("box_post_json", async ({ url, body }) => {
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { status: r.status, body: await r.text() };
});

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const S = () => useStore.getState();
async function waitFor(what: string, fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("online", () => S().boxChat?.reachable === true);
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("a model and effort picked for a chat reach the conversation the composer reads, and clearing effort clears it", async () => {
  const conv = S().newConversation();
  box.create(conv, "Chat");
  await waitFor("chat listed", () => S().conversations.some((c) => c.id === conv));
  box.emit(conv, { type: "meta", patch: { model: "sonnet", effort: "max" } });
  await waitFor("model shown", () => S().conversations.find((c) => c.id === conv)?.model === "sonnet");
  assert.equal(S().conversations.find((c) => c.id === conv)?.effort, "max");
  box.emit(conv, { type: "meta", patch: { effort: null } });
  await waitFor("effort cleared", () => S().conversations.find((c) => c.id === conv)?.effort === undefined);
  assert.equal(S().conversations.find((c) => c.id === conv)?.model, "sonnet");
});
