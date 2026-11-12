// The supervisor (base spec change 1.6, section 4): a plugin's desired state is records in the one log, every host runs a
// reconciler that makes what it shows match them, and what a plugin did to a host is undone, in reverse order, when it
// stops. Shared by the box (server/supervisor.ts), the app (src/pluginSupervisorApp.ts), the phone, a page's own link
// (src/pageLinkHost.ts) and the preview harness's fake box: no imports.
//
// Records (vault-level signals in the box's feed, as plugin.state is: src/pluginRecords.ts):
//
//   {type: "plugin.desired", plugin, state: "running" | "stopped", at, from?, by?, reason?}
//       Carl's (or a policy's) word on a plugin. `from` (ms): the word takes effect then, not now (an end date: "stopped
//       from Dec 1"). The rule: of the words already in effect, the newest (highest seq) wins; a word for later waits for
//       its time. So "enable" after an end date was set cancels it, and an end date set after "enable" still comes.
//   {type: "plugin.budget", plugin, callsPerMinute, at, by?}
//       A budget: when the plugin makes more box calls than this in a minute, the box writes `stopped` (by "budget").
//       callsPerMinute null removes it.
//
// No record: running. The core holds no policy of its own: disable, an end date and a budget are each only records,
// and whatever writes them (Carl, the agent's Plugins tool, the budget check) is named in `by`.
//
// Plugin id: the page's vault path, "/"-separated (the id its state is kept under).

export const PLUGIN_DESIRED = "plugin.desired";
export const PLUGIN_BUDGET = "plugin.budget";
export const PLUGIN_STATES = ["running", "stopped"] as const;
export type PluginRun = (typeof PLUGIN_STATES)[number];

export type DesiredSignal = { type: typeof PLUGIN_DESIRED; plugin: string; state: PluginRun; at: number; from?: number; by?: string; reason?: string };
export type BudgetSignal = { type: typeof PLUGIN_BUDGET; plugin: string; callsPerMinute: number | null; at: number; by?: string };
/** A record of the log as the supervisor folds it (the box's LogRecord, or the snapshot route's). */
export type SupervisorRecord = { seq: number; at?: number; type?: unknown; signal?: unknown };

/** What a host should make true for one plugin now. */
export type Desired = {
  state: PluginRun;
  /** Who wrote the word in effect ("carl", "agent", "budget" …); null: nobody, the default. */
  by: string | null;
  reason: string | null;
  /** The seq of the word in effect (0: the default). */
  seq: number;
  /** When a word written for later takes effect next (ms), or null. */
  next: number | null;
};

const RUNNING: Desired = { state: "running", by: null, reason: null, seq: 0, next: null };

/** A plugin's id, spelled one way whichever host names it (a Windows path, a leading ./). */
export function pluginIdOf(path: string): string {
  return String(path ?? "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

const PLUGIN_RE = /^[^\u0000-\u001f]{1,400}$/;
const WHO_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
type Bad = { status: number; error: string };

/** A desired-state word from a request body ({plugin, state, from?, reason?}), or why not. `by`: who the box says asks. */
export function desiredSignal(b: Record<string, unknown> | null, by: string, now: number): DesiredSignal | Bad {
  const plugin = typeof b?.plugin === "string" ? pluginIdOf(b.plugin) : "";
  if (!plugin || !PLUGIN_RE.test(plugin) || plugin.split("/").includes("..")) return { status: 400, error: "name the plugin: its vault path" };
  const state = b?.state;
  if (state !== "running" && state !== "stopped") return { status: 400, error: 'state is "running" or "stopped"' };
  let from: number | undefined;
  if (b?.from != null && b.from !== "") {
    const t = typeof b.from === "number" ? b.from : Date.parse(String(b.from));
    if (!Number.isFinite(t)) return { status: 400, error: "from: a date or a time in ms" };
    if (t > now) from = Math.trunc(t);
  }
  const reason = typeof b?.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 300) : undefined;
  return { type: PLUGIN_DESIRED, plugin, state, at: now, ...(from !== undefined ? { from } : {}), ...(WHO_RE.test(by) ? { by } : {}), ...(reason ? { reason } : {}) };
}

/** A budget from a request body ({plugin, callsPerMinute}: a whole number ≥ 1, or null to remove it), or why not. */
export function budgetSignal(b: Record<string, unknown> | null, by: string, now: number): BudgetSignal | Bad {
  const plugin = typeof b?.plugin === "string" ? pluginIdOf(b.plugin) : "";
  if (!plugin || !PLUGIN_RE.test(plugin) || plugin.split("/").includes("..")) return { status: 400, error: "name the plugin: its vault path" };
  const n = b?.callsPerMinute;
  if (n !== null && !(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return { status: 400, error: "callsPerMinute: a whole number from 1, or null" };
  return { type: PLUGIN_BUDGET, plugin, callsPerMinute: n as number | null, at: now, ...(WHO_RE.test(by) ? { by } : {}) };
}

type Word = { seq: number; at: number; from: number | null; state: PluginRun; by: string | null; reason: string | null };

/** The fold of the supervisor's records: every plugin's words and budget. */
export class Supervisor {
  private words = new Map<string, Word[]>();
  private budgets = new Map<string, { seq: number; callsPerMinute: number | null }>();
  private raw = new Map<number, SupervisorRecord>();
  /** The highest seq folded. */
  seq = 0;

  /** Fold one record of the log (anything else is ignored): whether it was a supervisor record not seen before. */
  fold(rec: SupervisorRecord): boolean {
    const s = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
    if (!s || (s.type !== PLUGIN_DESIRED && s.type !== PLUGIN_BUDGET) || typeof s.plugin !== "string" || !Number.isFinite(rec.seq)) return false;
    if (this.raw.has(rec.seq)) return false;
    const plugin = pluginIdOf(s.plugin);
    const at = Number(s.at ?? rec.at) || 0;
    if (s.type === PLUGIN_DESIRED) {
      if (s.state !== "running" && s.state !== "stopped") return false;
      const list = this.words.get(plugin) ?? [];
      list.push({ seq: rec.seq, at, from: typeof s.from === "number" && Number.isFinite(s.from) ? s.from : null, state: s.state, by: typeof s.by === "string" ? s.by : null, reason: typeof s.reason === "string" ? s.reason : null });
      list.sort((a, b) => a.seq - b.seq);
      this.words.set(plugin, list);
    } else {
      const n = s.callsPerMinute;
      const cur = this.budgets.get(plugin);
      if (!cur || cur.seq < rec.seq) this.budgets.set(plugin, { seq: rec.seq, callsPerMinute: typeof n === "number" && n >= 1 ? n : null });
    }
    this.raw.set(rec.seq, { seq: rec.seq, at: rec.at, type: "signal", signal: s });
    this.seq = Math.max(this.seq, rec.seq);
    return true;
  }

  /** What the plugin should be at `now`. */
  desired(plugin: string, now: number): Desired {
    const list = this.words.get(pluginIdOf(plugin));
    if (!list?.length) return RUNNING;
    let cur: Word | null = null;
    for (const w of list) if (w.from === null || w.from <= now) cur = w;
    let next: number | null = null;
    for (const w of list) if (w.from !== null && w.from > now && (!cur || w.seq > cur.seq)) next = next === null ? w.from : Math.min(next, w.from);
    return cur ? { state: cur.state, by: cur.by, reason: cur.reason, seq: cur.seq, next } : { ...RUNNING, next };
  }

  /** The plugin's budget (calls a minute), or null. */
  budget(plugin: string): number | null {
    return this.budgets.get(pluginIdOf(plugin))?.callsPerMinute ?? null;
  }

  /** Every plugin a record names. */
  plugins(): string[] {
    return [...new Set([...this.words.keys(), ...this.budgets.keys()])].sort();
  }

  /** The records folded so far, oldest first (what the snapshot route answers; a host folds them the same way). */
  records(): SupervisorRecord[] {
    return [...this.raw.values()].sort((a, b) => a.seq - b.seq);
  }
}

type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void };
const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/**
 * A host's reconciler: it watches the plugins the host shows, and whenever a record or the clock changes what one should
 * be, it tells the host, which makes it so (unmounts it and reverts its effects, or mounts it again). A host calls
 * `changed()` after it folds records into the supervisor.
 */
export class Reconciler {
  private watchers = new Map<string, Set<(d: Desired) => void>>();
  private last = new Map<string, PluginRun>();
  private timer: unknown = null;
  constructor(readonly sup: Supervisor, private clock: Clock = realClock) {}

  desired(plugin: string): Desired {
    return this.sup.desired(plugin, this.clock.now());
  }

  /** Follow one plugin: `fn` runs whenever what it should be changes (not at once). Returns the unwatch. */
  watch(plugin: string, fn: (d: Desired) => void): () => void {
    const id = pluginIdOf(plugin);
    let set = this.watchers.get(id);
    if (!set) {
      this.watchers.set(id, (set = new Set()));
      this.last.set(id, this.desired(id).state);
    }
    set.add(fn);
    this.schedule();
    return () => {
      const s = this.watchers.get(id);
      if (!s) return;
      s.delete(fn);
      if (!s.size) {
        this.watchers.delete(id);
        this.last.delete(id);
      }
      this.schedule();
    };
  }

  /** Records were folded (or the clock passed a word's time): tell every watcher whose plugin changed. */
  changed(): void {
    for (const [id, fns] of [...this.watchers]) {
      const d = this.desired(id);
      if (this.last.get(id) === d.state) continue;
      this.last.set(id, d.state);
      for (const fn of [...fns]) {
        try {
          fn(d);
        } catch {
          /* one host's failure is its own */
        }
      }
    }
    this.schedule();
  }

  /** How many plugins are watched (a host that let go of them all holds nothing). */
  get watching(): number {
    return this.watchers.size;
  }

  private schedule(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    let next: number | null = null;
    for (const id of this.watchers.keys()) {
      const n = this.desired(id).next;
      if (n !== null) next = next === null ? n : Math.min(next, n);
    }
    if (next === null) return;
    const wait = Math.max(0, Math.min(next - this.clock.now(), 2 ** 31 - 1));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.changed();
    }, wait + 5);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }
}

type Target = { addEventListener(type: string, fn: any, opts?: any): void; removeEventListener(type: string, fn: any, opts?: any): void };

/**
 * A plugin's effects on its host, each recorded with its inverse (mounted UI, listeners, timers, observers, registered
 * services): `revert()` undoes them all, newest first, and leaves nothing behind. An undo that throws does not stop
 * the rest.
 */
export class Effects {
  private undo: { label: string; fn: () => void }[] = [];

  /** Record an effect's inverse. Returns a function that undoes this one effect now (and forgets it). */
  add(label: string, fn: () => void): () => void {
    const e = { label, fn };
    this.undo.push(e);
    return () => {
      const i = this.undo.indexOf(e);
      if (i < 0) return;
      this.undo.splice(i, 1);
      try {
        fn();
      } catch {
        /* undone as far as it goes */
      }
    };
  }

  /** addEventListener, recorded. */
  listen(target: Target, type: string, fn: (e: any) => void, opts?: boolean | AddEventListenerOptions): () => void {
    target.addEventListener(type, fn, opts);
    return this.add(`listener ${type}`, () => target.removeEventListener(type, fn, opts));
  }

  /** setTimeout (once) or setInterval (`repeat`), recorded. */
  timer(fn: () => void, ms: number, repeat = false): () => void {
    let undo: () => void = () => {};
    const t = repeat ? setInterval(fn, ms) : setTimeout(() => {
      undo();
      fn();
    }, ms);
    undo = this.add(repeat ? "interval" : "timeout", () => (repeat ? clearInterval(t) : clearTimeout(t)));
    return undo;
  }

  /** What is still in effect (labels, oldest first). */
  get live(): string[] {
    return this.undo.map((e) => e.label);
  }

  /** Undo everything, newest first. */
  revert(): void {
    while (this.undo.length) {
      const e = this.undo.pop()!;
      try {
        e.fn();
      } catch {
        /* the rest still go */
      }
    }
  }
}

/** The one line a host shows where a stopped plugin was. */
export function offLine(plugin: string, d: Pick<Desired, "by" | "reason">): string {
  const name = pluginIdOf(plugin).split("/").pop() || plugin;
  const why = d.reason ? `: ${d.reason}` : d.by === "budget" ? ": over its budget" : "";
  return `${name} is turned off${why}`;
}
