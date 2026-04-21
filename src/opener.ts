import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around tauri-plugin-opener. Using raw invoke avoids pulling
// in @tauri-apps/plugin-opener as a separate npm package.

export async function openUrl(url: string): Promise<void> {
  await invoke("plugin:opener|open_url", { url });
}

export async function revealInFileExplorer(path: string): Promise<void> {
  await invoke("plugin:opener|reveal_item_in_dir", { path });
}

export async function openPathWithDefaultApp(path: string): Promise<void> {
  await invoke("plugin:opener|open_path", { path });
}

export function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
