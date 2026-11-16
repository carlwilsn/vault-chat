// The vault picker's model (app/vaults): its rows (the vault folders under the vault-chat folder; a vault that is
// itself a project keeps that project's metadata for its operations), whether its menu is open, and what it does to
// a row: open it as the workspace, make a new vault, rename, delete (recoverably, through git), make it a project.
// The picker (./Picker.tsx), its offers (./index.tsx) and the built-in fallback (src/VaultPicker.tsx) all use these.
// Vaults and projects are many-to-many: the picker lists vaults only; Main and projects live in the chat pane.
import { create } from "zustand";
import { useStore } from "../../store";
import { joinPath, localVaults, masterPath, newVault } from "../../master";
import { openVaultAt } from "../../openVault";
import { createProjectThread, deleteProject, folderAction, listProjects, renameProject, type ProjectInfo } from "../../projects";

/** Windows paths are case-insensitive; distinct POSIX vault paths must not share a checkmark. */
export const pickerPathKey = (p: string) => {
  const path = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
};

/** A vault folder relative to the vault-chat folder, with existing operation metadata only. */
export type FolderRow = { rel: string; name: string; repo: string; project: ProjectInfo | null };

/** Vault identities come from localVaults, not the project registry or name deduplication.
 * Project metadata is retained only for the existing operations on a vault that is itself a project. */
export function folderRows(vaults: string[], projects: ProjectInfo[]): FolderRow[] {
  const byRel = new Map(projects.filter((p) => p.rel).map((p) => [p.rel!, p]));
  return vaults.map((n) => ({ rel: `vaults/${n}`, name: n, repo: `vaults/${n}`, project: byRel.get(`vaults/${n}`) ?? null }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The picker's shared state: its menu open or not, and the rows last read. */
export const usePicker = create<{ open: boolean; rows: FolderRow[] }>(() => ({ open: false, rows: [] }));
export const setPickerOpen = (open: boolean) => usePicker.setState({ open });

/** Read the rows afresh (the picker on open, the agent's read). */
export async function loadRows(): Promise<FolderRow[]> {
  const m = masterPath();
  const [v, pr] = await Promise.all([localVaults(m), listProjects(useStore.getState().vaultPath)]);
  const rows = folderRows(v, pr);
  usePicker.setState({ rows });
  return rows;
}

/** Whether `r` is the vault open now. */
export function isOpenRow(r: FolderRow, vaultPath = useStore.getState().vaultPath, m = masterPath()): boolean {
  return !!vaultPath && !!m && r.rel === r.repo && pickerPathKey(joinPath(m, r.repo)) === pickerPathKey(vaultPath);
}

type Listener = (name: string, data: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
/** What the picker did (switched, created, renamed, deleted, madeProject), for the plugin's events. */
export function onPickerEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const tell = (name: string, data: Record<string, unknown>) => {
  for (const f of [...listeners]) {
    try {
      f(name, data);
    } catch {
      /* a listener's fault is its own */
    }
  }
};

type Done = { ok: true } | { ok: false; error: string };
const failed = (e: unknown): Done => ({ ok: false, error: String((e as Error)?.message ?? e) });

/** Open a vault as the workspace (tree, viewer, editor). Conversations never change with it. */
export async function switchTo(r: FolderRow): Promise<Done> {
  const m = masterPath();
  if (!m) return { ok: false, error: "set the vault-chat folder in Settings first" };
  try {
    await openVaultAt(joinPath(m, r.repo));
  } catch (e) {
    return failed(e);
  }
  tell("switched", { name: r.name });
  return { ok: true };
}

/** A new vault folder, opened. */
export async function createVault(name: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const r = await newVault(name);
  if ("error" in r) return { ok: false, error: r.error };
  await openVaultAt(r.path);
  tell("created", { name: r.path.split("/").filter(Boolean).pop() ?? name });
  return { ok: true, path: r.path };
}

/** Rename a vault (a vault that is a project: the project, as the chat pane's rename does). */
export async function renameRow(r: FolderRow, to: string): Promise<Done> {
  const want = to.trim();
  if (!want) return { ok: false, error: "a name is needed" };
  if (want === r.name) return { ok: true };
  const out = await (r.project ? renameProject(r.project.slug, want) : folderAction("rename", r.rel, want)).catch(failed);
  if (out.ok) {
    tell("renamed", { name: r.name, to: want });
    void loadRows().catch(() => {});
  }
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? "it did not work" };
}

/**
 * Delete a vault, recoverably (git keeps a copy). A plain vault: its folder. A vault that is a project: its
 * conversation, and the folder too only with `folderToo` (Carl's two choices). The open vault deleted: the picker
 * opens another one.
 */
export async function removeRow(r: FolderRow, folderToo: boolean): Promise<Done> {
  const out = await (r.project ? deleteProject(r.project.slug, { folder: folderToo }) : folderAction("delete", r.rel)).catch(failed);
  if (!out.ok) return { ok: false, error: out.error ?? "it did not work" };
  tell("deleted", { name: r.name, folder: !r.project || folderToo });
  const m = masterPath();
  const vaultPath = useStore.getState().vaultPath;
  const gone = !r.project || folderToo;
  if (gone && m && vaultPath && r.rel === r.repo && pickerPathKey(vaultPath) === pickerPathKey(joinPath(m, r.rel))) {
    const other = usePicker.getState().rows.find((x) => x.rel !== r.rel && x.rel === x.repo);
    if (other) await openVaultAt(joinPath(m, other.repo));
  }
  void loadRows().catch(() => {});
  return { ok: true };
}

/** Give a plain vault its own conversation (a project thread in the chat pane). */
export async function makeProject(r: FolderRow): Promise<Done> {
  if (r.project) return { ok: false, error: `${r.name} is a project already` };
  const out = await createProjectThread(r.name, { folder: r.rel }).catch(failed);
  if (!out.ok) return { ok: false, error: out.error };
  tell("madeProject", { name: r.name });
  void loadRows().catch(() => {});
  return { ok: true };
}
