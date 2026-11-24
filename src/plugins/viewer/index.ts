// The viewer as a plugin the agent reaches (src/appPlugins.ts VIEWER_PLUGIN, app/viewer): mounted by the viewer area
// (src/MarkdownArea.tsx), it draws nothing of its own (each file is drawn by the viewer the registry names,
// src/viewerRegistry.ts, in the pane ./Pane.tsx (part `pane`, mounted per pane by src/MarkdownView.tsx), with the app's own viewers in ./builtins.tsx) and declares
// what it offers through api.offer: the files open (pane, type, the viewer drawing each, view / edit mode, where each
// is scrolled, its zoom), the viewers of each type and which types Ctrl+E edits as state; open, scrollTo, find, zoom,
// setMode, use, disable, enable and setOption as actions; opened, scrolled, modeChanged and changed as events. Turned off, the agent cannot
// reach it and files still draw.
//
// An in-process page draws a type its own way with api.host.viewer(type, mount) (src/hostApi.ts). The choices (a viewer
// off, the one chosen for a type, a type made editable) are kept on the box (./prefs.ts). The active pane's file is
// published to the shared context (api.context, file).
import type { PluginApi } from "../../mountHost";
import type { Offers } from "../../pluginOffers";
import { useStore } from "../../store";
import { fileKind } from "../../fileKind";
import { PANE_SIDES, relToVault, type PaneSide } from "../../paneLayout";
import { showOnLaptop } from "../../showOnLaptop";
import { TARGET_KEYS, type ViewTarget } from "../../viewTarget";
import {
  describeModes,
  describeViewers,
  editable,
  fileViewerKeys,
  subscribeViewers,
  viewerById,
  viewerChain,
  viewerKey,
  viewerOptionProblem,
} from "../../viewerRegistry";
import { OFF, OPT, USE, keep, viewerPrefs } from "./prefs";
import { followScroll, onScroll, scrollOf } from "./scroll";
import { onZoomMoved, setZoomOf, zoomOf } from "./zoom";
import { onVideoChanged, videoNamed, videosNow } from "../../videoState";
import { onTexChanged, recompileTex, texOf } from "../../texState";
import { captureNow, startCapture, type CaptureFor } from "../../capture";
import { answerPrompt, livePagesNow, onLivePagesChanged, stopPageMic } from "../../livePagesState";
import { textOfFrame } from "../../pageSnap";
import { closeTracked } from "../../trackedOpen";
import { onOutsideOpened, openOutside, outsideOpened, type OutsideHow } from "../../opener";
import { onPaneEvent, paneOf } from "./panes";
import { useLiveFiles } from "../../liveReload";
import "./builtins"; // the app's own viewers register with the registry
import { caretOf, editorOf, onEditorChanged, onSaved } from "../../editorState";
import { editorWrites } from "../../saveBeforeSend";
export { pane } from "./mountPane";

followScroll();

const S = () => useStore.getState();
const rel = (p: string) => relToVault(S().vaultPath, p);
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

type Open = { pane: PaneSide | "main"; paneId: string | null; file: string; content: string; mode: "view" | "edit"; active: boolean };

/** The files open now: the one viewer, or the split's two panes. */
function openNow(): Open[] {
  const s = S();
  if (s.panes.length >= 2) {
    return s.panes.slice(0, 2).map((p, i) => ({ pane: PANE_SIDES[i]!, paneId: p.id, file: p.file, content: p.content, mode: p.mode, active: p.id === s.activePaneId }));
  }
  return s.currentFile ? [{ pane: "main", paneId: null, file: s.currentFile, content: s.currentContent, mode: s.mode, active: true }] : [];
}

/** The viewer drawing an open file now: "editor" (the source editor, Ctrl+E), a viewer's id, or "fallback". */
function drawnBy(o: Pick<Open, "file" | "mode">): string {
  const { type, ext } = fileViewerKeys(o.file);
  const top = viewerChain(type, ext)[0];
  if (top?.alwaysEdits) return top.id;
  if (editable(type) && o.mode === "edit") return "editor";
  return top?.id ?? "fallback";
}

/** The header's "Changed … — Reload · Keep mine": the file changed underneath this pane's unsaved typing and the two
 *  could not merge. Who changed it, when known: "agent" (its write on the box), "box" (a sync merge), else "outside". */
const changedBy = (file: string) => useLiveFiles.getState().diskChanged[file.replace(/\\/g, "/").replace(/\/+$/, "")];
const changedOnDisk = (file: string) => !!changedBy(file);

function describeOpen(o: Open) {
  const { type, ext } = fileViewerKeys(o.file);
  const canEdit = editable(type) && !viewerChain(type, ext)[0]?.alwaysEdits;
  const pos = scrollOf(o.file);
  const scroll: Record<string, unknown> = {};
  if (pos) {
    for (const k of ["ratio", "page", "totalPages", "line"] as const) if (pos[k] !== undefined) scroll[k] = pos[k];
    // A rendered note says how far down it is: the source line there, roughly.
    if (scroll.line === undefined && typeof pos.ratio === "number" && (type === "markdown" || type === "code")) {
      const lines = o.content.split("\n").length;
      scroll.line = 1 + Math.round(pos.ratio * Math.max(0, lines - 1));
      scroll.lineApprox = true;
    }
  }
  return {
    pane: o.pane,
    path: rel(o.file),
    type,
    ext,
    viewer: drawnBy(o),
    mode: canEdit ? o.mode : null,
    editable: canEdit,
    active: o.active,
    changedOnDisk: changedOnDisk(o.file),
    ...(changedBy(o.file) ? { changedBy: changedBy(o.file) } : {}),
    ...(Object.keys(scroll).length ? { scroll } : {}),
    ...(zoomOf(o.file) !== null ? { zoom: zoomOf(o.file) } : {}),
    ...(type === "tex" && texOf(o.file) ? { tex: texOf(o.file) } : {}),
    targets: TARGET_KEYS[type] ?? [],
  };
}

/** The open file an action names: a vault-relative path, a pane ("left" / "right" / "main"), else the active one. */
function openFor(a: Record<string, unknown>): Open {
  const list = openNow();
  if (!list.length) throw new Error("no file is open in the viewer");
  if (typeof a.path === "string" && a.path.trim()) {
    const want = norm(a.path.trim());
    const hit = list.find((o) => norm(rel(o.file)) === want || norm(o.file) === want);
    if (!hit) throw new Error(`${a.path} is not open (open: ${list.map((o) => rel(o.file)).join(", ")}); open it first`);
    return hit;
  }
  if (typeof a.pane === "string" && a.pane) {
    const hit = list.find((o) => o.pane === a.pane);
    if (!hit) throw new Error(`no "${a.pane}" pane (panes: ${list.map((o) => o.pane).join(", ")})`);
    return hit;
  }
  return list.find((o) => o.active) ?? list[0]!;
}

const TARGET_PROPS = {
  page: { type: "integer", minimum: 1, description: "PDF: a 1-based page." },
  line: { type: "integer", minimum: 1, description: "Markdown / code: a source line." },
  endLine: { type: "integer", minimum: 1, description: "Code: the range's last line (highlighted)." },
  heading: { type: "string", description: "Markdown / HTML: a heading's text or slug." },
  text: { type: "string", description: "A phrase: the first place with it." },
  anchor: { type: "string", description: "HTML: an element id." },
  cell: { type: "integer", minimum: 1, description: "Notebook: a 1-based cell." },
} as const;
const targetOf = (a: Record<string, unknown>): ViewTarget => {
  const t: Record<string, unknown> = {};
  for (const k of Object.keys(TARGET_PROPS)) if (a[k] !== undefined && a[k] !== null && a[k] !== "") t[k] = a[k];
  return t as ViewTarget;
};

/** Open (or scroll) through Show's own path: the same landing and the same answer the agent's Show gets. */
async function show(path: string, target: ViewTarget, pane?: PaneSide, vault?: string) {
  const ack = await showOnLaptop({ type: "show", id: "app/viewer", path, target, ...(pane ? { pane } : {}), ...(vault ? { vault } : {}) }, { answerMs: 8000 });
  if (!ack.ok) throw new Error(ack.error ?? "it could not be shown");
  return { landed: ack.landed, ...(ack.pane ? { pane: ack.pane } : {}) };
}

const FIND_MAX = 20;
/** The lines of a text holding `q` (case-insensitive): 1-based line numbers and the line (trimmed), at most FIND_MAX. */
export function findLines(content: string, q: string): { count: number; matches: { line: number; text: string }[] } {
  const want = q.toLowerCase();
  const matches: { line: number; text: string }[] = [];
  let count = 0;
  content.split("\n").forEach((l, i) => {
    if (!l.toLowerCase().includes(want)) return;
    count++;
    if (matches.length < FIND_MAX) matches.push({ line: i + 1, text: l.trim().slice(0, 160) });
  });
  return { count, matches };
}

const PANE_ARGS = { type: "object", properties: { path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } }, additionalProperties: false };
// The pane actions' events, to the mounted offers.
let paneEvent: (name: string, data: unknown) => void = () => {};

/** What the editors hold that the disk does not show yet: per open file its caret and whether it has unsaved typing;
 *  and any other file whose typing is not saved yet (src/editorState.ts, src/editorWrites.ts). */
export function describeEditing() {
  const pending = new Map(editorWrites.pending().map((p) => [slashed(p.path), p]));
  const open = openNow().map((o) => {
    const p = pending.get(slashed(o.file));
    pending.delete(slashed(o.file));
    const c = caretOf(o.file);
    return { pane: o.pane, path: rel(o.file), unsaved: !!p, conflict: changedOnDisk(o.file), ...(c ? { caret: { line: c.line, col: c.col, selected: c.selected, at: c.at } } : {}) };
  });
  return { open, otherUnsaved: [...pending.values()].map((p) => rel(p.path)) };
}
const slashed = (p: string) => p.replace(/\\/g, "/");

/** Select the first place showing `text` in the pane drawing `file` (a rendered note, an HTML page drawn in the app, a
 *  PDF's text layer), as a drag would: the document's selection, which app/context publishes. */
function selectOnScreen(file: string, text: string): boolean {
  const root = [...document.querySelectorAll<HTMLElement>("[data-file]")].find((el) => el.dataset.file === file);
  if (!root) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n.nodeValue ?? "").indexOf(text);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + text.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    (n.parentElement as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
    return true;
  }
  return false;
}

/** The plugin's offers (exported for tests). */
export function viewerOffers(): Offers {
  return {
    watch: (fn: () => void) => {
      const offs = [onLivePagesChanged(fn), useStore.subscribe(fn), useLiveFiles.subscribe(fn), onScroll(() => fn()), subscribeViewers(fn), onZoomMoved(fn), onVideoChanged(fn), onTexChanged(fn), onEditorChanged(fn), onSaved(() => fn()), onOutsideOpened(() => fn())];
      return () => offs.forEach((f) => f());
    },
    state: {
      videos: {
        description: "The videos on screen (the viewer's, a chat message's): id (the vault path, or a chat video's address), where (viewer | chat), time and duration in seconds, playing, muted, fullscreen. Change one with video.",
        read: () => videosNow(),
      },
      capture: {
        description: "A region capture under way (Carl drags a box over the viewer): who the picture goes to (chat, voice, note, ask) or null. Start one with capture.",
        read: () => ({ for: captureNow() }),
      },
      pages: {
        description: "The live vault pages doing something beyond their own state: a capability prompt waiting for Carl (asking: what it wants), recording from the mic, requests in flight to the box (vc.ask, vc.fetch), the last sound it played. Answer a prompt with grant; stop a recording with stopMic. A page's own state: PluginRead {plugin: <its path>}; its text: pageText.",
        read: () => livePagesNow(),
      },
      outside: {
        description: "The files opened outside the app this session (the default app, File Explorer, the system video player): path, how, at, and while the shell follows its program's window: id, open (closeOutside closes it).",
        read: () => outsideOpened(),
      },
      open: {
        description:
          "The files open in the viewer: per pane (main, or left / right in a split) its path, type, the viewer drawing it (a viewer's id, \"editor\" = the source editor via Ctrl+E, \"fallback\" = plain text), mode (view | edit, null when the type has no edit mode), whether it is the active pane, where it is scrolled (ratio 0..1, page / totalPages for a PDF, line; lineApprox when read off the scroll position), its zoom when its viewer zooms (1 = fit), a .tex preview's compile (compiling, error log, pdf, at) and the targets scrollTo takes for it.",
        read: () => openNow().map(describeOpen),
      },
      viewers: {
        description:
          "Each type of file (markdown, notebook, pdf, tex, html, image, video, unsupported, code) and each extension a plugin draws (\".csv\") with the viewer drawing it (active: builtin:<type> the app's own, app:<type>:<name> an app alternative drawn only when chosen, <plugin id>#<key> a plugin's, fallback = plain text) and every viewer registered for it (name, by, enabled, failures). An in-process page adds one with api.host.viewer(type, mount).",
        read: () => describeViewers(),
      },
      modes: {
        description: "Which types Ctrl+E (and the header's toggle) switches to the source editor: per text type its edit value, default and whether it is set (setOption).",
        read: () => describeModes(),
      },
      kept: {
        description: "The choices kept on the box (the same in every window, after a restart): disabled = viewer ids turned off, chosen = {type or .ext: viewer id}, options = {type: {edit}}.",
        read: () => viewerPrefs(),
      },
      editing: {
        description:
          "What Carl's editors hold that the disk does not show yet: for each open file its caret (line, col, characters selected, when it moved) and whether it has typing not saved yet (the 300 ms autosave) or a save stopped on a conflict; otherUnsaved: files not open with typing not saved. Before you edit a file he has open, read this: if it is unsaved or his caret moved just now, wait for the save (PluginRead {plugin: \"app/viewer\", wait}) rather than writing over him.",
        read: () => describeEditing(),
      },
    },
    actions: {
      open: {
        description:
          "Open a vault file in the viewer (vault: a file of another vault, by its name, which opens as the workspace first; pane: left / right puts it in that pane of a split, turning split on when one other file is open), optionally at a place (page, line, heading, text, anchor, cell, as its type takes them), the way Show does; answers where it landed. An open file is only scrolled.",
        args: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative." }, vault: { type: "string", description: "Another vault (its name, e.g. \"vault-chat\"): opened as the workspace first. Left out: the vault open now." }, pane: { type: "string", enum: ["left", "right"] }, ...TARGET_PROPS },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (a) => {
          const path = String(a.path ?? "").trim().replace(/^[\\/]+/, "");
          if (!path) throw new Error("path is needed (vault-relative)");
          const vault = typeof a.vault === "string" && a.vault.trim() ? a.vault.trim() : undefined;
          return show(path, targetOf(a), (a.pane as PaneSide | undefined) || undefined, vault);
        },
      },
      scrollTo: {
        description:
          "Scroll an open file (path, or pane; the active one when left out) to a place: a PDF's page or text, a note's line, heading or text, code's line (endLine highlights a range), an HTML page's anchor, heading or text, a notebook's cell. Answers where it landed, or the valid range / nearest headings.",
        args: { type: "object", properties: { path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] }, ...TARGET_PROPS }, additionalProperties: false },
        run: async (a) => {
          const o = openFor(a);
          const t = targetOf(a);
          if (!Object.keys(t).length) throw new Error(`a place is needed (a ${fileKind(o.file).kind} file takes: ${(TARGET_KEYS[fileKind(o.file).kind] ?? []).join(", ") || "none: it only opens"})`);
          return show(rel(o.file), t);
        },
      },
      find: {
        description:
          "Find text in an open file (path, or pane; the active one when left out) and scroll to it: a note or code file answers every line holding it (count, up to 20 {line, text}, case-insensitive) and goes to the nth (default 1); a PDF goes to the first page with it, an HTML page or notebook to the first place with it. Answers where it landed.",
        args: {
          type: "object",
          properties: { text: { type: "string" }, nth: { type: "integer", minimum: 1 }, path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } },
          required: ["text"],
          additionalProperties: false,
        },
        run: async (a) => {
          const q = String(a.text ?? "").trim();
          if (!q) throw new Error("text is needed");
          const o = openFor(a);
          const { type } = fileViewerKeys(o.file);
          if (type === "markdown" || type === "code") {
            const f = findLines(o.content, q);
            if (!f.count) return { path: rel(o.file), text: q, count: 0, matches: [] };
            const nth = Math.min(Math.max(1, Number(a.nth) || 1), f.matches.length);
            const line = f.matches[nth - 1]!.line;
            return { path: rel(o.file), text: q, count: f.count, matches: f.matches, at: line, ...(await show(rel(o.file), type === "code" ? { line, endLine: line } : { line })) };
          }
          if (type === "pdf" || type === "html" || type === "notebook") {
            const out: Record<string, unknown> = { path: rel(o.file), text: q };
            if (type !== "pdf") out.count = findLines(o.content, q).count;
            return { ...out, ...(await show(rel(o.file), { text: q })) };
          }
          throw new Error(`a ${type} file has no text to find in`);
        },
      },
      zoom: {
        description:
          "Zoom an open PDF or image (path, or pane; the active one when left out): zoom is a factor (1 = fit the pane; a PDF takes 0.25..5, an image 0.2..8) or \"in\" / \"out\" (one step, ×1.1, as the viewer's + / − buttons) or \"reset\" (its % button). Answers the zoom now; the open state shows it.",
        args: {
          type: "object",
          properties: { zoom: { type: ["number", "string"], description: "A factor, or in / out / reset." }, path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } },
          required: ["zoom"],
          additionalProperties: false,
        },
        run: (a) => {
          const o = openFor(a);
          const z = a.zoom;
          const want = z === "in" || z === "out" || z === "reset" ? z : Number(z);
          return { path: rel(o.file), pane: o.pane, ...setZoomOf(o.file, want) };
        },
      },
      setMode: {
        description: "Switch an open file (path, or pane; the active one when left out) to view or edit (the source editor), as Ctrl+E does. Only a type that Ctrl+E edits (see modes; setOption makes HTML or notebooks editable).",
        args: { type: "object", properties: { mode: { type: "string", enum: ["view", "edit"] }, path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } }, required: ["mode"], additionalProperties: false },
        run: (a) => {
          const o = openFor(a);
          const { type, ext } = fileViewerKeys(o.file);
          if (!editable(type) || viewerChain(type, ext)[0]?.alwaysEdits) {
            throw new Error(type === "code" ? "a code file is always in the editor" : `Ctrl+E does not edit ${type} files${type === "html" || type === "notebook" ? ` (setOption {type: "${type}", key: "edit", value: true} makes it)` : ""}`);
          }
          const want = a.mode === "edit" ? "edit" : "view";
          if (o.mode !== want) {
            if (o.paneId) S().togglePaneMode(o.paneId);
            else S().setMode(want);
          }
          return { path: rel(o.file), pane: o.pane, mode: want };
        },
      },
      reloadFromDisk: {
        description: "The header's Reload, when an open file changed on disk under typing not saved yet and the two could not merge (open: changedOnDisk, changedBy): show the file as it is on disk, dropping that typing. Only when Carl asks.",
        args: PANE_ARGS,
        run: async (a) => {
          const o = openFor(a);
          const h = paneOf(o.file, o.paneId);
          if (!h) throw new Error(`${rel(o.file)} has no pane on screen`);
          await h.reloadFromDisk();
          return { path: rel(o.file), pane: o.pane, reloaded: true };
        },
      },
      keepMine: {
        description: "The header's Keep mine, when an open file changed on disk under typing not saved yet and the two could not merge: save the version on screen over the one on disk. Only when Carl asks.",
        args: PANE_ARGS,
        run: async (a) => {
          const o = openFor(a);
          const h = paneOf(o.file, o.paneId);
          if (!h) throw new Error(`${rel(o.file)} has no pane on screen`);
          await h.keepMine();
          return { path: rel(o.file), pane: o.pane, kept: true };
        },
      },
      video: {
        description: "Control a video on screen (id from videos; left out: the viewer's), as its bar does: play true/false, seek (seconds), muted true/false, fullscreen true/false (the webview may refuse full screen without a click).",
        args: { type: "object", properties: { id: { type: "string" }, play: { type: "boolean" }, seek: { type: "number", minimum: 0 }, muted: { type: "boolean" }, fullscreen: { type: "boolean" } }, additionalProperties: false },
        run: (a) => {
          const v = videoNamed(a.id);
          const n = v.now();
          if (typeof a.seek === "number") v.seekTo(a.seek);
          if (typeof a.play === "boolean" && a.play !== n.playing) v.toggle();
          if (typeof a.muted === "boolean" && a.muted !== n.muted) v.toggleMute();
          if (typeof a.fullscreen === "boolean" && a.fullscreen !== n.fullscreen) v.toggleFull();
          return videosNow().find((x) => x.id === v.id) ?? null;
        },
      },
      recompile: {
        description: "Compile an open .tex file's preview again (as saving it does): its compile state is in open (tex).",
        args: PANE_ARGS,
        run: (a) => {
          const o = openFor(a);
          if (!recompileTex(o.file)) throw new Error(`${rel(o.file)} has no TeX preview on screen (view mode shows it)`);
          return { path: rel(o.file), compiling: true };
        },
      },
      type: {
        description: "Type text into an open file's editor at its caret (replacing what is selected), as Carl's keys do: it saves with the editor's autosave. Only what Carl asks for; to rewrite a file, edit the file. The file must be in the editor (mode edit, or a code file).",
        args: { type: "object", properties: { text: { type: "string" }, path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } }, required: ["text"], additionalProperties: false },
        run: (a) => {
          const o = openFor(a);
          const ed = editorOf(o.file);
          if (!ed) throw new Error(`${rel(o.file)} is not in an editor on screen (setMode edit first)`);
          ed.type(String(a.text ?? ""));
          return { path: rel(o.file), caret: caretOf(o.file) };
        },
      },
      select: {
        description: "Select text in an open file, as Carl's drag does: in an editor by line / col (1-based) to endLine / endCol (a caret when left out); in a rendered note, page or PDF, the first place showing `text` on screen. The selection is what app/context shows and a Ctrl+K box takes.",
        args: { type: "object", properties: { line: { type: "integer", minimum: 1 }, col: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, endCol: { type: "integer", minimum: 1 }, text: { type: "string" }, path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } }, additionalProperties: false },
        run: (a) => {
          const o = openFor(a);
          const ed = editorOf(o.file);
          if (ed && typeof a.line === "number") {
            ed.select(a.line, Number(a.col ?? 1), typeof a.endLine === "number" ? a.endLine : undefined, typeof a.endCol === "number" ? a.endCol : undefined);
            return { path: rel(o.file), caret: caretOf(o.file) };
          }
          if (typeof a.text !== "string" || !a.text) throw new Error(ed ? "line (and col / endLine / endCol) select in the editor" : "text: what to select on screen");
          if (!selectOnScreen(o.file, a.text)) throw new Error(`"${a.text}" is not shown on screen in ${rel(o.file)} (scrollTo it first)`);
          return { path: rel(o.file), selected: a.text };
        },
      },
      capture: {
        description: "Start a region capture, as the Capture buttons and Ctrl+M do: Carl drags a box over the viewer and the picture goes to for: chat (the composer), voice (the voice text panel), note (the note composer) or ask (a Ctrl+K box at the region).",
        args: { type: "object", properties: { for: { type: "string", enum: ["chat", "voice", "note", "ask"] } }, required: ["for"], additionalProperties: false },
        run: (a) => {
          startCapture(a.for as CaptureFor);
          return { capturing: a.for };
        },
      },
      grant: {
        description: "Answer a live page's capability prompt, as its Allow (allow true) or Not now (false). Only when Carl asks.",
        args: { type: "object", properties: { page: { type: "string" }, allow: { type: "boolean" } }, required: ["page", "allow"], additionalProperties: false },
        run: (a) => {
          const page = String(a.page ?? "");
          if (!answerPrompt(page, a.allow === true)) throw new Error(`no prompt waiting for ${page} (pages lists them)`);
          return { page, allowed: a.allow === true };
        },
      },
      stopMic: {
        description: "Stop a live page's recording, as its red badge's Stop.",
        args: { type: "object", properties: { page: { type: "string" } }, required: ["page"], additionalProperties: false },
        run: (a) => {
          if (!stopPageMic(String(a.page ?? ""))) throw new Error(`${String(a.page)} is not recording`);
          return { stopped: a.page };
        },
      },
      pageText: {
        description: "The text an open HTML page shows now (any page, with or without vc.state): asked of the page itself in its frame (path, or the active pane's page). Cut to 12 000 characters.",
        args: { type: "object", properties: { path: { type: "string" }, pane: { type: "string", enum: ["main", "left", "right"] } }, additionalProperties: false },
        run: async (a) => {
          const o = openFor(a);
          if (fileKind(o.file).kind !== "html") throw new Error(`${rel(o.file)} is not an HTML page`);
          const root = [...document.querySelectorAll<HTMLElement>("[data-file]")].find((el) => el.dataset.file === o.file);
          const frame = root?.querySelector("iframe") ?? null;
          if (!frame) throw new Error(`${rel(o.file)} is not drawn as a page on screen (view mode shows it)`);
          const text = await textOfFrame(frame);
          if (text === null) throw new Error("the page did not answer (an older bridge, or it is busy)");
          return { path: rel(o.file), text: text.slice(0, 12_000) };
        },
      },
      closeOutside: {
        description: "Close a file opened outside the app (outside: its id while open), as closing its program's window does. Only when Carl asks.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a) => {
          await closeTracked(String(a.id ?? ""));
          return { closed: a.id };
        },
      },
      openOutside: {
        description: "Open a vault file outside the app, as the viewer's buttons do: how default (its default app), explorer (show it in File Explorer) or video (the system video player). Only when Carl asks.",
        args: { type: "object", properties: { path: { type: "string" }, how: { type: "string", enum: ["default", "explorer", "video"] } }, required: ["path", "how"], additionalProperties: false },
        run: async (a) => {
          const vault = (S().vaultPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
          const r = String(a.path ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
          const abs = r.startsWith(vault + "/") ? r : `${vault}/${r}`;
          await openOutside(abs, a.how as OutsideHow);
          return { opened: rel(abs), how: a.how };
        },
      },
      closePane: {
        description: "Close one pane of a split (the header's ×): the other file stays as the one viewer.",
        args: { type: "object", properties: { pane: { type: "string", enum: ["left", "right"] }, path: { type: "string" } }, additionalProperties: false },
        run: (a) => {
          const o = openFor(a);
          if (!o.paneId) throw new Error("the viewer is not split (only a pane of a split closes)");
          S().closePane(o.paneId);
          paneEvent("paneClosed", { path: rel(o.file), pane: o.pane });
          return { closed: o.pane, path: rel(o.file) };
        },
      },
      use: {
        description:
          "Choose which registered viewer draws a type or an extension (type: \"pdf\", \".csv\" or a MIME type; id from viewers, e.g. builtin:pdf over a plugin's, or app:code:highlight; it is turned on too); id omitted: back to the default order (the newest plugin viewer, else the app's own). Kept: every window, after a restart.",
        args: { type: "object", properties: { type: { type: "string" }, id: { type: "string" } }, required: ["type"], additionalProperties: false },
        run: async (a) => {
          const key = viewerKey(a.type);
          const id = typeof a.id === "string" && a.id ? a.id : null;
          if (id) {
            const x = viewerById(id);
            const typeOfKey = key.startsWith(".") ? fileViewerKeys(`x${key}`).type : key;
            if (!x || (x.key !== key && x.key !== typeOfKey)) throw new Error(`no viewer "${id}" for "${key}" (see the viewers state)`);
          }
          const writes: [string, unknown][] = [[USE + key, id]];
          if (id && viewerPrefs().disabled.includes(id)) writes.push([OFF + id, null]);
          return { type: key, using: id ?? "default", ...(await keep(writes)) };
        },
      },
      disable: {
        description: "Turn a viewer off by its id (see viewers): its type is drawn by the next in line (a plugin's off: the app's own; the app's own off: plain text). Kept: every window, after a restart.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a) => {
          const id = String(a.id);
          if (!viewerById(id)) throw new Error(`no viewer "${id}" (see the viewers state)`);
          return { disabled: id, ...(await keep([[OFF + id, true]])) };
        },
      },
      enable: {
        description: "Turn a viewer back on by its id (kept, like disable).",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a) => {
          const id = String(a.id);
          if (!viewerPrefs().disabled.includes(id) && !viewerById(id)) throw new Error(`no viewer "${id}" (see the viewers state)`);
          return { enabled: id, ...(await keep([[OFF + id, null]])) };
        },
      },
      setOption: {
        description:
          "Set a type's option, live in every window and kept after a restart. The one option: edit (true: Ctrl+E and the header's toggle switch that type to the source editor; HTML and notebooks are false by default, markdown, TeX and code true): e.g. {type: \"html\", key: \"edit\", value: true}. value null: back to its default.",
        args: { type: "object", properties: { type: { type: "string" }, key: { type: "string" }, value: { type: ["boolean", "null"] } }, required: ["type", "key", "value"], additionalProperties: false },
        run: async (a) => {
          const type = String(a.type).trim().toLowerCase();
          const key = String(a.key);
          const value = a.value === undefined ? null : a.value;
          const bad = viewerOptionProblem(type, key, value);
          if (bad) throw new Error(bad);
          return { type, key, value: value ?? "default", ...(await keep([[`${OPT}${type}:${key}`, value]])) };
        },
      },
    },
    events: {
      opened: { description: "A file was opened in the viewer (or into a pane): path, pane, type, viewer." },
      scrolled: { description: "An open file was scrolled (at most every 400 ms per file): path, ratio?, page?, totalPages?, line?." },
      modeChanged: { description: "An open file switched between view and edit: path, pane, mode." },
      reloaded: { description: "The header's Reload (Carl's click or reloadFromDisk) showed a file as it is on disk: path, pane." },
      keptMine: { description: "The header's Keep mine (Carl's click or keepMine) saved the version on screen over the one on disk: path, pane." },
      openedOutside: { description: "A file was opened outside the app (the default app, File Explorer, the system video player): path, how." },
      paneClosed: { description: "closePane closed a pane of the split: path, pane." },
      saved: { description: "Carl's typing in an open file reached the disk (its autosave): path. Wait for it before editing a file he is typing in." },
      changed: { description: "The viewers changed (a plugin's registered or removed, one turned on or off or chosen, an option set): the active viewer of each type after it." },
    },
  };
}

const SCROLL_EVERY_MS = 400;

/** Headless (the panes draw; this offers and follows them): mounted in every layout by the "offers" place. */
export const offers = { mount };

export function mount(_el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(viewerOffers());
  const offs: (() => void)[] = [];
  const toEvents = (name: string, data: unknown) => offers.emit(name, data);
  paneEvent = toEvents;
  offs.push(() => {
    if (paneEvent === toEvents) paneEvent = () => {};
  });
  offs.push(onSaved((path) => offers.emit("saved", { path: rel(path) })));
  offs.push(onPaneEvent((name, d) => offers.emit(name, { path: rel(d.file), pane: openNow().find((o) => o.file === d.file && o.paneId === d.paneId)?.pane ?? "main" })));
  offs.push(onOutsideOpened((o) => o && offers.emit("openedOutside", { path: rel(o.path), how: o.how })));

  // Opened / modeChanged: what is open, per pane, compared on each store change (reference checks first).
  const sig = (o: Open) => `${o.pane}\n${o.file}`;
  let was = new Map(openNow().map((o) => [sig(o), o]));
  let lastActive = openNow().find((o) => o.active)?.file ?? null;
  if (lastActive) api.context.publish({ file: lastActive });
  offs.push(
    useStore.subscribe((s, prev) => {
      if (s.panes === prev.panes && s.currentFile === prev.currentFile && s.mode === prev.mode && s.activePaneId === prev.activePaneId) return;
      const now = openNow();
      const next = new Map(now.map((o) => [sig(o), o]));
      for (const [k, o] of next) {
        const before = was.get(k);
        if (!before) offers.emit("opened", { path: rel(o.file), pane: o.pane, type: fileKind(o.file).kind, viewer: drawnBy(o) });
        else if (before.mode !== o.mode && editable(fileKind(o.file).kind)) offers.emit("modeChanged", { path: rel(o.file), pane: o.pane, mode: o.mode });
      }
      was = next;
      const active = now.find((o) => o.active)?.file ?? null;
      if (active !== lastActive) {
        lastActive = active;
        api.context.publish({ file: active });
      }
    }),
  );

  // Scrolled: trailing, per file.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  offs.push(
    onScroll((path) => {
      if (timers.has(path)) return;
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path);
          const p = scrollOf(path);
          if (!p) return;
          const { at: _at, ...pos } = p;
          offers.emit("scrolled", { path: rel(path), ...pos });
        }, SCROLL_EVERY_MS),
      );
    }),
  );
  offs.push(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  offs.push(subscribeViewers(() => offers.emit("changed", Object.fromEntries(describeViewers().map((k) => [k.key, k.active])))));
  return () => {
    for (const f of offs) f();
  };
}
