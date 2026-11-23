// The parity check against the offers the parts really declare, not a list (reports/21-design 9). Each app part's
// offers are built by its own factory (the object it hands api.offer); a control on screen that names an offer
// (data-offer="app/<part>.<action>") must name an action that object has. Together with the ratchet in
// server/test/agencyCoverage.test.ts (a new control must name its offer or an exemption), a change that adds something
// visible without exposing it to the agent fails the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-parity-"));
const ROOT = join(import.meta.dirname, "..", "..");
const { controlsIn, uiControlFiles } = await import("../../server/test/agencyControls.ts");
const { APP_PLUGINS } = await import("../../src/appPlugins.ts");

/** A stand-in for whatever a factory takes (a host, a view, an emit): any property or call gives it back. */
const stub: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub), apply: () => stub });

const watched = new Map<string, boolean>();
/** Each part's offers, built by its own factory: part id → its action names (and whether it declares a watch). */
async function runningOffers(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const dir of readdirSync(join(ROOT, "src", "plugins"))) {
    const entry = ["index.tsx", "index.ts"].map((f) => join(ROOT, "src", "plugins", dir, f)).find(existsSync);
    if (!entry) continue;
    const m = (await import(entry)) as Record<string, unknown>;
    const acts = new Set<string>();
    for (const [k, f] of Object.entries(m)) {
      if (!/Offers$/.test(k) || typeof f !== "function") continue;
      const o = (f as (...a: unknown[]) => { actions?: Record<string, unknown>; state?: Record<string, unknown>; watch?: unknown })(stub, stub, stub);
      for (const a of Object.keys(o?.actions ?? {})) acts.add(a);
      if (o?.state || o?.actions) {
        out.set(`app/${dir}`, acts);
        watched.set(`app/${dir}`, typeof o?.watch === "function");
      }
    }
  }
  return out;
}

test("every app part builds offers (its factory runs), and every part listed in the app is one of them", async () => {
  const offers = await runningOffers();
  const parts = APP_PLUGINS.map((p) => p.id).filter((id) => existsSync(join(ROOT, "src", "plugins", id.replace(/^app\//, ""))));
  assert.deepEqual(parts.filter((p) => !offers.has(p)), [], "a part with no offers factory: the agent can't reach it");
  assert.ok(offers.get("app/notes")!.has("openComposer"));
  assert.ok(!offers.get("app/notes")!.has("add"), "the notes themselves are box:notes (one route)");
  assert.ok(!offers.get("app/settings")!.has("set"), "the settings' values are box:settings (one route)");
  assert.ok(!offers.get("app/chats")!.has("rename"), "renaming chats is box:chats (one route)");
  assert.ok(!offers.get("app/chat")!.has("setFullscreen") && !offers.get("app/titlebar")!.has("toggleLeftPanel"), "the layout is box:workspace (one route)");
});

/** The box's offers (the model's nouns and the box's own): box:<id> → its action names. */
async function boxActions(): Promise<Map<string, Set<string>>> {
  const { boxOffers } = await import("../../server/boxOffers.ts");
  const ctl = new Proxy({}, { get: () => () => ({}) });
  const all = boxOffers({ vault: makeTempVault("vc-parity-box-"), stateDir: makeTempVault("vc-parity-state-"), jobs: ctl as never, chats: ctl as never });
  return new Map(all.map((o) => [o.id, new Set(Object.keys(o.actions))]));
}

test("a control's data-offer names an action its part (or the box's noun) really offers", async () => {
  const offers = await runningOffers();
  const box = await boxActions();
  const bad: string[] = [];
  for (const c of uiControlFiles(ROOT).flatMap((f: string) => controlsIn(ROOT, f))) {
    if (!c.offer) continue;
    const m = /^(app\/[\w-]+|box:[\w-]+)\.(\w+)$/.exec(c.offer);
    const has = m ? (m[1]!.startsWith("box:") ? box.get(m[1]!) : offers.get(m[1]!)) : undefined;
    if (!m || !has?.has(m[2]!)) bad.push(`${c.file}: data-offer="${c.offer}" (${m ? `${m[1]} offers: ${[...(has ?? [])].join(", ") || "nothing"}` : 'write it "app/<part>.<action>" or "box:<noun>.<action>"'})`);
  }
  assert.deepEqual(bad, []);
});

test("every app part says when its state changes (offers.watch), so Carl's own changes wake a watch", async () => {
  await runningOffers();
  assert.deepEqual([...watched].filter(([, w]) => !w).map(([id]) => id), [], "a part with state needs watch: (fn) => unsubscribe over the stores its state reads");
});
