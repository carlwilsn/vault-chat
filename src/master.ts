// The vault-chat folder on this laptop (Carl, 2026-10-27): one folder per machine, the same shape on the box
// (server/master.ts):
//
//   <folder>/vaults/<name>/      a vault          → the box's <folder>/vaults/<name>, through /git/<name>.git
//   <folder>/projects/<name>/    a project folder → the box's <folder>/projects/<name>, through /git/projects/<name>.git
//   <folder>/.vault-chat-master.json   which box, and each project's branch (read by box_sync.rs)
//
// Every repo under it is synced by the one box-sync cycle (box_sync.rs), one loop per repo. Changing vaults is a
// pick from <folder>/vaults; "New vault" makes one here and on the box. The box's repos this laptop lacks are made
// here from the box's hub. Everything lives in the folder (Carl, 2026-10-28): no vault from elsewhere. A repo whose
// .git holds `vault-chat-no-sync` (a copy being brought in) never syncs, here or in box_sync.rs.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { boxGet, boxPost, type Link } from "./boxChat";
import { ensureProjectSyncLoop, ensureVaultSyncLoop, readBoxConfig, boxVaultName, trackedVaults } from "./vaultSync";

export const MASTER_KEY = "vault_chat_master_path";
export const MASTER_FILE = ".vault-chat-master.json";
/** In a repo's .git: never sync it (a copy being brought into the folder). Same name in box_sync.rs. */
export const NO_SYNC_MARK = "vault-chat-no-sync";

export type MasterFile = { box?: string; name?: string; projects?: Record<string, { branch?: string; origin?: string | null }> };
export type BoxMasterInfo = {
  master: string | null;
  vaults: { name: string; path: string }[];
  projects: { name: string; path: string; branch: string | null; origin: string | null; syncing: boolean; ok: boolean | null; error: string | null }[];
};

const fwd = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
export const joinPath = (...parts: string[]) => parts.map((p, i) => (i === 0 ? fwd(p) : fwd(p).replace(/^\/+/, ""))).join("/");

export function masterLayout(m: string): { vaults: string; projects: string; file: string; logs: string } {
  return { vaults: joinPath(m, "vaults"), projects: joinPath(m, "projects"), file: joinPath(m, MASTER_FILE), logs: joinPath(m, ".sync-logs") };
}

/** A repo's name under the folder (as on the box): letters, digits, . _ -, up to 64, not starting with a dot. */
export function validRepoName(n: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(n) && !n.startsWith(".") && !n.endsWith(".git");
}

/** This laptop's folder, or null (not set: vaults open from anywhere, as before). */
export function masterPath(): string | null {
  try {
    const v = localStorage.getItem(MASTER_KEY);
    return v ? fwd(v) : null;
  } catch {
    return null;
  }
}

/** The default Settings suggests: <home>/vc (C:\Users\<you>\vc). */
export async function suggestedMaster(): Promise<string> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    return joinPath(await homeDir(), "vc");
  } catch {
    return "~/vc";
  }
}

export async function readMasterFile(m: string): Promise<MasterFile> {
  try {
    return JSON.parse(await invoke<string>("read_text_file", { path: masterLayout(m).file })) as MasterFile;
  } catch {
    return {};
  }
}

async function writeMasterFile(m: string, f: MasterFile): Promise<void> {
  await invoke("write_text_file", { path: masterLayout(m).file, contents: JSON.stringify(f, null, 2) + "\n" });
}

/** The box this laptop syncs with: the folder's file, else the open vault's (sync.json). */
export async function masterBox(m: string | null = masterPath()): Promise<{ box: string; name?: string } | null> {
  if (m) {
    const f = await readMasterFile(m);
    if (f.box) return { box: f.box, name: f.name };
  }
  const open = useStore.getState().vaultPath;
  const cfg = open ? await readBoxConfig(open) : null;
  return cfg ? { box: cfg.box, name: cfg.name ?? undefined } : null;
}

function linkOf(box: string): Link {
  return { url: box.replace(/\/+$/, ""), token: useStore.getState().boxToken || null };
}

/** Set this laptop's folder: made with its layout, and its file names the box the open vault syncs with. */
export async function setMasterPath(raw: string): Promise<{ ok: true; path: string } | { error: string }> {
  const p = fwd(raw.trim());
  if (!p || !(/^[A-Za-z]:\//.test(p) || p.startsWith("/"))) return { error: `"${raw.trim()}" is not a full path` };
  try {
    await invoke("create_dir", { path: joinPath(p, "vaults") });
    await invoke("create_dir", { path: joinPath(p, "projects") });
  } catch (e) {
    return { error: `could not make ${p}: ${String((e as Error)?.message ?? e)}` };
  }
  const f = await readMasterFile(p);
  if (!f.box) {
    const b = await masterBox(null);
    if (b) Object.assign(f, b);
  }
  await writeMasterFile(p, { projects: {}, ...f });
  try {
    localStorage.setItem(MASTER_KEY, p);
  } catch {
    /* no storage */
  }
  return { ok: true, path: p };
}

async function dirsIn(dir: string): Promise<string[]> {
  try {
    const list = await invoke<{ name: string; is_dir: boolean }[]>("list_dir", { path: dir });
    return list.filter((e) => e.is_dir && validRepoName(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The vaults in this laptop's folder (the vault picker). */
export async function localVaults(m: string | null = masterPath()): Promise<string[]> {
  return m ? dirsIn(masterLayout(m).vaults) : [];
}

export async function localProjects(m: string | null = masterPath()): Promise<string[]> {
  return m ? dirsIn(masterLayout(m).projects) : [];
}

export type PickerItem = { kind: "vault"; name: string; path: string; open: boolean } | { kind: "new" };

/** The vault picker: every vault in the folder (the open one marked), then New vault. Nothing from elsewhere. */
export function pickerItems(m: string | null, names: string[], openPath: string | null): PickerItem[] {
  if (!m) return [];
  const open = openPath ? fwd(openPath).toLowerCase() : null;
  const vaults: PickerItem[] = names.map((name) => {
    const path = joinPath(masterLayout(m).vaults, name);
    return { kind: "vault" as const, name, path, open: path.toLowerCase() === open };
  });
  return [...vaults, { kind: "new" as const }];
}

/** Is this repo marked never to sync (a copy being brought in)? */
export async function noSync(repo: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path: joinPath(repo, ".git", NO_SYNC_MARK) });
  } catch {
    return false;
  }
}

/** What the laptop lacks of the box's folder: each vault and project to make here from the box's hub. */
export function missingHere(info: Pick<BoxMasterInfo, "vaults" | "projects">, vaults: string[], projects: string[]): { kind: "vaults" | "projects"; name: string; branch: string; origin: string | null }[] {
  const out: { kind: "vaults" | "projects"; name: string; branch: string; origin: string | null }[] = [];
  for (const v of info.vaults) if (validRepoName(v.name) && !vaults.includes(v.name)) out.push({ kind: "vaults", name: v.name, branch: "master", origin: null });
  for (const p of info.projects) {
    if (!validRepoName(p.name) || projects.includes(p.name) || !p.branch || p.branch === "box") continue;
    out.push({ kind: "projects", name: p.name, branch: p.branch, origin: p.origin });
  }
  return out;
}

export function hubUrl(box: string, kind: "vaults" | "projects", name: string): string {
  return `${box.replace(/\/+$/, "")}/git/${kind === "projects" ? "projects/" : ""}${name}.git`;
}

/** The box's folder (GET /api/v1/master), or null when the box can't say. */
export async function boxMasterInfo(box?: string): Promise<BoxMasterInfo | null> {
  const b = box ?? (await masterBox())?.box;
  if (!b) return null;
  try {
    return (await boxGet(linkOf(b), "/api/v1/master")) as BoxMasterInfo;
  } catch {
    return null;
  }
}

/** One pass: make here what the box has and this laptop lacks, then keep every repo in the folder syncing (one loop
 *  each). Returns what it made. */
export async function syncMasterFolder(): Promise<{ made: string[]; errors: string[] }> {
  const m = masterPath();
  const made: string[] = [];
  const errors: string[] = [];
  if (!m) return { made, errors };
  const f = await readMasterFile(m);
  if (f.box) {
    const info = await boxMasterInfo(f.box);
    if (info?.master) {
      // A vault this laptop already syncs from a folder elsewhere (school2 before its migration) is never made here
      // too: two copies would both write `master`. It is brought in by hand, once (server/README.md).
      const plan = missingHere(info, [...(await localVaults(m)), ...(await syncedElsewhere(m))], await localProjects(m));
      for (const x of plan) {
        const dest = joinPath(m, x.kind, x.name);
        try {
          if (x.kind === "projects") {
            f.projects = { ...(f.projects ?? {}), [x.name]: { branch: x.branch, origin: x.origin } };
            await writeMasterFile(m, f);
          }
          await invoke<string>("master_repo_init", { dest, remoteUrl: hubUrl(f.box, x.kind, x.name), branch: x.branch, originUrl: x.origin });
          made.push(`${x.kind}/${x.name}`);
        } catch (e) {
          errors.push(`${x.kind}/${x.name}: ${String((e as Error)?.message ?? e)}`);
        }
      }
    }
  }
  // A repo marked never to sync (a copy being brought in) gets no loop at all: not the box's, not the local autosave.
  for (const name of await localVaults(m)) {
    const v = joinPath(masterLayout(m).vaults, name);
    if (!(await noSync(v))) await ensureVaultSyncLoop(v).catch(() => {});
  }
  for (const name of await localProjects(m)) {
    const p = joinPath(masterLayout(m).projects, name);
    if (!(await noSync(p))) await ensureProjectSyncLoop(p, joinPath(masterLayout(m).logs, name)).catch(() => {});
  }
  return { made, errors };
}

/** The box names of the vaults this laptop syncs from outside the folder (tracked, with a box). */
async function syncedElsewhere(m: string): Promise<string[]> {
  const inside = masterLayout(m).vaults.toLowerCase() + "/";
  const out: string[] = [];
  for (const v of trackedVaults()) {
    if (fwd(v).toLowerCase().startsWith(inside)) continue;
    const cfg = await readBoxConfig(v).catch(() => null);
    if (cfg && !cfg.project) out.push(cfg.vault);
  }
  return out;
}

/** A vault outside the folder whose box vault is also in the folder (the copy brought in): the folder's copy is the
 *  one that syncs; this one never starts at launch again (it stays on disk as it is). Two laptop copies of one vault
 *  must never both write `master`. */
export async function shadowedByFolder(vault: string, m: string | null = masterPath()): Promise<boolean> {
  if (!m) return false;
  if (fwd(vault).toLowerCase().startsWith(masterLayout(m).vaults.toLowerCase() + "/")) return false;
  const cfg = await readBoxConfig(vault).catch(() => null);
  if (!cfg || cfg.project) return false;
  const here = joinPath(masterLayout(m).vaults, cfg.vault);
  return (await localVaults(m)).includes(cfg.vault) && !(await noSync(here));
}

/** "New vault": made in the folder here and on the box (POST /api/v1/vaults), then synced. Returns its path. */
export async function newVault(raw: string): Promise<{ path: string } | { error: string }> {
  const m = masterPath();
  if (!m) return { error: "set the vault-chat folder first (Settings)" };
  const name = boxVaultName(raw.trim());
  if (!validRepoName(name)) return { error: `"${raw}" is not a vault name` };
  const path = joinPath(masterLayout(m).vaults, name);
  const f = await readMasterFile(m);
  if (f.box) {
    const r = await boxPost(linkOf(f.box), "/api/v1/vaults", { name });
    if (!r.ok) return { error: `the box could not make it: ${r.error}` };
  }
  try {
    await invoke<string>("master_repo_init", { dest: path, remoteUrl: f.box ? hubUrl(f.box, "vaults", name) : "", branch: "master", originUrl: null });
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
  return { path };
}
