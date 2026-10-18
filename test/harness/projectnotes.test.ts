// "Project notes" in the chats panel (src/ChatsPanel.tsx → openProjectNotes in
// src/projects.ts): the project's shared project.md lives in the hidden
// agent-projects/ folder, so the menu opens it in the viewer, writing it first
// with the project's heading when it is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-projnotes-").replace(/\\/g, "/");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", () => null);
fake.setHandler("path_exists", ({ path: p }) => fs.existsSync(p));
fake.setHandler("create_dir", ({ path: p }) => void fs.mkdirSync(p, { recursive: true }));
fake.setHandler("git_repo_root_for_file", () => null);

const { useStore } = await import("../../src/store.ts");
const projects = await import("../../src/projects.ts");
useStore.setState({ vaultPath: vault } as any);

const writes = () => fake.calls.filter((c) => c.cmd === "write_text_file");

test("opens an existing project.md in the viewer, unchanged", async () => {
  const p = path.join(vault, "agent-projects/coconut/project.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "# Coconut\n\nUse YOLO.\n");
  const before = writes().length;
  const opened = await projects.openProjectNotes("coconut", "Coconut");
  assert.equal(opened, `${vault}/agent-projects/coconut/project.md`);
  assert.equal(useStore.getState().currentFile, opened);
  assert.equal(useStore.getState().currentContent, "# Coconut\n\nUse YOLO.\n");
  assert.equal(writes().length, before, "nothing written");
});

test("a missing project.md is created with a one-line heading, then opened; fullscreen chat steps aside", async () => {
  useStore.setState({ chatFullscreen: true } as any);
  const opened = await projects.openProjectNotes("bitnet-160m", "BitNet 160M");
  assert.equal(opened, `${vault}/agent-projects/bitnet-160m/project.md`);
  assert.equal(fs.readFileSync(path.join(vault, "agent-projects/bitnet-160m/project.md"), "utf8"), "# BitNet 160M\n");
  assert.equal(useStore.getState().currentFile, opened);
  assert.equal(useStore.getState().currentContent, "# BitNet 160M\n");
  assert.equal(useStore.getState().chatFullscreen, false, "the viewer is visible");
  // Opening again reads it back, no second write.
  const n = writes().length;
  await projects.openProjectNotes("bitnet-160m", "BitNet 160M");
  assert.equal(writes().length, n);
});

test("a slug that is not a slug opens nothing", async () => {
  assert.equal(await projects.openProjectNotes("../escape", "x"), null);
  assert.equal(fs.existsSync(path.join(vault, "escape")), false);
});

test("in the popout it goes to main (which has the viewer) and writes nothing here", async () => {
  const sent: [string, string][] = [];
  projects.routeProjectNotesTo((slug, name) => sent.push([slug, name]));
  const n = writes().length;
  assert.equal(await projects.openProjectNotes("whiteboard", "Whiteboard"), null);
  assert.deepEqual(sent, [["whiteboard", "Whiteboard"]]);
  assert.equal(writes().length, n);
  assert.equal(fs.existsSync(path.join(vault, "agent-projects/whiteboard")), false);
});
