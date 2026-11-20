// Change ready (reports/07 corrected model, point 4; records and rules in src/pluginDrafts.ts): the core's side of
// trying a plugin's draft. Not a plugin itself, so a draft can never break the buttons that judge it.
//
// - Try: the draft runs on Carl's windows only. Which version he tries is kept per vault in localStorage, so every
//   window of this app follows it (the storage event) and nothing on the box changes; Back stops trying.
// - Keep / Discard: one plugin.change record on the box (it moves the files: server/pluginDrafts.ts). A kept draft runs
//   as the live copy at once (the record), before its file has synced; undo is Switch back (another record).
// - A draft being tried that throws, fails to load or makes typing slow (composer or Ctrl+K keystroke-to-paint median
//   over TRY_SLOW_MS) discards itself: Carl's windows fall back at once, a discard record is written (by "auto") and
//   the notice says why.
// - After Keep, the kept copy is watched for KEEP_WATCH_MS: when it throws, fails to load or makes typing slow, it
//   switches back by itself (a switch record by "auto" naming the kept version, so two windows switch once) and the
//   notice says why, in every window and after a restart (from the record). Nothing listens to typing unless a draft
//   is tried or a keep is under watch.
// - The state and the actions are offers (app/changes: PluginRead / PluginAct), so the agent sees whether Carl is
//   trying a draft.
// - Carl's settings have drafts too (src/settingsRecords.ts: the agent's own idea, Settings with draft: true), shown as
//   "app/settings-values": Try lays their window settings (theme, sidebar) over the records on his windows only
//   (src/settings.ts setSettingsTry); a draft of settings only the box applies (model, voice …) has no Try, only
//   Keep / Discard. Keep, Discard and Switch back post the same change to the box, which writes the settings.
// - A migration draft (src/migrations.ts, id migrate/<name>: a plugin's state reshaped) comes from the box's list like a
//   box plugin's. Its Try changes nothing anywhere: the box runs migrate on a copy of the real state and the notice
//   shows the before / after summary (migrationTryOf); Keep has the box back up, migrate and switch the epoch.
// - The app's core (src/coreBundle.ts, part app/core) comes from the box's list the same way: a bundle the box built
//   from main. Try has the native loader run it in Carl's windows (src/coreFollow.ts tryCore: the screen is kept across
//   the load, src/coreSwap.ts); Keep makes it the core every launch runs (the record; it runs already); Back, Discard
//   and Switch back have the loader run the core in effect again at once (followCoreNow). A tried bundle that does not
//   come up is the loader's to fall back from (30 s, a throw), and it is discarded by "auto" like a failing draft.
import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { appPluginFolder, LIVE_APP_PLUGINS } from "./appPluginLive";
import { liveCopiesNow, useAllLiveCopies, type LiveCopies } from "./appPluginLiveHost";
import { postPluginChange, supervisorChangesNow, supervisorStagedNow, useSupervisorVersion } from "./pluginSupervisorApp";
import { boxGet, boxLinkFor, boxPost, provideNewChatTries } from "./boxChat";
import { provideBoxTries } from "./liveBridge";
import { APP_PLUGINS } from "./appPlugins";
import { PRESET_DRAFT_FILE, PRESET_PLUGIN_ID, parseDraft } from "./appPreset";
import { SETTINGS_DRAFT_ID, SETTINGS_DRAFT_NAME, describeValues, pendingSettingsDraft, triable as settingsTriable, windowValues } from "./settingsRecords";
import { onPickWhileTrying, onSettingsDrafts, refreshBoxSettings, setSettingsTry, settingsDraftsNow, settingsDraftsVersion } from "./settings";
import { isMigrationId, summaryLine, type MigrationSummary } from "./migrations";
import { CORE_NAME, CORE_PART, coreCard, coreChangesSince, type CoreCandidate, type CoreCommit, type CoreLook } from "./coreBundle";
import { provideCoreTrying } from "./coreFollow";
import { UNDO_CHORD, plainWhy } from "./changeFlow";
import { BUILT_IN, KEEP_TYPING_MS, KEEP_WATCH_MS, TRY_SLOW_MS, draftStaged, draftWhat, landing, slowMedian, watchedKeep, type ChangeRecord, type SlotCode } from "./pluginDrafts";

export const CHANGES_PLUGIN = { id: "app/changes", name: "Changes" } as const;
/** What Carl calls the app's preset in the notice. */
export const PRESET_NAME = "App preset";

// ---------------------------------------------------------------- what Carl tries (this app's windows)

const TRY_KEY = "vc.tryDraft:";
type Tries = Readonly<Record<string, string>>;
const NONE: Tries = Object.freeze({});
let tryVault: string | null = null;
let tries: Tries = NONE;
const tryListeners = new Set<() => void>();

function readTries(v: string | null): Tries {
  try {
    const raw = v ? globalThis.localStorage?.getItem(TRY_KEY + v) : null;
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o !== "object") return NONE;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(o)) if (typeof x === "string") out[k] = x;
    return out;
  } catch {
    return NONE;
  }
}

function followTries(): Tries {
  const v = useStore.getState().vaultPath;
  if (v !== tryVault) {
    tryVault = v;
    tries = readTries(v);
  }
  return tries;
}

function emitTries(): void {
  syncSettingsTry();
  for (const fn of [...tryListeners]) fn();
  for (const fn of [...changeListeners]) fn();
}

let storageHooked = false;
function hookStorage(): void {
  if (storageHooked || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  storageHooked = true;
  // Another window of this app tried or stopped a draft: follow it.
  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key || !tryVault || e.key !== TRY_KEY + tryVault) return;
    tries = readTries(tryVault);
    watchTyping();
    emitTries();
  });
}

function subscribeTries(fn: () => void): () => void {
  hookStorage();
  tryListeners.add(fn);
  return () => tryListeners.delete(fn);
}

/** The version of `plugin`'s draft Carl tries in this app's windows, or null. */
export function triedVersion(plugin: string): string | null {
  return followTries()[plugin] ?? null;
}

/** triedVersion, following it (null plugin: nothing). */
export function useTried(plugin: string | null): string | null {
  const get = () => (plugin ? triedVersion(plugin) : null);
  return useSyncExternalStore(subscribeTries, get, get);
}

const triesNow = () => followTries();
/** Every plugin's tried version in this app's windows, following them. */
export function useTries(): Tries {
  return useSyncExternalStore(subscribeTries, triesNow, triesNow);
}

/** Try `version` of the plugin's draft on this app's windows (null: stop trying it). */
export function setTried(plugin: string, version: string | null): void {
  const cur = followTries();
  if ((cur[plugin] ?? null) === version) return;
  const next: Record<string, string> = { ...cur };
  if (version) next[plugin] = version;
  else delete next[plugin];
  tries = next;
  try {
    if (tryVault) {
      if (Object.keys(next).length) {
        globalThis.localStorage?.setItem(TRY_KEY + tryVault, JSON.stringify(next));
        globalThis.localStorage?.setItem(TRY_BOOT_KEY + tryVault, String(Date.now()));
      } else globalThis.localStorage?.removeItem(TRY_KEY + tryVault);
    }
  } catch {
    /* no storage: this window still tries it */
  }
  watchTyping();
  emitTries();
}

// ---------------------------------------------------------------- a restart never keeps an untried change

const TRY_BOOT_KEY = "vc.tryBoot:";
/** When this app's process started (ms), or null when it can't say. Tests replace it. */
let processStart = async (): Promise<number | null> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const t = await invoke<{ uptime_ms: number }>("boot_timing");
    return typeof t?.uptime_ms === "number" ? Date.now() - t.uptime_ms : null;
  } catch {
    return null;
  }
};
/** Tests: when the process started. */
export function _setProcessStart(fn: typeof processStart): void {
  processStart = fn;
}

/**
 * A restart never keeps an untried change (src/changeFlow.ts): what this vault's windows tried in an earlier run of the
 * app stops being tried (the copy in effect runs; for the core, the loader runs the core in effect). A window loaded
 * again in the same run (a core Try loads the new core) keeps it. Returns what was dropped.
 */
export async function dropTriesFromBefore(): Promise<string[]> {
  const cur = followTries();
  if (!Object.keys(cur).length || !tryVault) return [];
  const start = await processStart();
  if (start === null) return [];
  let at = 0;
  try {
    at = Number(globalThis.localStorage?.getItem(TRY_BOOT_KEY + tryVault)) || 0;
  } catch {
    return [];
  }
  if (at >= start - 2_000) return [];
  const dropped = Object.keys(followTries());
  for (const plugin of dropped) {
    setTried(plugin, null);
    coreFollowNow(plugin);
  }
  console.info(`[changes] a restart: no longer trying ${dropped.join(", ")}`);
  return dropped;
}

// ---------------------------------------------------------------- Carl's settings (src/settings.ts)

/** A plugin's change records: the supervisor's, or for the settings, the settings' own (they live with them). */
export function changesOf(plugin: string): readonly ChangeRecord[] {
  return plugin === SETTINGS_DRAFT_ID ? settingsDraftsNow().changes : supervisorChangesNow(plugin);
}

/** This window shows the settings draft Carl tries (its window settings over the records), or the records again. */
function syncSettingsTry(): void {
  const d = pendingSettingsDraft(settingsDraftsNow());
  setSettingsTry(d && followTries()[SETTINGS_DRAFT_ID] === d.version ? windowValues(d.values) : null);
}

// ---------------------------------------------------------------- the vault plugins' slots (VaultPluginHost writes them)

export type VaultSlot = { id: string; name: string } & SlotCode;
let vaultSlots: readonly VaultSlot[] = [];
const changeListeners = new Set<() => void>();

/** VaultPluginHost's last look at .vault-chat/plugins: each plugin's live, draft and prev code. */
export function setVaultSlots(list: readonly VaultSlot[]): void {
  if (list === vaultSlots) return;
  vaultSlots = list;
  for (const fn of [...changeListeners]) fn();
}

// ---------------------------------------------------------------- the box plugins' drafts (the box reads them)

let boxPending: readonly PendingChange[] = [];
/** Box plugins seen with a draft here (their switch back by itself is told of after the draft is gone). */
const boxKnown = new Set<string>();

/** The box plugins' drafts waiting (server/boxPlugins.ts; GET /api/v2/changes lists them from the box's files). */
export function setBoxPending(list: readonly PendingChange[]): void {
  for (const p of list) boxKnown.add(p.plugin);
  boxPending = list;
  for (const fn of [...changeListeners]) fn();
}

/** The box plugins' drafts this app's windows try: a page's calls to their routes run the draft (src/liveBridge.ts). */
export function boxTries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(followTries())) if (k.startsWith("box/") && boxPending.some((p) => p.plugin === k && p.version === v)) out[k] = v;
  return out;
}
provideBoxTries(boxTries);
provideNewChatTries(boxTries);

/** Whether this laptop's loader can run a core bundle waiting on the box (tests replace it). */
let coreRunsHere = async (version: string, c: CoreCandidate): Promise<boolean> => {
  try {
    const m = await import("./coreFollow");
    const s = await m.coreStatus();
    // The bundle Carl tries runs here already: it stays on the card.
    return !!s && (s.active === version || m.candidateProblem(version, c, s) === null);
  } catch {
    return false;
  }
};
/** What a core bundle changes over the core this laptop runs now (its main commit: the box bundle's, else the installed
 *  app's own), newest first; null when the loader can't say (tests replace it). */
let coreChangesHere = async (c: CoreCandidate): Promise<CoreCommit[] | null> => {
  if (!c.commits?.length) return null;
  try {
    const s = await (await import("./coreFollow")).coreStatus();
    if (!s) return null;
    // Running the candidate itself (Carl tries it): its words stay those over the installed app's own core.
    const box = s.active !== BUILT_IN && s.activeCommit !== c.commit;
    const running = { commit: box ? s.activeCommit : s.baked.commit || null, time: box ? null : s.baked.commitTime };
    return coreChangesSince(c.commits, running);
  } catch {
    return null;
  }
};
/** Tests: what a core bundle changes here. */
export function _setCoreChangesHere(fn: typeof coreChangesHere): void {
  coreChangesHere = fn;
}

/** Tests: what the loader says about a core bundle. */
export function _setCoreRunsHere(fn: typeof coreRunsHere): void {
  coreRunsHere = fn;
}

/** The loader's side of a core change (src/coreFollow.ts); tests replace it. */
type CoreActs = { tryCore: (version: string, c: CoreCandidate, what?: string, looks?: CoreLook[]) => Promise<void>; followNow: () => Promise<unknown> };
let coreActs: CoreActs = {
  tryCore: async (version, c, what, looks) => {
    const m = await import("./coreFollow");
    await m.tryCore(version, c, await m.defaultDeps(), what, looks);
  },
  followNow: async () => (await import("./coreFollow")).followCoreNow(),
};
provideCoreTrying({ tried: () => triedVersion(CORE_PART), triedFailed: (version, why) => autoDiscard(CORE_PART, version, why) });
/** Tests: the loader's side. */
export function _setCoreActs(a: CoreActs): void {
  coreActs = a;
}
/** After Back / Discard / Switch back of the core: the loader runs what is in effect now. */
const coreFollowNow = (plugin: string) => {
  if (plugin === CORE_PART) void coreActs.followNow().catch((e) => console.warn("[core] follow failed:", e));
};

/** Core bundles applied by themselves here (nothing on screen changes): once each. */
const quietKept = new Set<string>();

/** Read the box plugins' drafts from the box. A tried one that is gone stops being tried (discarded by itself: said). */
export async function refreshBoxDrafts(): Promise<void> {
  const v = useStore.getState().vaultPath;
  const link = await boxLinkFor(v).catch(() => null);
  if (!link) return;
  let r: { changes?: unknown };
  try {
    r = await boxGet(link, "/api/v2/changes?surface=laptop");
  } catch {
    return; // an older box, or unreachable: nothing to add
  }
  if (useStore.getState().vaultPath !== v || !Array.isArray(r?.changes)) return;
  const list: PendingChange[] = [];
  for (const c of r.changes as Record<string, unknown>[]) {
    if (c?.plugin === CORE_PART && typeof c.version === "string" && c.core && typeof c.core === "object") {
      // Only a bundle this laptop's loader can run (an app with the loader, the shell's commands, newer than its own).
      const core = c.core as CoreCandidate;
      if (!(await coreRunsHere(c.version, core))) continue;
      // What it changes, in words: the titles of main's commits since the core this laptop runs (the box's words else),
      // and where to look. Only behind-the-scenes fixes: no Try (nothing to look at), Keep applies it.
      const since = await coreChangesHere(core);
      const card = since ? coreCard(since, core.commit) : null;
      // Nothing to see on this laptop (behind-the-scenes fixes only): it applies by itself, with a log line.
      if (card && !card.triable) {
        if (!quietKept.has(c.version)) {
          quietKept.add(c.version);
          console.info(`[changes] the app's core ${c.version} changes nothing on screen here: applying it (${card.changes.join("; ").slice(0, 300)})`);
          void post({ plugin: CORE_PART, change: "keep", version: c.version, by: "auto", reason: "nothing on screen changes on this laptop" });
        }
        continue;
      }
      list.push({
        plugin: CORE_PART,
        name: CORE_NAME,
        what: card ? card.what : String(c.what ?? ""),
        version: c.version,
        added: false,
        triable: card ? card.triable : true,
        core,
        ...(card?.changes.length ? { changes: card.changes } : {}),
        ...(card?.looks.length ? { looks: card.looks } : {}),
      });
      continue;
    }
    if (typeof c?.plugin === "string" && (c.plugin.startsWith("box/") || isMigrationId(c.plugin)) && typeof c.version === "string")
      list.push({
        plugin: c.plugin,
        name: String(c.name ?? c.plugin),
        what: String(c.what ?? ""),
        version: c.version,
        added: !!c.added,
        triable: true,
        ...(isMigrationId(c.plugin) ? { migration: { target: typeof (c.migration as { target?: unknown } | undefined)?.target === "string" ? String((c.migration as { target: string }).target) : null } } : {}),
      });
  }
  if (useStore.getState().vaultPath !== v) return;
  for (const [plugin, version] of Object.entries(followTries())) {
    if (!(plugin.startsWith("box/") || isMigrationId(plugin) || plugin === CORE_PART) || list.some((p) => p.plugin === plugin && p.version === version)) continue;
    setTried(plugin, null);
    // A core bundle no longer waiting (kept or discarded elsewhere): the loader runs what is in effect.
    coreFollowNow(plugin);
    const d = changesOf(plugin).filter((c) => c.change === "discard" && c.version === version).pop();
    if (d?.by === "auto") say({ plugin, name: list.find((p) => p.plugin === plugin)?.name ?? boxPending.find((p) => p.plugin === plugin)?.name ?? plugin, text: `Discarded by itself: ${d.reason ?? "it failed while tried"}`, ok: false, at: Date.now() });
  }
  setBoxPending(list);
}

// ---------------------------------------------------------------- the drafts waiting for Carl

export type PendingChange = {
  plugin: string;
  /** The plugin's name, as Carl knows it. */
  name: string;
  /** What the draft changes (its header's `what`, or its `// @vc-change` line), or "". */
  what: string;
  version: string;
  /** A vault plugin with no live file yet: the draft adds it. */
  added: boolean;
  /** Whether Try can run it on Carl's windows (a settings draft of only the box's settings can't: Keep sets it). */
  triable: boolean;
  /** A migration draft: whose state it reshapes (Try runs it on a copy of the real state and shows the summary). */
  migration?: { target: string | null };
  /** The app's core bundle (part app/core): how the loader fetches and checks it. */
  core?: CoreCandidate;
  /** The app's core bundle: what it changes over the core running here (main's commit titles, newest first). */
  changes?: string[];
  /** The app's core bundle: where its changes show (the app points there after Try). */
  looks?: CoreLook[];
};

const appName = (id: string) => APP_PLUGINS.find((p) => p.id === id)?.name ?? id.replace(/^app\//, "");

function appSlotCode(all: LiveCopies, folder: string): SlotCode {
  const out: SlotCode = {};
  for (const k of ["draft", "live", "prev"] as const) {
    const c = all[`${folder}${k === "live" ? "" : `.${k}`}.js`];
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Every draft nobody decided on yet, app plugins first. */
export function pendingChanges(all: LiveCopies = liveCopiesNow(), slots: readonly VaultSlot[] = vaultSlots, box: readonly PendingChange[] = boxPending): PendingChange[] {
  const out: PendingChange[] = [];
  for (const id of LIVE_APP_PLUGINS) {
    const code = appSlotCode(all, appPluginFolder(id)!);
    // Only a draft the gate passed reaches Carl (src/changeFlow.ts).
    const v = draftStaged(id, code, supervisorChangesNow(id), supervisorStagedNow(id));
    if (v) out.push({ plugin: id, name: appName(id), what: draftWhat(code.draft!), version: v, added: false, triable: true });
  }
  // The app's preset (src/appPreset.ts): its draft file waits the same way.
  const preset = all[PRESET_DRAFT_FILE];
  if (preset !== undefined) {
    const v = draftStaged(PRESET_PLUGIN_ID, { draft: preset }, supervisorChangesNow(PRESET_PLUGIN_ID), supervisorStagedNow(PRESET_PLUGIN_ID));
    if (v) {
      const d = parseDraft(preset);
      out.push({ plugin: PRESET_PLUGIN_ID, name: PRESET_NAME, what: "preset" in d ? d.what || `the app's preset "${d.preset.name}"` : "", version: v, added: false, triable: true });
    }
  }
  for (const s of slots) {
    const v = draftStaged(s.id, s, supervisorChangesNow(s.id), supervisorStagedNow(s.id));
    if (v) out.push({ plugin: s.id, name: s.name, what: draftWhat(s.draft!), version: v, added: s.live === undefined, triable: true });
  }
  // The box's own plugins: the box said which drafts wait; the records here may have decided one since.
  for (const p of box) if (supervisorChangesNow(p.plugin).every((c) => c.version !== p.version || c.change === "switch")) out.push(p);
  // Carl's settings (src/settingsRecords.ts): the agent's draft of them.
  const sd = pendingSettingsDraft(settingsDraftsNow());
  if (sd) out.push({ plugin: SETTINGS_DRAFT_ID, name: SETTINGS_DRAFT_NAME, what: sd.what || describeValues(sd.values), version: sd.version, added: false, triable: settingsTriable(sd.values) });
  return out;
}

function subscribeChanges(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
const slotsNow = () => vaultSlots;
const boxNow = () => boxPending;

/** The drafts waiting for Carl, kept current (the copies, the vault plugins' slots, the box's, the records). */
export function usePendingChanges(): PendingChange[] {
  const all = useAllLiveCopies();
  const slots = useSyncExternalStore(subscribeChanges, slotsNow, slotsNow);
  const box = useSyncExternalStore(subscribeChanges, boxNow, boxNow);
  const rv = useSupervisorVersion();
  const sv = useSyncExternalStore(onSettingsDrafts, settingsDraftsVersion, settingsDraftsVersion);
  return useMemo(() => pendingChanges(all, slots, box), [all, slots, box, rv, sv]);
}

/** The plugins Carl is trying now (pending drafts only), with the version. */
export function tryingNow(pending: readonly PendingChange[] = pendingChanges()): PendingChange[] {
  return pending.filter((p) => triedVersion(p.plugin) === p.version);
}

// ---------------------------------------------------------------- what happened last (the notice's line)

export type Outcome = { plugin: string; name: string; text: string; ok: boolean; at: number; /** the auto-revert record it tells of */ seq?: number };
let outcome: Outcome | null = null;
const outcomeListeners = new Set<() => void>();
function say(o: Outcome | null): void {
  outcome = o;
  for (const fn of [...outcomeListeners]) fn();
}
const outcomeNow = () => outcome;
export function useOutcome(): Outcome | null {
  return useSyncExternalStore((fn) => (outcomeListeners.add(fn), () => outcomeListeners.delete(fn)), outcomeNow, outcomeNow);
}
export const clearOutcome = () => {
  if (outcome?.seq) markSeen(outcome.seq);
  say(null);
};
export const lastOutcome = () => outcome;

const nameOf = (plugin: string) => (plugin === CORE_PART ? CORE_NAME : plugin === SETTINGS_DRAFT_ID ? SETTINGS_DRAFT_NAME : plugin === PRESET_PLUGIN_ID ? PRESET_NAME : plugin.startsWith("app/") ? appName(plugin) : plugin.startsWith("box/") || isMigrationId(plugin) ? boxPending.find((p) => p.plugin === plugin)?.name ?? (isMigrationId(plugin) ? `Data: ${plugin.slice(8)}` : `Box: ${plugin.slice(4)}`) : vaultSlots.find((s) => s.id === plugin)?.name ?? plugin.split("/").pop() ?? plugin);

// ---------------------------------------------------------------- the actions

// ---------------------------------------------------------------- a migration's Try: on a copy, on the box

export type MigrationTry = { plugin: string; version: string; state: "running" | "done" | "failed"; summary?: MigrationSummary; line?: string; error?: string };
let migrationTry: MigrationTry | null = null;
const migrationListeners = new Set<() => void>();
function setMigrationTry(t: MigrationTry | null): void {
  migrationTry = t;
  for (const fn of [...migrationListeners]) fn();
}
const migrationTryNow = () => migrationTry;
/** What the last migration Try found (the before / after summary), following it. */
export function useMigrationTry(): MigrationTry | null {
  return useSyncExternalStore((fn) => (migrationListeners.add(fn), () => migrationListeners.delete(fn)), migrationTryNow, migrationTryNow);
}
export const migrationTryOf = (plugin: string, version: string): MigrationTry | null => (migrationTry?.plugin === plugin && migrationTry.version === version ? migrationTry : null);

/** Run a migration draft on a copy of the real state (the box's route; nothing is written) and keep its summary. */
export async function tryMigration(plugin: string, version: string): Promise<MigrationTry> {
  setMigrationTry({ plugin, version, state: "running" });
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  let out: MigrationTry;
  if (!link) out = { plugin, version, state: "failed", error: "no box: a migration is tried on the box" };
  else
    try {
      const r = (await boxGet(link, `/api/v2/migrations/try?plugin=${encodeURIComponent(plugin)}&version=${encodeURIComponent(version)}`, 20_000)) as { summary?: MigrationSummary; line?: string };
      out = r?.summary ? { plugin, version, state: "done", summary: r.summary, line: r.line ?? summaryLine(r.summary) } : { plugin, version, state: "failed", error: "the box gave no summary" };
    } catch (e) {
      const m = /HTTP \d+: (\{.*)$/s.exec(String((e as Error)?.message ?? e));
      let why = String((e as Error)?.message ?? e);
      try {
        if (m) why = String(JSON.parse(m[1]!).error ?? why);
      } catch {
        /* the message as it is */
      }
      out = { plugin, version, state: "failed", error: why };
    }
  if (triedVersion(plugin) === version || migrationTry?.plugin === plugin) setMigrationTry(out);
  return out;
}

/** A core bundle's changes in one line, for the words after its Try. */
const tryWhat = (changes: readonly string[]) => changes.slice(0, 3).join("; ") + (changes.length > 3 ? ` (+${changes.length - 3} more)` : "");

/** Try a draft (Carl's windows only). A settings draft of only the box's settings can't be tried: nothing happens. A
 *  migration's Try runs it on a copy of the real state on the box and shows the summary. */
export function tryChange(plugin: string, version: string): Promise<MigrationTry> | null {
  if (plugin === SETTINGS_DRAFT_ID && !pendingChanges().some((p) => p.plugin === plugin && p.version === version && p.triable)) return null;
  say(null);
  if (plugin === CORE_PART) {
    const p = boxPending.find((x) => x.plugin === plugin && x.version === version);
    if (!p?.core) return null;
    setTried(plugin, version);
    // The loader fetches, checks and loads it: every window loads it (the screen is kept); the new page says it runs
    // (checkCoreSwap). What stops it is said.
    const what = p.changes?.length ? tryWhat(p.changes) : undefined;
    void coreActs.tryCore(version, p.core, what, p.looks).catch((e) => {
      setTried(plugin, null);
      say({ plugin, name: CORE_NAME, text: `Couldn't switch: ${String((e as Error)?.message ?? e).slice(0, 200)}. Still on your current version.`, ok: false, at: Date.now() });
    });
    return null;
  }
  setTried(plugin, version);
  return isMigrationId(plugin) ? tryMigration(plugin, version) : null;
}

/** Carl's word on a draft: the box's route (for the settings too: it hands theirs to them); the settings then read
 *  back at once, not when the feed brings them. */
async function post(body: Parameters<typeof postPluginChange>[0]): Promise<{ ok: boolean; text: string }> {
  const r = await postPluginChange(body);
  if (body.plugin === SETTINGS_DRAFT_ID) await refreshBoxSettings();
  return r;
}

/** Stop trying: the copy in effect runs again. */
export function stopTrying(plugin: string): void {
  setTried(plugin, null);
  if (migrationTry?.plugin === plugin) setMigrationTry(null);
  coreFollowNow(plugin);
}

/** Keep a draft: the record (the box moves the files); this window stops "trying", the kept copy runs as live. */
export async function keepChange(plugin: string, version: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await post({ plugin, change: "keep", version, by });
  if (r.ok) setTried(plugin, null);
  if (r.ok && migrationTry?.plugin === plugin) setMigrationTry(null);
  say({ plugin, name: nameOf(plugin), text: r.ok ? "Kept. Switch back undoes it." : `Not kept: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Discard a draft: this window falls back at once, then the record (the box removes the file). */
export async function discardChange(plugin: string, version: string, opts: { by?: string; reason?: string } = {}): Promise<{ ok: boolean; text: string }> {
  setTried(plugin, null);
  if (migrationTry?.plugin === plugin) setMigrationTry(null);
  const r = await post({ plugin, change: "discard", version, by: opts.by ?? "carl", ...(opts.reason ? { reason: opts.reason } : {}) });
  coreFollowNow(plugin);
  if (!opts.reason) say({ plugin, name: nameOf(plugin), text: r.ok ? "Discarded." : `Discard not written: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Switch back: the copy the last Keep replaced runs again (a record; undo is another switch). */
export async function switchBack(plugin: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await post({ plugin, change: "switch", by });
  if (r.ok) coreFollowNow(plugin);
  say({ plugin, name: nameOf(plugin), text: r.ok ? r.text : `Not switched: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Whether the plugin has a kept change Switch back can undo (the newest keep/switch record). */
export function canSwitchBack(plugin: string): boolean {
  const l = landing(changesOf(plugin));
  return !!l && (l.from ?? BUILT_IN) !== l.version;
}

const autoDone = new Set<string>();
/** A draft being tried failed (threw, did not load, slowed typing): fall back now, write the discard, say why. */
export function autoDiscard(plugin: string, version: string, why: string): void {
  if (triedVersion(plugin) !== version) return;
  const key = `${plugin}\u0000${version}`;
  setTried(plugin, null);
  if (autoDone.has(key)) return;
  autoDone.add(key);
  const short = why.split("\n")[0]!.slice(0, 200);
  say({ plugin, name: nameOf(plugin), text: `Discarded by itself: ${short}`, ok: false, at: Date.now() });
  void post({ plugin, change: "discard", version, by: "auto", reason: short }).then(() => coreFollowNow(plugin));
}

// ---------------------------------------------------------------- after Keep: switching back by itself

/** Every plugin that can have drafts here: the app plugins with live copies and the vault plugins' slots. */
const slotIds = (): string[] => [...LIVE_APP_PLUGINS, ...vaultSlots.map((s) => s.id), SETTINGS_DRAFT_ID, CORE_PART];
/** Every plugin a change can apply to here (the slots, the box's own plugins seen): the dead-man's switch watches them. */
export const changeablePlugins = (): string[] => [...new Set([...slotIds(), ...boxKnown])];

/** The keeps under watch now (src/pluginDrafts.ts watchedKeep): plugin, kept version, when the watch ends. */
export function keepsUnderWatch(now = Date.now()): { plugin: string; version: string; until: number }[] {
  const out: { plugin: string; version: string; until: number }[] = [];
  for (const plugin of slotIds()) {
    const k = watchedKeep(changesOf(plugin), now);
    if (k) out.push({ plugin, version: k.version, until: k.at + KEEP_WATCH_MS });
  }
  return out;
}

const revertDone = new Set<string>();
/**
 * A kept copy failed (threw, did not load, slowed typing) while its keep is under watch: switch back by itself, a record
 * by "auto" with why, and say it. `version`: the copy that failed (null: whichever is kept). Whether it switched.
 */
export function autoRevert(plugin: string, version: string | null, why: string): boolean {
  const k = watchedKeep(changesOf(plugin), Date.now());
  if (!k || (version !== null && k.version !== version)) return false;
  const key = `${plugin}\u0000${k.seq}`;
  if (revertDone.has(key)) return true;
  revertDone.add(key);
  const short = why.split("\n")[0]!.slice(0, 200);
  say({ plugin, name: nameOf(plugin), text: `Switched back by itself: ${short}`, ok: false, at: Date.now() });
  void post({ plugin, change: "switch", version: k.version, by: "auto", reason: short }).then((r) => {
    if (r.ok) coreFollowNow(plugin);
    // Another window switched it first ("already switched"): the same outcome.
    if (!r.ok && !/already switched/.test(r.text)) {
      // Plain words for Carl (no versions); the details go to the log. Never a red developer alert.
      console.warn(`[changes] ${plugin}: wanted to switch back by itself (${short}) but the box said: ${r.text}`);
      return say({ plugin, name: nameOf(plugin), text: `Couldn't undo it by itself (${plainWhy(short)}). ${UNDO_CHORD} undoes it.`, ok: false, at: Date.now() });
    }
    // The record this notice tells of: dismissing it here dismisses it in every window.
    const rec = changesOf(plugin).filter((c) => c.change === "switch" && c.by === "auto" && c.seq > k.seq).pop();
    if (rec && outcome?.plugin === plugin && !outcome.seq) say({ ...outcome, seq: rec.seq });
  });
  return true;
}

const SEEN_KEY = "vc.changeSeen:";
const seenSeq = (): number => {
  try {
    return Number(tryVault ? globalThis.localStorage?.getItem(SEEN_KEY + tryVault) : 0) || 0;
  } catch {
    return 0;
  }
};
function markSeen(seq: number): void {
  try {
    if (tryVault && seq > seenSeq()) globalThis.localStorage?.setItem(SEEN_KEY + tryVault, String(seq));
  } catch {
    /* no storage: it shows again next start */
  }
}

/** A switch back by itself this window did not see happen (another window, before a restart): the notice says it. */
export function noticeAutoSwitch(now = Date.now()): void {
  if (outcome) return;
  followTries();
  const seen = seenSeq();
  let best: { plugin: string; seq: number; reason: string | null; at: number } | null = null;
  for (const plugin of [...slotIds(), ...boxKnown])
    for (const c of changesOf(plugin))
      if (c.change === "switch" && c.by === "auto" && c.seq > seen && now - c.at <= KEEP_WATCH_MS && (!best || c.seq > best.seq)) best = { plugin, seq: c.seq, reason: c.reason, at: c.at };
  if (best) say({ plugin: best.plugin, name: nameOf(best.plugin), text: `Switched back by itself${best.reason ? `: ${best.reason}` : ""}`, ok: false, at: best.at, seq: best.seq });
}

// ---------------------------------------------------------------- typing while a draft is tried or a keep is watched

let typing: { off: () => void; samples: number[]; until: number; layout: string } | null = null;

/** What the screen holds that changes typing speed (the open files and how big, the split, full-screen chat): typing is
 *  only compared like with like, so a slowdown after Carl opens a 600-page PDF is not blamed on a change. */
export function layoutKey(): string {
  const s = useStore.getState() as unknown as { panes?: { file: string; content?: string }[]; splitDirection?: unknown; chatFullscreen?: unknown; rightCollapsed?: unknown };
  return JSON.stringify([(s.panes ?? []).map((p) => [p.file, Math.round((p.content?.length ?? 0) / 50_000)]), s.splitDirection ?? null, !!s.chatFullscreen, !!s.rightCollapsed]);
}

/** The keeps whose typing is still judged: applied less than KEEP_TYPING_MS ago (the watch for throwing stays longer). */
export function keepsForTyping(now = Date.now()): { plugin: string; version: string; until: number }[] {
  return keepsUnderWatch(now).flatMap((k) => (k.until - KEEP_WATCH_MS + KEEP_TYPING_MS > now ? [{ ...k, until: k.until - KEEP_WATCH_MS + KEEP_TYPING_MS }] : []));
}

/** Measure composer / Ctrl+K keystroke-to-paint only while something is tried or a keep is under watch (nothing is
 *  listening otherwise). Called again when the records change. */
export function watchTyping(): void {
  const keeps = keepsForTyping();
  const any = Object.keys(tries).length > 0 || keeps.length > 0;
  if (!any) {
    typing?.off();
    typing = null;
    return;
  }
  const until = Object.keys(tries).length ? Infinity : Math.max(...keeps.map((k) => k.until));
  if (typing) {
    typing.until = until;
    return;
  }
  if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof requestAnimationFrame !== "function") return;
  const samples: number[] = [];
  const onInput = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function" || !t.closest('[data-perf-target="composer"], [data-perf-target="ctrl-k"]')) return;
    if (document.hidden) return; // a hidden window's frames are throttled: not typing speed
    if (typing && Date.now() > typing.until) return void watchTyping(); // the watch ended: stop listening
    // Another layout than the samples were taken in (a file opened, the split changed): start over, like with like.
    const lk = layoutKey();
    if (typing && typing.layout !== lk) {
      typing.layout = lk;
      samples.length = 0;
    }
    const t0 = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (typing && typing.layout !== lk) return; // the screen changed while this key painted: not like with like
        samples.push(performance.now() - t0);
        if (samples.length > 40) samples.splice(0, samples.length - 40);
        const m = slowMedian(samples);
        if (m === null || m <= TRY_SLOW_MS) return;
        samples.length = 0;
        const ms = `median ${Math.round(m)} ms a key, the limit is ${TRY_SLOW_MS} ms`;
        for (const [plugin, version] of Object.entries(tries)) autoDiscard(plugin, version, `typing got slow while it was tried (${ms})`);
        for (const k of keepsForTyping()) autoRevert(k.plugin, k.version, `typing got slow after it was kept (${ms})`);
      }),
    );
  };
  window.addEventListener("input", onInput, true);
  typing = { samples, until, layout: layoutKey(), off: () => window.removeEventListener("input", onInput, true) };
}

/** Start following what this app's windows try (the app calls it once at start). */
let settingsHooked = false;
let swapChecked = false;
/** Once per page: a core swap just loaded this window, so say plainly what runs now (src/coreFollow.ts
 *  checkSwapOutcome): the new frontend, or why it could not switch. Tests replace the check. */
let swapCheck = async (): Promise<{ ok: boolean; text: string; looks?: CoreLook[] } | null> => {
  const m = await import("./coreFollow");
  const said = await m.checkSwapOutcome();
  const tried = triedVersion(CORE_PART);
  const SAID_KEY = "vc.coreTriedSaid";
  if (said) {
    try {
      if (said.ok && tried) globalThis.sessionStorage?.setItem(SAID_KEY, tried);
    } catch {
      /* no storage */
    }
    return said;
  }
  // A Try started by a core from before this check (the installer's own, today) leaves no expectation: the bundle Carl
  // tries running here, once per window session, is said the same way.
  let s = await m.coreStatus();
  for (let i = 0; s && tried && s.active === tried && !s.ready && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    s = await m.coreStatus();
  }
  if (!s || !tried || s.active !== tried || !s.ready) return null;
  try {
    if (globalThis.sessionStorage?.getItem(SAID_KEY) === tried) return null;
    globalThis.sessionStorage?.setItem(SAID_KEY, tried);
  } catch {
    return null;
  }
  await refreshBoxDrafts().catch(() => {});
  const card = boxPending.find((p) => p.plugin === CORE_PART && p.version === tried);
  return m.swapOutcome({ to: tried, kind: "try", at: Date.now(), ...(card?.changes?.length ? { what: tryWhat(card.changes) } : {}), ...(card?.looks?.length ? { looks: card.looks } : {}) }, s);
};
export function _setSwapCheck(fn: typeof swapCheck): void {
  swapChecked = false;
  swapCheck = fn;
}
function checkCoreSwap(): void {
  if (swapChecked) return;
  swapChecked = true;
  void swapCheck()
    .then((r) => {
      if (!r) return;
      console.info(`[core] after the swap: ${r.text}`);
      say({ plugin: CORE_PART, name: CORE_NAME, text: r.text, ok: r.ok, at: Date.now() });
      // Point at where it shows (the commits' Look selectors), so his eye goes straight to it.
      if (r.ok && r.looks?.length) void import("./corePointer").then((p) => p.pointAt(r.looks!)).catch(() => {});
    })
    .catch((e) => console.warn("[core] could not say what runs after the swap:", e));
}

export function startChangeReady(): void {
  checkCoreSwap();
  followTries();
  hookStorage();
  if (!settingsHooked) {
    settingsHooked = true;
    // A settings draft arrived, was decided or replaced: what this window shows follows (and a keep may be watched).
    onSettingsDrafts(() => {
      syncSettingsTry();
      watchTyping();
    });
    // Carl picks a setting the tried draft lays over: his pick wins and the trying stops.
    onPickWhileTrying(() => setTried(SETTINGS_DRAFT_ID, null));
  }
  syncSettingsTry();
  watchTyping();
}

// ---------------------------------------------------------------- "Try it?" lines in Main (src/changeFlow.ts)

const offered = new Set<string>();
/** The box writes "<what> — Try it?" into Main for each change waiting for Carl (once each; the box keeps it to one
 *  line too). A gated plugin's draft was offered by the gate already; this covers the rest (a core with something to
 *  see, a box plugin's or migration's draft, a settings draft). Tests replace the poster. */
let offerPost = async (plugin: string, version: string): Promise<boolean> => {
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return false;
  const r = await boxPost(link, "/api/v2/changes/offer", { plugin, version }).catch(() => null);
  return !!(r as { ok?: boolean } | null)?.ok;
};
export function _setOfferPost(fn: typeof offerPost): void {
  offerPost = fn;
}
export async function offerPending(pending: readonly PendingChange[] = pendingChanges()): Promise<number> {
  let n = 0;
  for (const p of pending) {
    const key = `${p.plugin}@${p.version}`;
    if (offered.has(key)) continue;
    offered.add(key);
    if (await offerPost(p.plugin, p.version).catch(() => false)) n++;
    else offered.delete(key);
  }
  return n;
}

// ---------------------------------------------------------------- the offers (PluginRead / PluginAct)

const describe = (p: PendingChange) => {
  const m = p.migration ? migrationTryOf(p.plugin, p.version) : null;
  return { plugin: p.plugin, name: p.name, what: p.what || null, version: p.version, added: p.added, trying: triedVersion(p.plugin) === p.version, triable: p.triable, ...(p.changes ? { changes: p.changes } : {}), ...(p.migration ? { migration: { target: p.migration.target, tried: m ? { state: m.state, line: m.line ?? null, error: m.error ?? null, summary: m.summary ?? null } : null } } : {}) };
};

export function changeOffers() {
  const need = (args: Record<string, unknown>) => {
    const plugin = String(args.plugin ?? "");
    const p = pendingChanges().find((x) => x.plugin === plugin || x.name.toLowerCase() === plugin.toLowerCase()) ?? (plugin ? null : pendingChanges()[0] ?? null);
    if (!p) throw new Error(plugin ? `no draft of ${plugin} is waiting` : "no draft is waiting");
    return p;
  };
  const pluginArg = { type: "object", properties: { plugin: { type: "string", description: "The plugin (app/composer, a vault plugin's path, app/settings-values for Carl's settings); left out: the first waiting draft." } }, additionalProperties: false };
  return {
    state: {
      changes: { description: "The changes staged for Carl (the gate passed; each has a \"Try it?\" line in Main), each with whether he is trying it now on his laptop. One he has not tried: remind him once.", read: () => pendingChanges().map(describe) },
      untried: { description: "Staged changes Carl has not tried yet (remind him once, in a word).", read: () => pendingChanges().filter((p) => triedVersion(p.plugin) !== p.version).map(describe) },
      trying: { description: "The drafts Carl is trying now (they run on his windows only; nothing on the box changes until Keep).", read: () => tryingNow().map(describe) },
      last: { description: "What happened last: kept, discarded, or discarded by itself and why.", read: () => outcome },
    },
    actions: {
      try: {
        description: "Try a waiting draft on Carl's windows (only when he asked). A settings draft (app/settings-values) of only the box's settings has no Try.",
        args: pluginArg,
        run: (a: Record<string, unknown>) => {
          const p = need(a);
          if (!p.triable) throw new Error(`${p.name}: ${p.what} is the box's, so it can't be tried on Carl's windows; Keep sets it`);
          const m = tryChange(p.plugin, p.version);
          return m ? m.then(() => describe(p)) : describe(p);
        },
      },
      stop: { description: "Stop trying a draft: the copy in effect runs again.", args: pluginArg, run: (a: Record<string, unknown>) => { const p = need(a); stopTrying(p.plugin); return describe(p); } },
      keep: { description: "Keep a draft (only when Carl said so): a record; the box makes it the live copy.", args: pluginArg, run: async (a: Record<string, unknown>) => { const p = need(a); return keepChange(p.plugin, p.version, "agent"); } },
      discard: { description: "Discard a draft: a record; the box removes it.", args: pluginArg, run: async (a: Record<string, unknown>) => { const p = need(a); return discardChange(p.plugin, p.version, { by: "agent" }); } },
      switchBack: {
        description: "Switch a plugin back to the copy its last Keep replaced (undo; another switch redoes it).",
        args: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => switchBack(String(a.plugin ?? ""), "agent"),
      },
    },
  };
}

/** Tests: forget what this module holds. */
export function _resetChangeReady(): void {
  offered.clear();
  quietKept.clear();
  typing?.off();
  typing = null;
  tryVault = null;
  tries = NONE;
  vaultSlots = [];
  boxPending = [];
  boxKnown.clear();
  migrationTry = null;
  outcome = null;
  autoDone.clear();
  revertDone.clear();
  setSettingsTry(null);
}

