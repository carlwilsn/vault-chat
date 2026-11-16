// The chat transcript's rows are rendered by renderers looked up here (the chat pane's first step to a plugin,
// reports/09 blocker #1). Each row has a kind (kindOf: a user bubble, an agent reply, a notice, the compaction divider,
// a job's end, a voice line, a voice ask, the plan card) and parts of a reply have kinds of their own (each tool call,
// "tool-call" or "tool-call:<Name>"; a vault .html shown inline, "inline-html"). The app's own renderers are registered
// as the built-in layer (src/plugins/chat-rows/rows.tsx); a plugin registers one over a kind live, with no release:
// a vault plugin through api.host.chat.row(kind, render) (render(el, row) draws into a plain element), undone when it
// stops. Which renderer draws a kind: the one chosen for it (use), else the newest enabled plugin renderer, else the
// built-in; a throwing renderer falls back down that chain to the built-in, then to the plain fallback row, for that row
// only. The app plugin app/chat-rows (src/plugins/chat-rows/index.ts) offers all this to the agent (PluginRead/Act).
//
// No imports from the app and no React here: the registry is plain data the app and the tests share.

/** What a row is, from its message. */
export type RowKind = "divider" | "job" | "working" | "notice" | "voice-ask" | "voice" | "user" | "assistant";
export const ROW_KINDS: readonly string[] = ["divider", "job", "working", "notice", "voice-ask", "voice", "user", "assistant", "plan", "tool-call", "inline-html"];

/** What a plugin's renderer is given: the row's kind, its index in the chat, and its data (the message, a tool call,
 *  a plan's steps, an inline page's src). */
export type RowData = { kind: string; index?: number; message?: unknown; tool?: unknown; todos?: unknown; src?: string; alt?: string };
/** A plugin's renderer: draw the row into `el` (a plain block element in the transcript); return a cleanup, if any. */
export type DomRender = (el: HTMLElement, row: RowData) => void | (() => void);

export type RowRenderer = {
  /** Unique: "builtin:<kind>" for the app's own, "<plugin id>#<kind>" for a plugin's. */
  id: string;
  kind: string;
  /** Who registered it: "app" or the plugin's id. */
  by: string;
  builtin: boolean;
  /** The app's own: a React component (typed loosely here: this module knows no React). */
  component?: unknown;
  dom?: DomRender;
};

type Failure = { count: number; last: string; at: number };

const KEY = "__vcChatRows";
type Reg = {
  byKind: Map<string, RowRenderer[]>;
  disabled: Set<string>;
  chosen: Map<string, string>;
  failures: Map<string, Failure>;
  version: number;
  fns: Set<() => void>;
  chains: Map<string, readonly RowRenderer[]>;
};
function reg(): Reg {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Reg | undefined) ??= { byKind: new Map(), disabled: new Set(), chosen: new Map(), failures: new Map(), version: 0, fns: new Set(), chains: new Map() });
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

/** Called on every change (a renderer registered, removed, enabled, disabled, chosen); returns off. */
export function subscribeRows(fn: () => void): () => void {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
}
export const rowsVersion = (): number => reg().version;

const KIND_RE = /^[a-z][a-z-]*(:[A-Za-z0-9_.-]{1,80})?$/;

/** The app's own renderer for a kind (replaces an earlier one; no change event: it is registered at load). */
export function registerBuiltin(kind: string, component: unknown): void {
  const r = reg();
  const id = `builtin:${kind}`;
  const list = (r.byKind.get(kind) ?? []).filter((x) => x.id !== id);
  r.byKind.set(kind, [{ id, kind, by: "app", builtin: true, component }, ...list]);
  r.chains.clear();
}

/** A plugin's renderer over a kind. Returns the undo. */
export function registerRow(kind: string, render: DomRender, by: string): () => void {
  const k = String(kind ?? "");
  if (!KIND_RE.test(k)) throw new Error(`chat row kind "${k}" is not a kind (kinds: ${ROW_KINDS.join(", ")}; a tool's own: tool-call:<Name>)`);
  if (typeof render !== "function") throw new Error("a chat row renderer is a function render(el, row)");
  const r = reg();
  const id = `${by}#${k}`;
  const entry: RowRenderer = { id, kind: k, by, builtin: false, dom: render };
  r.byKind.set(k, [...(r.byKind.get(k) ?? []).filter((x) => x.id !== id), entry]);
  r.failures.delete(id);
  changed();
  return () => {
    const list = (r.byKind.get(k) ?? []).filter((x) => x !== entry);
    if (list.length) r.byKind.set(k, list);
    else r.byKind.delete(k);
    changed();
  };
}

/**
 * The renderers that draw a kind, best first: the chosen one, else the newest enabled plugin renderer, else the
 * built-in; then the built-in after a plugin's. Empty: the fallback row draws it. Cached until the next change.
 */
export function rowChain(kind: string): readonly RowRenderer[] {
  const r = reg();
  const hit = r.chains.get(kind);
  if (hit) return hit;
  const list = (r.byKind.get(kind) ?? []).filter((x) => !r.disabled.has(x.id));
  const builtin = list.find((x) => x.builtin);
  const chosenId = r.chosen.get(kind);
  const chosen = chosenId ? list.find((x) => x.id === chosenId) : undefined;
  const top = chosen ?? [...list].reverse().find((x) => !x.builtin) ?? builtin;
  const chain = top ? (top === builtin || !builtin ? [top] : [top, builtin]) : [];
  r.chains.set(kind, chain);
  return chain;
}

/** A tool call's chain: its own kind ("tool-call:Bash") when one is registered, else "tool-call". */
export function toolChain(name: string): readonly RowRenderer[] {
  const own = reg().byKind.has(`tool-call:${name}`) ? rowChain(`tool-call:${name}`) : [];
  return own.length ? own : rowChain("tool-call");
}

/** A renderer threw: noted for the agent's state (the row falls back on its own). */
export function noteRowFailure(id: string, e: unknown): void {
  const r = reg();
  const f = r.failures.get(id) ?? { count: 0, last: "", at: 0 };
  r.failures.set(id, { count: f.count + 1, last: String((e as Error)?.message ?? e).slice(0, 300), at: Date.now() });
}

function findRenderer(id: string): RowRenderer | null {
  for (const list of reg().byKind.values()) for (const x of list) if (x.id === id) return x;
  return null;
}

/** Turn a renderer off (its kind falls to the next in line; the built-in off: the plain fallback row) or on. */
export function setRowEnabled(id: string, on: boolean): RowRenderer {
  const x = findRenderer(id);
  if (!x) throw new Error(`no chat row renderer "${id}" (see the renderers state)`);
  const r = reg();
  if (on) r.disabled.delete(id);
  else r.disabled.add(id);
  changed();
  return x;
}

/** Choose which registered renderer draws a kind; null: back to the default order. */
export function chooseRowRenderer(kind: string, id: string | null): void {
  const r = reg();
  if (id === null) r.chosen.delete(kind);
  else {
    const x = findRenderer(id);
    if (!x || x.kind !== kind) throw new Error(`no renderer "${id}" for kind "${kind}" (see the renderers state)`);
    r.disabled.delete(id);
    r.chosen.set(kind, id);
  }
  changed();
}

/** Every kind with its renderers, as plain data (the agent's renderers state). */
export function describeRows(): { kind: string; active: string; renderers: { id: string; by: string; builtin: boolean; enabled: boolean; failures?: Failure }[] }[] {
  const r = reg();
  const kinds = [...new Set([...ROW_KINDS, ...r.byKind.keys()])];
  return kinds.map((kind) => ({
    kind,
    active: rowChain(kind)[0]?.id ?? "fallback",
    renderers: (r.byKind.get(kind) ?? []).map((x) => ({ id: x.id, by: x.by, builtin: x.builtin, enabled: !r.disabled.has(x.id), ...(r.failures.has(x.id) ? { failures: r.failures.get(x.id)! } : {}) })),
  }));
}

// ---------------------------------------------------------------- what is on screen

/** A window event (detail {index}): the chat pane draws its rows from that message down (src/ChatPane.tsx). */
export const CHAT_REVEAL_EVENT = "vc-chat-reveal";

type Msg = {
  role?: string; content?: string; display?: string; mid?: string; hidden?: boolean; system?: boolean; working?: unknown;
  job?: unknown; voice?: unknown; voiceAsk?: unknown; toolCalls?: { name?: string }[]; dividerSummary?: unknown;
};

/** A message's row kind (the order the transcript always used: the divider first, then a job's end, ...). */
export function kindOf(m: Msg, isDivider: (m: unknown) => boolean): RowKind {
  if (isDivider(m)) return "divider";
  if (m.job) return "job";
  if (m.system && m.working) return "working";
  if (m.system) return "notice";
  if (m.voiceAsk) return "voice-ask";
  if (m.voice) return "voice";
  return m.role === "user" ? "user" : "assistant";
}

let view: { messages: readonly Msg[]; windowStart: number; isDivider: (m: unknown) => boolean } | null = null;
/** The transcript tells what it shows (no work here: the summary is made when the agent reads it). */
export function setVisibleRows(messages: readonly Msg[], windowStart: number, isDivider: (m: unknown) => boolean): void {
  view = { messages, windowStart, isDivider };
}

const one = (t: string, n: number) => {
  const x = t.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
};

/** The rows on screen now: index, kind, renderer, id, a line of text and its tool calls. */
export function visibleRows(limit = 60): { total: number; shownFrom: number; rows: Record<string, unknown>[] } {
  if (!view) return { total: 0, shownFrom: 0, rows: [] };
  const { messages, windowStart, isDivider } = view;
  const rows: Record<string, unknown>[] = [];
  for (let i = windowStart; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.hidden) continue;
    const kind = kindOf(m, isDivider);
    const tools = (m.toolCalls ?? []).map((t) => String(t?.name ?? "")).filter(Boolean);
    rows.push({ index: i, kind, renderer: rowChain(kind)[0]?.id ?? "fallback", ...(m.mid ? { mid: m.mid } : {}), text: one(String(m.display ?? m.content ?? ""), 140), ...(tools.length ? { tools } : {}) });
  }
  return { total: messages.length, shownFrom: windowStart, rows: rows.slice(-Math.max(1, limit)) };
}

/** Tests: forget every plugin renderer and choice (the built-ins stay). */
export function _resetRows(): void {
  const r = reg();
  for (const [k, list] of r.byKind) {
    const keep = list.filter((x) => x.builtin);
    if (keep.length) r.byKind.set(k, keep);
    else r.byKind.delete(k);
  }
  r.disabled.clear();
  r.chosen.clear();
  r.failures.clear();
  view = null;
  changed();
}
