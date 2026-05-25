import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileCode2 } from "lucide-react";
import { PdfView } from "./PdfView";
import { useStore } from "./store";

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
  // Bumps on every successful compile. Used as a key suffix on PdfView
  // so React remounts it after a recompile — Tectonic writes to a
  // deterministic per-source scratch path, so the path string is the
  // same string each time and PdfView's `useEffect([path])` would
  // otherwise miss that the bytes on disk just changed.
  const [compileGen, setCompileGen] = useState(0);
  const compilingRef = useRef(false);
  // Set when a fresh edit arrives during a running compile. After the
  // current compile finishes we kick off exactly one more so the
  // displayed PDF eventually matches the latest source. Without this,
  // the last edit in a burst could be dropped if it landed mid-compile.
  const queuedRef = useRef(false);
  // Latest content goes into a ref so the compile call always reads
  // fresh source — closure capture at the effect's setup time would
  // otherwise compile a stale snapshot.
  const contentRef = useRef(content);
  contentRef.current = content;
  const pathRef = useRef(path);
  pathRef.current = path;

  const compile = async () => {
    if (compilingRef.current) {
      // Already compiling — mark that we want a follow-up. The finally
      // block at the bottom will fire one more compile when this one
      // settles. Multiple edits during a single compile collapse into
      // exactly one extra run.
      queuedRef.current = true;
      return;
    }
    compilingRef.current = true;
    setCompiling(true);
    setError(null);
    try {
      // Re-read latest source + path at the moment we actually compile,
      // not at the time the call was scheduled. A burst of edits during
      // the debounce window all settle before this fires.
      const res = await invoke<CompileResult>("compile_tex", {
        sourcePath: pathRef.current,
        contents: contentRef.current,
      });
      setPdfPath(res.pdf_path);
      setCompileGen((g) => g + 1);
      setError(null);
    } catch (e) {
      setError(String(e));
      setPdfPath(null);
    } finally {
      compilingRef.current = false;
      setCompiling(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        void compile();
      }
    }
  };

  // Debounce wrapper: coalesces a burst of file-changed events (e.g.
  // the agent edits one .tex three times in a single reply) into a
  // single compile that fires once the edits go quiet. Together with
  // queuedRef above, this gives: "burst of edits → one compile when
  // settled; if another edit lands mid-compile, exactly one more
  // compile when that finishes."
  const debounceTimer = useRef<number | null>(null);
  const requestCompile = () => {
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null;
      void compile();
    }, 600);
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

  // Listen for Tauri-side `file-changed` events fired after every
  // text-file write. Recompile if it's our file. Covers the agent
  // editing the open .tex during its reply *and* external edits
  // from another editor (Obsidian, vim, etc.).
  //
  // Critical: re-read disk and push into the React store BEFORE
  // triggering compile. When the agent writes the .tex, the bytes hit
  // disk but the in-memory store (the source of `content` / contentRef)
  // is untouched — only user edits flow through the autosave path that
  // updates the store. Without this refresh, compile_tex would receive
  // contentRef's stale snapshot and faithfully re-typeset the old text,
  // producing a "new" PDF that looks identical to the previous one
  // (the user-reported "had to click twice" symptom).
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const off = await listen<string>("file-changed", async (evt) => {
        if (cancelled) return;
        // Normalize separators so the Windows backslash path the agent
        // tools hand us still matches the forward-slash path TexView
        // received from the file tree.
        const a = (evt.payload ?? "").replace(/\\/g, "/");
        const b = pathRef.current.replace(/\\/g, "/");
        if (a !== b) return;
        try {
          const fresh = await invoke<string>("read_text_file", {
            path: pathRef.current,
          });
          if (cancelled) return;
          // Set ref directly so the very next compile (about to be
          // scheduled below) sees the new bytes even if React hasn't
          // re-rendered yet.
          contentRef.current = fresh;
          // Push into the store too, so source-mode (Monaco) and any
          // other reader see the updated content. getState() always
          // returns the fresh actions / current file value.
          const store = useStore.getState();
          const pid = paneIdRef.current;
          if (pid) {
            store.setPaneFile(pid, pathRef.current, fresh);
          } else if (store.currentFile === pathRef.current) {
            store.setCurrentFile(pathRef.current, fresh);
          }
        } catch (e) {
          console.error("[tex] read-after-file-changed failed:", e);
        }
        requestCompile();
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      key={`${pdfPath}#${compileGen}`}
      path={pdfPath}
      relPath={relPath}
      paneId={paneId}
      extraToolbar={toolbarExtras}
    />
  );
}
