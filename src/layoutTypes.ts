// The layout's data shapes (src/layoutOps.ts reads and changes the screen): no imports, so a host that only names them
// (the plugin host API, src/hostApi.ts) does not pull in the app.

/** The two panes of a split ("left" is the top one when stacked). */
export type PaneSide = "left" | "right";

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
