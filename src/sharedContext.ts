// The shared context (reports/07 point 6): what Carl has selected, what he hovers, which plugin he is in and the open
// file, as one small piece of state any plugin (api.context) and the agent (the app/context plugin's offers, read with
// PluginRead) can read and subscribe to. A plugin extends another by reacting to it: a selection in a note, a chat
// message or a file is the same record whoever drew it.
//
//   selection  {kind: "file", path, text, lineStart?, lineEnd?} | {kind: "message", messageId, chatId, text}
//              | {kind: "note", noteId, text} | {kind: "text", text, path?, plugin?}
//              | {kind: "files", paths} (files and folders selected in the file tree, app/filetree)  (null: nothing selected)
//   hover      {kind: "file", path} | {kind: "message", messageId, chatId} | {kind: "note", noteId}
//              | {kind: "chat", chatId} | {kind: "plugin", plugin}  (null: nothing known under the pointer)
//   focus      {plugin: id} the plugin Carl last clicked or focused in, or {plugin: null, area?} the app's own parts
//   file       the open file (vault-relative or absolute as the app holds it; the viewer, app/viewer, publishes the
//              active pane's), or null
//
// Who publishes: a source bound by the app (src/contextSource.ts: the DOM's selection, pointer and focus, the store's
// editor selection and open file), and any plugin through api.context.publish (its own list's hover, say). The source
// runs only while someone subscribes (no subscriber, no listeners), and it is throttled: DOM events only mark what is
// dirty and one trailing timer reads it, so nothing here runs on the keystroke path. Subscribers are told once per
// change, after the publisher's call returns, with the keys that changed. This module imports nothing from the app.

export type ContextSelection =
  | { kind: "file"; path: string; text: string; lineStart?: number; lineEnd?: number }
  | { kind: "message"; messageId: string; chatId: string | null; text: string }
  | { kind: "note"; noteId: string; text: string }
  | { kind: "text"; text: string; path?: string; plugin?: string }
  | { kind: "files"; paths: string[] };
export type ContextItem =
  | { kind: "file"; path: string }
  | { kind: "message"; messageId: string; chatId: string | null }
  | { kind: "note"; noteId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "plugin"; plugin: string };
export type ContextFocus = { plugin: string | null; area?: string };
export type SharedContext = {
  readonly selection: ContextSelection | null;
  readonly hover: ContextItem | null;
  readonly focus: ContextFocus | null;
  readonly file: string | null;
  /** When it last changed (ms since epoch; 0: never). */
  readonly at: number;
};
export type ContextKey = "selection" | "hover" | "focus" | "file";
export type ContextPatch = { -readonly [K in ContextKey]?: SharedContext[K] };
export type ContextListener = (ctx: SharedContext, changed: ContextKey[]) => void;
/** The app's publisher: started with the first subscriber, stopped (the returned undo) after the last. */
export type ContextSource = (publish: (patch: ContextPatch) => void) => () => void;

export const CONTEXT_KEYS: readonly ContextKey[] = ["selection", "hover", "focus", "file"];
/** The longest selected text kept (a whole file selected is cut, and says so with the …). */
export const CONTEXT_TEXT_MAX = 4000;

type World = { ctx: SharedContext; fns: Set<ContextListener>; source: ContextSource | null; stop: (() => void) | null; queued: Set<ContextKey> };
const KEY = "__vcSharedContext";
function world(): World {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as World | undefined) ??= { ctx: { selection: null, hover: null, focus: null, file: null, at: 0 }, fns: new Set(), source: null, stop: null, queued: new Set() });
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const cut = (t: unknown) => {
  const s = typeof t === "string" ? t : "";
  return s.length > CONTEXT_TEXT_MAX ? `${s.slice(0, CONTEXT_TEXT_MAX)}…` : s;
};

/** A published value made plain and bounded; null when it is not one of the shapes above. */
function clean(key: ContextKey, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (key === "file") return typeof v === "string" && v ? v.slice(0, 1000) : null;
  if (typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (key === "focus") return { plugin: typeof x.plugin === "string" && x.plugin ? str(x.plugin) : null, ...(typeof x.area === "string" && x.area ? { area: str(x.area, 60) } : {}) };
  const kind = String(x.kind ?? "");
  const line = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined);
  if (key === "selection") {
    if (kind === "files") {
      const paths = Array.isArray(x.paths) ? x.paths.filter((p) => typeof p === "string" && p).slice(0, 200).map((p) => str(p, 1000)) : [];
      return paths.length ? { kind, paths } : null;
    }
    const text = cut(x.text);
    if (!text.trim()) return null;
    if (kind === "file" && str(x.path)) return { kind, path: str(x.path, 1000), text, ...(line(x.lineStart) ? { lineStart: line(x.lineStart) } : {}), ...(line(x.lineEnd) ? { lineEnd: line(x.lineEnd) } : {}) };
    if (kind === "message" && str(x.messageId)) return { kind, messageId: str(x.messageId), chatId: str(x.chatId) || null, text };
    if (kind === "note" && str(x.noteId)) return { kind, noteId: str(x.noteId), text };
    return { kind: "text", text, ...(str(x.path) ? { path: str(x.path, 1000) } : {}), ...(str(x.plugin) ? { plugin: str(x.plugin) } : {}) };
  }
  if (kind === "file" && str(x.path)) return { kind, path: str(x.path, 1000) };
  if (kind === "message" && str(x.messageId)) return { kind, messageId: str(x.messageId), chatId: str(x.chatId) || null };
  if (kind === "note" && str(x.noteId)) return { kind, noteId: str(x.noteId) };
  if (kind === "chat" && str(x.chatId)) return { kind, chatId: str(x.chatId) };
  if (kind === "plugin" && str(x.plugin)) return { kind, plugin: str(x.plugin) };
  return null;
}

/** The context now. */
export function contextNow(): SharedContext {
  return world().ctx;
}

/** Change what is known (the keys given; the others stay). Subscribers hear once, after this call returns. */
export function publishContext(patch: ContextPatch): ContextKey[] {
  const w = world();
  if (!patch || typeof patch !== "object") return [];
  const next: Record<string, unknown> = { ...w.ctx };
  const changed: ContextKey[] = [];
  for (const k of CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = clean(k, (patch as Record<string, unknown>)[k]);
    if (same(v, next[k])) continue;
    next[k] = v;
    changed.push(k);
  }
  if (!changed.length) return [];
  next.at = Date.now();
  w.ctx = Object.freeze(next) as unknown as SharedContext;
  const first = w.queued.size === 0;
  for (const k of changed) w.queued.add(k);
  if (first) {
    queueMicrotask(() => {
      const keys = CONTEXT_KEYS.filter((k) => w.queued.has(k));
      w.queued.clear();
      const ctx = w.ctx;
      for (const fn of [...w.fns]) {
        try {
          fn(ctx, keys);
        } catch {
          /* a listener's throw is its own (plugins' are guarded by their host) */
        }
      }
    });
  }
  return changed;
}

/** Hear every change; the app's source runs while anyone listens. Returns off. */
export function subscribeContext(fn: ContextListener): () => void {
  const w = world();
  if (typeof fn !== "function") return () => {};
  w.fns.add(fn);
  if (w.fns.size === 1 && w.source && !w.stop) start(w);
  return () => {
    if (!w.fns.delete(fn)) return;
    if (w.fns.size === 0) stopSource(w);
  };
}

function start(w: World): void {
  try {
    w.stop = w.source!(publishContext);
  } catch {
    w.stop = null;
  }
}
function stopSource(w: World): void {
  const s = w.stop;
  w.stop = null;
  try {
    s?.();
  } catch {
    /* nothing more to undo */
  }
}

/** Bind the app's publisher (once, at the app's start); started at once if someone already listens. Returns unbind. */
export function setContextSource(source: ContextSource | null): () => void {
  const w = world();
  stopSource(w);
  w.source = source;
  if (source && w.fns.size) start(w);
  return () => {
    if (w.source !== source) return;
    stopSource(w);
    w.source = null;
  };
}

/** Whether the app's publisher is running now (tests, and the perf proof: no listener, no listeners). */
export function contextSourceRunning(): boolean {
  return !!world().stop;
}

/** A plugin's api.context. */
export type ContextApi = {
  get(): SharedContext;
  /** Hear every change (the context and the keys that changed); undone when the plugin stops. */
  on(fn: ContextListener): () => void;
  /** Publish what this plugin knows (its own list's hover or selection): `plugin` is filled in with its id. The open
   *  file only from the app's own viewer (app/viewer); another plugin's `file` is ignored. */
  publish(patch: Pick<ContextPatch, "selection" | "hover" | "file">): void;
};

export function contextApi(id: string, alive: () => boolean, track: (off: () => void) => () => void, guard: <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => void): ContextApi {
  return {
    get: () => contextNow(),
    on(fn) {
      if (!alive() || typeof fn !== "function") return () => {};
      const g = guard(fn);
      return track(subscribeContext((c, k) => alive() && g(c, k)));
    },
    publish(patch) {
      if (!alive() || !patch || typeof patch !== "object") return;
      const p: ContextPatch = {};
      if ("selection" in patch) {
        const s = patch.selection as Record<string, unknown> | null | undefined;
        p.selection = s && s.kind === "text" && !s.plugin ? ({ ...s, plugin: id } as ContextSelection) : (s as ContextSelection | null);
      }
      if ("hover" in patch) p.hover = patch.hover ?? null;
      if ("file" in patch && id === "app/viewer") p.file = patch.file ?? null;
      publishContext(p);
    },
  };
}

/** Tests: back to nothing known, no listeners, no source. */
export function _resetContext(): void {
  const w = world();
  stopSource(w);
  w.fns.clear();
  w.queued.clear();
  w.source = null;
  w.ctx = { selection: null, hover: null, focus: null, file: null, at: 0 };
}
