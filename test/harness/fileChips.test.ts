// File chips (src/fileChip.tsx, src/plugins/composer/chips.ts): an @-reference in the composer is one thing (Backspace
// and Delete take it whole, the arrows step over it, the caret never rests in it); Carl's @name and a reply's link to a
// vault file become chips; a chip's click opens the file through the agent's own open (chipIO.open, Show's path) and its
// menu's items through box:workspace / the tree's reveal.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-filechips-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.document = document;
(document as any).defaultView ??= lw;

const { useStore } = await import("../../src/store.ts");
const { chipRanges, chipKey, snapCaret } = await import("../../src/plugins/composer/chips.ts");
const { FileChip, chipIO, resolveVaultFile } = await import("../../src/fileChip.tsx");
const { mentionLinks } = await import("../../src/plugins/chat-rows/rows.tsx");

/** A React handler called as the browser would (linkedom's events don't reach React's root listener). */
function fire(node: unknown, prop: "onClick" | "onContextMenu"): void {
  const k = Object.keys(node as object).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "a React element");
  (node as any)[k!][prop]({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
}

const file = (rel: string, is_dir = false) => ({ path: `${vault}/${rel}`, name: rel.split("/").pop()!, is_dir, depth: rel.split("/").length - 1, hidden: false });
useStore.setState({ vaultPath: vault, files: [file("notes", true), file("notes/essay.md"), file("fig.png"), file("projects/x/writeup.md")] } as any);

test("chip ranges: each tracked @name, only where it ends a word", () => {
  const t = "see @essay.md and @essay.md, not @essay.mdx or a@essay.md";
  assert.deepEqual(
    chipRanges(t, ["essay.md"]).map((r) => [r.start, r.end]),
    [
      [4, 13],
      [18, 27],
    ],
  );
  assert.deepEqual(chipRanges("plain text", ["essay.md"]), []);
});

test("Backspace and Delete take a chip whole; the arrows step over it; the caret snaps out of it", () => {
  const t = "see @essay.md now";
  const r = chipRanges(t, ["essay.md"]);
  // Backspace right after the chip (and anywhere in it): the whole "@essay.md" goes.
  assert.deepEqual(chipKey(t, r, 13, "Backspace"), { text: "see  now", caret: 4 });
  assert.deepEqual(chipKey(t, r, 8, "Backspace"), { text: "see  now", caret: 4 });
  // Backspace at its start deletes the space before it, as normal: not ours.
  assert.equal(chipKey(t, r, 4, "Backspace"), null);
  assert.deepEqual(chipKey(t, r, 4, "Delete"), { text: "see  now", caret: 4 });
  assert.equal(chipKey(t, r, 13, "Delete"), null);
  assert.deepEqual(chipKey(t, r, 13, "ArrowLeft"), { text: t, caret: 4 });
  assert.deepEqual(chipKey(t, r, 4, "ArrowRight"), { text: t, caret: 13 });
  assert.equal(chipKey(t, r, 2, "ArrowRight"), null);
  // A letter typed against a chip keeps a space between, so the chip stays one.
  assert.deepEqual(chipKey(t, r, 4, "X"), { text: "see X @essay.md now", caret: 5 });
  assert.deepEqual(chipKey(t, r, 13, "a"), { text: "see @essay.md a now", caret: 15 });
  assert.equal(chipKey(t, r, 13, ","), null);
  assert.equal(chipKey(t, r, 2, "a"), null);
  assert.equal(snapCaret(r, 6), 4);
  assert.equal(snapCaret(r, 11), 13);
  assert.equal(snapCaret(r, 15), 15);
});

test("a vault path, a path from the box's copy, a wiki-style tail and an @name resolve to the laptop's file; others don't", () => {
  assert.equal(resolveVaultFile("notes/essay.md")?.path, `${vault}/notes/essay.md`);
  assert.equal(resolveVaultFile("/home/someone/vc/vaults/school2/projects/x/writeup.md")?.path, `${vault}/projects/x/writeup.md`);
  assert.equal(resolveVaultFile("essay.md")?.path, `${vault}/notes/essay.md`);
  assert.equal(resolveVaultFile("notes")?.isDir, true);
  assert.equal(resolveVaultFile("https://example.com/notes/essay.md"), null);
  assert.equal(resolveVaultFile("missing.md"), null);
});

test("Carl's @names in a sent message become links to their files (the tracked path first), code left alone", () => {
  const sent = "read @essay.md, and @fig.png. `@essay.md` stays; @nobody too\n\n[attached: @essay.md → " + vault + "/notes/essay.md]";
  const text = sent.replace(/\n*\[attached:[^\]]*\]\s*$/, "");
  assert.equal(mentionLinks(text, sent), "read [essay.md](<notes/essay.md>), and [fig.png](<fig.png>). `@essay.md` stays; @nobody too");
});

test("a chip's click opens its file through the agent's open; its menu reveals, opens beside and copies", async () => {
  const calls: string[] = [];
  const saved = { ...chipIO };
  Object.assign(chipIO, {
    open: async (rel: string) => void calls.push(`open ${rel}`),
    beside: async (rel: string) => void calls.push(`beside ${rel}`),
    reveal: async (p: string) => void calls.push(`reveal ${p}`),
    copy: async (t: string) => void calls.push(`copy ${t}`),
  });
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as any);
    await act(async () => root.render(createElement(FileChip, { path: `${vault}/notes/essay.md` })));
    const chip = host.querySelector('[data-el="file-chip"]') as any;
    assert.ok(chip, "the chip is drawn");
    assert.equal(chip.getAttribute("title"), "notes/essay.md", "hover shows the path");
    assert.match(chip.textContent, /essay\.md/);
    assert.doesNotMatch(chip.textContent, /@/);
    await act(async () => fire(chip, "onClick"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ["open notes/essay.md"]);
    await act(async () => fire(chip, "onContextMenu"));
    const items = [...document.querySelectorAll('[data-el="file-chip-menu"] button')] as any[];
    assert.deepEqual(items.map((b) => b.textContent), ["Open", "Open beside", "Show in files", "Copy path"]);
    // Each item: the menu reopens for the next one, as a click closes it.
    for (const label of ["Open beside", "Show in files", "Copy path"]) {
      await act(async () => fire(chip, "onContextMenu"));
      const b = ([...document.querySelectorAll('[data-el="file-chip-menu"] button')] as any[]).find((x) => x.textContent === label);
      await act(async () => fire(b, "onClick"));
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.deepEqual(calls, ["open notes/essay.md", "beside notes/essay.md", `reveal ${vault}/notes/essay.md`, "copy notes/essay.md"]);
    await act(async () => root.unmount());
  } finally {
    Object.assign(chipIO, saved);
  }
});
