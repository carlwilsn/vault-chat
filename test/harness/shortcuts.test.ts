// The keyboard shortcut registry (src/shortcuts.ts) is the one source of truth:
// - every key the app's handlers act on is in it (grepped from src/);
// - every entry names files that really handle it;
// - Ctrl+/ (Cmd+/ on a Mac) opens the sheet, plain "/" never does;
// - the sheet lists every entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHORTCUTS, SUPPRESSED_KEYS, parseChord, hit, chordMatches, cmKey, chordLabel, type Shortcut } from "../../src/shortcuts.ts";

const root = join(import.meta.dirname, "..", "..");
const all = SHORTCUTS as readonly Shortcut[];

// Not key bindings: clientEvents.ts names every keyboard event as a chord for
// the activity log (it reacts to any key, binds none); src/lib is vendored UI;
// the registry itself.
const NOT_HANDLERS = new Set(["src/clientEvents.ts", "src/shortcuts.ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== "lib") out.push(...sources(p));
    } else if (/\.tsx?$/.test(d.name)) out.push(p);
  }
  return out;
}

const NAMED = /^(Escape|Enter|Tab|Arrow(Up|Down|Left|Right)|F\d{1,2}|Backspace|Delete|Home|End|PageUp|PageDown|Space| )$/;
const norm = (k: string) => (k === "Escape" ? "Esc" : k.length === 1 ? k.toUpperCase() : k);

/** Every key a handler in src/ compares against: [file, key]. */
function handledKeys(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const abs of sources(join(root, "src"))) {
    const file = relative(root, abs).replace(/\\/g, "/");
    if (NOT_HANDLERS.has(file)) continue;
    const src = readFileSync(abs, "utf8");
    // e.key === "Escape", k === "b", key !== "l", e.key.toLowerCase() === "d"
    for (const m of src.matchAll(/\b(?:\w+\.key|k|key)(?:\.toLowerCase\(\))?\s*[!=]==\s*"([^"]*)"/g)) {
      const lit = m[1]!;
      if (lit.length === 1 || NAMED.test(lit)) found.push([file, norm(lit)]);
    }
    // CodeMirror keymaps: key: "Mod-k"
    for (const m of src.matchAll(/\bkey:\s*"((?:Mod|Ctrl|Alt|Shift|Cmd)-[^"]+)"/g)) found.push([file, norm(m[1]!.split("-").pop()!)]);
    // Monaco: KeyCode.KeyK
    for (const m of src.matchAll(/KeyCode\.Key([A-Z])\b/g)) found.push([file, m[1]!]);
    // e.code === "KeyK" / "Slash"
    for (const m of src.matchAll(/\.code\s*[!=]==\s*"([^"]+)"/g)) found.push([file, m[1]!.replace(/^Key/, "")]);
  }
  return found;
}

test("every key handled in src/ is in the shortcut registry", () => {
  const entries = [...all.map((s) => ({ keys: s.keys, files: s.files })), SUPPRESSED_KEYS];
  const found = handledKeys();
  assert.ok(found.length > 30, `the grep finds the handlers (${found.length})`);
  const missing = found.filter(
    ([file, key]) => !entries.some((e) => (e.files as readonly string[]).includes(file) && e.keys.some((c) => norm(parseChord(c).key) === key)),
  );
  assert.deepEqual(
    [...new Set(missing.map(([f, k]) => `${f}: ${k}`))],
    [],
    "add these to src/shortcuts.ts (with the file in `files`), or bind them through hit()",
  );
});

test("every registry entry names files that handle it", () => {
  const ids = new Set<string>();
  for (const s of all) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.label.split(/\s+/).length <= 4, `${s.id}: a short label`);
    for (const f of s.files) {
      assert.ok(existsSync(join(root, f)), `${s.id}: ${f} exists`);
      const src = readFileSync(join(root, f), "utf8");
      const lits = s.keys.map((c) => parseChord(c).key).flatMap((k) => (k === "Esc" ? ["\"Escape\""] : [`"${k}"`, `"${k.toLowerCase()}"`, `Key${k.toUpperCase()}`]));
      const uses = src.includes(`"${s.id}"`) || lits.some((l) => src.includes(l)) || s.id === "chat.newline";
      assert.ok(uses, `${s.id}: ${f} reads it from the registry or handles its key`);
    }
  }
});

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, code?: string) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("Ctrl+/ (Cmd+/ on a Mac) opens the sheet; typing / does not", () => {
  assert.equal(hit(ev("/", { ctrlKey: true }, "Slash"), "view.shortcuts"), true);
  assert.equal(hit(ev("/", { metaKey: true }, "Slash"), "view.shortcuts"), true);
  assert.equal(hit(ev("/", {}, "Slash"), "view.shortcuts"), false, "a / typed in the composer starts a command, not the sheet");
  assert.equal(hit(ev("7", { ctrlKey: true }, "Slash"), "view.shortcuts"), true, "a layout where the / key types something else");
  assert.equal(hit(ev("h", { ctrlKey: true }), "view.shortcuts"), false);
  assert.equal(hit(ev("h", { ctrlKey: true }), "files.history"), true, "Ctrl+H is still History");
  // The sheet listens for it, and both windows mount the sheet.
  const sheet = readFileSync(join(root, "src/ShortcutSheet.tsx"), "utf8");
  assert.match(sheet, /hit\(e, "view\.shortcuts"\)/);
  assert.match(sheet, /e\.key === "Escape"/, "Esc closes it");
  for (const f of ["src/App.tsx", "src/ChatWindow.tsx"]) assert.match(readFileSync(join(root, f), "utf8"), /<ShortcutSheet \/>/, `${f} mounts the sheet`);
  assert.match(readFileSync(join(root, "src/SettingsPane.tsx"), "utf8"), /openShortcutSheet/, "Settings has the item");
});

test("chords match exactly, and translate for the editors and the Mac", () => {
  assert.equal(chordMatches(ev("F", { ctrlKey: true, shiftKey: true }), "Mod+Shift+F"), true);
  assert.equal(chordMatches(ev("f", { ctrlKey: true }), "Mod+Shift+F"), false);
  assert.equal(chordMatches(ev("d", { metaKey: true }), "Ctrl+D"), false, "Ctrl is the Ctrl key, not Cmd");
  assert.equal(hit(ev("j", { ctrlKey: true, shiftKey: true }), "view.terminalOther"), true);
  assert.equal(hit(ev("Escape"), "view.close"), true);
  assert.equal(cmKey("edit.inline"), "Mod-k");
  assert.deepEqual(chordLabel("Mod+Shift+F", false), ["Ctrl", "Shift", "F"]);
  assert.deepEqual(chordLabel("Mod+Shift+F", true), ["⌘", "⇧", "F"]);
  assert.deepEqual(chordLabel("Ctrl+D", true), ["⌃", "D"]);
});

test("the sheet lists every registry entry", async () => {
  const { ShortcutList } = await import("../../src/ShortcutSheet.tsx");
  for (const mac of [false, true]) {
    const html = renderToStaticMarkup(createElement(ShortcutList, { mac }));
    for (const s of all) {
      assert.ok(html.includes(`data-shortcut="${s.id}"`), `${s.id} is listed`);
      assert.ok(html.includes(s.label.replace(/&/g, "&amp;")), `${s.id}: "${s.label}"`);
    }
    for (const g of new Set(all.map((s) => s.group))) assert.ok(html.includes(g.replace(/&/g, "&amp;")), `group ${g}`);
  }
});
