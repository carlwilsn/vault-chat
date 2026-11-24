// The chat's ⋯ menu's slot for plugins' entries (a "Summarize this chat", an "Export", a link to a page): an in-process page
// adds one live with api.host.chat.menuItem({...}) (src/hostApi.ts), and it is gone when the plugin stops (an effect of
// its run) or when it calls the returned off. The chat pane plugin (src/plugins/chat, app/chat) draws them (the ⋯ menu shows only
// when there is one) and offers them to the agent (state menu, action clickItem). A throwing click is the adding plugin's
// failure, not the menu's: the host's guard takes that plugin down, and its entries with it.
//
// No imports from the app and no React here: the registry is plain data the menu, the offers and the tests share.

export type ChatMenuItemSpec = {
  /** The entry's id, unique within its plugin (a second entry with the same id replaces the first). */
  id: string;
  /** What the entry says (and the name the agent sees). */
  label: string;
  /** The tooltip. */
  title?: string;
  /** Lower first; equal: the order they were added. */
  order?: number;
  /** A click on the entry (also the agent's clickItem). The menu closes after it. */
  onClick: () => void;
};
export type ChatMenuItem = Readonly<Required<Pick<ChatMenuItemSpec, "id" | "label" | "order" | "onClick">> & Pick<ChatMenuItemSpec, "title"> & {
  /** "<by>#<id>": unique in the menu. */
  key: string;
  /** The plugin that added it (its id). */
  by: string;
  seq: number;
}>;

type Reg = { items: Map<string, ChatMenuItem>; list: readonly ChatMenuItem[]; fns: Set<() => void>; seq: number };
const KEY = "__vcChatMenuItems";
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
      console.warn("[chat menu] a listener failed:", e);
    }
  }
}

/** Why a spec is refused, or null. */
export function chatMenuItemProblem(spec: unknown): string | null {
  const s = spec as ChatMenuItemSpec | null;
  if (!s || typeof s !== "object") return "an entry is an object: {id, label, onClick, title?, order?}";
  if (typeof s.id !== "string" || !s.id.trim()) return "an entry needs an id (a string)";
  if (typeof s.label !== "string" || !s.label.trim()) return "an entry needs a label (a string)";
  if (typeof s.onClick !== "function") return "an entry needs an onClick (a function)";
  if (s.title !== undefined && typeof s.title !== "string") return "title is a string";
  if (s.order !== undefined && !Number.isFinite(s.order)) return "order is a number";
  return null;
}

/** Add an entry for plugin `by`; the undo. Throws on a bad spec. */
export function registerChatMenuItem(spec: ChatMenuItemSpec, by: string): () => void {
  const why = chatMenuItemProblem(spec);
  if (why) throw new Error(`chat.menuItem: ${why}`);
  const r = reg();
  const id = spec.id.trim();
  const key = `${by}#${id}`;
  const item: ChatMenuItem = { ...spec, id, label: spec.label.trim(), order: spec.order ?? 0, key, by, seq: ++r.seq };
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

/** The entries now, in order (a stable array until something changes). */
export function chatMenuItems(): readonly ChatMenuItem[] {
  return reg().list;
}

/** Called on every change; the off. */
export function subscribeChatMenuItems(fn: () => void): () => void {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
}

/** An entry by its key ("<plugin>#<id>"), or by its id or label when that names one entry. */
export function chatMenuItemNamed(name: string): ChatMenuItem | null {
  const w = String(name ?? "").trim();
  if (!w) return null;
  const list = chatMenuItems();
  const exact = list.find((i) => i.key === w);
  if (exact) return exact;
  const low = w.toLowerCase();
  const hits = list.filter((i) => i.id.toLowerCase() === low || i.label.toLowerCase() === low);
  return hits.length === 1 ? hits[0]! : null;
}

/** For tests: forget every entry. */
export function _resetChatMenuItems(): void {
  const r = reg();
  r.items.clear();
  changed(r);
}
