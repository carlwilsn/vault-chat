// The viewer's registry: what draws each type of file in the viewer pane (src/MarkdownView.tsx). Each file has a type
// (fileKind: markdown, notebook, pdf, tex, html, image, video, unsupported, code) and an extension; a viewer is keyed
// by a type ("pdf"), an extension (".csv") or a MIME type ("application/pdf", "image/*": made a type or an extension
// here). The app's own viewers are the built-in layer (src/plugins/viewer/builtins.tsx: the PDF, markdown, notebook,
// TeX, HTML, image, video, unsupported and code viewers, unchanged). A plugin registers one over a type live, with no
// release: a vault plugin through api.host.viewer(type, mount) (mount(el, file) draws into a plain element), undone
// when it stops. Which viewer draws a file: the one chosen for its extension, else for its type (use), else the
// newest enabled plugin viewer of its extension, then of its type, else the built-in; a throwing viewer falls back to
// the built-in for that file, then to the plain fallback (the file's text, or what happened). The app plugin
// app/viewer (src/plugins/viewer/index.ts) offers all this to the agent (PluginRead / PluginAct).
//
// Modes: a type is "editable" when Ctrl+E (and the header's toggle) switches it to the app's source editor (the live
// editor for markdown, Monaco otherwise). Markdown, TeX and code are by default; HTML and notebooks can be made so
// (the `edit` option, kept by app/viewer); a PDF, an image, a video are not text and never are.
//
// No React and no imports from the app here (fileKind has none): the registry is plain data the app and the tests share.
import { fileKind, type FileKind } from "./fileKind";

export const VIEWER_TYPES: readonly FileKind[] = ["markdown", "notebook", "pdf", "tex", "html", "image", "video", "unsupported", "code"];
/** The types whose files are text (the source editor can edit them). */
export const TEXT_TYPES: readonly FileKind[] = ["markdown", "notebook", "tex", "html", "code"];
export type ViewerMode = "view" | "edit";

/** What a plugin viewer is given: the file and a few calls back into the pane. */
export type ViewerFile = {
  /** The file's path as the app holds it (absolute on the laptop). */
  path: string;
  /** Vault-relative, as the agent names it. */
  rel: string;
  /** Lower case, no dot ("" for none). */
  ext: string;
  /** Its type (fileKind). */
  type: FileKind;
  /** Its text ("" for a file that is not text: a PDF, an image, a video). */
  content: string;
  /** The pane's mode now. */
  mode: ViewerMode;
  /** The pane ("left" / "right" in a split), or null for the one viewer. */
  pane: string | null;
  /** Bumped when the file changes on disk (the agent's write, a sync). */
  rev: number;
  /** The file's bytes (a binary file's way in). */
  bytes(): Promise<Uint8Array>;
  /** Replace the file's text (saved as typing in the editor is). */
  save(text: string): void;
  /** Say where the viewer is (the agent's scroll state and the scrolled event): a ratio 0..1, a page, a line. */
  scrolled(pos: { ratio?: number; page?: number; totalPages?: number; line?: number }): void;
  /** Say what is selected in it (the shared context's selection), null: nothing. */
  select(text: string | null, lines?: { start: number; end: number }): void;
};
/** A ViewTarget (src/viewTarget.ts) as a plain object: {page?, line?, heading?, text?, anchor?, cell?, query?}. */
export type ViewerTarget = Record<string, unknown>;
/** What a plugin viewer's mount may return: a cleanup, or {unmount?, update?(file), scrollTo?(target) → where it landed, zoom?}. */
export type ViewerHandle =
  | void
  | (() => void)
  | {
      unmount?: () => void;
      update?: (file: ViewerFile) => void;
      scrollTo?: (target: ViewerTarget) => string | void;
      /** It zooms: app/viewer's zoom action and open state reach it (1 = fit). */
      zoom?: { get(): number; set(z: number): void; min?: number; max?: number };
    };
export type ViewerMount = (el: HTMLElement, file: ViewerFile) => ViewerHandle;
export type ViewerOptions = { name?: string };

export type ViewerEntry = {
  /** Unique: "builtin:<type>" for the app's own, "<plugin id>#<key>" for a plugin's. */
  id: string;
  /** What it is keyed by: a type, or ".<ext>". */
  key: string;
  /** Who registered it: "app" or the plugin's id. */
  by: string;
  builtin: boolean;
  name: string;
  /** The app's own: a React component (typed loosely here: this module knows no React). */
  component?: unknown;
  /** The app's own: whether it draws its own bar across the top in this mode (the pane's header then stays out). */
  ownHeader?: (mode: ViewerMode) => boolean;
  /** The app's own: the source editor is the viewer itself (code): no view / edit toggle. */
  alwaysEdits?: boolean;
  /** An app alternative ("app:<type>:<name>"): draws only when chosen for its type (use). */
  alt?: boolean;
  mount?: ViewerMount;
};

type Failure = { count: number; last: string; at: number };
type OptionValues = Record<string, Record<string, unknown>>;
type Reg = {
  byKey: Map<string, ViewerEntry[]>;
  disabled: Set<string>;
  chosen: Map<string, string>;
  failures: Map<string, Failure>;
  options: OptionValues;
  version: number;
  fns: Set<() => void>;
  chains: Map<string, readonly ViewerEntry[]>;
};
const KEY = "__vcViewers";
function reg(): Reg {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Reg | undefined) ??= { byKey: new Map(), disabled: new Set(), chosen: new Map(), failures: new Map(), options: {}, version: 0, fns: new Set(), chains: new Map() });
}
function changed(): void {
  const r = reg();
  r.version++;
  r.chains.clear();
  for (const f of [...r.fns]) {
    try {
      f();
    } catch {
      /* a listener's problem */
    }
  }
}

/** Called on every change (a viewer registered, removed, enabled, disabled, chosen, an option set); returns off. */
export function subscribeViewers(fn: () => void): () => void {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
}
export const viewersVersion = (): number => reg().version;

// ---------------------------------------------------------------- keys

const MIME_TYPES: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/x-ipynb+json": "notebook",
  "application/x-tex": "tex",
  "text/x-tex": "tex",
  "text/plain": "code",
};
const MIME_EXTS: Record<string, string> = {
  "text/csv": "csv",
  "application/json": "json",
  "text/javascript": "js",
  "application/javascript": "js",
  "text/x-python": "py",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
  "text/css": "css",
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/zip": "zip",
};

/** A viewer's key from what a plugin or the agent names: a type, ".ext" (or "ext:csv"), or a MIME type. Throws on none. */
export function viewerKey(raw: unknown): string {
  const w = String(raw ?? "").trim().toLowerCase();
  if ((VIEWER_TYPES as readonly string[]).includes(w)) return w;
  const ext = w.startsWith(".") ? w.slice(1) : w.startsWith("ext:") ? w.slice(4) : null;
  if (ext !== null && /^[a-z0-9_+-]{1,16}$/.test(ext)) return `.${ext}`;
  if (w.includes("/")) {
    if (MIME_TYPES[w]) return MIME_TYPES[w];
    if (MIME_EXTS[w]) return `.${MIME_EXTS[w]}`;
    if (/^image\/(\*|[a-z0-9.+-]+)$/.test(w)) return "image";
    if (/^video\/(\*|[a-z0-9.+-]+)$/.test(w)) return "video";
    if (/^text\/\*$/.test(w)) return "code";
  }
  throw new Error(`"${String(raw)}" names no type of file (a type: ${VIEWER_TYPES.join(", ")}; an extension: ".csv"; or a MIME type: "application/pdf", "image/*")`);
}

/** A file's type and extension. */
export function fileViewerKeys(path: string): { type: FileKind; ext: string } {
  const { kind, ext } = fileKind(path);
  return { type: kind, ext };
}

// ---------------------------------------------------------------- registering

/** The app's own viewer for a type (replaces an earlier one; no change event: it is registered at load). */
export function registerBuiltinViewer(type: FileKind, component: unknown, meta: { name: string; ownHeader?: (mode: ViewerMode) => boolean; alwaysEdits?: boolean }): void {
  const r = reg();
  const id = `builtin:${type}`;
  const list = (r.byKey.get(type) ?? []).filter((x) => x.id !== id);
  r.byKey.set(type, [{ id, key: type, by: "app", builtin: true, component, name: meta.name, ...(meta.ownHeader ? { ownHeader: meta.ownHeader } : {}), ...(meta.alwaysEdits ? { alwaysEdits: true } : {}) }, ...list]);
  r.chains.clear();
}

/** An app alternative to the built-in viewer of a type: drawn only when chosen ("app:<type>:<name>"). */
export function registerAppViewer(type: FileKind, name: string, component: unknown, label: string): void {
  const r = reg();
  const id = `app:${type}:${name}`;
  const list = (r.byKey.get(type) ?? []).filter((x) => x.id !== id);
  r.byKey.set(type, [...list, { id, key: type, by: "app", builtin: false, alt: true, component, name: label }]);
  r.chains.clear();
}

/** A plugin's viewer over a type, extension or MIME type. Returns the undo. Throws on a bad key or mount. */
export function registerViewer(key: string, mount: ViewerMount, by: string, opts?: ViewerOptions): () => void {
  const k = viewerKey(key);
  if (typeof mount !== "function") throw new Error("a viewer is a function mount(el, file) → cleanup?");
  const r = reg();
  const id = `${by}#${k}`;
  const name = typeof opts?.name === "string" && opts.name.trim() ? opts.name.trim().slice(0, 80) : `${by.split("/").pop()} (${k})`;
  const entry: ViewerEntry = { id, key: k, by, builtin: false, name, mount };
  r.byKey.set(k, [...(r.byKey.get(k) ?? []).filter((x) => x.id !== id), entry]);
  r.failures.delete(id);
  changed();
  return () => {
    const list = (r.byKey.get(k) ?? []).filter((x) => x !== entry);
    if (list.length) r.byKey.set(k, list);
    else r.byKey.delete(k);
    changed();
  };
}

// ---------------------------------------------------------------- which viewer draws a file

/**
 * The viewers that draw a file of this type and extension, best first: the one chosen for the extension, else for
 * the type, else the newest enabled plugin viewer of the extension, then of the type, else the built-in; the built-in
 * after a plugin's. Empty: the plain fallback draws it. Cached until the next change.
 */
export function viewerChain(type: FileKind, ext: string): readonly ViewerEntry[] {
  const r = reg();
  const ck = `${type}|${ext}`;
  const hit = r.chains.get(ck);
  if (hit) return hit;
  const on = (k: string) => (r.byKey.get(k) ?? []).filter((x) => !r.disabled.has(x.id));
  const byExt = ext ? on(`.${ext}`) : [];
  const byType = on(type);
  const builtin = byType.find((x) => x.builtin);
  const pick = (k: string, list: ViewerEntry[]) => {
    const want = r.chosen.get(k);
    return want ? list.find((x) => x.id === want) : undefined;
  };
  const newest = (list: ViewerEntry[]) => [...list].reverse().find((x) => !x.builtin && !x.alt);
  // The one chosen for the extension may be one of its type's (builtin:code over a plugin's .csv viewer).
  const top = (ext ? pick(`.${ext}`, [...byExt, ...byType]) : undefined) ?? pick(type, byType) ?? newest(byExt) ?? newest(byType) ?? builtin;
  const chain = top ? (top === builtin || !builtin ? [top] : [top, builtin]) : [];
  r.chains.set(ck, chain);
  return chain;
}

/** A file's viewer chain. */
export function viewerChainFor(path: string): readonly ViewerEntry[] {
  const { type, ext } = fileViewerKeys(path);
  return viewerChain(type, ext);
}

/** A viewer threw: noted for the agent's state (the file falls back on its own). */
export function noteViewerFailure(id: string, e: unknown): void {
  const r = reg();
  const f = r.failures.get(id) ?? { count: 0, last: "", at: 0 };
  r.failures.set(id, { count: f.count + 1, last: String((e as Error)?.message ?? e).slice(0, 300), at: Date.now() });
}

/** A registered viewer by id, or null. */
export function viewerById(id: string): ViewerEntry | null {
  for (const list of reg().byKey.values()) for (const x of list) if (x.id === id) return x;
  return null;
}

/** The kept choices (app/viewer's state): the viewers turned off, the one chosen per key and the option values,
 *  replacing what was here. An id not registered (yet: a vault plugin not mounted) is kept for when it is. */
export function setViewerPrefs(disabled: Iterable<string>, chosen: Record<string, string>, options: OptionValues = {}): void {
  const r = reg();
  const d = new Set(disabled);
  const c = new Map(Object.entries(chosen).filter(([, id]) => typeof id === "string" && id));
  const o: OptionValues = {};
  for (const [type, kv] of Object.entries(options)) for (const [k, v] of Object.entries(kv)) if (v !== null && viewerOptionProblem(type, k, v) === null) (o[type] ??= {})[k] = v;
  const same =
    d.size === r.disabled.size &&
    [...d].every((x) => r.disabled.has(x)) &&
    c.size === r.chosen.size &&
    [...c].every(([k, v]) => r.chosen.get(k) === v) &&
    JSON.stringify(o) === JSON.stringify(r.options);
  if (same) return;
  r.disabled = d;
  r.chosen = c;
  r.options = o;
  changed();
}

// ---------------------------------------------------------------- modes

const EDIT_DEFAULT: Partial<Record<FileKind, boolean>> = { markdown: true, tex: true, code: true, html: false, notebook: false };

/** Whether Ctrl+E switches this type to the source editor (the `edit` option, else its default). */
export function editable(type: FileKind): boolean {
  if (!(TEXT_TYPES as readonly string[]).includes(type)) return false;
  const set = reg().options[type]?.edit;
  return typeof set === "boolean" ? set : !!EDIT_DEFAULT[type];
}

/** Why a value is not one a type's option takes (null: it is). The one option today: edit (boolean). */
export function viewerOptionProblem(type: string, key: string, value: unknown): string | null {
  if (!(VIEWER_TYPES as readonly string[]).includes(type)) return `"${type}" is not a type of file (types: ${VIEWER_TYPES.join(", ")})`;
  if (key !== "edit") return `a type's one option is "edit" (Ctrl+E switches it to the source editor), not "${key}"`;
  if (!(TEXT_TYPES as readonly string[]).includes(type)) return `a ${type} file is not text: it has no source editor (editable types: ${TEXT_TYPES.join(", ")})`;
  if (value === null || typeof value === "boolean") return null;
  return `"edit" takes true or false (null: back to its default)`;
}

/** Every type's modes: whether Ctrl+E edits it, its default, whether that is set. */
export function describeModes(): { type: string; edit: boolean; default: boolean; set: boolean }[] {
  const r = reg();
  return TEXT_TYPES.map((type) => ({ type, edit: editable(type), default: !!EDIT_DEFAULT[type], set: typeof r.options[type]?.edit === "boolean" }));
}

/** Every key with its viewers, as plain data (the agent's viewers state). */
export function describeViewers(): { key: string; active: string; viewers: { id: string; name: string; by: string; builtin: boolean; alternative?: boolean; enabled: boolean; failures?: Failure }[] }[] {
  const r = reg();
  const keys = [...new Set([...VIEWER_TYPES, ...r.byKey.keys()])];
  return keys.map((key) => {
    const chain = key.startsWith(".") ? viewerChain(fileViewerKeys(`x${key}`).type, key.slice(1)) : viewerChain(key as FileKind, "");
    return {
      key,
      active: chain[0]?.id ?? "fallback",
      viewers: (r.byKey.get(key) ?? []).map((x) => ({ id: x.id, name: x.name, by: x.by, builtin: x.builtin, ...(x.alt ? { alternative: true } : {}), enabled: !r.disabled.has(x.id), ...(r.failures.has(x.id) ? { failures: r.failures.get(x.id)! } : {}) })),
    };
  });
}

/** Tests: forget every plugin viewer and choice (the built-ins stay). */
export function _resetViewers(): void {
  const r = reg();
  for (const [k, list] of r.byKey) {
    const keep = list.filter((x) => x.builtin || x.alt);
    if (keep.length) r.byKey.set(k, keep);
    else r.byKey.delete(k);
  }
  r.disabled.clear();
  r.chosen.clear();
  r.failures.clear();
  r.options = {};
  changed();
}
