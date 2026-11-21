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

/** Each part's offers, built by its own factory: part id → its action names. */
async function runningOffers(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const dir of readdirSync(join(ROOT, "src", "plugins"))) {
    const entry = ["index.tsx", "index.ts"].map((f) => join(ROOT, "src", "plugins", dir, f)).find(existsSync);
    if (!entry) continue;
    const m = (await import(entry)) as Record<string, unknown>;
    const acts = new Set<string>();
    for (const [k, f] of Object.entries(m)) {
      if (!/Offers$/.test(k) || typeof f !== "function") continue;
      const o = (f as (...a: unknown[]) => { actions?: Record<string, unknown>; state?: Record<string, unknown> })(stub, stub, stub);
      for (const a of Object.keys(o?.actions ?? {})) acts.add(a);
      if (o?.state || o?.actions) out.set(`app/${dir}`, acts);
    }
  }
  return out;
}

test("every app part builds offers (its factory runs), and every part listed in the app is one of them", async () => {
  const offers = await runningOffers();
  const parts = APP_PLUGINS.map((p) => p.id).filter((id) => existsSync(join(ROOT, "src", "plugins", id.replace(/^app\//, ""))));
  assert.deepEqual(parts.filter((p) => !offers.has(p)), [], "a part with no offers factory: the agent can't reach it");
  assert.ok(offers.get("app/notes")!.has("add"));
});

test("a control's data-offer names an action its part really offers", async () => {
  const offers = await runningOffers();
  const bad: string[] = [];
  for (const c of uiControlFiles(ROOT).flatMap((f: string) => controlsIn(ROOT, f))) {
    if (!c.offer) continue;
    const m = /^(app\/[\w-]+)\.(\w+)$/.exec(c.offer);
    if (!m || !offers.get(m[1]!)?.has(m[2]!)) bad.push(`${c.file}: data-offer="${c.offer}" (${m ? `${m[1]} offers: ${[...(offers.get(m[1]!) ?? [])].join(", ") || "nothing"}` : 'write it "app/<part>.<action>"'})`);
  }
  assert.deepEqual(bad, []);
});
