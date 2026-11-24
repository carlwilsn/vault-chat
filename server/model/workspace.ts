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
import { keptLayout, layoutTool, onLayoutKept } from "../layoutTool";
import type { ActResult, Noun, NounAction } from "./index";

/** How fresh a read-back must be to answer without asking the laptop again (an action's own ack, just now). */
const FRESH_MS = 2_000;
/** The laptop's layout events (src/offerHistory.ts → offer.event records): a change Carl made by hand. */
const LAYOUT_PARTS = new Set(["app/viewer", "app/chats", "app/titlebar", "app/chat"]);

const when = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
const PANE = { type: "string", enum: ["left", "right"], description: "left or right (stacked: left is the top)" };
const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export type WorkspaceCtx = { vault: string; emit?: (ev: Record<string, unknown>) => void; ackMs?: number; dev?: (port: number) => Promise<{ origin: string } | { error: string }> };

export function workspaceNoun(ctx: WorkspaceCtx): Noun {
  const run = (op: string) => async (a: Record<string, unknown>): Promise<ActResult> => {
    if (!ctx.emit) return { ok: false, text: "this box has no link to the laptop here; nothing changed." };
    const args = op === "arrange" ? { ops: a.ops } : { action: op, ...a };
    const r = await layoutTool({ vault: ctx.vault, emit: ctx.emit, ackMs: ctx.ackMs, dev: ctx.dev, brief: true }, args);
    return { ok: r.ok, text: r.text };
  };
  const action = (description: string, op: string, args = obj()): NounAction => ({ description, args, run: run(op) });
  return {
    id: "workspace",
    name: "Workspace",
    state: {
      layout: {
        description:
          "Carl's laptop screen, read back from it: panes and their files or web pages (url and title; Carl's own navigation shows here) (split, side-by-side or stacked, the active pane), the left panel (file tree) open, the chat panel open / full screen / popped out, its sidebar, the open chat when known, window and column sizes; when the laptop is away, the last read-back and since when",
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
    },
    actions: {
      openLeftPanel: action("open the left panel (the file tree)", "openLeftPanel"),
      closeLeftPanel: action("close the left panel (the file tree)", "closeLeftPanel"),
      openRightPanel: action("open the chat panel", "openRightPanel"),
      closeRightPanel: action("close the chat panel", "closeRightPanel"),
      closePane: action("close one pane of the split (back to one file); with no split, leave pane out to close the one file or page", "closePane", obj({ pane: PANE })),
      openInPane: action(
        "put a vault file (path + pane) or a web page (url; pane left out: in place of the active pane's) in a pane, turning the split on when one other is open; a pane already on a page goes to the url. A url http://localhost:<port> is your StartJob dev server, through the box. To open a file at a place, use Show",
        "openInPane",
        obj({ path: { type: "string", description: "vault-relative" }, url: { type: "string", description: "http(s)" }, pane: PANE }),
      ),
      webPage: action("the web page in a pane (left out: the active one), as its title row's buttons: back, forward, reload, or browser (opens it, or url, in his browser)", "webPage", obj({ do: { type: "string", enum: ["back", "forward", "reload", "browser"] }, pane: PANE, url: { type: "string" } }, ["do"])),
      split: action("turn the split on or off (off keeps the active pane)", "split", obj({ on: { type: "boolean" } }, ["on"])),
      focus: action("focus a pane or the chat", "focus", obj({ target: { type: "string", enum: ["left", "right", "chat"] } }, ["target"])),
      fullscreenChat: action("full-screen chat on or off", "fullscreenChat", obj({ on: { type: "boolean" } }, ["on"])),
      chatSidebar: action("the chat list beside full-screen chat, open or closed", "chatSidebar", obj({ open: { type: "boolean" } }, ["open"])),
      resize: action("set the columns' widths as dragging the sashes does: leftPanel (the file tree) and/or chat, in pixels; the viewer takes the rest", "resize", obj({ leftPanel: { type: "number", minimum: 0 }, chat: { type: "number", minimum: 0 } })),
      openChat: action('switch the chat pane to a chat (its id, "main", or "project-<slug>"), through the chat list\'s own open', "openChat", obj({ id: { type: "string" } }, ["id"])),
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
