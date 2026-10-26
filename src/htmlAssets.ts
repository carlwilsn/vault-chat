// How a vault HTML page (rendered by HtmlView as a sandboxed srcdoc iframe,
// which has no address of its own) finds its own files.
//
// The way: a <base href> at the page's folder on the app's `vcpage` protocol
// (src-tauri/src/vault_page.rs, the open vault only). With it the browser
// resolves every relative URL the normal way, whoever builds it: markup,
// CSS url(), and URLs a script makes at run time (`new Audio('clip.mp3')`,
// `fetch('data.json')`) — exactly as the file opened from its folder.
// The markup rewrite below is left for what a base cannot cover: absolute
// local paths, and a page outside the vault (or a host with no protocol).
import { convertFileSrc } from "@tauri-apps/api/core";

export const PAGE_SCHEME = "vcpage";

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The page's folder as a vcpage URL ("…/0/Physics%20135/"), or null when the page is not inside the vault. */
export function pageBaseUrl(rootIndex: number, vaultRoot: string, htmlPath: string): string | null {
  const root = slashes(vaultRoot);
  const file = slashes(htmlPath);
  // Windows paths compare case-insensitively ("c:\Users" vs "C:\Users").
  const fold = (s: string) => (/^[a-zA-Z]:/.test(root) ? s.toLowerCase() : s);
  if (!root || !fold(file).startsWith(fold(root) + "/")) return null;
  const dir = file.slice(root.length + 1).split("/").slice(0, -1);
  if (dir.some((seg) => !seg || seg === "." || seg === "..")) return null;
  const origin = convertFileSrc(String(rootIndex), PAGE_SCHEME).replace(/\/+$/, "");
  return origin + "/" + dir.map((seg) => encodeURIComponent(seg) + "/").join("");
}

/** Put `<base href>` first in the head, unless the page sets its own base. */
export function withBase(html: string, href: string): string {
  if (/<base\b[^>]*\bhref\s*=/i.test(html)) return html;
  const tag = `<base href="${href.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// Resolve a relative path against the directory of `baseFile`.
// Mirrors MarkdownView's resolveRelative.
export function resolveRelative(baseFile: string, rel: string): string {
  const sep = baseFile.includes("\\") ? "\\" : "/";
  const baseParts = baseFile.slice(0, baseFile.lastIndexOf(sep)).split(sep);
  const relParts = rel.replace(/^\.\/+/, "").split(/[\/\\]/);
  for (const p of relParts) {
    if (p === "..") baseParts.pop();
    else if (p && p !== ".") baseParts.push(p);
  }
  return baseParts.join(sep);
}

// Local paths in the markup rewritten to Tauri asset:// URLs: absolute ones
// always, relative ones only for a page with no base (outside the vault, or
// a host without the vcpage protocol). External URLs, data/blob URIs and
// in-page anchors are left untouched.
function toAssetUrl(raw: string, htmlPath: string, relative = true): string {
  const url = raw.trim();
  if (!url) return raw;
  if (/^(https?:|data:|blob:|mailto:|tauri:|asset:|javascript:|#|\/\/)/i.test(url)) {
    return raw;
  }
  const cleaned = url.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
  const absolute = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned);
  // A page with a base (pageBaseUrl) resolves its relative URLs itself.
  if (!absolute && !relative) return raw;
  const resolved = absolute ? cleaned : resolveRelative(htmlPath, cleaned);
  try {
    return convertFileSrc(resolved);
  } catch {
    return raw;
  }
}

// Rewrite only the markup: the text inside <script>…</script> is code, and a
// string in it like `src="'+x+'"` must never be touched (a single-file built
// app broke on exactly that). Opening tags are still rewritten, so
// <script src="local.js"> keeps working.
// `relative: false` (the page has a base): absolute local paths only.
export function rewriteAssetUrls(html: string, htmlPath: string, relative = true): string {
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/i);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return rewriteMarkupUrls(part, htmlPath, relative);
      const open = part.match(/^<script\b[^>]*>/i)![0];
      return rewriteMarkupUrls(open, htmlPath, relative) + part.slice(open.length);
    })
    .join("");
}

function rewriteMarkupUrls(html: string, htmlPath: string, relative: boolean): string {
  // src="" / poster="" — a single resource URL each.
  let out = html.replace(
    /(\s(?:src|poster)\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (_m, pre: string, q: string, val: string) => `${pre}${q}${toAssetUrl(val, htmlPath, relative)}${q}`,
  );
  // srcset="" — comma-separated "url [descriptor]" candidates.
  out = out.replace(
    /(\ssrcset\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (_m, pre: string, q: string, val: string) => {
      const rewritten = val
        .split(",")
        .map((cand) => {
          const t = cand.trim();
          if (!t) return cand;
          const sp = t.indexOf(" ");
          const u = sp === -1 ? t : t.slice(0, sp);
          const d = sp === -1 ? "" : t.slice(sp);
          return toAssetUrl(u, htmlPath, relative) + d;
        })
        .join(", ");
      return `${pre}${q}${rewritten}${q}`;
    },
  );
  return out;
}
