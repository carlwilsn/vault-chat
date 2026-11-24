// A viewer pane holding a web page (src/webPane.ts): the title row (Back, Forward, Reload, the page's title and host,
// Open in browser, Close) and, under it, the desktop shell's native browser view (src-tauri/src/web_embed.rs) laid over
// the pane's body and kept on it as the pane moves, resizes or splits, hidden while the pane is hidden or something of
// the app's lies over it (a menu, a dialog): the same view and placement inline chat pages use (src/InlineWebPage.tsx).
// Carl's own navigation in the page becomes the pane's address (the store), so the workspace noun's state and watch
// follow it. Where no view can be made (not the desktop app, Linux, an address it refuses, an older shell for a dev
// server), the pane says why and links to the page.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useStore } from "../../store";
import { openUrl } from "../../opener";
import { inOrder, measure, native, newId, ready, type Bounds } from "../../InlineWebPage";
import { displayHost, sameBounds, WEB_EMBED_EVENT, type WebEmbedEvent } from "../../inlineWeb";
import { embedKind, paneKey, registerWebPane, type WebPageDo } from "../../webPane";

const iconBtn = "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40";

/** Why a view can't be made here, before trying (null: try). */
function noViewWhy(url: string): string | null {
  if (!native()) return "a web page shows in the viewer only in the Windows or macOS app";
  const k = embedKind(url);
  return "link" in k ? k.link : null;
}

export function WebPane({ paneId, url }: { paneId?: string; url: string }) {
  const key = paneKey(paneId);
  const activePaneId = useStore((s) => s.activePaneId);
  const inSplit = useStore((s) => s.panes.length > 0);
  const title = useStore((s) => s.webTitles[url] ?? null);
  const isActive = paneId ? paneId === activePaneId : true;
  // Why there is no live view: decided by the address up front, or the shell's refusal of this address.
  const [runErr, setRunErr] = useState<{ url: string; why: string } | null>(null);
  const failed = noViewWhy(url) ?? (runErr && runErr.url === url ? runErr.why : null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ text: string; url: string } | null>(null);

  const idRef = useRef<string>(newId());
  const id = idRef.current;
  const body = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  const last = useRef<Bounds | null>(null);
  /** Where the view is (its own navigation, or the address it was told to load). */
  const viewUrl = useRef(url);
  const scale = useRef(0);

  const setAddress = useCallback(
    (to: string) => {
      viewUrl.current = to;
      const s = useStore.getState();
      if (paneId) {
        if (s.panes.find((p) => p.id === paneId)?.file !== to) s.setPaneFile(paneId, to, "");
      } else if (s.currentFile !== to) s.setCurrentFile(to, "");
    },
    [paneId],
  );

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

  const place = useCallback(() => {
    const el = body.current;
    if (!el || failed) return;
    const zoom = (window.devicePixelRatio || 1) / (scale.current || window.devicePixelRatio || 1);
    const b = measure(el, zoom);
    if (!opened.current) {
      if (!b.visible) return; // made the first time it is seen
      opened.current = true;
      last.current = b;
      const k = embedKind(viewUrl.current);
      const cmd = "kind" in k && k.kind === "dev" ? "web_embed_open_dev" : "web_embed_open";
      void ready().then(() => inOrder(id, () => invoke(cmd, { id, url: viewUrl.current, ...b }))).catch((e: unknown) => {
        opened.current = false;
        const msg = String(e instanceof Error ? e.message : e);
        const at = viewUrl.current;
        setRunErr({ url: at, why: cmd === "web_embed_open_dev" && /not found|unknown|not allowed|denied/i.test(msg) ? "dev servers show in the viewer from the next app update (Install & restart); until then it opens in the browser" : msg });
      });
      return;
    }
    if (sameBounds(last.current, b)) return;
    last.current = b;
    void inOrder(id, () => invoke("web_embed_place", { id, ...b })).catch(() => undefined);
  }, [id, failed]);

  useEffect(() => {
    let alive = true;
    void import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().scaleFactor()).then((s) => { if (alive) { scale.current = s; place(); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [place]);

  // Follow the pane: resizing, splitting, layout changes, and a slow tick for what fires no event (a menu over it).
  useEffect(() => {
    if (failed) return;
    let raf = 0;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
    const el = body.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(soon) : null;
    if (el) { ro?.observe(el); ro?.observe(document.body); }
    window.addEventListener("scroll", soon, true);
    window.addEventListener("resize", soon);
    document.addEventListener("visibilitychange", soon);
    const tick = setInterval(soon, 200);
    soon();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("scroll", soon, true);
      window.removeEventListener("resize", soon);
      document.removeEventListener("visibilitychange", soon);
      clearInterval(tick);
    };
  }, [place, failed]);

  // A new address for this pane (the agent's openInPane / Show, not the page's own navigation): the view goes there,
  // keeping its history; a view of the other kind (public / dev server) is made again.
  useEffect(() => {
    if (url === viewUrl.current) return;
    const was = viewUrl.current;
    viewUrl.current = url;
    if (!opened.current) return;
    const k0 = embedKind(was), k1 = embedKind(url);
    const sameKind = "kind" in k0 && "kind" in k1 && k0.kind === k1.kind;
    const reopen = () => {
      opened.current = false;
      last.current = null;
      void inOrder(id, () => invoke("web_embed_close", { id })).catch(() => undefined).then(() => place());
    };
    if (!sameKind) return reopen();
    void inOrder(id, () => invoke("web_embed_go", { id, action: "load", url })).catch(reopen);
  }, [url, id, place]);

  // Leaving (the pane closed, another file in it, the viewer unmounted): the native view goes.
  useEffect(() => () => {
    if (opened.current) void inOrder(id, () => invoke("web_embed_close", { id })).catch(() => undefined);
    opened.current = false;
  }, [id]);
  useEffect(() => {
    if (!failed || !opened.current) return;
    opened.current = false;
    void inOrder(id, () => invoke("web_embed_close", { id })).catch(() => undefined);
  }, [failed, id]);

  const act = useCallback(
    async (what: WebPageDo, other?: string) => {
      if (what === "browser") {
        const now = other ?? (opened.current ? await inOrder(id, () => invoke<string>("web_embed_url", { id })).catch(() => viewUrl.current) : viewUrl.current);
        await openUrl(now || viewUrl.current).catch(() => window.open(viewUrl.current, "_blank", "noopener"));
        return;
      }
      if (!opened.current) return;
      await inOrder(id, () => invoke("web_embed_go", { id, action: what })).catch(() => undefined);
    },
    [id],
  );
  useEffect(() => registerWebPane(key, { live: !failed, ...(failed ? { why: failed } : {}), act }), [key, failed, act]);

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
      data-look-pane={paneId ?? "main"}
      data-file={url}
      data-web-page=""
      data-active={isActive ? "true" : "false"}
      data-embed-id={failed ? undefined : id}
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
    </div>
  );
}
