// The app's HostBackend (src/hostApi.ts) bound to the store: the one place a plugin's host calls reach it.
import { useStore } from "./store";
import { readTextAt, boxPathOf } from "./boxFiles";
import { writeAllNotes } from "./notes";
import { isUnreadableAsText } from "./fileKind";
import { hostTheme } from "./mountHost";
import { applyLayoutOps, readLayout, type LayoutIO } from "./layoutOps";
import { placeInPane } from "./paneLayout";
import type { HostBackend, HostState, HostSelection } from "./hostApi";

/** Commands a plugin may run by id (host.runCommand). */
const COMMANDS: Record<string, () => void> = {
  "chat.toggle": () => useStore.getState().toggleRight(),
  "notes.open": () => useStore.getState().setShowNotesPanel(true),
  "notes.close": () => useStore.getState().setShowNotesPanel(false),
  "notes.toggle": () => {
    const s = useStore.getState();
    s.setShowNotesPanel(!s.showNotesPanel);
  },
};

let cache: { key: unknown[]; value: HostState } | null = null;
function state(): HostState {
  const s = useStore.getState();
  const last = s.messages.length ? s.messages[s.messages.length - 1] : null;
  const lastId = last ? String((last as { mid?: string }).mid ?? s.messages.length) : "";
  const key = [s.currentFile, s.activeConversationId, s.conversations, lastId, s.notes, s.showNotesPanel];
  if (cache && cache.key.every((v, i) => v === key[i])) return cache.value;
  const value: HostState = {
    currentFile: s.currentFile,
    openChatId: s.activeConversationId,
    conversations: s.conversations.map((c) => ({ id: c.id, title: c.title, status: c.status, source: c.source, unread: !!c.unread, lastActivityAt: c.lastActivityAt })),
    lastMessage: last ? { id: lastId, role: last.role, content: last.content } : null,
    notes: s.notes,
    notesPanelOpen: s.showNotesPanel,
  };
  cache = { key, value };
  return value;
}

/** Putting a file in a pane from inside the app: read it (the disk, or the box's copy) and place it. */
const appLayoutIO: LayoutIO = {
  async openInPane(path, pane) {
    const vault = useStore.getState().vaultPath;
    if (!vault) return { ok: false, error: "no vault is open" };
    const abs = /^([a-zA-Z]:)?[\\/]/.test(path) ? path : `${vault.replace(/[\\/]+$/, "")}/${path}`;
    try {
      placeInPane(pane, abs, isUnreadableAsText(abs) ? "" : await readTextAt(abs));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `could not open ${path}: ${(e as Error)?.message ?? String(e)}` };
    }
  },
};

export const appHostBackend: HostBackend = {
  state,
  subscribe: (fn) => useStore.subscribe(fn),
  onSelection(fn) {
    const read = (): HostSelection | null => {
      const s = useStore.getState();
      if (s.editorSelection?.text) return { path: s.editorSelection.path, text: s.editorSelection.text };
      const t = typeof window !== "undefined" ? window.getSelection()?.toString() ?? "" : "";
      return t ? { path: s.currentFile ?? "", text: t } : null;
    };
    const onDoc = () => fn(read());
    document.addEventListener("selectionchange", onDoc);
    const un = useStore.subscribe((s, p) => {
      if (s.editorSelection !== p.editorSelection) fn(read());
    });
    return () => {
      document.removeEventListener("selectionchange", onDoc);
      un();
    };
  },
  theme: () => hostTheme(),
  async openFile(path, anchor, origin) {
    const s = useStore.getState();
    const p = origin ? boxPathOf(path.startsWith("/") ? path : `${origin}/${path}`) : path;
    if (isUnreadableAsText(p)) s.setCurrentFile(p, "");
    else s.setCurrentFile(p, await readTextAt(p));
    if (anchor) useStore.getState().requestScrollAnchor(p, anchor);
  },
  notify(text, kind) {
    const el = document.createElement("div");
    el.setAttribute("data-el", "host-toast");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = text;
    el.className = "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-md border border-border bg-card px-3 py-2 text-[12.5px] shadow-lg" + (kind === "error" ? " text-destructive" : "");
    document.body.append(el);
    const t = setTimeout(() => el.remove(), 4000);
    return () => {
      clearTimeout(t);
      el.remove();
    };
  },
  runCommand(id) {
    const f = COMMANDS[id];
    if (!f) return false;
    f();
    return true;
  },
  closeNotesPanel: () => useStore.getState().setShowNotesPanel(false),
  setNoteStatus: (id, st) => void useStore.getState().setNoteStatus(id, st),
  deleteNote: (id) => void useStore.getState().deleteNote(id),
  clearResolvedNotes: () => void useStore.getState().clearResolvedNotes(),
  reformatNote: (id) => void useStore.getState().reformatNote(id),
  async saveNoteDraft(id, draft) {
    const s = useStore.getState();
    if (!s.vaultPath || !draft.trim()) return;
    await writeAllNotes(s.vaultPath, s.notes.map((n) => (n.id === id ? { ...n, user_draft: draft.trim(), turns: [], formatted: null, title: null, last_updated: new Date().toISOString() } : n)));
    await s.loadNotes();
  },
  layout: () => readLayout(),
  applyLayout: (ops) => applyLayoutOps(ops, appLayoutIO),
  async primeChat(lines) {
    const store = useStore.getState();
    // Box mode: the box writes the chat; these lines go to it as they are.
    const { boxLines } = await import("./boxChat");
    if (!(await boxLines(lines))) {
      for (const l of lines) store.appendMessage({ role: l.role, content: l.text, ...(l.hidden ? { hidden: true } : {}) });
    }
    if (store.rightCollapsed) store.toggleRight();
    return true;
  },
};
