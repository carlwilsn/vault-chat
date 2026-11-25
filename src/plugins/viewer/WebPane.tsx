// A viewer pane holding a web page (src/webPane.ts): the title row (Back, Forward, Reload, the page's title and host,
// Open in browser, Close) and, under it, the page.
//
// The box's dev server (FrameWebPane): an iframe in the app's own page, so it moves, resizes and clips with the app
// like any element, and its own frames work. The box's proxy lets the app's origins frame it and puts in a script that
// posts the page's address and title here (server/devProxy.ts FRAME_SCRIPT); the pane keeps its own history from those
// (frameArrived), and Back / Forward / Reload replace the frame's page, so two panes never share the window's history.
//
// A public page (NativeWebPane): most sites refuse to be framed, so it is the desktop shell's native browser view
// (src-tauri/src/web_embed.rs) laid over the pane's body and kept on it as the pane moves, resizes or splits, hidden while the pane is hidden or something of
// the app's lies over it (a menu, a dialog): the same view and placement inline chat pages use (src/InlineWebPage.tsx).
// Carl's own navigation in the page becomes the pane's address (the store), so the workspace noun's state and watch
// follow it. Where no view can be made (not the desktop app, Linux, an address it refuses, an older shell for a dev
// server), the pane says why and links to the page.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useStore } from "../../store";
import { openUrl } from "../../opener";
import { followPlaceholder, inOrder, measure, native, nativeView, newId, useZoom } from "../../InlineWebPage";
import { displayHost, WEB_EMBED_EVENT, type ViewPlacer, type WebEmbedEvent } from "../../inlineWeb";
import type { WebPageSeen } from "../../layoutTypes";
import { boxDevUrl, embedKind, frameArrived, frameHistory, frameStep, paneKey, registerWebPane, type WebPageDo } from "../../webPane";

const iconBtn = "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40";

/** Why a native view can't be made here, before trying (null: try). */
function noViewWhy(url: string): string | null {
  const k = embedKind(url);
  if ("link" in k) return k.link;
  if (!native()) return "a web page shows in the viewer only in the Windows or macOS app";
  return null;
}

/** The box's dev server in an iframe; any other page in the native view (or a link). */
export function WebPane({ paneId, url }: { paneId?: string; url: string }) {
  return boxDevUrl(url) ? <FrameWebPane paneId={paneId} url={url} /> : <NativeWebPane paneId={paneId} url={url} />;
}

/** The pane's address becomes `to` (the page's own navigation, or Back / Forward): the store, so the noun follows. */
function useSetAddress(paneId: string | undefined, viewUrl: { current: string }) {
  return useCallback(
    (to: string) => {
      viewUrl.current = to;
      const s = useStore.getState();
      if (paneId) {
        if (s.panes.find((p) => p.id === paneId)?.file !== to) s.setPaneFile(paneId, to, "");
      } else if (s.currentFile !== to) s.setCurrentFile(to, "");
    },
    [paneId, viewUrl],
  );
}

/** The frame both kinds share: the pane, its title row, a note, and the body under them. */
function PaneShell(p: { paneId?: string; url: string; failed: string | null; loading: boolean; note: { text: string; url: string } | null; embedId?: string; act: (what: WebPageDo, other?: string) => Promise<void>; children: ReactNode }) {
  const { paneId, url, failed, loading, note, act } = p;
  const activePaneId = useStore((s) => s.activePaneId);
  const inSplit = useStore((s) => s.panes.length > 0);
  const title = useStore((s) => s.webTitles[url] ?? null);
  const isActive = paneId ? paneId === activePaneId : true;
  const close = () => {
    const s = useStore.getState();
    if (paneId) s.closePane(paneId);
    else s.setCurrentFile(null, "");
  };
  const activate = () => {
    if (paneId && !isActive) useStore.getState().setActivePane(paneId);
  };
  return (
    <div
      data-offer="box:workspace.focus"
      className={`h-full flex flex-col bg-background ${inSplit && isActive ? "ring-1 ring-primary/40 ring-inset" : ""}`}
      onClick={activate}
      onFocusCapture={activate}
      data-look-pane={paneId ?? "main"}
      data-file={url}
      data-web-page=""
      data-active={isActive ? "true" : "false"}
      data-embed-id={p.embedId}
    >
      <div data-look-skip className="flex items-center gap-2.5 px-4 py-2 border-b border-border/60 text-[11px] text-muted-foreground shrink-0" data-el="web-pane-bar">
        <button data-offer="box:workspace.webPage" type="button" className={iconBtn} onClick={() => void act("back")} title="Back" data-el="web-pane-back" disabled={!!failed}><ArrowLeft className="h-3.5 w-3.5" /></button>
        <button data-offer="box:workspace.webPage" type="button" className={iconBtn} onClick={() => void act("forward")} title="Forward" data-el="web-pane-forward" disabled={!!failed}><ArrowRight className="h-3.5 w-3.5" /></button>
        <button data-offer="box:workspace.webPage" type="button" className={iconBtn} onClick={() => void act("reload")} title="Reload" data-el="web-pane-reload" disabled={!!failed}><RotateCw className={`h-3.5 w-3.5 ${loading && !failed ? "animate-spin" : ""}`} /></button>
        <span className="truncate flex-1 min-w-0 font-mono" title={url} data-el="web-pane-title">
          {title ? <span className="text-foreground/90 font-sans">{title} </span> : null}
          <span className="opacity-70">{title ? "· " : ""}{displayHost(url)}</span>
        </span>
        <button data-offer="box:workspace.webPage" type="button" onClick={() => void act("browser")} className={iconBtn} data-el="web-pane-browser" title="Open in the browser"><ExternalLink className="h-3.5 w-3.5" /> Browser</button>
        <button data-offer="box:workspace.closePane" type="button" onClick={(e) => { e.stopPropagation(); close(); }} className={iconBtn} data-el="web-pane-close" title="Close the page"><X className="h-3.5 w-3.5" /></button>
      </div>
      {note && !failed && (
        <div className="flex items-center gap-2 px-4 py-0.5 border-b border-border/60 text-[11px] text-muted-foreground shrink-0" data-el="web-pane-note">
          <span className="truncate flex-1">{note.text}: {note.url}</span>
          <button data-offer="box:workspace.webPage" type="button" className={iconBtn} onClick={() => void act("browser", note.url)}>Open in browser</button>
        </div>
      )}
      {p.children}
    </div>
  );
}

/** What the box's proxy script posts from a framed dev page (server/devProxy.ts frameScript). */
type FrameReport =
  | { vcFrame: "at"; url: string; title?: string }
  | { vcFrame: "page"; url: string; title?: string; text?: unknown; textLength?: unknown; errors?: unknown; failed?: unknown };

/** A page report as the workspace noun shows it, bounded again here (the page is not trusted to keep the limits). */
function pageSeen(d: Extract<FrameReport, { vcFrame: "page" }>): WebPageSeen {
  const str = (x: unknown, n: number) => String(x ?? "").slice(0, n);
  const text = str(d.text, 8000);
  const errors = Array.isArray(d.errors) ? d.errors.slice(-20).map((e) => str(e, 400)) : [];
  const failed = Array.isArray(d.failed)
    ? d.failed.slice(-30).filter((f) => f && typeof f === "object").map((f: { status?: unknown; url?: unknown; how?: unknown }) => ({ status: Number(f.status) || 0, url: str(f.url, 300), ...(f.how ? { how: str(f.how, 140) } : {}) }))
    : [];
  const textLength = typeof d.textLength === "number" && d.textLength >= text.length ? d.textLength : text.length;
  return { text, textLength, errors, failed, at: new Date().toISOString() };
}

/** The box's dev server in the app's own page. */
function FrameWebPane({ paneId, url }: { paneId?: string; url: string }) {
  const key = paneKey(paneId);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const viewUrl = useRef(url);
  const hist = useRef(frameHistory(url));
  /** The pane just sent the frame somewhere: its next report is where that landed (a redirect replaces the entry). */
  const sent = useRef(true);
  const [src] = useState(url);
  const [loading, setLoading] = useState(true);
  const setAddress = useSetAddress(paneId, viewUrl);

  const go = useCallback((to: string) => {
    viewUrl.current = to;
    sent.current = true;
    setLoading(true);
    const f = frame.current;
    if (!f) return;
    try {
      // A parent may replace a child frame's page, cross-origin too; replace keeps the window's history out of it.
      f.contentWindow!.location.replace(to);
    } catch {
      f.src = to;
    }
  }, []);

  // Where the page is, from the proxy's script: the pane's address, history and title follow.
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const f = frame.current;
      const d = e.data as FrameReport | null;
      if (!f || e.source !== f.contentWindow || !d || (d.vcFrame !== "at" && d.vcFrame !== "page") || typeof d.url !== "string" || !boxDevUrl(d.url)) return;
      try {
        if (new URL(d.url).origin !== e.origin) return;
      } catch {
        return;
      }
      // What the page shows: kept by its address (the pane's), so the workspace noun's read carries it.
      if (d.vcFrame === "page") return void useStore.getState().setWebPage(d.url, pageSeen(d));
      hist.current = frameArrived(hist.current, d.url, sent.current);
      sent.current = false;
      setAddress(d.url);
      useStore.getState().setWebTitle(d.url, typeof d.title === "string" && d.title.trim() ? d.title : null);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [setAddress]);

  // A new address for this pane (the agent's openInPane / Show, not the page's own navigation): the frame goes there.
  useEffect(() => {
    if (url === viewUrl.current) return;
    hist.current = frameArrived(hist.current, url);
    go(url);
  }, [url, go]);

  const act = useCallback(
    async (what: WebPageDo, other?: string) => {
      if (what === "browser") {
        const to = other ?? viewUrl.current;
        await openUrl(to).catch(() => window.open(to, "_blank", "noopener"));
        return;
      }
      if (what === "reload") return go(viewUrl.current);
      const step = frameStep(hist.current, what === "back" ? -1 : 1);
      if (!step) return;
      hist.current = step.h;
      go(step.url);
      setAddress(step.url);
    },
    [go, setAddress],
  );
  useEffect(() => registerWebPane(key, { live: true, act }), [key, act]);

  return (
    <PaneShell paneId={paneId} url={url} failed={null} loading={loading} note={null} act={act}>
      <div className="relative flex-1 min-h-0 bg-background" data-el="web-pane-body">
        <iframe
          ref={frame}
          src={src}
          title={displayHost(url)}
          data-el="web-pane-frame"
          className="absolute inset-0 w-full h-full border-0"
          // Its own origin's scripts, storage and forms; it can't navigate the app or open windows.
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock"
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={() => {
            setLoading(false);
            // A page with no script (not HTML) never reports: the next load is Carl's own.
            setTimeout(() => { sent.current = false; }, 500);
          }}
        />
      </div>
    </PaneShell>
  );
}

/** A public page: the desktop shell's native browser view over the pane's body. */
function NativeWebPane({ paneId, url }: { paneId?: string; url: string }) {
  const key = paneKey(paneId);
  // Why there is no live view: decided by the address up front, or the shell's refusal of this address.
  const [runErr, setRunErr] = useState<{ url: string; why: string } | null>(null);
  const failed = noViewWhy(url) ?? (runErr && runErr.url === url ? runErr.why : null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ text: string; url: string } | null>(null);

  const idRef = useRef<string>(newId());
  const id = idRef.current;
  const body = useRef<HTMLDivElement | null>(null);
  /** Where the view is (its own navigation, or the address it was told to load). */
  const viewUrl = useRef(url);
  /** The native view, kept on this pane's own body (src/inlineWeb.ts viewPlacer). */
  const view = useRef<ViewPlacer | null>(null);
  if (!view.current) view.current = nativeView(id, () => viewUrl.current);

  const setAddress = useSetAddress(paneId, viewUrl);

  // The page's own reports: where it went (that becomes the pane's address), its title, a refused link or download.
  useEffect(() => {
    if (failed) return;
    let off: (() => void) | null = null;
    let gone = false;
    void listen<WebEmbedEvent>(WEB_EMBED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.id !== id) return;
      if (p.kind === "load") {
        setLoading(!!p.loading);
        if (p.loading) setNote(null);
        if (p.url && p.url !== "about:blank" && p.url !== viewUrl.current) setAddress(p.url);
      } else if (p.kind === "title") useStore.getState().setWebTitle(viewUrl.current, p.title ?? null);
      else if (p.kind === "blocked" && p.url) setNote({ text: "That link can't open here", url: p.url });
      else if (p.kind === "download" && p.url) setNote({ text: "Downloads open in the browser", url: p.url });
    }).then((u) => { if (gone) u(); else off = u; }).catch(() => undefined);
    return () => { gone = true; off?.(); };
  }, [id, failed, setAddress]);

  // Where the view goes: this pane's own body, measured when the call runs (never another pane's, never a layout
  // from before the split settled).
  const placeRef = useRef<() => void>(() => undefined);
  const zoom = useZoom(() => placeRef.current());
  const place = useCallback(() => {
    const el = body.current;
    const v = view.current;
    if (!el || !v || failed) return;
    const wasOpen = v.open;
    const sent = v.to(measure(el, zoom()));
    if (!wasOpen && v.open) sent?.catch((e: unknown) => setRunErr({ url: viewUrl.current, why: String(e instanceof Error ? e.message : e) }));
  }, [failed, zoom]);
  placeRef.current = place;

  // Follow the pane: opening, splitting and unsplitting, the split's divider, the window, scrolling, the other pane
  // changing kind, and a 200 ms tick for what fires no event (the pane moving without resizing, a menu over it).
  useEffect(() => (failed ? undefined : followPlaceholder(body.current, place)), [place, failed]);

  // A new address for this pane (the agent's openInPane / Show, not the page's own navigation): the view goes there,
  // keeping its history; a view of the other kind (public / dev server) is made again.
  useEffect(() => {
    if (url === viewUrl.current) return;
    viewUrl.current = url;
    const v = view.current;
    if (!v?.open) return;
    const reopen = () => {
      v.reset();
      void inOrder(id, () => invoke("web_embed_close", { id })).catch(() => undefined).then(() => place());
    };
    void inOrder(id, () => invoke("web_embed_go", { id, action: "load", url })).catch(reopen);
  }, [url, id, place]);

  // Leaving (the pane closed, another file in it, the viewer unmounted): the native view goes, after anything asked
  // of it before (a view still being made is closed once it exists).
  useEffect(() => () => void view.current?.close(), [id]);
  useEffect(() => {
    if (failed) void view.current?.close();
  }, [failed]);

  const act = useCallback(
    async (what: WebPageDo, other?: string) => {
      if (what === "browser") {
        const now = other ?? (view.current?.open ? await inOrder(id, () => invoke<string>("web_embed_url", { id })).catch(() => viewUrl.current) : viewUrl.current);
        await openUrl(now || viewUrl.current).catch(() => window.open(viewUrl.current, "_blank", "noopener"));
        return;
      }
      if (!view.current?.open) return;
      await inOrder(id, () => invoke("web_embed_go", { id, action: what })).catch(() => undefined);
    },
    [id],
  );
  useEffect(() => registerWebPane(key, { live: !failed, ...(failed ? { why: failed } : {}), act }), [key, failed, act]);

  return (
    <PaneShell paneId={paneId} url={url} failed={failed} loading={loading} note={note} act={act} embedId={failed ? undefined : id}>
      {/* The native view sits exactly over this element; what shows here is only seen while it loads, or as the link. */}
      <div ref={body} className="relative flex-1 min-h-0 bg-background" data-el="web-pane-body">
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-muted-foreground" data-el="web-pane-link">
            <Globe className="h-7 w-7 opacity-30" />
            <a data-offer="box:workspace.webPage" href={url} onClick={(e) => { e.preventDefault(); void act("browser"); }} className="underline underline-offset-2 hover:text-foreground break-all">{url}</a>
            <span data-el="web-pane-why">Opens in the browser: {failed}.</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground italic">Loading {displayHost(url)}…</div>
        )}
      </div>
    </PaneShell>
  );
}
