// The app's own plugins' state (app/<name>, src/appPlugins.ts) as plugin.state records in the one log, like a page's
// (src/pluginRecords.ts; the box's side, server/pluginState.ts appPluginStateRoute). A choice an app plugin keeps (which
// chat row renderer is off, which one draws a kind) is a record on the box, so it survives a restart and every window
// of the app shows the same: the app reads the states once when its chat connects (GET /api/v2/plugin/app-state), folds
// every plugin.state record for an app plugin that arrives on the feed it already polls (src/boxChat.ts), and writes a
// change as a record (POST), applied here at once.
//
// What the first paint needs before the box answers comes from a copy in localStorage per vault, written only from the
// fold (a cache, never a second truth; log seqs never go back, so the box's records fold on top of it).
// A migrated plugin (src/migrations.ts) is in an epoch: the box's answer says which, and the fold takes only that
// epoch's records (a switch record carries the whole state it switches to).
import { boxGet, boxLinkFor, boxPost, type Link } from "./boxChat";
import { useStore } from "./store";
import { foldPluginState, type PluginState } from "./pluginRecords";

const CACHE = "vc.appstate:";
// A note widget's state (src/noteWidgets.ts, `widget:<note>#<widget>`) is kept the same way: Carl's devices write it.
const isApp = (id: unknown): id is string => typeof id === "string" && (id.startsWith("app/") || id.startsWith("widget:"));

let vault: string | null | undefined;
let states = new Map<string, PluginState>();
const subs = new Set<(plugin: string) => void>();

function forVault(): void {
  const v = useStore.getState().vaultPath ?? null;
  if (v === vault) return;
  const first = vault === undefined;
  vault = v;
  const was = [...states.keys()];
  states = new Map();
  try {
    const raw = v ? globalThis.localStorage?.getItem(CACHE + v) : null;
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === "object") for (const [k, s] of Object.entries(o as Record<string, PluginState>)) if (isApp(k) && s && typeof s === "object") states.set(k, { seq: Number(s.seq) || 0, state: { ...(s.state ?? {}) }, ...(typeof s.epoch === "string" && s.epoch ? { epoch: s.epoch } : {}) });
  } catch {
    /* no copy: the box's answer */
  }
  // Another vault: whoever follows a plugin's state reads it again.
  if (!first) for (const id of new Set([...was, ...states.keys()])) tell(id);
}

function keep(): void {
  try {
    if (vault) globalThis.localStorage?.setItem(CACHE + vault, JSON.stringify(Object.fromEntries(states)));
  } catch {
    /* no storage: the next start waits for the box */
  }
}

function tell(plugin: string): void {
  for (const f of [...subs]) {
    try {
      f(plugin);
    } catch {
      /* a listener's problem */
    }
  }
}

/** An app plugin's state as this window knows it. */
export function appPluginState(plugin: string): Record<string, unknown> {
  forVault();
  return states.get(plugin)?.state ?? {};
}

/** Called with the plugin's id each time an app plugin's state changes here; returns off. */
export function subscribeAppPluginState(fn: (plugin: string) => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}

/** Records of the box's feed: the app plugins' plugin.state records are folded, everything else is ignored. */
export function foldAppPluginRecords(records: readonly { seq: number; conv?: unknown; type?: unknown; signal?: unknown }[]): void {
  forVault();
  const touched = new Set<string>();
  for (const r of records) {
    if (r.conv !== null || r.type !== "signal") continue;
    const id = (r.signal as { plugin?: unknown } | undefined)?.plugin;
    if (!isApp(id)) continue;
    const was = states.get(id);
    if (was && was.seq >= r.seq) continue; // already folded (the box's answer, or this record twice)
    if (foldPluginState(states, r)) touched.add(id);
  }
  if (!touched.size) return;
  keep();
  for (const id of touched) tell(id);
}

/** The app plugins' states as the box has them, folded here. Never throws. */
export async function loadAppPluginStates(link: Link): Promise<void> {
  try {
    const r = (await boxGet(link, "/api/v2/plugin/app-state", 10_000)) as { states?: Record<string, PluginState> };
    if (!r?.states || typeof r.states !== "object") return;
    forVault();
    const touched: string[] = [];
    for (const [plugin, s] of Object.entries(r.states)) {
      if (!isApp(plugin) || !s || typeof s.seq !== "number" || !s.state || typeof s.state !== "object") continue;
      if ((states.get(plugin)?.seq ?? -1) >= s.seq) continue; // this window has it, or newer
      states.set(plugin, { seq: s.seq, state: { ...s.state }, ...(typeof s.epoch === "string" && s.epoch ? { epoch: s.epoch } : {}) });
      touched.push(plugin);
    }
    if (!touched.length) return;
    keep();
    for (const id of touched) tell(id);
  } catch {
    /* an older box, or offline: the local copy stands */
  }
}

/** Set one key of an app plugin's state (value null: removed): here at once, then a record on the box. Answers the
 *  box's refusal, or null. */
export async function setAppPluginState(plugin: string, key: string, value: unknown): Promise<string | null> {
  forVault();
  const cur = states.get(plugin) ?? { seq: 0, state: {} };
  const state = { ...cur.state };
  if (value === null || value === undefined) delete state[key];
  else state[key] = value;
  states.set(plugin, { seq: cur.seq, state });
  tell(plugin);
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return "no box is connected (the choice holds in this window only)";
  const r = await boxPost(link, "/api/v2/plugin/app-state", { plugin, key, value: value ?? null });
  return r.ok ? null : (r.error ?? "the box refused");
}

/** Tests: forget everything. */
export function _resetAppPluginState(): void {
  vault = undefined;
  states = new Map();
}
