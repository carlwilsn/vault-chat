// Pinned apps (src/pinnedApps.ts): every pinned page of the vault is mounted when the app starts and stays mounted,
// hidden (display: none, so it keeps running and keeps its state) until the launcher (Titlebar "Apps") brings it to the
// front in a pane of its own. Each is a HtmlView, so the iframe / in-process machinery, the supervisor ("turned off" +
// Turn on) and the in-process error card are the ones every page has. A page that cannot be read gets its own error card.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { boxGet, boxLinkFor } from "./boxChat";
import { HtmlView } from "./HtmlView";
import { PINNED_CHANGED_EVENT } from "./pinnedApps";
import { useStore } from "./store";

export type PinnedApp = { id: string; name: string; path: string; html: string | null; error: string | null };
type State = { apps: PinnedApp[]; front: string | null };
let state: State = { apps: [], front: null };
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  for (const fn of [...listeners]) fn();
};
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
export const usePinnedApps = () => useSyncExternalStore(subscribe, () => state);

/** Bring a pinned app to the front (null: back to the background, still running). */
export function showPinnedApp(id: string | null): void {
  set({ ...state, front: id });
}

/** Read the vault's pinned pages (the catalog's `pinned` plugins) and keep the ones already mounted untouched. */
export async function loadPinnedApps(vault: string | null): Promise<void> {
  if (!vault) return set({ apps: [], front: null });
  const link = await boxLinkFor(vault).catch(() => null);
  if (!link) return;
  let plugins: { id: string; name: string; pinned?: boolean }[] = [];
  try {
    plugins = ((await boxGet(link, "/api/v2/plugin/catalog"))?.plugins ?? []).filter((p: any) => p?.pinned);
  } catch {
    return;
  }
  const apps = await Promise.all(
    plugins.map(async (p): Promise<PinnedApp> => {
      const path = `${vault.replace(/[\\/]+$/, "")}/${p.id}`;
      const old = state.apps.find((a) => a.id === p.id);
      try {
        const html = await invoke<string>("read_text_file", { path });
        return { id: p.id, name: p.name, path, html: old && old.html === html ? old.html : html, error: null };
      } catch (e) {
        return { id: p.id, name: p.name, path, html: null, error: String((e as Error)?.message ?? e) };
      }
    }),
  );
  set({ apps, front: apps.some((a) => a.id === state.front) ? state.front : null });
}

/** Mounted once in the app: starts the pinned apps at launch and reloads the list when a page is pinned or unpinned. */
export function PinnedApps() {
  const vault = useStore((s) => s.vaultPath);
  const { apps, front } = usePinnedApps();
  useEffect(() => {
    void loadPinnedApps(vault);
    const on = () => void loadPinnedApps(vault);
    window.addEventListener(PINNED_CHANGED_EVENT, on);
    return () => window.removeEventListener(PINNED_CHANGED_EVENT, on);
  }, [vault]);
  return (
    <>
      {apps.map((a) => {
        const shown = a.id === front;
        return (
          <div
            key={a.id}
            data-el="pinned-app"
            data-vc-app={a.id}
            data-front={shown ? "true" : "false"}
            style={{ display: shown ? "flex" : "none" }}
            className="fixed left-0 right-0 bottom-0 top-9 z-30 flex-col bg-background"
          >
            <div className="h-8 shrink-0 flex items-center gap-2 border-b border-border px-3 text-[12px]">
              <span className="font-medium truncate">{a.name}</span>
              <span className="text-muted-foreground/70 truncate">{a.id}</span>
              <button type="button" data-el="pinned-app-hide" onClick={() => showPinnedApp(null)} className="ml-auto rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
                Back to the app
              </button>
            </div>
            {a.html === null ? (
              <span data-el="plugin-error" className="block m-3 rounded-md border border-destructive/50 bg-card px-3 py-2 text-[12.5px]">
                <b className="block">{a.name} could not start</b>
                <span className="block whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{a.error}</span>
                <button type="button" onClick={() => void loadPinnedApps(vault)} className="mt-2 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px]">
                  Try again
                </button>
              </span>
            ) : (
              <HtmlView content={a.html} path={a.path} />
            )}
          </div>
        );
      })}
    </>
  );
}
