// An open file changing underneath its editor (src/liveReload.ts settleOpenFile, src/merge3.ts):
//  - the sync bringing back the editor's own save is an echo: no notice, the buffer untouched (Carl's 11-23
//    "Changed by the agent" bar on his own typing in What's left.md);
//  - a real change with a clean buffer reloads silently;
//  - a real change under unsaved typing that touches other lines merges, and the merge is saved;
//  - only a real conflict shows the notice, naming who changed it only when that is known.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-echo-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
const NOTE = `${vault}/What's left.md`;

const { useStore } = await import("../../src/store.ts");
const live = await import("../../src/liveReload.ts");
const { EditorWrites } = await import("../../src/editorWrites.ts");
const { merge3 } = await import("../../src/merge3.ts");
const S = () => useStore.getState();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notice = () => live.useLiveFiles.getState().diskChanged[NOTE];

// The editor's saves, as src/saveBeforeSend.ts wires them: each noted as its own before it is written.
const writes = new EditorWrites({
  read: async (p) => fs.readFileSync(p, "utf8"),
  write: async (p, t) => (live.noteOwnWrite(p, t), fs.writeFileSync(p, t)),
  isOwn: live.isOwnWrite,
});

/** One editor pane on NOTE, as src/plugins/viewer/Pane.tsx keeps it: the last text saved / loaded, the buffer. */
function openEditor(text: string) {
  fs.writeFileSync(NOTE, text);
  useStore.setState({ vaultPath: vault });
  S().setCurrentFile(NOTE, text);
  const ed = { saved: text, user: text };
  const conflicts: string[] = [];
  const queue = (value: string, rebase = false) =>
    writes.queue({ vault, path: NOTE, text: value }, ed.saved, () => (ed.saved = value), () => conflicts.push(value), rebase);
  const un = live.registerDirty(NOTE, () => ed.user !== ed.saved, {
    base: () => ed.saved,
    buffer: () => ed.user,
    adopt: (merged, disk) => {
      ed.saved = disk;
      ed.user = merged;
      if (merged !== S().currentContent) S().reloadCurrent(NOTE, merged);
      if (merged !== disk) queue(merged, true);
      else void writes.discard(NOTE);
    },
  });
  const type = (value: string) => {
    ed.user = value;
    S().reloadCurrent(NOTE, value);
    queue(value);
  };
  /** Wait out the 300 ms autosave. */
  const settle = () => tick(400);
  return { ed, type, settle, conflicts, close: () => (un(), void writes.discard(NOTE), live.setDiskChanged(NOTE, false)) };
}

test("an echo of the editor's own save while Carl keeps typing: no notice, his buffer untouched", async () => {
  const e = openEditor("# What's left\n\n- a\n");
  e.type("# What's left\n\n- a\n- b\n");
  await e.settle();
  assert.equal(fs.readFileSync(NOTE, "utf8"), "# What's left\n\n- a\n- b\n", "saved");
  e.type("# What's left\n\n- a\n- b\n- c\n");
  e.type("# What's left\n\n- a\n- b\n- c\n- d\n"); // typing ahead of the disk (the autosave not run yet)
  // The sync round-trips: a merge naming the file, and a cycle comparing every open file, both find his save.
  await live.refreshOpenFiles({ vault, paths: ["What's left.md"] });
  await live.refreshOpenFiles({ vault });
  assert.equal(notice(), undefined, "no bar for his own write");
  assert.equal(S().currentContent, "# What's left\n\n- a\n- b\n- c\n- d\n");
  // An older save of his coming back late is an echo too; the autosave still lands (no conflict).
  fs.writeFileSync(NOTE, "# What's left\n\n- a\n- b\n");
  await e.settle();
  assert.equal(notice(), undefined);
  assert.deepEqual(e.conflicts, []);
  assert.equal(fs.readFileSync(NOTE, "utf8"), "# What's left\n\n- a\n- b\n- c\n- d\n");
  // Now an older save (not the base any more) comes back under new typing: still his own, no bar, the save lands.
  assert.equal(e.ed.saved, "# What's left\n\n- a\n- b\n- c\n- d\n");
  e.type("# What's left\n\n- a\n- b\n- c\n- d\n- e\n");
  fs.writeFileSync(NOTE, "# What's left\n\n- a\n- b\n");
  await live.refreshOpenFiles({ vault });
  assert.equal(notice(), undefined);
  assert.equal(S().currentContent, "# What's left\n\n- a\n- b\n- c\n- d\n- e\n");
  await e.settle();
  assert.deepEqual(e.conflicts, []);
  assert.equal(fs.readFileSync(NOTE, "utf8"), "# What's left\n\n- a\n- b\n- c\n- d\n- e\n");
  e.close();
});

test("an outside change with a clean buffer reloads silently", async () => {
  const e = openEditor("one\ntwo\n");
  fs.writeFileSync(NOTE, "one\ntwo\nthree from the agent\n");
  await live.refreshOpenFiles({ vault, paths: ["What's left.md"] });
  assert.equal(S().currentContent, "one\ntwo\nthree from the agent\n");
  assert.equal(notice(), undefined);
  e.close();
});

test("unsaved typing and an outside change on other lines merge, and the merge is saved", async () => {
  const base = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  const e = openEditor(base);
  e.type("ALPHA by Carl\nbeta\ngamma\ndelta\nepsilon\n"); // not saved yet
  fs.writeFileSync(NOTE, "alpha\nbeta\ngamma\ndelta\nepsilon by the agent\n");
  await live.refreshOpenFiles({ vault });
  const merged = "ALPHA by Carl\nbeta\ngamma\ndelta\nepsilon by the agent\n";
  assert.equal(S().currentContent, merged, "both edits on screen");
  assert.equal(notice(), undefined, "no bar");
  await e.settle();
  assert.equal(fs.readFileSync(NOTE, "utf8"), merged, "the merge saved over the outside change");
  assert.deepEqual(e.conflicts, []);
  // The change found by the save itself (before any refresh) merges the same way.
  e.type("ALPHA by Carl\nbeta, again\ngamma\ndelta\nepsilon by the agent\n");
  fs.writeFileSync(NOTE, "ALPHA by Carl\nbeta\ngamma\ndelta\nepsilon by the agent, again\n");
  await e.settle();
  assert.equal(e.conflicts.length, 1, "the save saw it");
  const disk = fs.readFileSync(NOTE, "utf8");
  live.settleOpenFile(NOTE, disk, "outside"); // what the pane's conflict callback does with the disk it reads
  await e.settle();
  assert.equal(fs.readFileSync(NOTE, "utf8"), "ALPHA by Carl\nbeta, again\ngamma\ndelta\nepsilon by the agent, again\n");
  assert.equal(notice(), undefined);
  e.close();
});

test("a real conflict shows the notice, naming the source only when known; the buffer stays", async () => {
  const e = openEditor("line one\nline two\n");
  e.type("line one, Carl's\nline two\n");
  fs.writeFileSync(NOTE, "line one, the agent's\nline two\n");
  await live.refreshOpenFiles({ vault });
  assert.equal(notice(), "outside", "an unnamed change: Changed outside the editor");
  assert.equal(live.CHANGE_LABEL[notice()!], "Changed outside the editor");
  assert.equal(S().currentContent, "line one, Carl's\nline two\n");
  await live.refreshOpenFiles({ vault, paths: ["What's left.md"] });
  assert.equal(notice(), "box", "a merge from the box names it: Changed on the box");
  // The disk coming back to his text (Keep mine elsewhere, an undo) clears it.
  fs.writeFileSync(NOTE, "line one, Carl's\nline two\n");
  await live.refreshOpenFiles({ vault });
  assert.equal(notice(), undefined);
  e.close();
});

test("merge3: separate lines merge, the same or adjacent lines conflict, identical changes are one", () => {
  const b = "a\nb\nc\nd\ne\n";
  assert.equal(merge3(b, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"), "A\nb\nc\nd\nE\n");
  assert.equal(merge3(b, "a\nb\nc\nd\ne\nmine\n", "theirs\na\nb\nc\nd\ne\n"), "theirs\na\nb\nc\nd\ne\nmine\n");
  assert.equal(merge3(b, "a\nB1\nc\nd\ne\n", "a\nB2\nc\nd\ne\n"), null);
  assert.equal(merge3(b, "a\nB\nc\nd\ne\n", "a\nb\nC\nd\ne\n"), null, "adjacent lines: a conflict, as git");
  assert.equal(merge3(b, "a\nB\nc\nd\ne\n", "a\nB\nc\nd\ne\n"), "a\nB\nc\nd\ne\n");
  assert.equal(merge3(b, "a\nc\nd\ne\n", "a\nb\nc\nd\n"), "a\nc\nd\n", "deletions on both ends");
  assert.equal(merge3("", "x\n", "y\n"), null);
});
