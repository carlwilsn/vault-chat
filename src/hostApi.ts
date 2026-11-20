// The plugin host API (api.host, version 1): the narrow, versioned surface a plugin uses to read and act on the app, so
// a plugin never imports the store. Three parts:
//   selectors  host.state() (a plain-data snapshot: currentFile, openChatId, theme, conversations, ...), host.subscribe(fn)
//   actions    host.openFile(path, anchor?), host.notify(text, kind?), host.runCommand(id), plus the narrow
//              notes/panel/chat actions the Notes plugin needs
//   layout     host.layout.get() (panes, split, panels, chat, window and column sizes) and host.layout.apply(op | ops)
//              (close/open the left panel or chat, put a file in a pane, split, focus, full-screen chat): the same ops the
//              agent's Layout tool runs (src/layoutOps.ts), each answered with the layout read back
//   chat menu  host.chat.menuItem({id, label, onClick, title?, order?}) → off: an entry in the chat's ⋯ menu
//              (src/chatMenuItems.ts), live until the plugin stops; host.chat.menuItems() the entries there now
//   titlebar   host.titlebar.item({id, label | icon | render, onClick?, title?, side?}) → off: an item in the title bar
//              (src/titlebarItems.ts), live until the plugin stops; host.titlebar.items() the items there now
//   viewer     host.viewer(type, mount, {name?}) → off: draw a type of file in the viewer ("pdf", ".csv", "image/*";
//              src/viewerRegistry.ts), live until the plugin stops; mount(el, file) → cleanup | {unmount, update, scrollTo};
//              a throw falls back to the app's own viewer for that file. host.viewers() the viewers of each type now
//   capture    host.capture(target?) a PNG of the app's own window or one column (the laptop's `capture` service,
//              src/screenCapture.ts; the agent's Screen tool draws through the same function)
//   events     host.on("file-opened" | "chat-message" | "selection-changed", fn) → off
//   first run  host.readFile(rel) a vault file's text (null: not there), host.shortcut(id) a shortcut's label for this
//              platform ("⌘K" on a Mac, "Ctrl+K" elsewhere; src/shortcuts.ts), host.speak(text) one line in the app's
//              local voice (Kokoro af_heart; false when it is not available: never waits long) (the first-run
//              tutorial uses them; host.boardPaired() is always false now: the iPad board was removed)
// This module imports nothing from the app: the app binds a HostBackend (src/hostBackend.ts) to the store, tests bind a
// fake. Every subscription a plugin makes through it is an Effect of its run (src/pluginSupervisor.ts): disabling the
// plugin removes the listeners, and a stopped run's api is inert.
import type { Effects } from "./pluginSupervisor";
import type { Note } from "./noteTypes";
import type { HostLayout, LayoutOp, LayoutResult } from "./layoutTypes";
import type { Capture, CaptureTarget } from "./screenCapture";
import type { TitlebarItem, TitlebarItemSpec } from "./titlebarItems";
import type { ChatMenuItem, ChatMenuItemSpec } from "./chatMenuItems";
import type { ViewerMount, ViewerOptions } from "./viewerRegistry";
export type { HostLayout, LayoutOp, LayoutResult } from "./layoutTypes";

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
/** A type of file (or an extension) and its viewers: the one drawing it now and every one registered. */
export type HostViewerKey = { key: string; active: string; viewers: readonly { id: string; name: string; by: string; builtin: boolean; enabled: boolean }[] };
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
  /** Add a note (written to the notes file); its id, or why not. */
  addNote(text: string, sourcePath?: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  setNoteStatus(id: string, status: "open" | "resolved"): Promise<void> | void;
  deleteNote(id: string): Promise<void> | void;
  clearResolvedNotes(): void;
  reformatNote(id: string): void;
  saveNoteDraft(id: string, draft: string): Promise<void>;
  /** Put lines in the open chat and reveal it; false when it could not. */
  primeChat(lines: HostChatLine[]): Promise<boolean>;
  /** The screen's layout now (panes, panels, sizes). */
  layout(): HostLayout;
  /** Apply layout ops in order; the answer carries the layout read back afterwards. */
  applyLayout(ops: LayoutOp[]): Promise<LayoutResult>;
  /** A picture of the app's window or one column; absent: this host has no screen to draw. */
  capture?(target: CaptureTarget): Promise<Capture>;
  /** Draw one kind of chat row with a plugin's renderer (src/chatRows.ts); the undo. Absent: no chat here. */
  registerChatRow?(kind: string, render: ChatRowRender, by: string, opts?: ChatRowOptions): () => void;
  /** Translate one type of the chat's events with a plugin's translator (src/convlog/translators.ts); the undo. */
  registerChatTranslator?(type: string, fn: ChatTranslator, by: string): () => void;
  /** Put an entry in the chat's ⋯ menu (src/chatMenuItems.ts) for plugin `by`; the undo. Absent: no chat here. */
  registerChatMenuItem?(spec: ChatMenuItemSpec, by: string): () => void;
  /** The chat menu's plugin entries now. */
  chatMenuItems?(): readonly ChatMenuItem[];
  /** Put an item in the title bar (src/titlebarItems.ts) for plugin `by`; the undo. Absent: no title bar here. */
  registerTitlebarItem?(spec: TitlebarItemSpec, by: string): () => void;
  /** The title bar's items now. */
  titlebarItems?(): readonly TitlebarItem[];
  /** Draw a type of file in the viewer (src/viewerRegistry.ts) for plugin `by`; the undo. Absent: no viewer here. */
  registerViewer?(type: string, mount: ViewerMount, by: string, opts?: ViewerOptions): () => void;
  /** The viewers of each type now. */
  viewers?(): readonly HostViewerKey[];
  /** A vault file's text (vault-relative), or null when it is not there. Absent: no files here. */
  readFile?(rel: string): Promise<string | null>;
  /** A shortcut's label for this platform (src/shortcuts.ts shortcutHint), or "" for an unknown id. */
  shortcut?(id: string): string;
  /** Say one line in the app's local voice; true once it played, false when there is no local voice now. */
  speak?(text: string): Promise<boolean>;
};
/** A chat translator: the messages an event of its type shows ([] none), or null to hand it to the next in line (next()
 *  gives that answer). event.item is the log's item: {id, kind, status, at, text?, via?, name?, args?, result?, level?, ...}. */
export type ChatTranslator = (
  event: { type: string; item: Readonly<Record<string, unknown>>; retry?: boolean; repeat?: boolean },
  next: () => unknown[],
) => unknown[] | null | undefined | void;
/** A chat row renderer: draw `row` ({kind, index?, message?, tool?, todos?, src?, alt?}) into `el`; return a cleanup. */
/** when(row): the rows of its kind this renderer draws (false: the next in line draws that row; e.g. only some notices). */
export type ChatRowOptions = { when?: (row: Parameters<ChatRowRender>[1]) => boolean };
export type ChatRowRender = (el: HTMLElement, row: { kind: string; index?: number; message?: unknown; tool?: unknown; todos?: unknown; src?: string; alt?: string; placement?: string }) => void | (() => void);

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
    add(text: string, sourcePath?: string): Promise<{ ok: boolean; id?: string; error?: string }>;
    setStatus(id: string, status: "open" | "resolved"): Promise<void>;
    remove(id: string): Promise<void>;
    clearResolved(): void;
    reformat(id: string): void;
    saveDraft(id: string, draft: string): Promise<void>;
  };
  panel: { close(): void };
  chat: {
    prime(lines: HostChatLine[]): Promise<boolean>;
    /** Draw one kind of the transcript's rows ("assistant", "notice", "tool-call", "tool-call:Bash", "plan", "inline-html",
     *  ...) with this renderer, live, until the plugin stops (or the returned off). A throw falls back to the app's own
     *  renderer for that row. Throws on a bad kind. opts.when(row): draw only the rows it answers true for (the others
     *  keep the next renderer in line: hide only some notices, restyle only some tool calls). */
    row(kind: string, render: ChatRowRender, opts?: ChatRowOptions): () => void;
    /** Translate one type of the chat's events ("user", "user:<via>", "worker", "assistant", "thinking", "commentary",
     *  "compaction", "notice") into the messages it shows, live, until the plugin stops (or the returned off): add a type
     *  the app has no translator for, or override its own. Return null to hand an event on. Throws on a bad type. */
    translate(type: string, fn: ChatTranslator): () => void;
    /** Put an entry in the chat's ⋯ menu (beside Memory), live, until the plugin stops (or the returned off):
     *  {id, label, onClick, title?, order?}. The same id again replaces it. A throw in its click is this plugin's
     *  failure. Throws on a bad spec. */
    menuItem(spec: ChatMenuItemSpec): () => void;
    /** Every plugin's entries in the chat's ⋯ menu now: {key, id, by, label, title?}. */
    menuItems(): readonly { key: string; id: string; by: string; label: string; title?: string }[];
  };
  layout: { get(): HostLayout; apply(ops: LayoutOp | LayoutOp[]): Promise<LayoutResult> };
  titlebar: {
    /** Put an item in the title bar, live, until the plugin stops (or the returned off): a button ({id, label or icon,
     *  title?, onClick?, side? "left" | "right", order?}) or one that draws itself (render(el) → cleanup). The same id
     *  again replaces it. A throw in its click or render is this plugin's failure. Throws on a bad spec. */
    item(spec: TitlebarItemSpec): () => void;
    /** Every plugin's title bar items now: {key, id, by, side, label?, title?}. */
    items(): readonly { key: string; id: string; by: string; side: string; label?: string; title?: string }[];
  };
  /** Draw a type of file in the viewer its own way, live, until the plugin stops (or the returned off): type is a
   *  type ("pdf", "markdown", "html", "image", "video", "notebook", "tex", "code", "unsupported"), an extension
   *  (".csv") or a MIME type ("application/pdf", "image/*"). mount(el, file) draws into a plain element and returns a
   *  cleanup, or {unmount?, update?(file), scrollTo?(target) → where it landed, zoom?: {get, set, min?, max?}}; file: {path, rel, ext, type, content,
   *  mode, pane, rev, bytes(), save(text), scrolled({ratio?, page?, line?}), select(text, lines?)}. The newest plugin
   *  viewer of a type draws it; a throw falls back to the app's own viewer for that file. Throws on a bad type. */
  viewer(type: string, mount: ViewerMount, opts?: ViewerOptions): () => void;
  /** Every type's viewers now: {key, active, viewers: [{id, name, by, builtin, enabled}]}. */
  viewers(): readonly HostViewerKey[];
  /** A PNG of the app's own window ("window", default) or its "viewer" / "chat" column; rejects with why it can't. */
  capture(target?: CaptureTarget): Promise<Capture>;
  /** A vault file's text (vault-relative, inside the vault), or null when it is not there or cannot be read. */
  readFile(rel: string): Promise<string | null>;
  /** A shortcut's label for this platform: shortcut("edit.inline") is "⌘K" on a Mac, "Ctrl+K" elsewhere ("" unknown). */
  shortcut(id: string): string;
  /** Say one line in the app's local voice (Kokoro, af_heart). Resolves true once it played, false when there is no
   *  local voice now (not installed, still loading, no server) or it took too long; never rejects. */
  speak(text: string): Promise<boolean>;
  /** Always false: the iPad board was removed (kept so a tutorial copy from before still runs). */
  boardPaired(): Promise<boolean>;
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
  addNote: async () => ({ ok: false, error: "no notes here" }),
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
export function createHostApi(b: HostBackend, fx: Effects, alive: () => boolean, guard: <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => void, id = "plugin"): HostApi {
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
      add: act(async (text: string, sourcePath?: string) => b.addNote(String(text), sourcePath), Promise.resolve({ ok: false, error: "the plugin has stopped" })),
      setStatus: act(async (id: string, s: "open" | "resolved") => void (await b.setNoteStatus(id, s)), Promise.resolve()),
      remove: act(async (id: string) => void (await b.deleteNote(id)), Promise.resolve()),
      clearResolved: act(() => b.clearResolvedNotes(), undefined),
      reformat: act((id) => b.reformatNote(id), undefined),
      saveDraft: act((id, d) => b.saveNoteDraft(id, d), Promise.resolve()),
    },
    panel: { close: act(() => b.closeNotesPanel(), undefined) },
    chat: {
      prime: act((l) => b.primeChat(l), Promise.resolve(false)),
      row(kind, render, opts) {
        if (!alive()) return () => {};
        if (!b.registerChatRow) throw new Error("no chat here to draw rows in");
        return fx.add(`chat row ${String(kind)}`, b.registerChatRow(String(kind), render, id, opts));
      },
      translate(type, fn) {
        if (!alive()) return () => {};
        if (!b.registerChatTranslator) throw new Error("no chat here to translate for");
        return fx.add(`chat translator ${String(type)}`, b.registerChatTranslator(String(type), fn, id));
      },
      menuItem(spec) {
        if (!alive()) return () => {};
        if (!b.registerChatMenuItem) throw new Error("no chat menu here");
        const s = (spec ?? {}) as ChatMenuItemSpec;
        const click = typeof s.onClick === "function" ? s.onClick : undefined;
        return fx.add(`chat menu item ${String(s.id)}`, b.registerChatMenuItem({ ...s, ...(click ? { onClick: guard(() => void click()) } : {}) } as ChatMenuItemSpec, id));
      },
      menuItems: () => (b.chatMenuItems?.() ?? []).map((i) => ({ key: i.key, id: i.id, by: i.by, label: i.label, ...(i.title ? { title: i.title } : {}) })),
    },
    layout: {
      get: () => b.layout(),
      apply: (ops) => (alive() ? b.applyLayout(Array.isArray(ops) ? ops : [ops]) : Promise.resolve({ ok: false, results: [], layout: b.layout() })),
    },
    titlebar: {
      item(spec) {
        if (!alive()) return () => {};
        if (!b.registerTitlebarItem) throw new Error("no title bar here");
        const s = (spec ?? {}) as TitlebarItemSpec;
        const render = typeof s.render === "function" ? s.render : undefined;
        const click = typeof s.onClick === "function" ? s.onClick : undefined;
        const wrapped: TitlebarItemSpec = {
          ...s,
          ...(click ? { onClick: guard(() => void click()) } : {}),
          ...(render
            ? {
                render: (el: HTMLElement) => {
                  if (!alive()) return;
                  let out: void | (() => void) = undefined;
                  guard(() => void (out = render(el)))();
                  return typeof out === "function" ? guard(out as () => void) : undefined;
                },
              }
            : {}),
        };
        return fx.add(`titlebar item ${String(s.id)}`, b.registerTitlebarItem(wrapped, id));
      },
      items: () => (b.titlebarItems?.() ?? []).map((i) => ({ key: i.key, id: i.id, by: i.by, side: i.side, ...(i.label ? { label: i.label } : {}), ...(i.title ? { title: i.title } : {}) })),
    },
    viewer(type, mount, opts) {
      if (!alive()) return () => {};
      if (!b.registerViewer) throw new Error("no viewer here");
      if (typeof mount !== "function") throw new Error("a viewer is a function mount(el, file) → cleanup?");
      // A stopped run's viewer draws nothing (its registration is gone with it; this covers a pane mid-swap).
      const m: ViewerMount = (el, file) => (alive() ? mount(el, file) : undefined);
      return fx.add(`viewer ${String(type)}`, b.registerViewer(String(type), m, id, opts));
    },
    viewers: () => (b.viewers?.() ?? []).map((k) => ({ key: k.key, active: k.active, viewers: k.viewers.map((v) => ({ id: v.id, name: v.name, by: v.by, builtin: v.builtin, enabled: v.enabled })) })),
    capture: (target = "window") => (!alive() ? Promise.reject(new Error("this plugin is stopped")) : b.capture ? b.capture(target) : Promise.reject(new Error("no screen here"))),
    readFile: (rel) => {
      const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
      if (!alive() || !b.readFile || !r || r.startsWith("/") || /^[a-z]:/i.test(r) || r.split("/").includes("..")) return Promise.resolve(null);
      return b.readFile(r).catch(() => null);
    },
    shortcut: (sid) => b.shortcut?.(String(sid)) ?? "",
    speak: (text) => (alive() && b.speak && String(text ?? "").trim() ? b.speak(String(text).slice(0, 400)).catch(() => false) : Promise.resolve(false)),
    boardPaired: () => Promise.resolve(false),
  };
}
