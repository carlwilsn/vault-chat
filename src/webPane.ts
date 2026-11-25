// A viewer pane can hold a web page instead of a vault file: a public site, or the agent's dev server through the box
// (server/devProxy.ts: https on the box's tailnet name). The pane's `file` (the store's panes / currentFile) is then
// the page's http(s) address, so everything that already places, swaps, closes and reports panes (src/paneLayout.ts,
// src/layoutOps.ts, the workspace noun) does it for pages too. A public page is drawn by the desktop shell's native
// browser view laid over the pane (most sites refuse to be framed; the same view inline chat pages use, src/inlineWeb.ts).
// The box's dev server is an iframe in the app's own page (its proxy lets the app frame it and reports where the page
// is: server/devProxy.ts FRAME_SCRIPT), so it moves and resizes with the app and its own frames work. Where neither can
// be made, the pane shows a link and why (src/plugins/viewer/WebPane.tsx).
//
// This file: which addresses are pages and how each opens, putting one in a pane, and the live panes' buttons (Back,
// Forward, Reload, Open in browser) as one action the layout op `webPage` and the pane's own title row both call.
import { useStore } from "./store";
import { placeInPane, type PaneSide } from "./paneLayout";
import { publicWebUrl } from "./inlineWeb";
import { driveOpFor, pickOf, type DriveOp } from "./webDrive";

/** A pane's content is a web page when its `file` is an http(s) address. */
export const isWebAddress = (s: string | null | undefined): s is string => typeof s === "string" && /^https?:\/\//i.test(s.trim());

/** The agent's dev server through the box's tailnet proxy: https, no credentials, a `*.ts.net` name (the same rule as
 *  web_embed.rs box_dev_url, which decides). */
export function boxDevUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return false; }
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  return u.protocol === "https:" && !u.username && !u.password && host.endsWith(".ts.net") && host.length > ".ts.net".length;
}

/** How a pane shows this address: a public page (the native view, web_embed_open), the box's dev server (an iframe),
 *  or a link with the reason it can't be shown here. */
export function embedKind(url: string): { kind: "public" | "dev" } | { link: string } {
  if (publicWebUrl(url)) return { kind: "public" };
  if (boxDevUrl(url)) return { kind: "dev" };
  return { link: "only public pages and the agent's dev servers (opened through the box) show in the viewer" };
}

/** An iframe pane's own history (the app can't read a cross-origin frame's): where the page has been, and where it is.
 *  Back / Forward replace the frame's page with the entry beside it, so panes never share the window's history. */
export type FrameHistory = { stack: string[]; at: number };
export const frameHistory = (url: string): FrameHistory => ({ stack: [url], at: 0 });
/** The page says it is at `url`. `replacing`: the pane just sent it somewhere (a redirect lands elsewhere: that entry
 *  becomes where it landed). Otherwise Carl went there: one step back / forward when it is the entry beside, else a
 *  new entry after this one (any forward entries go, as in a browser). */
export function frameArrived(h: FrameHistory, url: string, replacing = false): FrameHistory {
  const cur = h.stack[h.at];
  if (cur === url) return h;
  if (replacing) return { stack: h.stack.map((u, i) => (i === h.at ? url : u)), at: h.at };
  if (h.stack[h.at - 1] === url) return { ...h, at: h.at - 1 };
  if (h.stack[h.at + 1] === url) return { ...h, at: h.at + 1 };
  return { stack: [...h.stack.slice(0, h.at + 1), url], at: h.at + 1 };
}
/** One step back (-1) or forward (1): the new history and the address to load, or null at the end. */
export function frameStep(h: FrameHistory, by: -1 | 1): { h: FrameHistory; url: string } | null {
  const url = h.stack[h.at + by];
  return url === undefined ? null : { h: { ...h, at: h.at + by }, url };
}

export type WebPageDo = "back" | "forward" | "reload" | "browser";
export const WEB_PAGE_DO: readonly WebPageDo[] = ["back", "forward", "reload", "browser"];
/** What the agent (and Select) do inside a public page (src/webDrive.ts). */
export type WebDriveDo = "read" | "click" | "type" | "scroll" | "select";
export const WEB_DRIVE_DO: readonly WebDriveDo[] = ["read", "click", "type", "scroll", "select"];

/** A web pane on screen: its buttons, and whether a live view is behind them (false: the pane shows a link). A public
 *  page's pane can also be driven: drive runs one step of the page script, read reads the page into the store (the
 *  workspace noun's panes[].page; settled: after the page had a moment, and its load, to answer a step), pick turns
 *  Select on (Carl clicks an element) or off. */
export type WebPaneHandle = {
  live: boolean;
  why?: string;
  act(what: WebPageDo, url?: string): Promise<void>;
  drive?: (op: DriveOp) => Promise<Record<string, unknown>>;
  read?: (settled?: boolean) => Promise<void>;
  pick?: (on: boolean) => Promise<void>;
};

/** Panes whose Select is on (waiting for Carl's click on the page), by pane key: the workspace noun reads it. */
const picking = new Set<string>();
export const isPicking = (key: string) => picking.has(key);
export function setPickingPane(key: string, on: boolean): void {
  if (on) picking.add(key);
  else picking.delete(key);
}
const handles = new Map<string, WebPaneHandle>();
/** A pane's key: its id in a split, "main" for the one viewer. */
export const paneKey = (paneId: string | null | undefined) => paneId ?? "main";
export function registerWebPane(key: string, h: WebPaneHandle): () => void {
  handles.set(key, h);
  return () => {
    if (handles.get(key) === h) handles.delete(key);
  };
}
export const webPaneHandle = (key: string): WebPaneHandle | null => handles.get(key) ?? null;

/** The pane a side means now (a split's left / right; with no split, the one viewer), and the address it holds. */
export function paneAt(side?: PaneSide): { key: string; file: string | null; paneId: string | null } | { error: string } {
  const s = useStore.getState();
  if (s.panes.length >= 2) {
    const p = side ? s.panes[side === "left" ? 0 : 1] : s.panes.find((x) => x.id === s.activePaneId) ?? s.panes[0];
    return p ? { key: paneKey(p.id), file: p.file, paneId: p.id } : { error: "no such pane" };
  }
  return { key: paneKey(null), file: s.currentFile, paneId: null };
}

/** The side a pane is on, for the agent's own actions (undefined: no split, the one viewer). */
export function paneSideOf(paneId: string | null | undefined): PaneSide | undefined {
  const s = useStore.getState();
  if (!paneId || s.panes.length < 2) return undefined;
  const i = s.panes.findIndex((p) => p.id === paneId);
  return i === 0 ? "left" : i === 1 ? "right" : undefined;
}

/** Put a web page in the viewer: in the `pane` side (turning the split on when one other thing is open, as a file
 *  does), or in place of what the active pane shows. A page already there only becomes the active pane. */
export function openWebInPane(url: string, pane?: PaneSide): { landed: string } {
  const st = useStore.getState();
  // The viewer must be on screen: the full-screen chat has none.
  if (st.chatFullscreen) st.toggleChatFullscreen();
  if (pane) {
    const r = placeInPane(pane, url, "");
    const split = useStore.getState().panes.length >= 2;
    return { landed: `${r.opened ? "opened" : "showing"} ${url}${split ? ` in the ${pane} pane` : " (alone: a split needs a second file or page)"}` };
  }
  const s = useStore.getState();
  const active = s.panes.length >= 2 ? s.panes.find((p) => p.id === s.activePaneId)?.file : s.currentFile;
  if (active === url) return { landed: `${url} is open (it already was)` };
  s.setCurrentFile(url, "");
  return { landed: `opened ${url} in the viewer` };
}

/** Back / Forward / Reload / Open in browser on the page in a pane (the title row's buttons, the layout op webPage).
 *  `url` with browser: another address (a link the page could not open here) instead of the page's own. */
export async function webPageAct(what: WebPageDo | WebDriveDo, side?: PaneSide, url?: string, args: DriveArgs = {}): Promise<{ ok: boolean; note?: string; error?: string }> {
  if (!WEB_PAGE_DO.includes(what as WebPageDo) && !WEB_DRIVE_DO.includes(what as WebDriveDo)) return { ok: false, error: `webPage do is ${[...WEB_PAGE_DO, ...WEB_DRIVE_DO].join(", ")}, not "${String(what)}"` };
  const at = paneAt(side);
  if ("error" in at) return { ok: false, error: at.error };
  if (!isWebAddress(at.file)) return { ok: false, error: `${side ? `the ${side} pane` : "the viewer"} shows ${at.file ? "a file" : "nothing"}, not a web page` };
  const h = webPaneHandle(at.key);
  if (what === "browser") {
    if (url !== undefined && !isWebAddress(url)) return { ok: false, error: "url must be an http(s) address" };
    if (h) await h.act("browser", url);
    else await (await import("./opener")).openUrl(url ?? at.file);
    return { ok: true, note: `opened ${url ?? at.file} in the browser` };
  }
  if (!h || !h.live) return { ok: false, error: `the page in ${side ? `the ${side} pane` : "the viewer"} is a link here, not a live view${h?.why ? ` (${h.why})` : ""}` };
  if (WEB_DRIVE_DO.includes(what as WebDriveDo)) return drivePage(h, what as WebDriveDo, args, at.file);
  await h.act(what as WebPageDo);
  return { ok: true };
}

export type DriveArgs = { ref?: unknown; text?: unknown; value?: unknown; enter?: unknown; by?: unknown };

/** One step inside a public page, then the page read again (the noun's panes[].page carries it back). */
async function drivePage(h: WebPaneHandle, what: WebDriveDo, a: DriveArgs, pageUrl: string): Promise<{ ok: boolean; note?: string; error?: string }> {
  if (!h.drive || !h.read || !h.pick) return { ok: false, error: "only a public page's view can be driven; a dev server's page is read from its own report (panes[].page)" };
  try {
    if (what === "read") {
      await h.read();
      return { ok: true };
    }
    if (what === "select") {
      if (a.ref === undefined && a.text === undefined) {
        await h.pick(true);
        return { ok: true, note: "Select is on: Carl clicks an element on the page and it goes to the composer as a chip (Esc stops)" };
      }
      const op = driveOpFor("click", a);
      if (typeof op === "string") return { ok: false, error: op.replace("click", "select") };
      const ans = await h.drive({ ...op, op: "describe" } as DriveOp);
      const p = pickOf(ans.picked, pageUrl);
      if (!p) return { ok: false, error: String(ans.error ?? "the page did not describe it") };
      // The composer's draft, loaded when used (a static import would cycle through the box chat).
      (await import("./plugins/composer/draft")).addPick(p);
      return { ok: true, note: `selected ${p.ref} <${p.tag}> "${p.label}": a chip in the composer` };
    }
    const op = driveOpFor(what, a);
    if (typeof op === "string") return { ok: false, error: op };
    const ans = await h.drive(op);
    if (ans.error) return { ok: false, error: String(ans.error) };
    await h.read(true);
    return { ok: true, note: String(ans.did ?? what) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What was typed in a pane's address bar, as the address to open: an http(s) address as it is; one word with a dot
 *  (or localhost), as a host, gets https://; anything else is a web search. Null: nothing typed. */
export function addressFor(typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^(localhost|[^/?#.]+(\.[^/?#.]+)*\.[a-z]{2,})(:\d+)?([/?#]|$)/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** A pane's address bar: Enter goes to what was typed, through the agent's own openInPane {url, pane} (the side the
 *  pane is on in a split; with none, the one viewer). Returns where it landed, or null when nothing was typed. */
export function openTyped(typed: string, paneId?: string | null): string | null {
  const to = addressFor(typed);
  if (!to) return null;
  const s = useStore.getState();
  const idx = paneId && s.panes.length >= 2 ? s.panes.findIndex((p) => p.id === paneId) : -1;
  return openWebInPane(to, idx === 0 ? "left" : idx === 1 ? "right" : undefined).landed;
}
