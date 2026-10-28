// No layout survives a restart (Carl: "if I close the app or restart it, just
// have the app be nothing in the viewer"): src/paneLayout.ts saves nothing, and
// clears the per-vault layouts earlier builds kept in localStorage. Also: the
// turn prefix (buildViewportContextText) names the panes the way Show's `pane` does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-panes-");
installFakeTauri(vault);
const W = (rel: string, body: string) => {
  fs.mkdirSync(`${vault}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(`${vault}/${rel}`, body);
};
W("hw/hw3.pdf", "%PDF-1.4 stand-in");
W("notes/lecture6_notes.md", "# Lecture 6\n\nCounterexamples.\n");
W("notes/lecture6_typed.md", "# Lecture 6 (typed)\n");

const { useStore } = await import("../../src/store.ts");
const { placeInPane, clearSavedLayouts, LAYOUT_STORAGE } = await import("../../src/paneLayout.ts");
const { buildViewportContextText } = await import("../../src/voice-elevenlabs.ts");
const S = () => useStore.getState();

const abs = (rel: string) => `${vault}/${rel}`;
const read = (rel: string) => fs.readFileSync(abs(rel), "utf8");
const layoutKeys = () => [...Array(localStorage.length).keys()].map((i) => String(localStorage.key(i))).filter((k) => k.startsWith(LAYOUT_STORAGE));

test("a restart opens with an empty viewer: nothing open is saved, and a layout an earlier build saved is cleared, not put back", async () => {
  // What an earlier build left behind, plus an unrelated key that must stay.
  localStorage.setItem(`${LAYOUT_STORAGE}:${vault.toLowerCase()}`, JSON.stringify({ v: 1, files: ["hw/hw3.pdf", "notes/lecture6_notes.md"], direction: "horizontal", active: 1 }));
  localStorage.setItem("vault_chat_theme", "light");
  useStore.setState({ vaultPath: vault, currentFile: null, currentContent: "", panes: [], splitDirection: null, activePaneId: null, viewport: null });

  // The app's start (App.tsx): clear, twice to show it is harmless to repeat.
  clearSavedLayouts();
  clearSavedLayouts();
  assert.deepEqual(layoutKeys(), []);
  assert.equal(localStorage.getItem("vault_chat_theme"), "light");

  // Work with a split open: nothing is written.
  placeInPane("left", abs("hw/hw3.pdf"), "");
  placeInPane("right", abs("notes/lecture6_notes.md"), read("notes/lecture6_notes.md"));
  S().setViewport({ path: abs("hw/hw3.pdf"), page: 4, totalPages: 9 });
  assert.equal(S().panes.length, 2);
  assert.deepEqual(layoutKeys(), []);

  // Restart: a fresh store, the same localStorage, the app's start again. The viewer stays empty.
  useStore.setState({ currentFile: null, currentContent: "", panes: [], splitDirection: null, activePaneId: null, viewport: null });
  clearSavedLayouts();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(S().currentFile, null);
  assert.equal(S().panes.length, 0);
});

test("the turn prefix says the layout in Show's names: which file is in the left and the right pane, and which is active", () => {
  useStore.setState({ vaultPath: vault, currentFile: null, panes: [], splitDirection: null, activePaneId: null, viewport: null });
  placeInPane("left", abs("hw/hw3.pdf"), "");
  placeInPane("right", abs("notes/lecture6_typed.md"), read("notes/lecture6_typed.md"));
  const text = buildViewportContextText(S());
  assert.match(text, /^Split screen on \(side by side\): left pane: hw\/hw3\.pdf · right pane: notes\/lecture6_typed\.md \(active\) \(Show's pane: "left" \/ "right" puts a file in one\)/);
  assert.match(text, />>> USER IS CURRENTLY VIEWING .*lecture6_typed\.md <<</);
  assert.match(text, /OTHER pane \(left\) document: .*hw3\.pdf \(no text content\)/);
  // One file: no split line.
  useStore.setState({ panes: [], splitDirection: null, activePaneId: null });
  assert.doesNotMatch(buildViewportContextText(S()), /Split screen/);
});
