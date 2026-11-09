// A vault .html linked in a chat message, live and interactive in the bubble
// (src/inlineHtml.ts): a sandboxed srcdoc iframe (scripts, no same-origin, CSP:
// nothing from the network), sized to its content by its own reports, with an
// "Open full" overlay. The page's bytes come the way ChatImage's do (box
// conversation: the box's file route; local: the vault on disk).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, X } from "lucide-react";
import { useStore } from "./store";
import { readChatImage } from "./chatImage";
import { localPathFromUrl } from "./mdPipeline";
import { boxLinkFor, fetchBoxFile } from "./boxChat";
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

function Frame({ doc, title, full }: { doc: string; title: string; full?: boolean }) {
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
      className={full ? "w-full h-full border-0 bg-background" : "w-full block border-0 bg-background"}
      style={full ? undefined : { height: h }}
    />
  );
}

export const InlineHtmlFrame = memo(function InlineHtmlFrame({ src, alt }: { src: string; alt?: string }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const convId = useStore((s) => s.activeConversationId);
  const [state, setState] = useState<{ key: string; html: string | null; css: string } | null>(null);
  const [full, setFull] = useState(false);
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

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setFull(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  const live = state?.key === key ? state : null;
  const doc = useMemo(() => (live?.html != null ? inlineHtmlDocument(live.html, { css: live.css, theme: themeNow() }) : null), [live]);
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
  return (
    <span className="block my-2 rounded-md border border-border/60 overflow-hidden" data-el="chat-html-wrap">
      <span className="flex items-center gap-2 px-2 py-1 border-b border-border/60 bg-muted/40 text-[11px] text-muted-foreground">
        <span className="truncate flex-1" title={src}>{title}</span>
        <button type="button" onClick={() => setFull(true)} className="inline-flex items-center gap-1 hover:text-foreground" data-el="chat-html-full" title="Open full">
          <Maximize2 className="h-3 w-3" /> Open full
        </button>
      </span>
      <Frame doc={doc} title={title} />
      {full && createPortal(
        <div className="fixed inset-0 z-[1000] flex flex-col bg-background" data-el="chat-html-overlay">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground">
            <span className="truncate flex-1">{title}</span>
            <button type="button" onClick={() => setFull(false)} className="inline-flex items-center gap-1 hover:text-foreground" data-el="chat-html-close" title="Close (Esc)">
              <X className="h-3.5 w-3.5" /> Close
            </button>
          </div>
          <div className="flex-1 min-h-0"><Frame doc={doc} title={title} full /></div>
        </div>,
        document.body,
      )}
    </span>
  );
});
