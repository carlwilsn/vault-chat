// Ctrl+K / Ctrl+L changing the app (Carl, 2026-11-17: "turn off the snail, make it say shail" ended in "ask me again in
// Main"). The box's agent now has PluginWrite (the plugin folders only: a vault plugin lands live, turned on, Switch back
// undoes it) and Handoff (a new chat with every tool does what it can't; its answer comes back to the box, or as an alert).
// The side runner here is a stand-in for the model: it calls the tools the engine bound to the request, as the CLI would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRig, until, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { pluginWriteTarget } from "../pluginWriteTool";

let rig: Rig;
const sides: any[] = [];
/** What the "model" does with a request: called with the engine's tool handler and the request. */
let script: (call: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }>, o: any) => Promise<string> = async () => "ok";
const results = new Map<string, { text: string; done: boolean }>();

const CURSOR = (word: string) =>
  `export const meta = { name: "${word} cursor" };\nexport function mount(el, api) {\n  const s = document.createElement("style");\n  s.textContent = "html * { cursor: text !important }"; // ${word}\n  document.head.appendChild(s);\n  api.effect(() => s.remove());\n}\n`;

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
const plugins = () => join(rig.vault, ".vault-chat", "plugins");

describe("Ctrl+L can change the app", () => {
  it("lists the scoped write and enable tools (and the handoff) for the box", async () => {
    script = async () => "ok";
    await ask("what tools?");
    const names = sides.at(-1).hostTools.map((t: any) => t.name);
    for (const n of ["PluginWrite", "Plugins", "Settings", "Handoff", "ProposeEdit"]) expect(names).toContain(n);
  });

  it("\"make my cursor show the text 'hi'\": the plugin file is written, live and on; no \"go to Main\"", async () => {
    // The snail is there and he turned it off first (the ask of 2026-11-17).
    mkdirSync(plugins(), { recursive: true });
    writeFileSync(join(plugins(), "snail-cursor.js"), CURSOR("snail"));
    script = async (call) => {
      const off = await call("Plugins", { action: "disable", plugin: "snail-cursor" });
      expect(off.ok).toBe(true);
      const w = await call("PluginWrite", { path: ".vault-chat/plugins/hi-cursor.js", content: CURSOR("hi"), reason: "cursor shows hi" });
      expect(w.ok).toBe(true);
      return `Done: your cursor shows "hi". ${w.text}`;
    };
    const done = await ask("make my cursor show the text 'hi'");
    expect(done.text).not.toMatch(/Main/);
    expect(readFileSync(join(plugins(), "hi-cursor.js"), "utf8")).toContain("// hi");
    expect(existsSync(join(plugins(), "hi-cursor.draft.js"))).toBe(false);
    const { pluginDesired } = await import("../supervisor");
    expect(pluginDesired(rig.vault, ".vault-chat/plugins/hi-cursor.js").state).toBe("running");
    expect(pluginDesired(rig.vault, ".vault-chat/plugins/snail-cursor.js").state).toBe("stopped");
  });

  it("editing a plugin that was off: live, on again, and Switch back undoes it", async () => {
    script = async (call) => (await call("PluginWrite", { path: ".vault-chat/plugins/snail-cursor.js", oldText: "// snail", newText: "// shail" })).text;
    const done = await ask("make the snail say shail");
    expect(done.text).toMatch(/live now/);
    expect(readFileSync(join(plugins(), "snail-cursor.js"), "utf8")).toContain("// shail");
    expect(readFileSync(join(plugins(), "snail-cursor.prev.js"), "utf8")).toContain("// snail");
    const { pluginDesired } = await import("../supervisor");
    expect(pluginDesired(rig.vault, ".vault-chat/plugins/snail-cursor.js").state).toBe("running");
    script = async (call) => (await call("Plugins", { action: "back", plugin: ".vault-chat/plugins/snail-cursor.js" })).text;
    await ask("switch it back");
    expect(readFileSync(join(plugins(), "snail-cursor.js"), "utf8")).toContain("// snail");
  });

  it("writes nothing outside the plugin folders; drafts wait as Change ready", async () => {
    expect("error" in pluginWriteTarget("Hi.md")).toBe(true);
    expect("error" in pluginWriteTarget(".vault-chat/plugins/../conversations/x.js")).toBe(true);
    expect("error" in pluginWriteTarget(".vault-chat/box-plugins/x.js")).toBe(true);
    expect("error" in pluginWriteTarget("/etc/passwd")).toBe(true);
    expect(pluginWriteTarget(".vault-chat/box-plugins/greet.draft.js")).toMatchObject({ kind: "draft" });
    expect(pluginWriteTarget(".vault-chat/app-plugins/composer.draft.js")).toMatchObject({ kind: "draft" });
    let out = { ok: true, text: "" };
    script = async (call) => ((out = await call("PluginWrite", { path: ".vault-chat/notes.jsonl", content: "x" })), out.text);
    await ask("write my notes file");
    expect(out.ok).toBe(false);
    script = async (call) => ((out = await call("PluginWrite", { path: ".vault-chat/plugins/broken.js", content: "console.log(1)" })), out.text);
    await ask("a plugin with no mount");
    expect(out.ok).toBe(false);
    expect(existsSync(join(plugins(), "broken.js"))).toBe(false);
    script = async (call) => ((out = await call("PluginWrite", { path: ".vault-chat/plugins/hi-cursor.draft.js", content: CURSOR("hey") })), out.text);
    await ask("draft a hey cursor for me to try");
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/Nothing reaches Carl yet: Plugins submit runs it through the gate/);
    expect(readFileSync(join(plugins(), "hi-cursor.js"), "utf8")).toContain("// hi");
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
