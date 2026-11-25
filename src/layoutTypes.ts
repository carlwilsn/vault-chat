// The layout's data shapes (src/layoutOps.ts reads and changes the screen): no imports, so a host that only names them
// (the plugin host API, src/hostApi.ts) does not pull in the app.

/** The two panes of a split ("left" is the top one when stacked). */
export type PaneSide = "left" | "right";
/** A Snap spot of the viewer: a half or a quarter; full: the whole viewer (every other tile closes, as a drop in its
 *  center box). */
export type TileSpot = "full" | "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type LayoutOp =
  | { op: "openLeftPanel" }
  | { op: "closeLeftPanel" }
  | { op: "openRightPanel" }
  | { op: "closeRightPanel" }
  // A pane is also any tile (its id, from `tiles`; closing a tile leaves its spot empty, closing an
  // empty spot takes it away); openInPane also opens a chat, in a spot or a tile's spot (neither: where new
  // things go); moveTile is a drag of a tile to a spot; page opens / closes the Settings or Notes modal.
  | { op: "closePane"; pane?: PaneSide; tile?: string }
  | { op: "openInPane"; path?: string; chat?: string; pane?: PaneSide; tile?: string; spot?: TileSpot; url?: undefined }
  /** A web page (url: pane left out puts it in place of the active pane's). */
  | { op: "openInPane"; url: string; pane?: PaneSide; tile?: string }
  /** The web page in a pane (left out: the active one): Back, Forward, Reload, Open in browser (url: another address);
   *  read it again, click / type into / scroll to an element (ref from its read, or text), select one (Select: with ref
   *  it goes to the composer as a chip; without, Carl picks it on the page). */
  | { op: "webPage"; do: "back" | "forward" | "reload" | "browser" | "read" | "click" | "type" | "scroll" | "select"; pane?: PaneSide; url?: string; ref?: string; text?: string; value?: string; enter?: boolean; by?: number | "top" | "bottom" }
  | { op: "page"; page: "settings" | "notes"; open: boolean }
  | { op: "moveTile"; tile: string; spot: TileSpot }
  /** The title bar auto-hidden (on) or always shown (off): the same setting as its right-click menu. */
  | { op: "autoHideTitleBar"; on: boolean }
  /** A new chat: tile (a chat tile): in its place (its project or Main), replacing that tile's chat, as its New chat;
   *  else in place ("main" or a project's slug; left out: where Carl is) at spot (left out: where new things go), as
   *  "+ New chat" or a project row dropped there. */
  | { op: "newChat"; tile?: string; place?: string; spot?: TileSpot }
  | { op: "maximize"; tile?: string; on: boolean }
  | { op: "split"; on: boolean }
  | { op: "focus"; target: PaneSide | "chat" | string }
  | { op: "fullscreenChat"; on: boolean }
  | { op: "chatSidebar"; open: boolean }
  | { op: "resize"; leftPanel?: number; chat?: number; tiles?: { x?: number; xb?: number; left?: number; right?: number } }
  /** The web pages' browser profile wiped (src/webProfile.ts): signed out of every site, cookies and storage gone. */
  | { op: "signOutOfSites" }
  /** A second app window on this vault (the title bar's New window, src/newWindow.ts): its own tiles, Files and Chats
   *  closed at first; open already: brought to the front. */
  | { op: "newWindow" }
  /** Close a New window (window: 2; in that window, left out: itself): its tiles are dropped on the box. */
  | { op: "closeWindow"; window?: number };

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
  /** Which window this is, when it is not the main one (2: a New window, src/newWindow.ts): each has its own tiles. */
  window?: number;
  /** The title bar hides until the pointer rests at the top edge (its right-click menu's Auto-hide). */
  titleBarAutoHide?: boolean;
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
  /** the viewer's spots: [{ tile, spot: full|left|...|bottom-right, file|chat|page|empty, focused?, maximized? }]. */
  tiles?: unknown;
  /** where the lines between spots are: x (left side's share of the width), left / right (each side's top
   *  spot's share of the height). */
  tileSplit?: { x: number; xb: number; left: number; right: number };
  viewport: { width: number; height: number } | null;
  /** Pixel widths of the three columns, when the screen can say (null: not measurable here). */
  sizes: { leftPanel: number; viewer: number; chat: number } | null;
  /** The web pages' downloads this session, newest first (at most 20): each saved to <vault>/.vault-chat/downloads. */
  downloads?: WebDownload[];
};

export type LayoutOpResult = { op: string; ok: boolean; note?: string; error?: string };
export type LayoutResult = { ok: boolean; results: LayoutOpResult[]; layout: HostLayout };
