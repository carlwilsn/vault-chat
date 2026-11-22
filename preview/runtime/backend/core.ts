// The hot core in the preview (src/coreBundle.ts, src/coreFollow.ts, src/coreSwap.ts): a fake native loader and the
// box's core routes, so the real follow (a kept bundle swapped in) and Switch back run as on the laptop.
//
//   loader   core_status / core_install / core_use / core_ready / core_events_sent. core_use is the real swap: the frame
//            loads again (location.reload), as the native loader reloads the window, and the boot keeps this device's
//            storage for that load (a swap, not a new scenario: src/coreSwap.ts finds what it kept).
//   box      GET /api/v2/core (the offer: what was kept), POST /api/v2/supervisor for app/core (keep /
//            switch / discard resolved as server/coreBundles.ts coreLanding does). The records outlive the frame's
//            load (sessionStorage), as the box's log does.
//   look     a bundle may carry `css`: what that build changes on screen, applied while the loader runs it.
// Nothing here runs unless a scenario gives `host.core`.
import { BUILT_IN, landing, type ChangeRecord } from "../../../src/pluginDrafts";
import { CORE_BOX_API, CORE_PART, type CoreCommit } from "../../../src/coreBundle";

export type CoreBundle = { version: string; sha256?: string; commit?: string; commitTime: number; what: string; css?: string; /** main's commits up to it, newest first (the box's git log) */ commits?: CoreCommit[] };
export type CoreConfig = { bundles: CoreBundle[]; bakedCommitTime?: number; /** what the box's git lists for any GET /api/v2/core/landed/<from>/<to> (the Landed card) */ landed?: string[]; /** a bundle the gate kept already when the scenario opens (the Ready card asks for OK) */ kept?: string };

type Loader = { active: string | null; current: string | null; previous: string | null; bad: string[] };
type Sig = { type: "plugin.change"; plugin: string; change: "keep" | "switch" | "discard"; version: string; from?: string; at: number; by?: string; reason?: string };

let cfg: CoreConfig | null = null;
let ns = "default";
const key = (k: string) => `vcp-core:${ns}:${k}`;
const read = <T>(k: string, d: T): T => {
  try {
    const v = sessionStorage.getItem(key(k));
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => sessionStorage.setItem(key(k), JSON.stringify(v));

/** At boot: this frame's side and scenario (each keeps its own loader and records). Returns whether this load is a
 *  core swap (the storage is kept, the scenario's steps do not run again). */
export function coreBoot(namespace: string): boolean {
  ns = namespace;
  const swap = sessionStorage.getItem(key("swap")) === "1";
  sessionStorage.removeItem(key("swap"));
  if (!swap) {
    for (const k of ["loader", "recs"]) sessionStorage.removeItem(key(k));
  }
  return swap;
}

/** The scenario's core (null: none, nothing here answers). */
export function setCoreConfig(c: CoreConfig | null | undefined): void {
  cfg = c ?? null;
  if (cfg?.kept && !sigs().length) write("recs", [{ type: "plugin.change", plugin: CORE_PART, change: "keep", version: cfg.kept, from: BUILT_IN, at: Date.now(), by: "gate" } satisfies Sig]);
}

const loader = (): Loader => read<Loader>("loader", { active: null, current: null, previous: null, bad: [] });
const sigs = (): Sig[] => read<Sig[]>("recs", []);
/** The records as the box folds them (seq = order). */
const changes = (): ChangeRecord[] => sigs().map((s, i) => ({ seq: i + 1, plugin: s.plugin, change: s.change, version: s.version, from: s.from ?? null, at: s.at, by: s.by ?? null, reason: s.reason ?? null }));
const sha = (b: CoreBundle) => b.sha256 ?? b.version + "0".repeat(56);
const commit = (b: CoreBundle) => b.commit ?? (b.version + "0".repeat(40)).slice(0, 40);
const byVersion = (v: string | null | undefined) => cfg?.bundles.find((b) => b.version === v) ?? null;

/** The records to put back in the fake box's log at boot (its supervisor feed). */
export function coreSignals(): Sig[] {
  return cfg ? sigs() : [];
}

/** What the loader runs now changes the screen as that build does. */
export function applyCoreLook(): void {
  const css = byVersion(loader().active)?.css;
  if (!cfg || !css || typeof document === "undefined") return;
  const st = document.createElement("style");
  st.dataset.vcpCore = loader().active ?? "";
  st.textContent = css;
  document.head.appendChild(st);
}

export const coreCommands: Record<string, (a: Record<string, any>) => unknown> = {
  core_ready: () => null,
  core_boot_error: () => false,
  core_events_sent: () => null,
  core_status: () => {
    if (!cfg) throw "command core_status not found"; // an installed app from before the loader
    const l = loader();
    return {
      shell: "0.9.40",
      active: l.active ?? BUILT_IN,
      activeCommit: l.active ? commit(byVersion(l.active)!) : null,
      ready: true,
      current: l.current,
      previous: l.previous,
      bad: l.bad,
      events: [],
      commands: ["app_ready", "core_ready", "core_status", "core_install", "core_use"],
      plugins: ["autostart", "dialog", "opener", "process", "single-instance", "updater"],
      baked: { commit: "b".repeat(40), commitTime: cfg.bakedCommitTime ?? 100 },
    };
  },
  core_install: async ({ version, sha256 }) => {
    const b = byVersion(version);
    if (!b) throw `no core bundle ${version} on the box`;
    if (sha256 !== sha(b)) throw `${version}'s manifest does not match its record's hash: refused`;
    await new Promise((r) => setTimeout(r, 500)); // fetched and every file's hash checked
    return null;
  },
  core_use: ({ version }) => {
    const v = version && version !== BUILT_IN ? String(version) : null;
    const l = loader();
    if (l.current !== v) write("loader", { ...l, previous: l.current ?? l.previous, current: v, active: v });
    else write("loader", { ...l, active: v });
    // The loader serves it from the next load on and reloads the window.
    sessionStorage.setItem(key("swap"), "1");
    setTimeout(() => location.reload(), 30);
    return null;
  },
};

/** GET routes of the box's core, or null (not one). */
export function coreBoxGet(u: URL): { status: number; body: string } | null {
  if (!cfg) return null;
  const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
  if (u.pathname.includes("/api/v2/core/landed/")) return cfg.landed ? ok({ subjects: cfg.landed }) : { status: 404, body: JSON.stringify({ error: "no such route" }) };
  if (u.pathname.endsWith("/api/v2/core")) {
    const l = landing(changes());
    const b = l && l.version !== BUILT_IN ? byVersion(l.version) : null;
    return ok({
      part: CORE_PART,
      boxApi: CORE_BOX_API,
      publish: true,
      offer: b ? { version: b.version, sha256: sha(b), commit: commit(b), commitTime: b.commitTime, needs: { commands: ["app_ready", "core_ready"], plugins: ["dialog"], boxApi: CORE_BOX_API }, seq: l!.seq } : null,
      builds: [],
    });
  }
  return null;
}

/** Carl's word on app/core, resolved as the box does (server/coreBundles.ts coreLanding), or null (another plugin). */
export function coreChange(b: Record<string, any> | null): { status: number; sig?: Sig; error?: string } | null {
  if (!cfg || b?.plugin !== CORE_PART) return null;
  const ch = changes();
  const now = landing(ch)?.version ?? BUILT_IN;
  const by = typeof b.by === "string" ? b.by : "carl";
  const change = b.change as Sig["change"];
  let sig: Sig;
  if (change === "switch") {
    const to = typeof b.version === "string" && b.version ? b.version : landing(ch)?.from ?? BUILT_IN;
    if (to === now) return { status: 409, error: `the core is ${now} already` };
    sig = { type: "plugin.change", plugin: CORE_PART, change, version: to, from: now, at: Date.now(), by };
  } else if (change === "keep" || change === "discard") {
    if (!byVersion(b.version)) return { status: 404, error: `no core bundle ${b.version} on this box` };
    sig = { type: "plugin.change", plugin: CORE_PART, change, version: b.version, from: now, at: Date.now(), by };
  } else return { status: 400, error: 'change is "keep", "discard" or "switch"' };
  if (typeof b.reason === "string") sig.reason = b.reason;
  write("recs", [...sigs(), sig]);
  return { status: 200, sig };
}
