// The app's layout as data and as actions: what the screen looks like (panes and their files, split, left panel, chat,
// viewport and panel sizes) and the ops that change it. One implementation for everyone who arranges the screen:
// a plugin (api.host.layout, src/hostApi.ts) and the agent's Layout tool (server/layoutTool.ts → a "layout" signal on the
// feed → src/boxChat.ts → here). Every apply returns the layout AFTER the ops, read back from the store, never assumed.
//
// Names: the two panes of a split are "left" and "right" (src/paneLayout.ts; in a stacked split left is the top one).
// "leftPanel" is the file tree; "chat" is the right panel (or the full-screen chat).
import { useStore } from "./store";
import { PANE_SIDES, relToVault, sideOf } from "./paneLayout";
import type { HostLayout, LayoutOp, LayoutOpResult, LayoutResult, PaneSide, WebPageSeen } from "./layoutTypes";
import { isPicking, isWebAddress, openWebInPane, paneKey, webPageAct } from "./webPane";
import { signOutOfSites } from "./webProfile";
export type { HostLayout, LayoutOp, LayoutOpResult, LayoutResult, WebPageSeen } from "./layoutTypes";

export const LAYOUT_OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "webPage", "split", "focus", "fullscreenChat", "chatSidebar", "resize", "signOutOfSites"] as const;

/** The outer split's own resize (Allotment's, registered by src/App.tsx): what dragging a sash does, in pixels per column. */
let outerResize: ((sizes: number[]) => void) | null = null;
export function registerOuterResize(fn: (sizes: number[]) => void): () => void {
  outerResize = fn;
  return () => {
    if (outerResize === fn) outerResize = null;
  };
}

/**
 * Tell the box the layout when it changes, whoever changed it (a sash dragged, a panel toggled, a file opened): the
 * workspace noun's state and its watch (server/model/workspace.ts). Compared as read back; sent at most every 300 ms.
 * Returns the undo.
 */
export function pushLayoutChanges(post: (layout: HostLayout) => void, measure: () => Pick<HostLayout, "viewport" | "sizes"> = domMeasure): () => void {
  let last = "";
  let t: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    t = null;
    const l = readLayout(measure);
    const j = JSON.stringify(l);
    if (j === last) return;
    const first = last === "";
    last = j;
    if (!first) post(l);
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
  return () => {
    offStore();
    offSash();
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
  const s = useStore.getState();
  const vault = s.vaultPath;
  const split = s.panes.length >= 2;
  // A pane's content: a vault file, or a web page (its address, and its title when the page said it).
  // picking: its Select is on, waiting for Carl's click on the page.
  const content = (f: string, key: string) =>
    isWebAddress(f)
      ? { url: f, ...(s.webTitles[f] ? { title: s.webTitles[f] } : {}), ...(s.webPages[f] ? { page: s.webPages[f] } : {}), ...(isPicking(key) ? { picking: true } : {}) }
      : { file: relToVault(vault, f) };
  const panes: HostLayout["panes"] = split
    ? s.panes.slice(0, 2).map((p, i) => ({ side: PANE_SIDES[i]!, ...content(p.file, paneKey(p.id)), active: p.id === s.activePaneId }))
    : s.currentFile
      ? [{ side: "single" as const, ...content(s.currentFile, paneKey(null)), active: true }]
      : [];
  const activePane = split ? sideOf(s, s.activePaneId) : s.currentFile ? "single" : null;
  const web = isWebAddress(s.currentFile);
  return {
    split,
    direction: split ? (s.splitDirection === "vertical" ? "stacked" : "side-by-side") : null,
    panes,
    currentFile: s.currentFile && !web ? relToVault(vault, s.currentFile) : null,
    ...(web ? { currentUrl: s.currentFile! } : {}),
    activePane,
    leftPanelOpen: !s.leftCollapsed && !s.chatFullscreen,
    rightPanelOpen: !s.rightCollapsed && !s.popoutOpen && !s.chatFullscreen,
    chatFullscreen: s.chatFullscreen,
    chatPoppedOut: s.popoutOpen,
    chatSidebarOpen: s.chatSidebarOpen,
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
      const open = op.op === "openRightPanel";
      if (st().popoutOpen) return no("the chat is popped out into its own window; it has no right panel");
      if (st().rightCollapsed === !open) return done(`the chat panel was already ${open ? "open" : "closed"}`);
      st().toggleRight();
      return done();
    }
    case "closePane": {
      if (op.pane !== undefined && !sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      const s = st();
      if (s.panes.length < 2) {
        // No split: the one file or page closes (as its own Close does), when no side was named.
        if (op.pane) return no("there is no split: only one file is open, so there is no second pane to close (leave pane out to close it)");
        if (!s.currentFile) return done("nothing was open");
        s.setCurrentFile(null, "");
        return done();
      }
      if (!op.pane) return no('closePane in a split needs pane: "left" or "right"');
      s.closePane(s.panes[op.pane === "left" ? 0 : 1]!.id);
      return done();
    }
    case "openInPane": {
      if (op.pane !== undefined && !sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      if ("url" in op && op.url !== undefined) {
        if (!isWebAddress(op.url)) return no("openInPane's url is an http(s) address");
        return done(openWebInPane(op.url.trim(), op.pane).landed);
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
      // Off: the active pane stays, the other closes.
      const other = s.panes.find((p) => p.id !== s.activePaneId) ?? s.panes[1]!;
      s.closePane(other.id);
      return done();
    }
    case "focus": {
      const s = st();
      if (op.target === "chat") {
        if (s.popoutOpen) return no("the chat is popped out into its own window");
        if (s.rightCollapsed && !s.chatFullscreen) s.toggleRight();
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-focus-composer"));
        return done();
      }
      if (!sideOk(op.target)) return no(`focus is "left", "right" or "chat", not "${String((op as { target?: unknown }).target)}"`);
      if (s.panes.length < 2) return no("there is no split: only one file is open");
      s.setActivePane(s.panes[op.target === "left" ? 0 : 1]!.id);
      return done();
    }
    case "fullscreenChat": {
      if (st().chatFullscreen === !!op.on) return done(`the chat was already ${op.on ? "full screen" : "not full screen"}`);
      st().toggleChatFullscreen();
      return done();
    }
    case "chatSidebar": {
      if (st().chatSidebarOpen === !!op.open) return done(`the sidebar was already ${op.open ? "open" : "closed"}`);
      st().toggleChatSidebar();
      return done();
    }
    case "resize": {
      const why = resizeColumns({ leftPanel: op.leftPanel, chat: op.chat }, io.measure);
      return why ? no(why) : done();
    }
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
  const chat = l.chatFullscreen ? "chat full screen" : l.chatPoppedOut ? "chat popped out" : `chat panel ${l.rightPanelOpen ? "open" : "closed"}`;
  const size = l.viewport ? `; window ${l.viewport.width}x${l.viewport.height}${l.sizes ? ` (left panel ${l.sizes.leftPanel}px, viewer ${l.sizes.viewer}px, chat ${l.sizes.chat}px)` : ""}` : "";
  return `${where}; left panel ${l.leftPanelOpen ? "open" : "closed"}; ${chat}${size}`;
}
