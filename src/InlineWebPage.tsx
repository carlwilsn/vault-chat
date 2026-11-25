// A public web page linked in a chat message (`![label](https://…)`), live in the bubble on the laptop: a native
// browser view from the desktop shell (src-tauri/src/web_embed.rs) laid over the placeholder drawn here and kept on it
// as the chat scrolls and resizes (src/inlineWeb.ts). The title bar: Back, Forward, Reload, Full window, Open in
// browser, Close. Anywhere the native view cannot be made (not the desktop app, Linux, a refused address, an error),
// the label is a plain link that opens the page in the browser. A viewer pane holding a page (src/plugins/viewer/
// WebPane.tsx) uses the same view and the helpers exported here.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { inlineChanged, registerInlineFrame } from "./inlineFrames";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { openUrl } from "./opener";
import { defaultFrameHeight, parseFrameHint, frameHeight, HTML_MAX_H, HTML_MIN_FRAME_H } from "./inlineHtml";
import { downloadNote, startWebProfile } from "./webProfile";
import { displayHost, inOrder, nativeBounds, pickToRest, probePoints, publicWebUrl, viewPlacer, visibleBox, WEB_EMBED_EVENT, type Bounds, type Box, type ViewPlacer, type WebEmbedEvent } from "./inlineWeb";

export { inOrder, type Bounds };

/** A reloaded chat never leaves an earlier run's native views on screen: they are all closed before the first opens. */
let startOver: Promise<unknown> | null = null;
export const native = () => { try { return isTauri(); } catch { return false; } };
export function ready(): Promise<unknown> {
  if (!startOver) {
    startOver = native() ? invoke("web_embed_close", {}).catch(() => undefined) : Promise.resolve();
    // The views' downloads go to the vault open (src/webProfile.ts).
    startWebProfile();
  }
  return startOver;
}

/** The live views, for the cap (src/inlineWeb.ts MAX_LIVE_VIEWS): seen longest ago rests first. */
const live = new Map<string, { lastSeen: number; visible: boolean; rest: () => void }>();

let seq = 0;
export const newId = () => `w${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The native view `id` kept on its placeholder (src/inlineWeb.ts viewPlacer): made with `open` (web_embed_open, or the
 *  dev variant) at the address `url()` holds when the call runs. `onMoving`: hidden for a drag / resize, and back. */
export function nativeView(id: string, url: () => string, open = "web_embed_open", onMoving?: (moving: boolean) => void): ViewPlacer {
  return viewPlacer(id, {
    open: (b) => invoke(open, { id, url: url(), ...b }),
    place: (b) => invoke("web_embed_place", { id, ...b }),
    close: () => invoke("web_embed_close", { id }),
  }, ready, { onMoving });
}

/** Where the window's logical pixels are, per CSS pixel: the page zoom (devicePixelRatio over the window's scale
 *  factor, read again when the window's scale changes: another monitor). */
export function useZoom(onChange: () => void): () => number {
  const scale = useRef(0);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/window").then(async (m) => {
      const w = m.getCurrentWindow();
      const s = await w.scaleFactor();
      if (!alive) return;
      scale.current = s;
      cb.current();
      const u = await w.onScaleChanged((e) => { scale.current = e.payload.scaleFactor; cb.current(); });
      if (alive) off = u; else u();
    }).catch(() => undefined);
    return () => { alive = false; off?.(); };
  }, []);
  return useCallback(() => (window.devicePixelRatio || 1) / (scale.current || window.devicePixelRatio || 1), []);
}

/** Calls `place` whenever the placeholder `el` may have moved, as soon as the frame that moved it is drawn (a task
 *  right after it, not the next frame's requestAnimationFrame: the view's move leaves a frame earlier, and sees the
 *  layout settled, not the first pass of a panel opening): its size (ResizeObserver: a sash, a split, a panel, full
 *  screen), the window's size, any scroll. Something of the app's opening over it (a menu, Ctrl+K, Settings, a dialog): checked on
 *  the next frame after a key or a click and after the app adds or removes an element (at most every 50 ms), and
 *  again shortly after (a menu mounts a moment after the click that opens it). And a 200 ms tick for what fires none
 *  of these (a pane moving without resizing). */
export function followPlaceholder(el: HTMLElement | null, place: () => void, also?: () => void): () => void {
  let raf = 0;
  let late: ReturnType<typeof setTimeout> | null = null;
  let lastDom = 0;
  const run = () => { raf = 0; place(); };
  const soon = () => { if (!raf) raf = requestAnimationFrame(run); };
  let queued = false;
  const ch = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  if (ch) ch.port1.onmessage = () => { queued = false; place(); };
  const asap = () => {
    if (!ch) return soon();
    if (!queued) { queued = true; ch.port2.postMessage(0); }
  };
  /** Input or the DOM changed: maybe a menu or a dialog over the view. Next frame, and once more a little later. */
  const recheck = () => {
    soon();
    if (late) clearTimeout(late);
    late = setTimeout(() => { late = null; soon(); }, 120);
  };
  let domLater: ReturnType<typeof setTimeout> | null = null;
  const onDom = () => {
    const t = performance.now();
    if (t - lastDom >= 50) { lastDom = t; soon(); return; }
    // A streaming reply changes the DOM every frame: one check per 50 ms, the last change always checked.
    domLater ??= setTimeout(() => { domLater = null; lastDom = performance.now(); soon(); }, 50 - (t - lastDom));
  };
  const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { also?.(); asap(); }) : null;
  if (el) { ro?.observe(el); ro?.observe(document.body); }
  const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(onDom) : null;
  mo?.observe(document.body, { childList: true, subtree: true });
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("scroll", asap, opts);
  window.addEventListener("resize", asap);
  for (const k of ["pointerdown", "pointerup", "keydown", "keyup"] as const) window.addEventListener(k, recheck, opts);
  document.addEventListener("visibilitychange", soon);
  // The tick measures now, not on a frame: it keeps working while no frame comes.
  const tick = setInterval(place, 200);
  soon();
  return () => {
    cancelAnimationFrame(raf);
    if (late) clearTimeout(late);
    if (domLater) clearTimeout(domLater);
    ro?.disconnect();
    mo?.disconnect();
    ch?.port1.close();
    window.removeEventListener("scroll", asap, opts);
    window.removeEventListener("resize", asap);
    for (const k of ["pointerdown", "pointerup", "keydown", "keyup"] as const) window.removeEventListener(k, recheck, opts);
    document.removeEventListener("visibilitychange", soon);
    clearInterval(tick);
  };
}

function clipsOf(el: HTMLElement): Box[] {
  const out: Box[] = [];
  for (let node: HTMLElement = el, p = el.parentElement; p && p !== document.documentElement; node = p, p = p.parentElement) {
    // Past a fixed-position box (Full window), the ancestors' overflow no longer clips it.
    if (getComputedStyle(node).position === "fixed") break;
    const s = getComputedStyle(p);
    if (s.display === "contents") continue;
    if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
      const r = p.getBoundingClientRect();
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return out;
}

/** Where the view goes now: the visible part of the placeholder, hidden when it is off screen, under something, or
 *  the page is hidden. */
export function measure(el: HTMLElement, zoom: number): Bounds {
  const hide: Bounds = { x: 0, y: 0, width: 1, height: 1, visible: false };
  if (document.hidden || !el.isConnected) return hide;
  const r = el.getBoundingClientRect();
  const vis = visibleBox({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, clipsOf(el), { w: window.innerWidth, h: window.innerHeight });
  if (!vis) return hide;
  for (const [x, y] of probePoints(vis)) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !el.contains(hit)) return hide; // a menu, dialog or panel of the app lies over it
  }
  return { ...nativeBounds(vis, zoom), visible: true };
}

function PlainLink({ src, label, note }: { src: string; label: string; note?: string }) {
  return (
    <span className="block my-1" data-el="chat-web-link">
      <a data-offer="app/chat-rows.inline" href={src} onClick={(e) => { e.preventDefault(); void openUrl(src).catch(() => window.open(src, "_blank", "noopener")); }} className="underline underline-offset-2 hover:text-foreground" title={src}>{label}</a>
      {note ? <span className="ml-1.5 text-[11px] text-muted-foreground">{note}</span> : null}
    </span>
  );
}

const iconBtn = "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40";

function LiveWebPage({ src, label, sizeHint, onFail, onClose }: { src: string; label: string; sizeHint?: string; onFail: (why: string) => void; onClose: () => void }) {
  const idRef = useRef<string>(newId());
  const id = idRef.current;
  const body = useRef<HTMLSpanElement | null>(null);
  const [big, setBig] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  const [url, setUrl] = useState(src);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ text: string; url?: string } | null>(null);
  const [resting, setResting] = useState(false);
  const urlRef = useRef(src);
  urlRef.current = url;
  const view = useRef<ViewPlacer | null>(null);
  const [moving, setMoving] = useState(false);
  if (!view.current) view.current = nativeView(id, () => urlRef.current, "web_embed_open", setMoving);

  // The page's own reports: where it went, its title, a refused link or download.
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void listen<WebEmbedEvent>(WEB_EMBED_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.id !== id) return;
      if (p.kind === "load") { if (p.url) setUrl(p.url); setLoading(!!p.loading); if (p.loading) setNote(null); }
      else if (p.kind === "title") setTitle(p.title?.trim() || null);
      else if (p.kind === "blocked" && p.url) setNote({ text: "That link can't open here", url: p.url });
      else { const n = downloadNote(p); if (n) setNote(n); }
    }).then((u) => { if (gone) u(); else off = u; }).catch(() => undefined);
    return () => { gone = true; off?.(); };
  }, [id]);

  // The window's scale factor, to turn CSS pixels into the window's logical pixels when the app is zoomed.
  const placeRef = useRef<() => void>(() => undefined);
  const zoom = useZoom(() => placeRef.current());
  const place = useCallback(() => {
    const el = body.current;
    const v = view.current;
    if (!el || !v || resting) return;
    const b = measure(el, zoom());
    const entry = live.get(id);
    if (entry) { entry.visible = b.visible; if (b.visible) entry.lastSeen = Date.now(); }
    const wasOpen = v.open;
    const sent = v.to(b);
    if (wasOpen || !v.open) return;
    live.set(id, { lastSeen: Date.now(), visible: true, rest: () => setResting(true) });
    for (const k of pickToRest(live)) live.get(k)?.rest();
    sent?.catch((e: unknown) => {
      live.delete(id);
      onFail(String(e instanceof Error ? e.message : e));
    });
  }, [id, resting, onFail, zoom]);
  placeRef.current = place;

  // Follow the placeholder: scrolling (any ancestor), resizing, layout changes, and a slow tick for what fires no event
  // (a menu opening over it, a panel sliding in).
  useEffect(() => {
    if (resting) return;
    const el = body.current;
    if (el) setWidth(el.clientWidth);
    return followPlaceholder(el, place, () => { if (el) setWidth(el.clientWidth); });
  }, [place, resting]);

  // Resting (past the cap) or leaving the chat: the native view goes; resting keeps where it had got to.
  useEffect(() => {
    if (!resting) return;
    live.delete(id);
    void view.current?.close();
  }, [resting, id]);
  useEffect(() => () => {
    live.delete(id);
    void view.current?.close();
  }, [id]);
  // Esc leaves the full window (when the app has the keys; the page keeps its own).
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBig(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big]);

  const go = (action: "back" | "forward" | "reload") => void inOrder(id, () => invoke("web_embed_go", { id, action })).catch(() => undefined);
  const openOutside = async () => {
    const now = view.current?.open ? await inOrder(id, () => invoke<string>("web_embed_url", { id })).catch(() => urlRef.current) : urlRef.current;
    await openUrl(now || src).catch(() => undefined);
  };
  const close = () => {
    live.delete(id);
    void view.current?.close();
    onClose();
  };
  const startDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    const f = body.current;
    if (!f) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = f.getBoundingClientRect().height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDrag(Math.max(HTML_MIN_FRAME_H, Math.min(HTML_MAX_H, Math.round(h0 + ev.clientY - y0))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };

  const hint = parseFrameHint(sizeHint);
  const h = drag ?? (hint ? frameHeight({ width, vh: window.innerHeight, hint }) : defaultFrameHeight(width, window.innerHeight));

  // What it shows and its buttons, for app/chat-rows' inline state and action (src/inlineFrames.ts).
  const liveRef = useRef({ url, title, loading, big, resting, note, h, go, openOutside, close, setBig, setResting, setDrag });
  liveRef.current = { url, title, loading, big, resting, note, h, go, openOutside, close, setBig, setResting, setDrag };
  useEffect(
    () =>
      registerInlineFrame({
        id: `web:${id}`,
        kind: "web",
        state: () => {
          const l = liveRef.current;
          return { url: l.url, title: l.title, loading: l.loading, fullWindow: l.big, resting: l.resting, height: l.h, ...(l.note ? { note: l.note.text, ...(l.note.url ? { noteUrl: l.note.url } : {}) } : {}) };
        },
        act: {
          back: () => liveRef.current.go("back"),
          forward: () => liveRef.current.go("forward"),
          reload: () => liveRef.current.go("reload"),
          fullWindow: (a) => liveRef.current.setBig(a.on !== false),
          browser: () => liveRef.current.openOutside(),
          close: () => liveRef.current.close(),
          dismissNote: () => setNote(null),
          wake: () => liveRef.current.setResting(false),
          resize: (a) => liveRef.current.setDrag(Math.max(HTML_MIN_FRAME_H, Math.min(HTML_MAX_H, Math.round(Number(a.height))))),
        },
      }),
    [id],
  );
  useEffect(() => inlineChanged());
  const shownTitle = title || label;
  return (
    <span className={big ? "fixed inset-3 z-[60] flex flex-col rounded-md border border-border bg-background shadow-2xl overflow-hidden" : "block my-2 rounded-md border border-border/60 overflow-hidden"} data-el="chat-web-wrap" data-big={big ? "" : undefined} data-embed-id={id}>
      <span className="flex items-center gap-2 px-2 py-1 border-b border-border/60 bg-muted/40 text-[11px] text-muted-foreground shrink-0">
        <button data-offer="app/chat-rows.inline" type="button" className={iconBtn} onClick={() => go("back")} title="Back" data-el="chat-web-back" disabled={resting}><ArrowLeft className="h-3 w-3" /></button>
        <button data-offer="app/chat-rows.inline" type="button" className={iconBtn} onClick={() => go("forward")} title="Forward" data-el="chat-web-forward" disabled={resting}><ArrowRight className="h-3 w-3" /></button>
        <button data-offer="app/chat-rows.inline" type="button" className={iconBtn} onClick={() => go("reload")} title="Reload" data-el="chat-web-reload" disabled={resting}><RotateCw className={`h-3 w-3 ${loading && !resting ? "animate-spin" : ""}`} /></button>
        <span className="truncate flex-1 min-w-0" title={url} data-el="chat-web-title">
          <span className="text-foreground/90">{shownTitle}</span> <span className="opacity-70">· {displayHost(url)}</span>
        </span>
        <button data-offer="app/chat-rows.inline" type="button" onClick={() => setBig((v) => !v)} className={iconBtn} data-el="chat-web-big" title={big ? "Back to the chat (Esc)" : "Show the page over the whole window"}>
          {big ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />} {big ? "Smaller" : "Full window"}
        </button>
        <button data-offer="app/chat-rows.inline" type="button" onClick={() => void openOutside()} className={iconBtn} data-el="chat-web-browser" title="Open in the browser"><ExternalLink className="h-3 w-3" /> Browser</button>
        <button data-offer="app/chat-rows.inline" type="button" onClick={close} className={iconBtn} data-el="chat-web-close" title="Close the page (a link stays)"><X className="h-3 w-3" /></button>
      </span>
      {note && (
        <span className="flex items-center gap-2 px-2 py-0.5 border-b border-border/60 text-[11px] text-muted-foreground shrink-0" data-el="chat-web-note">
          <span className="truncate flex-1">{note.url ? `${note.text}: ${note.url}` : note.text}</span>
          {note.url ? <button data-offer="app/chat-rows.inline" type="button" className={iconBtn} onClick={() => void openUrl(note.url!).catch(() => undefined)}>Open in browser</button> : null}
          <button data-offer="app/chat-rows.inline" type="button" className={iconBtn} onClick={() => setNote(null)} title="Dismiss"><X className="h-3 w-3" /></button>
        </span>
      )}
      {/* The native view sits exactly over this element; what shows here is only seen while it loads or rests. */}
      <span ref={body} className={`relative block bg-background ${big ? "flex-1 min-h-0" : ""}`} style={big ? undefined : { height: h }} data-el="chat-web-body">
        {resting ? (
          <span className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
            <button data-offer="app/chat-rows.inline" type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setResting(false)} data-el="chat-web-wake">Show the page again</button>
          </span>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground italic">{moving ? displayHost(url) : `Loading ${displayHost(url)}…`}</span>
        )}
      </span>
      {!big && (
        <span className="block h-1.5 cursor-ns-resize bg-muted/40 hover:bg-muted border-t border-border/40 touch-none" data-el="chat-web-resize" title="Drag to resize" onPointerDown={startDrag} onDoubleClick={() => setDrag(null)} />
      )}
    </span>
  );
}

/** `![label](https://…)` for a page: live on the laptop's desktop app; a plain link anywhere else or when it fails. */
export const InlineWebPage = memo(function InlineWebPage({ src, alt, sizeHint }: { src: string; alt?: string; sizeHint?: string }) {
  const label = alt?.trim() || displayHost(src);
  const [state, setState] = useState<"live" | "closed" | { failed: string }>(() => (native() && publicWebUrl(src) ? "live" : { failed: "" }));
  const onFail = useCallback((why: string) => setState({ failed: why }), []);
  const onClose = useCallback(() => setState("closed"), []);
  if (state === "live") return <LiveWebPage src={src} label={label} sizeHint={sizeHint} onFail={onFail} onClose={onClose} />;
  if (state === "closed") {
    return (
      <ClosedWebPage src={src} label={label} onReopen={() => setState("live")} />
    );
  }
  return <PlainLink src={src} label={label} />;
});

/** A page Carl closed: its link, and "show here" (app/chat-rows inline reopen does the same). */
function ClosedWebPage({ src, label, onReopen }: { src: string; label: string; onReopen: () => void }) {
  const re = useRef(onReopen);
  re.current = onReopen;
  const id = useRef(`web:closed-${newId()}`).current;
  useEffect(() => registerInlineFrame({ id, kind: "web", state: () => ({ url: src, title: label, closed: true }), act: { reopen: () => re.current() } }), [id, src, label]);
  {
    return (
      <span className="block my-1" data-el="chat-web-closed">
        <PlainLink src={src} label={label} />
        <button type="button" className="ml-2 text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2" onClick={onReopen} data-el="chat-web-reopen" data-offer="app/chat-rows.inline">show here</button>
      </span>
    );
  }
}
