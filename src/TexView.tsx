import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
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
// Recompile is manual via a refresh button rather than triggered on
// every edit: even cached compiles cost ~1-3s, and continuous
// recompilation as the user types would feel laggier than a deliberate
// "show me the result now" click. The .tex source is autosaved upstream
// (MarkdownView's autosave path), so the disk copy is always fresh.
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

  const compile = async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    setError(null);
    try {
      const res = await invoke<CompileResult>("compile_tex", {
        sourcePath: path,
        contents: content,
      });
      setPdfPath(res.pdf_path);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
      setPdfPath(null);
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  };

  // Auto-compile on first mount and whenever the user switches to a
  // different .tex file. Subsequent edits don't auto-recompile — the
  // refresh button or a fresh switch is the trigger.
  useEffect(() => {
    setPdfPath(null);
    setError(null);
    void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative bg-muted/20">
      <div className="sticky top-0 z-20 bg-muted/80 backdrop-blur border-b border-border/60 px-4 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
        {compiling && (
          <span className="flex items-center gap-1.5 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> compiling…
          </span>
        )}
        {!compiling && pdfPath && !error && (
          <span className="text-muted-foreground">compiled</span>
        )}
        {!compiling && error && (
          <span className="text-destructive flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3" /> compile failed
          </span>
        )}
        <button
          onClick={() => void compile()}
          disabled={compiling}
          className="ml-auto h-6 px-2 flex items-center gap-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground disabled:opacity-40"
          title="Recompile (re-run Tectonic)"
        >
          <RefreshCw className={`h-3 w-3 ${compiling ? "animate-spin" : ""}`} />
          recompile
        </button>
      </div>
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
