// A vault .html linked in a chat message, live and interactive in the bubble
// (src/inlineHtml.ts): a sandboxed srcdoc iframe (scripts, no same-origin, CSP:
// nothing from the network), sized to its content by its own reports, with an
// "Open in viewer" control (the page opens in the file viewer like any file). The page's bytes come the way ChatImage's do (box
// conversation: the box's file route; local: the vault on disk).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PanelRight } from "lucide-react";
import { useStore } from "./store";
import { readChatImage } from "./chatImage";
import { localPathFromUrl } from "./mdPipeline";
import { boxLinkFor, fetchBoxFile } from "./boxChat";
import { insideVault } from "./liveBridge";
import { HTML_DEFAULT_H, inlineHtmlDocument, inlineHtmlHeight } from "./inlineHtml";

let appStyles: Promise<string> | null = null;

/** The running app's own stylesheet, as text, with its latin Inter/JetBrains faces as data: URLs
 *  (the frame's CSP allows fonts only from data:). Read once per app run. */
export function appStylesText(): Promise<string> {
  if (appStyles) return appStyles;
  appStyles = (async () => {
    const parts: string[] = [];
    const fonts: Promise<string>[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSFontFaceRule) {
          if (/url\(["']?data:/.test(rule.cssText)) { parts.push(rule.cssText); continue; }
          const m = /url\(["']?([^"')]+-latin-\d+-normal[^"')]*\.woff2)["']?\)/.exec(rule.cssText);
          if (!m) continue;
          const href = new URL(m[1]!, sheet.href ?? location.href).href;
          fonts.push(fetch(href).then((r) => r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))).then((b) => new Promise<string>((ok) => {
            const fr = new FileReader();
            fr.onload = () => ok(rule.cssText.replace(/src:[^;}]+/, `src: url(${String(fr.result)}) format("woff2")`));
            fr.onerror = () => ok("");
            fr.readAsDataURL(b);
          })).catch(() => ""));
          continue;
        }
        parts.push(rule.cssText);
      }
    }
    return [...(await Promise.all(fonts)), ...parts].join("\n");
  })();
  return appStyles;
}

const themeNow = () => (document.documentElement.dataset.theme === "light" ? "light" : "graphite");

function useFittedHeight(frame: React.RefObject<HTMLIFrameElement | null>): number {
  const [h, setH] = useState(HTML_DEFAULT_H);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const v = inlineHtmlHeight(e.data);
      if (v !== null) setH(v);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [frame]);
  return h;
}

function Frame({ doc, title, live }: { doc: string; title: string; live?: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const h = useFittedHeight(ref);
  return (
    <iframe
      ref={ref}
      srcDoc={doc}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-el="chat-html"
      {...(live ? { "data-vc-live": live } : {})}
      className="w-full block border-0 bg-background"
      style={{ height: h }}
    />
  );
}

/** The vault path the viewer knows this page by. */
function viewerPath(src: string, vault: string | null): string {
  const cleaned = localPathFromUrl(src).replace(/^\.\/+/, "");
  const absolute = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned);
  return absolute || !vault ? cleaned : `${vault}${vault.includes("\\") ? "\\" : "/"}${cleaned}`;
}

const samePath = (a: string | null | undefined, b: string) => !!a && a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/** The page opens in the file viewer like a file clicked in the tree (HtmlView renders it live); fullscreen chat leaves
 *  fullscreen, which has no viewer. `html`: the bytes the chat already read (box or disk). */
function openInViewer(src: string, html: string, vault: string | null): void {
  const path = viewerPath(src, vault);
  const st = useStore.getState();
  if (st.chatFullscreen) st.toggleChatFullscreen();
  // Already open in a pane: bring that pane forward instead of loading the page a second time.
  const pane = st.panes.find((p) => samePath(p.file, path));
  if (pane) st.setActivePane(pane.id);
  else st.setCurrentFile(path, html);
}

export const InlineHtmlFrame = memo(function InlineHtmlFrame({ src, alt }: { src: string; alt?: string }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const convId = useStore((s) => s.activeConversationId);
  const inViewer = useStore((s) => {
    const path = viewerPath(src, s.vaultPath);
    return samePath(s.currentFile, path) || s.panes.some((p) => samePath(p.file, path));
  });
  const [state, setState] = useState<{ key: string; html: string | null; css: string } | null>(null);
  const key = JSON.stringify([src, vaultPath, convId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cleaned = localPathFromUrl(src);
      const [page, css] = await Promise.all([
        readChatImage(cleaned, vaultPath, files, {
          local: (path) => invoke<number[]>("read_binary_file", { path }),
          box: async () => {
            const link = await boxLinkFor(vaultPath);
            return link ? (path) => (convId ? fetchBoxFile(link, path, convId) : Promise.resolve(null)) : null;
          },
        }).catch(() => null),
        appStylesText().catch(() => ""),
      ]);
      if (cancelled) return;
      setState({ key, html: page ? new TextDecoder().decode(new Uint8Array(page.bytes)) : null, css });
    })();
    return () => { cancelled = true; };
    // `files` only helps a local chat find a moved file; a new index is not a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A page in the vault (a relative path, no ..) may be a live page (src/liveBridge.ts): it needs a manifest too.
  const pagePath = (() => { const p = localPathFromUrl(src); return insideVault(p, vaultPath) ? p : null; })();
  const live = state?.key === key ? state : null;
  const doc = useMemo(() => (live?.html != null ? inlineHtmlDocument(live.html, { css: live.css, theme: themeNow(), live: pagePath !== null }) : null), [live, pagePath]);
  const name = src.split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? src;
  const title = alt || name;

  if (!live) return <span className="block text-[11.5px] text-muted-foreground italic" data-el="chat-html-loading">Loading {name}…</span>;
  if (doc === null) {
    return (
      <span className="text-muted-foreground italic text-[11.5px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block">
        ⚠ page not found: {src}{alt ? ` (${alt})` : ""}
      </span>
    );
  }
  // Open in the viewer: one live copy, not two. Closing the file there brings the inline page back.
  if (inViewer) {
    return (
      <button type="button" onClick={() => openInViewer(src, live.html ?? "", vaultPath)} className="flex items-center gap-1.5 my-2 px-2 py-1 rounded-md border border-border/60 bg-muted/40 text-[11.5px] text-muted-foreground hover:text-foreground max-w-full" data-el="chat-html-in-viewer" title="Bring it to the front in the viewer">
        <PanelRight className="h-3 w-3 shrink-0" /> <span className="truncate">Open in viewer: {name}</span>
      </button>
    );
  }
  return (
    <span className="block my-2 rounded-md border border-border/60 overflow-hidden" data-el="chat-html-wrap">
      <span className="flex items-center gap-2 px-2 py-1 border-b border-border/60 bg-muted/40 text-[11px] text-muted-foreground">
        <span className="truncate flex-1" title={src}>{title}</span>
        <button type="button" onClick={() => openInViewer(src, live.html ?? "", vaultPath)} className="inline-flex items-center gap-1 hover:text-foreground" data-el="chat-html-viewer" title="Open in the viewer">
          <PanelRight className="h-3 w-3" /> Open in viewer
        </button>
      </span>
      <Frame doc={doc} title={title} live={pagePath ?? undefined} />
    </span>
  );
});
