// The dead-man's switch and the Undo that do not depend on the part being changed (src/changeFlow.ts).
//
// - For DEADMAN_MS after a change applied, the app checks itself every HEALTH_EVERY_MS: the chat pane is on screen with
//   its transcript (not the plain stand-in a broken one leaves) and the page answers a ping (a frame comes).
//   HEALTH_MISSES failed checks in a row and the change switches back by itself (a record by "auto"; the box writes the
//   line in the chat that says so).
// - Every check is also told to the native shell (`safety_beat`, src-tauri/src/safety.rs): when the page itself is dead
//   (a broken core, a frozen script) the beats stop, and the shell undoes the change through the box and reloads.
// - Undo of the last applied change is Ctrl/Cmd+Alt+Z, caught by the shell (a global shortcut) and its tray menu, so
//   it works whatever a change did to the page; here the same keys are a fallback where there is no shell (a browser).
import { useStore } from "./store";
import { DEADMAN_MS, HEALTH_EVERY_MS, HEALTH_MISSES } from "./changeFlow";
import { autoRevert, changeablePlugins, changesOf } from "./changeReady";
import { landing } from "./pluginDrafts";
import { boxLinkFor, boxPost } from "./boxChat";
import { loadSupervisor } from "./pluginSupervisorApp";
import { hit } from "./shortcuts";

/** Plugins whose applied change may be watched (tests replace it). */
let watchedPlugins: () => string[] = () => changeablePlugins();

/** The applied changes still inside the dead-man's window: plugin, version, until when. */
export function appliedUnderWatch(now = Date.now(), plugins = watchedPlugins()): { plugin: string; version: string; until: number }[] {
  const out: { plugin: string; version: string; until: number }[] = [];
  for (const plugin of new Set(plugins)) {
    const l = landing(changesOf(plugin));
    if (!l || l.change !== "keep" || (l.from ?? "built-in") === l.version) continue;
    if (now - l.at <= DEADMAN_MS && now >= l.at - 60_000) out.push({ plugin, version: l.version, until: l.at + DEADMAN_MS });
  }
  return out;
}

/** Whether Carl's layout shows the chat pane in this window now (closed, popped out or Settings: nothing to judge). */
function chatShown(): boolean {
  const s = useStore.getState() as unknown as { rightCollapsed?: boolean; popoutOpen?: boolean; showSettings?: boolean; chatFullscreen?: boolean };
  if (s.showSettings || s.popoutOpen) return false;
  return !s.rightCollapsed || !!s.chatFullscreen;
}

/** The chat pane renders: on screen, its transcript there, not the plain stand-in a broken transcript leaves. */
export function chatRenders(doc: Document = document): boolean {
  const host = doc.querySelector<HTMLElement>('[data-el="chat-pane-host"]') ?? doc.querySelector<HTMLElement>('[data-el="chat-scroll"]')?.parentElement ?? null;
  if (!host || !host.isConnected) return false;
  if (host.querySelector('[data-el="transcript-fallback"]')) return false;
  const scroll = host.querySelector<HTMLElement>('[data-el="chat-scroll"]');
  if (!scroll) return false;
  const rects = typeof host.getClientRects === "function" ? host.getClientRects().length : 1;
  if (!rects) return false;
  const view = doc.defaultView;
  const cs = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(host) : null;
  return !(cs && (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0"));
}

/** The page answers: a frame comes within `ms` (a frozen page never answers, a hidden one is let off). */
function ping(ms = 2_000): Promise<boolean> {
  if (typeof requestAnimationFrame !== "function" || (typeof document !== "undefined" && document.hidden)) return Promise.resolve(true);
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    requestAnimationFrame(() => (clearTimeout(t), res(true)));
  });
}

export type Health = { healthy: boolean; why: string | null };
/** Tests replace the check. */
let check = async (): Promise<Health> => {
  if (!(await ping())) return { healthy: false, why: "the chat stopped responding (no frame)" };
  if (chatShown() && !chatRenders()) return { healthy: false, why: "the chat stopped responding (the chat pane is not drawn)" };
  return { healthy: true, why: null };
};
export function _setHealthCheck(fn: typeof check, plugins?: () => string[]): void {
  check = fn;
  if (plugins) watchedPlugins = plugins;
}

/** The native shell's side (src-tauri/src/safety.rs); tests replace it. Never throws. `tried` is always empty now
 *  (there is no Try step); the installed shell still takes it. */
let beat = async (b: { url: string | null; token: string | null; vault: string | null; watchUntil: number; healthy: boolean; tried: { plugin: string; version: string }[] }): Promise<void> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("safety_beat", { url: b.url, token: b.token, vault: b.vault, watchUntil: b.watchUntil, healthy: b.healthy, tried: b.tried });
  } catch {
    /* an older shell, or a browser: the page's own switch still holds */
  }
};
export function _setBeat(fn: typeof beat): void {
  beat = fn;
}

let misses = 0;
let reverting = false;

/** One look: while something is watched, judge health; revert after HEALTH_MISSES bad looks. What it did. */
export async function healthTick(now = Date.now()): Promise<"idle" | "healthy" | "miss" | "reverted"> {
  const applied = appliedUnderWatch(now);
  const watching = applied.length > 0;
  const h = watching ? await check() : { healthy: true, why: null };
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  void beat({ url: link?.url ?? null, token: link?.token ?? null, vault: link?.vault ?? null, watchUntil: applied.length ? Math.max(...applied.map((a) => a.until)) : 0, healthy: h.healthy, tried: [] });
  if (!watching) {
    misses = 0;
    return "idle";
  }
  if (h.healthy) {
    misses = 0;
    return "healthy";
  }
  misses++;
  if (misses < HEALTH_MISSES || reverting) return "miss";
  misses = 0;
  reverting = true;
  try {
    const why = h.why ?? "the chat stopped responding";
    console.warn(`[changes] ${why}: undoing ${applied.map((a) => a.plugin).join(", ")}`);
    for (const a of applied) autoRevert(a.plugin, a.version, why);
  } finally {
    reverting = false;
  }
  return "reverted";
}

/** Undo the last change through the box (the shell's way, here where there is no shell). */
export async function undoLastChange(by: "carl" | "auto" = "carl"): Promise<{ ok: boolean; text: string }> {
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return { ok: false, text: "no box to undo it on" };
  const r = await boxPost(link, "/api/v2/changes/undo-last", { by });
  await loadSupervisor(true).catch(() => {});
  const d = (r.data ?? {}) as { text?: string };
  return { ok: !!r.ok, text: String(d.text ?? r.error ?? "") };
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Start checking (the app's ChangeKeeper, once). Returns the stop. */
export function startChangeSafety(): () => void {
  if (timer || typeof window === "undefined") return () => {};
  timer = setInterval(() => void healthTick().catch(() => {}), HEALTH_EVERY_MS);
  const onKey = (e: KeyboardEvent) => {
    if (!hit(e, "change.undo")) return;
    e.preventDefault();
    e.stopPropagation();
    void undoLastChange("carl");
  };
  window.addEventListener("keydown", onKey, true);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    window.removeEventListener("keydown", onKey, true);
  };
}

/** Tests: forget what this module holds. */
export function _resetChangeSafety(): void {
  misses = 0;
  reverting = false;
}
