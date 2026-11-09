// The laptop app's side of live pages (src/liveBridge.ts): the bridge needs one thing, a JSON POST to the box.
import { installLiveBridge, type LiveHost } from "./liveBridge";
import { invoke } from "@tauri-apps/api/core";
import { boxLinkFor, vaultPath } from "./boxChat";
import { useStore } from "./store";
import { ONE_RETRY_MS, withRetry } from "./boxRetry";

export const appLiveHost: LiveHost = {
  async post(path, body) {
    const link = await boxLinkFor(useStore.getState().vaultPath);
    if (!link) throw new Error("Live pages need the box: it is not connected.");
    const text = JSON.stringify(body);
    const r = await withRetry(() => invoke<{ status: number; body: string }>("box_post_json", { url: `${link.url}${vaultPath(link, path)}`, body: text, token: link.token }), ONE_RETRY_MS);
    let json: any = {};
    try {
      json = JSON.parse(r.body || "{}");
    } catch {
      /* not JSON */
    }
    return { status: r.status, json };
  },
};

let installed = false;
/** Once per app window. */
export function installAppLiveBridge(): void {
  if (installed) return;
  installed = true;
  installLiveBridge(appLiveHost);
}
