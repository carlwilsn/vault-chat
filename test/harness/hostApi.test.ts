// The plugin host API (src/hostApi.ts, api.host): selectors, actions and events through a fake backend, all undone
// when the plugin stops; and the Notes plugin reaches the app only through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";
import { HOST_API_VERSION, noHost, type HostBackend, type HostState } from "../../src/hostApi.ts";

const dataLoad: LoadModule = async (code) => ({ module: await import("data:text/javascript;base64," + Buffer.from(code).toString("base64")), url: "data:", dispose() {} });
const THEME = { mode: "dark" as const, vars: {} };

function fake() {
  let st: HostState = { ...noHost.state(), currentFile: "a.md", openChatId: "c1", conversations: [{ id: "c1", title: "One", status: "idle", source: "manual", unread: false, lastActivityAt: 1 }] };
  const subs = new Set<() => void>();
  const sels = new Set<(s: any) => void>();
  const calls: string[] = [];
  const b: HostBackend = {
    ...noHost,
    state: () => st,
    subscribe: (f) => (subs.add(f), () => void subs.delete(f)),
    onSelection: (f) => (sels.add(f), () => void sels.delete(f)),
    openFile: async (p, a) => void calls.push(`open ${p} ${a ?? ""}`),
    notify: (t, k) => (calls.push(`notify ${k} ${t}`), () => void calls.push("toast removed")),
    runCommand: (id) => (calls.push(`cmd ${id}`), id === "known"),
  };
  const set = (p: Partial<HostState>) => { st = { ...st, ...p }; for (const f of [...subs]) f(); };
  return { b, set, subs, sels, calls };
}

async function mountWith(b: HostBackend, body: string) {
  const { document, window } = parseHTML("<!doctype html><html><body><div id=h></div></body></html>");
  const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };
  const host = document.getElementById("h") as any as HTMLElement;
  const html = `<meta name="vc-mount" content="in-process"><body><script type="module">export function mount(el, api) { ${body} }</script></body>`;
  const h = mountPlugin(host, html, { path: "v/p.html", theme: () => THEME, win: win as any, load: dataLoad, host: b });
  await h.ready;
  assert.equal(h.error, null);
  return h;
}

test("selectors read plain data; actions reach the backend; the api is versioned", async () => {
  const f = fake();
  const h = await mountWith(f.b, `globalThis.__h1 = api.host;`);
  const host = (globalThis as any).__h1;
  assert.equal(host.version, HOST_API_VERSION);
  assert.equal(host.currentFile(), "a.md");
  assert.equal(host.openChatId(), "c1");
  assert.equal(host.theme().mode, "dark");
  assert.deepEqual(host.conversations().map((c: any) => c.title), ["One"]);
  await host.openFile("b.md", { anchor: "p3" });
  host.notify("hi", "error");
  assert.equal(host.runCommand("known"), true);
  assert.equal(host.runCommand("nope"), false);
  assert.deepEqual(f.calls, ["open b.md p3", "notify error hi", "cmd known", "cmd nope"]);
  h.unmount();
  assert.ok(f.calls.includes("toast removed"), "a toast is an effect: it goes with the plugin");
  host.notify("late", "info");
  assert.ok(!f.calls.includes("notify info late"), "a stopped run's api does nothing");
});

test("events: file-opened and chat-message are derived from changes; off and unmount remove them", async () => {
  const f = fake();
  const h = await mountWith(f.b, `
    const seen = globalThis.__seen = [];
    globalThis.__off = api.host.on("file-opened", (e) => seen.push("file " + e.path));
    api.host.on("chat-message", (e) => seen.push("msg " + e.chatId + " " + e.message.content));
    api.host.on("selection-changed", (s) => seen.push("sel " + (s ? s.text : "none")));
    api.host.on("bogus", () => seen.push("bogus"));`);
  const seen: string[] = (globalThis as any).__seen;
  f.set({ currentFile: "b.md" });
  f.set({ lastMessage: { id: "m1", role: "user", content: "yo" } });
  f.set({ lastMessage: { id: "m1", role: "user", content: "yo!" } }); // same message streaming: not a new one
  f.sels.forEach((s) => s({ path: "b.md", text: "x" }));
  assert.deepEqual(seen, ["file b.md", "msg c1 yo", "sel x"]);
  (globalThis as any).__off();
  f.set({ currentFile: "c.md" });
  assert.equal(seen.length, 3, "off removes the listener");
  assert.ok(f.subs.size === 1 && f.sels.size === 1);
  assert.ok(h.effects.some((e) => e.startsWith("host event")));
  h.unmount();
  assert.equal(f.subs.size, 0, "unmount removes every host listener");
  assert.equal(f.sels.size, 0);
  f.set({ lastMessage: { id: "m2", role: "user", content: "later" } });
  assert.equal(seen.length, 3);
  assert.deepEqual(h.effects, []);
});

test("a throwing event handler is the plugin's failure, not the app's; subscribe notifies on change", async () => {
  const f = fake();
  const h = await mountWith(f.b, `globalThis.__n = 0; api.host.subscribe(() => globalThis.__n++); api.host.on("file-opened", () => { throw new Error("boom"); });`);
  f.set({ notes: [] });
  assert.equal((globalThis as any).__n, 1);
  f.set({ currentFile: "z.md" });
  assert.match(String(h.error), /boom/);
});

test("without a backend the host is inert, and the Notes plugin imports no store", async () => {
  const h = await mountWith(noHost, `globalThis.__v = [api.host.currentFile(), api.host.conversations().length, api.host.runCommand("x")].join();`);
  assert.equal((globalThis as any).__v, ",0,false");
  h.unmount();
  for (const file of ["src/plugins/notes/NotesPanel.tsx", "src/plugins/notes/index.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /from ["'][./]+\/store["']|useStore/, file);
  }
});
