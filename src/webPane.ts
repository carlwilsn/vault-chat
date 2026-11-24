// A viewer pane can hold a web page instead of a vault file: a public site, or the agent's dev server through the box
// (server/devProxy.ts: https on the box's tailnet name). The pane's `file` (the store's panes / currentFile) is then
// the page's http(s) address, so everything that already places, swaps, closes and reports panes (src/paneLayout.ts,
// src/layoutOps.ts, the workspace noun) does it for pages too. The page is drawn by the desktop shell's native browser
// view laid over the pane (src/plugins/viewer/WebPane.tsx, the same view inline chat pages use, src/inlineWeb.ts);
// where that can't be made, the pane shows a link and why.
//
// This file: which addresses are pages and how each opens, putting one in a pane, and the live panes' buttons (Back,
// Forward, Reload, Open in browser) as one action the layout op `webPage` and the pane's own title row both call.
import { useStore } from "./store";
import { placeInPane, type PaneSide } from "./paneLayout";
import { publicWebUrl } from "./inlineWeb";

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

/** How a pane shows this address: a public page (web_embed_open), the box's dev server (web_embed_open_dev), or a
 *  link with the reason it can't be shown here. */
export function embedKind(url: string): { kind: "public" | "dev" } | { link: string } {
  if (publicWebUrl(url)) return { kind: "public" };
  if (boxDevUrl(url)) return { kind: "dev" };
  return { link: "only public pages and the agent's dev servers (opened through the box) show in the viewer" };
}

export type WebPageDo = "back" | "forward" | "reload" | "browser";
export const WEB_PAGE_DO: readonly WebPageDo[] = ["back", "forward", "reload", "browser"];

/** A web pane on screen: its buttons, and whether a live view is behind them (false: the pane shows a link). */
export type WebPaneHandle = { live: boolean; why?: string; act(what: WebPageDo, url?: string): Promise<void> };
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
export async function webPageAct(what: WebPageDo, side?: PaneSide, url?: string): Promise<{ ok: boolean; note?: string; error?: string }> {
  if (!WEB_PAGE_DO.includes(what)) return { ok: false, error: `webPage do is ${WEB_PAGE_DO.join(", ")}, not "${String(what)}"` };
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
  await h.act(what);
  return { ok: true };
}
