// The app's core as a swappable part (hot core). The laptop app's whole frontend (this folder, built) is a bundle the
// box builds from accepted main and serves; the native shell keeps a small loader (src-tauri/src/core_loader.rs) and the
// bundle baked into the installer as its last resort. Only native changes (Rust commands, plugins, the WebView shell,
// the installer) still need a release.
//
//   build    the box, after main moves, while Carl's setting corePublish is on (the default; server/coreBundles.ts
//            starts scripts/core-publish.ts through the StartJob path, outside the server's memory): `vite build` of that
//            commit into <state>/core-bundles/<version>/, with manifest.json.
//   offer    a new bundle is a Change ready card (the part app/core, GET /api/v2/changes), like a plugin's draft: Try runs
//            it in Carl's windows (src/coreFollow.ts tryCore: the loader serves it, the old screen stays painted until
//            the new one is up, and the open chat, its scroll, the composer draft and the panes come back:
//            src/coreSwap.ts), Keep makes it the core every launch runs, Discard drops it, Switch back returns to the
//            core the Keep replaced.
//   version  the first 8 hex digits of the manifest's sha256 (the same shape as a plugin copy's version); the full
//            sha256 travels with it and the loader checks it, and every file's own sha256, before it keeps a copy.
//   record   the existing plugin.change record for the part `app/core` (src/pluginDrafts.ts): Carl's keep lands a new
//            bundle, a switch by "auto" is the laptop's loader falling back. The loader's cache only mirrors it.
//   needs    the manifest says what the bundle needs: the native commands it invokes and the shell plugins it imports
//            (scanned from its source at build time), and the box API (CORE_BOX_API of its commit). The loader refuses a
//            bundle whose commands the installed shell lacks, and the laptop one whose box API the box does not serve.
//   boot     the loader serves the chosen bundle at the app's own origin (same storage, same IPC). The bundle must call
//            `core_ready` within READY_MS of every load, or the loader falls back: to the previous bundle, then to the
//            baked one. An error thrown before ready does the same at once. The fallback is the loader's, never this
//            bundle's: a bundle that cannot boot cannot rescue itself.
//
// app/* live copies and the bundle: an app plugin's kept live copy (.vault-chat/app-plugins/<name>.js) is a copy of
// that plugin built against some core. The bundle carries every plugin's built-in module, so a later core fix to the
// same plugin lands in the bundle while the live copy keeps running over it: today a kept live copy HIDES later core
// fixes to its plugin until it is switched back to built-in (Plugins tool back, or Change ready's Switch back). So:
// fix app/* plugins in the core (src/plugins/<name>, shipped as a bundle) and use live copies only for quick tries and
// vault plugins; after a core fix to a plugin that has a kept live copy, switch that copy back (or rebuild it from the
// new built-in). Not built yet: a live copy naming the core it was made from, so a newer core wins over it by itself.
//
// Shared by the app, the box and the build script: no imports.

export const CORE_PART = "app/core";
/** What Carl calls it on the Change ready card. */
export const CORE_NAME = "App core";
/** The box API this source needs (bundle) or serves (box). Raise it when the frontend starts to depend on a box route
 *  or record shape older boxes lack: a box below the bundle's number is never offered that bundle. */
export const CORE_BOX_API = 1;
/** The manifest's shape. */
export const CORE_SCHEMA = 1;
/** How long a freshly loaded bundle has to say ready before the loader falls back (src-tauri/src/core_loader.rs). */
export const READY_MS = 30_000;

export type CoreFile = { path: string; sha256: string; size: number };
export type CoreNeeds = { commands: string[]; plugins: string[]; boxApi: number };
export type CoreManifest = {
  schema: typeof CORE_SCHEMA;
  /** The main commit it was built from, and that commit's time (s since 1970). */
  commit: string;
  commitTime: number;
  builtAt: string;
  needs: CoreNeeds;
  files: CoreFile[];
};
/** A bundle waiting for Carl (the Change ready card's `core`): how to fetch and check it, and whether this laptop can run it. */
export type CoreCandidate = { sha256: string; commit: string; commitTime: number; needs: CoreNeeds; boxApi: number };
/** What the box offers: the bundle in effect and how to check it. */
export type CoreOffer = { version: string; sha256: string; commit: string; commitTime: number; needs: CoreNeeds; seq: number };

export const CORE_VERSION_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[a-z0-9_:|-]{1,80}$/;

/** A bundle file's path: relative, forward slashes, no `..`, no hidden or odd names. */
export function safeCorePath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 300 || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((s) => s && s !== "." && s !== ".." && /^[A-Za-z0-9@_+-][A-Za-z0-9@_.+-]*$/.test(s));
}

/** Why a manifest is not one a loader may take, or null. */
export function manifestProblem(m: unknown): string | null {
  const x = m as Partial<CoreManifest> | null;
  if (!x || typeof x !== "object") return "not a manifest";
  if (x.schema !== CORE_SCHEMA) return `schema ${String(x.schema)} (this reads ${CORE_SCHEMA})`;
  if (typeof x.commit !== "string" || !COMMIT_RE.test(x.commit)) return "commit missing";
  if (typeof x.commitTime !== "number" || !Number.isFinite(x.commitTime)) return "commitTime missing";
  const n = x.needs;
  if (!n || !Array.isArray(n.commands) || !Array.isArray(n.plugins) || typeof n.boxApi !== "number") return "needs missing";
  if (![...n.commands, ...n.plugins].every((c) => typeof c === "string" && NAME_RE.test(c))) return "needs: a bad name";
  if (!Array.isArray(x.files) || !x.files.length || x.files.length > 5000) return "files missing";
  const seen = new Set<string>();
  for (const f of x.files) {
    if (!f || !safeCorePath(f.path) || seen.has(f.path)) return `bad file ${String(f?.path).slice(0, 80)}`;
    if (typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256) || typeof f.size !== "number" || f.size < 0) return `bad file ${f.path}`;
    seen.add(f.path);
  }
  if (!seen.has("index.html")) return "no index.html";
  return null;
}

/** The manifest's bytes, always written the same way (the version is the hash of these bytes). */
export function manifestText(m: CoreManifest): string {
  const files = [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ schema: m.schema, commit: m.commit, commitTime: m.commitTime, builtAt: m.builtAt, needs: { commands: [...m.needs.commands].sort(), plugins: [...m.needs.plugins].sort(), boxApi: m.needs.boxApi }, files }, null, 1) + "\n";
}

/** The version of a manifest whose sha256 is `sha256`. */
export const coreVersionOf = (sha256: string): string => sha256.slice(0, 8);

/** What the installed shell lacks for this bundle (empty: it can run it). */
export function missingNeeds(needs: CoreNeeds, shell: { commands: readonly string[]; plugins: readonly string[] }): string[] {
  const c = new Set(shell.commands);
  const p = new Set(shell.plugins);
  return [...needs.commands.filter((x) => !c.has(x)).map((x) => `command ${x}`), ...needs.plugins.filter((x) => !p.has(x)).map((x) => `plugin ${x}`)];
}

/** The native commands and shell plugins a source tree uses: invoke("<command>") / invoke<T>("<command>") calls and
 *  `@tauri-apps/plugin-<name>` imports. Pure (the build script reads the files). */
/** Commands the source calls that no shell has, each call guarded (it works without them): not needs. */
export const OPTIONAL_COMMANDS: readonly string[] = ["phone_push_legacy_enabled", "phone_push_result"];
export function scanNeeds(sources: Iterable<string>): { commands: string[]; plugins: string[] } {
  const commands = new Set<string>();
  const plugins = new Set<string>();
  const inv = /\binvoke\s*(?:<[^()]*?>)?\s*\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
  const imp = /["']@tauri-apps\/plugin-([a-z-]+)["']/g;
  for (const s of sources) {
    for (const m of s.matchAll(inv)) if (!OPTIONAL_COMMANDS.includes(m[1]!)) commands.add(m[1]!);
    for (const m of s.matchAll(imp)) plugins.add(m[1]!);
  }
  return { commands: [...commands].sort(), plugins: [...plugins].sort() };
}

/** What the laptop should run, from the box's offer and what it runs now. `baked`: the installed shell's own bundle
 *  (its commit time; a box bundle no newer than the installer's own source is never taken over it). */
export type CoreStep = { kind: "stay"; why: string } | { kind: "install"; offer: CoreOffer } | { kind: "baked"; why: string };
export function nextCoreStep(o: {
  offer: CoreOffer | null;
  active: string | null;
  bad: readonly string[];
  bakedCommitTime: number | null;
  shell: { commands: readonly string[]; plugins: readonly string[] };
  boxApi: number | null;
}): CoreStep {
  const { offer } = o;
  // No box bundle in effect (none kept yet, or Carl switched back to the installed app's own): the baked core.
  if (!offer) return o.active ? { kind: "baked", why: "the box's core is the installed app's own" } : { kind: "stay", why: "the box offers no core bundle" };
  if (offer.version === o.active) return { kind: "stay", why: "running it already" };
  if (o.bad.includes(offer.version)) return { kind: "stay", why: `${offer.version} failed here before` };
  if (o.bakedCommitTime !== null && offer.commitTime <= o.bakedCommitTime) {
    return o.active ? { kind: "baked", why: "the installed app's own core is newer" } : { kind: "stay", why: "the installed app's own core is as new" };
  }
  const missing = missingNeeds(offer.needs, o.shell);
  if (missing.length) return { kind: "stay", why: `needs a newer installed app (${missing.slice(0, 4).join(", ")})` };
  if (o.boxApi === null || offer.needs.boxApi > o.boxApi) return { kind: "stay", why: `needs box API ${offer.needs.boxApi}, the box serves ${o.boxApi ?? "none"}` };
  return { kind: "install", offer };
}
