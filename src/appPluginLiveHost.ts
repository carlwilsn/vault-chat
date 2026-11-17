// The app's side of live app plugins (src/appPluginLive.ts): the copies in <vault>/.vault-chat/app-plugins, read at
// startup and every few seconds after while something shows an app plugin (as the vault plugins' folder is,
// src/VaultPluginHost.tsx), and how one is loaded (the app modules it shares first, then its own code).
//
// The copies last read are kept per vault in localStorage and used at once when the app starts, so a plugin with a live
// copy mounts that copy first instead of the built-in one and then swapping (the supervisor's records do the same,
// src/pluginSupervisorApp.ts). No copy kept: the built-in copy mounts, and a live copy found by the first read takes its
// place.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { blobLoad, type LoadModule } from "./mountHost";
import { provideShared } from "./appPluginShared";
import { useStore } from "./store";
import { APP_PLUGIN_LIVE_DIR, APP_PLUGIN_LIVE_MAX_BYTES, appPluginFolder, liveCopyFile, liveCopyOf, liveErrorFile, parseLiveHeader, type LiveCopyKind } from "./appPluginLive";

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
/** The copies in the folder: file name → code. */
export type LiveCopies = Readonly<Record<string, string>>;

const CACHE = "vc.appPluginLive:";
const EVERY_MS = 2000;
const NONE: LiveCopies = Object.freeze({});

const dirOf = (vault: string) => `${vault.replace(/\\/g, "/").replace(/\/+$/, "")}/${APP_PLUGIN_LIVE_DIR}`;

/** Read the folder: every app plugin copy with its code. A missing folder is none; an unreadable file is skipped. */
export async function scanLiveCopies(vault: string, call: Invoke = invoke as Invoke): Promise<LiveCopies> {
  let entries: { name: string; path: string; is_dir: boolean }[];
  try {
    entries = await call("list_dir", { path: dirOf(vault) });
  } catch {
    return NONE;
  }
  const out: Record<string, string> = {};
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.is_dir || !liveCopyOf(e.name)) continue;
    try {
      const code = await call<string>("read_text_file", { path: e.path });
      if (code.length <= APP_PLUGIN_LIVE_MAX_BYTES) out[e.name] = code;
    } catch {
      /* mid-write or gone: the next look sees it */
    }
  }
  return out;
}

let vault: string | null = null;
let copies: LiveCopies = NONE;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

const same = (a: LiveCopies, b: LiveCopies) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
};

function kept(v: string): LiveCopies {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE + v);
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o !== "object") return NONE;
    const out: Record<string, string> = {};
    for (const [k, c] of Object.entries(o)) if (liveCopyOf(k) && typeof c === "string") out[k] = c;
    return out;
  } catch {
    return NONE;
  }
}

function keep(v: string, c: LiveCopies): void {
  try {
    if (Object.keys(c).length) globalThis.localStorage?.setItem(CACHE + v, JSON.stringify(c));
    else globalThis.localStorage?.removeItem(CACHE + v);
  } catch {
    /* no room: the next start mounts the built-in copy first */
  }
}

function set(next: LiveCopies): void {
  if (same(copies, next)) return;
  copies = next;
  if (vault) keep(vault, next);
  for (const fn of [...listeners]) fn();
}

/** The vault the copies are for: another one starts from its kept copies. */
function follow(v: string | null): void {
  if (v === vault) return;
  vault = v;
  copies = v ? kept(v) : NONE;
  for (const fn of [...listeners]) fn();
}

/** Look at the folder now (the app's own read; a test passes its own). */
export async function refreshLiveCopies(call?: Invoke): Promise<void> {
  follow(useStore.getState().vaultPath);
  const v = vault;
  if (!v || busy) return;
  busy = true;
  try {
    const next = await scanLiveCopies(v, call);
    if (v === vault) set(next);
  } finally {
    busy = false;
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) {
    void refreshLiveCopies();
    timer = setInterval(() => void refreshLiveCopies(), EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const quiet = () => () => {};
const none = () => NONE;

function snapshot(): LiveCopies {
  follow(useStore.getState().vaultPath);
  return copies;
}

/** The plugin's copies in the vault now: its draft and its live copy (code), each absent when there is none. */
export function useLiveCopies(pluginId: string): { draft?: string; live?: string } {
  const folder = appPluginFolder(pluginId);
  const all = useSyncExternalStore(folder ? subscribe : quiet, folder ? snapshot : none, folder ? snapshot : none);
  if (!folder) return {};
  const draft = all[liveCopyFile(folder, "draft")];
  const live = all[liveCopyFile(folder, "live")];
  return { ...(draft !== undefined ? { draft } : {}), ...(live !== undefined ? { live } : {}) };
}

let baseLoad: LoadModule = blobLoad;
/** Tests: how a copy's code becomes a module (the app: a blob: URL). */
export function _setLiveLoad(load: LoadModule | null): void {
  baseLoad = load ?? blobLoad;
}

/** Load a live copy of `pluginId`: check its header, put the app modules it names on the global, then load its code. */
export function liveLoader(pluginId: string, load: LoadModule = (code) => baseLoad(code), provide: (names: readonly string[]) => Promise<void> = provideShared): LoadModule {
  return async (code) => {
    const h = parseLiveHeader(code);
    if (!h) throw new Error("not a built live copy (no // @vc-app-plugin header line): build it with scripts/app-plugin-live.ts");
    if (h.plugin !== pluginId) throw new Error(`this live copy is ${h.plugin}'s, not ${pluginId}'s`);
    await provide(h.shared);
    return load(code);
  };
}

const reported = new Set<string>();

/** Write why a copy failed next to it (<file>.error.txt) for the agent on the box: once per copy's code. */
export async function reportLiveFailure(pluginId: string, kind: LiveCopyKind, code: string, message: string, call: Invoke = invoke as Invoke): Promise<void> {
  const folder = appPluginFolder(pluginId);
  const v = vault ?? useStore.getState().vaultPath;
  if (!folder || !v) return;
  const file = liveCopyFile(folder, kind);
  const key = `${v}\u0000${file}\u0000${code.length}\u0000${code.slice(0, 200)}\u0000${code.slice(-200)}`;
  if (reported.has(key)) return;
  reported.add(key);
  const header = parseLiveHeader(code);
  const text = `${new Date().toISOString()} ${pluginId} ${kind} copy failed on the laptop; the ${kind === "draft" ? "live or built-in" : "built-in"} copy runs instead.\n${header?.built ? `built: ${header.built}\n` : ""}\n${message}\n`;
  try {
    await call("write_text_file", { path: `${dirOf(v)}/${liveErrorFile(file)}`, contents: text });
  } catch (e) {
    console.warn("[plugin] could not write the live copy's error:", e);
  }
}

/** Tests: forget the folder's state. */
export function _resetLiveCopies(): void {
  vault = null;
  copies = NONE;
  reported.clear();
  if (timer) clearInterval(timer);
  timer = null;
  for (const fn of [...listeners]) fn();
}
