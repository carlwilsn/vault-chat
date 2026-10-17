// Box mode, every frame: the laptop's screen is the log's order, and nothing it
// showed ever disappears (Carl: "chat replies sometimes disappear and then pop
// back", "the render order is wrong"). Every store update is recorded as the
// screen it makes (the messages and the live tail, as the items they show);
// through a whole turn — thinking, two tool calls, a steer, the box going away
// and coming back, the box restarting — each frame must (1) show its items in
// the log's order and (2) still show every item the frame before showed (only
// moving from the live tail into the messages).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-boxorder-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const S = () => useStore.getState();

type Frame = { ids: string[]; texts: string[] };
/** The items a screen shows, in order: each message's items, then the live tail (its tools; its text by content). */
function frame(): Frame {
  const s = S();
  const ids: string[] = [];
  const texts: string[] = [];
  for (const m of s.messages) {
    if (m.boxLocal) continue;
    const items = ((m as any).items as string[] | undefined) ?? (m.mid ? [m.mid] : []);
    ids.push(...items);
    if (m.content.trim()) texts.push(m.content.trim());
    if (m.thinking?.trim()) texts.push(m.thinking.trim());
  }
  for (const t of s.liveTools) ids.push(t.id);
  if (s.streamingReasoning.trim()) texts.push(s.streamingReasoning.trim());
  if (s.streamingText.trim()) texts.push(s.streamingText.trim());
  return { ids, texts };
}

let conv = "";
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

test("a whole turn with thinking, two tool calls, a steer, an outage and a box restart: every frame in the log's order, nothing shown ever lost", async () => {
  conv = S().newConversation();
  const frames: Frame[] = [];
  const unsub = useStore.subscribe(() => frames.push(frame()));

  await chat.sendMessage("Compare the two KV-cache papers.");
  await waitFor("running", () => S().busy && S().messages.some((m) => m.mid && !m.boxPending));
  // Thinking, streamed.
  const th = box.open(conv, "thinking");
  for (const w of ["Two papers: ", "compare ", "their memory."]) {
    th.delta(w);
    await sleep(60);
  }
  th.end();
  // Two tool calls in parallel, then their results.
  box.tool(conv, "call_a", "Read", { path: "papers/a.md" });
  box.tool(conv, "call_b", "Read", { path: "papers/b.md" });
  await sleep(150);
  // Carl steers while the tools run.
  await chat.sendMidTurn("steer", "Only the 4-bit results, please.");
  const steer = box.intents.at(-1)!;
  box.toolDone(conv, "call_a", "paper A text");
  await sleep(80);
  box.toolDone(conv, "call_b", "paper B text");
  // pi delivers the steer after the tool calls.
  box.deliver(conv, steer.clientId);
  await sleep(100);
  // The reply starts streaming…
  const reply = box.open(conv, "assistant");
  reply.delta("At 4 bits, ");
  await waitFor("streaming", () => S().streamingText.startsWith("At 4 bits"));
  // …the box goes away (the laptop sees nothing), the turn goes on…
  box.down = true;
  await waitFor("unreachable", () => S().boxChat?.reachable === false, 15_000);
  reply.delta("A keeps perplexity within 0.05; ");
  box.down = false;
  bc._boxChatSession()!.kick();
  await waitFor("caught up", () => S().streamingText.includes("0.05"), 15_000);
  // …the box restarts (a new process on the same log), and the turn finishes.
  box.restart();
  reply.delta("B loses 0.3.");
  reply.end();
  box.endTurn(conv);
  await waitFor("done", () => !S().busy && S().messages.at(-1)?.content === "At 4 bits, A keeps perplexity within 0.05; B loses 0.3.", 15_000);
  await sleep(200);
  unsub();

  // The log's order: the box's fold.
  const order = box.picture(conv).items.map((x) => x.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  assert.ok(frames.length > 20, `${frames.length} frames`);
  const bad: string[] = [];
  frames.forEach((f, i) => {
    const known = f.ids.filter((id) => pos.has(id));
    for (let k = 1; k < known.length; k++) if (pos.get(known[k]!)! < pos.get(known[k - 1]!)!) bad.push(`frame ${i}: ${known[k - 1]} before ${known[k]}`);
    if (i === 0) return;
    const prev = frames[i - 1]!;
    for (const id of prev.ids) if (!f.ids.includes(id)) bad.push(`frame ${i}: item ${id} disappeared`);
    for (const t of prev.texts) if (!f.texts.some((x) => x.includes(t.slice(-80)))) bad.push(`frame ${i}: "${t.slice(0, 50)}" disappeared`);
  });
  assert.deepEqual(bad.slice(0, 8), []);
  // The last frame is exactly the log, in its order (one message per item, the two tool calls folded).
  const last = frames.at(-1)!;
  assert.deepEqual(last.ids.filter((id) => pos.has(id)), order.filter((id) => !id.endsWith(":plan")));
  const steerAt = last.ids.indexOf(steer.clientId);
  assert.ok(steerAt > last.ids.indexOf("call_b"), "the steer is where pi delivered it: after the tool calls");
  assert.ok(steerAt < last.ids.indexOf(order.at(-1)!), "and before the reply it got");
});
