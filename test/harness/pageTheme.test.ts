// The app's theme for sandboxed pages (src/pageTheme.ts): the variables, the defaults, the live update message.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PAGE_THEME_HELLO, PAGE_THEME_MSG, pageThemeFor, pageThemeHead } from "../../src/pageTheme.ts";
import { inlineHtmlDocument } from "../../src/inlineHtml.ts";

test("both modes define every --vc variable; reads from the app's CSS win over the table", () => {
  for (const mode of ["dark", "light"] as const) {
    const t = pageThemeFor(mode);
    for (const k of ["--vc-bg", "--vc-fg", "--vc-muted", "--vc-surface", "--vc-border", "--vc-accent", "--vc-font", "--vc-mono"]) assert.ok(t.vars[k], `${mode} ${k}`);
  }
  assert.notEqual(pageThemeFor("dark").vars["--vc-bg"], pageThemeFor("light").vars["--vc-bg"]);
  assert.equal(pageThemeFor("dark", (n) => (n === "background" ? " 1 2% 3% " : "")).vars["--vc-bg"], "hsl(1 2% 3%)");
});

test("a page document carries the variables, the colour scheme and a zero-specificity default background", () => {
  for (const [theme, mode] of [["graphite", "dark"], ["light", "light"], [null, "dark"]] as const) {
    const doc = inlineHtmlDocument("<p>x</p>", { css: "", theme });
    assert.ok(doc.includes(`color-scheme:${mode}`), String(theme));
    assert.ok(doc.includes(":where(html){background:var(--vc-bg);color:var(--vc-fg)}"));
  }
});

test("the page script applies a theme message from its parent only, and says hello", () => {
  const head = pageThemeHead(pageThemeFor("dark"));
  const js = /<script>([\s\S]*)<\/script>/.exec(head)![1]!;
  const set: Record<string, string> = {};
  const listeners: Record<string, (e: unknown) => void> = {};
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const d = { style: { setProperty: (k: string, v: string) => (set[k] = v), colorScheme: "" } as any, setAttribute: (k: string, v: string) => (set[k] = v) };
  vm.runInNewContext(js, { document: { documentElement: d }, parent, addEventListener: (n: string, f: (e: unknown) => void) => (listeners[n] = f), dispatchEvent() {}, CustomEvent: class {} });
  assert.equal(JSON.stringify(posted), JSON.stringify([{ [PAGE_THEME_HELLO]: 1 }]));
  const light = pageThemeFor("light");
  listeners.message!({ source: {}, data: { [PAGE_THEME_MSG]: light } });
  assert.equal(set["--vc-bg"], undefined, "a message from anything but the parent is ignored");
  listeners.message!({ source: parent, data: { [PAGE_THEME_MSG]: light } });
  assert.equal(set["--vc-bg"], light.vars["--vc-bg"]);
  assert.equal(d.style.colorScheme, "light");
});
