// The Landed card: the box lists main's subjects between two commits (server/coreBundles.ts coreLanded), the laptop
// trims them, shows the card once per new core, and OK (here or app/titlebar's dismissLanded) acknowledges it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-landed-"));
const L = await import("../../src/landed.ts");
const { coreLanded } = await import("../../server/coreBundles.ts");
const { titlebarOffers } = await import("../../src/plugins/titlebar/index.tsx");

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("the box lists from..to's subjects with git, and says null when git can't", () => {
  const calls: string[][] = [];
  const out = coreLanded("/repo", A, B, 50, (_cmd, args) => (calls.push(args), { status: 0, stdout: "Second thing. More words\nFirst thing\n", stderr: "" }));
  assert.deepEqual(out, ["Second thing. More words", "First thing"]);
  assert.deepEqual(calls[0]!.slice(-2), ["--format=%s", `${A}..${B}`]);
  assert.equal(coreLanded("/repo", A, B, 50, () => ({ status: 128, stdout: "", stderr: "bad revision" })), null);
  assert.equal(coreLanded("/repo", "not-a-commit", B, 50, () => assert.fail("never runs git")), null);
});

test("subjects are cut to their first sentence, at most 5 lines with +N more, else the fallback", () => {
  assert.equal(L.firstSentence("Composer keeps the draft. It used to lose it on swap."), "Composer keeps the draft.");
  assert.equal(L.firstSentence("v1.2 ships the thing"), "v1.2 ships the thing");
  assert.deepEqual(L.landedLines(["a. x", "b", "c"]), ["a.", "b", "c"]);
  assert.deepEqual(L.landedLines(["1", "2", "3", "4", "5", "6", "7"]), ["1", "2", "3", "4", "+3 more"]);
  assert.deepEqual(L.landedLines(["1", "2", "3", "4", "5"]), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(L.landedLines(null), [L.LANDED_FALLBACK]);
});

test("shown once per new core: the first run only records, a newer core shows until OK, then never again", async () => {
  localStorage.removeItem(L.LANDED_ACK_KEY);
  let running = A;
  let asked: string[] = [];
  const deps = { running: async () => running, subjects: async (f: string, t: string) => (asked.push(`${f}..${t}`), ["New card. Details", "Fix"]) };
  assert.equal((await L.checkLanded(deps)).shown, false, "the first run has nothing to compare with");
  assert.equal(localStorage.getItem(L.LANDED_ACK_KEY), A);
  assert.equal((await L.checkLanded(deps)).shown, false, "same core: no card");
  running = B;
  const seen: boolean[] = [];
  const off = L.onLandedChanged((s) => seen.push(s.shown));
  assert.deepEqual(await L.checkLanded(deps), { shown: true, revision: B, what: ["New card.", "Fix"] });
  assert.deepEqual(asked, [`${A}..${B}`]);
  // A reload before OK shows it again (it stays until OK).
  assert.equal((await L.checkLanded(deps)).shown, true);
  // OK through the agent's offer.
  const offers = titlebarOffers({ host: {} as never });
  assert.deepEqual(await (offers.state!.landed!.read as () => unknown)(), { shown: true, revision: B, what: ["New card.", "Fix"] });
  await (offers.actions!.dismissLanded!.run as () => Promise<unknown>)();
  assert.equal(L.landedNow().shown, false);
  assert.equal(localStorage.getItem(L.LANDED_ACK_KEY), B);
  asked = [];
  assert.equal((await L.checkLanded(deps)).shown, false, "acknowledged: never again for this core");
  assert.deepEqual(asked, []);
  off();
  assert.deepEqual(seen, [true, false]);
  // No list from the box: the fallback line.
  running = C;
  assert.deepEqual((await L.checkLanded({ running: async () => C, subjects: async () => null })).what, [L.LANDED_FALLBACK]);
  L.dismissLanded();
  // A switch back to an older core (nothing in from..to): acknowledged, no card.
  assert.equal((await L.checkLanded({ running: async () => A, subjects: async () => [] })).shown, false);
  assert.equal(localStorage.getItem(L.LANDED_ACK_KEY), A);
});
