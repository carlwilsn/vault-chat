// The model on the box (server/model/, report 24 §4) and its parity check: every way the app changes a moved noun is an
// action of that noun on the box, and every action the box has is one the app has. Listed from the app's own source,
// so a new control that bypasses the model fails here. Starting with settings (noun 1).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../convlog/log";
import { SETTING_KEYS } from "../../src/settingsRecords";
import { configureSettings } from "../settings";
import { NOUNS, nextChange, noun } from "../model";
import { actBoxOffer, readBoxOffer, watchBoxOffer } from "../boxOffers";
import { agentToolSpecs } from "../engine/engine";

const SRC = join(__dirname, "..", "..", "src");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const source = files(SRC).map((f) => [f.slice(SRC.length + 1), readFileSync(f, "utf8")] as const);

/** Every way the app changes a setting, as "set:<key>", read from its source. */
function uiSettingsActions(): { actions: Set<string>; exempt: string[] } {
  const actions = new Set<string>();
  const exempt: string[] = [];
  for (const [f, s] of source) {
    for (const m of s.matchAll(/(?<!function )saveSetting\(\s*("([^"]+)"|([A-Za-z_.]+))/g)) {
      if (m[2]) actions.add(`set:${m[2]}`);
      // A key the user picks from the whole list (the Settings plugin's change action): every setting.
      else if (f.startsWith("plugins/settings/")) for (const k of SETTING_KEYS) actions.add(`set:${k}`);
      else throw new Error(`${f}: saveSetting with a computed key (${m[3]}): name it, or add it here`);
    }
    // The composer's model picker: model and effort, through the engine (it also restarts the running session).
    if (/boxPost\([^)]*"\/api\/v1\/model"/.test(s)) ["model", "effort"].forEach((k) => actions.add(`set:${k}`));
    for (const m of s.matchAll(/boxPost\([^,]+,\s*"\/api\/v2\/settings",\s*\{\s*(\w+)/g)) {
      if (m[1] === "key") continue; // saveSetting itself
      if (m[1] === "migrate") exempt.push(`${f}: migrate (a laptop's own old settings moved once; not a control)`);
      else throw new Error(`${f}: POST /api/v2/settings {${m[1]}…}: a settings change the model has no action for`);
    }
  }
  return { actions, exempt };
}

const root = mkdtempSync(join(tmpdir(), "vc-model-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
beforeEach(() => {
  const dir = join(root, `log${++n}`);
  const log = new ConvLog(dir, null, join(dir, "events"));
  configureSettings({ log: () => log });
});
const deps = { vault: root };

describe("the model's settings noun", () => {
  it("parity: the app's settings changes are exactly the model's", () => {
    const { actions, exempt } = uiSettingsActions();
    const set = noun("settings")!.actions.set!.args as { properties: { key: { enum: string[] } } };
    const model = new Set(set.properties.key.enum.map((k) => `set:${k}`));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(Object.keys(noun("settings")!.actions)).toEqual(["set"]);
    expect(exempt.length).toBeLessThanOrEqual(1);
  });

  it("is box:settings: read, set by the agent, refused with nothing changed, and watched without re-reading", async () => {
    let r = await readBoxOffer(deps, "box:settings");
    expect((r.state!.values as any).theme).toMatchObject({ value: "graphite", set: "default" });
    const watched = watchBoxOffer(deps, "box:settings", 5_000);
    const a = await actBoxOffer(deps, "box:settings", "set", { key: "theme", value: "light" });
    expect(a.ok).toBe(true);
    expect(a.text).toBe('theme is now "light" (was "graphite"). Every open app and the phone follow it.');
    const w = await watched;
    expect(w.changed).toBe(true);
    expect((w.state!.values as any).theme).toMatchObject({ value: "light", set: "agent" });
    expect((await actBoxOffer(deps, "box:settings", "set", { key: "apiKey", value: "x" })).text).toMatch(/No setting "apiKey"; nothing changed/);
    expect((await actBoxOffer(deps, "box:settings", "set", { key: "theme", value: "purple" })).text).toMatch(/theme takes .*nothing changed/);
    r = await readBoxOffer(deps, "box:settings");
    expect((r.state!.values as any).theme.value).toBe("light");
    expect(await nextChange(noun("settings")!, 30)).toBe(false);
  });

  it("the engine's model and effort follow it", async () => {
    const { engineModel, engineEffort } = await import("../engine");
    const before = engineModel();
    await actBoxOffer(deps, "box:settings", "set", { key: "model", value: "sonnet" });
    await actBoxOffer(deps, "box:settings", "set", { key: "effort", value: "high" });
    expect(engineModel()).toBe("sonnet");
    expect(engineEffort()).toBe("high");
    await actBoxOffer(deps, "box:settings", "set", { key: "model", value: null });
    expect(engineModel()).toBe(before);
  });

  it("a moved noun has no tool of its own", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const x of NOUNS) expect(names).not.toContain(x.name);
  });
});
