// Carl's input in the viewer's web pages (src/pageInput.ts): a dev server's page (the box proxy's frame script) posts
// what he does to the app, a public page (the native view) keeps it for the pane to collect, and the agent's own step
// there is marked as the agent's. Never a password.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { frameScript } from "../../server/devProxy.ts";
import { PAGE_INPUT_LIMITS, pageInputOf } from "../../src/pageInput.ts";
import { answerText, driveScript, inputInstallScript, inputPollScript } from "../../src/webDrive.ts";

const HTML =
  `<!doctype html><html><head><title>Tiles</title></head><body><div class="tile" id="t1" style="cursor:pointer"><span>Chat A</span></div>` +
  `<button id="snap">Snap left</button><input id="q" name="query"><input type="password" id="pw"><input id="tok" name="api_token">` +
  `<input id="cc" autocomplete="cc-number"><div id="drop">Right half</div></body></html>`;

function page() {
  const { document, window } = parseHTML(HTML);
  const W = window as any;
  const fire = (el: any, type: string, init: Record<string, unknown> = {}, trusted = true) => {
    const e = new W.Event(type, { bubbles: true });
    for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v });
    Object.defineProperty(e, "isTrusted", { value: trusted });
    el.dispatchEvent(e);
  };
  return { document, window: W, fire };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a dev server's page in a pane posts what Carl does: clicks, typing, keys, drags; never a password, card or token field", async () => {
  const { document, window, fire } = page();
  const tag = frameScript(["http://tauri.localhost"]);
  const body = tag.slice("<script>".length, tag.indexOf("</script>"));
  const posted: any[] = [];
  const app = { postMessage: (m: unknown) => posted.push(m) };
  const add = (k: string, f: any, c?: any) => document.addEventListener(k, f, c);
  const ctx: any = {
    document, location: { href: "https://box.ts.net:1560/before/", ancestorOrigins: ["http://tauri.localhost"] }, history: { pushState() {}, replaceState() {} },
    addEventListener: add, setTimeout, clearTimeout, getComputedStyle: (el: any) => ({ cursor: el?.getAttribute?.("style")?.includes("pointer") ? "pointer" : "auto" }),
    getSelection: () => null, JSON, Date, Math, String, Object, Array, URL, Event: window.Event,
  };
  ctx.window = ctx;
  ctx.top = app;
  ctx.parent = app;
  ctx.document.elementFromPoint = () => document.getElementById("drop");
  vm.runInNewContext(body, ctx);
  const inputs = () => JSON.parse(JSON.stringify(posted.filter((m) => m.vcFrame === "input")));

  fire(document.querySelector("span"), "click");
  // A page's own synthetic click is not his.
  fire(document.getElementById("snap"), "click", {}, false);
  await wait(400);
  assert.equal(inputs().length, 1, "one post after the burst");
  assert.equal(inputs()[0].url, "https://box.ts.net:1560/before/");
  assert.deepEqual(inputs()[0].input.recent.map((r: any) => [r.what, r.id, r.text, r.by]), [["click", "t1", "Chat A", "Carl"]]);

  const q = document.getElementById("q") as any;
  q.value = "tiles";
  fire(q, "input");
  // Typing into a field is its input, not keys; Enter there is a key.
  fire(q, "keydown", { key: "s" });
  fire(q, "keydown", { key: "Enter" });
  for (const [id, v] of [["pw", "hunter2"], ["tok", "sk-123"], ["cc", "4111111111111111"]]) {
    const el = document.getElementById(id) as any;
    el.value = v;
    fire(el, "input");
    fire(el, "keydown", { key: "Enter" });
    fire(el, "keydown", { key: "v", ctrlKey: true });
  }
  fire(document.body, "keydown", { key: "Escape" });
  fire(document.body, "keydown", { key: "Escape" });
  fire(document.body, "keydown", { key: "z", ctrlKey: true });
  // A drag: down on the tile, moves, up over the right half; the click it ends in is not another click.
  const t1 = document.getElementById("t1");
  fire(t1, "pointerdown", { button: 0, clientX: 100, clientY: 100 });
  fire(t1, "pointermove", { clientX: 300, clientY: 120 });
  fire(t1, "pointermove", { clientX: 600, clientY: 140 });
  fire(t1, "pointerup", { button: 0, clientX: 700, clientY: 150 });
  fire(t1, "click");
  await wait(1000);
  const last = inputs().at(-1).input;
  assert.deepEqual(
    last.recent.map((r: any) => [r.what, r.id, r.value ?? r.key ?? r.onto, r.n]),
    [["click", "t1", undefined, undefined], ["input", "q", "tiles", undefined], ["key", "q", "Enter", undefined], ["key", undefined, "Escape", 2], ["key", undefined, "Control+Z", undefined], ["drag", "t1", "Right half", undefined]],
  );
  const drag = last.recent.at(-1);
  assert.deepEqual([drag.from, drag.to, drag.moves], [[100, 100], [700, 150], 2]);
  assert.equal(last.fields.q, "tiles");
  const all = JSON.stringify(posted);
  for (const secret of ["hunter2", "sk-123", "4111"]) assert.ok(!all.includes(secret), `never posted: ${secret}`);
  for (const id of ["pw", "tok", "cc"]) assert.ok(!last.recent.some((r: any) => r.id === id), `nothing from ${id}`);
  // Bounded, and bounded again by the app.
  for (let i = 0; i < PAGE_INPUT_LIMITS.recent + 5; i++) fire(document.getElementById("snap"), "click");
  await wait(400);
  assert.equal(inputs().at(-1).input.recent.length, PAGE_INPUT_LIMITS.recent);
  const big = pageInputOf({ fields: { a: "x".repeat(5000) }, recent: Array.from({ length: 50 }, () => ({ what: "click", text: "y".repeat(5000) })), at: "nope" })!;
  assert.equal(big.recent.length, PAGE_INPUT_LIMITS.recent);
  assert.ok(String(big.fields.a).length <= PAGE_INPUT_LIMITS.value + 1 && String(big.recent[0]!.text).length <= PAGE_INPUT_LIMITS.value + 1);
  assert.equal(pageInputOf("x"), null);
});

test("a public page in the native view: the pane puts the recorder in and collects its newest record; the agent's own click is the agent's", async () => {
  const { document, window, fire } = page();
  const ctx: any = {
    document, addEventListener: (k: string, f: any, c?: any) => document.addEventListener(k, f, c), setTimeout, clearTimeout,
    getComputedStyle: () => ({ cursor: "auto", visibility: "visible", display: "block", opacity: "1" }), getSelection: () => null,
    PointerEvent: window.Event, MouseEvent: window.Event, KeyboardEvent: window.Event, Event: window.Event, NodeFilter: { SHOW_ELEMENT: 1 },
    innerHeight: 800, scrollY: 0, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const run = (js: string) => vm.runInContext(js, ctx);
  assert.equal(run(inputPollScript(0)), "none");
  assert.equal(run(inputInstallScript()), "ok");
  assert.equal(run(inputInstallScript()), "ok", "once per document");
  assert.equal(run(inputPollScript(0)), "same");
  fire(document.getElementById("snap"), "click");
  await wait(400);
  const a = JSON.parse(answerText(JSON.stringify(run(inputPollScript(0))))!);
  assert.equal(answerText("same"), "same");
  assert.equal(a.seq, 1);
  assert.deepEqual(a.rec.recent.map((r: any) => [r.what, r.id, r.by]), [["click", "snap", "Carl"]]);
  assert.equal(run(inputPollScript(1)), "same");
  // The agent's click through the drive script (box:workspace webPage click): recorded, as the agent's.
  for (const el of document.querySelectorAll("*") as any) {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
    el.scrollIntoView = () => {};
    el.click = function (this: any) { fire(this, "click", {}, false); };
  }
  const r = JSON.parse(run(driveScript({ op: "click", text: "Chat A" })));
  assert.ok(!r.error, r.error);
  await wait(400);
  const b = JSON.parse(run(inputPollScript(1)));
  assert.deepEqual(b.rec.recent.map((x: any) => [x.what, x.text, x.by]), [["click", "Snap left", "Carl"], ["click", "Chat A", "agent"]]);
  assert.equal(ctx.__vcAgentStep, 0, "the step's mark is gone after it");
});
