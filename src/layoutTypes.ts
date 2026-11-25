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
  /** The web page in a pane (left out: the active one): Back, Forward, Reload, Open in browser (url: another address);
   *  read it again, click / type into / scroll to an element (ref from its read, or text), select one (Select: with ref
   *  it goes to the composer as a chip; without, Carl picks it on the page). */
  | { op: "webPage"; do: "back" | "forward" | "reload" | "browser" | "read" | "click" | "type" | "scroll" | "select"; pane?: PaneSide; url?: string; ref?: string; text?: string; value?: string; enter?: boolean; by?: number | "top" | "bottom" }
  | { op: "split"; on: boolean }
  | { op: "focus"; target: PaneSide | "chat" }
  | { op: "fullscreenChat"; on: boolean }
  | { op: "chatSidebar"; open: boolean }
  | { op: "resize"; leftPanel?: number; chat?: number }
  /** The web pages' browser profile wiped (src/webProfile.ts): signed out of every site, cookies and storage gone. */
  | { op: "signOutOfSites" };

/** What a page in a pane shows: its visible text (trimmed and capped; textLength is the whole) and `at`, when it was
 *  read. A dev-server page reports itself (server/devProxy.ts frameScript): also console and uncaught errors, and
 *  requests that failed (status 0: no answer). A public page is read through its native view (src/webDrive.ts): also
 *  its interactive elements, one line each with a ref ("e12 button \"Sign in\"", in view first; elementCount when
 *  more than listed), a password field only as filled / empty, and where it is scrolled. */
export type WebPageSeen = {
  text: string;
  textLength: number;
  errors?: string[];
  failed?: { status: number; url: string; how?: string }[];
  elements?: string[];
  elementCount?: number;
  scroll?: { y: number; max: number };
  at: string;
};

/** A file a web page downloaded (src/webProfile.ts): saved under the vault's .vault-chat/downloads. */
export type WebDownload = { name: string; /** vault-relative */ path: string; /** bytes; null when it failed */ size: number | null; at: string; ok: boolean; /** the source's host */ from?: string };

export type HostLayout = {
  /** Two files side by side or stacked. */
  split: boolean;
  direction: "side-by-side" | "stacked" | null;
  /** The viewer's panes, in order (one entry when there is no split, none when nothing is open): a vault file
   *  (vault-relative) or a web page (its address now, and its title when known). */
  panes: ({ side: PaneSide | "single"; active: boolean } & ({ file: string } | { url: string; title?: string; page?: WebPageSeen; picking?: boolean }))[];
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
  /** The web pages' downloads this session, newest first (at most 20): each saved to <vault>/.vault-chat/downloads. */
  downloads?: WebDownload[];
};

export type LayoutOpResult = { op: string; ok: boolean; note?: string; error?: string };
export type LayoutResult = { ok: boolean; results: LayoutOpResult[]; layout: HostLayout };
