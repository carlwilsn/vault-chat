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
