import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FileText, ZoomIn, ZoomOut, BoxSelect } from "lucide-react";
import { cn } from "./lib/utils";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";
import { useStore } from "./store";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const BASE_RENDER_SCALE = 1.5;

function clampZoom(z: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

export function PdfView({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Full plain-text dump of the PDF, used as ask-mode context when
  // nothing is selected (or as the "before"/"after" pool when the user
  // has a text-layer selection).
  const fullTextRef = useRef<string>("");
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);
  const [marqueeOn, setMarqueeOn] = useState(false);
  // Current drag state for the marquee rectangle. Stored as client-space
  // pixels. Null when no drag is active.
  const [marquee, setMarquee] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Ctrl+M fires a `vc-marquee-toggle` window event from the top-level
  // keydown handler; each marquee-capable viewer listens and flips its
  // local state.
  useEffect(() => {
    const onToggle = () => setMarqueeOn((v) => !v);
    window.addEventListener("vc-marquee-toggle", onToggle);
    return () => window.removeEventListener("vc-marquee-toggle", onToggle);
  }, []);

  // Watch for a pending scroll request (e.g. "open anchor" from the
  // Notes panel). Gated on !loading so the page wrappers are in the
  // DOM with their final heights — otherwise scrollIntoView lands on
  // a position that shifts as later wrappers append. Targets the
  // pdf-page-wrap (always present after load, even before the canvas
  // for that page has rendered under virtualization) rather than the
  // canvas itself.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  const clearScrollAnchor = useStore((s) => s.clearScrollAnchor);
  useEffect(() => {
    if (loading) return;
    if (!pendingScrollAnchor) return;
    if (pendingScrollAnchor.path !== path) return;
    const pageMatch = pendingScrollAnchor.anchor.match(/page=(\d+)/);
    if (!pageMatch) return;
    const target = pageMatch[1];
    const id = requestAnimationFrame(() => {
      const wrap = hostRef.current?.querySelector<HTMLDivElement>(
        `.pdf-page-wrap[data-page="${target}"]`,
      );
      if (wrap) {
        wrap.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      clearScrollAnchor();
    });
    return () => cancelAnimationFrame(id);
  }, [pendingScrollAnchor, path, loading, clearScrollAnchor]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    fullTextRef.current = "";
    setLoading(true);
    setError(null);
    setPages(0);
    setZoom(1);

    // Virtualized rendering: build empty page wrappers up front so the
    // scroll height is correct, then lazily render canvas + text-layer
    // for pages near the viewport via IntersectionObserver. Pages that
    // scroll far away get torn down to free GPU/RAM. Without this, a
    // 350-page book would render every canvas at startup (~6 GB on
    // hi-DPI screens) and lock the UI for tens of seconds.
    type PageProxy = {
      getViewport: (opts: { scale: number }) => { width: number; height: number };
      render: (opts: {
        canvas: HTMLCanvasElement;
        viewport: { width: number; height: number };
        transform: [number, number, number, number, number, number];
      }) => { promise: Promise<void>; cancel(): void };
      getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      cleanup: () => void;
    };
    type PageState = {
      page: PageProxy;
      fitScale: number;
      displayViewport: { width: number; height: number };
      renderViewport: { width: number; height: number };
      rendered: boolean;
      renderTask: { promise: Promise<void>; cancel(): void } | null;
    };

    let doc: { destroy: () => void; numPages: number; getPage(n: number): Promise<PageProxy> } | null = null;
    const wrappers: HTMLDivElement[] = [];
    const pageStates: PageState[] = [];
    let renderObserver: IntersectionObserver | null = null;
    let teardownObserver: IntersectionObserver | null = null;

    const renderPage = async (idx: number) => {
      if (cancelled) return;
      const state = pageStates[idx];
      const wrap = wrappers[idx];
      if (!state || !wrap || state.rendered || state.renderTask) return;

      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(state.renderViewport.width * dpr);
      canvas.height = Math.floor(state.renderViewport.height * dpr);
      canvas.style.width = `${state.displayViewport.width}px`;
      canvas.style.height = `${state.displayViewport.height}px`;
      canvas.className = "pdf-page shadow-md rounded";
      canvas.dataset.page = String(idx + 1);
      wrap.appendChild(canvas);

      const transform: [number, number, number, number, number, number] =
        dpr === 1 ? [1, 0, 0, 1, 0, 0] : [dpr, 0, 0, dpr, 0, 0];
      const task = state.page.render({
        canvas,
        viewport: state.renderViewport,
        transform,
      });
      state.renderTask = task;
      try {
        await task.promise;
      } catch {
        // RenderingCancelledException — page was torn down mid-render.
        state.renderTask = null;
        return;
      }
      state.renderTask = null;
      if (cancelled) return;

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "pdf-text-layer";
      textLayerDiv.style.setProperty("--scale-factor", String(state.fitScale));
      wrap.appendChild(textLayerDiv);

      const textContent = await state.page.getTextContent();
      if (cancelled) return;

      const TL = (pdfjs as unknown as {
        TextLayer?: new (o: {
          textContentSource: typeof textContent;
          container: HTMLElement;
          viewport: typeof state.displayViewport;
        }) => { render: () => Promise<void> };
      }).TextLayer;
      if (TL) {
        const layer = new TL({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: state.displayViewport,
        });
        try {
          await layer.render();
        } catch {
          /* layer cancelled — ignore */
        }
      } else {
        const legacy = (pdfjs as unknown as {
          renderTextLayer?: (o: {
            textContentSource: typeof textContent;
            container: HTMLElement;
            viewport: typeof state.displayViewport;
          }) => { promise: Promise<void> };
        }).renderTextLayer;
        if (legacy) {
          try {
            await legacy({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport: state.displayViewport,
            }).promise;
          } catch {
            /* ignore */
          }
        }
      }

      state.rendered = true;
    };

    const tearDownPage = (idx: number) => {
      const state = pageStates[idx];
      const wrap = wrappers[idx];
      if (!state || !wrap || !state.rendered) return;
      if (state.renderTask) {
        try {
          state.renderTask.cancel();
        } catch {
          /* ignore */
        }
        state.renderTask = null;
      }
      wrap.innerHTML = "";
      try {
        state.page.cleanup();
      } catch {
        /* ignore */
      }
      state.rendered = false;
    };

    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path });
        const data = new Uint8Array(bytes);
        if (cancelled) return;
        doc = (await pdfjs.getDocument({ data }).promise) as unknown as typeof doc;
        if (cancelled) {
          doc!.destroy();
          return;
        }
        setPages(doc!.numPages);

        const containerWidth = host.clientWidth - 32;

        // Fetch all PageProxy in parallel — pdf.js queues internally,
        // and parallel `getPage` is dramatically faster than serial.
        const proxies: PageProxy[] = await Promise.all(
          Array.from({ length: doc!.numPages }, (_, i) => doc!.getPage(i + 1)),
        );
        if (cancelled) {
          doc!.destroy();
          return;
        }

        // Build empty wrappers at correct dimensions so the document
        // has its true scroll height immediately.
        for (let i = 0; i < proxies.length; i++) {
          const page = proxies[i];
          const unscaled = page.getViewport({ scale: 1 });
          const fitScale = Math.max(0.8, containerWidth / unscaled.width);
          const displayViewport = page.getViewport({ scale: fitScale });
          const renderViewport = page.getViewport({
            scale: fitScale * BASE_RENDER_SCALE,
          });

          const pageWrap = document.createElement("div");
          pageWrap.className = "pdf-page-wrap";
          pageWrap.style.position = "relative";
          pageWrap.style.width = `${displayViewport.width}px`;
          pageWrap.style.height = `${displayViewport.height}px`;
          pageWrap.dataset.page = String(i + 1);

          const outerWrap = document.createElement("div");
          outerWrap.className = "flex justify-center";
          outerWrap.appendChild(pageWrap);
          host.appendChild(outerWrap);

          wrappers.push(pageWrap);
          pageStates.push({
            page,
            fitScale,
            displayViewport,
            renderViewport,
            rendered: false,
            renderTask: null,
          });
        }

        // Background: pull all pages' text content for ask-mode context.
        // Cheap relative to rendering (no rasterization); doesn't block
        // the UI. Marquee captures still work for visible pages even if
        // this hasn't completed yet — `textInRect` reads from the live
        // text-layer DOM, not from `fullTextRef`.
        void (async () => {
          const allText: string[] = new Array(proxies.length).fill("");
          await Promise.all(
            proxies.map(async (page, i) => {
              if (cancelled) return;
              try {
                const tc = await page.getTextContent();
                const text = tc.items
                  .map((it) => (typeof it.str === "string" ? it.str : ""))
                  .join(" ");
                allText[i] = `--- page ${i + 1} ---\n${text}`;
              } catch {
                /* ignore */
              }
            }),
          );
          if (!cancelled) fullTextRef.current = allText.join("\n\n");
        })();

        const scroller = scrollRef.current;
        if (!scroller || cancelled) {
          if (cancelled) doc!.destroy();
          return;
        }

        // Render zone: ~1.2 viewports above + below trigger render.
        renderObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const idx = Number((entry.target as HTMLElement).dataset.page) - 1;
              if (idx >= 0 && idx < pageStates.length) void renderPage(idx);
            }
          },
          { root: scroller, rootMargin: "1200px 0px 1200px 0px" },
        );

        // Keep-alive zone: wider margin. Pages outside it get torn down
        // to free canvas memory. Hysteresis between the two zones means
        // small scrolls don't churn the recently-rendered set.
        teardownObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) continue;
              const idx = Number((entry.target as HTMLElement).dataset.page) - 1;
              if (idx >= 0 && idx < pageStates.length) tearDownPage(idx);
            }
          },
          { root: scroller, rootMargin: "5000px 0px 5000px 0px" },
        );

        for (const wrap of wrappers) {
          renderObserver.observe(wrap);
          teardownObserver.observe(wrap);
        }

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderObserver) renderObserver.disconnect();
      if (teardownObserver) teardownObserver.disconnect();
      for (const state of pageStates) {
        if (state.renderTask) {
          try {
            state.renderTask.cancel();
          } catch {
            /* ignore */
          }
        }
        try {
          state.page.cleanup();
        } catch {
          /* ignore */
        }
      }
      if (doc) doc.destroy();
    };
  }, [path]);

  // Capture the pixels in the given client-space rectangle by compositing
  // the overlapping canvases into a new canvas. Returns a PNG data URL
  // or null if nothing overlapped. Crosses page boundaries if the box
  // does — each canvas is clipped + drawn at its relative offset.
  const imageOfRect = (clientRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): string | null => {
    const host = hostRef.current;
    if (!host) return null;
    const canvases = host.querySelectorAll<HTMLCanvasElement>("canvas.pdf-page");
    const width = clientRect.right - clientRect.left;
    const height = clientRect.bottom - clientRect.top;
    if (width < 4 || height < 4) return null;

    // Output canvas at device-pixel resolution for crispness.
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement("canvas");
    out.width = Math.floor(width * dpr);
    out.height = Math.floor(height * dpr);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);

    let drewSomething = false;
    for (const canvas of canvases) {
      const cr = canvas.getBoundingClientRect();
      // Overlap rect in client space.
      const ix1 = Math.max(cr.left, clientRect.left);
      const iy1 = Math.max(cr.top, clientRect.top);
      const ix2 = Math.min(cr.right, clientRect.right);
      const iy2 = Math.min(cr.bottom, clientRect.bottom);
      if (ix2 <= ix1 || iy2 <= iy1) continue;

      // Map client-space sub-rect to canvas-internal pixel space.
      const scaleX = canvas.width / cr.width;
      const scaleY = canvas.height / cr.height;
      const sx = (ix1 - cr.left) * scaleX;
      const sy = (iy1 - cr.top) * scaleY;
      const sw = (ix2 - ix1) * scaleX;
      const sh = (iy2 - iy1) * scaleY;

      // Destination rect in the output canvas (device pixels).
      const dx = (ix1 - clientRect.left) * dpr;
      const dy = (iy1 - clientRect.top) * dpr;
      const dw = (ix2 - ix1) * dpr;
      const dh = (iy2 - iy1) * dpr;

      ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
      drewSomething = true;
    }

    if (!drewSomething) return null;
    try {
      return out.toDataURL("image/png");
    } catch {
      return null;
    }
  };

  // Extract all text whose client rect intersects the given rect from
  // the text layer spans currently in the DOM. Preserves reading order
  // via pdf.js's left-to-right, top-to-bottom span layout. We also
  // insert a newline when we cross from one span's bottom to the next
  // span's top (rough paragraph boundary) — good enough for ask context.
  const textInRect = (clientRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): string => {
    const host = hostRef.current;
    if (!host) return "";
    const spans = host.querySelectorAll<HTMLElement>(".pdf-text-layer span");
    let out = "";
    let prevBottom: number | null = null;
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      const intersects =
        r.left < clientRect.right &&
        r.right > clientRect.left &&
        r.top < clientRect.bottom &&
        r.bottom > clientRect.top;
      if (!intersects) continue;
      const txt = s.textContent ?? "";
      if (!txt) continue;
      if (prevBottom !== null && r.top > prevBottom + 2) out += "\n";
      else if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      out += txt;
      prevBottom = r.bottom;
    }
    return out.trim();
  };

  // Marquee drag — attached to the scroll container when marqueeOn is
  // true. On release, hit-test the text layer, compute context slices
  // around the captured text, and open the ask popover automatically.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !marqueeOn) return;

    // Track the last known pointer position from move events. If a fast
    // drag flings the cursor outside the window right before release,
    // the pointerup event can arrive with stale/clamped coordinates —
    // so we prefer the most recent pointermove position as the end.
    let lastMove: { x: number; y: number } | null = null;
    let capturedPointerId: number | null = null;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (loading) return;
      const target = e.target as HTMLElement;
      if (!scroller.contains(target)) return;
      e.preventDefault();
      marqueeStartRef.current = { x: e.clientX, y: e.clientY };
      lastMove = { x: e.clientX, y: e.clientY };
      setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
      // Pointer capture — guarantees we keep receiving move/up events
      // on `scroller` even if the cursor flies off the window during a
      // fast drag.
      try {
        scroller.setPointerCapture(e.pointerId);
        capturedPointerId = e.pointerId;
      } catch {
        // Older platforms without pointer capture — fall back to the
        // window-level listeners below.
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!marqueeStartRef.current) return;
      lastMove = { x: e.clientX, y: e.clientY };
      setMarquee({
        x1: marqueeStartRef.current.x,
        y1: marqueeStartRef.current.y,
        x2: e.clientX,
        y2: e.clientY,
      });
    };

    const onUp = (e: PointerEvent) => {
      const start = marqueeStartRef.current;
      marqueeStartRef.current = null;
      if (capturedPointerId !== null) {
        try {
          scroller.releasePointerCapture(capturedPointerId);
        } catch {
          /* already released */
        }
        capturedPointerId = null;
      }
      if (!start) return;
      // Prefer the last pointermove position — pointerup sometimes
      // fires with older/stale coords on fast flings.
      const endX = lastMove?.x ?? e.clientX;
      const endY = lastMove?.y ?? e.clientY;
      lastMove = null;
      const rect = {
        left: Math.min(start.x, endX),
        top: Math.min(start.y, endY),
        right: Math.max(start.x, endX),
        bottom: Math.max(start.y, endY),
      };
      setMarquee(null);

      // Ignore tiny boxes (treat as a stray click). Fast small drags can
      // legitimately be a handful of pixels, so keep this lenient.
      if (rect.right - rect.left < 3 || rect.bottom - rect.top < 3) return;

      const captured = textInRect(rect);
      const image = imageOfRect(rect);
      // Need either text or an image to be useful.
      if (!captured && !image) return;

      const full = fullTextRef.current;
      let before = full.slice(-3000);
      let after = "";
      if (captured) {
        const idx = full.indexOf(
          captured.slice(0, Math.min(80, captured.length)),
        );
        if (idx >= 0) {
          before = full.slice(Math.max(0, idx - 3000), idx);
          after = full.slice(
            idx + captured.length,
            Math.min(full.length, idx + captured.length + 3000),
          );
        }
      }

      setMarqueeOn(false);
      // Drag direction — popover opens on the side the mouse ended.
      // Treat a pure-vertical or pure-horizontal drag as +1 on the
      // missing axis so the popover still picks a consistent side.
      const dirX = endX === start.x ? 1 : Math.sign(endX - start.x);
      const dirY = endY === start.y ? 1 : Math.sign(endY - start.y);
      // Which PDF page does this marquee land on? Pick the canvas
      // whose rect overlaps the selection most (by area) and read
      // its data-page attribute.
      const pageCanvases =
        hostRef.current?.querySelectorAll<HTMLCanvasElement>("canvas.pdf-page[data-page]");
      let bestPage: string | null = null;
      let bestArea = 0;
      if (pageCanvases) {
        for (const c of pageCanvases) {
          const cr = c.getBoundingClientRect();
          const ix = Math.max(0, Math.min(cr.right, rect.right) - Math.max(cr.left, rect.left));
          const iy = Math.max(0, Math.min(cr.bottom, rect.bottom) - Math.max(cr.top, rect.top));
          const area = ix * iy;
          if (area > bestArea) {
            bestArea = area;
            bestPage = c.dataset.page ?? null;
          }
        }
      }
      const sourceAnchor = bestPage ? `page=${bestPage}` : null;
      // Marquee output is owned by whichever popup it feeds (chat
      // capture, edit-prompt, note, feedback, or a fresh inline-ask).
      // Don't stash in the global lastCapture — Ctrl+N is supposed to
      // be vault-context-only and shouldn't pick up popup leftovers.
      const store = useStore.getState();
      if (store.chatPaneCapturePending && image) {
        store.setChatPaneLastCapture({
          imageDataUrl: image,
          sourcePath: path,
          sourceAnchor: sourceAnchor,
        });
        store.setChatPaneCapturePending(false);
        return;
      }
      if (store.editPromptCapturePending && image) {
        store.setEditPromptLastCapture({
          imageDataUrl: image,
          sourcePath: path,
          sourceAnchor: sourceAnchor,
        });
        store.setEditPromptCapturePending(false);
        return;
      }
      if (store.noteCapturePending || store.feedbackCapturePending) {
        const isFeedback = store.feedbackCapturePending;
        const stashed = isFeedback ? store.feedbackComposer : store.noteComposer;
        const prev = stashed.initialAnchors ?? [];
        const hasPrimary = prev.some((a) => a.primary);
        const appendImage = (a: typeof prev[number]) => {
          const existing =
            a.images && a.images.length > 0
              ? a.images
              : a.image_data_url
                ? [a.image_data_url]
                : [];
          const next = image ? [...existing, image] : existing;
          return {
            ...a,
            image_data_url: next[0] ?? null,
            images: next,
            source_anchor: a.source_anchor ?? sourceAnchor ?? null,
          };
        };
        const updated = prev.length > 0
          ? prev.map((a) => (a.primary ? appendImage(a) : a))
          : [];
        const anchors = hasPrimary
          ? updated
          : [
              ...updated,
              {
                source_path: path,
                source_kind: "pdf" as const,
                source_anchor: sourceAnchor,
                image_data_url: image ?? null,
                images: image ? [image] : [],
                source_selection: captured || null,
                primary: true,
              },
            ];
        if (isFeedback) {
          store.openFeedbackComposer({
            initialDraft: stashed.initialDraft,
            initialAnchors: anchors,
          });
          store.setFeedbackCapturePending(false);
        } else {
          store.openNoteComposer({
            initialDraft: stashed.initialDraft,
            initialAnchors: anchors,
            initialTurns: (stashed as typeof store.noteComposer).initialTurns,
          });
          store.setNoteCapturePending(false);
        }
        return;
      }
      setInlineAsk({
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          dirX,
          dirY,
        },
        selection: captured,
        before,
        after,
        language: "pdf",
        imageDataUrl: image ?? undefined,
        sourceAnchor: sourceAnchor ?? undefined,
      });
    };

    const onKeyEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        marqueeStartRef.current = null;
        setMarquee(null);
        setMarqueeOn(false);
        // Cancel any pending capture reservations so the next
        // marquee, wherever it's launched from, isn't claimed by a
        // destination the user already gave up on.
        const s = useStore.getState();
        s.setChatPaneCapturePending(false);
        s.setEditPromptCapturePending(false);
        s.setNoteCapturePending(false);
      }
    };

    scroller.addEventListener("pointerdown", onDown);
    scroller.addEventListener("pointermove", onMove);
    scroller.addEventListener("pointerup", onUp);
    scroller.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKeyEsc);
    return () => {
      scroller.removeEventListener("pointerdown", onDown);
      scroller.removeEventListener("pointermove", onMove);
      scroller.removeEventListener("pointerup", onUp);
      scroller.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKeyEsc);
    };
  }, [marqueeOn, loading]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
      <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
        {pages > 0 && (
          <span className="font-mono">{pages} page{pages === 1 ? "" : "s"}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              if (loading) return;
              setMarqueeOn((v) => !v);
            }}
            className={cn(
              "h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground mr-1",
              marqueeOn && "bg-primary/20 text-foreground",
            )}
            title={
              marqueeOn
                ? "Marquee ask: drag a box over text (Esc to cancel)"
                : "Marquee ask: click, then drag a box over text to ask about it"
            }
          >
            <BoxSelect className="h-3 w-3" />
          </button>
          <button
            onClick={() => {
              if (loading) return;
              setZoom((z) => clampZoom(z / 1.1));
            }}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
            title="Zoom out"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          <button
            onClick={() => {
              if (loading) return;
              setZoom(1);
            }}
            className="h-6 min-w-[48px] px-2 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground font-mono text-[10.5px]"
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => {
              if (loading) return;
              setZoom((z) => clampZoom(z * 1.1));
            }}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
            title="Zoom in"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
        </div>
      </div>
      {error && (
        <div className="p-8 text-destructive text-sm font-mono flex items-center gap-2">
          <FileText className="h-4 w-4" /> Failed to load PDF: {error}
        </div>
      )}
      {loading && !error && (
        <div className="p-8 text-muted-foreground text-sm">Loading PDF…</div>
      )}
      <div
        ref={scrollRef}
        className={cn(
          "flex-1 overflow-auto p-4 relative",
          marqueeOn && "cursor-crosshair select-none",
        )}
      >
        <div
          ref={hostRef}
          className="space-y-4"
          style={{ zoom }}
        />
        {marqueeOn && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-20 rounded-full bg-card border border-border shadow px-3 py-1 text-[10.5px] text-muted-foreground">
            drag a box over text · Esc to cancel
          </div>
        )}
      </div>
      {marquee && (
        <div
          className="pointer-events-none fixed z-40 border border-primary/80 bg-primary/15 rounded-sm"
          style={{
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
          }}
        />
      )}
      {inlineAsk && (
        <InlineEditPrompt
          request={inlineAsk}
          initialMode="ask"
          askOnly
          onAccept={() => setInlineAsk(null)}
          onCancel={() => setInlineAsk(null)}
        />
      )}
    </div>
  );
}
