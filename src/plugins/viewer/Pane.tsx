// The viewer's pane (part `pane` of app/viewer, src/plugins/viewer): the header (the file's path, "Changed by the agent"
// with Reload / Keep mine, the view / edit toggle, Close pane), the file drawn by the viewer the registry names
// (./builtins.tsx ViewerBody; edit mode is the source editor, EDITOR_CHAIN: the live markdown editor, Monaco otherwise),
// saving as Carl types, live reload, Ctrl+L / the marquee in a viewer, ScrollTo on a rendered note. Moved here from
// src/MarkdownView.tsx unchanged; src/MarkdownView.tsx mounts it through the plugin host (its props: the pane's id), and
// draws this same component in the app's tree while the records are unknown or the plugin is off. Each pane registers
// its Reload / Keep mine with ./panes.ts for the offers.
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isBoxPath, readTextAt, writeTextAt } from "../../boxFiles";
import { editorWrites } from "../../saveBeforeSend";
import { FileText, Eye, Pencil, X } from "lucide-react";
import { useStore } from "../../store";
import { EDITOR_CHAIN, ViewerBody, type ViewerProps } from "./builtins";
import { editable, subscribeViewers, viewerChain, viewersVersion } from "../../viewerRegistry";
import { VAULT_PANE_MIME } from "../../dnd";
import { InlineEditPrompt, type InlineEditRequest } from "../../InlineEditPrompt";
import { fileKind } from "../../fileKind";
import { landMarkdown, reportScroll } from "../../scrollTarget";
import { decodeTarget } from "../../viewTarget";
import { findVaultFileByTail, tryOpenLink } from "../../linkNav";
import { noteEditedFile } from "../../commit-controller";
import { applyDiskContent, pendingBoxText, registerDirty, setDiskChanged, useLiveFiles } from "../../liveReload";

import { flipNthTaskCheckbox, localPathFromUrl } from "../../mdPipeline";
import { hit } from "../../shortcuts";
import { NotePre, useNoteSource } from "../../NoteWidget";
import { registerPane } from "./panes";

function resolveRelative(baseFile: string, rel: string): string {
  const sep = baseFile.includes("\\") ? "\\" : "/";
  const baseParts = baseFile.slice(0, baseFile.lastIndexOf(sep)).split(sep);
  const relParts = rel.replace(/^\.\/+/, "").split(/[\/\\]/);
  for (const p of relParts) {
    if (p === "..") baseParts.pop();
    else if (p && p !== ".") baseParts.push(p);
  }
  return baseParts.join(sep);
}

// Render anchors safely: for internal links (vault://, relative paths)
// we strip the real href attribute so the webview cannot navigate under
// any circumstance — the global click handler in App reads the original
// href from `data-href`. External links keep their href so the default
// browser tooltip shows the URL on hover.
function SafeAnchor(props: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const { href, children, node: _node, onClick: _oc, ...rest } = props;
  if (!href) return <a {...rest}>{children}</a>;
  if (href.startsWith("#")) {
    // In-page anchor. The viewer has its own scroll container, so
    // the browser's default hash-nav doesn't work — scroll the target
    // element into view manually.
    const onHash = (e: ReactMouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      if (!id) return;
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    return <a href={href} {...rest} onClick={onHash}>{children}</a>;
  }
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("[SafeAnchor] click href=", href);
    tryOpenLink(href).catch((err) => console.error("[link] failed:", err));
  };
  const isExternal = /^(https?:|mailto:)/i.test(href);
  if (isExternal) {
    return <a href={href} {...rest} onClick={onClick}>{children}</a>;
  }
  return (
    <a
      role="link"
      data-href={href}
      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
      title={href}
      {...rest}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

// Renders an <img> whose src has been resolved relative to the current
// vault file and read off disk into a blob URL. The webview can't load
// local file:// URLs directly, so we always go through read_binary_file.
// Wrapped in memo so a parent re-render (mode toggle, scroll ratio
// update, sibling state change) doesn't re-fire the disk-read effect
// for every image in the document.
const VaultImage = memo(function VaultImage({ src, alt, ...rest }: ComponentPropsWithoutRef<"img">) {
  const currentFile = useStore((s) => s.currentFile);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setFailed(null);
    if (!src || !currentFile) return;
    // External / data / blob URLs — leave alone.
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setUrl(src);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    // `assets/my%20plot.png` (markdown percent-encodes a path with spaces)
    // is the file "assets/my plot.png".
    const cleaned = localPathFromUrl(src);
    const resolved = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)
      ? cleaned
      : resolveRelative(currentFile, cleaned);
    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path: resolved });
        if (cancelled) return;
        const dot = resolved.lastIndexOf(".");
        const ext = dot > 0 ? resolved.slice(dot + 1).toLowerCase() : "";
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "png"
                ? "image/png"
                : ext === "gif"
                  ? "image/gif"
                  : ext === "webp"
                    ? "image/webp"
                    : ext === "bmp"
                      ? "image/bmp"
                      : ext === "ico"
                        ? "image/x-icon"
                        : `image/${ext || "png"}`;
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        // Not where the link points: a vault file of that name (an Obsidian
        // `![[shot.png]]` lives in an attachments folder).
        const byName = findVaultFileByTail(cleaned);
        if (byName && byName !== resolved) {
          try {
            const bytes = await invoke<number[]>("read_binary_file", { path: byName });
            if (cancelled) return;
            const ext = byName.slice(byName.lastIndexOf(".") + 1).toLowerCase();
            const blob = new Blob([new Uint8Array(bytes)], { type: ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}` });
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
            return;
          } catch {
            // fall through to the not-found mark
          }
        }
        if (!cancelled) setFailed(resolved);
        console.warn("vault-chat: failed to load image:", resolved, err);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, currentFile]);

  if (failed) {
    // Say it plainly: a missing image, not bracketed text that reads like a
    // footnote (the chat shows the same mark).
    return (
      <span className="text-muted-foreground italic text-[12px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block" data-el="image-missing">
        image not found: {src}
        {alt ? ` (${alt})` : ""}
      </span>
    );
  }
  if (!url) return <span className="text-muted-foreground italic">[{alt || src}]</span>;
  return <img src={url} alt={alt} data-src={src} {...rest} />;
});

// Publishes the visible-text window for follow-along voice mode.
// Slices a ~4000-char chunk centered on the scroll offset so the
// agent receives what the user can actually see, not the whole file.
const VIEWPORT_WINDOW = 4000;
function publishTextViewport(
  path: string | null,
  content: string,
  ratio: number,
): void {
  if (!path) return;
  const offset = Math.floor(ratio * content.length);
  const half = VIEWPORT_WINDOW / 2;
  const start = Math.max(0, offset - half);
  const end = Math.min(content.length, offset + half);
  let visible = content.slice(start, end);
  if (start > 0) visible = "[...earlier content omitted...]\n" + visible;
  if (end < content.length) visible = visible + "\n[...later content omitted...]";
  useStore.getState().setViewport({
    path,
    scrollRatio: ratio,
    visibleText: visible,
  });
}

type Props = { paneId?: string };
const NO_CHAIN: readonly never[] = [];

export function Pane({ paneId }: Props) {
  const currentFile = useStore((s) => s.currentFile);
  const currentContent = useStore((s) => s.currentContent);
  const panes = useStore((s) => s.panes);
  const activePaneId = useStore((s) => s.activePaneId);
  const globalMode = useStore((s) => s.mode);
  const toggleGlobalMode = useStore((s) => s.toggleMode);
  const togglePaneMode = useStore((s) => s.togglePaneMode);
  const reloadCurrent = useStore((s) => s.reloadCurrent);
  const setActivePane = useStore((s) => s.setActivePane);
  const closePane = useStore((s) => s.closePane);
  const updatePaneContent = useStore((s) => s.updatePaneContent);

  const pane = paneId ? panes.find((p) => p.id === paneId) : null;
  const file = pane ? pane.file : currentFile;
  const content = pane ? pane.content : currentContent;
  // A live inline popover can pin this absolute-path file while the tree
  // navigates to another vault. Its autosave/read barrier still owns the file's root.
  const fileWorkspace = useRef({ file, vault: useStore.getState().vaultPath });
  if (fileWorkspace.current.file !== file) fileWorkspace.current = { file, vault: useStore.getState().vaultPath };
  // Each pane carries its own view/edit mode so split panes can show
  // one rendered + one editor at the same time.
  const mode = pane ? pane.mode : globalMode;
  const toggleMode = paneId ? () => togglePaneMode(paneId) : toggleGlobalMode;
  const isActive = paneId ? paneId === activePaneId : true;
  const inSplit = panes.length > 0;

  // The viewer the registry names for this file (src/viewerRegistry.ts), live: a plugin's viewer on or off redraws the
  // pane. Ctrl+E switches an editable type to the source editor; code's viewer is the editor itself.
  useSyncExternalStore(subscribeViewers, viewersVersion, viewersVersion);
  const keys = file ? fileKind(file) : null;
  const chain = keys ? viewerChain(keys.kind, keys.ext) : NO_CHAIN;
  const top = chain[0];
  const canEdit = !!keys && editable(keys.kind);
  const editing = !!keys && ((canEdit && mode === "edit") || !!top?.alwaysEdits);

  const lastSaved = useRef<string>(content);
  // The most recent value the *user* produced via onChange. Lets us tell
  // a user edit apart from an external buffer swap (agent reload after a
  // run, voice-tool write, sync). See the [content] effect below.
  const lastUserValue = useRef<string>(content);
  const scrollRatioRef = useRef(0);
  const viewScrollRef = useRef<HTMLDivElement | null>(null);
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);

  useEffect(() => {
    lastSaved.current = content;
    lastUserValue.current = content;
    scrollRatioRef.current = 0;
    // Publish viewport for the freshly-opened file so voice mode's
    // follow-along contextual update fires even before the user has
    // scrolled. Without this, switching files mid-session leaves the
    // agent thinking you're still on the previous file.
    publishTextViewport(file, content, 0);
  }, [file]);

  // Live refresh (liveReload.ts): typing not yet on disk keeps an agent's
  // change from replacing this buffer — the header offers Reload instead.
  useEffect(() => (file ? registerDirty(file, () => lastUserValue.current !== lastSaved.current) : undefined), [file]);
  const normFile = file ? file.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const diskChanged = useLiveFiles((s) => !!(normFile && s.diskChanged[normFile]));
  const rev = useLiveFiles((s) => (normFile ? s.revs[normFile] ?? 0 : 0));

  // When the buffer is replaced by something other than the user typing
  // — the agent reloading the open file after a run, a voice-tool write,
  // an external-sync reload — the new content IS the on-disk truth, so
  // advance `lastSaved` to match. Without this, the autosave's
  // external-mutation guard later sees disk != stale lastSaved, mistakes
  // the agent's own (already-loaded) change for an unsynced external
  // edit, and "reloads" — clobbering the user's in-progress edit and
  // scrolling to the top. User edits route through onChange, which keeps
  // lastUserValue === content, so this no-ops for them.
  useEffect(() => {
    if (content !== lastUserValue.current) {
      lastSaved.current = content;
      lastUserValue.current = content;
      if (file) editorWrites.discard(file);
    }
  }, [content]);

  useLayoutEffect(() => {
    const el = viewScrollRef.current;
    if (!el) return;
    const ratio = scrollRatioRef.current;
    if (ratio <= 0) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = ratio * max;
  }, [mode, file]);

  const onViewScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    scrollRatioRef.current = ratio;
    publishTextViewport(file, content, ratio);
  };

  const onChange = (value: string) => {
    // Editors fire onChange both for user edits and for programmatic
    // value-prop changes (LiveEditor's [value] effect, Monaco's
    // wrapper setValue). The LiveEditor case is filtered upstream via
    // an ExternalSet annotation; this guard catches the Monaco case
    // and any other echo. Without it, switching files quickly could
    // cause the new file's content to be saved against the previous
    // file's path — which is how daily.md once ended up with
    // boosting-loop.md's content.
    if (value === content) return;
    lastUserValue.current = value;
    // What's in view changed with the typing (a paste, an edit): voice's
    // follow-along sees it now, not at the next scroll.
    publishTextViewport(file, value, scrollRatioRef.current);
    if (paneId) {
      updatePaneContent(paneId, value);
    } else {
      reloadCurrent(file ?? "", value);
    }
    if (!file) return;
    const vault = fileWorkspace.current.vault;
    if (!vault) return;
    editorWrites.queue({ vault, path: file, text: value }, lastSaved.current, () => {
      const live = useStore.getState();
      const livePath = paneId ? live.panes.find(p => p.id === paneId)?.file : live.currentFile;
      if (livePath === file) lastSaved.current = value;
      if (!isBoxPath(file)) noteEditedFile(file);
    }, () => setDiskChanged(file, true));
  };

  const reloadFromDisk = async () => {
    if (!file) return;
    try {
      await editorWrites.discard(file);
      // Box mode: the box's copy when it is ahead of this disk (a live edit not merged yet).
      const onDisk = pendingBoxText(file) ?? (await readTextAt(file));
      lastSaved.current = onDisk;
      lastUserValue.current = onDisk;
      editorWrites.discard(file);
      applyDiskContent(file, onDisk);
    } catch (e) {
      console.error("reload failed", e);
    }
  };
  const keepMine = async () => {
    if (!file) return;
    try {
      await editorWrites.discard(file);
      await writeTextAt(file, content);
      const vault = fileWorkspace.current.vault;
      if (vault) editorWrites.queue({ vault, path: file, text: content }, content, () => {}, () => setDiskChanged(file, true));
      lastSaved.current = content;
      lastUserValue.current = content;
      setDiskChanged(file, false);
      if (!isBoxPath(file)) noteEditedFile(file);
    } catch (e) {
      console.error("save failed", e);
    }
  };

  // The header's Reload / Keep mine, for app/viewer's offers (./panes.ts): the newest of each.
  const headerActs = useRef({ reloadFromDisk, keepMine });
  headerActs.current = { reloadFromDisk, keepMine };
  useEffect(
    () => (file ? registerPane(file, { paneId: paneId ?? null, reloadFromDisk: () => headerActs.current.reloadFromDisk(), keepMine: () => headerActs.current.keepMine() }) : undefined),
    [file, paneId],
  );

  const onPaneClick = () => {
    if (paneId && !isActive) setActivePane(paneId);
  };

  const onHeaderDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!paneId) return;
    e.dataTransfer.setData(VAULT_PANE_MIME, paneId);
    e.dataTransfer.effectAllowed = "move";
  };

  // GFM task checkboxes render as <input type="checkbox" disabled> via
  // remark-gfm. We override the input component to make them interactive:
  // on toggle, locate the clicked checkbox's index among all rendered
  // checkboxes, flip the Nth task-list token in the source, and save.
  //
  // Read content + onChange via refs so the renderer function itself
  // stays referentially stable. ReactMarkdown's `components` prop is
  // memoized below — handing it a fresh function each render would
  // tear down and rebuild the entire rendered subtree.
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const renderInput = useCallback(
    (props: ComponentPropsWithoutRef<"input"> & { node?: unknown }) => {
      const { node: _node, type, disabled: _disabled, checked, onChange: _oc, ...rest } = props;
      if (type !== "checkbox") {
        return <input type={type} disabled={_disabled} {...rest} />;
      }
      const onFlip = (e: ReactMouseEvent<HTMLInputElement>) => {
        const scope = viewScrollRef.current;
        if (!scope) return;
        const all = Array.from(
          scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        );
        const idx = all.indexOf(e.currentTarget);
        if (idx < 0) return;
        const next = flipNthTaskCheckbox(contentRef.current, idx);
        if (next == null) return;
        // Flip the visual immediately so the click feels instant; the
        // expensive markdown re-render that follows runs as a transition,
        // off the input-handling path, so the cursor never lags.
        e.currentTarget.checked = !e.currentTarget.checked;
        startTransition(() => onChangeRef.current(next));
      };
      return (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={() => {}}
          onClick={onFlip}
          style={{ cursor: "pointer" }}
          {...rest}
        />
      );
    },
    [],
  );
  const markdownComponents = useMemo(
    () => ({ a: SafeAnchor, img: VaultImage, input: renderInput, pre: NotePre }),
    [renderInput],
  );

  // Ctrl+L in view mode opens the inline ask popover, using any text
  // the user has highlighted in the rendered markdown as the selection.
  // Only the active pane responds, so multi-pane doesn't double-fire.
  useEffect(() => {
    if (!file) return;
    const scroller = viewScrollRef.current;
    if (!scroller) return;
    const { kind: k, ext: e2 } = fileKind(file);
    if (editing || k !== "markdown" || !isActive) return;

    const onKey = (e: KeyboardEvent) => {
      if (!hit(e, "edit.ask")) return;

      const sel = window.getSelection();
      const selectionText = sel && !sel.isCollapsed ? sel.toString() : "";

      // Anchor: bottom of the selection if present, else the viewer's
      // visible center-ish as a graceful fallback.
      let anchor: InlineEditRequest["anchor"];
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
      } else {
        const r = scroller.getBoundingClientRect();
        anchor = {
          left: r.left + 40,
          top: r.top + r.height * 0.25,
          bottom: r.top + r.height * 0.25 + 20,
        };
      }

      // Context: if there's a selection, try to locate it in the source
      // content to slice before/after. Fall back to the whole file
      // being "before" if we can't find it (whitespace or formatting
      // normalization can make exact matches miss).
      let before = content;
      let after = "";
      if (selectionText) {
        const idx = content.indexOf(selectionText);
        if (idx >= 0) {
          before = content.slice(Math.max(0, idx - 6000), idx);
          after = content.slice(
            idx + selectionText.length,
            Math.min(content.length, idx + selectionText.length + 6000),
          );
        } else {
          before = content.slice(-6000);
        }
      } else {
        before = content.slice(-6000);
      }

      e.preventDefault();
      setInlineAsk({
        anchor,
        selection: selectionText,
        before,
        after,
        language: e2,
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, top, file, isActive, content]);

  // Ctrl+L ask (no context) for PDF, HTML, and image viewers. These don't
  // have a meaningful source-text window to slice like markdown does, so
  // we open the prompt with empty before/after — the user's question
  // stands on its own.
  useEffect(() => {
    if (!file || !isActive) return;
    const { kind: k, ext: e2 } = fileKind(file);
    const hasMarquee = k === "pdf" || k === "html" || k === "image";
    const hasNoContextAsk = hasMarquee || k === "notebook";
    if (!hasNoContextAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if (hit(e, "edit.marquee") && hasMarquee) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
        return;
      }
      if (!hit(e, "edit.ask")) return;
      e.preventDefault();
      setInlineAsk({
        anchor: {
          left: window.innerWidth * 0.5,
          top: window.innerHeight * 0.4,
          bottom: window.innerHeight * 0.4 + 20,
        },
        selection: "",
        before: "",
        after: "",
        language: e2,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, isActive]);

  // ScrollTo (voice) on a rendered markdown file: its heading, id or a phrase; the tool hears the outcome.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  // The note its widgets read and follow (src/NoteWidget.tsx): one per file, its text kept current.
  const noteSource = useNoteSource(file && fileKind(file).kind === "markdown" ? file : null, content);
  useEffect(() => {
    const req = pendingScrollAnchor;
    if (!req || !file || req.path !== file || fileKind(file).kind !== "markdown") return;
    // A plugin's viewer of markdown takes the request itself (src/plugins/viewer/builtins.tsx DomViewer).
    if (!editing && top?.id !== "builtin:markdown") return;
    if (paneId && !isActive && panes.some((p) => p.id === activePaneId && p.file === file)) return; // the active pane shows it too: that one moves
    const t = decodeTarget(req.anchor);
    // A source line while editing: the editor itself goes there (LiveEditor takes the request).
    if (editing && t.line !== undefined) return;
    useStore.getState().clearScrollAnchor();
    if (editing) {
      reportScroll(file, landMarkdown(null, content, req.anchor, file, true));
      return;
    }
    // After a render (a file just opened by this request has not drawn yet). A source line: the heading on it, else its first words.
    requestAnimationFrame(() => reportScroll(file, landMarkdown(viewScrollRef.current, content, req.anchor, file, false)));
  }, [pendingScrollAnchor, file, editing, top, paneId, isActive, panes, activePaneId, content]);

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">Open a vault and pick a file to get started.</p>
        </div>
      </div>
    );
  }

  const relPath = file.split("/").slice(-3).join(" › ");
  const showActiveOutline = inSplit && isActive;
  const { kind, ext } = keys!;
  // A view / edit toggle where Ctrl+E edits the type (markdown and .tex by default: rendered prose / compiled PDF vs.
  // raw source), except where the viewer is the editor itself (code). Editor visibility tracks the pane's own mode. The
  // previous `&& isActive` gate (kept editor mounted only on the active pane) unmounted LiveEditor whenever focus moved
  // elsewhere — which broke the inline-edit Accept button: the floating popup outlived the editor, but its dispatch had
  // no view to dispatch into and silently no-op'd. Per-pane mode is the user's intent for what each pane shows;
  // activation is a separate axis.
  const showToggle = canEdit && !top?.alwaysEdits;
  const toggleHere = () => {
    if (paneId && !isActive) setActivePane(paneId);
    toggleMode();
  };
  const viewerProps: ViewerProps = {
    file,
    content,
    ext,
    type: kind,
    relPath,
    paneId,
    rev,
    mode,
    onChange,
    onToggleMode: toggleHere,
    md: {
      viewScrollRef,
      onViewScroll,
      components: markdownComponents,
      noteSource,
      scrollRatioRef,
      onEditorScrollRatio: (r) => {
        scrollRatioRef.current = r;
        publishTextViewport(file, content, r);
      },
    },
  };

  return (
    <div
      className={`h-full flex flex-col bg-background ${
        showActiveOutline ? "ring-1 ring-primary/40 ring-inset" : ""
      }`}
      onClick={onPaneClick}
      // LookAtScreen reads the focused pane off the page (screenLook.ts).
      data-look-pane={paneId ?? "main"}
      data-file={file}
      data-active={isActive ? "true" : "false"}
      data-mode={showToggle ? (mode === "edit" ? "editing" : "viewing") : ""}
      data-viewer={editing && !top?.alwaysEdits ? "editor" : (top?.id ?? "fallback")}
    >
      {/* A viewer with its own toolbar (PDFs, and .tex in preview mode, which renders a PDF: file path, page count,
          zoom, source toggle) keeps the generic header out, so there's only one bar across the top. */}
      {!(!editing && top?.ownHeader?.(mode)) && (
      <div
        data-look-skip
        className={`flex items-center justify-between px-6 py-2.5 border-b border-border/60 ${
          paneId ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        draggable={!!paneId}
        onDragStart={onHeaderDragStart}
      >
        <div className="text-[11px] font-mono text-muted-foreground truncate select-none flex items-center gap-2">
          <span className="truncate">{relPath}</span>
        </div>
        <div className="flex items-center gap-3">
          {diskChanged && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="disk-changed" draggable={false}>
              Changed by the agent —
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void reloadFromDisk();
                }}
                className="text-primary hover:underline"
                title="Show the file as it is on disk (drops your unsaved typing)"
              >
                Reload
              </button>
              ·
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void keepMine();
                }}
                className="hover:text-foreground hover:underline"
                title="Save your version over the agent's"
              >
                Keep mine
              </button>
            </span>
          )}
          {showToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleHere();
              }}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              title={
                kind === "tex"
                  ? mode === "view"
                    ? "Source (Ctrl+E)"
                    : "Preview PDF (Ctrl+E)"
                  : mode === "view"
                    ? "Edit (Ctrl+E)"
                    : "View (Ctrl+E)"
              }
              draggable={false}
            >
              {mode === "view" ? (
                <>
                  <Eye className="h-3 w-3" /> {kind === "tex" ? "preview" : "view"}
                </>
              ) : (
                <>
                  <Pencil className="h-3 w-3" /> {kind === "tex" ? "source" : "editing"}
                </>
              )}
            </button>
          )}
          {paneId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                closePane(paneId);
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Close pane"
              draggable={false}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      )}
      <ViewerBody chain={editing ? EDITOR_CHAIN : chain} props={viewerProps} />
      {inlineAsk && (
        <InlineEditPrompt
          request={inlineAsk}
          onAccept={() => setInlineAsk(null)}
          onCancel={() => setInlineAsk(null)}
        />
      )}
    </div>
  );
}
