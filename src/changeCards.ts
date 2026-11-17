// Change ready on the surfaces that do not hold the vault's files (the phone app, the iPad board; reports/07 corrected
// model point 4). The laptop folds its drafts itself (src/changeReady.ts); these read the box's list
// (GET /api/v2/changes, server/changesPending.ts) and send Carl's word through the same POST /api/v2/supervisor
// (a plugin.change / setting.change record), so a decision on any surface clears the card on every one.
//
// Nothing here draws: the phone (phone/src/changes.ts) and the board (board/src/changes.ts) each draw their own card
// with their own look, from this store. With nothing pending the store holds an empty list and they draw nothing.
// The list is read once at start, again on a record that can move it (changesMayMove), when the page comes back on
// screen, and every `everyMs` while on screen (a draft file the vault's sync brought has no record).
//
// Shared by the phone, the board and the box: no imports.

export type ChangeSurface = "laptop" | "phone" | "board";

/** One draft waiting for Carl, as a surface shows it (the laptop's PendingChange, plus where Try can run it). */
export type BoxPendingChange = {
  plugin: string;
  name: string;
  what: string;
  version: string;
  added: boolean;
  tryOn: ChangeSurface[];
  /** Only for the phone, when it can try it: the draft's code (its plugin host mounts it in place of the live copy). */
  code?: string;
  /** A migration draft (src/migrations.ts): whose state it reshapes. Try runs it on a copy and shows a summary. */
  migration?: { target: string | null };
  /** The app's core bundle (src/coreBundle.ts, part app/core): how the laptop's loader fetches and checks it. */
  core?: { sha256: string; commit: string; commitTime: number; needs: { commands: string[]; plugins: string[]; boxApi: number }; boxApi: number };
};

export type ChangeWord = "keep" | "discard" | "switch";
export type Outcome = { plugin: string; name: string; text: string; ok: boolean; /** a kept change: Switch back undoes it */ kept?: boolean };

/** Whether a vault-level record (a /poll event) can change the list: the surface reads it again on one. */
export function changesMayMove(ev: unknown): boolean {
  const rec = ev as { type?: unknown; signal?: { type?: unknown; path?: unknown; plugin?: unknown } } | null;
  const s = rec?.type === "signal" ? rec.signal : (rec as { type?: unknown; path?: unknown; plugin?: unknown } | null);
  const t = s?.type;
  if (t === "plugin.change" || t === "setting.draft" || t === "setting.change") return true;
  if (t === "plugin.desired" && (s?.plugin === "app/phone" || s?.plugin === "app/board")) return true;
  return t === "file_changed" && typeof s?.path === "string" && /^\.vault-chat\/(?:(?:app-|box-)?plugins|migrations)\//.test(s.path.replace(/\\/g, "/"));
}

/** The card's title line, as the laptop says it. */
export const changeTitle = (c: BoxPendingChange): string => `Change ready: ${c.what || (c.added ? `new plugin ${c.name}` : c.name)}`;

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export type ChangeCards = {
  /** The drafts waiting now (empty: draw nothing). */
  list(): readonly BoxPendingChange[];
  /** The surface is turned off (the box's line): draw nothing. */
  off(): string | null;
  /** What happened last (Kept / Discarded / why not), or null. */
  outcome(): Outcome | null;
  clearOutcome(): void;
  /** Whether a word is on its way to the box. */
  busy(): boolean;
  /** A /poll record: read the list again when it can move it. */
  record(ev: unknown): void;
  /** Read the list now (debounced by `ms`). */
  refresh(ms?: number): void;
  /** Carl's word on a draft (or Switch back on a kept one): the box's record, then the list read again. */
  decide(plugin: string, word: ChangeWord, version?: string, opts?: { by?: string; reason?: string; quiet?: boolean }): Promise<{ ok: boolean; text: string }>;
  subscribe(fn: () => void): () => void;
  stop(): void;
};

const NONE: readonly BoxPendingChange[] = Object.freeze([]);

export function startChangeCards(d: {
  api: Api;
  surface: "phone" | "board";
  everyMs?: number;
  /** Tests: whether the page is on screen. */
  visible?: () => boolean;
}): ChangeCards {
  let list: readonly BoxPendingChange[] = NONE;
  let offLine: string | null = null;
  let outcome: Outcome | null = null;
  let busy = false;
  let stopped = false;
  let reading = false;
  let again = false;
  let t: ReturnType<typeof setTimeout> | null = null;
  let sig = "";
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a drawer's own problem */
      }
    }
  };
  const visible = d.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");

  async function read(): Promise<void> {
    if (stopped) return;
    if (reading) return void (again = true);
    reading = true;
    try {
      const r = await d.api(`/api/v2/changes?surface=${d.surface}`, { cache: "no-store" } as RequestInit);
      if (r.ok) {
        const b = (await r.json()) as { changes?: BoxPendingChange[]; off?: string };
        const next = Array.isArray(b.changes) ? b.changes.filter((c) => c && typeof c.plugin === "string" && typeof c.version === "string") : [];
        const off = typeof b.off === "string" && b.off ? b.off : null;
        const s = JSON.stringify([off, next.map((c) => [c.plugin, c.version, c.what, c.name, c.added, c.tryOn, c.code?.length ?? 0])]);
        if (s !== sig) {
          sig = s;
          list = next.length ? next : NONE;
          offLine = off;
          emit();
        }
      }
      // 404: an older box, nothing to show.
    } catch {
      /* offline: keep what we had */
    } finally {
      reading = false;
      if (again) {
        again = false;
        void read();
      }
    }
  }
  const refresh = (ms = 120) => {
    if (stopped) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      void read();
    }, ms);
  };
  const timer = setInterval(() => visible() && void read(), d.everyMs ?? 60_000);
  const onVisible = () => visible() && refresh(0);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  void read();

  const nameOf = (plugin: string) => list.find((c) => c.plugin === plugin)?.name ?? plugin.split("/").pop() ?? plugin;

  return {
    list: () => list,
    off: () => offLine,
    outcome: () => outcome,
    clearOutcome() {
      if (!outcome) return;
      outcome = null;
      emit();
    },
    busy: () => busy,
    record(ev) {
      if (changesMayMove(ev)) refresh();
    },
    refresh,
    async decide(plugin, word, version, opts = {}) {
      const name = nameOf(plugin);
      busy = true;
      emit();
      let res: { ok: boolean; text: string };
      try {
        const r = await d.api("/api/v2/supervisor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plugin, change: word, ...(version ? { version } : {}), by: opts.by ?? "carl", ...(opts.reason ? { reason: opts.reason } : {}) }),
        });
        const b = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
        res = { ok: r.ok, text: String(b.text ?? b.error ?? (r.ok ? "done" : `the box refused it (${r.status})`)) };
      } catch (e) {
        res = { ok: false, text: String((e as Error)?.message ?? e) };
      }
      busy = false;
      if (!opts.quiet) {
        const text =
          word === "keep" ? (res.ok ? "Kept. Switch back undoes it." : `Not kept: ${res.text}`) : word === "discard" ? (res.ok ? "Discarded." : `Discard not written: ${res.text}`) : res.ok ? "Switched back." : `Not switched: ${res.text}`;
        outcome = { plugin, name, text, ok: res.ok, ...(word === "keep" && res.ok ? { kept: true } : {}) };
      }
      // The record is written: this surface's list drops it now, not when the feed brings it.
      if (res.ok && version) {
        list = list.filter((c) => !(c.plugin === plugin && c.version === version));
        sig = "";
      }
      emit();
      void read();
      return res;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      if (t) clearTimeout(t);
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      listeners.clear();
    },
  };
}
