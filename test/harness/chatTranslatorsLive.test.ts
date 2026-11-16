// A translator changed live reaches the open chat at once (src/boxChat.ts re-projects every chat when the translators
// change): the real store and box client against a box in memory (src/convlog/memoryBox.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { MemoryBox } from "../../src/convlog/memoryBox.ts";

const vault = makeTempVault("vc-translive-");
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
const T = await import("../../src/convlog/translators.ts");
const S = () => useStore.getState();

before(async () => {
  box.create("main", { title: "Main", source: "main", kind: "main" });
  // A reply that launched a worker in the same message (its text is commentary in the log), then the worker's line.
  box.append("main", [
    { role: "user", content: "start track 2", mid: "u-1" },
    { role: "assistant", content: "Starting it now: TRACK-TWO.", toolCalls: [{ id: "a1", name: "Agent", input: { description: "Track 2" }, result: "launched" }] },
    { role: "user", system: true, content: "Worker finished: Track 2" },
  ]);
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  (await import("../../src/projects.ts")).openThread("main");
  await waitFor("Main open", () => S().messages.some((m) => m.content === "start track 2"));
});
after(() => bc.stopBoxChat());

test("the open chat shows the fixed translation, and follows a translator change at once", async () => {
  assert.ok(S().messages.some((m) => m.role === "assistant" && m.content === "Starting it now: TRACK-TWO." && !m.thinking), "the text beside the tool call is shown");
  assert.ok(S().messages.some((m) => m.system && m.content === "Worker finished · Track 2"));
  T.setTranslatorPrefs([], { commentary: "app:commentary:thought" });
  await waitFor("folded under Thought", () => S().messages.some((m) => m.thinking === "Starting it now: TRACK-TWO."));
  const undo = T.registerTranslator("worker", (e) => [{ role: "user", system: true, content: `DONE ${String(e.item.text).slice(17)}`, mid: e.item.id }], "test");
  await waitFor("a plugin's worker line", () => S().messages.some((m) => m.content === "DONE Track 2"));
  undo();
  T.setTranslatorPrefs([], {});
  await waitFor("the app's own again", () => S().messages.some((m) => m.content === "Worker finished · Track 2") && S().messages.some((m) => m.content === "Starting it now: TRACK-TWO."));
});
