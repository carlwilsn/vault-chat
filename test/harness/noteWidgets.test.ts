// Live widgets inside notes (src/noteWidgets.ts, src/NoteWidget.tsx; plugin refactor point 7): a ```widget block in a
// markdown note names a vault module exporting mount(el, api); the viewer mounts it in place, in its own shadow root,
// through the in-process host. It reads and follows the note around it (api.note), keeps its state in the one log
// (api.state), offers itself to the agent (api.offer, id <note>#<widget>), and whatever it throws is a card in its place.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { parseHTML } from "linkedom";
import { markdownUrlTransform, pluginsFor, prepareMarkdown } from "../../src/mdPipeline.ts";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";
import { listOffers, readOffers, actOffers, _resetOffers } from "../../src/pluginOffers.ts";
import {
  NoteSource,
  noteOutline,
  noteWidgetApi,
  parseWidgetBlock,
  sectionAt,
  widgetBlockOfPre,
  widgetCandidates,
  widgetInstanceId,
  widgetKind,
  type StateStore,
} from "../../src/noteWidgets.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", "note-widgets", name), "utf8");

const dataLoad: LoadModule = async (code) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const tick = () => new Promise((r) => setTimeout(r, 15));

function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><h1 id=note>The note</h1><div id=host></div><p id=after>after</p></body></html>");
  const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };
  return { document, win, host: document.getElementById("host") as any as HTMLElement };
}

/** The app's state store, in memory: what appPluginState / setAppPluginState do, without a box. */
function memoryStore(): StateStore & { states: Map<string, Record<string, unknown>> } {
  const states = new Map<string, Record<string, unknown>>();
  const subs = new Set<(id: string) => void>();
  return {
    states,
    read: (id) => states.get(id) ?? {},
    write: async (id, key, value) => {
      const s = { ...(states.get(id) ?? {}) };
      if (value === null || value === undefined) delete s[key];
      else s[key] = value;
      states.set(id, s);
      for (const f of [...subs]) f(id);
      return null;
    },
    subscribe: (fn) => (subs.add(fn), () => void subs.delete(fn)),
  };
}

const NOTE = `---
title: week 3
---
# Week 3

Intro text.

## Exam prep

Things before the exam.

\`\`\`widget
widgets/section-outline.js
Before the exam
\`\`\`

### Torque
### Angular momentum

## Homework

\`\`\`js
console.log("not a widget");
\`\`\`

\`\`\`widget widgets/section-outline.js
\`\`\`
`;

test("a widget block: the path on the first line (or the fence line), the rest is the block's own text", () => {
  assert.deepEqual(parseWidgetBlock("widgets/a.js\nline one\nline two\n"), { src: "widgets/a.js", text: "line one\nline two" });
  assert.deepEqual(parseWidgetBlock("\n\n  a.js  \n"), { src: "a.js", text: "" });
  assert.deepEqual(parseWidgetBlock(""), { src: "", text: "" });
  assert.equal(widgetKind("w/a.js"), "module");
  assert.equal(widgetKind("w/a.MJS"), "module");
  assert.equal(widgetKind("w/a.html"), "page");
  assert.equal(widgetKind("w/a.ts"), null, "no build step in the app: a .ts widget is refused with a reason");
});

test("the path is looked for next to the note, then from the vault's root; never outside the vault, never a URL", () => {
  const V = "/v";
  assert.deepEqual(widgetCandidates("/v/Physics/week 3.md", "widgets/a.js", V), ["/v/Physics/widgets/a.js", "/v/widgets/a.js"]);
  assert.deepEqual(widgetCandidates("/v/Physics/week 3.md", "/widgets/a.js", V), ["/v/widgets/a.js"], "a leading / is the vault's root");
  assert.deepEqual(widgetCandidates("/v/Physics/week 3.md", "../shared/a.js", V), ["/v/shared/a.js"]);
  assert.deepEqual(widgetCandidates("/v/a.md", "../../etc/x.js", V), [], "outside the vault: nothing");
  assert.deepEqual(widgetCandidates("/v/a.md", "https://evil.example/x.js", V), []);
  assert.deepEqual(widgetCandidates("C:\\vault\\notes\\a.md", "w.js", "C:\\vault"), ["C:/vault/notes/w.js", "C:/vault/w.js"]);
  assert.equal(widgetInstanceId("Physics/week 3.md", "widgets/a.js", 1), "Physics/week 3.md#widgets/a.js");
  assert.equal(widgetInstanceId("Physics/week 3.md", "widgets/a.js", 2), "Physics/week 3.md#widgets/a.js~2");
});

test("the note's outline: headings outside code and frontmatter, its widget blocks in order, the section a block is in", () => {
  const { headings, widgets } = noteOutline(NOTE);
  assert.deepEqual(headings.map((h) => `${h.level} ${h.text}`), ["1 Week 3", "2 Exam prep", "3 Torque", "3 Angular momentum", "2 Homework"]);
  assert.deepEqual(widgets.map((w) => [w.src, w.text]), [["widgets/section-outline.js", "Before the exam"], ["widgets/section-outline.js", ""]]);
  const sec = sectionAt(NOTE, widgets[0]!.line);
  assert.equal(sec.heading?.text, "Exam prep");
  assert.match(sec.text, /^## Exam prep/);
  assert.match(sec.text, /### Angular momentum\s*$/, "the section runs to the next heading of its level");
  assert.ok(!sec.text.includes("Homework"));
  assert.equal(sectionAt(NOTE, widgets[1]!.line).heading?.text, "Homework");
});

test("the note viewer's pipeline keeps a widget block a code block the viewer can tell apart; other code is untouched", () => {
  const { remarkPlugins, rehypePlugins } = pluginsFor("note", rehypeHighlight);
  const seen: unknown[] = [];
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins,
        rehypePlugins,
        urlTransform: markdownUrlTransform,
        components: {
          pre: (p: any) => {
            const b = widgetBlockOfPre(p.node);
            if (!b) return createElement("pre", null, p.children);
            seen.push(b);
            return createElement("div", { "data-el": "note-widget", "data-src": b.src });
          },
        },
      },
      prepareMarkdown(NOTE, { frontmatter: true }),
    ),
  );
  assert.deepEqual(seen, [{ src: "widgets/section-outline.js", text: "Before the exam" }, { src: "widgets/section-outline.js", text: "" }]);
  assert.equal((html.match(/data-el="note-widget"/g) ?? []).length, 2);
  assert.match(html, /<pre><code class="hljs language-js">/, "an ordinary code block is still highlighted code");
  assert.match(html, /<h3 dir="auto" id="torque">Torque<\/h3>/, "the note around it renders as before");
  // A chat reply has no widgets: the block stays code there.
  const chat = pluginsFor("chat", rehypeHighlight);
  const reply = renderToStaticMarkup(createElement(ReactMarkdown, { ...chat, urlTransform: markdownUrlTransform }, "```widget\nw.js\n```"));
  assert.match(reply, /<code class="(hljs )?language-widget">w\.js/);
});

test("the sample widget mounts in place in its own shadow root, reads the section around it and follows the note's edits", async () => {
  _resetOffers();
  const { host, win, document } = world();
  const source = new NoteSource("/v/Physics/week 3.md", NOTE);
  const store = memoryStore();
  const id = widgetInstanceId("Physics/week 3.md", "widgets/section-outline.js", 1);
  const h = mountPlugin(host, { name: "Section outline", code: fixture("section-outline.js") }, {
    path: id,
    shadow: true,
    theme: () => ({ mode: "dark", vars: {} }),
    win: win as any,
    load: dataLoad,
    extend: (ctx) => noteWidgetApi({ source, notePath: "Physics/week 3.md", index: 0, widget: "widgets/section-outline.js", blockText: "Before the exam", stateId: `widget:${id}`, store }, ctx),
  });
  await h.ready;
  assert.equal(h.error, null);
  const root = host.shadowRoot!;
  assert.ok(root, "a note widget is isolated in a shadow root (its CSS stays its own)");
  const text = () => root.querySelector('[data-el="plugin-root"] .box')!.textContent!.replace(/\s+/g, " ").trim();
  assert.equal(text(), "Before the exam Torque Angular momentum");
  assert.equal(document.getElementById("note")!.textContent, "The note", "the note around it stands");

  // The note is edited (Carl, or the agent writing the file): the widget follows.
  source.set(NOTE.replace("### Angular momentum", "### Angular momentum\n### Rolling"));
  assert.equal(text(), "Before the exam Torque Angular momentum Rolling");

  // The agent reaches it by its instance id: reads its items, checks one; the state is a record under widget:<id>.
  assert.ok(listOffers().some((o) => o.id === id), "listed for PluginRead");
  const read = await readOffers(id);
  assert.ok(read.ok);
  assert.deepEqual((read as any).state.items, ["Torque", "Angular momentum", "Rolling"]);
  const act = await actOffers(id, "toggle", { text: "Torque" });
  assert.ok(act.ok, JSON.stringify(act));
  assert.deepEqual(store.states.get(`widget:${id}`), { checked: ["Torque"] });
  assert.match(root.querySelector(".done")!.textContent!, /Torque/, "its own state redraws it");

  // Unmounted (the note closed, scrolled away for good, the widget turned off): nothing of it is left listening.
  h.unmount();
  assert.equal(root.childNodes.length, 0);
  assert.ok(!listOffers().some((o) => o.id === id), "no offers once it is gone");
  source.set(NOTE);
  await store.write(`widget:${id}`, "checked", []);
  assert.equal(root.childNodes.length, 0, "an edit or a state change after unmount draws nothing");
});

test("its state comes back on a fresh mount (another window, a restart): the same records", async () => {
  _resetOffers();
  const store = memoryStore();
  const id = widgetInstanceId("n.md", "w.js", 1);
  await store.write(`widget:${id}`, "checked", ["Torque"]);
  const { host, win } = world();
  const source = new NoteSource("/v/n.md", "## A\n\n```widget\nw.js\n```\n\n### Torque\n");
  const h = mountPlugin(host, { name: "o", code: fixture("section-outline.js") }, {
    path: id, shadow: true, theme: () => ({ mode: "dark", vars: {} }), win: win as any, load: dataLoad,
    extend: (ctx) => noteWidgetApi({ source, notePath: "n.md", index: 0, widget: "w.js", blockText: "", stateId: `widget:${id}`, store }, ctx),
  });
  await h.ready;
  const cb = host.shadowRoot!.querySelector("input") as any;
  assert.equal(cb.checked, true);
  h.unmount();
});

test("a widget that throws is a card in its place with Reload; the note stands and nothing reaches the app", async () => {
  const { host, win, document } = world();
  const source = new NoteSource("/v/n.md", "# N\n");
  const store = memoryStore();
  let reported = "";
  const h = mountPlugin(host, { name: "broken.js", code: fixture("broken.js") }, {
    path: "n.md#broken.js", shadow: true, theme: () => ({ mode: "dark", vars: {} }), win: win as any, load: dataLoad,
    onError: (m) => (reported = m),
    extend: (ctx) => noteWidgetApi({ source, notePath: "n.md", index: 0, widget: "broken.js", blockText: "", stateId: "widget:n.md#broken.js", store }, ctx),
  });
  await h.ready;
  assert.match(h.error ?? "", /broken on purpose/);
  assert.match(reported, /broken on purpose/);
  const card = host.shadowRoot!.querySelector('[data-el="plugin-error"]')!;
  assert.match(card.textContent!, /broken\.js stopped/);
  assert.ok(card.querySelector('[data-el="plugin-reload"]'));
  assert.ok(!(card.getAttribute("style") ?? "").includes("fixed"), "the card sits in the note's flow, not floating over the app");
  assert.equal(document.getElementById("after")!.textContent, "after");
  // A module that is not a widget at all.
  const { host: h2, win: w2 } = world();
  const g = mountPlugin(h2, { name: "x", code: "export const nothing = 1;" }, { path: "n.md#x.js", shadow: true, theme: () => ({ mode: "dark", vars: {} }), win: w2 as any, load: dataLoad });
  await g.ready;
  assert.match(g.error ?? "", /exports no mount/);
  await tick();
});

test("the extra api can't shadow the host's own (a widget can't replace offer, plugins or context)", async () => {
  const { host, win } = world();
  let seen: any = null;
  const code = "export function mount(el, api) { globalThis.__nwApi = api; }";
  const h = mountPlugin(host, { name: "x", code }, {
    path: "n.md#x.js", shadow: true, theme: () => ({ mode: "dark", vars: {} }), win: win as any, load: dataLoad,
    extend: () => ({ offer: "hijacked", note: { path: "n.md" } }),
  });
  await h.ready;
  seen = (globalThis as any).__nwApi;
  assert.equal(typeof seen.offer, "function");
  assert.equal(seen.note.path, "n.md");
  h.unmount();
});
