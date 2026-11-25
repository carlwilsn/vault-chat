// The workspace noun (report 24 §4, noun 4): what is on Carl's laptop screen and how it is arranged: the viewer's panes
// (a split of two files, "left" and "right"; stacked: left is the top), the left panel (file tree), the chat (the right
// panel, full screen, its sidebar) and which chat is open. Only the laptop app has panes, so its state is what the
// laptop reads back from its own screen (src/layoutOps.ts readLayout), kept on the box with when it was read: read live
// when the laptop is up, the last read-back (and since when the laptop is away) when it is not. The actions are the
// app's own layout ops (src/layoutOps.ts LAYOUT_OPS: a pane holds a vault file or a web page, src/webPane.ts, the same ones a plugin has as api.host.layout and the title bar's
// buttons call) and openChat (the chat list's own open), sent over Show's signal + ack channel (server/layoutTool.ts);
// each is confirmed only by the laptop's ack. Watched on that ack and on the laptop's own layout events (the viewer
// opening a file, the chat list switching chat), so a change Carl makes by hand is seen too. Opening a file at a place
// stays Show (it also reaches web pages and dev servers, and switches the laptop's vault).
import { controlDown } from "../deviceLink";
import { signalLog } from "../convlog/log";
import { OFFER_EVENT } from "../offerLog";
import { keptLayout, keptWindows, layoutTool, onLayoutKept } from "../layoutTool";
import type { ActResult, Noun, NounAction } from "./index";

/** How fresh a read-back must be to answer without asking the laptop again (an action's own ack, just now). */
const FRESH_MS = 2_000;
/** The laptop's layout events (src/offerHistory.ts → offer.event records): a change Carl made by hand. */
const LAYOUT_PARTS = new Set(["app/viewer", "app/chats", "app/titlebar", "app/chat"]);

const when = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
const PANE = { type: "string", enum: ["left", "right"], description: "left or right (stacked: left is the top)" };
const SPOT = { type: "string", enum: ["full", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"], description: "a half or a quarter of the viewer, or full: the whole viewer" };
const WINDOW = { type: "integer", minimum: 1, description: "which window: 2 a New window (its own tiles; see windows); left out: the main window" };
const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export type WorkspaceCtx = { vault: string; emit?: (ev: Record<string, unknown>) => void; ackMs?: number; dev?: (port: number) => Promise<{ origin: string } | { error: string }> };

export function workspaceNoun(ctx: WorkspaceCtx): Noun {
  const run = (op: string) => async (a: Record<string, unknown>): Promise<ActResult> => {
    if (!ctx.emit) return { ok: false, text: "this box has no link to the laptop here; nothing changed." };
    const args = op === "arrange" ? { ops: a.ops, ...(a.window !== undefined ? { window: a.window } : {}) } : { action: op, ...a };
    const r = await layoutTool({ vault: ctx.vault, emit: ctx.emit, ackMs: ctx.ackMs, dev: ctx.dev, brief: true }, args);
    return { ok: r.ok, text: r.text };
  };
  // Every arranging action takes window: 2 to act in a New window (left out: the main window); opening and closing
  // windows are the main window's own.
  const withWindow = (args: Record<string, unknown>) => ({ ...args, properties: { ...(args.properties as object), window: WINDOW } });
  const action = (description: string, op: string, args = obj()): NounAction => ({ description, args: op === "newWindow" || op === "closeWindow" ? args : withWindow(args), run: run(op) });
  return {
    id: "workspace",
    name: "Workspace",
    state: {
      layout: {
        description:
          "Carl's laptop screen, read back from it: downloads (files the web pages saved this session, newest first: name, path under .vault-chat/downloads, size, at, ok); panes and their files or web pages (url and title; Carl's own navigation shows here; `page`: the visible text as Carl sees it, for a public page also its interactive elements with refs (one line each, like e12 button 'Sign in'; password fields only filled / empty) and scroll, for a dev server's page console errors and failed requests with status, as the page reported them; picking: its Select is on) (split, side-by-side or stacked, the active pane), the left panel (file tree) open, the chat panel open / full screen / popped out, its sidebar, the open chat when known, window and column sizes; when the laptop is away, the last read-back and since when",
        read: async () => {
          const k = keptLayout();
          const down = controlDown("laptop");
          if (k && Date.now() - k.at < FRESH_MS) return { ...(k.layout as object), ...(k.open !== undefined ? { openChat: k.open } : {}), readAt: when(k.at) };
          if (!down && ctx.emit) {
            const r = await layoutTool({ vault: ctx.vault, emit: ctx.emit, ackMs: ctx.ackMs ?? 8_000, brief: true }, { action: "get" });
            const n = keptLayout();
            if (r.ok && n) return { ...(n.layout as object), ...(n.open !== undefined ? { openChat: n.open } : {}), readAt: when(n.at) };
            return { error: r.text, ...(n ? { last: n.layout, readAt: when(n.at) } : {}) };
          }
          return { laptop: down ?? "no link to the laptop here", ...(k ? { last: k.layout, readAt: when(k.at) } : { last: null }) };
        },
      },
      windows: {
        description:
          "every vault-chat window on the laptop, each with its own tiles: window 1 the main one (as layout), window 2 a New window (Files and Chats closed at first), each as its last read-back (it says its layout when anything in it changes) and when; a New window is kept across a restart (the app opens it again) and gone once closed. Act in one with window: 2 on any action",
        read: async () => {
          const down = controlDown("laptop");
          return {
            ...(down ? { laptop: down } : {}),
            windows: keptWindows().map((w) => ({ window: w.window, ...(w.layout as object), ...(w.window === 1 && w.open !== undefined ? { openChat: w.open } : {}), readAt: when(w.at) })),
          };
        },
      },
    },
    actions: {
      openLeftPanel: action("open the left panel (the file tree)", "openLeftPanel"),
      closeLeftPanel: action("close the left panel (the file tree)", "closeLeftPanel"),
      openRightPanel: action("open Chats (the chat list at the right; every chat is a tile)", "openRightPanel"),
      closeRightPanel: action("close Chats (the chat list at the right)", "closeRightPanel"),
      closePane: action("close one pane of the split (back to one file); with no split, leave pane out to close the one file or page; or a tile by its id: its spot stays, empty; an empty spot's id takes the spot away (its neighbour grows)", "closePane", obj({ pane: PANE, tile: { type: "string", description: "a tile id from layout.tiles" } })),
      openInPane: action(
        "put a vault file (path + pane) or a web page (url; pane left out: in place of the active pane's) in a pane, turning the split on when one other is open; a pane already on a page goes to the url. A url http://localhost:<port> is your StartJob dev server, through the box. To open a file at a place, use Show. Or a file or a chat (its id) in a spot (a half, a quarter, or full: the whole viewer, as a drag there) or in a tile's spot (a web tile with url: it goes to that address, as its address bar); with neither pane nor spot: where new things go (an empty spot, else the whole viewer). No stacking: a tile it covers completely closes (it stays in Files / Chats), one it covers in part shrinks into the rest of its room",
        "openInPane",
        obj({ path: { type: "string", description: "vault-relative" }, url: { type: "string", description: "http(s)" }, chat: { type: "string" }, pane: PANE, tile: { type: "string", description: "a tile id: open it in that spot" }, spot: SPOT }),
      ),
      webPage: action(
        "the web page in a pane (left out: the active one): its title row's back, forward, reload, browser (opens it, or url, in his browser); and inside a public page: read (its text and elements again, into panes[].page), click (ref from page.elements, or text), type (value into ref / a field's text; enter: true presses Enter), scroll (by pixels, \"top\" / \"bottom\", or to ref), select (with ref: that element goes to his composer as a chip; without: Select, Carl clicks one). Answers with the page read back",
        "webPage",
        obj({ do: { type: "string", enum: ["back", "forward", "reload", "browser", "read", "click", "type", "scroll", "select"] }, pane: PANE, url: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, value: { type: "string" }, enter: { type: "boolean" }, by: { description: "pixels (negative: up), \"top\" or \"bottom\"" } }, ["do"]),
      ),
      moveTile: action("drag a tile to a spot as Windows Snap: it takes that half, quarter or the whole viewer (full); onto exactly one tile of the same size and shape (half and half, quarter and quarter) they swap; otherwise a tile it covers completely closes, one it covers in part shrinks into the rest of its room (no stacking), and its old spot is left empty", "moveTile", obj({ tile: { type: "string" }, spot: SPOT }, ["tile", "spot"])),
      newChat: action("a new chat: with tile (a chat tile's id), in that chat's place (its project or Main), replacing it in that tile, as the tile's New chat; else in place (\"main\" or a project's slug; left out: where Carl is) at spot (left out: where new things go), as \"+ New chat\" or a project row dropped there", "newChat", obj({ tile: { type: "string" }, place: { type: "string" }, spot: SPOT })),
      autoHideTitleBar: action("the title bar auto-hidden (on: it slides in when the pointer rests at the top edge) or always shown (off), as its right-click menu's Auto-hide title bar; layout.titleBarAutoHide says which", "autoHideTitleBar", obj({ on: { type: "boolean" } }, ["on"])),
      page: action("open or close Settings or Notes: a modal centred over everything (never a tile), as its title-bar button", "page", obj({ page: { type: "string", enum: ["settings", "notes"] }, open: { type: "boolean" } }, ["page", "open"])),
      maximize: action("a tile fills the app window (its own row the one bar), or (on: false) back to the arrangement", "maximize", obj({ tile: { type: "string" }, on: { type: "boolean" } }, ["on"])),
      split: action("turn the split on or off (off keeps the active pane)", "split", obj({ on: { type: "boolean" } }, ["on"])),
      focus: action("focus a pane, a tile (its id) or the chat", "focus", obj({ target: { type: "string", description: '"left", "right", "chat" or a tile id' } }, ["target"])),
      fullscreenChat: action("the open chat's tile full screen, or back (as maximize)", "fullscreenChat", obj({ on: { type: "boolean" } }, ["on"])),
      chatSidebar: action("Chats (the chat list at the right) open or closed, as Ctrl+Shift+B", "chatSidebar", obj({ open: { type: "boolean" } }, ["open"])),
      resize: action("set the columns' widths as dragging the sashes does: leftPanel (the file tree) and/or chat, in pixels; the viewer takes the rest. tiles: the lines between the viewer's spots as dragging their dividers does, fractions: x (the left side's share of the width; alone: in both rows), xb (the bottom row's own, when the rows' lines differ: four quarters, or a bottom row split under a top half), left / right (that side's top spot's share of its height; one line across when a spot spans both sides: left). Four quarters: rows' lines apart keep one line across, sides' lines apart keep one line down", "resize", obj({ leftPanel: { type: "number", minimum: 0 }, chat: { type: "number", minimum: 0 }, tiles: obj({ x: { type: "number", minimum: 0, maximum: 1 }, xb: { type: "number", minimum: 0, maximum: 1 }, left: { type: "number", minimum: 0, maximum: 1 }, right: { type: "number", minimum: 0, maximum: 1 } }) })),
      signOutOfSites: action(
        "sign out of every site in the laptop's web pages (viewer panes and chat pages share one browser profile, kept across restarts): wipes its cookies, storage and cache and reloads the pages open, as Settings' Sign out of all sites. Only when Carl asks",
        "signOutOfSites",
      ),
      openChat: action('switch the chat pane to a chat (its id, "main", or "project-<slug>"), through the chat list\'s own open', "openChat", obj({ id: { type: "string" } }, ["id"])),
      newWindow: action("open a second vault-chat window (a New window, window 2) on this vault, as the title bar's New window button: the same box and chats, its own tiles (at most 4, the same rules), Files and Chats closed at first; open already: brought to the front. Then act in it with window: 2", "newWindow"),
      closeWindow: action("close a New window (window: 2, the default), as its own close button: its tiles are dropped and it does not come back at the next start", "closeWindow", obj({ window: { type: "integer", minimum: 2 } })),
      arrange: action("several of these in order: ops [{action, ...its args}]", "arrange", obj({ ops: { type: "array", items: { type: "object" } } }, ["ops"])),
    },
    watch: (fn) => {
      const offKept = onLayoutKept(fn);
      let offLog = () => {};
      try {
        offLog = signalLog(ctx.vault).onRecord((r) => {
          const s = (r as { signal?: Record<string, unknown> }).signal;
          if (s?.type === OFFER_EVENT && s.device !== "phone" && LAYOUT_PARTS.has(String(s.plugin)) && s.event !== "scrolled") fn();
        });
      } catch {
        /* no log for this vault: the acks alone */
      }
      return () => (offKept(), offLog());
    },
  };
}
