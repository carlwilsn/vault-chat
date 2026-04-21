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
