// The plugin host API (api.host, version 1): the narrow, versioned surface a plugin uses to read and act on the app, so
// a plugin never imports the store. Three parts:
//   selectors  host.state() (a plain-data snapshot: currentFile, openChatId, theme, conversations, ...), host.subscribe(fn)
//   actions    host.openFile(path, anchor?), host.notify(text, kind?), host.runCommand(id), plus the narrow
//              notes/panel/chat actions the Notes plugin needs
//   layout     host.layout.get() (panes, split, panels, chat, window and column sizes) and host.layout.apply(op | ops)
//              (close/open the left panel or chat, put a file in a pane, split, focus, full-screen chat): the same ops the
//              agent's Layout tool runs (src/layoutOps.ts), each answered with the layout read back
//   events     host.on("file-opened" | "chat-message" | "selection-changed", fn) → off
// This module imports nothing from the app: the app binds a HostBackend (src/hostBackend.ts) to the store, tests bind a
// fake. Every subscription a plugin makes through it is an Effect of its run (src/pluginSupervisor.ts): disabling the
// plugin removes the listeners, and a stopped run's api is inert.
import type { Effects } from "./pluginSupervisor";
import type { Note } from "./notes";
import type { HostLayout, LayoutOp, LayoutResult } from "./layoutOps";
export type { HostLayout, LayoutOp, LayoutResult } from "./layoutOps";

export const HOST_API_VERSION = 1;

export type HostConversation = { id: string; title: string; status: string; source: string; unread: boolean; lastActivityAt: number };
export type HostMessage = { id: string; role: string; content: string };
export type HostTheme = { mode: "light" | "dark"; vars: Record<string, string> };
export type HostState = {
  readonly currentFile: string | null;
  readonly openChatId: string | null;
  readonly conversations: readonly HostConversation[];
  readonly lastMessage: HostMessage | null;
  readonly notes: readonly Note[];
  readonly notesPanelOpen: boolean;
};
export type HostSelection = { path: string; text: string };
export type HostEvents = {
  "file-opened": { path: string };
  "chat-message": { chatId: string; message: HostMessage };
  "selection-changed": HostSelection | null;
};
export type HostEventName = keyof HostEvents;
export type HostChatLine = { role: "user" | "assistant"; text: string; hidden?: boolean };

/** What the app supplies. `state()` must return the same object while nothing changed (subscribe-friendly). */
export type HostBackend = {
  state(): HostState;
  subscribe(fn: () => void): () => void;
  onSelection(fn: (s: HostSelection | null) => void): () => void;
  theme(): HostTheme;
  openFile(path: string, anchor?: string, origin?: string): Promise<void>;
  notify(text: string, kind: "info" | "error"): () => void;
  runCommand(id: string): boolean;
  closeNotesPanel(): void;
  setNoteStatus(id: string, status: "open" | "resolved"): void;
  deleteNote(id: string): void;
  clearResolvedNotes(): void;
  reformatNote(id: string): void;
  saveNoteDraft(id: string, draft: string): Promise<void>;
  /** Put lines in the open chat and reveal it; false when it could not. */
  primeChat(lines: HostChatLine[]): Promise<boolean>;
  /** The screen's layout now (panes, panels, sizes). */
  layout(): HostLayout;
  /** Apply layout ops in order; the answer carries the layout read back afterwards. */
  applyLayout(ops: LayoutOp[]): Promise<LayoutResult>;
};

export type HostApi = {
  readonly version: number;
  /** The current snapshot (stable identity until something changes). */
  state(): HostState;
  currentFile(): string | null;
  openChatId(): string | null;
  theme(): HostTheme;
  conversations(): readonly HostConversation[];
  /** Called on every change of the snapshot; returns off (also undone when the plugin stops). */
  subscribe(fn: () => void): () => void;
  on<E extends HostEventName>(event: E, fn: (payload: HostEvents[E]) => void): () => void;
  openFile(path: string, opts?: { anchor?: string; origin?: string }): Promise<void>;
  notify(text: string, kind?: "info" | "error"): void;
  runCommand(id: string): boolean;
  notes: {
    setStatus(id: string, status: "open" | "resolved"): void;
    remove(id: string): void;
    clearResolved(): void;
    reformat(id: string): void;
    saveDraft(id: string, draft: string): Promise<void>;
  };
  panel: { close(): void };
  chat: { prime(lines: HostChatLine[]): Promise<boolean> };
  layout: { get(): HostLayout; apply(ops: LayoutOp | LayoutOp[]): Promise<LayoutResult> };
};

/** An inert backend: what a plugin mounted without the app's store sees. */
export const noHost: HostBackend = {
  state: (() => {
    const s: HostState = { currentFile: null, openChatId: null, conversations: [], lastMessage: null, notes: [], notesPanelOpen: false };
    return () => s;
  })(),
  subscribe: () => () => {},
  onSelection: () => () => {},
  theme: () => ({ mode: "dark", vars: {} }),
  openFile: async () => {},
  notify: () => () => {},
  runCommand: () => false,
  closeNotesPanel() {},
  setNoteStatus() {},
  deleteNote() {},
  clearResolvedNotes() {},
  reformatNote() {},
  saveNoteDraft: async () => {},
  primeChat: async () => false,
  layout: () => NO_LAYOUT,
  applyLayout: async (ops) => ({ ok: false, results: ops.map((o) => ({ op: o.op, ok: false, error: "no screen here" })), layout: NO_LAYOUT }),
};

const NO_LAYOUT: HostLayout = { split: false, direction: null, panes: [], currentFile: null, activePane: null, leftPanelOpen: false, rightPanelOpen: false, chatFullscreen: false, chatPoppedOut: false, chatSidebarOpen: false, viewport: null, sizes: null };
const EVENTS: readonly string[] = ["file-opened", "chat-message", "selection-changed"];

/**
 * The api.host of one run. `fx` records every subscription (undone on stop); `alive()` is false once the run is over
 * (its calls then do nothing); `guard` wraps plugin callbacks (a throw is the plugin's failure, not the app's).
 */
export function createHostApi(b: HostBackend, fx: Effects, alive: () => boolean, guard: <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => void): HostApi {
  const fns = new Set<() => void>();
  let stopBackend: (() => void) | null = null;
  // One backend subscription per run: it fans out to subscribe() and derives the file-opened / chat-message events.
  const fileFns = new Set<(p: HostEvents["file-opened"]) => void>();
  const msgFns = new Set<(p: HostEvents["chat-message"]) => void>();
  let prev = b.state();
  const ensure = () => {
    if (stopBackend) return;
    prev = b.state();
    const off = b.subscribe(() => {
      const cur = b.state();
      const was = prev;
      prev = cur;
      if (cur === was) return;
      if (cur.currentFile !== was.currentFile && cur.currentFile) for (const f of [...fileFns]) f({ path: cur.currentFile });
      const m = cur.lastMessage;
      if (m && cur.openChatId && cur.openChatId === was.openChatId && m.id !== was.lastMessage?.id) {
        for (const f of [...msgFns]) f({ chatId: cur.openChatId, message: m });
      }
      for (const f of [...fns]) f();
    });
    stopBackend = fx.add("host subscription", () => {
      off();
      stopBackend = null;
      fns.clear();
      fileFns.clear();
      msgFns.clear();
    });
  };
  const on: HostApi["on"] = (event, fn) => {
    if (!alive() || !EVENTS.includes(event) || typeof fn !== "function") return () => {};
    const g = guard(fn as (p: unknown) => void);
    let off: () => void;
    if (event === "selection-changed") {
      const raw = b.onSelection(g);
      off = fx.add(`host event ${event}`, raw);
    } else {
      ensure();
      const set = (event === "file-opened" ? fileFns : msgFns) as Set<(p: unknown) => void>;
      set.add(g);
      off = fx.add(`host event ${event}`, () => void set.delete(g));
    }
    return off;
  };
  const act = <A extends unknown[], R>(f: (...a: A) => R, none: R) => (...a: A): R => (alive() ? f(...a) : none);
  return {
    version: HOST_API_VERSION,
    state: () => b.state(),
    currentFile: () => b.state().currentFile,
    openChatId: () => b.state().openChatId,
    theme: () => b.theme(),
    conversations: () => b.state().conversations,
    subscribe(fn) {
      if (!alive() || typeof fn !== "function") return () => {};
      ensure();
      const g = guard(fn);
      fns.add(g);
      return fx.add("host subscription", () => void fns.delete(g));
    },
    on,
    openFile: act((path, o) => b.openFile(String(path), o?.anchor, o?.origin), Promise.resolve()),
    notify(text, kind = "info") {
      if (!alive()) return;
      // The toast is an effect: it goes with the plugin if it is still showing.
      const undo = b.notify(String(text), kind === "error" ? "error" : "info");
      fx.add("toast", undo);
    },
    runCommand: act((id) => b.runCommand(String(id)), false),
    notes: {
      setStatus: act((id, s) => b.setNoteStatus(id, s), undefined),
      remove: act((id) => b.deleteNote(id), undefined),
      clearResolved: act(() => b.clearResolvedNotes(), undefined),
      reformat: act((id) => b.reformatNote(id), undefined),
      saveDraft: act((id, d) => b.saveNoteDraft(id, d), Promise.resolve()),
    },
    panel: { close: act(() => b.closeNotesPanel(), undefined) },
    chat: { prime: act((l) => b.primeChat(l), Promise.resolve(false)) },
    layout: {
      get: () => b.layout(),
      apply: (ops) => (alive() ? b.applyLayout(Array.isArray(ops) ? ops : [ops]) : Promise.resolve({ ok: false, results: [], layout: b.layout() })),
    },
  };
}
