// A vault .html linked in a chat message, live and interactive in the bubble
// (src/inlineHtml.ts): a sandboxed srcdoc iframe (scripts, no same-origin, CSP:
// nothing from the network), sized to its content by its own reports, with an
// "Open in viewer" control (the page opens in the file viewer like any file). The page's bytes come the way ChatImage's do (box
// conversation: the box's file route; local: the vault on disk).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Minimize2, PanelRight } from "lucide-react";
import { useStore } from "./store";
import { readChatImage } from "./chatImage";
import { localPathFromUrl } from "./mdPipeline";
import { boxLinkFor, fetchBoxFile } from "./boxChat";
import { insideVault, parseLiveMount } from "./liveBridge";
import { PluginMount } from "./PluginMount";
import { PluginOff } from "./PluginOff";
import { usePluginDesired } from "./pluginSupervisorApp";
import { isNewestEmbed, newestEmbed, registerEmbed, subscribeEmbeds } from "./inlineEmbeds";
import { changedRev, useChangedFiles } from "./liveReload";
import { appPageTheme, PAGE_FRAME_ATTR } from "./pageTheme";
import { embedRelativeImages, joinPagePath, relativeImageRefs, frameHeight, inlineHtmlCollapses, inlineHtmlDocument, inlineHtmlReport, parseFrameHint, parseFrameHintFromHtml, HTML_MAX_H, HTML_MIN_FRAME_H, type FrameHint, type FrameReport } from "./inlineHtml";

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

/** The frame's height (src/inlineHtml.ts frameHeight): the page's request (meta / markdown title), else a 16:10 default
 *  that a full-height page keeps and a short content-sized page shrinks from; a drag overrides all of it. */
function useFrameHeight(frame: React.RefObject<HTMLIFrameElement | null>, hint: FrameHint | null, drag: number | null): number {
  const [report, setReport] = useState<FrameReport | null>(null);
  const [width, setWidth] = useState(0);
  const [vh, setVh] = useState(() => window.innerHeight);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const r = inlineHtmlReport(e.data);
      if (r) setReport(r);
    };
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("message", onMsg);
    window.addEventListener("resize", onResize);
    const el = frame.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setWidth(el.clientWidth)) : null;
    if (el) { ro?.observe(el); setWidth(el.clientWidth); }
    return () => { window.removeEventListener("message", onMsg); window.removeEventListener("resize", onResize); ro?.disconnect(); };
  }, [frame]);
  return drag ?? frameHeight({ width, vh, report, hint });
}

const focusFrame = (f: HTMLIFrameElement | null) => { f?.focus(); try { f?.contentWindow?.focus(); } catch { /* sandboxed: the page focuses itself on click */ } };

function Frame({ doc, title, live, hint, big, drag }: { doc: string; title: string; live?: string; hint: FrameHint | null; big: boolean; drag: number | null }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const h = useFrameHeight(ref, hint, drag);
  return (
    <iframe
      ref={ref}
      srcDoc={doc}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-el="chat-html"
      {...{ [PAGE_FRAME_ATTR]: "" }}
      {...(live ? { "data-vc-live": live } : {})}
      className={`w-full block border-0 bg-background ${big ? "flex-1 min-h-0" : ""}`}
      style={big ? undefined : { height: h }}
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

function LiveInlineHtml({ src, alt, sizeHint }: { src: string; alt?: string; sizeHint?: string }) {
  const [big, setBig] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const convId = useStore((s) => s.activeConversationId);
  // Collapse only while chat and the viewer showing this file are on screen together (inlineHtmlCollapses).
  const inViewer = useStore((s) => {
    const path = viewerPath(src, s.vaultPath);
    return inlineHtmlCollapses(s, samePath(s.currentFile, path) || s.panes.some((p) => samePath(p.file, path)));
  });
  const [state, setState] = useState<{ key: string; html: string | null; css: string } | null>(null);
  const key = JSON.stringify([src, vaultPath, convId]);
  // The page changed under us (an edit saved in the viewer, the agent's write, a box sync): re-read it, once the
  // writes settle. The previous page stays on screen meanwhile and the frame keeps its height, so it is one quiet reload.
  const rev = useChangedFiles((s) => changedRev(s, viewerPath(src, vaultPath)));
  // The viewer's own copy of this page (an unsaved or just-saved edit there), the freshest there is.
  const shown = useStore((s) => {
    const path = viewerPath(src, s.vaultPath);
    const pane = s.panes.find((p) => samePath(p.file, path));
    return pane ? pane.content : samePath(s.currentFile, path) ? s.currentContent : null;
  });
  useEffect(() => {
    if (shown === null) return;
    const t = setTimeout(() => setState((st) => (st && st.html !== shown ? { ...st, html: shown } : st)), 400);
    return () => clearTimeout(t);
  }, [shown]);

  useEffect(() => {
    let cancelled = false;
    const wait = rev ? 300 : 0;
    const timer = setTimeout(() => void (async () => {
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
      let html = page ? new TextDecoder().decode(new Uint8Array(page.bytes)) : null;
      if (html) {
        // Relative images (a photo viewer's files beside the page) become data: URIs: the frame's CSP loads nothing else.
        const dir = cleaned.replace(/[?#].*$/, "").split("/").slice(0, -1).join("/");
        const imgs = new Map<string, ArrayLike<number>>();
        const io = { local: (path: string) => invoke<number[]>("read_binary_file", { path }), box: async () => { const link = await boxLinkFor(vaultPath); return link ? (path: string) => (convId ? fetchBoxFile(link, path, convId) : Promise.resolve(null)) : null; } };
        await Promise.all(relativeImageRefs(html).map(async (ref) => {
          const at = joinPagePath(dir, ref);
          const r = at === null ? null : await readChatImage(at, vaultPath, files, io).catch(() => null);
          if (r) imgs.set(ref, r.bytes);
        }));
        if (cancelled) return;
        html = embedRelativeImages(html, imgs);
      }
      // A failed re-read keeps the page that is showing; an identical one changes nothing.
      setState((st) => (st && st.key === key && (html === null || st.html === html) ? st : { key, html, css }));
    })(), wait);
    return () => { cancelled = true; clearTimeout(timer); };
    // `files` only helps a local chat find a moved file; a new index is not a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rev]);

  // A page in the vault (a relative path, no ..) may be a live page (src/liveBridge.ts): it needs a manifest too.
  const pagePath = (() => { const p = localPathFromUrl(src); return insideVault(p, vaultPath) ? p : null; })();
  const live = state?.key === key ? state : null;
  const doc = useMemo(() => (live?.html != null ? inlineHtmlDocument(live.html, { css: live.css, theme: themeNow(), pageTheme: appPageTheme(), live: pagePath !== null }) : null), [live, pagePath]);
  const name = src.split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? src;
  const title = alt || name;
  // A vault page is a plugin: stopped by the supervisor (src/pluginSupervisorApp.ts), its copy here is taken down too.
  const desired = usePluginDesired(pagePath);
  if (pagePath !== null && desired.state === "stopped") {
    return (
      <span className="block my-2 rounded-md border border-border/60 bg-muted/40" data-el="chat-html-wrap">
        <PluginOff path={pagePath} desired={desired} />
      </span>
    );
  }

  if (!live) return <span className="block text-[11.5px] text-muted-foreground italic" data-el="chat-html-loading">Loading {name}…</span>;
  if (doc === null) {
    return (
      <span className="text-muted-foreground italic text-[11.5px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block">
        ⚠ page not found: {src}{alt ? ` (${alt})` : ""}
      </span>
    );
  }
  // Chat and viewer both showing this file: one live copy, not two. Closing the file or hiding either side brings the inline page back.
  if (inViewer) {
    return (
      <button type="button" onClick={() => openInViewer(src, live.html ?? "", vaultPath)} className="flex items-center gap-1.5 my-2 px-2 py-1 rounded-md border border-border/60 bg-muted/40 text-[11.5px] text-muted-foreground hover:text-foreground max-w-full" data-el="chat-html-in-viewer" title="Bring it to the front in the viewer">
        <PanelRight className="h-3 w-3 shrink-0" /> <span className="truncate">Open in viewer: {name}</span>
      </button>
    );
  }
  const inProcess = live.html != null && parseLiveMount(live.html) === "in-process";
  const hint = parseFrameHint(sizeHint) ?? parseFrameHintFromHtml(live.html ?? "");
  const toggleBig = () => {
    setBig((v) => !v);
    // The same element stays mounted (only its layout changes), so the page keeps its state; give it the keys.
    setTimeout(() => focusFrame(wrapRef.current?.querySelector("iframe") ?? null), 0);
  };
  const startDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    const f = wrapRef.current?.querySelector("iframe");
    if (!f) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = f.getBoundingClientRect().height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDrag(Math.max(HTML_MIN_FRAME_H, Math.min(HTML_MAX_H, Math.round(h0 + ev.clientY - y0))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  return (
    <span ref={wrapRef} className={big ? "fixed inset-3 z-[60] flex flex-col rounded-md border border-border bg-background shadow-2xl overflow-hidden" : "block my-2 rounded-md border border-border/60 overflow-hidden"} data-el="chat-html-wrap" data-big={big ? "" : undefined}>
      <span className="flex items-center gap-2 px-2 py-1 border-b border-border/60 bg-muted/40 text-[11px] text-muted-foreground shrink-0">
        <span className="truncate flex-1" title={src}>{title}</span>
        {!inProcess && <span className="hidden sm:inline opacity-70 whitespace-nowrap" data-el="chat-html-hint">Click the page, then use the keyboard</span>}
        {!inProcess && <button type="button" onClick={toggleBig} className="inline-flex items-center gap-1 hover:text-foreground" data-el="chat-html-larger" title={big ? "Back to the chat" : "Show the page large"}>
          {big ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />} {big ? "Smaller" : "Larger"}
        </button>}
        <button type="button" onClick={() => openInViewer(src, live.html ?? "", vaultPath)} className="inline-flex items-center gap-1 hover:text-foreground" data-el="chat-html-viewer" title="Open in the viewer">
          <PanelRight className="h-3 w-3" /> Open in viewer
        </button>
      </span>
      {inProcess ? (
        // A page that declares an in-process mount runs in the app itself (src/mountHost.ts), not in a frame.
        <PluginMount html={live.html ?? ""} path={pagePath ?? localPathFromUrl(src)} className="block bg-background" />
      ) : (
        <Frame doc={doc} title={title} live={pagePath ?? undefined} hint={hint} big={big} drag={drag} />
      )}
      {!big && !inProcess && (
        <span className="block h-1.5 cursor-ns-resize bg-muted/40 hover:bg-muted border-t border-border/40 touch-none" data-el="chat-html-resize" title="Drag to resize" onPointerDown={startDrag} onDoubleClick={() => setDrag(null)} />
      )}
    </span>
  );
}

/** One live copy of a file in the feed: the newest embed is live (follows edits and the theme); older embeds of the same
 *  file are a static row that jumps to the live one. */
export const InlineHtmlFrame = memo(function InlineHtmlFrame({ src, alt, sizeHint }: { src: string; alt?: string; sizeHint?: string }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const file = viewerPath(src, vaultPath);
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => (ref.current ? registerEmbed(file, ref.current) : undefined), [file]);
  const newest = useSyncExternalStore(subscribeEmbeds, () => isNewestEmbed(file, ref.current));
  const name = src.split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? src;
  return (
    <span ref={ref} className="block" data-el="chat-html-embed">
      {newest ? (
        <LiveInlineHtml src={src} alt={alt} sizeHint={sizeHint} />
      ) : (
        <button type="button" onClick={() => newestEmbed(file)?.scrollIntoView({ block: "center", behavior: "smooth" })} className="flex items-center gap-1.5 my-2 px-2 py-1 rounded-md border border-border/60 bg-muted/40 text-[11.5px] text-muted-foreground hover:text-foreground max-w-full" data-el="chat-html-older" title="A newer copy of this page is further down: that one is live">
          <PanelRight className="h-3 w-3 shrink-0" /> <span className="truncate">{alt || name} · older version, go to the latest</span>
        </button>
      )}
    </span>
  );
});
