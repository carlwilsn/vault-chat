// The editors' unsaved typing and Carl's caret are state (reports/21 B6): app/viewer's `editing` says, per open file,
// where his caret is and whether the disk has his typing yet, and `saved` fires when it does, so the agent waits
// instead of writing over him. Before, the agent saw only the disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-editing-");
installFakeTauri(vault);
const { EditorWrites } = await import("../../src/editorWrites.ts");
const { setCaret, caretOf, lineColAt, onSaved, noteSaved, _resetCarets } = await import("../../src/editorState.ts");
const { useStore } = await import("../../src/store.ts");
const { viewerOffers } = await import("../../src/plugins/viewer/index.ts");
const { editorWrites } = await import("../../src/saveBeforeSend.ts");

test("pending: typing not on disk yet, until the autosave writes it", async () => {
  let disk = "a";
  const w = new EditorWrites({ read: async () => disk, write: async (_p, t) => void (disk = t) });
  w.queue({ vault: "/v", path: "/v/a.md", text: "ab" }, "a", () => {}, () => {});
  assert.deepEqual(w.pending(), [{ vault: "/v", path: "/v/a.md", chars: 2 }]);
  await w.flush("/v");
  assert.deepEqual(w.pending(), []);
  assert.equal(disk, "ab");
});

test("caret: line and column, and the viewer's editing state for the open file", async () => {
  _resetCarets();
  assert.deepEqual(lineColAt("one\ntwo\nthree", 6), { line: 2, col: 3 });
  const file = `${vault}/notes/hw.md`;
  setCaret(file, 2, 3, 0, 1000);
  assert.deepEqual(caretOf(file), { line: 2, col: 3, selected: 0, at: 1000 });
  useStore.setState({ vaultPath: vault, currentFile: file, currentContent: "one\ntwo", panes: [] } as never);
  editorWrites.queue({ vault, path: file, text: "one\ntwo!" }, "one\ntwo", () => {}, () => {});
  const editing = (await (viewerOffers().state!.editing!.read as () => unknown)()) as any;
  assert.equal(editing.open[0].path, "notes/hw.md");
  assert.equal(editing.open[0].unsaved, true);
  assert.deepEqual(editing.open[0].caret, { line: 2, col: 3, selected: 0, at: 1000 });
  await editorWrites.discard(file);
  const after = (await (viewerOffers().state!.editing!.read as () => unknown)()) as any;
  assert.equal(after.open[0].unsaved, false);
});

test("saved: the viewer hears each save", () => {
  const got: string[] = [];
  const off = onSaved((p) => got.push(p));
  noteSaved("/v/a.md");
  off();
  noteSaved("/v/b.md");
  assert.deepEqual(got, ["/v/a.md"]);
  assert.ok((viewerOffers().events as Record<string, unknown>).saved);
});
