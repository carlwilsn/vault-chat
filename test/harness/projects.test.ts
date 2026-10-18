// Projects on the desktop (src/projects.ts), local mode: they live in
// `<vault>/agent-projects/<slug>/`; opening a vault moves them from the old
// place (.vault-chat/projects/) once per session and hides the folder through
// the hide list (.vaultchatignore) the first time — never again once Carl
// unhides it. The Tauri side is lib.rs prepare_agent_projects; the fake runs
// the same moves (server/context/layout.ts) on a temp vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-projects-");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", () => null);
// The chip's "vc-projects-changed" event: node's global has no dispatchEvent.
const g = globalThis as any;
if (typeof g.dispatchEvent !== "function") g.dispatchEvent = () => true;
fake.setHandler("list_markdown_files", () => []);
fake.setHandler("path_exists", ({ path: p }) => fs.existsSync(p));
fake.setHandler("create_dir", ({ path: p }) => void fs.mkdirSync(p, { recursive: true }));
// glob_files for the one pattern listLocal uses: "<dir>/*/project.md" under cwd.
fake.setHandler("glob_files", ({ pattern, cwd }) => {
  const m = /^([^*]+)\/\*\/project\.md$/.exec(pattern);
  if (!m) return [];
  const root = path.join(cwd, m[1]!);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((d) => path.join(root, d, "project.md"))
    .filter((f) => fs.existsSync(f))
    .map((f) => f.replace(/\\/g, "/"));
});

const { useStore } = await import("../../src/store.ts");
const projects = await import("../../src/projects.ts");
const { PROJECTS_DIR, LEGACY_PROJECTS_DIR, HIDE_FILE } = await import("../../src/agentProjects.ts");

const put = (rel: string, s: string) => {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const hideLines = () => (fs.existsSync(path.join(vault, HIDE_FILE)) ? fs.readFileSync(path.join(vault, HIDE_FILE), "utf8").split("\n").filter(Boolean) : []);
const prepares = () => fake.calls.filter((c) => c.cmd === "prepare_agent_projects").length;

test("the folder is agent-projects/, the old place .vault-chat/projects/", () => {
  assert.equal(PROJECTS_DIR, "agent-projects");
  assert.equal(LEGACY_PROJECTS_DIR, ".vault-chat/projects");
  assert.equal(HIDE_FILE, ".vaultchatignore");
});

test("opening an old vault moves its projects to agent-projects/ and hides the folder; once per session", async () => {
  put(".vault-chat/projects/coconut/project.md", "# Coconut\n");
  put(".vault-chat/projects/coconut/memory.md", "# Memory: Coconut\n\n- use YOLO\n");
  put(".vault-chat/projects/bitnet-160m/project.md", "# BitNet 160M\n");
  useStore.setState({ vaultPath: vault } as any);

  const list = await projects.listProjects(vault);
  assert.deepEqual(list, [
    { slug: "bitnet-160m", name: "BitNet 160M" },
    { slug: "coconut", name: "Coconut" },
  ]);
  assert.equal(fs.readFileSync(path.join(vault, "agent-projects/coconut/memory.md"), "utf8"), "# Memory: Coconut\n\n- use YOLO\n");
  assert.equal(fs.existsSync(path.join(vault, ".vault-chat/projects")), false, "nothing left behind");
  assert.deepEqual(hideLines(), ["agent-projects"]);
  const r = await projects.prepareVaultProjects(vault);
  assert.deepEqual(r?.moved.sort(), ["bitnet-160m", "coconut"]);
  assert.equal(r?.hidden, true);

  await projects.listProjects(vault);
  await projects.prepareVaultProjects(vault);
  assert.equal(prepares(), 1, "the move runs once per vault per session");
  const glob = fake.calls.find((c) => c.cmd === "glob_files");
  assert.equal(glob?.args.pattern, "agent-projects/*/project.md");
});

test("a project made here lands in agent-projects/; unhidden by Carl, a new project does not hide it again", async () => {
  const id = useStore.getState().newConversation();
  const r = await projects.setConversationProject(id, "Whiteboard", []);
  assert.deepEqual(r, { ok: true, slug: "whiteboard" });
  // A plain grouping: its folder and project.md (the shared notes), no plan, progress or memory files.
  assert.deepEqual(fs.readdirSync(path.join(vault, "agent-projects/whiteboard")), ["project.md"]);
  assert.equal(fs.readFileSync(path.join(vault, "agent-projects/whiteboard/project.md"), "utf8"), "# Whiteboard\n");
  assert.equal(fs.existsSync(path.join(vault, ".vault-chat/projects/whiteboard")), false);
  assert.deepEqual(hideLines(), ["agent-projects"]);

  // The Hidden files modal's Unhide (remove_from_ignore) empties the list.
  fs.writeFileSync(path.join(vault, HIDE_FILE), "");
  const id2 = useStore.getState().newConversation();
  await projects.setConversationProject(id2, "Thesis", await projects.listProjects(vault));
  assert.ok(fs.existsSync(path.join(vault, "agent-projects/thesis/project.md")));
  assert.deepEqual(hideLines(), [], "never re-hidden");
  assert.deepEqual(fake.unknown, []);
});

test("a fresh vault: no projects, no folder, nothing hidden", async () => {
  const v2 = makeTempVault("vc-projects-empty-");
  assert.deepEqual(await projects.listProjects(v2), []);
  assert.equal(fs.existsSync(path.join(v2, PROJECTS_DIR)), false);
  assert.equal(fs.existsSync(path.join(v2, HIDE_FILE)), false);
});
