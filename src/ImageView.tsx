import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";
import { useStore } from "./store";

function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "bmp") return "image/bmp";
  if (e === "ico") return "image/x-icon";
  if (e === "tif" || e === "tiff") return "image/tiff";
  if (e === "heic") return "image/heic";
  if (e === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

export function ImageView({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marqueeOn, setMarqueeOn] = useState(false);
  const [marquee, setMarquee] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);
  // Two-finger pinch zoom + pan. On Windows touchpads the webview
  // translates a pinch into a `wheel` event with ctrlKey set; regular
  // two-finger scroll arrives as a wheel without ctrl. State is per-file
  // so opening a new image resets the view back to fit-to-screen.
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  useEffect(() => {
    setZoom({ scale: 1, tx: 0, ty: 0 });
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path });
        if (cancelled) return;
        const dot = path.lastIndexOf(".");
        const ext = dot > 0 ? path.slice(dot + 1) : "";
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(ext) });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  // Ctrl+M toggles marquee via the window event dispatched by the
  // top-level keydown handler in MarkdownView.
  useEffect(() => {
    const onToggle = () => setMarqueeOn((v) => !v);
    window.addEventListener("vc-marquee-toggle", onToggle);
    return () => window.removeEventListener("vc-marquee-toggle", onToggle);
  }, []);

  // Touchpad pinch-to-zoom. The wheel listener has to be registered
  // non-passive so preventDefault() actually stops the webview from
  // also page-zooming or scrolling underneath us. React's onWheel
  // attaches passive by default in some versions, so we go through
  // addEventListener directly.
  //
  // Zoom math: keep the image pixel under the cursor anchored to the
  // cursor as scale changes. Working in container-local coords with
  // transform-origin: 0 0, an image point originally at offset (u, v)
  // from the img's layout top-left maps to (offsetLeft + tx + u*scale,
  // ...). Setting the new container-relative cursor equal across old
  // and new state gives newTx = u − (u − oldTx) * (newScale/oldScale).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const img = imgRef.current;
      if (!img) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const stageRect = stage.getBoundingClientRect();
        const cx = e.clientX - stageRect.left;
        const cy = e.clientY - stageRect.top;
        // Exponential step so equal touchpad deltas produce equal
        // multiplicative zoom — feels right whether you're at 1x or 4x.
        const factor = Math.exp(-e.deltaY * 0.01);
        setZoom((z) => {
          const next = Math.max(0.2, Math.min(8, z.scale * factor));
          const ratio = next / z.scale;
          const u = cx - img.offsetLeft;
          const v = cy - img.offsetTop;
          // If we ratio'd back to 1x exactly, snap translation to 0 so
          // the image returns to its fit-to-screen layout position.
          if (Math.abs(next - 1) < 0.01) {
            return { scale: 1, tx: 0, ty: 0 };
          }
          return {
            scale: next,
            tx: u - (u - z.tx) * ratio,
            ty: v - (v - z.ty) * ratio,
          };
        });
        return;
      }
      // Regular two-finger scroll: pan when zoomed in. Leave it alone
      // at 1x so the rest of the app behaves normally.
      setZoom((z) => {
        if (z.scale <= 1) return z;
        e.preventDefault();
        return { ...z, tx: z.tx - e.deltaX, ty: z.ty - e.deltaY };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  // Double-click to reset zoom — quick escape hatch when the user
  // pinched too far in or lost the image off-screen.
  const onDoubleClick = () => setZoom({ scale: 1, tx: 0, ty: 0 });

  // Crop a viewport-space rect out of the rendered image and return the
  // crop as a PNG data URL. Maps client rect → displayed-image rect →
  // natural-image pixels. Respects object-fit: contain letterboxing.
  const cropRect = (clientRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): string | null => {
    const img = imgRef.current;
    if (!img) return null;
    const ir = img.getBoundingClientRect();
    // Overlap between marquee and the displayed image area.
    const ix1 = Math.max(clientRect.left, ir.left);
    const iy1 = Math.max(clientRect.top, ir.top);
    const ix2 = Math.min(clientRect.right, ir.right);
    const iy2 = Math.min(clientRect.bottom, ir.bottom);
    if (ix2 <= ix1 || iy2 <= iy1) return null;

    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    if (!nat.w || !nat.h) return null;

    const scaleX = nat.w / ir.width;
    const scaleY = nat.h / ir.height;
    const sx = (ix1 - ir.left) * scaleX;
    const sy = (iy1 - ir.top) * scaleY;
    const sw = (ix2 - ix1) * scaleX;
    const sh = (iy2 - iy1) * scaleY;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    } catch (err) {
      console.error("[image marquee] canvas draw failed:", err);
      return null;
    }
  };

  useEffect(() => {
    if (!marqueeOn) return;
    const host = overlayRef.current;
    if (!host) return;

    let lastMove: { x: number; y: number } | null = null;
    let capturedPointerId: number | null = null;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      marqueeStartRef.current = { x: e.clientX, y: e.clientY };
      lastMove = { x: e.clientX, y: e.clientY };
      setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
      try {
        host.setPointerCapture(e.pointerId);
        capturedPointerId = e.pointerId;
      } catch {
        /* older platforms — window events pick up the slack */
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
          host.releasePointerCapture(capturedPointerId);
        } catch {
          /* already released */
        }
        capturedPointerId = null;
      }
      if (!start) return;
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
      if (rect.right - rect.left < 3 || rect.bottom - rect.top < 3) return;

      const image = cropRect(rect);
      if (!image) return;

      const dirX = endX === start.x ? 1 : Math.sign(endX - start.x);
      const dirY = endY === start.y ? 1 : Math.sign(endY - start.y);
      setMarqueeOn(false);
      // Marquee output is owned by whichever popup it feeds. Don't
      // stash in lastCapture — Ctrl+N stays vault-context-only.
      const store = useStore.getState();
      if (store.voiceCapturePending) {
        store.setVoiceLastCapture({
          imageDataUrl: image,
          sourcePath: path,
          sourceAnchor: null,
        });
        store.setVoiceCapturePending(false);
        return;
      }
      if (store.chatPaneCapturePending) {
        store.setChatPaneLastCapture({
          imageDataUrl: image,
          sourcePath: path,
          sourceAnchor: null,
        });
        store.setChatPaneCapturePending(false);
        return;
      }
      if (store.editPromptCapturePending) {
        store.setEditPromptLastCapture({
          imageDataUrl: image,
          sourcePath: path,
          sourceAnchor: null,
        });
        store.setEditPromptCapturePending(false);
        return;
      }
      if (store.noteCapturePending) {
        const stashed = store.noteComposer;
        const prev = stashed.initialAnchors ?? [];
        const hasPrimary = prev.some((a) => a.primary);
        const appendImage = (a: typeof prev[number]) => {
          const existing =
            a.images && a.images.length > 0
              ? a.images
              : a.image_data_url
                ? [a.image_data_url]
                : [];
          const next = [...existing, image];
          return { ...a, image_data_url: next[0], images: next };
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
                source_kind: "image" as const,
                source_anchor: null,
                image_data_url: image,
                images: [image],
                primary: true,
              },
            ];
        store.openNoteComposer({
          initialDraft: stashed.initialDraft,
          initialAnchors: anchors,
          initialTurns: stashed.initialTurns,
        });
        store.setNoteCapturePending(false);
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
        selection: "",
        before: "",
        after: "",
        language: "image",
        imageDataUrl: image,
      });
    };

    const onKeyEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        marqueeStartRef.current = null;
        setMarquee(null);
        setMarqueeOn(false);
        const s = useStore.getState();
        s.setChatPaneCapturePending(false);
        s.setEditPromptCapturePending(false);
        s.setNoteCapturePending(false);
        s.setVoiceCapturePending(false);
      }
    };

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKeyEsc);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKeyEsc);
    };
  }, [marqueeOn]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive text-sm p-8">
        Failed to load image: {error}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8">
        Loading image…
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20 relative">
      <div
        ref={stageRef}
        onDoubleClick={onDoubleClick}
        className="flex-1 overflow-hidden flex items-center justify-center p-4 relative"
      >
        <img
          ref={imgRef}
          src={url}
          alt={path.split("/").pop() ?? "image"}
          className="max-w-full max-h-full object-contain pointer-events-none"
          draggable={false}
          style={{
            transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        />
        {marqueeOn && (
          <div
            ref={overlayRef}
            className="absolute inset-0 z-20 cursor-crosshair select-none"
          />
        )}
        {marqueeOn && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-30 rounded-full bg-card border border-border shadow px-3 py-1 text-[10.5px] text-muted-foreground">
            drag a box · Esc to cancel
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
