// Ctrl+K / Ctrl+L changing the app (Carl, 2026-11-17: "turn off the snail, make it say shail" ended in "ask me again in
// Main"). The box's agent changes the app's state with the same model actions the app calls (PluginAct box:pages,
// box:settings, box:workspace) and hands a code change to Handoff (a new chat with every tool, real code; its answer
// comes back to the box, or as an alert). No vault-plugin overlay (constitution 2.1, 2026-11-23).
// The side runner here is a stand-in for the model: it calls the tools the engine bound to the request, as the CLI would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRig, until, type Rig } from "./longRig";
import { cleanup } from "./helpers";

let rig: Rig;
const sides: any[] = [];
/** What the "model" does with a request: called with the engine's tool handler and the request. */
let script: (call: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }>, o: any) => Promise<string> = async () => "ok";
const results = new Map<string, { text: string; done: boolean }>();

const CURSOR = (word: string) =>
  `<!doctype html><title>${word} cursor</title><meta name="vc-mount" content="in-process">\n<script type="module">export function mount(el, api) {}</script>\n`;

beforeAll(async () => {
  rig = await makeRig({ deps: { handoffWaitMs: 4_000 } });
  const b = rig.backend as any;
  b.paths = { sessionsDir: join(rig.root, "pi", "sessions"), instrDir: join(rig.root, "pi", "instr") };
  b.threadSource = () => null;
  b.side = {
    start: async (o: any) => {
      sides.push(o);
      const id = `side${sides.length}`;
      results.set(id, { text: "", done: false });
      const call = async (name: string, args: unknown) => {
        if (!o.hostTools.some((t: any) => t.name === name)) return { ok: false, text: `${name} is not bound` };
        return b.h.sideTool(o.you?.convId ?? null, name, args, new AbortController().signal);
      };
      void script(call, o).then((text) => results.set(id, { text, done: true }));
      return { id, text: "", v: 0, done: false, error: null, file: null };
    },
    wait: async (id: string) => {
      await until(() => results.get(id)!.done, 30_000);
      return { id, text: results.get(id)!.text, v: 1, done: true, error: null, file: null };
    },
  };
});
afterAll(() => {
  rig?.engine.stop();
  cleanup(rig?.root);
});

const ask = async (text: string) => {
  const r = await rig.engine.sideStart({ kind: "inline", text, editable: true, doc: { text: "Hi\n", from: 0, to: 0 } });
  expect(r.ok).toBe(true);
  return (rig.backend as any).side.wait(r.id);
};
const plugins = () => join(rig.vault, "pages");

describe("Ctrl+L can change the app", () => {
  it("lists the model actions and the handoff for the box; no plugin-writing overlay", async () => {
    script = async () => "ok";
    await ask("what tools?");
    const names = sides.at(-1).hostTools.map((t: any) => t.name);
    for (const n of ["PluginAct", "Handoff", "ProposeEdit"]) expect(names).toContain(n);
    expect(names).not.toContain("PluginWrite");
  });

  it("\"turn off the snail cursor\": the same box:pages action the app calls", async () => {
    mkdirSync(plugins(), { recursive: true });
    writeFileSync(join(plugins(), "snail-cursor.html"), CURSOR("snail"));
    script = async (call) => {
      const off = await call("PluginAct", { plugin: "box:pages", action: "disable", args: { plugin: "snail-cursor" } });
      expect(off.ok).toBe(true);
      return "Done: the snail cursor is off.";
    };
    const done = await ask("turn off the snail cursor");
    expect(done.text).not.toMatch(/Main/);
    const { pluginDesired } = await import("../supervisor");
    expect(pluginDesired(rig.vault, "pages/snail-cursor.html").state).toBe("stopped");
  });

  it("hands what it can't do to a new chat and reports its answer in the box", async () => {
    const before = rig.backend.turns.length;
    const ended = (async () => {
      await until(() => rig.backend.turns.length > before);
      const tid = rig.backend.turns[before].threadId;
      rig.backend.ev(tid, { kind: "text", text: "Renamed the folder to Physics 2." });
      rig.backend.end(tid);
    })();
    script = async (call) => (await call("Handoff", { request: "Rename the folder Phys to Physics 2 in school2.", title: "Rename Phys" })).text;
    const done = await ask("rename the Phys folder to Physics 2");
    await ended;
    expect(done.text).toContain("Renamed the folder to Physics 2.");
    const chats = await rig.allConvs();
    const hand = chats.find((c: any) => c.title === "Rename Phys");
    expect(hand).toBeTruthy();
    expect(JSON.stringify(rig.backend.turns[before])).toContain("Rename the folder Phys to Physics 2");
  });

  it("a long handoff answers in the box at once and sends the result as an alert when it ends", async () => {
    const before = rig.backend.turns.length;
    script = async (call) => (await call("Handoff", { request: "Build a big dashboard plugin.", title: "Dashboard" })).text;
    const done = await ask("build me a dashboard");
    expect(done.text).toMatch(/alert/);
    const tid = rig.backend.turns[before].threadId;
    rig.backend.ev(tid, { kind: "text", text: "The dashboard is in .vault-chat/plugins/dashboard.js." });
    rig.backend.end(tid);
    await until(() => rig.pings.some((p: any) => p.title === "Done: Dashboard" && /dashboard\.js/.test(p.body)));
  }, 20_000);
});
