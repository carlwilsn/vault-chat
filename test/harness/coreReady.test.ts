// The Ready card (src/coreReady.ts): a newer core the loader fetched and checked waits for Carl's OK. The card lists
// what it brings; Later hides it until another version (or the next start); OK acknowledges what landed first (so no
// Landed card follows the swap) and runs the swap; a swap that did not start puts the acknowledgement back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { CORE_BOX_API } from "../../src/coreBundle.ts";

installFakeTauri(makeTempVault("vc-coreready-"));
const R = await import("../../src/coreReady.ts");
const { LANDED_ACK_KEY, checkLanded, landedNow } = await import("../../src/landed.ts");
const { titlebarOffers } = await import("../../src/plugins/titlebar/index.tsx");

const A = "a".repeat(40);
const C = "c".repeat(40);
const offer = (version: string, commit: string) => ({ version, sha256: version + "0".repeat(56), commit, commitTime: 200, needs: { commands: [], plugins: [], boxApi: CORE_BOX_API }, seq: 1 });
const install = (v = "cccc0000", c = C) => ({ kind: "install" as const, offer: offer(v, c) });
const deps = (subjects: string[] | null = ["Ready card: OK swaps in. Later waits.", "Second"]) => {
  const asked: string[][] = [];
  return { asked, d: { running: async () => A, subjects: async (f: string, t: string) => (asked.push([f, t]), subjects) } };
};

test("a fetched bundle shows the card with what it brings (running..offer); the same one is not asked again", async () => {
  R._resetReady();
  const t = deps();
  const s = await R.offerReady(install(), null, t.d);
  assert.deepEqual(s, { shown: true, version: "cccc0000", commit: C, what: ["Ready card: OK swaps in.", "Second"], phase: "ready" });
  assert.deepEqual(t.asked, [[A, C]]);
  await R.offerReady(install(), null, t.d);
  assert.equal(t.asked.length, 1);
  // The offer is what runs again (the box switched back): the card goes.
  await R.offerReady({ kind: "stay", why: "running it already" }, null, t.d);
  assert.equal(R.readyNow().shown, false);
  // No list from the box: a plain line.
  assert.deepEqual((await R.offerReady(install(), null, deps(null).d)).what, ["A new version of the interface is ready"]);
});

test("Later hides it until another version, or the next app start", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  R.laterReady();
  assert.equal(R.readyNow().shown, false);
  await R.offerReady(install(), null, deps().d);
  assert.equal(R.readyNow().shown, false);
  await R.offerReady(install("dddd0000", "d".repeat(40)), null, deps().d);
  assert.equal(R.readyNow().version, "dddd0000");
  R.laterReady();
  R._resetReady(); // a new start
  await R.offerReady(install("dddd0000", "d".repeat(40)), null, deps().d);
  assert.equal(R.readyNow().shown, true);
});

test("OK acknowledges what landed, then swaps: the new page shows no Landed card", async () => {
  R._resetReady();
  localStorage.setItem(LANDED_ACK_KEY, A);
  await R.offerReady(install(), null, deps().d);
  const phases: string[] = [];
  const off = R.onReadyChanged((s) => phases.push(s.phase ?? "gone"));
  await R.acceptReady(async () => {
    assert.equal(localStorage.getItem(LANDED_ACK_KEY), C);
    return { did: "swapped" };
  });
  off();
  assert.deepEqual(phases, ["switching"]);
  // After the load the core runs C: acknowledged already, nothing to show.
  await checkLanded({ running: async () => C, subjects: async () => assert.fail("never asked") });
  assert.equal(landedNow().shown, false);
});

test("a swap that did not start: the old acknowledgement is back and the card says why", async () => {
  R._resetReady();
  localStorage.setItem(LANDED_ACK_KEY, A);
  await R.offerReady(install(), null, deps().d);
  const s = await R.acceptReady(async () => ({ did: "failed", error: "hash mismatch" }));
  assert.equal(s.phase, "failed");
  assert.equal(s.error, "hash mismatch");
  assert.equal(localStorage.getItem(LANDED_ACK_KEY), A);
  // Nothing to swap to any more: the card goes.
  await R.acceptReady(async () => ({ did: "nothing" }));
  assert.equal(R.readyNow().shown, false);
});

test("a full localStorage (QuotaExceededError) never stops OK: the swap still runs (11-22 'Switching…' forever)", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  const ls = globalThis.localStorage as Storage;
  const real = ls.setItem;
  const quota = () => {
    const e = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
    e.name = "QuotaExceededError";
    throw e;
  };
  Object.defineProperty(ls, "setItem", { value: quota, configurable: true, writable: true });
  let swapped = false;
  try {
    await R.acceptReady(async () => ((swapped = true), { did: "swapped" }));
    assert.equal(swapped, true);
    // A failed swap with storage still full: the card says why, no throw.
    R._resetReady();
    await R.offerReady(install("dddd0000"), null, deps().d);
    const s = await R.acceptReady(async () => ({ did: "failed", error: "hash mismatch" }));
    assert.equal(s.phase, "failed");
    assert.equal(s.error, "hash mismatch");
  } finally {
    Object.defineProperty(ls, "setItem", { value: real, configurable: true, writable: true });
  }
});

test("a swap that never answers: after the timeout the card leaves 'Switching…' for 'failed' with the reason", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  const s = await R.acceptReady(() => new Promise(() => {}), 30);
  assert.equal(s.phase, "failed");
  assert.match(s.error ?? "", /did not finish within/);
  assert.equal(R.SWITCH_TIMEOUT_MS, 30_000);
});

test("agent parity: app/titlebar reads the Ready card and presses Later", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  const o = titlebarOffers({ host: {} } as any, () => ({}) as any) as any;
  assert.equal(o.state.ready.read().version, "cccc0000");
  assert.ok(/Only when Carl asks/.test(o.actions.acceptReady.description));
  const r = await o.actions.laterReady.run({});
  assert.equal(r.ready.shown, false);
});

test("the card is offered core vs running core: never a core the laptop already runs", async () => {
  // The same main revision as the running core (e.g. a new installer whose own core is the box's bundle): no card,
  // and the box is not even asked for a list.
  R._resetReady();
  const same = { asked: [] as string[][], d: { running: async () => C.slice(0, 12), subjects: async () => assert.fail("never asked") } };
  assert.equal((await R.offerReady(install(), null, same.d)).shown, false);
  // A card up already (from before) goes when the offer turns out to be what runs.
  await R.offerReady(install(), null, deps().d);
  assert.equal(R.readyNow().shown, true);
  const o = titlebarOffers({ host: {} } as any, () => ({}) as any) as any;
  const seen: unknown[] = [];
  const off = R.onReadyChanged((s) => seen.push(s));
  await R.offerReady(install(), null, same.d);
  off();
  // Read and watched through app/titlebar's ready state and its readyChanged source.
  assert.equal(o.state.ready.read().shown, false);
  assert.deepEqual(seen, [{ shown: false }]);
  // An offer whose commits the running core has all (running..offer is empty): no card.
  assert.equal((await R.offerReady(install("eeee0000", "e".repeat(40)), null, deps([]).d)).shown, false);
  // The installed app's own core at the running revision: no card either.
  assert.equal((await R.offerReady({ kind: "baked", why: "publishing off" }, A, deps([]).d)).shown, false);
  // An older installed core, on purpose (a switch back): still offered.
  const back = await R.offerReady({ kind: "baked", why: "publishing off" }, "b".repeat(40), deps([]).d);
  assert.equal(back.shown, true);
  assert.equal(R.sameCommit("50272a64", "50272a646f93767f"), true);
  assert.equal(R.sameCommit("50272a6", "50272a7"), false);
});

test("one card at a time: a landing while Ready is pending joins its list, never a second card", async () => {
  const { publishLanded } = await import("../../src/landed.ts");
  const B = "b".repeat(40);
  // An installer's own core arrived without his OK (ack A, running B) while a Ready card is up: one card.
  R._resetReady();
  publishLanded({ shown: false });
  await R.offerReady(install(), null, { running: async () => B, subjects: async () => ["Brings this."] });
  localStorage.setItem(LANDED_ACK_KEY, A);
  await checkLanded({ running: async () => B, subjects: async () => ["Landed that."] });
  assert.equal(landedNow().shown, false);
  assert.deepEqual(R.readyNow().what, ["Landed that.", "Brings this."]);
  assert.equal(localStorage.getItem(LANDED_ACK_KEY), B);
  // The other order: a Landed card is up, then a Ready card comes: the Landed card goes into it.
  R._resetReady();
  localStorage.setItem(LANDED_ACK_KEY, A);
  await checkLanded({ running: async () => B, subjects: async () => ["Landed that."] });
  assert.equal(landedNow().shown, true);
  await R.offerReady(install(), null, { running: async () => B, subjects: async () => ["Brings this."] });
  assert.equal(landedNow().shown, false);
  assert.deepEqual(R.readyNow().what, ["Landed that.", "Brings this."]);
  assert.equal(localStorage.getItem(LANDED_ACK_KEY), B);
  // OK on it acknowledges the offer's core: no Landed card follows the swap.
  await R.acceptReady(async () => ({ did: "swapped" }));
  await checkLanded({ running: async () => C, subjects: async () => assert.fail("never asked") });
  assert.equal(landedNow().shown, false);
  // No Ready card pending: the landing shows as its own Landed card.
  R._resetReady();
  localStorage.setItem(LANDED_ACK_KEY, A);
  await checkLanded({ running: async () => B, subjects: async () => ["Landed that."] });
  assert.deepEqual(landedNow(), { shown: true, revision: B, what: ["Landed that."] });
});

test("no answer from the box (asleep, offline, no box) keeps the card: only the box's own answer takes it down (11-24: hidden 1 s after the laptop lost the box)", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  await R.offerReady({ kind: "none", why: "the box has no core bundles (an older box) or is out of reach" }, null, deps().d);
  assert.equal(R.readyNow().shown, true);
  assert.equal(R.readyNow().version, "cccc0000");
  await R.offerReady({ kind: "stay", why: "running it already" }, null, deps().d);
  assert.equal(R.readyNow().shown, false);
});

test("showReady brings the card back after Later, asks the box now and never presses OK", async () => {
  R._resetReady();
  await R.offerReady(install(), null, deps().d);
  R.laterReady();
  assert.equal(R.readyNow().shown, false);
  let looks = 0;
  const step = install();
  const r = await R.showReady(async () => {
    looks++;
    await R.offerReady(step, null, deps().d);
    return { step };
  });
  assert.equal(looks, 1);
  assert.equal(r.ready.shown, true);
  assert.equal(r.ready.phase, "ready");
  assert.match(r.note, /card is up/);
  // Nothing newer: up to date, with the box's reason.
  R._resetReady();
  const u = await R.showReady(async () => ({ step: { kind: "stay" as const, why: "running it already" } }));
  assert.equal(u.ready.shown, false);
  assert.match(u.note, /up to date/);
  // The box out of reach: says so.
  const n = await R.showReady(async () => ({ step: { kind: "none" as const, why: "no box" } }));
  assert.match(n.note, /could not ask the box: no box/);
});

test("agent parity: app/titlebar showReady is the Settings control's action and says it never presses OK", async () => {
  const o = titlebarOffers({ host: {} } as any, () => ({}) as any) as any;
  assert.ok(o.actions.showReady);
  assert.ok(/Never presses OK/.test(o.actions.showReady.description));
});
