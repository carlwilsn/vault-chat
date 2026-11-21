// Offer events leave the app for the box's event log (src/offerHistory.ts): every emit reaches the sink; a repeat
// within COALESCE_MS keeps only its newest; they go in batches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { declareOffers, setOfferEventSink, _resetOffers } from "../../src/pluginOffers.ts";
import { OfferHistory, COALESCE_MS, payloadLine } from "../../src/offerHistory.ts";

test("every emitted offer event reaches the sink, with its part", () => {
  _resetOffers();
  const got: string[] = [];
  const prev = setOfferEventSink((p, rec) => got.push(`${p.id} ${rec.event}`));
  try {
    const { handle } = declareOffers("app/viewer", "Viewer", { events: { opened: { description: "a file opened" } } });
    handle.emit("opened", { path: "a.md" });
    handle.emit("nope");
    assert.deepEqual(got, ["app/viewer opened"]);
  } finally {
    setOfferEventSink(prev);
  }
});

test("repeats coalesce, batches flush, a long payload is cut", async () => {
  const sent: any[][] = [];
  const timers: (() => void)[] = [];
  const h = new OfferHistory(async (evs) => void sent.push(evs), (fn) => (timers.push(fn), 1 as any));
  h.add("app/viewer", { event: "scrolled", at: 1000, payload: { page: 1 } });
  h.add("app/viewer", { event: "scrolled", at: 1000 + COALESCE_MS - 1, payload: { page: 2 } });
  h.add("app/viewer", { event: "opened", at: 1500, payload: { path: "a.md" } });
  h.add("app/viewer", { event: "scrolled", at: 1000 + COALESCE_MS * 3, payload: { page: 9 } });
  assert.equal(timers.length, 1);
  timers[0]!();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent[0]!.map((e) => `${e.event} ${e.payload}`), ['scrolled {"page":2}', 'opened {"path":"a.md"}', 'scrolled {"page":9}']);
  assert.equal(payloadLine("x".repeat(1000))!.length, 401);
});

test("an offer event carries its part's state from before it, where it changed (report 22: undo by hand)", async () => {
  _resetOffers();
  const recs: any[] = [];
  const prev = setOfferEventSink((_p, rec) => recs.push(rec));
  try {
    let notes = [{ id: "a", text: "one", status: "open" }, { id: "b", text: "two", status: "open" }];
    let theme = "dark";
    const { handle } = declareOffers("app/notes", "Notes", {
      state: { notes: { read: () => notes }, settings: { read: () => ({ theme, model: "opus" }) } },
      events: { changed: { description: "x" }, hover: { description: "y", before: false } },
    });
    await Promise.resolve();
    notes = [{ id: "a", text: "one!", status: "open" }, { id: "c", text: "three", status: "open" }];
    theme = "light";
    handle.emit("changed");
    assert.deepEqual(recs[0].before, { notes: { changed: [{ id: "a", text: "one", status: "open" }, { id: "b", text: "two", status: "open" }], added: ["id:c"] }, settings: { theme: "dark" } });
    handle.emit("changed");
    assert.equal(recs[1].before, undefined, "nothing changed since the last event");
    theme = "x";
    handle.emit("hover");
    assert.equal(recs[2].before, undefined, "an event can opt out");
  } finally {
    setOfferEventSink(prev);
  }
});

test("hover / focus moves stay out of the box's history; a coalesced run keeps its first before", async () => {
  const sent: any[][] = [];
  const timers: (() => void)[] = [];
  const h = new OfferHistory(async (evs) => void sent.push(evs), (fn) => (timers.push(fn), 1 as any));
  h.add("app/context", { event: "changed", at: 1, payload: { changed: ["hover"] } });
  h.add("app/context", { event: "changed", at: 2, payload: { changed: ["hover", "focus"] } });
  h.add("app/viewer", { event: "scrolled", at: 10, payload: { page: 2 }, before: { open: { page: 1 } } });
  h.add("app/viewer", { event: "scrolled", at: 20, payload: { page: 3 }, before: { open: { page: 2 } } });
  h.add("app/context", { event: "changed", at: 30_000, payload: { changed: ["selection"] } });
  timers[0]!();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent[0]!.map((e) => `${e.plugin} ${e.payload} ${e.before ?? ""}`), ['app/viewer {"page":3} {"open":{"page":1}}', 'app/context {"changed":["selection"]} ']);
});
