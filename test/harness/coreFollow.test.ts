// The laptop following the box's core bundle (src/coreFollow.ts): it asks the native loader (core_status), tells the
// box about the loader's fallbacks (a plugin.change switch by "auto", only while the box still offers what failed),
// has the loader fetch and check a newer compatible bundle, and takes it only with Carl's OK (swap); an app from before the
// loader, an older box, a bundle the shell cannot run and the installer's own newer core all leave it where it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import type { CoreDeps, CoreStatus } from "../../src/coreFollow.ts";
import { CORE_BOX_API } from "../../src/coreBundle.ts";

installFakeTauri(makeTempVault("vc-corefollow-"));
// After the fake app is in place (the store reads its storage when it loads).
const { followCoreOnce } = await import("../../src/coreFollow.ts");

const OFFER = { version: "abcd1234", sha256: "abcd1234" + "0".repeat(56), commit: "a".repeat(40), commitTime: 200, needs: { commands: ["app_ready"], plugins: ["dialog"], boxApi: CORE_BOX_API }, seq: 5 };
const status = (o: Partial<CoreStatus> = {}): CoreStatus => ({ shell: "0.9.40", active: "built-in", activeCommit: null, ready: true, current: null, previous: null, bad: [], events: [], commands: ["app_ready", "core_ready"], plugins: ["dialog"], baked: { commit: "b".repeat(40), commitTime: 100 }, ...o });

function deps(o: { status?: CoreStatus | null; offer?: unknown; boxApi?: number; installFails?: string; boxDown?: boolean } = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const posts: Record<string, unknown>[] = [];
  const d: CoreDeps = {
    native: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "core_status") {
        if (o.status === null) throw new Error("command core_status not found");
        return (o.status ?? status()) as T;
      }
      if (cmd === "core_install" && o.installFails) throw new Error(o.installFails);
      return undefined as T;
    },
    link: async () => ({ url: "https://box.example.ts.net", token: "t" }),
    get: async (_l, p) => {
      if (o.boxDown) throw new Error("404 no such route");
      assert.equal(p, "/api/v2/core");
      return { boxApi: o.boxApi ?? CORE_BOX_API, offer: o.offer === undefined ? OFFER : o.offer };
    },
    post: async (_l, p, b) => {
      assert.equal(p, "/api/v2/supervisor");
      posts.push(b);
      return { ok: true };
    },
  };
  return { d, calls, posts, cmds: () => calls.map((c) => c.cmd) };
}

test("a newer compatible bundle is fetched and checked by the loader, then taken with OK (swap)", async () => {
  const t = deps();
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(t.cmds(), ["core_status", "core_install", "core_use"]);
  assert.deepEqual(t.calls[1]!.args, { baseUrl: "https://box.example.ts.net", token: "t", version: OFFER.version, sha256: OFFER.sha256 });
  assert.deepEqual(t.calls[2]!.args, { version: OFFER.version });
});

test("without OK it is only fetched and checked: nothing swaps by itself, idle or not", async () => {
  const t = deps();
  const r = await followCoreOnce(t.d);
  assert.equal(r.did, "installed");
  assert.equal(r.status?.active, "built-in");
  assert.ok(!t.cmds().includes("core_use"));
});

test("a bundle the loader refuses (a hash that does not match, a command the shell lacks) is never taken", async () => {
  const t = deps({ installFails: "abcd1234's manifest does not match its record's hash: refused" });
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "failed");
  assert.match(r.error!, /refused/);
  assert.ok(!t.cmds().includes("core_use"));
});

test("the loader's fallback is told to the box while the box still offers what failed; then cleared", async () => {
  const ev = { from: OFFER.version, to: "built-in", reason: "did not say ready within 30 s", at_ms: 1 };
  const t = deps({ status: status({ events: [ev], bad: [OFFER.version] }) });
  const r = await followCoreOnce(t.d, { swap: true });
  assert.deepEqual(t.posts, [{ plugin: "app/core", change: "switch", version: "built-in", by: "auto", reason: `the laptop's loader fell back from ${OFFER.version}: did not say ready within 30 s` }]);
  assert.ok(t.cmds().includes("core_events_sent"));
  // ... and the bundle that failed here is not taken again.
  assert.equal(r.did, "nothing");
  // The box moved on already: nothing is written (it would switch the box back to an older core).
  const later = deps({ status: status({ events: [ev] }), offer: { ...OFFER, version: "99999999", sha256: "99999999" + "0".repeat(56) } });
  await followCoreOnce(later.d);
  assert.deepEqual(later.posts, []);
});

test("an app from before the loader, an older box, an old offer or one needing a newer box API: nothing happens", async () => {
  for (const o of [{ status: null }, { boxDown: true }, { offer: { ...OFFER, commitTime: 50 } }, { offer: { ...OFFER, needs: { ...OFFER.needs, boxApi: CORE_BOX_API + 1 } } }, { offer: { ...OFFER, needs: { ...OFFER.needs, commands: ["app_ready", "brand_new"] } } }, { offer: null }] as const) {
    const t = deps(o as Parameters<typeof deps>[0]);
    const r = await followCoreOnce(t.d, { swap: true });
    assert.equal(r.did, "nothing", JSON.stringify(o));
    assert.ok(!t.cmds().includes("core_install") && !t.cmds().includes("core_use"));
  }
});

test("a newer installer runs its own core over an older box bundle", async () => {
  const t = deps({ status: status({ active: "11112222", baked: { commit: "c".repeat(40), commitTime: 500 } }) });
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: null } });
});

test("the box's core publishing turned off: back to the installed app's own core, with OK", async () => {
  const t = deps({ status: status({ active: "11112222" }), offer: null });
  t.d.get = async () => ({ boxApi: CORE_BOX_API, publish: false, offer: null });
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: null } });
});

// ---------------------------------------------------------------- a switch back, and what is said after a swap

test("a switch back (now): the core in effect is taken at once, busy or not, after the screen is kept", async () => {
  const t = deps({ status: status({ active: "77778888" }), offer: null });
  const order: string[] = [];
  t.d.beforeSwap = async () => void order.push("kept the screen");
  const native = t.d.native;
  t.d.native = async (cmd, args) => (cmd === "core_use" && order.push("core_use"), native(cmd, args));
  const r = await followCoreOnce(t.d, { swap: true, now: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(order, ["kept the screen", "core_use"]);
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: null } });
  // Not asked for (the periodic look): it waits for OK.
  const later = deps({ status: status({ active: "77778888" }), offer: null });
  assert.equal((await followCoreOnce(later.d)).did, "waiting");
});

test("after a swap's load the new page says plainly what runs, or why it couldn't switch (never silent)", async () => {
  const { swapOutcome, checkSwapOutcome, takeSwapExpect, expectSwap, EXPECT_KEY } = await import("../../src/coreFollow.ts");
  // The window's session storage (it survives the load): a plain one here.
  if (!(globalThis as { sessionStorage?: Storage }).sessionStorage) {
    const m = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
  }
  const e = { to: "abcd1234", kind: "follow" as const, at: Date.now() };
  assert.deepEqual(swapOutcome(e, status({ active: "abcd1234" })), { ok: true, text: "Now running frontend abcd1234." });
  const fell = swapOutcome(e, status({ bad: ["abcd1234"], events: [{ from: "abcd1234", to: "built-in", reason: "threw before it was ready: x is not a function", at_ms: 1 }] }));
  assert.deepEqual(fell, { ok: false, text: "Couldn't switch: threw before it was ready: x is not a function. Still on the installed app's own frontend." });
  assert.equal(swapOutcome({ ...e, kind: "back", to: "built-in" }, status()).text, "Back on the installed app's own frontend.");
  // Kept in the window's session across the load, taken once; the check waits for this load to say ready.
  expectSwap({ to: "abcd1234", kind: "follow" });
  assert.ok(sessionStorage.getItem(EXPECT_KEY));
  let n = 0;
  const native = async <T,>(cmd: string) => (assert.equal(cmd, "core_status"), status({ active: "abcd1234", ready: ++n >= 3 }) as T);
  assert.deepEqual(await checkSwapOutcome(native, { stepMs: 1 }), { ok: true, text: "Now running frontend abcd1234." });
  assert.equal(n, 3);
  assert.equal(takeSwapExpect(), null, "said once");
  assert.equal(await checkSwapOutcome(native), null, "no swap: nothing said");
  expectSwap({ to: "abcd1234", kind: "follow" }, Date.now() - 10 * 60_000);
  assert.equal(takeSwapExpect(), null, "an old one is not about this load");
});

test("the card's words: the titles of main's commits since the core this laptop runs", async () => {
  const { coreChangesSince, coreWhat, shortTitle } = await import("../../src/coreBundle.ts");
  const commits = [
    { commit: "6".repeat(40), time: 300, title: "Inline pages play their video and audio: relative mp4/webm refs are embedded" },
    { commit: "7".repeat(40), time: 200, title: "Free local voice by default: Kokoro + Whisper" },
    { commit: "8".repeat(40), time: 100, title: "Core builds no longer stall after the first: reaped" },
  ];
  assert.deepEqual(coreChangesSince(commits, { commit: "7".repeat(40), time: null }).map((c) => c.commit), ["6".repeat(40)]);
  assert.deepEqual(coreChangesSince(commits, { commit: "f".repeat(40), time: 150 }).length, 2, "not in the list: by its time");
  assert.equal(coreChangesSince(commits, { commit: null, time: null }).length, 3);
  assert.equal(shortTitle(commits[0]!.title), "Inline pages play their video and audio");
  assert.equal(coreWhat(commits.slice(0, 1), "6".repeat(40)), "new frontend: Inline pages play their video and audio");
  assert.equal(coreWhat(commits, "6".repeat(40), true), "new frontend, 3 changes");
  assert.equal(coreWhat(commits, "6".repeat(40)), "new frontend, 3 changes: Inline pages play their video and audio; Free local voice by default; Core builds no longer stall after the first");
  assert.equal(coreWhat([], "6".repeat(40)), "the app's frontend from main 666666666666");
});

test("a core's words: what Carl can see and behind-the-scenes fixes; a change's Look says where it shows", async () => {
  const { bundlePath, parseLooks, coreCard } = await import("../../src/coreBundle.ts");
  assert.deepEqual(bundlePath("src/InlineHtmlFrame.tsx"), { frontend: true, visible: true });
  assert.deepEqual(bundlePath("src/coreFollow.ts"), { frontend: true, visible: false });
  assert.deepEqual(bundlePath("src/x.test.tsx"), { frontend: false, visible: false });
  assert.deepEqual(bundlePath("server/voiceProvider.ts"), { frontend: false, visible: false });
  assert.deepEqual(parseLooks('[data-el="model-menu"] :: the model menu lists Fable\x1fthe chat scrolls smoother'), [
    { selector: '[data-el="model-menu"]', text: "the model menu lists Fable" },
    { selector: null, text: "the chat scrolls smoother" },
  ]);
  const look = { selector: '[data-el="model-menu"]', text: "the model menu lists Fable" };
  const c = (title: string, o: object) => ({ commit: "1".repeat(40), time: 1, title, ...o });
  const shown = coreCard([c("Model menu lists Fable: x", { frontend: true, visible: true, look: [look] }), c("Faster chat sync: y", { frontend: true, visible: false }), c("Box voice: z", { frontend: false, visible: false })], "1".repeat(40));
  assert.deepEqual(shown, { what: "new frontend: Model menu lists Fable", changes: ["Model menu lists Fable", "and 1 behind-the-scenes fix"], looks: [look], triable: true });
  const quiet = coreCard([c("Faster chat sync: y", { frontend: true, visible: false }), c("Box voice: z", { frontend: false, visible: false })], "1".repeat(40));
  assert.deepEqual(quiet, { what: "behind-the-scenes fixes, nothing to look at", changes: ["Faster chat sync"], looks: [], triable: false });
  assert.equal(coreCard([c("Box voice: z", { frontend: false, visible: false })], "1".repeat(40)).triable, false);
  assert.equal(coreCard(null, "1".repeat(40)).triable, true, "unknown (an older box)");
});
