// The Try redesign (src/changeFlow.ts): no card, no glow; a change is a line in the chat. Box mode, Main.
//   1. Carl asks for a change; the agent submits the draft; nothing on screen changes while the gate runs.
//   2. The gate passed (the fake box writes what the real one does: a keep by "gate" and the "Done: <what>" line):
//      the Send button turns green, and the line has Undo. Undo: the record, and it is gone.
//   3. A draft the gate let through that breaks the chat pane (it stops drawing; nothing throws): applied, the dead-man's
//      switch (src/changeSafety.ts) sees the chat not drawn three checks in a row and switches it back by itself; the
//      chat says so ("Undid … by itself: the chat stopped responding.").
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";
import { versionOf } from "../../src/pluginDrafts";
import { changeLineId, doneText } from "../../src/changeFlow";
import type { MemoryBox } from "../../src/convlog/memoryBox";

const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };

const GREEN = `// @vc-change the Send button is green
export const meta = { name: "Send colour" };
export function mount(el, api) {
  const s = document.createElement("style");
  s.textContent = '[data-el="composer-send"] { background: #16a34a !important; color: #fff !important; box-shadow: 0 0 0 3px rgb(22 163 74 / .35) !important; }';
  document.head.appendChild(s);
  api.effect(() => s.remove());
}
`;
const BROKEN = `// @vc-change the chat uses the full width
export const meta = { name: "Wide chat" };
export function mount(el, api) {
  // The bug: the chat pane stops drawing. Nothing throws, so only the dead-man's switch can see it.
  const host = document.querySelector('[data-el="chat-pane-host"]');
  if (host) host.style.visibility = "hidden";
  api.effect(() => { if (host) host.style.visibility = ""; });
}
`;
const GREEN_V = versionOf(GREEN);
const BROKEN_V = versionOf(BROKEN);
const GREEN_ID = ".vault-chat/plugins/send-colour.js";
const BROKEN_ID = ".vault-chat/plugins/wide-chat.js";

const keep = (box: MemoryBox, plugin: string, version: string, what: string) => {
  box.emit(null, { type: "signal", signal: { type: "plugin.change", plugin, change: "keep", version, from: "built-in", at: Date.now(), by: "gate", what, conv: "main", reason: "asked for; the draft check passed" } } as any);
  box.note("main", changeLineId("done", plugin, version), { kind: "notice", text: doneText(what), change: { plugin, version, offer: "undo" } });
};
const ask = (box: MemoryBox, said: string, reply: string, plugin: string) => {
  box.startTurn("main");
  box.userLine("main", `u-${plugin}`, said);
  box.say("main", reply);
  box.tool("main", `t-${plugin}`, "Plugins", { action: "submit", plugin, asked: true }, `Checking ${plugin.split("/").pop()} on a copy of your data. Nothing reaches the laptop until it passes.`);
  box.endTurn("main");
};

const next: Step = { run: () => (window as any).__preview.boxNext() };

export const tryFlowScenarios: Scenario[] = [
  {
    id: "try-flow",
    title: "Changes as chat lines — asked: gate, then Done + Undo; a broken one reverts by itself",
    group: "Changes",
    clock: "2026-11-19T15:00:00",
    notes:
      "Box mode, Main. Carl asks for a green Send button: the agent submits the draft and nothing changes while the gate runs (no card, no glow). The gate passed: the Send button is green and the chat says \"Done: the Send button is green\" with Undo; Undo takes it away. Then a draft the gate let through that stops the chat pane drawing: the app's dead-man's switch sees it (three checks, about 12 s) and switches it back by itself; the chat says so.",
    build: (ctx) => {
      P3.build(ctx);
      ctx.write(".vault-chat/plugins/send-colour.draft.js", GREEN);
      ctx.write(".vault-chat/plugins/wide-chat.draft.js", BROKEN);
    },
    host: {
      sync: {
        box: BOX,
        boxChat: {
          convs: {
            main: { title: "Main", source: "main", meta: { kind: "main" }, messages: [{ role: "user", content: "morning" }, { role: "assistant", content: "Morning! What are we working on?" }] },
          },
          steps: [
            { log: (b) => ask(b, "Make the Send button green so I can find it.", "On it. I'll check it on a copy of your data first; nothing on your screen changes until it passes.", GREEN_ID) },
            { log: (b) => keep(b, GREEN_ID, GREEN_V, "the Send button is green") },
            { log: (b) => ask(b, "Let the chat use the full width.", "Checking that one the same way.", BROKEN_ID) },
            { log: (b) => keep(b, BROKEN_ID, BROKEN_V, "the chat uses the full width") },
          ],
          live: true,
        },
      },
    } as any,
    activeConversation: "main",
    open: [
      { chat: true },
      { conversation: "main" },
      { sleep: 2500 },
      next,
      { sleep: 4000 },
      next,
      { wait: '[data-el="change-undo"]', timeout: 8000 },
      { sleep: 5000 },
      { click: '[data-el="change-undo"]' },
      { wait: '[data-el="change-line"][data-vc-state="undone"]', timeout: 8000 },
      { sleep: 4000 },
      next,
      { sleep: 4000 },
      next,
      // The dead-man's switch: about 12 s of the chat not drawn, then it is switched back by itself.
      {
        run: async () => {
          for (let t = Date.now(); Date.now() - t < 45_000; await new Promise((r) => setTimeout(r, 250)))
            if (document.querySelectorAll('[data-el="change-line"][data-vc-state="undone"]').length >= 2) return;
          throw new Error("the broken change was not switched back by itself");
        },
      },
      { sleep: 2500 },
    ],
  },
];
