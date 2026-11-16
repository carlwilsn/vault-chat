// The title bar's slot for plugins' items (a pinned-apps launcher, a plugin menu, a status light): a vault plugin adds
// one live with api.host.titlebar.item({...}) (src/hostApi.ts), and it is gone when the plugin stops (an effect of its
// run) or when it calls the returned off. The title bar plugin (src/plugins/titlebar, app/titlebar) draws them, left
// (after the app's own buttons) or right (before the sync chip), and offers them to the agent (state items, action
// clickItem). An item is a button (label / icon text or <svg> markup, title, onClick) or draws itself (render(el) into a
// plain inline element; a cleanup when it goes). A throwing render or click is the adding plugin's failure, not the
// bar's: the host's guard takes that plugin down, and its items with it.
//
// No imports from the app and no React here: the registry is plain data the bar, the offers and the tests share.

export type TitlebarSide = "left" | "right";
export type TitlebarItemSpec = {
  /** The item's id, unique within its plugin (a second item with the same id replaces the first). */
  id: string;
  /** Where in the bar: "left" (after the app's own buttons, the default) or "right" (before the sync chip). */
  side?: TitlebarSide;
  /** A short text drawn in the button (when there is no icon), and the name the agent sees. */
  label?: string;
  /** The tooltip (and the button's accessible name). */
  title?: string;
  /** An icon: <svg ...> markup, or a character or two (an emoji). */
  icon?: string;
  /** Lower first; equal: the order they were added. */
  order?: number;
  /** A click on the button (also the agent's clickItem). */
  onClick?: () => void;
  /** Draw the item itself into `el` (a plain inline-flex element in the bar); return a cleanup. */
  render?: (el: HTMLElement) => void | (() => void);
};
export type TitlebarItem = Readonly<Required<Pick<TitlebarItemSpec, "id" | "side" | "order">> & Omit<TitlebarItemSpec, "id" | "side" | "order"> & {
  /** "<by>#<id>": unique in the bar. */
  key: string;
  /** The plugin that added it (its id). */
  by: string;
  /** Added when (a counter: the tie-break of `order`). */
  seq: number;
}>;

type Reg = { items: Map<string, TitlebarItem>; list: readonly TitlebarItem[]; fns: Set<() => void>; seq: number };
const KEY = "__vcTitlebarItems";
function reg(): Reg {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Reg | undefined) ??= { items: new Map(), list: [], fns: new Set(), seq: 0 });
}
function changed(r: Reg): void {
  r.list = [...r.items.values()].sort((a, b) => a.order - b.order || a.seq - b.seq);
  for (const f of [...r.fns]) {
    try {
      f();
    } catch (e) {
      console.warn("[titlebar] a listener failed:", e);
    }
  }
}

/** Why a spec is refused, or null. */
export function titlebarItemProblem(spec: unknown): string | null {
  const s = spec as TitlebarItemSpec | null;
  if (!s || typeof s !== "object") return "an item is an object: {id, label or icon or render, onClick?, title?, side?}";
  if (typeof s.id !== "string" || !s.id.trim()) return "an item needs an id (a string)";
  if (s.side !== undefined && s.side !== "left" && s.side !== "right") return `side is "left" or "right", not ${JSON.stringify(s.side)}`;
  if (s.onClick !== undefined && typeof s.onClick !== "function") return "onClick is a function";
  if (s.render !== undefined && typeof s.render !== "function") return "render is a function";
  if (!s.render && !(typeof s.label === "string" && s.label.trim()) && !(typeof s.icon === "string" && s.icon.trim())) return "an item needs a label, an icon or a render";
  for (const k of ["label", "title", "icon"] as const) if (s[k] !== undefined && typeof s[k] !== "string") return `${k} is a string`;
  if (s.order !== undefined && !Number.isFinite(s.order)) return "order is a number";
  return null;
}

/** Add an item for plugin `by`; the undo. Throws on a bad spec. */
export function registerTitlebarItem(spec: TitlebarItemSpec, by: string): () => void {
  const why = titlebarItemProblem(spec);
  if (why) throw new Error(`titlebar.item: ${why}`);
  const r = reg();
  const id = spec.id.trim();
  const key = `${by}#${id}`;
  const item: TitlebarItem = {
    ...spec,
    id,
    side: spec.side ?? "left",
    order: spec.order ?? 0,
    key,
    by,
    seq: ++r.seq,
  };
  r.items.set(key, item);
  changed(r);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (r.items.get(key) !== item) return;
    r.items.delete(key);
    changed(r);
  };
}

/** The items now, in order (a stable array until something changes). */
export function titlebarItems(): readonly TitlebarItem[] {
  return reg().list;
}

/** Called on every change; the off. */
export function subscribeTitlebarItems(fn: () => void): () => void {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
}

/** An item by its key ("<plugin>#<id>"), or by its id or label when that names one item. */
export function titlebarItemNamed(name: string): TitlebarItem | null {
  const w = String(name ?? "").trim();
  if (!w) return null;
  const list = titlebarItems();
  const exact = list.find((i) => i.key === w);
  if (exact) return exact;
  const low = w.toLowerCase();
  const hits = list.filter((i) => i.id.toLowerCase() === low || (i.label ?? "").toLowerCase() === low || (i.title ?? "").toLowerCase() === low);
  return hits.length === 1 ? hits[0] : null;
}

/** For tests: forget every item. */
export function _resetTitlebarItems(): void {
  const r = reg();
  r.items.clear();
  changed(r);
}
