// The chat's translators (src/convlog/translators.ts): each event in a conversation's log becomes its rows through the
// translator of its type: the app's own (./view.ts, as before), an alternative of the app's when chosen, or a vault
// plugin's over it, live (api.host.chat.translate); a throw hands the event on; app/chat-rows offers them to the agent.
// And the asks it unlocks (U28): text beside a tool call is shown, not lost under Thought; a worker's line says what
// happened in Carl's words, once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-translators-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
const G = globalThis as any;
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
G.document = document;
(document as any).defaultView ??= lw;
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

const T = await import("../../src/convlog/translators.ts");
const { makeChatView, messagesOf, workerLine } = await import("../../src/convlog/view.ts");
const { fold } = await import("../../src/convlog/reduce.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
const chatRowsPlugin = await import("../../src/plugins/chat-rows/index.ts");

const C = "c";
const THEME = { mode: "dark" as const, vars: {} };
const el = () => document.createElement("div") as unknown as HTMLElement;
const dataLoad = async (code: string) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
let seq = 0;
const user = (text: string, via = "chat"): any => {
  const n = ++seq;
  return { seq: n, conv: C, at: 1000 + n, type: "entry", file: "f", clientId: `u${n}`, shown: text, via, entry: { type: "message", id: `e${n}`, message: { role: "user", content: [{ type: "text", text }], timestamp: 1000 + n } } };
};
const reply = (content: any[], stopReason = "stop"): any => {
  const n = ++seq;
  return { seq: n, conv: C, at: 1000 + n, type: "entry", file: "f", entry: { type: "message", id: `e${n}`, message: { role: "assistant", content, stopReason, timestamp: 5000 + n } } };
};
const notice = (text: string): any => {
  const n = ++seq;
  return { seq: n, conv: C, at: 1000 + n, type: "entry", file: "f", clientId: `n${n}`, entry: { type: "custom", customType: "vc-note", id: `e${n}`, data: { kind: "notice", text } } };
};
const shown = (ms: any[]) => ms.map((m) => (m.toolCalls ? `tools:${m.toolCalls.map((t: any) => t.name).join(",")}` : m.thinking ? `thought:${m.thinking}` : `${m.system ? "line" : m.role}:${m.content}`));

// Carl's case (2026-11-13, "the translator puts some not-thought messages as thoughts so I lose them"): Claude answered,
// then launched a worker in the same message.
const committed = [
  user("can you commit yourself to finishing track 1 and 2?"),
  reply([{ type: "thinking", thinking: "" }, { type: "text", text: "Yes, I commit to it. **Track 1** moves features behind plugins." }, { type: "toolCall", id: "a1", name: "Agent", arguments: { description: "Track 2" } }], "toolUse"),
  reply([{ type: "text", text: "Track 2 is now running." }]),
];

test("every event type has the app's own translator; the transcript is what it was, except the two fixes", () => {
  for (const t of ["user", "user:job", "user:delegate", "user:retry", "user:handoff", "user:wake", "user:nudge", "user:resume", "worker", "assistant", "thinking", "commentary", "compaction", "notice"]) {
    assert.equal(T.translatorChain(t)[0]?.id, `builtin:${t}`, t);
  }
  const ms = messagesOf(fold([user("hi"), user("Job sweep-ab12cd34 finished: exit 1.", "job"), user("check the run", "wake"), user("Try again", "retry"), reply([{ type: "thinking", thinking: "Weighing." }, { type: "text", text: "Done." }]), notice("Voice call ended · 2 min")], C));
  assert.deepEqual(shown(ms), ["user:hi", "line:Job failed (exit 1) · sweep", "line:⏰ check the run", "line:↻ Trying again", "thought:Weighing.", "assistant:Done.", "line:Voice call ended · 2 min"]);
});

test("U28: text beside a tool call is shown as what the agent said; the old fold under Thought is one choice away", () => {
  assert.deepEqual(shown(messagesOf(fold(committed, C))), ["user:can you commit yourself to finishing track 1 and 2?", "assistant:Yes, I commit to it. **Track 1** moves features behind plugins.", "tools:Agent", "assistant:Track 2 is now running."]);
  const view = makeChatView();
  const p = fold(committed, C);
  const first = view(p).messages;
  assert.equal(view(p).messages[1], first[1], "unchanged: the same message objects (rows keep their memo)");
  T.setTranslatorPrefs([], { commentary: "app:commentary:thought" });
  assert.deepEqual(shown(view(p).messages)[1], "thought:Yes, I commit to it. **Track 1** moves features behind plugins.", "the same view translates again after a change");
  T.setTranslatorPrefs([], {});
  assert.equal(shown(view(p).messages)[1], "assistant:Yes, I commit to it. **Track 1** moves features behind plugins.");
});

test("U28: a worker's line says what happened in Carl's words, and a repeat since the last reply is said once", () => {
  assert.deepEqual(workerLine("Worker NOT finished, waiting on its own background work (interim notice): Fix composer test"), { content: "Worker reported, still waiting on its own work · Fix composer test" });
  assert.deepEqual(workerLine('Worker stopped: Background agent "Lane F: chat pane" didn\'t finish before the previous session ended. Use SendMessage to resume'), { content: "Worker interrupted by a restart · Lane F: chat pane" });
  assert.deepEqual(workerLine('Worker idle for 11 min, not finished (check JobStatus {id: "abc123"}): Resubmit lanes'), { content: "Worker quiet for 11 min, not finished · Resubmit lanes" });
  assert.deepEqual(workerLine('Worker idle for 11 min, not finished (check box:jobs status {id: "abc123"}): Resubmit lanes'), { content: "Worker quiet for 11 min, not finished · Resubmit lanes" });
  assert.deepEqual(workerLine("Worker interrupted by a restart (check box:jobs: it may have finished, or resume it): Lane C"), { content: "Worker interrupted by a restart · Lane C" });
  assert.deepEqual(workerLine("Worker interrupted by a restart (check JobList: it may have finished, or resume it): Lane C"), { content: "Worker interrupted by a restart · Lane C" });
  assert.deepEqual(workerLine("Worker stopped: wait for ship result"), { content: "Worker stopped · wait for ship result" });
  assert.equal(workerLine("Job x finished"), null);
  const gone = 'Worker stopped: Background agent "Lane F" didn\'t finish before the previous session ended';
  const ms = messagesOf(fold([user("go"), user(gone, "wake"), user(gone, "wake"), user("Worker finished: Lane G", "wake"), reply([{ type: "text", text: "Lane G landed." }]), user(gone, "wake")], C));
  assert.deepEqual(shown(ms), ["user:go", "line:Worker interrupted by a restart · Lane F", "line:Worker finished · Lane G", "assistant:Lane G landed.", "line:Worker interrupted by a restart · Lane F"]);
});

test("a vault plugin adds or overrides a translator live; next() wraps the app's; a throw hands the event on; stopped, the app's own", async () => {
  T._resetTranslators();
  const view = makeChatView();
  const p = fold([user("hi"), notice("Voice call ended · 2 min"), user("Worker finished: Lane G", "wake")], C);
  const code = `
    export const meta = { name: "My words" };
    export function mount(el, api) {
      api.host.chat.translate("notice", (e) => (/^Voice call ended/.test(e.item.text) ? [] : null));
      api.host.chat.translate("worker", (e, next) => next().map((m) => ({ ...m, content: "🛠 " + m.content })));
      api.host.chat.translate("user:chat", (e) => [{ role: "user", content: "Carl: " + e.item.text, mid: e.item.id }]);
    }`;
  const h = mountPlugin(el(), { name: "My words", code }, { path: ".vault-chat/plugins/my-words.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await h.ready;
  assert.deepEqual(shown(view(p).messages), ["user:Carl: hi", "line:🛠 Worker finished · Lane G"]);
  const d = T.describeTranslators();
  assert.equal(d.find((x) => x.type === "notice")!.active, ".vault-chat/plugins/my-words.js#notice");
  assert.equal(d.find((x) => x.type === "user:chat")!.active, ".vault-chat/plugins/my-words.js#user:chat", "a type the app had no translator of");
  // The agent puts the app's own back for one type.
  T.setTranslatorPrefs([], { notice: "builtin:notice" });
  assert.deepEqual(shown(view(p).messages)[1], "line:Voice call ended · 2 min");
  T.setTranslatorPrefs([], {});
  h.unmount();
  assert.deepEqual(shown(view(p).messages), ["user:hi", "line:Voice call ended · 2 min", "line:Worker finished · Lane G"]);

  const undo = T.registerTranslator("notice", () => {
    throw new Error("bad words");
  }, "test");
  assert.deepEqual(shown(view(p).messages)[1], "line:Voice call ended · 2 min", "a throw: the app's own");
  assert.equal(T.describeTranslators().find((x) => x.type === "notice")!.translators.find((t) => t.id === "test#notice")!.failures!.last, "bad words");
  undo();
  assert.throws(() => T.registerTranslator("Not A Type!", () => null, "x"), /not a type/);
});

test("app/chat-rows offers the translators to the agent: read, use, disable, enable", async () => {
  T._resetTranslators();
  _resetOffers();
  const h = mountPlugin(el(), { name: "Chat rows", module: chatRowsPlugin }, { path: "app/chat-rows", theme: () => THEME, host: appHostBackend });
  await h.ready;
  const ask = async (sig: Record<string, unknown>) => JSON.parse((await answerPluginSignal({ type: "plugin", id: "s", ...sig } as any)).data!.answer);
  const list = await ask({ op: "list" });
  const me = list.plugins.find((x: any) => x.id === "app/chat-rows");
  for (const a of ["disableTranslator", "enableTranslator", "useTranslator"]) assert.ok(me.actions.some((x: any) => x.name === a), a);
  assert.ok(me.state.some((x: any) => x.name === "translators"));
  const read = await ask({ op: "read", plugin: "app/chat-rows", state: "translators" });
  const commentary = read.state.translators.find((x: any) => x.type === "commentary");
  assert.equal(commentary.active, "builtin:commentary");
  assert.deepEqual(commentary.translators.map((t: any) => t.id), ["builtin:commentary", "app:commentary:thought"]);

  let act = await ask({ op: "act", plugin: "app/chat-rows", action: "useTranslator", args: { type: "commentary", id: "app:commentary:thought" } });
  assert.equal(act.ok, true);
  assert.equal(act.state.translators.find((x: any) => x.type === "commentary").active, "app:commentary:thought");
  assert.equal(shown(messagesOf(fold(committed, C)))[1], "thought:Yes, I commit to it. **Track 1** moves features behind plugins.");
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "useTranslator", args: { type: "commentary" } });
  assert.equal(act.state.translators.find((x: any) => x.type === "commentary").active, "builtin:commentary");

  act = await ask({ op: "act", plugin: "app/chat-rows", action: "disableTranslator", args: { id: "builtin:worker" } });
  assert.equal(act.ok, true);
  assert.deepEqual(shown(messagesOf(fold([user("Worker finished: Lane G", "wake")], C))), [], "no worker translator left: nothing");
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "enableTranslator", args: { id: "builtin:worker" } });
  assert.deepEqual(shown(messagesOf(fold([user("Worker finished: Lane G", "wake")], C))), ["line:Worker finished · Lane G"]);
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "useTranslator", args: { type: "notice", id: "builtin:worker" } });
  assert.equal(act.ok, false);
  assert.match(act.error, /no translator "builtin:worker" for type "notice"/);
  h.unmount();
});
