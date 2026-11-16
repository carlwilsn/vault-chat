// The phone app as a plugin host (phone/src/plugins.ts): the vault plugins whose meta names the phone are mounted with
// the laptop's host and api, follow the supervisor's records, draw the phone's chat rows (a throw falls back to the
// phone's own row), follow app/chat-rows' kept choices, and are reached by the agent through the offers registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { LoadModule } from "../../src/mountHost.ts";
import { vaultPluginDevices, vaultPluginRunsOn } from "../../src/vaultPlugins.ts";
import { _resetRows } from "../../src/chatRows.ts";
import { _resetOffers, answerPluginSignal } from "../../src/pluginOffers.ts";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
(globalThis as any).document = document;
const { startPhoneHost } = await import("../../phone/src/plugins.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const THEME = { mode: "dark" as const, vars: {} };
const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };

test("a plugin's meta says where it mounts; none named is the laptop only", () => {
  assert.deepEqual(vaultPluginDevices("export function mount(){}"), ["laptop"]);
  assert.deepEqual(vaultPluginDevices(`export const meta = { name: "X", devices: "laptop, phone" };`), ["laptop", "phone"]);
  assert.deepEqual(vaultPluginDevices(`export const meta = { devices: ["phone"] };`), ["phone"]);
  assert.deepEqual(vaultPluginDevices(`export const meta = { devices: "toaster" };`), ["laptop"]);
  assert.ok(vaultPluginRunsOn(`export const meta = { devices: ['phone'] }`, "phone"));
  assert.ok(!vaultPluginRunsOn(`export const meta = { devices: ['phone'] }`, "laptop"));
});

type Box = { records: any[]; plugins: { id: string; name: string; code: string }[]; state: Record<string, unknown>; seq: number };
function fakeApi(box: Box) {
  return async (path: string) => {
    const body = path.startsWith("/api/v2/supervisor")
      ? { seq: box.records.length, records: box.records }
      : path.startsWith("/api/v2/plugin/device")
        ? { device: "phone", plugins: box.plugins }
        : path.startsWith("/api/v2/plugin/app-state")
          ? { seq: box.seq, state: box.state }
          : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

// The code text names what the module does: "rows" draws assistant rows and offers a state; "throw" draws by throwing.
const load: LoadModule = async (code) => {
  const module = {
    mount(el: HTMLElement, api: any) {
      assert.equal(api.device, "phone");
      if (code.includes("rows")) {
        api.host.chat.row("assistant", (row: HTMLElement, r: any) => {
          if (code.includes("throw")) throw new Error("renderer broke");
          row.textContent = "plugin:" + String(r.message?.content ?? "");
        });
        api.offer({ state: { hello: { description: "a greeting", read: () => "hi from the phone" } } });
      }
    },
  };
  return { module, url: "blob:" + code, dispose() {} };
};

test("the phone mounts its plugins, draws their rows, answers the agent, and follows the supervisor and the kept choices", async () => {
  _resetRows();
  _resetOffers();
  const box: Box = { records: [], plugins: [{ id: ".vault-chat/plugins/rows.js", name: "Rows", code: "rows" }], state: {}, seq: 0 };
  const redraws: boolean[] = [];
  const host = startPhoneHost({ api: fakeApi(box) as any, toast() {}, where: () => ({ page: "chat", chat: "main", title: "Main" }), redraw: (r) => void redraws.push(r), load, win: win as any, theme: () => THEME, everyMs: 60_000 });
  try {
    await tick(60);
    assert.deepEqual(host.mounted().map((m) => [m.id, m.error]), [[".vault-chat/plugins/rows.js", null]]);
    assert.ok(redraws.includes(true), "a renderer registered: the rows are drawn again");

    // Its renderer draws the phone's assistant rows; a kind it does not draw is the phone's own.
    const el = host.rowElement({ kind: "assistant", index: 0, message: { role: "assistant", content: "hello" } });
    assert.equal(el?.textContent, "plugin:hello");
    assert.equal(el?.getAttribute("data-vc-row-renderer"), ".vault-chat/plugins/rows.js#assistant");
    assert.equal(host.rowElement({ kind: "user", index: 1, message: { role: "user", content: "x" } }), null);

    // The agent reaches it (PluginRead with device "phone" is this signal), and the phone itself.
    const list = JSON.parse((await answerPluginSignal({ type: "plugin", id: "1", to: "phone", op: "list" })).data!.answer);
    assert.deepEqual(list.plugins.map((p: any) => p.id).sort(), [".vault-chat/plugins/rows.js", "app/phone"]);
    const read = JSON.parse((await answerPluginSignal({ type: "plugin", id: "2", to: "phone", op: "read", plugin: "rows" })).data!.answer);
    assert.equal(read.state.hello, "hi from the phone");
    const phone = JSON.parse((await answerPluginSignal({ type: "plugin", id: "3", to: "phone", op: "read", plugin: "app/phone" })).data!.answer);
    assert.deepEqual(phone.state.showing, { page: "chat", chat: "main", title: "Main" });
    assert.equal(phone.state.rows.assistant, ".vault-chat/plugins/rows.js#assistant");

    // app/chat-rows' kept choice turns that renderer off here too: the phone's own row.
    host.fold([{ seq: 5, conv: null, type: "signal", signal: { type: "plugin.state", plugin: "app/chat-rows", key: "off:.vault-chat/plugins/rows.js#assistant", value: true } } as any]);
    assert.equal(host.rowElement({ kind: "assistant", index: 0, message: { content: "hello" } }), null);
    host.fold([{ seq: 6, conv: null, type: "signal", signal: { type: "plugin.state", plugin: "app/chat-rows", key: "off:.vault-chat/plugins/rows.js#assistant", value: null } } as any]);
    assert.ok(host.rowElement({ kind: "assistant", index: 0, message: { content: "hello" } }));

    // "Turn off rows": the supervisor's record takes it down on the phone; its renderer and offers go with it.
    host.fold([{ seq: 7, conv: null, type: "signal", signal: { type: "plugin.desired", plugin: ".vault-chat/plugins/rows.js", state: "stopped", at: Date.now(), by: "agent" } } as any]);
    assert.deepEqual(host.mounted(), []);
    assert.equal(host.rowElement({ kind: "assistant", index: 0, message: { content: "hello" } }), null);
    const after = JSON.parse((await answerPluginSignal({ type: "plugin", id: "4", to: "phone", op: "list" })).data!.answer);
    assert.deepEqual(after.plugins.map((p: any) => p.id), ["app/phone"]);

    // On again: mounted afresh.
    host.fold([{ seq: 8, conv: null, type: "signal", signal: { type: "plugin.desired", plugin: ".vault-chat/plugins/rows.js", state: "running", at: Date.now(), by: "carl" } } as any]);
    await tick(40);
    assert.equal(host.mounted().length, 1);
  } finally {
    host.stop();
  }
});

test("a renderer that throws falls back to the phone's own row, for that row only; a plugin turned off is never mounted", async () => {
  _resetRows();
  _resetOffers();
  const box: Box = {
    records: [{ seq: 1, type: "signal", signal: { type: "plugin.desired", plugin: ".vault-chat/plugins/off.js", state: "stopped", at: 1 } }],
    plugins: [
      { id: ".vault-chat/plugins/bad.js", name: "Bad", code: "rows throw" },
      { id: ".vault-chat/plugins/off.js", name: "Off", code: "rows off" },
    ],
    state: {},
    seq: 0,
  };
  const host = startPhoneHost({ api: fakeApi(box) as any, toast() {}, where: () => ({ page: "chat", chat: null, title: "" }), redraw() {}, load, win: win as any, theme: () => THEME, everyMs: 60_000 });
  try {
    await tick(60);
    assert.deepEqual(host.mounted().map((m) => m.id), [".vault-chat/plugins/bad.js"]);
    assert.equal(host.rowElement({ kind: "assistant", index: 0, message: { content: "x" } }), null);
    // A tool step keeps its text when no renderer draws it.
    const step = document.createElement("div") as unknown as HTMLElement;
    step.textContent = "Bash";
    assert.equal(host.toolInto(step, { name: "Bash" }, 0), false);
    assert.equal(step.textContent, "Bash");
  } finally {
    host.stop();
  }
});
