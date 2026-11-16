// The app's publisher of the shared context (src/sharedContext.ts): the selection, the hovered item, the plugin Carl is
// in and the open file, read from the DOM and the store. It runs only while someone subscribes (the app/context plugin,
// or any plugin's api.context.on), and it stays off the typing path: the DOM listeners (selectionchange, pointerover,
// pointerdown, focusin) only note what is dirty, and one trailing timer (THROTTLE_MS) reads and publishes it. A
// selection change inside a text box (the composer, Ctrl+K, a search field) is ignored at once: the browser's
// selection does not see into one, and the caret moves on every key.
//
// What the DOM marks (the app's own markup): a chat message `data-message-id`, a note `data-note-id`, a file in the tree
// `data-tree-path`, a chat in the list `data-chat`, a rendered file `data-file`, a plugin's mount `data-vc-plugin`.
import { useStore } from "./store";
import { contextNow, setContextSource, type ContextFocus, type ContextItem, type ContextPatch, type ContextSelection } from "./sharedContext";

export const THROTTLE_MS = 150;

const isTextBox = (el: Element | null): boolean => {
  if (!el) return false;
  const t = el.tagName;
  return t === "TEXTAREA" || (t === "INPUT" && !/^(checkbox|radio|button|submit|range|color|file)$/i.test((el as HTMLInputElement).type || ""));
};
const elementOf = (n: Node | null | undefined): Element | null => (!n ? null : n.nodeType === 1 ? (n as Element) : n.parentElement);
const attr = (el: Element | null, a: string): [Element, string] | null => {
  const hit = el?.closest(`[${a}]`);
  const v = hit?.getAttribute(a);
  return hit && v ? [hit, v] : null;
};

/** The item an element is part of, or null. */
export function itemAt(el: Element | null): ContextItem | null {
  if (!el) return null;
  const chatId = useStore.getState().activeConversationId ?? null;
  let m;
  if ((m = attr(el, "data-message-id"))) return { kind: "message", messageId: m[1], chatId };
  if ((m = attr(el, "data-note-id"))) return { kind: "note", noteId: m[1] };
  if ((m = attr(el, "data-tree-path"))) return { kind: "file", path: m[1] };
  if ((m = attr(el, "data-chat"))) return { kind: "chat", chatId: m[1] };
  if ((m = attr(el, "data-file"))) return { kind: "file", path: m[1] };
  if ((m = attr(el, "data-vc-plugin"))) return { kind: "plugin", plugin: m[1] };
  return null;
}

/** The plugin an element is inside, or the app's own area. */
export function focusAt(el: Element | null): ContextFocus | null {
  if (!el) return null;
  const p = attr(el, "data-vc-plugin");
  if (p) return { plugin: p[1] };
  const area = el.closest("[data-look-pane]") ? "viewer" : el.closest("[data-message-id], [data-el='chat-pane']") ? "chat" : el.closest("[data-tree-path]") ? "file tree" : undefined;
  return { plugin: null, ...(area ? { area } : {}) };
}

/** The browser's selection as a context selection (null: none, or collapsed). */
export function domSelection(doc: Document = document): ContextSelection | null {
  const sel = doc.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const el = elementOf(sel.anchorNode);
  const it = itemAt(el);
  if (it?.kind === "message") return { kind: "message", messageId: it.messageId, chatId: it.chatId, text };
  if (it?.kind === "note") return { kind: "note", noteId: it.noteId, text };
  const file = attr(el, "data-file");
  if (file) return { kind: "file", path: file[1], text };
  const plugin = attr(el, "data-vc-plugin");
  const path = useStore.getState().currentFile;
  return { kind: "text", text, ...(path ? { path } : {}), ...(plugin ? { plugin: plugin[1] } : {}) };
}

/** Start publishing (the shared context's source); the undo removes every listener and the timer. */
export function startContextSource(publish: (p: ContextPatch) => void, doc: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dirty = { sel: false, hover: false, focus: false };
  let lastSel: "dom" | "editor" = "dom";
  let hoverEl: Element | null = null;
  let focusEl: Element | null = null;

  const flush = () => {
    timer = null;
    const p: ContextPatch = {};
    if (dirty.sel) {
      const s = useStore.getState();
      const ed = s.editorSelection;
      p.selection = lastSel === "editor" && ed?.text ? { kind: "file", path: ed.path, text: ed.text, lineStart: ed.lineStart, lineEnd: ed.lineEnd } : domSelection(doc);
    }
    if (dirty.hover) p.hover = itemAt(hoverEl);
    if (dirty.focus) p.focus = focusAt(focusEl);
    dirty.sel = dirty.hover = dirty.focus = false;
    // The file tree's selection (published by app/filetree) stands until something else is selected: a click that only
    // collapses the browser's selection does not clear it.
    if (p.selection === null && contextNow().selection?.kind === "files") delete p.selection;
    publish(p);
  };
  const mark = (k: keyof typeof dirty) => {
    dirty[k] = true;
    if (!timer) timer = setTimeout(flush, THROTTLE_MS);
  };

  const onSelection = () => {
    if (isTextBox(doc.activeElement)) return;
    lastSel = "dom";
    mark("sel");
  };
  const onOver = (e: Event) => {
    hoverEl = e.target as Element | null;
    mark("hover");
  };
  const onFocus = (e: Event) => {
    focusEl = e.target as Element | null;
    mark("focus");
  };
  const opts = { capture: true, passive: true } as const;
  doc.addEventListener("selectionchange", onSelection);
  doc.addEventListener("pointerover", onOver, opts);
  doc.addEventListener("pointerdown", onFocus, opts);
  doc.addEventListener("focusin", onFocus, opts);

  // The store: Monaco's selection (outside the browser's) and the open file. Only reference checks run per change.
  const st = useStore.getState();
  publish({ file: st.currentFile ?? null });
  const unStore = useStore.subscribe((s, prev) => {
    if (s.editorSelection !== prev.editorSelection) {
      lastSel = "editor";
      mark("sel");
    }
    if (s.currentFile !== prev.currentFile) publish({ file: s.currentFile ?? null });
  });

  return () => {
    doc.removeEventListener("selectionchange", onSelection);
    doc.removeEventListener("pointerover", onOver, opts);
    doc.removeEventListener("pointerdown", onFocus, opts);
    doc.removeEventListener("focusin", onFocus, opts);
    unStore();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Bind it as the shared context's source (the app's start). */
export function bindContextSource(): () => void {
  return setContextSource((publish) => startContextSource(publish));
}
