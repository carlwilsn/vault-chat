import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileCode2 } from "lucide-react";
import { PdfView } from "./PdfView";

type CompileResult = { pdf_path: string; log: string };

// Preview-side of a .tex file. Calls the bundled Tectonic engine via
// the `compile_tex` Tauri command to produce a PDF, then hands the
// resulting on-disk path to the existing PdfView so zoom / marquee /
// page-turn behavior is identical to viewing any other PDF in the app.
//
// First compile of a new document is slow (Tectonic fetches CTAN
// packages on demand into a local cache, typically 5-30s depending on
// what's used). Subsequent compiles are 1-3s — the Rust side reuses a
// per-document scratch directory keyed by source path so the package
// cache and .aux state survive between compiles.
//
// No explicit recompile button: every toggle into preview mode
// remounts this view (MarkdownView swaps in the Monaco editor for the
// source side), which fires the [path] effect and runs a fresh
// compile. The user sees an "edit → toggle preview → fresh PDF" loop
// without thinking about it.
export function TexView({
  path,
  content,
  relPath,
  paneId,
  onToggleMode,
}: {
  path: string;
  content: string;
  relPath?: string;
  paneId?: string | null;
  // Click on the source/preview toggle inside the PdfView toolbar.
  // Provided by the parent MarkdownView so the toggle flips the
  // pane's view mode without TexView having to know about the store.
  onToggleMode?: () => void;
}) {
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compilingRef = useRef(false);
  // Latest content goes into a ref so the compile call always reads
  // fresh source — closure capture at the effect's setup time would
  // otherwise compile a stale snapshot.
  const contentRef = useRef(content);
  contentRef.current = content;

  const compile = async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    setError(null);
    try {
      const res = await invoke<CompileResult>("compile_tex", {
        sourcePath: path,
        contents: contentRef.current,
      });
      setPdfPath(res.pdf_path);
    } catch (e) {
      setError(String(e));
      setPdfPath(null);
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  };

  // Auto-compile on mount and on file switch. Toggling source → preview
  // re-mounts this view (Monaco owns the source side) so this effect
  // fires there too, giving the user a fresh PDF every time.
  useEffect(() => {
    setPdfPath(null);
    setError(null);
    void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Single source-toggle button injected into PdfView's toolbar (left
  // of the marquee). Same icon-button shape as PdfView's own controls
  // so visually nothing distinguishes a .tex preview from a real PDF.
  const toolbarExtras = onToggleMode ? (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggleMode();
      }}
      className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground mr-1"
      title="Source (Ctrl+E)"
    >
      <FileCode2 className="h-3 w-3" />
    </button>
  ) : null;

  if (error) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
        <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-2 flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
          {relPath && (
            <span className="font-mono truncate select-none">{relPath}</span>
          )}
          <div className="ml-auto flex items-center gap-1">{toolbarExtras}</div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-[11.5px] font-mono text-destructive whitespace-pre-wrap break-words">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  if (!pdfPath) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
        <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-2 flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
          {relPath && (
            <span className="font-mono truncate select-none">{relPath}</span>
          )}
          <div className="ml-auto flex items-center gap-1">{toolbarExtras}</div>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {compiling ? "Compiling LaTeX…" : "Preparing preview…"}
        </div>
      </div>
    );
  }

  // Once the PDF is on disk, defer entirely to PdfView. Pass our
  // relPath + paneId through so the toolbar shows the .tex file's
  // path (not the temp PDF's) and the pane close button still works.
  return (
    <PdfView
      path={pdfPath}
      relPath={relPath}
      paneId={paneId}
      extraToolbar={toolbarExtras}
    />
  );
}
