// The laptop following the box's core bundle (src/coreFollow.ts): it asks the native loader (core_status), tells the
// box about the loader's fallbacks (a plugin.change switch by "auto", only while the box still offers what failed),
// has the loader fetch and check a newer compatible bundle, and takes it only at a quiet moment; an app from before the
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

function deps(o: { status?: CoreStatus | null; offer?: unknown; boxApi?: number; quiet?: boolean; installFails?: string; boxDown?: boolean } = {}) {
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
    quiet: () => o.quiet ?? true,
  };
  return { d, calls, posts, cmds: () => calls.map((c) => c.cmd) };
}

test("a newer compatible bundle is fetched and checked by the loader, then taken at a quiet moment", async () => {
  const t = deps();
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(t.cmds(), ["core_status", "core_install", "core_use"]);
  assert.deepEqual(t.calls[1]!.args, { baseUrl: "https://box.example.ts.net", token: "t", version: OFFER.version, sha256: OFFER.sha256 });
  assert.deepEqual(t.calls[2]!.args, { version: OFFER.version });
});

test("while Carl is working (or has text in the composer) it is only installed: no reload under him", async () => {
  const t = deps({ quiet: false });
  assert.equal((await followCoreOnce(t.d, { swap: true })).did, "installed");
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

test("the box's core publishing turned off: back to the installed app's own core, at a quiet moment", async () => {
  const t = deps({ status: status({ active: "11112222" }), offer: null });
  t.d.get = async () => ({ boxApi: CORE_BOX_API, publish: false, offer: null });
  const r = await followCoreOnce(t.d, { swap: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: null } });
});

// ---------------------------------------------------------------- Change ready: Try, Back, a tried bundle that fails

test("while Carl tries a bundle (Change ready), following leaves it running: no swap to the kept core under him", async () => {
  const t = deps({ status: status({ active: "77778888" }), offer: null });
  t.d.tried = () => "77778888";
  const r = await followCoreOnce(t.d, { swap: true, now: true });
  assert.equal(r.did, "nothing");
  assert.match((r.step as { why: string }).why, /trying 77778888/);
  assert.ok(!t.cmds().includes("core_use"));
});

test("a tried bundle the loader fell back from is discarded by itself (with why), and the core in effect runs", async () => {
  const ev = { from: "77778888", to: "built-in", reason: "did not say ready within 30 s", at_ms: 1 };
  const t = deps({ status: status({ active: "built-in", events: [ev], bad: ["77778888"] }), offer: null });
  let tried: string | null = "77778888";
  const failed: [string, string][] = [];
  t.d.tried = () => tried;
  t.d.triedFailed = (v, why) => {
    failed.push([v, why]);
    tried = null;
  };
  const r = await followCoreOnce(t.d, { swap: true });
  assert.deepEqual(failed, [["77778888", "the loader fell back from it: did not say ready within 30 s"]]);
  assert.deepEqual(t.posts, [], "not a switch of the kept core: the tried one was never kept");
  assert.equal(r.did, "nothing");
});

test("Back / Discard / Switch back (now): the core in effect is taken at once, busy or not, after the screen is kept", async () => {
  const t = deps({ status: status({ active: "77778888" }), offer: null, quiet: false });
  const order: string[] = [];
  t.d.beforeSwap = async () => void order.push("kept the screen");
  const native = t.d.native;
  t.d.native = async (cmd, args) => (cmd === "core_use" && order.push("core_use"), native(cmd, args));
  const r = await followCoreOnce(t.d, { swap: true, now: true });
  assert.equal(r.did, "swapped");
  assert.deepEqual(order, ["kept the screen", "core_use"]);
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: null } });
  // Not asked for (the periodic look) while he is busy: it waits.
  const later = deps({ status: status({ active: "77778888" }), offer: null, quiet: false });
  assert.equal((await followCoreOnce(later.d, { swap: true })).did, "waiting");
});

test("Try: the loader fetches and checks the bundle, the screen is kept, then it loads; one this laptop can't run is refused with why", async () => {
  const { tryCore, candidateProblem } = await import("../../src/coreFollow.ts");
  const c = { sha256: OFFER.sha256, commit: OFFER.commit, commitTime: 300, needs: OFFER.needs, boxApi: CORE_BOX_API };
  const t = deps();
  const order: string[] = [];
  t.d.beforeSwap = async () => void order.push("kept the screen");
  const native = t.d.native;
  t.d.native = async (cmd, args) => (order.push(cmd), native(cmd, args));
  await tryCore("abcd1234", c, t.d);
  assert.deepEqual(order, ["core_status", "core_install", "kept the screen", "core_use"]);
  assert.deepEqual(t.calls.find((x) => x.cmd === "core_install")!.args, { baseUrl: "https://box.example.ts.net", token: "t", version: "abcd1234", sha256: OFFER.sha256 });
  assert.deepEqual(t.calls.at(-1), { cmd: "core_use", args: { version: "abcd1234" } });
  const s = status();
  assert.equal(candidateProblem("abcd1234", c, s), null);
  assert.match(String(candidateProblem("abcd1234", { ...c, needs: { ...c.needs, commands: ["brand_new"] } }, s)), /newer installed app/);
  assert.match(String(candidateProblem("abcd1234", { ...c, commitTime: 50 }, s)), /installed app's own core/);
  assert.match(String(candidateProblem("abcd1234", c, { ...s, bad: ["abcd1234"] })), /failed here before/);
  await assert.rejects(tryCore("abcd1234", c, deps({ status: null }).d), /no core loader/);
  await assert.rejects(tryCore("abcd1234", { ...c, commitTime: 50 }, deps().d), /installed app's own core/);
});
