// Watching a plugin instead of polling it (Native agency: read / change / watch). Before, PluginRead's after + wait
// worked only for vault pages kept on the box; an app plugin (the viewer, the chat list, the composer…) could only be
// read again and again. Now the device holds a "watch" until the plugin's next event (src/pluginOffers.ts
// watchOffers) and PluginRead {plugin, wait, after} carries it (server/pluginOffersTool.ts).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { declareOffers, watchOffers, answerPluginSignal, _resetOffers } from "../../src/pluginOffers.ts";

const { pluginOfferTool } = await import("../../server/pluginOffersTool.ts");
const { ackShow, feedOpened, resetPresence } = await import("../../server/show.ts");

let n = 0;
let handle: ReturnType<typeof declareOffers>["handle"];
before(() => {
  _resetOffers();
  handle = declareOffers("app/counter", "Counter", {
    state: { count: { description: "the count", read: () => n } },
    events: { changed: { description: "the count changed" } },
  }).handle;
});
const bump = (ms: number) => setTimeout(() => (n++, handle.emit("changed", { n })), ms);

test("a watch answers at the plugin's next event, with its state then; with nothing new it ends when the wait does", async () => {
  bump(60);
  const t0 = Date.now();
  const r = await watchOffers("counter", undefined, 3000);
  assert.ok(Date.now() - t0 < 2000, "answered at the event, not at the end of the wait");
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.state, { count: 1 });
  assert.equal(r.events!.length, 1);
  assert.equal(r.events![0]!.event, "changed");
  const seq = r.seq!;
  assert.ok(seq > 0);
  // Nothing after that seq: the wait runs out.
  const quiet = await watchOffers("counter", seq, 120);
  assert.equal(quiet.timedOut, true);
  assert.deepEqual(quiet.events, []);
  // An event that came between two watches is not missed: `after` names where the last one ended.
  n++;
  handle.emit("changed", { n });
  const caught = await watchOffers("counter", seq, 3000);
  assert.equal(caught.timedOut, false);
  assert.equal(caught.events!.length, 1);
  assert.ok(caught.seq! > seq);
  const none = await watchOffers("nope", undefined, 50);
  assert.equal(none.ok, false);
  assert.match(none.error!, /no plugin "nope" is mounted/);
});

test("PluginRead {plugin, wait} on an app plugin is that watch, end to end over the device signal", async () => {
  resetPresence();
  const leave = feedOpened("/tmp/vc-watch-vault", "laptop");
  const sent: string[] = [];
  const deps = {
    vault: "/tmp/vc-watch-vault",
    ackMs: 3000,
    emit: (ev: Record<string, unknown>) => {
      sent.push(String(ev.op));
      void answerPluginSignal(ev as any).then((ack) => ackShow(String(ev.id), ack));
    },
  };
  try {
    bump(80);
    const r = await pluginOfferTool(deps as any, "PluginRead", { plugin: "counter", wait: 5 });
    assert.equal(r.ok, true);
    assert.deepEqual(sent, ["watch"]);
    assert.match(r.text, /watched on the laptop: new events/);
    assert.match(r.text, /"event": "changed"/);
    const seq = Number(/after: (\d+), wait: 25/.exec(r.text)![1]);
    const quiet = await pluginOfferTool(deps as any, "PluginRead", { plugin: "counter", wait: 0.2, after: seq });
    assert.match(quiet.text, new RegExp(`nothing new since seq ${seq} within 0.2 s`));
    // No wait: a plain read, as before.
    const read = await pluginOfferTool(deps as any, "PluginRead", { plugin: "counter" });
    assert.equal(sent.at(-1), "read");
    assert.match(read.text, /read from the laptop now/);
  } finally {
    leave();
  }
});
