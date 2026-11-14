// The app's layout as data and as actions: what the screen looks like (panes and their files, split, left panel, chat,
// viewport and panel sizes) and the ops that change it. One implementation for everyone who arranges the screen:
// a plugin (api.host.layout, src/hostApi.ts) and the agent's Layout tool (server/layoutTool.ts → a "layout" signal on the
// feed → src/boxChat.ts → here). Every apply returns the layout AFTER the ops, read back from the store, never assumed.
//
// Names: the two panes of a split are "left" and "right" (src/paneLayout.ts; in a stacked split left is the top one).
// "leftPanel" is the file tree; "chat" is the right panel (or the full-screen chat).
import { useStore } from "./store";
import { PANE_SIDES, relToVault, sideOf, type PaneSide } from "./paneLayout";

export type LayoutOp =
  | { op: "openLeftPanel" }
  | { op: "closeLeftPanel" }
  | { op: "openRightPanel" }
  | { op: "closeRightPanel" }
  | { op: "closePane"; pane: PaneSide }
  | { op: "openInPane"; path: string; pane: PaneSide }
  | { op: "split"; on: boolean }
  | { op: "focus"; target: PaneSide | "chat" }
  | { op: "fullscreenChat"; on: boolean }
  | { op: "chatSidebar"; open: boolean };

export const LAYOUT_OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "split", "focus", "fullscreenChat", "chatSidebar"] as const;

export type HostLayout = {
  /** Two files side by side or stacked. */
  split: boolean;
  direction: "side-by-side" | "stacked" | null;
  /** The viewer's files, in order (one entry when there is no split, none when nothing is open). Vault-relative. */
  panes: { side: PaneSide | "single"; file: string; active: boolean }[];
  /** The file the viewer is on (the active pane's). */
  currentFile: string | null;
  activePane: PaneSide | "single" | null;
  /** The file tree. */
  leftPanelOpen: boolean;
  /** The chat as the right panel (false while it is full screen or popped out). */
  rightPanelOpen: boolean;
  chatFullscreen: boolean;
  chatPoppedOut: boolean;
  /** The conversations sidebar inside the full-screen chat. */
  chatSidebarOpen: boolean;
  viewport: { width: number; height: number } | null;
  /** Pixel widths of the three columns, when the screen can say (null: not measurable here). */
  sizes: { leftPanel: number; viewer: number; chat: number } | null;
};

export type LayoutOpResult = { op: string; ok: boolean; note?: string; error?: string };
export type LayoutResult = { ok: boolean; results: LayoutOpResult[]; layout: HostLayout };

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
  const panes: HostLayout["panes"] = split
    ? s.panes.slice(0, 2).map((p, i) => ({ side: PANE_SIDES[i]!, file: relToVault(vault, p.file), active: p.id === s.activePaneId }))
    : s.currentFile
      ? [{ side: "single" as const, file: relToVault(vault, s.currentFile), active: true }]
      : [];
  const activePane = split ? sideOf(s, s.activePaneId) : s.currentFile ? "single" : null;
  return {
    split,
    direction: split ? (s.splitDirection === "vertical" ? "stacked" : "side-by-side") : null,
    panes,
    currentFile: s.currentFile ? relToVault(vault, s.currentFile) : null,
    activePane,
    leftPanelOpen: !s.leftCollapsed && !s.chatFullscreen,
    rightPanelOpen: !s.rightCollapsed && !s.popoutOpen && !s.chatFullscreen,
    chatFullscreen: s.chatFullscreen,
    chatPoppedOut: s.popoutOpen,
    chatSidebarOpen: s.chatSidebarOpen,
    ...measure(),
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
      if (!sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      const s = st();
      if (s.panes.length < 2) return no("there is no split: only one file is open, so there is no second pane to close");
      s.closePane(s.panes[op.pane === "left" ? 0 : 1]!.id);
      return done();
    }
    case "openInPane": {
      if (!sideOk(op.pane)) return no(`pane is "left" or "right", not "${String((op as { pane?: unknown }).pane)}"`);
      if (typeof op.path !== "string" || !op.path) return no("openInPane needs a path");
      return io.openInPane(op.path, op.pane);
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
  const where = l.split ? `split ${l.direction}: ${l.panes.map((p) => `${p.side}=${p.file}${p.active ? " (active)" : ""}`).join(", ")}` : l.currentFile ? `one file: ${l.currentFile}` : "nothing open in the viewer";
  const chat = l.chatFullscreen ? "chat full screen" : l.chatPoppedOut ? "chat popped out" : `chat panel ${l.rightPanelOpen ? "open" : "closed"}`;
  const size = l.viewport ? `; window ${l.viewport.width}x${l.viewport.height}${l.sizes ? ` (left panel ${l.sizes.leftPanel}px, viewer ${l.sizes.viewer}px, chat ${l.sizes.chat}px)` : ""}` : "";
  return `${where}; left panel ${l.leftPanelOpen ? "open" : "closed"}; ${chat}${size}`;
}
