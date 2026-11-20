// Live widgets inside notes (plugin refactor point 7): a fenced block in a markdown note
//
//   ```widget
//   widgets/counter.js
//   anything after the first line is the block's own text (api.block.text)
//   ```
//
// (or ```widget widgets/counter.js```, the path on the fence line) shows that widget live in the note, in place, in the
// viewer's rendered view (src/NoteWidget.tsx). The widget is a vault .js / .mjs module exporting `mount(el, api)` (the
// in-process host's contract, src/mountHost.ts), or a page that declares
// `<meta name="vc-mount" content="in-process">`. It mounts in a shadow root when it scrolls near the view (a long note
// with many widgets opens as fast as without), and whatever it throws is an error card in its place: the note stands.
//
// What it gets beyond the host's api (size, theme, listen/timer/effect, offer, plugins, context, ...):
//   api.note:  path, text(), headings(), section() (the heading it sits under and that section's text), onChange(fn)
//              (the note was edited or written: fn(text)): it reads and reacts to the note around it.
//   api.block: {text, index, widget}: its own block's text after the path, its place among the note's widgets, its file.
//   api.state: get(key) / all() / set(key, value) / onChange(fn): its own state as plugin.state records in the one log
//              (id `widget:<instance>`, src/appPluginState.ts), the same in every window and after a restart.
// Its id (offers, error card, api.path) is the instance: `<note path>#<widget path>`, `~2` for a second embed of the
// same widget in that note. The supervisor's on/off is the widget file's (turn off counter.js: every embed goes).
// Pure: no React, no app imports (tests run it as is).

export const WIDGET_LANG = "widget";
/** The plugin.state id prefix of a note widget's state (src/appPluginState.ts, server/pluginState.ts). */
export const WIDGET_STATE_PREFIX = "widget:";

export type WidgetBlock = { src: string; text: string };

/** A widget block's body: the first non-empty line is the widget's path, the rest is the block's own text. */
export function parseWidgetBlock(body: string): WidgetBlock {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trim() !== "");
  if (at < 0) return { src: "", text: "" };
  return { src: lines[at]!.trim(), text: lines.slice(at + 1).join("\n").replace(/\n+$/, "") };
}

/** Whether a fence's info string makes it a widget block (```widget, ```widget path). */
export const isWidgetInfo = (info: string | null | undefined): boolean => String(info ?? "").trim().split(/\s+/)[0]?.toLowerCase() === WIDGET_LANG;

/** remark: ```widget path``` (the path on the fence line) carries the path into the block's body, so the rendered block
 *  has it (rehype-raw does not keep a code element's meta). */
export function remarkWidgetMeta() {
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "code" && typeof n.lang === "string" && n.lang.toLowerCase() === WIDGET_LANG && typeof n.meta === "string" && n.meta.trim()) {
      n.value = `${n.meta.trim()}\n${n.value ?? ""}`;
      n.meta = null;
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  };
  return (tree: any) => walk(tree);
}

/** The text of a rendered block (a hast node). */
export function hastText(n: any): string {
  if (!n || typeof n !== "object") return "";
  if (n.type === "text") return String(n.value ?? "");
  return Array.isArray(n.children) ? n.children.map(hastText).join("") : "";
}

/** The widget block a rendered `<pre>` is, or null: its `<code class="language-widget">`'s text. */
export function widgetBlockOfPre(node: any): WidgetBlock | null {
  const code = Array.isArray(node?.children) ? node.children.find((c: any) => c?.type === "element") : null;
  if (!code || code.tagName !== "code") return null;
  const cls = code.properties?.className;
  const list: string[] = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(/\s+/) : [];
  if (!list.some((c) => c.toLowerCase() === `language-${WIDGET_LANG}`)) return null;
  return parseWidgetBlock(hastText(code));
}

const norm = (p: string) => String(p ?? "").replace(/\\/g, "/");
const dirOf = (p: string) => {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
};
function join(base: string, rel: string): string | null {
  const out = base ? base.split("/") : [];
  const lead = base.startsWith("/") ? "/" : "";
  if (lead) out.shift();
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return lead + out.join("/");
}

/** Where a block's widget path may be, in order: next to the note, then from the vault's root (a leading `/` is the
 *  vault's root only). Absolute paths; none outside the vault. */
export function widgetCandidates(notePath: string, src: string, vault: string | null | undefined): string[] {
  const s = norm(src).trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s)) return [];
  const root = norm(vault ?? "").replace(/\/+$/, "");
  const inside = (p: string | null): p is string => !!p && (!root || p.toLowerCase().startsWith(root.toLowerCase() + "/"));
  const out: string[] = [];
  if (!s.startsWith("/")) {
    const near = join(dirOf(notePath), s);
    if (inside(near)) out.push(near);
  }
  if (root) {
    const fromRoot = join(root, s.replace(/^\/+/, ""));
    if (inside(fromRoot) && !out.includes(fromRoot)) out.push(fromRoot);
  }
  return out;
}

export type WidgetKind = "module" | "page" | null;
/** What a widget file is: a module (.js, .mjs), a page (.html), or nothing a note can embed. */
export function widgetKind(path: string): WidgetKind {
  if (/\.m?js$/i.test(path)) return "module";
  if (/\.html?$/i.test(path)) return "page";
  return null;
}

/** The instance's id: `<note>#<widget>`, `~n` for the n-th embed (n > 1) of the same widget in the note. */
export function widgetInstanceId(noteRel: string, widgetRel: string, nth: number): string {
  return `${norm(noteRel)}#${norm(widgetRel)}${nth > 1 ? `~${nth}` : ""}`;
}

export type Heading = { level: number; text: string; line: number };
export type Fence = { line: number; end: number; src: string; text: string };

/** The note's headings (ATX, outside code fences) and its widget blocks, with their 1-based lines. */
export function noteOutline(text: string): { headings: Heading[]; widgets: Fence[] } {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const headings: Heading[] = [];
  const widgets: Fence[] = [];
  let fence: { mark: string; line: number; info: string; body: string[] } | null = null;
  let front = lines[0] === "---";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (front) {
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(l)) front = false;
      continue;
    }
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.mark[0] === "`" ? "`" : "~"}{${fence.mark.length},}\\s*$`);
      if (close.test(l)) {
        if (isWidgetInfo(fence.info)) {
          const meta = fence.info.trim().split(/\s+/).slice(1).join(" ");
          const b = parseWidgetBlock((meta ? meta + "\n" : "") + fence.body.join("\n"));
          widgets.push({ line: fence.line, end: i + 1, ...b });
        }
        fence = null;
      } else fence.body.push(l);
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = { mark: f[1]!, line: i + 1, info: f[2]!, body: [] };
      continue;
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!.trim(), line: i + 1 });
  }
  return { headings, widgets };
}

/** The section a line sits in: the nearest heading above it and the text up to the next heading of its level or
 *  higher (from the note's top when no heading is above). */
export function sectionAt(text: string, line: number): { heading: Heading | null; text: string } {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const { headings } = noteOutline(text);
  let h: Heading | null = null;
  for (const x of headings) if (x.line <= line) h = x;
  const start = h ? h.line : 1;
  const next = headings.find((x) => x.line > start && (!h || x.level <= h.level));
  const end = next ? next.line - 1 : lines.length;
  return { heading: h, text: lines.slice(start - 1, end).join("\n") };
}

/** A note's live text for its widgets: the viewer sets it on each change; widgets read it and follow it. */
export class NoteSource {
  private listeners = new Set<(text: string) => void>();
  constructor(public readonly path: string, private current: string) {}
  get text(): string {
    return this.current;
  }
  set(text: string): void {
    if (text === this.current) return;
    this.current = text;
    for (const fn of [...this.listeners]) {
      try {
        fn(text);
      } catch {
        /* a widget's listener is guarded by its host */
      }
    }
  }
  subscribe(fn: (text: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

export type NoteApi = {
  path: string;
  text(): string;
  headings(): Heading[];
  section(): { heading: Heading | null; text: string };
  onChange(fn: (text: string) => void): () => void;
};
export type StateApi = {
  get(key: string): unknown;
  all(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<string | null>;
  onChange(fn: (state: Record<string, unknown>) => void): () => void;
};
/** How the host keeps a plugin's state (the app: src/appPluginState.ts). */
export type StateStore = {
  read(id: string): Record<string, unknown>;
  write(id: string, key: string, value: unknown): Promise<string | null>;
  subscribe(fn: (id: string) => void): () => void;
};

/** The extra api a note widget gets (merged into the host's by mountPlugin's `extend`): `alive` is whether its run still
 *  stands, `effect` keeps an undo for when it stops, `guard` makes a throw its own failure. */
export function noteWidgetApi(
  o: { source: NoteSource; notePath: string; index: number; widget: string; blockText: string; stateId: string; store: StateStore },
  ctx: { alive: () => boolean; effect: (label: string, undo: () => void) => void; guard: <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => void },
): { note: NoteApi; block: { text: string; index: number; widget: string }; state: StateApi } {
  const on = <T>(sub: (fn: (x: T) => void) => () => void, fn: (x: T) => void, label: string) => {
    if (!ctx.alive() || typeof fn !== "function") return () => {};
    const g = ctx.guard(fn);
    const off = sub((x) => {
      if (ctx.alive()) g(x);
    });
    ctx.effect(label, off);
    return off;
  };
  const note: NoteApi = {
    path: o.notePath,
    text: () => o.source.text,
    headings: () => noteOutline(o.source.text).headings,
    section: () => {
      const w = noteOutline(o.source.text).widgets[o.index];
      return sectionAt(o.source.text, w ? w.line : 1);
    },
    onChange: (fn) => on((f) => o.source.subscribe(f), fn, "note subscription"),
  };
  const state: StateApi = {
    get: (key) => o.store.read(o.stateId)[String(key)],
    all: () => ({ ...o.store.read(o.stateId) }),
    set: (key, value) => (ctx.alive() ? o.store.write(o.stateId, String(key), value) : Promise.resolve("the widget has stopped")),
    onChange: (fn) =>
      on<string>(
        (f) => o.store.subscribe((id) => id === o.stateId && f(id)),
        () => fn({ ...o.store.read(o.stateId) }),
        "state subscription",
      ),
  };
  return { note, block: { text: o.blockText, index: o.index, widget: o.widget }, state };
}
