// The viewer pane's body (./Pane.tsx is the pane: its header, Ctrl+L, saving, live reload): the file drawn by
// the viewer the registry names (src/viewerRegistry.ts). The app's own viewers are registered here as the built-in
// layer, each drawing exactly what the pane drew before (PDF, rendered markdown, notebook, TeX, HTML, image, video,
// unsupported, code in Monaco); an in-process page's viewer draws into a plain element (DomViewer); a viewer that throws
// hands the file to the next in line (a plugin's → the built-in → the plain fallback), for that file only.
//
// The source editor (Ctrl+E on an editable type: the live editor for markdown, Monaco otherwise) is the pane's, not a
// viewer: SourceEditor.
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle } from "lucide-react";
import type { FileKind } from "../../fileKind";
import { LiveEditor } from "../../LiveEditor";
import { CodeView } from "../../CodeView";
import { NotebookView } from "../../NotebookView";
import { PdfView } from "../../PdfView";
import { TexView } from "../../TexView";
import { HtmlView } from "../../HtmlView";
import { ImageView } from "../../ImageView";
import { VideoView } from "../../VideoView";
import { UnsupportedView } from "../../UnsupportedView";
import { Markdown } from "../../Markdown";
import { NoteSourceContext } from "../../NoteWidget";
import type { NoteSource } from "../../noteWidgets";
import { useStore } from "../../store";
import { reportScroll } from "../../scrollTarget";
import { decodeTarget } from "../../viewTarget";
import { relToVault } from "../../paneLayout";
import { contextNow, publishContext } from "../../sharedContext";
import {
  noteViewerFailure,
  registerAppViewer,
  registerBuiltinViewer,
  type ViewerEntry,
  type ViewerFile,
  type ViewerHandle,
  type ViewerMode,
} from "../../viewerRegistry";
import { enableViewer } from "./prefs";
import { noteScroll } from "./scroll";
import { registerZoom } from "./zoom";

// Monaco (with its languages) is most of the bundle and only edits non-markdown
// files, so it loads on first use (main.tsx prefetches it once startup settles)
// instead of being parsed before the first paint on every launch.
const MonacoEditor = lazy(() => import("../../MonacoEditor").then((m) => ({ default: m.MonacoEditor })));

/** What a viewer is drawn with: the pane's file and the few things of the pane a viewer reaches. */
export type ViewerProps = {
  file: string;
  content: string;
  ext: string;
  type: FileKind;
  relPath: string;
  paneId?: string;
  rev: number;
  mode: ViewerMode;
  onChange: (value: string) => void;
  onToggleMode: () => void;
  /** The rendered markdown's parts the pane owns (its scroller is the pane's Ctrl+L and ScrollTo root). */
  md: {
    viewScrollRef: RefObject<HTMLDivElement | null>;
    onViewScroll: (e: React.UIEvent<HTMLDivElement>) => void;
    components: Record<string, unknown>;
    noteSource: NoteSource | null;
    scrollRatioRef: { current: number };
    onEditorScrollRatio: (r: number) => void;
  };
};

// ---------------------------------------------------------------- the app's own viewers (unchanged)

function MarkdownViewer({ content, md }: ViewerProps) {
  return (
    <div ref={md.viewScrollRef} onScroll={md.onViewScroll} data-look-scroll className="flex-1 overflow-auto py-10 px-8">
      <div className="prose-md mx-auto" data-note-widgets>
        <NoteSourceContext.Provider value={md.noteSource}>
          <Markdown source={content} profile="note" components={md.components as never} />
        </NoteSourceContext.Provider>
      </div>
    </div>
  );
}
const NotebookViewer = ({ content, file }: ViewerProps) => <NotebookView content={content} path={file} />;
const PdfViewer = ({ file, relPath, paneId, rev }: ViewerProps) => <PdfView path={file} relPath={relPath} paneId={paneId} rev={rev} />;
const TexViewer = ({ file, content, relPath, paneId, onToggleMode }: ViewerProps) => (
  <TexView path={file} content={content} relPath={relPath} paneId={paneId} onToggleMode={onToggleMode} />
);
const HtmlViewer = ({ content, file }: ViewerProps) => <HtmlView content={content} path={file} />;
const ImageViewer = ({ file, rev }: ViewerProps) => <ImageView path={file} rev={rev} />;
const VideoViewer = ({ file }: ViewerProps) => <VideoView path={file} />;
const UnsupportedViewer = ({ file }: ViewerProps) => <UnsupportedView path={file} />;
const HighlightViewer = ({ content, ext, file }: ViewerProps) => <CodeView content={content} ext={ext} path={file} />;

/** The source editor (the pane's edit mode, and the code viewer): the live editor for markdown, Monaco otherwise. */
export function SourceEditor({ file, content, ext, type, onChange, md }: ViewerProps) {
  if (type === "markdown") {
    return (
      <div className="flex-1 min-h-0">
        <LiveEditor value={content} onChange={onChange} initialScrollRatio={md.scrollRatioRef.current} onScrollRatio={md.onEditorScrollRatio} file={file} />
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0">
      <Suspense fallback={null}>
        <MonacoEditor value={content} onChange={onChange} ext={ext} path={file} />
      </Suspense>
    </div>
  );
}

/** The pane in edit mode: the source editor, behind the same boundary as a viewer (failing, the file as plain text). */
export const EDITOR_CHAIN: readonly ViewerEntry[] = [{ id: "editor", key: "editor", by: "app", builtin: true, name: "Source editor", component: SourceEditor }];

registerBuiltinViewer("markdown", MarkdownViewer, { name: "Markdown (rendered)" });
registerBuiltinViewer("notebook", NotebookViewer, { name: "Notebook" });
// PDFs (and .tex in preview mode, which renders a PDF) own their own toolbar — file path, page count, zoom, source
// toggle — so the pane's header stays out and there's only one bar across the top.
registerBuiltinViewer("pdf", PdfViewer, { name: "PDF", ownHeader: () => true });
registerBuiltinViewer("tex", TexViewer, { name: "TeX (compiled PDF)", ownHeader: () => true });
registerBuiltinViewer("html", HtmlViewer, { name: "HTML page" });
registerBuiltinViewer("image", ImageViewer, { name: "Image" });
registerBuiltinViewer("video", VideoViewer, { name: "Video" });
registerBuiltinViewer("unsupported", UnsupportedViewer, { name: "Open with the default app" });
// Code files are edit-only — Monaco renders them fine and a view / edit toggle would flip to a near-identical view.
registerBuiltinViewer("code", SourceEditor, { name: "Code (Monaco editor)", alwaysEdits: true });
// An app alternative, drawn only when chosen: code highlighted read-only.
registerAppViewer("code", "highlight", HighlightViewer, "Code (highlighted, read-only)");

// ---------------------------------------------------------------- a plugin's viewer

type Handle = Exclude<ViewerHandle, void | (() => void)>;
const asHandle = (h: ViewerHandle): Handle =>
  typeof h === "function" ? { unmount: h } : h && typeof h === "object" ? h : {};

/** A plugin's viewer: a plain element it draws into, mounted per file (and change on disk); a throw is the file's. */
function DomViewer({ entry, props }: { entry: ViewerEntry; props: ViewerProps }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const live = useRef(props);
  live.current = props;
  const handle = useRef<ReturnType<typeof asHandle> | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [remount, setRemount] = useState(0);
  const fileObj = (): ViewerFile => {
    const p = live.current;
    return {
      path: p.file,
      rel: relToVault(useStore.getState().vaultPath, p.file),
      ext: p.ext,
      type: p.type,
      content: p.content,
      mode: p.mode,
      pane: p.paneId ?? null,
      rev: p.rev,
      bytes: async () => new Uint8Array(await invoke<number[]>("read_binary_file", { path: p.file })),
      save: (text: string) => {
        if (typeof text === "string" && live.current.file === p.file) live.current.onChange(text);
      },
      scrolled: (pos) => noteScroll(p.file, pos ?? {}),
      select: (text, lines) => {
        if (typeof text === "string" && text.trim()) publishContext({ selection: { kind: "file", path: p.file, text, ...(lines ? { lineStart: lines.start, lineEnd: lines.end } : {}) } });
        else if (contextNow().selection?.kind === "file") publishContext({ selection: null });
      },
    };
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !entry.mount) return;
    let h: ReturnType<typeof asHandle> = {};
    try {
      h = asHandle(entry.mount(el, fileObj()));
    } catch (e) {
      setErr(e ?? new Error("the viewer threw"));
    }
    handle.current = h;
    const z = h.zoom;
    const offZoom =
      z && typeof z.get === "function" && typeof z.set === "function"
        ? registerZoom(props.file, {
            get: () => Number(z.get()) || 1,
            set: (v) => {
              try {
                z.set(v);
              } catch (e) {
                setErr(e ?? new Error("the viewer's zoom threw"));
              }
            },
            min: typeof z.min === "number" && z.min > 0 ? z.min : 0.1,
            max: typeof z.max === "number" && z.max > 0 ? z.max : 10,
          })
        : null;
    return () => {
      offZoom?.();
      handle.current = null;
      try {
        h.unmount?.();
      } catch {
        /* its cleanup's problem */
      }
      el.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, props.file, props.rev, remount]);
  // The text or the mode changed (the editor, a reload): told, or drawn afresh.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h = handle.current;
    if (!h) return;
    if (!h.update) {
      setRemount((n) => n + 1);
      return;
    }
    try {
      h.update(fileObj());
    } catch (e) {
      setErr(e ?? new Error("the viewer's update threw"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content, props.mode]);
  // Show / ScrollTo on this file: the viewer's own scrollTo, which says where it landed.
  const pending = useStore((s) => s.pendingScrollAnchor);
  useEffect(() => {
    if (!pending || pending.path !== props.file) return;
    const h = handle.current;
    useStore.getState().clearScrollAnchor();
    if (!h?.scrollTo) {
      reportScroll(props.file, `Error: ${entry.name} (the viewer drawing this file) does not scroll to a place; the file is open.`);
      return;
    }
    try {
      const out = h.scrollTo(decodeTarget(pending.anchor) as Record<string, unknown>);
      reportScroll(props.file, typeof out === "string" && out ? out : "Scrolled.");
    } catch (e) {
      reportScroll(props.file, `Error: ${String((e as Error)?.message ?? e)}`);
    }
  }, [pending, props.file, entry]);
  if (err) throw err;
  return <div ref={ref} data-el="viewer-plugin" data-viewer={entry.id} data-file={props.file} className="flex-1 min-h-0 overflow-auto" />;
}

// ---------------------------------------------------------------- the plain fallback

/** No viewer left for this file (every one off, or each threw): its text, or what happened, and a way back. */
function FallbackViewer({ props, chain, error, retry }: { props: ViewerProps; chain: readonly ViewerEntry[]; error: string | null; retry: () => void }) {
  const name = props.file.split(/[\\/]/).pop() ?? props.file;
  const builtinOff = !chain.length;
  return (
    <div data-el="viewer-fallback" className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-6 py-2 border-b border-border/50 text-[11.5px] text-muted-foreground shrink-0">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate" title={error ?? ""}>
          {builtinOff ? `The ${props.type} viewer is turned off; ${name} as plain text.` : `The viewer stopped on ${name}${error ? `: ${error}` : ""}.`}
        </span>
        {builtinOff ? (
          <button data-offer="app/viewer.enable" type="button" data-el="viewer-turn-on" onClick={() => void enableViewer(`builtin:${props.type}`)} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 hover:text-foreground">
            Turn on
          </button>
        ) : (
          <button data-offer="app/titlebar.reloadPart" type="button" data-el="viewer-reload" onClick={retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 hover:text-foreground">
            Reload
          </button>
        )}
      </div>
      <pre className="flex-1 overflow-auto px-6 py-4 text-[12px] font-mono whitespace-pre-wrap break-words">{props.content ? props.content.slice(0, 200_000) : "(not a text file)"}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- the chain

type ChainProps = { chain: readonly ViewerEntry[]; props: ViewerProps };
type ChainState = { level: number; chain: readonly ViewerEntry[]; file: string; rev: number; error: string | null; failing: boolean };
/** Draws the chain's first viewer; one that throws hands the file to the next, the last to the fallback. */
class ViewerBoundary extends Component<ChainProps, ChainState> {
  state: ChainState = { level: 0, chain: this.props.chain, file: this.props.props.file, rev: this.props.props.rev, error: null, failing: false };
  static getDerivedStateFromProps(p: ChainProps, s: ChainState) {
    // Another viewer, another file, or the file changed on disk: start again from the best one.
    return p.chain !== s.chain || p.props.file !== s.file || p.props.rev !== s.rev ? { level: 0, chain: p.chain, file: p.props.file, rev: p.props.rev, error: null, failing: false } : null;
  }
  // The recovery render draws nothing (a viewer that throws while rendering, e.g. a lazy editor that failed to load,
  // would throw again); componentDidCatch then moves on to the next in line.
  static getDerivedStateFromError() {
    return { failing: true };
  }
  componentDidCatch(err: unknown) {
    const v = this.props.chain[this.state.level];
    if (v) noteViewerFailure(v.id, err);
    console.warn(`[viewer] ${v?.id ?? "fallback"} failed on ${this.props.props.file}:`, err);
    this.setState((s) => ({ level: s.failing ? s.level + 1 : s.level, failing: false, error: String((err as Error)?.message ?? err).slice(0, 300) }));
  }
  render(): ReactNode {
    if (this.state.failing) return null;
    const v = this.props.chain[this.state.level];
    if (!v) return <FallbackViewer props={this.props.props} chain={this.props.chain} error={this.state.error} retry={() => this.setState({ level: 0, error: null, failing: false })} />;
    if (v.mount) return <DomViewer entry={v} props={this.props.props} />;
    const C = v.component as ComponentType<ViewerProps>;
    return <C {...this.props.props} />;
  }
}

/** The file drawn by its viewer chain (the editor in edit mode is the pane's choice: SourceEditor). */
export function ViewerBody({ chain, props }: ChainProps) {
  return <ViewerBoundary chain={chain} props={props} />;
}
