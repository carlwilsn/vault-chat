// The layout's data shapes (src/layoutOps.ts reads and changes the screen): no imports, so a host that only names them
// (the plugin host API, src/hostApi.ts) does not pull in the app.

/** The two panes of a split ("left" is the top one when stacked). */
export type PaneSide = "left" | "right";

export type LayoutOp =
  | { op: "openLeftPanel" }
  | { op: "closeLeftPanel" }
  | { op: "openRightPanel" }
  | { op: "closeRightPanel" }
  /** No split: pane may be left out, and the one file or page closes. */
  | { op: "closePane"; pane?: PaneSide }
  /** A vault file (pane needed), or a web page (url: pane left out puts it in place of the active pane's). */
  | { op: "openInPane"; path: string; pane: PaneSide }
  | { op: "openInPane"; url: string; pane?: PaneSide }
  /** The web page in a pane (left out: the active one): Back, Forward, Reload, Open in browser (url: another address). */
  | { op: "webPage"; do: "back" | "forward" | "reload" | "browser"; pane?: PaneSide; url?: string }
  | { op: "split"; on: boolean }
  | { op: "focus"; target: PaneSide | "chat" }
  | { op: "fullscreenChat"; on: boolean }
  | { op: "chatSidebar"; open: boolean }
  | { op: "resize"; leftPanel?: number; chat?: number };

/** What a dev-server page in a pane shows, as the page itself reported it (server/devProxy.ts frameScript): its visible
 *  text (trimmed, at most 8000 characters; textLength is the whole), console and uncaught errors, and requests that
 *  failed (status 0: no answer), the last ones of each; `at` is when the page last reported. */
export type WebPageSeen = { text: string; textLength: number; errors: string[]; failed: { status: number; url: string; how?: string }[]; at: string };

export type HostLayout = {
  /** Two files side by side or stacked. */
  split: boolean;
  direction: "side-by-side" | "stacked" | null;
  /** The viewer's panes, in order (one entry when there is no split, none when nothing is open): a vault file
   *  (vault-relative) or a web page (its address now, and its title when known). */
  panes: ({ side: PaneSide | "single"; active: boolean } & ({ file: string } | { url: string; title?: string; page?: WebPageSeen }))[];
  /** The file the viewer is on (the active pane's; null when that is a web page). */
  currentFile: string | null;
  /** The web page the viewer is on, when the active pane holds one. */
  currentUrl?: string;
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
