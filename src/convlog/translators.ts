// The chat's translators: how each thing in a conversation's log (an item of the fold, ./reduce.ts) becomes the rows
// the chat shows (messages, ./view.ts). The second half of the chat pane as a plugin (reports/09 blocker #1): the rows'
// renderers (src/chatRows.ts) decide how a row looks; these decide what rows there are.
//
// Each event type has a chain of translators: the one chosen for it (use), else the newest enabled plugin translator,
// else the app's own (the built-in layer, ./view.ts). A translator answers the event with its messages, or with
// null / undefined to hand it to the next in line (next() gives that answer, so a plugin can also wrap it); one that
// throws is noted and skipped for that event. The app has alternatives of its own that draw only when chosen (the old
// "commentary under Thought").
//
// A vault plugin adds or overrides one live: api.host.chat.translate(type, (event, next) => messages | null), undone
// when it stops; app/chat-rows offers them to the agent (`translators` state; disableTranslator / enableTranslator /
// useTranslator, kept as plugin.state records). The box and the phone project through the same view with the
// built-ins only (no plugins register there).
//
// No imports from the app and no React: plain data, shared by the box, the laptop, the phone and the tests.
import type { Item } from "./reduce";

/** The types of event a translator answers (a user line's own via first, e.g. "user:job"; then "user"). */
export const TRANSLATE_TYPES: readonly string[] = [
  "user", "user:job", "user:delegate", "user:retry", "user:handoff", "user:wake", "user:nudge", "user:resume",
  "worker", "assistant", "thinking", "commentary", "compaction", "notice",
];

/** What a translator is given: the event's type, the log item (read-only), and for a worker line whether the same line
 *  was already said since the last reply (the box repeats some after a restart). */
export type TranslateEvent = { type: string; item: Readonly<Item>; retry?: boolean; repeat?: boolean };
/** A translator: the messages this event shows (any shape a chat message has; [] = nothing), or null to pass it on. */
export type Translator = (event: TranslateEvent, next: () => unknown[]) => unknown[] | null | undefined | void;

export type TranslatorEntry = {
  /** "builtin:<type>" for the app's own, "app:<type>:<name>" for its alternatives, "<plugin id>#<type>" for a plugin's. */
  id: string;
  type: string;
  by: string;
  builtin: boolean;
  /** An alternative of the app's: draws only when chosen. */
  alt?: boolean;
  description?: string;
  fn: Translator;
};

type Failure = { count: number; last: string; at: number };
type Reg = {
  byType: Map<string, TranslatorEntry[]>;
  disabled: Set<string>;
  chosen: Map<string, string>;
  failures: Map<string, Failure>;
  version: number;
  fns: Set<() => void>;
  chains: Map<string, readonly TranslatorEntry[]>;
};
const KEY = "__vcChatTranslators";
function reg(): Reg {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Reg | undefined) ??= { byType: new Map(), disabled: new Set(), chosen: new Map(), failures: new Map(), version: 0, fns: new Set(), chains: new Map() });
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

/** Called on every change (a translator registered, removed, enabled, disabled, chosen); returns off. */
export function subscribeTranslators(fn: () => void): () => void {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
}
export const translatorsVersion = (): number => reg().version;

const TYPE_RE = /^[a-z][a-z-]*(:[a-z][a-z0-9_-]{0,40})?$/;

/** The app's own translator of a type (at load; replaces an earlier one). opts.alt: an alternative, only when chosen. */
export function registerBuiltinTranslator(type: string, fn: Translator, opts: { alt?: string; description?: string } = {}): void {
  const r = reg();
  const id = opts.alt ? `app:${type}:${opts.alt}` : `builtin:${type}`;
  const list = (r.byType.get(type) ?? []).filter((x) => x.id !== id);
  const entry: TranslatorEntry = { id, type, by: "app", builtin: !opts.alt, ...(opts.alt ? { alt: true } : {}), ...(opts.description ? { description: opts.description } : {}), fn };
  r.byType.set(type, opts.alt ? [...list, entry] : [entry, ...list]);
  r.chains.clear();
}

/** A plugin's translator for a type. Returns the undo. */
export function registerTranslator(type: string, fn: Translator, by: string): () => void {
  const t = String(type ?? "");
  if (!TYPE_RE.test(t)) throw new Error(`chat event type "${t}" is not a type (types: ${TRANSLATE_TYPES.join(", ")}; a user line by how it came in: user:<via>)`);
  if (typeof fn !== "function") throw new Error("a chat translator is a function (event, next) => messages | null");
  const r = reg();
  const id = `${by}#${t}`;
  const entry: TranslatorEntry = { id, type: t, by, builtin: false, fn };
  r.byType.set(t, [...(r.byType.get(t) ?? []).filter((x) => x.id !== id), entry]);
  r.failures.delete(id);
  changed();
  return () => {
    const list = (r.byType.get(t) ?? []).filter((x) => x !== entry);
    if (list.length) r.byType.set(t, list);
    else r.byType.delete(t);
    changed();
  };
}

/** The translators of a type, best first: the chosen one, else the newest enabled plugin's, else the built-in; then the built-in. */
export function translatorChain(type: string): readonly TranslatorEntry[] {
  const r = reg();
  const hit = r.chains.get(type);
  if (hit) return hit;
  const list = (r.byType.get(type) ?? []).filter((x) => !r.disabled.has(x.id));
  const builtin = list.find((x) => x.builtin);
  const chosenId = r.chosen.get(type);
  const chosen = chosenId ? list.find((x) => x.id === chosenId) : undefined;
  const top = chosen ?? [...list].reverse().find((x) => !x.builtin && !x.alt) ?? builtin;
  const chain = top ? (top === builtin || !builtin ? [top] : [top, builtin]) : [];
  r.chains.set(type, chain);
  return chain;
}

/** Whether a type has translators of its own (a user line's via falls back to "user" when not). */
export const hasTranslators = (type: string): boolean => (reg().byType.get(type)?.length ?? 0) > 0;

function noteFailure(id: string, e: unknown): void {
  const r = reg();
  const f = r.failures.get(id) ?? { count: 0, last: "", at: 0 };
  r.failures.set(id, { count: f.count + 1, last: String((e as Error)?.message ?? e).slice(0, 300), at: Date.now() });
}

/** The messages an event shows: its chain in order (null hands on; a throw is noted and handed on); none left: none. */
export function translate(event: TranslateEvent): unknown[] {
  const chain = translatorChain(event.type);
  const at = (i: number): unknown[] => {
    const t = chain[i];
    if (!t) return [];
    let out: unknown;
    try {
      out = t.fn(event, () => at(i + 1));
    } catch (e) {
      noteFailure(t.id, e);
      return at(i + 1);
    }
    if (out === null || out === undefined) return at(i + 1);
    if (!Array.isArray(out)) {
      noteFailure(t.id, new Error("a translator returns an array of messages, or null"));
      return at(i + 1);
    }
    return out.filter((m) => m && typeof m === "object");
  };
  return at(0);
}

function find(id: string): TranslatorEntry | null {
  for (const list of reg().byType.values()) for (const x of list) if (x.id === id) return x;
  return null;
}
export const translatorById = (id: string): TranslatorEntry | null => find(id);

/** The kept choices (app/chat-rows' state): translators turned off, the one chosen per type. Unknown ids are kept. */
export function setTranslatorPrefs(disabled: Iterable<string>, chosen: Record<string, string>): void {
  const r = reg();
  const d = new Set(disabled);
  const c = new Map(Object.entries(chosen).filter(([, id]) => typeof id === "string" && id));
  const same = d.size === r.disabled.size && [...d].every((x) => r.disabled.has(x)) && c.size === r.chosen.size && [...c].every(([k, v]) => r.chosen.get(k) === v);
  if (same) return;
  r.disabled = d;
  r.chosen = c;
  changed();
}

/** Every type with its translators, as plain data (the agent's translators state). */
export function describeTranslators(): { type: string; active: string; translators: { id: string; by: string; builtin: boolean; alt?: boolean; enabled: boolean; description?: string; failures?: Failure }[] }[] {
  const r = reg();
  const types = [...new Set([...TRANSLATE_TYPES, ...r.byType.keys()])];
  return types.map((type) => ({
    type,
    active: translatorChain(type)[0]?.id ?? (type.startsWith("user:") ? "user" : "none"),
    translators: (r.byType.get(type) ?? []).map((x) => ({
      id: x.id,
      by: x.by,
      builtin: x.builtin,
      ...(x.alt ? { alt: true } : {}),
      enabled: !r.disabled.has(x.id),
      ...(x.description ? { description: x.description } : {}),
      ...(r.failures.has(x.id) ? { failures: r.failures.get(x.id)! } : {}),
    })),
  }));
}

/** Tests: forget every plugin translator and choice (the app's own stay). */
export function _resetTranslators(): void {
  const r = reg();
  for (const [k, list] of r.byType) {
    const keep = list.filter((x) => x.builtin || x.alt);
    if (keep.length) r.byType.set(k, keep);
    else r.byType.delete(k);
  }
  r.disabled.clear();
  r.chosen.clear();
  r.failures.clear();
  changed();
}
