// Pinned apps (Track 2): a vault .html page that declares `<meta name="vc-pinned">` is an app. It starts when the app
// launches, stays mounted and running while Carl uses the app (hidden when not in front, its state kept), and a
// launcher brings it to the front in its own pane (src/PinnedApps.tsx). The declaration is the one source of truth:
// the page-header toggle edits it in the page, so the catalog (src/pluginCatalog.ts) lists the same apps from the
// vault. Pages are fully trusted. Shared by the app and the box: no imports.

const PINNED_META = /<meta\b[^>]*\bname\s*=\s*["']?vc-pinned["']?(?=[\s>/"'])[^>]*>\s*/gi;

/** Whether the page declares itself a pinned app (`content="false"`/"no"/"0" says it does not). */
export function parsePinned(html: string): boolean {
  for (const m of String(html ?? "").matchAll(new RegExp(PINNED_META.source, "gi"))) {
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[0]);
    const word = (c?.[1] ?? c?.[2] ?? c?.[3] ?? "").trim().toLowerCase();
    if (!["false", "no", "0", "off"].includes(word)) return true;
  }
  return false;
}

/** The page with the declaration added (once) or removed. */
export function setPinned(html: string, pinned: boolean): string {
  const bare = html.replace(PINNED_META, "");
  if (!pinned) return bare;
  const tag = '<meta name="vc-pinned">\n';
  const head = /<head\b[^>]*>\s*/i.exec(bare);
  if (head) return bare.slice(0, head.index + head[0].length) + tag + bare.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>\s*/i.exec(bare);
  if (doctype) return bare.slice(0, doctype[0].length) + tag + bare.slice(doctype[0].length);
  return tag + bare;
}

/** Fired on window when a page was pinned or unpinned (the launcher reloads its list). */
export const PINNED_CHANGED_EVENT = "vc-pinned-changed";
