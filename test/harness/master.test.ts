// The vault-chat folder on the laptop (src/master.ts): the vault picker's list, setting the folder (its file names
// the box the open vault syncs with), bringing what the box has and this laptop lacks (each vault and project made
// from its hub, a project with its own remote and branch), "New vault" (made on the box and here), "+ New project"'s
// note on what syncs, and the migration's switch and one-step switch back (never both copies syncing).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-master-");
const fake = installFakeTauri(vault);
const M = await import("../../src/master.ts");
const { projectSyncNote } = await import("../../src/NewProjectForm.tsx");
const { useStore } = await import("../../src/store.ts");

after(async () => (await import("../../src/vaultSync.ts")).stopVaultSyncLoop());

const BOX = "https://thinkbox.tail.ts.net";
const files = new Map<string, string>();
const dirs = new Map<string, string[]>();
const inits: any[] = [];
const posts: any[] = [];
let boxInfo: any = null;
fake.setHandler("read_text_file", ({ path }: any) => {
  if (!files.has(path)) throw new Error("no file");
  return files.get(path);
});
fake.setHandler("write_text_file", ({ path, contents }: any) => void files.set(path, contents));
fake.setHandler("create_dir", ({ path }: any) => void (dirs.has(path) || dirs.set(path, [])));
fake.setHandler("list_dir", ({ path }: any) => (dirs.get(path) ?? []).map((name) => ({ name, path: `${path}/${name}`, is_dir: true })));
fake.setHandler("vault_box_config", ({ vault: v }: any) => (v === "C:/Users/carl/github/school2" ? { box: BOX, vault: "school2", name: "thinkbox" } : null));
fake.setHandler("box_get_json", ({ url }: any) => (url.endsWith("/api/v1/master") && boxInfo ? { status: 200, body: JSON.stringify(boxInfo) } : { status: 404, body: "{}" }));
fake.setHandler("box_post_json", ({ url, body }: any) => {
  posts.push({ url, body: JSON.parse(body) });
  return { status: 200, body: JSON.stringify({ ok: true, name: JSON.parse(body).name, created: true }) };
});
fake.setHandler("master_repo_init", (a: any) => {
  inits.push(a);
  const parts = a.dest.split("/");
  const name = parts.pop();
  const parent = parts.join("/");
  dirs.set(parent, [...(dirs.get(parent) ?? []), name]);
  return "cloned from the box";
});
for (const c of ["append_sync_log", "machine_host", "read_vault_config"]) fake.setHandler(c, () => null);
fake.setHandler("vault_sync_status", () => ({ has_changes: false, nested_repos: [] }));
fake.setHandler("vault_commit_local", () => ({ ok: true, message: "no local changes", error: false }));
fake.setHandler("vault_box_sync", () => ({ configured: true, ok: true, message: "synced", committed: false, merged: false, conflict: null, error: null, error_kind: null, changes_waiting: 0, big_files: [], github_warning: null, github_pushed_at: null }));

test("the picker without a folder: nothing to pick (Settings says where to set it)", () => {
  assert.equal(M.masterPath(), null);
  assert.deepEqual(M.pickerItems(null, [], null), []);
});

test("setting the folder: its layout made, its file names the open vault's box", async () => {
  useStore.setState({ vaultPath: "C:/Users/carl/github/school2" } as any);
  const r = await M.setMasterPath("C:\\Users\\carl\\vc");
  assert.deepEqual(r, { ok: true, path: "C:/Users/carl/vc" });
  assert.equal(M.masterPath(), "C:/Users/carl/vc");
  assert.ok(dirs.has("C:/Users/carl/vc/vaults") && dirs.has("C:/Users/carl/vc/projects"));
  assert.deepEqual(JSON.parse(files.get("C:/Users/carl/vc/.vault-chat-master.json")!), { projects: {}, box: BOX, name: "thinkbox" });
  assert.deepEqual(await M.setMasterPath("vc"), { error: '"vc" is not a full path' });
});

test("what the box has and this laptop lacks is made here from its hub: two vaults and a project with its own remote", async () => {
  dirs.set("C:/Users/carl/vc/vaults", []);
  boxInfo = {
    master: "/home/carl/vc",
    suggested: "/home/carl/vc",
    vaults: [{ name: "school2", path: "/home/carl/vc/vaults/school2" }, { name: "physics", path: "/home/carl/vc/vaults/physics" }],
    projects: [
      { name: "vault-chat", path: "/home/carl/vc/projects/vault-chat", branch: "main", origin: "https://github.com/carlwilsn/vault-chat.git", syncing: true, ok: true, error: null },
      { name: "lecture-tools", path: "/home/carl/vc/projects/lecture-tools", branch: "main", origin: null, syncing: true, ok: true, error: null },
      { name: "odd", path: "/x", branch: null, origin: null, syncing: false, ok: null, error: "detached" },
    ],
  };
  // school2 already syncs from C:/Users/carl/github/school2 (tracked): never a second copy in the folder (its
  // migration brings it in).
  localStorage.setItem("vault_chat_tracked_vaults", JSON.stringify(["C:/Users/carl/github/school2"]));
  const out = await M.syncMasterFolder();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.made, ["vaults/physics", "projects/vault-chat", "projects/lecture-tools"]);
  assert.deepEqual(
    inits.map((i) => [i.dest, i.remoteUrl, i.branch, i.originUrl]),
    [
      ["C:/Users/carl/vc/vaults/physics", `${BOX}/git/physics.git`, "master", null],
      ["C:/Users/carl/vc/projects/vault-chat", `${BOX}/git/projects/vault-chat.git`, "main", "https://github.com/carlwilsn/vault-chat.git"],
      ["C:/Users/carl/vc/projects/lecture-tools", `${BOX}/git/projects/lecture-tools.git`, "main", null],
    ],
  );
  // Each project's branch is in the folder's file (box_sync.rs reads it).
  assert.deepEqual(JSON.parse(files.get("C:/Users/carl/vc/.vault-chat-master.json")!).projects["vault-chat"], { branch: "main", origin: "https://github.com/carlwilsn/vault-chat.git" });
  // A second pass makes nothing again.
  inits.length = 0;
  assert.deepEqual((await M.syncMasterFolder()).made, []);
  assert.equal(inits.length, 0);
});

test("the vault picker: every vault in the folder, the open one ticked, then New vault — nothing from elsewhere", async () => {
  const names = await M.localVaults();
  assert.deepEqual(names, ["physics"]);
  assert.deepEqual(M.pickerItems(M.masterPath(), ["physics", "school2"], "C:/Users/carl/vc/vaults/school2"), [
    { kind: "vault", name: "physics", path: "C:/Users/carl/vc/vaults/physics", open: false },
    { kind: "vault", name: "school2", path: "C:/Users/carl/vc/vaults/school2", open: true },
    { kind: "new" },
  ]);
});

test("New vault: made on the box (POST /api/v1/vaults) and here, from the box's hub", async () => {
  posts.length = 0;
  inits.length = 0;
  const r = await M.newVault("Linear Algebra");
  assert.deepEqual(r, { path: "C:/Users/carl/vc/vaults/Linear-Algebra" });
  assert.deepEqual(posts, [{ url: `${BOX}/api/v1/vaults`, body: { name: "Linear-Algebra" } }]);
  assert.deepEqual(inits.map((i) => [i.dest, i.remoteUrl, i.branch]), [["C:/Users/carl/vc/vaults/Linear-Algebra", `${BOX}/git/Linear-Algebra.git`, "master"]]);
});

test("+ New project says what syncs: its folder in projects/ does (no folder elsewhere to pick)", () => {
  assert.match(projectSyncNote({ kind: "new" }, "/home/carl/vc"), /projects\/: synced with this laptop/);
  assert.match(projectSyncNote({ kind: "new" }, null), /does not sync/);
  assert.match(projectSyncNote({ kind: "none" }, "/home/carl/vc"), /vault/);
});

test("a copy being brought in (its .git marked) gets no sync loop at all", async () => {
  const marked = "C:/Users/carl/vc/vaults/incoming";
  dirs.set("C:/Users/carl/vc/vaults", [...(dirs.get("C:/Users/carl/vc/vaults") ?? []), "incoming"]);
  fake.setHandler("path_exists", ({ path }: any) => path === `${marked}/.git/vault-chat-no-sync`);
  boxInfo = { ...boxInfo, vaults: boxInfo.vaults.filter((v: any) => v.name !== "incoming") };
  const before = fake.calls.length;
  await M.syncMasterFolder();
  const touched = fake.calls.slice(before).filter((x: any) => JSON.stringify(x.args ?? {}).includes("/vaults/incoming") && x.cmd !== "path_exists");
  assert.deepEqual(touched.map((x: any) => x.cmd), []);
  const { activeSyncVaults } = await import("../../src/vaultSync.ts");
  assert.ok(!activeSyncVaults().includes(marked));
  assert.ok(activeSyncVaults().includes("C:/Users/carl/vc/vaults/physics"));
});

test("a vault elsewhere whose copy is in the folder never syncs again at launch (two laptop copies never both write master)", async () => {
  fake.setHandler("path_exists", () => false);
  dirs.set("C:/Users/carl/vc/vaults", ["physics", "school2"]);
  assert.equal(await M.shadowedByFolder("C:/Users/carl/github/school2"), true);
  assert.equal(await M.shadowedByFolder("C:/Users/carl/vc/vaults/school2"), false);
  dirs.set("C:/Users/carl/vc/vaults", ["physics"]);
  assert.equal(await M.shadowedByFolder("C:/Users/carl/github/school2"), false);
  // Its copy still being brought in (marked): the original keeps syncing until the copy is switched in.
  dirs.set("C:/Users/carl/vc/vaults", ["physics", "school2"]);
  fake.setHandler("path_exists", ({ path }: any) => path === "C:/Users/carl/vc/vaults/school2/.git/vault-chat-no-sync");
  assert.equal(await M.shadowedByFolder("C:/Users/carl/github/school2"), false);
  fake.setHandler("path_exists", () => false);
  const { untrackVault, trackedVaults } = await import("../../src/vaultSync.ts");
  localStorage.setItem("vault_chat_tracked_vaults", JSON.stringify(["C:/Users/carl/github/school2", "C:/Users/carl/notes"]));
  untrackVault(["C:", "Users", "carl", "github", "school2", ""].join(String.fromCharCode(92)));
  assert.deepEqual(trackedVaults(), ["C:/Users/carl/notes"]);
});
