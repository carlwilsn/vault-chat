import {
  openUrl as pluginOpenUrl,
  openPath as pluginOpenPath,
  revealItemInDir as pluginRevealItemInDir,
} from "@tauri-apps/plugin-opener";

// Thin wrappers around @tauri-apps/plugin-opener. Using the typed JS
// bindings rather than raw invoke() because the raw invoke name changed
// between plugin versions and the JS package tracks whichever one the
// installed Rust crate ships.

export async function openUrl(url: string): Promise<void> {
  await pluginOpenUrl(url);
}

export async function revealInFileExplorer(path: string): Promise<void> {
  await pluginRevealItemInDir(path);
}

export async function openPathWithDefaultApp(path: string): Promise<void> {
  await pluginOpenPath(path);
}

export function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

// ---- opening a vault file outside the app: one path for the viewer's buttons, the tree's menu and the agent ----

export type OutsideHow = "default" | "explorer" | "video";
type Opened = { path: string; how: OutsideHow; at: string; id?: string };
const opened: Opened[] = [];
const openedFns = new Set<(o: Opened | null) => void>();

/** Open `path` outside the app: its default app, File Explorer at it, or the system video player (its default app).
 *  app/viewer's openOutside action and every such button call this; what happens in that program is the OS's. */
export async function openOutside(path: string, how: OutsideHow): Promise<void> {
  if (how === "explorer") await revealInFileExplorer(path);
  else await openPathWithDefaultApp(path);
  const o = { path, how, at: new Date().toISOString() };
  opened.push(o);
  if (opened.length > 10) opened.shift();
  for (const f of [...openedFns]) f(o);
}
/** The files opened outside this session, newest last. */
export const outsideOpened = () => opened.slice();
export function onOutsideOpened(fn: (o: Opened | null) => void): () => void {
  openedFns.add(fn);
  return () => void openedFns.delete(fn);
}
