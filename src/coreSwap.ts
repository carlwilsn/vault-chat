// Carl's screen across a core swap (src/coreBundle.ts; src/coreFollow.ts followCoreOnce): the loader serves
// the new bundle and the window loads it, so what only lived in this page would go. Before the swap the main window
// keeps, in its sessionStorage (it survives the load, per window), the open chat, the chat's scroll (at the bottom, or
// where he was), the composer's draft (text, mentions, pictures, files), the panes (files, split, which is active, view
// or edit, unsaved text), the side panels and full-screen chat.
// On that load index.html shows no splash and keeps the new screen hidden (html.vc-swapping), so nothing new is
// painted and the webview keeps the old frame up (Chromium's paint holding: a same-origin load shows the old page
// until the new one first paints content); the new bundle puts everything back once its vault and chats are loaded
// (restoreAfterSwap, main.tsx) and only then shows itself. A swap older than SWAP_MAX_MS is not restored (a crash, a
// later launch: a fresh start).
// The old frame is not held that long on Carl's laptop (WebView2 drops it on the reload: a ~1.4 s blank, dark on his
// light theme), so the swap also keeps a picture of the screen (src/screenCapture.ts, at the window's own pixels) in
// sessionStorage: index.html paints it as the very first frame, and the restored screen replaces it in one frame once it
// is drawn under it (no fade: Carl wants the swap still). The theme rides along (src/firstTheme.ts): the first frame is
// never the wrong colour.
// The layout comes back exactly: the tiles (src/tiles.ts snapshotTiles: each spot's file, web page or chat, the lines
// between them, which is focused; an older core's split and chat column become tiles), the side panels, and the
// columns' widths (file tree, viewer, Chats: src/layoutOps.ts resizeColumns, what dragging the sashes does). The new window's first file listing refits the file tree; the kept widths win over it
// (keepColumns). Nothing asks "Reload site?" on the swap's load (src/swapHold.ts).
import { useStore, type Pane, type SplitDirection } from "./store";
import { isTheme, type Theme } from "./firstTheme";
import { holdForSwap, releaseSwapHold } from "./swapHold";
import { isWebAddress } from "./webPane";
import { domMeasure, keepColumns, resizeColumns } from "./layoutOps";
import { restoreTiles, snapshotTiles, tilesFromLegacy, type SavedTiles } from "./tiles";

/** index.html reads this key by name before any script loads: keep the two in step. */
export const SWAP_KEY = "vc.coreSwap";
export const SWAP_MAX_MS = 60_000;
/** index.html reads this key by name too: the picture of the screen (a data: URL). */
export const SWAP_SHOT_KEY = "vc.coreSwapShot";
/** The id index.html gives the picture's element. */
export const SWAP_SHOT_ID = "vc-swap-shot";
/** How long the columns' widths a swap put back win over the new window's refit of the file tree. */
export const KEEP_COLUMNS_MS = 15_000;
/** A picture bigger than this (characters) is not kept: sessionStorage has ~5 M. */
const SHOT_MAX_CHARS = 3_500_000;
/** Pane text kept as it is (unsaved edits included) up to this much in all; over it the files are read again. */
const PANE_TEXT_MAX = 1_500_000;

export type SwapState = {
  at: number;
  /** The theme the window shows (index.html paints its first frame in it). */
  theme?: Theme;
  vault: string | null;
  conv: string | null;
  scroll: { top: number; atBottom: boolean } | null;
  draft: { input: string; mentions: unknown[]; images: unknown[]; files: unknown[] } | null;
  panes: { file: string; mode: Pane["mode"]; content: string | null }[];
  split: SplitDirection;
  active: number;
  currentFile: string | null;
  currentContent: string | null;
  /** The one file's view or edit (a split's panes carry their own). */
  mode?: "view" | "edit";
  /** The columns' widths in pixels (0: a closed panel), null when there is no split on screen (full-screen chat). */
  sizes?: { leftPanel: number; viewer: number; chat: number } | null;
  /** An older core's viewer split: its two panes' sizes in pixels (not used: tiles keep their own lines). */
  paneSizes?: number[] | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  chatFullscreen: boolean;
  /** The tiles (src/tiles.ts snapshotTiles, absolute paths). A record without them is an older core's: its split and
   *  chat column become tiles (tilesFromLegacy). */
  tiles?: SavedTiles;
};

const ss = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const chatScroller = (): HTMLElement | null => (typeof document !== "undefined" ? (document.querySelector('[data-el="chat-scroll"]') as HTMLElement | null) : null);

/** What the window shows now (pure over the store and the DOM; the composer's draft is passed in). */
export function swapStateNow(draft: SwapState["draft"], now = Date.now()): SwapState {
  const s = useStore.getState();
  const keepText = s.panes.reduce((n, p) => n + (p.content?.length ?? 0), 0) <= PANE_TEXT_MAX;
  const el = chatScroller();
  return {
    at: now,
    theme: isTheme(s.theme) ? s.theme : "graphite",
    vault: s.vaultPath,
    conv: s.activeConversationId,
    scroll: el ? { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 } : null,
    draft,
    panes: s.panes.map((p) => ({ file: p.file, mode: p.mode, content: keepText ? p.content : null })),
    split: s.splitDirection,
    active: Math.max(0, s.panes.findIndex((p) => p.id === s.activePaneId)),
    currentFile: s.currentFile,
    currentContent: s.currentContent.length <= PANE_TEXT_MAX ? s.currentContent : null,
    mode: s.mode,
    sizes: domMeasure().sizes,
    leftCollapsed: s.leftCollapsed,
    rightCollapsed: s.rightCollapsed,
    chatFullscreen: s.chatFullscreen,
    tiles: snapshotTiles((p) => p),
  };
}

/** Before the loader swaps the bundle (main window): keep the screen's state. Never throws. */
export async function saveSwapState(): Promise<SwapState | null> {
  const store = ss();
  if (!store) return null;
  let draft: SwapState["draft"] = null;
  try {
    const { useDraft } = await import("./plugins/composer/draft");
    const d = useDraft.getState();
    draft = { input: d.input, mentions: d.mentions, images: d.images, files: d.files };
  } catch {
    /* no composer here */
  }
  const st = swapStateNow(draft);
  // The picture first, while the screen is still exactly as Carl sees it (no more than ~2 s; without it the swap still runs).
  const shot = await screenPicture();
  // The load that follows is on purpose: the window's leave guard (src/linkNav.ts) stands aside for it, and the frames
  // in it leave (their own beforeunload would ask), after the picture so it still shows them.
  holdForSwap();
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("vc-core-swapping");
  } catch {
    /* no other windows to tell */
  }
  try {
    store.setItem(SWAP_KEY, JSON.stringify(st));
  } catch {
    // Too big (pictures in the draft, long panes): the rest without them.
    try {
      store.setItem(SWAP_KEY, JSON.stringify({ ...st, draft: draft ? { ...draft, images: [], files: [] } : null, panes: st.panes.map((p) => ({ ...p, content: null })), currentContent: null }));
    } catch {
      return null;
    }
  }
  try {
    store.removeItem(SWAP_SHOT_KEY);
    if (shot) store.setItem(SWAP_SHOT_KEY, shot);
  } catch {
    /* too big for what is left: the theme-coloured frame instead */
  }
  return st;
}

/** The swap did not start (the loader refused): the frames and the leave guard come back, in every window. */
export async function cancelSwap(): Promise<void> {
  releaseSwapHold();
  try {
    ss()?.removeItem(SWAP_KEY);
    ss()?.removeItem(SWAP_SHOT_KEY);
  } catch {
    /* none */
  }
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("vc-core-swap-cancelled");
  } catch {
    /* no other windows */
  }
}

/** The window as Carl sees it, at its own pixels, as a data: URL; null when it can't be drawn in time. Never throws. */
async function screenPicture(): Promise<string | null> {
  try {
    if (typeof window === "undefined") return null;
    const { captureWindow } = await import("./screenCapture");
    const px = Math.round(window.innerWidth * (window.devicePixelRatio || 1));
    const c = await captureWindow("window", { maxWidth: Math.min(Math.max(px, 1), 4096), timeoutMs: 2000, blankFrames: true });
    const url = `data:${c.mimeType};base64,${c.data}`;
    return url.length <= SHOT_MAX_CHARS ? url : null;
  } catch {
    return null;
  }
}

/** The kept state, once (it is removed), or null when none or too old. */
export function takeSwapState(now = Date.now()): SwapState | null {
  const store = ss();
  if (!store) return null;
  let st: SwapState | null = null;
  try {
    const raw = store.getItem(SWAP_KEY);
    st = raw ? (JSON.parse(raw) as SwapState) : null;
  } catch {
    st = null;
  }
  store.removeItem(SWAP_KEY);
  return st && typeof st.at === "number" && Math.abs(now - st.at) <= SWAP_MAX_MS ? st : null;
}

/** Show the new screen (index.html kept it hidden on a swap's load). */
export function revealAfterSwap(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove("vc-swapping");
  try {
    ss()?.removeItem(SWAP_SHOT_KEY);
  } catch {
    /* gone already */
  }
  const shot = document.getElementById(SWAP_SHOT_ID);
  if (!shot) return;
  // The restored screen is drawn under it in the next frame: the picture goes after that frame, at once (no fade).
  requestAnimationFrame(() => requestAnimationFrame(() => shot.remove()));
}

export type RestoreDeps = {
  /** A file's text (the panes whose text was not kept). */
  read: (path: string) => Promise<string>;
  /** Wait until the vault's chats are loaded (the open chat can be picked). */
  chatsLoaded: () => Promise<void>;
  setDraft: (d: NonNullable<SwapState["draft"]>) => void;
  /** Frames to wait for the transcript to lay out before scrolling. */
  frame: () => Promise<void>;
  /** Wait (bounded) until the vault's file listing is in: it refits the file tree, so the widths go back after it. */
  filesLoaded?: () => Promise<void>;
};

/** Put back what the window showed before the swap. What it can't (a file gone, a chat deleted since) is left as the
 *  new start has it. Returns what it put back, for the log. */
export async function restoreSwapState(st: SwapState, d: RestoreDeps): Promise<string[]> {
  const done: string[] = [];
  const s = useStore.getState();
  if (st.vault && s.vaultPath !== st.vault) return done; // another vault opened since: nothing of it applies
  // The tiles: this core's own record, or an older core's split and chat column turned into tiles (kept text first).
  const kept = new Map<string, string>();
  for (const p of st.panes) if (p.content !== null) kept.set(p.file, p.content);
  if (st.currentFile && st.currentContent !== null) kept.set(st.currentFile, st.currentContent);
  // (A record whose tiles were never drawn, a window with no screen: its panes, as an older core's.)
  const legacy = !st.tiles?.tiles?.length;
  const files = st.panes.length >= 2 ? st.panes.map((p) => p.file) : st.currentFile ? [st.currentFile] : [];
  const saved: SavedTiles = !legacy && st.tiles ? st.tiles : tilesFromLegacy({ files, modes: st.panes.length >= 2 ? st.panes.map((p) => p.mode) : undefined, stacked: st.split === "vertical", active: st.active, chat: st.conv, chat_at: st.chatFullscreen ? "full" : st.rightCollapsed ? null : "right" });
  if (saved.tiles.some((t) => t.chat)) await d.chatsLoaded();
  const back = await restoreTiles(saved, {
    vault: st.vault ?? s.vaultPath ?? "",
    read: async (f) => kept.get(f) ?? (isWebAddress(f) ? "" : await d.read(f)),
    how: legacy ? "legacy" : "swap",
    ...(legacy ? { from: { coreSwap: { panes: st.panes.map((p) => p.file), split: st.split, active: st.active, currentFile: st.currentFile, conv: st.conv, rightCollapsed: st.rightCollapsed, chatFullscreen: st.chatFullscreen } } } : {}),
  }).catch(() => false);
  if (back) done.push(legacy ? "tiles (from the split)" : "tiles");
  if (back && st.mode && useStore.getState().panes.length === 0) useStore.getState().setMode(st.mode);
  useStore.setState({ leftCollapsed: st.leftCollapsed, rightCollapsed: st.rightCollapsed, chatFullscreen: false });
  if (st.sizes) {
    // The panels open or shut and the file listing in (it refits the tree), then the widths as they were.
    await d.filesLoaded?.();
    await d.frame();
    let sized = false;
    try {
      if (st.sizes) {
        const c = { ...(st.sizes.leftPanel > 0 ? { leftPanel: st.sizes.leftPanel } : {}), ...(st.sizes.chat > 0 ? { chat: st.sizes.chat } : {}) };
        keepColumns(c, KEEP_COLUMNS_MS);
        sized = resizeColumns(c) === null;
      }
    } catch (e) {
      console.warn("[core] the widths did not go back:", e);
    }
    if (sized) {
      await d.frame();
      done.push("sizes");
    }
  }
  if (st.draft && (st.draft.input || st.draft.mentions.length || st.draft.images.length || st.draft.files.length)) {
    d.setDraft(st.draft);
    done.push("draft");
  }
  if (st.conv) {
    await d.chatsLoaded();
    if (useStore.getState().conversations.some((c) => c.id === st.conv)) {
      if (useStore.getState().activeConversationId !== st.conv) useStore.getState().selectConversation(st.conv);
      done.push("chat");
    }
  }
  if (st.scroll) {
    await d.frame();
    const el = chatScroller();
    if (el) {
      el.scrollTop = st.scroll.atBottom ? el.scrollHeight : st.scroll.top;
      done.push("scroll");
    }
  }
  return done;
}

/** Main window, at start: a swap just happened here, so put the screen back, then show it. */
export async function restoreAfterSwap(): Promise<void> {
  const mark = (v: string) => typeof document !== "undefined" && document.documentElement.setAttribute("data-vc-core-swap", v);
  const st = takeSwapState();
  if (!st) {
    mark("none");
    revealAfterSwap();
    return;
  }
  mark("restoring");
  const until = (ok: () => boolean, ms: number) =>
    new Promise<void>((resolve) => {
      const end = Date.now() + ms;
      const look = () => (ok() || Date.now() > end ? resolve() : setTimeout(look, 50));
      look();
    });
  try {
    await until(() => !!useStore.getState().vaultPath, 8000);
    const [{ readTextAt }, draftMod] = await Promise.all([import("./boxFiles"), import("./plugins/composer/draft")]);
    const done = await restoreSwapState(st, {
      read: (p) => readTextAt(p),
      chatsLoaded: () => until(() => useStore.getState().conversations.some((c) => c.id === st.conv) || (useStore.getState().conversationsLoaded && useStore.getState().conversations.length > 0), 8000),
      setDraft: (x) => draftMod.useDraft.setState({ input: x.input, mentions: x.mentions as never, images: x.images as never, files: x.files as never }),
      frame: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      filesLoaded: () => until(() => useStore.getState().files.length > 0, 3000),
    });
    console.info(`[core] after the swap, put back: ${done.join(", ") || "nothing"}`);
    mark(done.join(",") || "nothing");
  } catch (e) {
    mark(`failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    console.warn("[core] could not put the screen back after the swap:", e);
  } finally {
    revealAfterSwap();
  }
}
