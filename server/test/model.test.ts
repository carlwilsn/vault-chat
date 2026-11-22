// The model on the box (server/model/, report 24 §4) and its parity check: every way the app changes a moved noun is an
// action of that noun on the box, and every action the box has is one the app has. Listed from the app's own source,
// so a new control that bypasses the model fails here. Settings (noun 1), notes (noun 2).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../convlog/log";
import { SETTING_KEYS } from "../../src/settingsRecords";
import { configureSettings } from "../settings";
import { nextChange, noun, nouns } from "../model";
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
const PHONE = join(__dirname, "..", "..", "phone", "src");
const phone = files(PHONE).map((f) => [`phone/${f.slice(PHONE.length + 1)}`, readFileSync(f, "utf8")] as const);

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

/** Every way the app and the phone change a note, as the notes noun's action names, read from their source. */
const ROUTE: Record<string, string[]> = { "/notes/edit": ["edit"], "/notes/status": ["resolve", "reopen"], "/notes/delete": ["delete"], "/notes/clear-resolved": ["clearResolved"] };
const NOTE_ACTION: Record<string, string> = { edit: "/notes/edit", status: "/notes/status", delete: "/notes/delete", "clear-resolved": "/notes/clear-resolved" };
const HOST_NOTES: Record<string, string[]> = { add: ["add"], saveDraft: ["edit"], setStatus: ["resolve", "reopen"], remove: ["delete"], clearResolved: ["clearResolved"] };
/** Panel controls that are not a change to a note (each named, with why). */
const HOST_NOTES_EXEMPT: Record<string, string> = { reformat: "re-summarize: rebuilds the cached summary on the laptop (an AI call); the note's own text is unchanged" };
/** Whole-file note writes that are not one of Carl's controls (each file named, with why). */
const NOTE_WRITES_EXEMPT: Record<string, string> = {
  "store.ts": "rename/delete cascades rewrite anchors, the summary cache, and the no-box fallback of each control",
  "hostBackend.ts": "the no-box fallback of edit",
  "notes.ts": "the write itself and compactNotes (dedupe, no box)",
};
function uiNotesActions(): { actions: Set<string>; exempt: string[] } {
  const actions = new Set<string>();
  const exempt: string[] = [];
  for (const [f, s] of [...source, ...phone]) {
    for (const m of s.matchAll(/["'`](\/notes(?:\/[a-z-]+)?)["'`]/g)) {
      const r = m[1]!;
      if (r === "/notes") {
        // POST /notes: add (the app's {note} built from a capture, the phone's {text}); GET /notes reads.
        if (/method:\s*"POST"|boxPost/.test(s)) actions.add("add");
      } else if (r === "/notes/write") {
        if (f !== "notes.ts") throw new Error(`${f}: a whole-file notes write (/notes/write) outside src/notes.ts`);
      } else if (ROUTE[r]) ROUTE[r]!.forEach((a) => actions.add(a));
      else if (!f.startsWith("phone/mock")) throw new Error(`${f}: ${r}: a notes route the model has no action for`);
    }
    for (const m of s.matchAll(/noteAction\([^,]+,\s*"([a-z-]+)"/g)) {
      const r = NOTE_ACTION[m[1]!];
      if (!r) throw new Error(`${f}: noteAction "${m[1]}": the model has no such action`);
      ROUTE[r]!.forEach((a) => actions.add(a));
    }
    if (f.startsWith("plugins/notes/")) for (const m of s.matchAll(/host\.notes\.(\w+)/g)) {
      if (HOST_NOTES_EXEMPT[m[1]!]) {
        exempt.push(`${f}: host.notes.${m[1]}: ${HOST_NOTES_EXEMPT[m[1]!]}`);
        continue;
      }
      const to = HOST_NOTES[m[1]!];
      if (!to) throw new Error(`${f}: host.notes.${m[1]}: a notes control the model has no action for`);
      to.forEach((a) => actions.add(a));
    }
    if (/\bwriteAllNotes\(/.test(s) && !f.startsWith("phone/")) {
      if (!NOTE_WRITES_EXEMPT[f]) throw new Error(`${f}: writes the notes file whole: call the box's notes action (noteAction) instead, or name why here`);
      exempt.push(`${f}: ${NOTE_WRITES_EXEMPT[f]}`);
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
    const set = noun("settings", deps)!.actions.set!.args as { properties: { key: { enum: string[] } } };
    const model = new Set(set.properties.key.enum.map((k) => `set:${k}`));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(Object.keys(noun("settings", deps)!.actions)).toEqual(["set"]);
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
    expect(await nextChange(noun("settings", deps)!, 30)).toBe(false);
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
    for (const x of nouns(deps)) expect(names).not.toContain(x.name);
  });
});

describe("the model's notes noun", () => {
  it("parity: the app's and the phone's note controls are exactly the model's", () => {
    const { actions, exempt } = uiNotesActions();
    const model = new Set(Object.keys(noun("notes", deps)!.actions));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(new Set(exempt).size).toBeLessThanOrEqual(Object.keys(NOTE_WRITES_EXEMPT).length + Object.keys(HOST_NOTES_EXEMPT).length);
  });

  it("is box:notes: added, edited in place, resolved, cleared, and watched without re-reading", async () => {
    const watched = watchBoxOffer(deps, "box:notes", 5_000);
    const a = await actBoxOffer(deps, "box:notes", "add", { text: "buy chalk" });
    expect(a.ok, a.text).toBe(true);
    const w = await watched;
    expect(w.changed).toBe(true);
    const id = (w.state!.open as any[])[0].id as string;
    expect((w.state!.open as any[])[0].text).toBe("buy chalk");
    expect((await actBoxOffer(deps, "box:notes", "edit", { id, text: "buy chalk and erasers" })).text).toContain(`Updated note ${id} in place`);
    expect((await actBoxOffer(deps, "box:notes", "resolve", { id })).ok).toBe(true);
    let r = await readBoxOffer(deps, "box:notes");
    expect(r.state!.open).toEqual([]);
    expect((r.state!.resolved as any[])[0]).toMatchObject({ id, text: "buy chalk and erasers" });
    expect((await actBoxOffer(deps, "box:notes", "clearResolved", {})).text).toBe("Cleared 1 resolved note(s) from the Notes panel (git history keeps them).");
    r = await readBoxOffer(deps, "box:notes");
    expect(r.state!.resolved).toEqual([]);
    expect((await actBoxOffer(deps, "box:notes", "delete", { id: "nope" })).text).toMatch(/no note with id "nope".*nothing changed/);
    expect(await nextChange(noun("notes", deps)!, 30)).toBe(false);
  });
});
