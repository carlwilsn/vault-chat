// Stage 1.7 of the plugin refactor: a page's own link. The box serves a vault .html page at /p/<id>/ (id = its vault
// path, the same plugin id its state is kept under: server/liveProxy.ts) so it opens in a plain browser tab, the phone's
// included, with the same `vc` it has in the viewer and the chat.
//
// The link is a small shell around the page: the page itself is the same sandboxed srcdoc the chat shows inline
// (src/inlineHtml.ts: scripts, no same-origin, no network), and the shell's script is the host (src/pageLinkHost.ts:
// the live-page bridge, src/liveBridge.ts, posting to this box's /api/v2/live/* routes). Grant, token and gateway are
// the ones every other host uses; the link adds no service and no route of its own besides the shell.
//
// Identity: the link opens only for a person `tailscale serve` names (Tailscale-User-Login, an allowed login:
// server/auth.ts tailnetIdentity). A request without it is refused, from loopback or with a phone token too.
// Exposure: the box's existing serve mapping (https://<box>.<tailnet>.ts.net/ → the box's port) already carries /p/;
// nothing is added to `tailscale serve`. Another vault on the box: /p/<id>/?vault=<name>.
import { readFileSync, statSync } from "node:fs";
import HOST_JS from "vc:page-link-host";
import { withinVault } from "./phoneData";
import { appCss } from "./appCss";
import { APP_STYLES_HREF, inlineHtmlDocument, isHtmlSrc } from "../src/inlineHtml";

export const PAGE_LINK_PREFIX = "/p/";
/** The largest page the link serves (as a live page's manifest reads at most). */
const MAX_BYTES = 8 * 1024 * 1024;

/** The page a link names: its vault path from /p/<id>[/] (each segment percent-encoded), else null. */
export function pageLinkId(pathname: string): string | null {
  if (!pathname.startsWith(PAGE_LINK_PREFIX)) return null;
  const segs = pathname.slice(PAGE_LINK_PREFIX.length).replace(/\/$/, "").split("/");
  const out: string[] = [];
  for (const s of segs) {
    let d: string;
    try {
      d = decodeURIComponent(s);
    } catch {
      return null;
    }
    if (!d || d === "." || d === ".." || /[\\/\u0000-\u001f]/.test(d)) return null;
    out.push(d);
  }
  const id = out.join("/");
  return out.length && isHtmlSrc(id) ? id : null;
}

/** A page's link, as Carl opens it: `/p/<id>/` (and `?vault=<name>` for a vault that is not the box's main one). */
export function pageLinkHref(id: string, vault?: string | null): string {
  return `${PAGE_LINK_PREFIX}${id.split("/").map(encodeURIComponent).join("/")}/${vault ? `?vault=${encodeURIComponent(vault)}` : ""}`;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The shell a link answers with, or why not. `vault`: the vault's folder; `vaultName`: its name, when not the main one. */
export function pageLinkDocument(vault: string, id: string, vaultName: string | null): { status: number; html?: string; error?: string } {
  const full = withinVault(vault, id);
  if (!full) return { status: 404, error: "no such page" };
  let html: string;
  try {
    if (statSync(full).size > MAX_BYTES) return { status: 413, error: "page too large" };
    html = readFileSync(full, "utf8");
  } catch {
    return { status: 404, error: "no such page" };
  }
  const title = id.split("/").pop()!.replace(/\.html?$/i, "");
  // The page as the chat shows it inline, in the device's theme (the host script follows it and tells the page).
  const page = inlineHtmlDocument(html, { css: appCss(), live: true });
  const shell =
    `<!doctype html><html data-theme="dark"${vaultName ? ` data-vc-vault="${attr(vaultName)}"` : ""}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${attr(title)}</title>` +
    `<link rel="stylesheet" href="${APP_STYLES_HREF}">` +
    `<style>html,body{margin:0;height:100%;overflow:hidden;background:hsl(var(--background))}iframe{display:block;border:0;width:100%;height:100%}</style>` +
    `</head><body><iframe sandbox="allow-scripts" allow="autoplay" title="${attr(title)}" data-vc-live="${attr(id)}" srcdoc="${attr(page)}"></iframe>` +
    `<script data-vc-link-host>${HOST_JS}</script></body></html>`;
  return { status: 200, html: shell };
}
