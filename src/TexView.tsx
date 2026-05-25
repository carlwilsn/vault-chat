import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PdfView } from "./PdfView";

type CompileResult = { pdf_path: string; log: string };

// Preview-side of a .tex file. Calls the bundled Tectonic engine via
// the `compile_tex` Tauri command to produce a PDF, then hands the
// resulting on-disk path to the existing PdfView so zoom / marquee /
// page-turn behavior is identical to viewing any other PDF in the app.
//
// First compile of a new document is slow (Tectonic fetches CTAN
// packages on demand into a local cache, typically 5-30s depending on
// what's used). Subsequent compiles of the same document are 1-3s — the
// Rust side reuses a per-document scratch directory keyed by source
// path so the package cache and .aux state survive between compiles.
//
// Recompile is manual: the parent MarkdownView header renders a refresh
// button next to the source/preview toggle that dispatches a
// `vc-tex-recompile` window event; this view listens for it and triggers
// a fresh compile. Reverse channel `vc-tex-status` keeps the header's
// spinner in sync.
export function TexView({
  path,
  content,
  relPath: _relPath,
  paneId: _paneId,
}: {
  path: string;
  content: string;
  relPath?: string;
  paneId?: string | null;
}) {
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump on every successful compile so PdfView, which keys its setup
  // effect on `path`, gets re-mounted and rereads the temp PDF (the
  // path string is the same per-document, so React wouldn't otherwise
  // notice that the bytes on disk changed).
  const [version, setVersion] = useState(0);
  const compilingRef = useRef(false);
  // Latest content goes into a ref so the global recompile listener
  // (set up once on mount) always reads fresh source — the closure
  // captured at addEventListener time would otherwise re-compile the
  // version of `content` that was current the first time TexView
  // mounted, ignoring every keystroke since.
  const contentRef = useRef(content);
  contentRef.current = content;
  const pathRef = useRef(path);
  pathRef.current = path;

  const compile = async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    setError(null);
    window.dispatchEvent(
      new CustomEvent("vc-tex-status", { detail: { state: "compiling" } }),
    );
    try {
      const res = await invoke<CompileResult>("compile_tex", {
        sourcePath: pathRef.current,
        contents: contentRef.current,
      });
      setPdfPath(res.pdf_path);
      setVersion((v) => v + 1);
      window.dispatchEvent(
        new CustomEvent("vc-tex-status", { detail: { state: "idle" } }),
      );
    } catch (e) {
      setError(String(e));
      setPdfPath(null);
      window.dispatchEvent(
        new CustomEvent("vc-tex-status", { detail: { state: "error" } }),
      );
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  };

  // Auto-compile on first mount and whenever the user switches to a
  // different .tex file. Subsequent edits don't auto-recompile — the
  // header's refresh button or a fresh switch is the trigger.
  useEffect(() => {
    setPdfPath(null);
    setError(null);
    void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Header refresh button → window event → here.
  useEffect(() => {
    const onRecompile = () => void compile();
    window.addEventListener("vc-tex-recompile", onRecompile);
    return () => window.removeEventListener("vc-tex-recompile", onRecompile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative bg-muted/20">
      {error ? (
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-[11.5px] font-mono text-destructive whitespace-pre-wrap break-words">
            {error}
          </pre>
        </div>
      ) : pdfPath ? (
        // paneId is intentionally null — the parent MarkdownView header
        // already owns the close-pane button, so we don't want PdfView
        // to render a second one.
        <PdfView key={`${pdfPath}#${version}`} path={pdfPath} paneId={null} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {compiling ? "Compiling LaTeX…" : "Preparing preview…"}
        </div>
      )}
    </div>
  );
}
