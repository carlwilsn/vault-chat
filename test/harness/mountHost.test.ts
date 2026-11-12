// The in-process mount host (src/mountHost.ts, change 1.5): a page that declares `vc-mount: in-process` is loaded into
// the app itself and its `mount(el, api)` called; whatever it throws (at load, in mount, later) becomes an error card in
// its own box, never an exception into the app. Pages without the declaration stay iframes, unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { parseLiveMount } from "../../src/liveBridge.ts";
import { inlineHtmlDocument } from "../../src/inlineHtml.ts";
import { mountPlugin, pluginParts, type LoadModule } from "../../src/mountHost.ts";

/** A window with listeners we can fire, and a document to mount into. */
function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><div id=host></div><div id=app>the app</div></body></html>");
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const win = {
    DOMParser: (window as any).DOMParser,
    addEventListener: (k: string, f: any) => (listeners[k] ??= []).push(f),
    removeEventListener: (k: string, f: any) => { listeners[k] = (listeners[k] ?? []).filter((x) => x !== f); },
  };
  const fire = (k: string, e: any) => { for (const f of [...(listeners[k] ?? [])]) f(e); };
  return { document, win, fire, listeners, host: document.getElementById("host") as any as HTMLElement };
}

/** Node can import data: modules (the app uses blob: URLs): the same contract, a URL per load. */
const dataLoad: LoadModule = async (code) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const tick = () => new Promise((r) => setTimeout(r, 15));
const THEME = { mode: "dark" as const, vars: { background: "0 0% 10%" } };
const page = (mod: string, extra = "") =>
  `<!doctype html><html><head><meta name="vc-mount" content="in-process"><title>Counter</title><style>.n{font-size:40px}</style>${extra}</head>` +
  `<body><div class="n">0</div><script type="module">${mod}</script></body></html>`;

test("a page mounts in-process only when it declares it; every other page is an iframe as before", () => {
  assert.equal(parseLiveMount(page("")), "in-process");
  assert.equal(parseLiveMount("<meta content='in-process' name=vc-mount>"), "in-process");
  assert.equal(parseLiveMount("<meta name=vc-mount content=IN-PROCESS>"), "in-process");
  assert.equal(parseLiveMount('<meta name="vc-mount" content="iframe">'), "iframe");
  assert.equal(parseLiveMount('<meta name="vc-mount" content="somewhere">'), "iframe", "a word no host knows is the default");
  assert.equal(parseLiveMount('<meta name="vc-capabilities" content="ask, mic"><p>x</p>'), "iframe");
  assert.equal(parseLiveMount("<p>plain page</p>"), "iframe");
  // The iframe document of an ordinary page is byte-for-byte what it was (the meta is the only switch).
  assert.equal(inlineHtmlDocument("<p>x</p>", { css: "" }), inlineHtmlDocument("<p>x</p>", { css: "" }));
});

test("the page splits into its styles, its markup and its module", () => {
  const { win } = world();
  const p = pluginParts(page("export function mount(el){}", '<script type="module">export const b = 2;</script><script>window.classic = 1</script>'), win as any, "v/counter.html");
  assert.equal(p.name, "Counter");
  assert.deepEqual(p.styles, [".n{font-size:40px}"]);
  assert.match(p.body, /<div class="n">0<\/div>/);
  assert.ok(!/<script/i.test(p.body), "no script stays in the markup");
  assert.match(p.code, /export function mount/);
  assert.match(p.code, /export const b = 2/);
  assert.ok(!p.code.includes("classic"), "only module scripts are the plugin's code");
  assert.equal(pluginParts("<p>x</p>", win as any, "a/b/thing.html").name, "thing.html", "no title: the file's name");
});

test("a plugin mounts without an iframe: its markup and styles in a shadow root, mount(el, api) called, the api is the widget contract", async () => {
  const { host, win, document } = world();
  const mod = `export function mount(el, api) {
    el.querySelector(".n").textContent = "mounted " + api.size().w + " " + api.theme.mode + " " + api.path;
    api.onTheme((t) => { el.querySelector(".n").textContent = "theme " + t.mode; });
    globalThis.__mh1 = el;
  }`;
  const h = mountPlugin(host, page(mod), { path: "v/counter.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.equal(h.error, null);
  assert.equal(host.querySelectorAll("iframe").length, 0);
  const root = host.shadowRoot!;
  assert.ok(root, "the plugin lives in a shadow root on the host element");
  assert.match(root.innerHTML, /\.n\{font-size:40px\}/, "its styles stay in its root");
  const n = root.querySelector('[data-el="plugin-root"] .n')!;
  assert.equal(n.textContent, "mounted 0 dark v/counter.html");
  assert.equal((globalThis as any).__mh1, root.querySelector('[data-el="plugin-root"]'), "mount got the plugin's element");
  h.setTheme({ mode: "light", vars: {} });
  assert.equal(n.textContent, "theme light");
  assert.equal(document.getElementById("app")!.textContent, "the app");
  h.unmount();
});

test("mount may be the default export, or return a cleanup that unmount runs; unmount leaves no listener behind", async () => {
  const { host, win, listeners } = world();
  const mod = `export default { mount(el, api) { api.onResize(() => {}); return () => { globalThis.__mh2 = "cleaned"; }; } };`;
  const h = mountPlugin(host, page(mod), { path: "p.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.equal(h.error, null);
  assert.ok((listeners.error ?? []).length > 0, "while mounted it watches for its own errors");
  h.unmount();
  assert.equal((globalThis as any).__mh2, "cleaned");
  assert.equal((listeners.error ?? []).length, 0);
  assert.equal((listeners.unhandledrejection ?? []).length, 0);
  assert.equal(host.shadowRoot!.innerHTML, "", "nothing of it is left on screen");
});

for (const [what, mod, want] of [
  ["mount throws", `export function mount() { throw new Error("broken on purpose"); }`, /broken on purpose/],
  ["mount rejects", `export async function mount() { await null; throw new Error("async broken"); }`, /async broken/],
  ["the module throws while loading", `throw new Error("top-level boom"); export function mount() {}`, /top-level boom/],
  ["the module does not parse", `export function mount( {`, /./],
  ["the module exports no mount", `export const x = 1;`, /exports no mount\(el, api\)/],
] as const) {
  test(`a throwing plugin does not take the app down: ${what} → an error card in its own box`, async () => {
    const { host, win, document } = world();
    const errors: string[] = [];
    const h = mountPlugin(host, page(mod), { path: "v/broken.html", theme: () => THEME, win: win as any, load: dataLoad, onError: (m) => errors.push(m) });
    await assert.doesNotReject(h.ready, "nothing is thrown out to the app");
    assert.match(h.error ?? "", want);
    const card = host.shadowRoot!.querySelector('[data-el="plugin-error"]')!;
    assert.ok(card, "the card shows where the plugin was");
    assert.match(card.textContent ?? "", /Counter stopped/);
    assert.match(card.textContent ?? "", want);
    assert.ok(card.querySelector('[data-el="plugin-reload"]'), "with a way to try again");
    assert.equal(errors.length, 1);
    assert.equal(document.getElementById("app")!.textContent, "the app", "the app stands");
    h.unmount();
  });
}

test("a no-module page gets the card, not an exception", async () => {
  const { host, win } = world();
  const h = mountPlugin(host, '<meta name="vc-mount" content="in-process"><p>no code</p>', { path: "x.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.match(h.error ?? "", /no <script type="module">/);
});

test("an error the plugin throws later (an event handler, a timer) is caught as its own and becomes the card; others' errors are not", async () => {
  const { host, win, fire } = world();
  let url = "";
  const load: LoadModule = async (code) => { const r = await dataLoad(code); url = r.url; return r; };
  const h = mountPlugin(host, page(`export function mount(el) { el.textContent = "running"; }`), { path: "v/late.html", theme: () => THEME, win: win as any, load });
  await h.ready;
  assert.equal(h.error, null);
  // Someone else's error (the app's own code): not this plugin's business.
  let prevented = false;
  fire("error", { filename: "http://localhost/src/App.tsx", error: new Error("app bug"), message: "app bug", preventDefault() { prevented = true; } });
  assert.equal(h.error, null);
  assert.equal(prevented, false);
  // Its own: by the module's URL, as the file the error came from or in the stack.
  fire("error", { filename: url, error: new Error("click handler broke"), message: "click handler broke", preventDefault() { prevented = true; } });
  assert.match(h.error ?? "", /click handler broke/);
  assert.equal(prevented, true, "handled: it does not also land as an uncaught error");
  h.unmount();

  const h2 = mountPlugin(host, page(`export function mount() {}`), { path: "v/late.html", theme: () => THEME, win: win as any, load });
  await h2.ready;
  const err = new Error("rejected later");
  err.stack = `Error: rejected later\n    at tick (${url}:1:30)`;
  fire("unhandledrejection", { reason: err, preventDefault() {} });
  assert.match(h2.error ?? "", /rejected later/);
  h2.unmount();
});

test("a callback the host runs (onResize, onTheme) that throws is the plugin's error, not the host's", async () => {
  const { host, win } = world();
  const h = mountPlugin(host, page(`export function mount(el, api) { api.onTheme(() => { throw new Error("theme handler"); }); }`), { path: "t.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.doesNotThrow(() => h.setTheme({ mode: "light", vars: {} }));
  assert.match(h.error ?? "", /theme handler/);
  h.unmount();
});

test("Reload mounts it again (a fixed page, or a passing glitch); an unmount while loading never mounts", async () => {
  const { host, win } = world();
  let n = 0;
  const load: LoadModule = async (code) => dataLoad(code.replace("__N__", String(++n)));
  const h = mountPlugin(host, page(`export function mount(el) { if (__N__ === 1) throw new Error("first time"); el.textContent = "second time"; }`), { path: "r.html", theme: () => THEME, win: win as any, load });
  await h.ready;
  assert.match(h.error ?? "", /first time/);
  await h.reload();
  assert.equal(h.error, null);
  assert.equal(host.shadowRoot!.querySelector('[data-el="plugin-root"]')!.textContent, "second time");
  h.unmount();

  const h2 = mountPlugin(host, page(`export function mount() { globalThis.__mh3 = "mounted"; }`), { path: "r.html", theme: () => THEME, win: win as any, load: dataLoad });
  h2.unmount();
  await h2.ready;
  await tick();
  assert.equal((globalThis as any).__mh3, undefined);
});
