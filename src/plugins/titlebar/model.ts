// The title bar's own state and actions (src/plugins/titlebar): the Hidden files list, the tree's refresh spin,
// plus the window's state. Shared by the bar (./Bar.tsx), its offers (./index.tsx) and the
// built-in fallback (src/Titlebar.tsx), so what the agent does through PluginAct is what a click does, on screen.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type FileEntry } from "../../store";

type BarState = {
  hiddenOpen: boolean;
  hiddenLines: string[];
  selected: Set<string>;
  refreshing: boolean;
};

export const useBar = create<BarState>(() => ({ hiddenOpen: false, hiddenLines: [], selected: new Set(), refreshing: false }));

type Listener = (event: string, data?: unknown) => void;
const listeners = new Set<Listener>();
/** What the bar did (refreshed, unhidden, ...), for the offers' events; the off. */
export function onBarEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function emitBarEvent(event: string, data?: unknown): void {
  for (const f of [...listeners]) {
    try {
      f(event, data);
    } catch {
      /* a listener's own failure */
    }
  }
}

/** Re-list the open vault's files (the tree's refresh button). */
export async function refreshTree(): Promise<{ ok: boolean; files?: number; error?: string }> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return { ok: false, error: "no vault is open" };
  if (useBar.getState().refreshing) return { ok: false, error: "a refresh is already running" };
  useBar.setState({ refreshing: true });
  try {
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault });
    useStore.getState().setFiles(listed);
    emitBarEvent("refreshed", { files: listed.length });
    return { ok: true, files: listed.length };
  } catch (e) {
    console.error("[tree] refresh failed:", e);
    return { ok: false, error: String((e as Error)?.message ?? e) };
  } finally {
    // Keep the spin visible briefly so a fast refresh still reads as feedback.
    setTimeout(() => useBar.setState({ refreshing: false }), 250);
  }
}

/** Open the Hidden files list (the vault's .vaultchatignore lines). */
export async function openHidden(): Promise<string[]> {
  const vault = useStore.getState().vaultPath;
  if (!vault) throw new Error("no vault is open");
  const lines = await invoke<string[]>("read_ignore_lines", { vault });
  useBar.setState({ hiddenLines: lines, selected: new Set(), hiddenOpen: true });
  return lines;
}

export function closeHidden(): void {
  useBar.setState({ hiddenOpen: false });
}

export function toggleSelected(line: string): void {
  const next = new Set(useBar.getState().selected);
  if (next.has(line)) next.delete(line);
  else next.add(line);
  useBar.setState({ selected: next });
}

/** Unhide these lines (default: the ones ticked in the list), re-list the files and close the list. */
export async function unhide(lines?: readonly string[]): Promise<string[]> {
  const vault = useStore.getState().vaultPath;
  const want = [...(lines ?? useBar.getState().selected)];
  if (!vault || want.length === 0) {
    closeHidden();
    return [];
  }
  try {
    await invoke("remove_from_ignore", { vault, relativePaths: want });
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault });
    useStore.getState().setFiles(listed);
    emitBarEvent("unhidden", { lines: want });
  } finally {
    closeHidden();
  }
  return want;
}

export type WindowState = { maximized: boolean; minimized: boolean; fullscreen: boolean; focused: boolean };
/** The app window's state now, or null where there is no native window (a browser preview, a test without one). */
export async function windowState(): Promise<WindowState | null> {
  try {
    const w = getCurrentWindow();
    const [maximized, minimized, fullscreen, focused] = await Promise.all([w.isMaximized(), w.isMinimized(), w.isFullscreen(), w.isFocused()]);
    return { maximized, minimized, fullscreen, focused };
  } catch {
    return null;
  }
}
