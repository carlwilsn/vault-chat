// Open a vault (the titlebar's picker, Settings' switch to a copy and back): the one way the open vault changes.
import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
import { gitInitIfNeeded } from "./git";

/**
 * The first-run tutorial (src-tauri/src/first_run_tutorial.rs): the app's first vault on this account gets it when it
 * is a new, empty folder; any later vault, or one with files, never does. Asked before anything else writes there.
 * At start (src/main.tsx) the vault already open is passed too, so an existing install ends its first run at once.
 */
export async function firstRunSeed(vault: string | null): Promise<boolean> {
  // A box path ("box:/...", src/boxFiles.ts) is never a new folder here.
  if (!vault || vault.startsWith("box:")) return false;
  const r = await invoke<{ seeded: boolean; why: string }>("first_run_seed", { vault }).catch(() => null);
  if (r?.seeded) console.info("[first-run] the tutorial is in", vault);
  return !!r?.seeded;
}

export async function openVaultAt(path: string): Promise<void> {
  const normalized = path.split("\\").join("/");
  const seeded = await firstRunSeed(normalized);
  const st = useStore.getState();
  // File-workspace navigation never owns the global conversation or its native turn.
  st.setVault(normalized);
  const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: normalized });
  useStore.getState().setFiles(listed);
  // A vault is a git repo so agent turns can auto-commit. Silent no-op if already one.
  gitInitIfNeeded(normalized).catch(() => {});
  // The tutorial's first step starts on the welcome note.
  if (seeded) useStore.getState().setCurrentFile(`${normalized}/Welcome.md`, await invoke<string>("read_text_file", { path: `${normalized}/Welcome.md` }).catch(() => ""));
}
