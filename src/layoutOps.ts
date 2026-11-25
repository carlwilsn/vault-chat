// The app's layout as data and as actions: what the screen looks like (panes and their files, split, left panel, chat,
// viewport and panel sizes) and the ops that change it. One implementation for everyone who arranges the screen:
// a plugin (api.host.layout, src/hostApi.ts) and the agent's Layout tool (server/layoutTool.ts → a "layout" signal on the
// feed → src/boxChat.ts → here). Every apply returns the layout AFTER the ops, read back from the store, never assumed.
//
// Names: the two panes of a split are "left" and "right" (src/paneLayout.ts; in a stacked split left is the top one).
// "leftPanel" is the file tree; "chat" is the right panel (or the full-screen chat).
import { useStore } from "./store";
import { PANE_SIDES, relToVault, sideOf } from "./paneLayout";
import { invoke } from "@tauri-apps/api/core";
import { isUnreadableAsText } from "./fileKind";
import { SPOTS, rectEq, closeTile, ensureChatTile, ensureTilesStarted, fileTilesInPlace, fillTile, findLeaf, findSlot, focusTile, moveTile, newChatAt, openAt, openFilling, placeTile, restoreTiles, restoredFrom, setSplit, takeMigration, tileAtSide, tilesFromLegacy, tileOfPane, tilesForLayout, useTiles, type SavedTiles, type TileWhat } from "./tiles";
import type { HostLayout, LayoutOp, LayoutOpResult, LayoutResult, PaneSide, WebPageSeen } from "./layoutTypes";
import { isPicking, isWebAddress, navigateWebPane, openWebInPane, paneKey, webPageAct } from "./webPane";
import { signOutOfSites } from "./webProfile";
import { onSettingsChanged, saveSetting, setting } from "./settings";
import { closeWindow, openWindow } from "./newWindow";
import { isSecondWindow, windowNo } from "./windowKind";
export type { HostLayout, LayoutOp, LayoutOpResult, LayoutResult, WebPageSeen } from "./layoutTypes";

export const LAYOUT_OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "webPage", "split", "focus", "chatSidebar", "resize", "signOutOfSites", "moveTile", "page", "newChat", "autoHideTitleBar", "newWindow", "closeWindow"] as const;

/** The outer split's own resize (Allotment's, registered by src/App.tsx): what dragging a sash does, in pixels per column. */
let outerResize: ((sizes: number[]) => void) | null = null;
export function registerOuterResize(fn: (sizes: number[]) => void): () => void {
  outerResize = fn;
  return () => {
    if (outerResize === fn) outerResize = null;
  };
}

/**
 * At start, the tiles the box kept for this vault (GET /api/v2/layout; src/tiles.ts restoreTiles), unless a core swap
 * already put this window's own back. An older layout kept there (a split, the chat column) becomes tiles once
 * (tilesFromLegacy); the box backs it up when it hears of it. Never throws.
 */
export async function restoreKeptTiles(get: () => Promise<{ layout?: unknown } | null>, vault: string): Promise<string> {
  try {
    if (restoredFrom()) return `already put back (${restoredFrom()})`;
    const r = await get();
    const l = (r?.layout ?? null) as (Partial<HostLayout> & { tiles?: unknown; tileSplit?: SavedTiles["tileSplit"] }) | null;
    if (!l || restoredFrom()) return "nothing kept";
    // The chats first (a chat tile names one).
    const listed = () => useStore.getState().conversationsLoaded && useStore.getState().conversations.length > 0;
    for (let i = 0; i < 80 && !listed(); i++) await new Promise((res) => setTimeout(res, 100));
    const read = async (abs: string) => (isUnreadableAsText(abs) ? "" : await invoke<string>("read_text_file", { path: abs }));
    if (Array.isArray(l.tiles)) {
      const ok = await restoreTiles({ tiles: l.tiles as SavedTiles["tiles"], tileSplit: l.tileSplit }, { vault, read, how: "box" });
      return ok ? "tiles put back" : "the kept tiles did not fit";
    }
    if (!Array.isArray(l.panes)) return "nothing kept";
    const files = l.panes.map((p) => ("file" in p ? p.file : p.url)).filter((f): f is string => typeof f === "string" && !!f);
    const active = Math.max(0, l.panes.findIndex((p) => p.active));
    const chat = useStore.getState().activeConversationId;
    const saved = tilesFromLegacy({ files, stacked: l.direction === "stacked", active, chat, chat_at: (l as { chatFullscreen?: boolean }).chatFullscreen ? "full" : l.rightPanelOpen ? "right" : null });
    if (!saved.tiles.length) return "nothing kept";
    const ok = await restoreTiles(saved, { vault, read, how: "legacy", from: { box: l } });
    return ok ? "the older layout became tiles" : "the older layout did not fit";
  } catch (e) {
    return `not put back: ${(e as Error).message}`;
  }
}

/**
 * Tell the box the layout when it changes, whoever changed it (a sash dragged, a panel toggled, a file opened): the
 * workspace noun's state and its watch (server/model/workspace.ts). Compared as read back; sent at most every 300 ms.
 * Returns the undo.
 */
export function pushLayoutChanges(post: (layout: HostLayout, migratedFrom?: unknown) => void, measure: () => Pick<HostLayout, "viewport" | "sizes"> = domMeasure, postFirst = false): () => void {
  let last = "";
  let t: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    t = null;
    const l = readLayout(measure);
    const j = JSON.stringify(l);
    if (j === last) return;
    const first = last === "";
    last = j;
    if (!first || postFirst) {
      const m = takeMigration();
      post(l, ...(m !== null ? [m] : []));
    }
  };
  const soon = () => {
    if (!t) t = setTimeout(check, 300);
  };
  try {
    check();
  } catch {
    /* no screen to read here (a test, a headless app) */
  }
  const offStore = useStore.subscribe(soon);
  const onWin = () => soon();
  const win = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
  win?.addEventListener("resize", onWin);
  const offSash = onSashMoved(soon);
  const offTiles = useTiles.subscribe(soon);
  const offSettings = onSettingsChanged(soon);
  return () => {
    offSettings();
    offStore();
    offSash();
    offTiles();
    win?.removeEventListener("resize", onWin);
    if (t) clearTimeout(t);
  };
}

const sashFns = new Set<() => void>();
/** As dragging the sashes: the file tree's and the chat's widths (a width left out stays), the viewer takes the rest.
 *  Returns why it can't, or null. */
export function resizeColumns(c: { leftPanel?: number; chat?: number }, measure: () => Pick<HostLayout, "viewport" | "sizes"> = domMeasure): string | null {
  const m = measure();
  if (!outerResize || !m.sizes || !m.viewport) return "the columns can't be resized here (full-screen chat, or no split on screen)";
  const left = typeof c.leftPanel === "number" ? Math.max(0, c.leftPanel) : m.sizes.leftPanel;
  const chat = typeof c.chat === "number" ? Math.max(0, c.chat) : m.sizes.chat;
  const total = m.sizes.leftPanel + m.sizes.viewer + m.sizes.chat;
  outerResize([left, Math.max(340, total - left - chat), chat]);
  return null;
}

// Column widths a core swap put back (src/coreSwap.ts): the new window's first file listing refits the file tree
// (src/App.tsx resets the columns when its fit width changes), which would undo them; for a short while after the
// swap the refit puts them back instead.
let keptColumns: { leftPanel?: number; chat?: number; until: number } | null = null;
export function keepColumns(c: { leftPanel?: number; chat?: number }, ms: number, now = Date.now()): void {
  keptColumns = { ...c, until: now + ms };
}
/** After the columns were reset (src/App.tsx): the kept widths again, while they are kept. True when it did. */
export function reapplyKeptColumns(now = Date.now()): boolean {
  if (!keptColumns || now > keptColumns.until) {
    keptColumns = null;
    return false;
  }
  return resizeColumns(keptColumns) === null;
}

// The viewer's own split (two panes, src/MarkdownArea.tsx): its sizes, as its sash leaves them.
let paneSplitResize: ((sizes: number[]) => void) | null = null;
export function registerPaneSplitResize(fn: (sizes: number[]) => void): () => void {
  paneSplitResize = fn;
  return () => {
    if (paneSplitResize === fn) paneSplitResize = null;
  };
}
/** The two panes' sizes in pixels (widths side by side, heights stacked), or null when the viewer is not split. */
export function paneSplitSizes(): number[] | null {
  if (typeof document === "undefined") return null;
  try {
    const split = document.querySelector('[data-el="markdown-area"] .split-view');
    const views = split ? [...split.querySelectorAll(":scope > .split-view-container > .split-view-view")] : [];
    if (views.length !== 2) return null;
    const vertical = split!.classList.contains("split-view-vertical");
    return views.map((v) => Math.round(vertical ? v.getBoundingClientRect().height : v.getBoundingClientRect().width));
  } catch {
    return null;
  }
}
/** The viewer's split to these sizes, as dragging its sash. False when there is no split on screen. */
export function resizePaneSplit(sizes: number[]): boolean {
  if (!paneSplitResize || sizes.length !== 2) return false;
  paneSplitResize(sizes);
  return true;
}

/** The outer split's columns changed size (Allotment's onChange, src/App.tsx). */
export function sashMoved(): void {
  for (const f of [...sashFns]) f();
}
function onSashMoved(fn: () => void): () => void {
  sashFns.add(fn);
  return () => void sashFns.delete(fn);
}

/** What applying needs from outside the store: putting a file in a pane (it must be read; the agent's path syncs first). */
export type LayoutIO = {
  openInPane(path: string, pane: PaneSide): Promise<{ ok: boolean; note?: string; error?: string }>;
  /** Measures the screen (default: the DOM). */
  measure?: () => Pick<HostLayout, "viewport" | "sizes">;
};

/** The columns of the app's outer split, from the DOM (Allotment's views, in order: tree, viewer, chat). */
export function domMeasure(): Pick<HostLayout, "viewport" | "sizes"> {
  if (typeof window === "undefined" || typeof document === "undefined") return { viewport: null, sizes: null };
  const viewport = { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) };
  try {
    const outer = document.querySelector(".split-view-horizontal, .split-view");
    const views = outer ? [...outer.querySelectorAll(":scope > .split-view-container > .split-view-view")] : [];
    const w = (el: Element | undefined) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
    if (views.length >= 2) return { viewport, sizes: { leftPanel: w(views[0]), viewer: w(views[1]), chat: w(views[2]) } };
  } catch {
    /* no layout engine: the viewport alone */
  }
  return { viewport, sizes: null };
}

/** The layout now, read from the store. */
export function readLayout(measure: () => Pick<HostLayout, "viewport" | "sizes"> = domMeasure): HostLayout {
  ensureTilesStarted();
  const s = useStore.getState();
  const vault = s.vaultPath;
  const split = s.panes.length >= 2;
  // A pane's content: a vault file, or a web page (its address, and its title when the page said it).
  // picking: its Select is on, waiting for Carl's click on the page.
  const content = (f: string, key: string) =>
    isWebAddress(f)
      ? { url: f, ...(s.webTitles[f] ? { title: s.webTitles[f] } : {}), ...(s.webPages[f] ? { page: s.webPages[f] } : {}), ...(isPicking(key) ? { picking: true } : {}) }
      : { file: relToVault(vault, f) };
  // Two or more files: in place order (the tiles'), "left" and "right" the first two (src/tiles.ts tileAtSide).
  const inPlace = fileTilesInPlace().map((l) => s.panes.find((p) => p.id === l.content.paneId)).filter((p): p is (typeof s.panes)[number] => !!p);
  const panes: HostLayout["panes"] = split
    ? (inPlace.length >= 2 ? inPlace : s.panes).slice(0, 2).map((p, i) => ({ side: PANE_SIDES[i]!, ...content(p.file, paneKey(p.id)), active: p.id === s.activePaneId }))
    : s.currentFile
      ? [{ side: "single" as const, ...content(s.currentFile, paneKey(null)), active: true }]
      : [];
  const activePane = split ? sideOf(s, s.activePaneId) : s.currentFile ? "single" : null;
  const web = isWebAddress(s.currentFile);
  return {
    ...(isSecondWindow ? { window: windowNo } : {}),
    split,
    direction: split ? (s.splitDirection === "vertical" ? "stacked" : "side-by-side") : null,
    panes,
    currentFile: s.currentFile && !web ? relToVault(vault, s.currentFile) : null,
    ...(web ? { currentUrl: s.currentFile! } : {}),
    activePane,
    leftPanelOpen: !s.leftCollapsed,
    rightPanelOpen: s.chatSidebarOpen,
    chatPoppedOut: s.popoutOpen,
    chatSidebarOpen: s.chatSidebarOpen,
    titleBarAutoHide: setting("titleBarAutoHide") === true,
    tiles: tilesForLayout((p) => relToVault(vault, p)),
    tileSplit: { ...useTiles.getState().split },
    ...measure(),
    ...(s.webDownloads.length ? { downloads: s.webDownloads } : {}),
  };
}

const sideOk = (v: unknown): v is PaneSide => PANE_SIDES.includes(v as PaneSide);
const done = (note?: string) => ({ ok: true, ...(note ? { note } : {}) });
const no = (error: string) => ({ ok: false, error });

async function applyOne(op: LayoutOp, io: LayoutIO): Promise<{ ok: boolean; note?: string; error?: string }> {
  const st = () => useStore.getState();
  switch (op.op) {
    case "openLeftPanel":
    case "closeLeftPanel": {
      const open = op.op === "openLeftPanel";
      if (st().leftCollapsed === !open) return done(`the left panel was already ${open ? "open" : "closed"}`);
      st().toggleLeft();
      return done();
    }
    case "openRightPanel":
    case "closeRightPanel": {
      // The right panel is Chats (the chat list): every chat itself is a tile.
      const open = op.op === "openRightPanel";
      if (st().chatSidebarOpen === open) return done(`Chats was already ${open ? "open" : "closed"}`);
      st().toggleChatSidebar();
      return done();
    }
    case "closePane": {
      if (op.tile) return closeTile(op.tile) ? done() : no(`no tile "${op.tile}" (see the layout's tiles)`);
      if (op.pane !== undefined && !sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      const s = st();
      if (s.panes.length < 2) {
        // One file: it closes (as its tile's Close does), when no side was named.
        if (op.pane) return no("there is no split: only one file is open, so there is no second pane to close (leave pane out to close it, or name its tile)");
        const one = tileOfPane(null);
        if (!one) return done("no file was open");
        closeTile(one.id);
        return done();
      }
      if (!op.pane) return no('closePane with several files open needs pane: "left" or "right", or tile');
      const t = tileAtSide(op.pane);
      if (!t) return no(`no ${op.pane} pane`);
      closeTile(t.id);
      return done();
    }
    case "openInPane": {
      if (op.pane !== undefined && !sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      if ("url" in op && op.url !== undefined) {
        if (!isWebAddress(op.url)) return no("openInPane's url is an http(s) address");
        // a web tile (its id) goes to the url, as its address bar's Enter.
        if (op.tile) {
          const c = findSlot(useTiles.getState().slots, op.tile)?.content;
          if (c?.type !== "file") return no(`no web tile "${op.tile}" (see the layout's tiles)`);
          const cur = c.paneId ? st().panes.find((p) => p.id === c.paneId)?.file : st().currentFile;
          if (!cur || !isWebAddress(cur)) return no(`tile "${op.tile}" shows a file, not a web page`);
          navigateWebPane(c.paneId, op.url.trim());
          return done();
        }
        return done(openWebInPane(op.url.trim(), op.pane).landed);
      }
      if (op.chat || op.tile || op.spot || (!op.pane && op.path)) {
        // a file or a chat in a spot (a half, a quarter or full, as a drag there; or a spot's id: in it);
        // neither: where new things go (an empty spot, else the whole viewer). No stacking: what it covers closes.
        if (op.tile && !findSlot(useTiles.getState().slots, op.tile)) return no(`no tile "${op.tile}" (see the layout's tiles)`);
        if (op.spot && op.spot !== "full" && !(op.spot in SPOTS)) return no(`spot is one of full, ${Object.keys(SPOTS).join(", ")}`);
        let what: TileWhat;
        if (op.chat) {
          if (op.chat !== "main" && !st().conversations.some((c) => c.id === op.chat)) return no(`no chat "${op.chat}"`);
          what = { chat: op.chat };
        } else if (typeof op.path === "string" && op.path) {
          const vault = st().vaultPath ?? "";
          const abs = /^([a-zA-Z]:)?[\\/]/.test(op.path) ? op.path : `${vault.replace(/[\\/]+$/, "")}/${op.path}`;
          const text = isUnreadableAsText(abs) ? "" : await invoke<string>("read_text_file", { path: abs });
          what = { file: abs, text };
        } else return no("openInPane needs a path or a chat");
        if (op.spot === "full") return openFilling(what), done();
        if (op.spot) return openAt(what, SPOTS[op.spot]) ? done() : no("it can't go there");
        if (op.tile) return openAt(what, op.tile) ? done() : no("it can't go there");
        placeTile(what);
        return done();
      }
      const path = (op as { path?: unknown }).path;
      if (typeof path !== "string" || !path) return no("openInPane needs a path (a vault file) or a url (a web page)");
      if (!op.pane) return no('openInPane of a file needs pane: "left" or "right"');
      return io.openInPane(path, op.pane);
    }
    case "webPage": {
      if (op.pane !== undefined && !sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      return webPageAct(op.do, op.pane, op.url, op);
    }
    case "split": {
      const s = st();
      if (op.on) return s.panes.length >= 2 ? done("already split") : no("a split needs two files: openInPane a second file with the other pane");
      if (s.panes.length < 2) return done("already not split");
      // Off: the active file's tile fills the viewer (the others close, as a drop in the center).
      const keep = tileOfPane(s.activePaneId ?? s.panes[0]!.id);
      if (keep) fillTile(keep.id);
      return done();
    }
    case "focus": {
      const s = st();
      if (op.target === "chat") {
        if (s.popoutOpen) return no("the chat is popped out into its own window");
        if (s.activeConversationId) ensureChatTile(s.activeConversationId);
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-focus-composer"));
        return done();
      }
      if (findSlot(useTiles.getState().slots, op.target)) return focusTile(op.target), done();
      if (!sideOk(op.target)) return no(`focus is "left", "right" or "chat", not "${String((op as { target?: unknown }).target)}"`);
      if (s.panes.length < 2) return no("there is no split: only one file is open");
      const t = tileAtSide(op.target);
      if (!t) return no(`no ${op.target} pane`);
      focusTile(t.id);
      return done();
    }
    case "page": {
      // Settings and Notes are modals over everything (never tiles), as their title-bar buttons.
      const s = st();
      if (op.page === "settings") s.setShowSettings(!!op.open);
      else if (op.page === "notes") s.setShowNotesPanel(!!op.open);
      else return no('page is "settings" or "notes"');
      return done();
    }
    case "moveTile": {
      // As dragging a tile to an edge, a corner or the center: it takes that half, quarter or the whole viewer; the
      // tiles it covers close (no stacking), its old spot is left empty.
      if (!findLeaf(useTiles.getState().slots, op.tile)) return no(`no tile "${String(op.tile)}" (see the layout's tiles)`);
      if (op.spot !== "full" && !(op.spot in SPOTS)) return no(`spot is one of full, ${Object.keys(SPOTS).join(", ")}`);
      const to = op.spot === "full" ? { x: 0, y: 0, w: 2, h: 2 } : SPOTS[op.spot];
      if (moveTile(op.tile, to)) return done();
      return rectEq(findSlot(useTiles.getState().slots, op.tile)!.rect, to) ? done(`it is in ${op.spot} already`) : no(`it can't go to ${op.spot} (three columns come only from two halves, for something new; in three columns, only columns, their halves or full; at most 4 spots)`);
    }
    case "newChat": {
      const cc = await import("./chat-controller");
      if (op.tile) {
        if (findSlot(useTiles.getState().slots, op.tile)?.content?.type !== "chat") return no(`"${op.tile}" is not a chat tile (see the layout's tiles)`);
        return cc.newChatInTile(op.tile) ? done() : no("no new chat");
      }
      if (op.spot && op.spot !== "full" && !(op.spot in SPOTS)) return no(`spot is one of full, ${Object.keys(SPOTS).join(", ")}`);
      const place = op.place ?? null;
      const at = op.spot === "full" ? { fill: true as const } : op.spot ? { rect: SPOTS[op.spot] } : null;
      if (at) newChatAt(() => cc.newChatIn(place), at);
      else cc.newChatIn(place);
      return done();
    }
    case "autoHideTitleBar": {
      if (typeof op.on !== "boolean") return no("autoHideTitleBar needs on: true or false");
      if ((setting("titleBarAutoHide") === true) === op.on) return done(`the title bar was already ${op.on ? "auto-hidden" : "shown"}`);
      const why = await saveSetting("titleBarAutoHide", op.on);
      return why ? no(why) : done();
    }
    case "chatSidebar": {
      if (st().chatSidebarOpen === !!op.open) return done(`the sidebar was already ${op.open ? "open" : "closed"}`);
      st().toggleChatSidebar();
      return done();
    }
    case "resize": {
      // the lines between spots, as dragging their dividers (a spot dragged away is not collapsed here).
      if (op.tiles) {
        // x alone: the line between the sides in both rows; with xb: the top row's (x) and the bottom row's (xb).
        setSplit(op.tiles.x !== undefined && op.tiles.xb === undefined ? { ...op.tiles, xb: op.tiles.x } : op.tiles);
        if (op.leftPanel === undefined && op.chat === undefined) return done();
      }
      const why = resizeColumns({ leftPanel: op.leftPanel, chat: op.chat }, io.measure);
      return why ? no(why) : done();
    }
    case "newWindow":
      // The main window opens it (a New window's own button is not drawn).
      return openWindow();
    case "closeWindow":
      return closeWindow(op.window ?? (isSecondWindow ? windowNo : undefined));
    case "signOutOfSites": {
      const r = await signOutOfSites();
      return r.ok ? done(r.note) : no(r.error ?? "not signed out");
    }
    default:
      return no(`unknown layout op "${String((op as { op?: unknown }).op)}" (${LAYOUT_OPS.join(", ")})`);
  }
}

/** Apply the ops in order (a failed one is reported and the rest still run), then read the layout back. */
export async function applyLayoutOps(ops: LayoutOp[], io: LayoutIO): Promise<LayoutResult> {
  ensureTilesStarted();
  const results: LayoutOpResult[] = [];
  for (const op of ops) {
    let r: { ok: boolean; note?: string; error?: string };
    try {
      r = await applyOne(op, io);
    } catch (e) {
      r = no((e as Error)?.message ?? String(e));
    }
    results.push({ op: String((op as { op?: unknown })?.op), ...r });
  }
  // Let the store's change reach the screen (Allotment resizes) before the sizes are read.
  if (typeof requestAnimationFrame === "function") await new Promise<void>((res) => requestAnimationFrame(() => setTimeout(res, 60)));
  return { ok: results.every((r) => r.ok), results, layout: readLayout(io.measure) };
}

/** A line for the agent / a log: what the layout is. */
export function layoutText(l: HostLayout): string {
  const seen = (p: { page?: WebPageSeen }) =>
    p.page ? ` (${p.page.textLength} chars of text${p.page.elements ? `, ${p.page.elementCount ?? p.page.elements.length} elements` : ""}${p.page.errors ? `, ${p.page.errors.length} errors` : ""}${p.page.failed ? `, ${p.page.failed.length} failed requests` : ""})` : "";
  const what = (p: HostLayout["panes"][number]) => ("url" in p ? `page ${p.url}${p.title ? ` "${p.title}"` : ""}${seen(p)}` : p.file);
  const one = l.panes[0];
  const where = l.split ? `split ${l.direction}: ${l.panes.map((p) => `${p.side}=${what(p)}${p.active ? " (active)" : ""}`).join(", ")}` : one ? ("url" in one ? `one web ${what(one)}` : `one file: ${one.file}`) : "nothing open in the viewer";
  const chat = l.chatPoppedOut ? "chat popped out" : `chat panel ${l.rightPanelOpen ? "open" : "closed"}`;
  const size = l.viewport ? `; window ${l.viewport.width}x${l.viewport.height}${l.sizes ? ` (left panel ${l.sizes.leftPanel}px, viewer ${l.sizes.viewer}px, chat ${l.sizes.chat}px)` : ""}` : "";
  return `${l.window ? `window ${l.window}: ` : ""}${where}; left panel ${l.leftPanelOpen ? "open" : "closed"}; ${chat}${size}`;
}
