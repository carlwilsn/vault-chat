import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Eye, FileText } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export function PdfView({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    setLoading(true);
    setError(null);
    setPages(0);

    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path });
        const data = new Uint8Array(bytes);
        if (cancelled) return;
        const task = pdfjs.getDocument({ data });
        const doc = await task.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPages(doc.numPages);
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) {
            doc.destroy();
            return;
          }
          const page = await doc.getPage(i);
          const containerWidth = host.clientWidth - 32;
          const unscaled = page.getViewport({ scale: 1 });
          const scale = Math.min(2, Math.max(0.8, containerWidth / unscaled.width));
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className = "pdf-page shadow-md rounded";
          const transform: [number, number, number, number, number, number] =
            dpr === 1 ? [1, 0, 0, 1, 0, 0] : [dpr, 0, 0, dpr, 0, 0];

          const wrap = document.createElement("div");
          wrap.className = "flex justify-center";
          wrap.appendChild(canvas);
          host.appendChild(wrap);

          await page.render({ canvas, viewport, transform }).promise;
          page.cleanup();
        }
        setLoading(false);
        doc.destroy();
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
      <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
        <Eye className="h-3 w-3" />
        <span>Read-only PDF</span>
        {pages > 0 && (
          <>
            <span className="opacity-60">·</span>
            <span className="font-mono">{pages} page{pages === 1 ? "" : "s"}</span>
          </>
        )}
      </div>
      {error && (
        <div className="p-8 text-destructive text-sm font-mono flex items-center gap-2">
          <FileText className="h-4 w-4" /> Failed to load PDF: {error}
        </div>
      )}
      {loading && !error && (
        <div className="p-8 text-muted-foreground text-sm">Loading PDF…</div>
      )}
      <div ref={hostRef} className="flex-1 overflow-auto p-4 space-y-4" />
    </div>
  );
}
