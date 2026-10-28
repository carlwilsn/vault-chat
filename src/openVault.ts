// Open a vault (the titlebar's picker, Settings' switch to a copy and back): the one way the open vault changes.
import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
import { stopAgent } from "./chat-controller";
import { gitInitIfNeeded } from "./git";

export async function openVaultAt(path: string): Promise<void> {
  const normalized = path.split("\\").join("/");
  const st = useStore.getState();
  const switching = normalized !== st.vaultPath;
  if (switching && st.busy) stopAgent();
  st.setVault(normalized);
  if (switching) st.setCurrentFile(null, "");
  const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: normalized });
  useStore.getState().setFiles(listed);
  // A vault is a git repo so agent turns can auto-commit. Silent no-op if already one.
  gitInitIfNeeded(normalized).catch(() => {});
}
