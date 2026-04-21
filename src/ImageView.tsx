import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";

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
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);

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
      <div className="flex-1 overflow-auto flex items-center justify-center p-4 relative">
        <img
          ref={imgRef}
          src={url}
          alt={path.split("/").pop() ?? "image"}
          className="max-w-full max-h-full object-contain pointer-events-none"
          draggable={false}
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
