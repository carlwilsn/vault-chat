// Local resource paths in an HTML file, rewritten to asset:// URLs the
// webview can fetch (HtmlView renders via srcDoc, which has no base URL).
import { convertFileSrc } from "@tauri-apps/api/core";


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

// The iframe renders via srcDoc, which gives the document a null base URL —
// so relative resource paths (src="assets/x.png") have nothing to resolve
// against and silently fail to load, even though they work when the file is
// opened directly in a browser. Rewrite local relative/absolute paths to
// Tauri asset:// URLs the webview can fetch off disk. External URLs, data/
// blob URIs and in-page anchors are left untouched.
function toAssetUrl(raw: string, htmlPath: string): string {
  const url = raw.trim();
  if (!url) return raw;
  if (/^(https?:|data:|blob:|mailto:|tauri:|asset:|javascript:|#|\/\/)/i.test(url)) {
    return raw;
  }
  const cleaned = url.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
  const resolved = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)
    ? cleaned
    : resolveRelative(htmlPath, cleaned);
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
export function rewriteAssetUrls(html: string, htmlPath: string): string {
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/i);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return rewriteMarkupUrls(part, htmlPath);
      const open = part.match(/^<script\b[^>]*>/i)![0];
      return rewriteMarkupUrls(open, htmlPath) + part.slice(open.length);
    })
    .join("");
}

function rewriteMarkupUrls(html: string, htmlPath: string): string {
  // src="" / poster="" — a single resource URL each.
  let out = html.replace(
    /(\s(?:src|poster)\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (_m, pre: string, q: string, val: string) => `${pre}${q}${toAssetUrl(val, htmlPath)}${q}`,
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
          return toAssetUrl(u, htmlPath) + d;
        })
        .join(", ");
      return `${pre}${q}${rewritten}${q}`;
    },
  );
  return out;
}
