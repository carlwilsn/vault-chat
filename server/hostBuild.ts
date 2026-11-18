// Which build each host app runs, and the agent's LaptopBuild tool.
//
//   report  The laptop app, once per launch (src/hostBuild.ts), POSTs /api/v1/host/build: its frontend version and
//           revision (vite's __APP_VERSION__ / __APP_REVISION__), the native app version, surface, webview runtime, the
//           last launch-to-interactive time, and the server it carries if it runs one. The box appends it to
//           <state>/logs/host-builds.jsonl and keeps the newest per host in <state>/host-builds.json.
//   wake    A conversation can ask to be woken when a host reports a different build (LaptopBuild {action:"wake"}):
//           a watcher in <state>/host-build-watch.json. A report that satisfies it adds a durable wake for that
//           conversation (server/engine/wakes.ts, the ScheduleWake path), so the agent gets one short turn
//           "laptop now on build X" and runs its checks then, instead of polling. One-shot; expires.
//   get     LaptopBuild asks the laptop live (a "build" signal on Show's channel, acked with the same record) and
//           puts it next to the last report and the box's own server build. Offline / no answer are said as such.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RotatingLog } from "./boxLogs";
import { renameRetry } from "./atomic";
import { addWake } from "./engine/wakes";
import { waitAck } from "./show";
import { controlDown, noteAnswer, unansweredNote } from "./deviceLink";

export const HOSTS = ["laptop"] as const;
export type Host = (typeof HOSTS)[number];

/** What a host app says about itself. Only these fields are kept, each bounded. */
export type HostBuild = {
  host: Host;
  /** Frontend build: package.json version and the git revision it was built from ("unknown": a dirty build). */
  version: string;
  revision: string;
  /** The installed native app's version (Tauri getVersion), when the app is native. */
  nativeVersion?: string;
  surface: string;
  runtime?: string;
  runtimeVersion?: string;
  /** "launch": sent once per app start; "ask": an answer to LaptopBuild. */
  reason?: "launch" | "ask";
  session?: string;
  /** Native run() entry to an interactive first screen, this launch (src/laptopPerf.ts's launch-interactive). */
  launchMs?: number;
  launchMethod?: string;
  /** When the app started (ISO), from the renderer's time origin. */
  startedAt?: string;
  /** The vault-chat server the app runs itself (no box), if any: its url and build. */
  localServer?: { url: string; version?: string; rev?: string } | null;
  /** The box the app talks to. */
  box?: string;
  /** The core bundle the native shell's loader serves (src/coreBundle.ts): a box-built one (its version, the main commit
   *  it was built from) or the installed app's own ("built-in"), apart from the native shell's version above. */
  core?: { version: string; commit?: string; fellBack?: string };
};

const str = (v: unknown, max = 80): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** The fields kept from a host's report, or why it is refused. */
export function cleanHostBuild(raw: unknown): HostBuild | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (!(HOSTS as readonly string[]).includes(String(b.host))) return "unknown host";
  const version = str(b.version, 40);
  const revision = str(b.revision, 64);
  const surface = str(b.surface, 40);
  if (!version || !revision || !surface) return "version, revision and surface are required";
  const out: HostBuild = { host: b.host as Host, version, revision, surface };
  for (const k of ["nativeVersion", "runtime", "runtimeVersion", "session", "launchMethod", "startedAt", "box"] as const) {
    const v = str(b[k], k === "box" ? 200 : 80);
    if (v) out[k] = v;
  }
  if (b.reason === "launch" || b.reason === "ask") out.reason = b.reason;
  if (typeof b.launchMs === "number" && Number.isFinite(b.launchMs) && b.launchMs >= 0 && b.launchMs < 600_000) out.launchMs = Math.round(b.launchMs);
  const core = b.core as Record<string, unknown> | null | undefined;
  if (core && typeof core === "object" && typeof core.version === "string" && /^(?:[0-9a-f]{8}|built-in)$/.test(core.version)) {
    out.core = { version: core.version, ...(typeof core.commit === "string" && /^[0-9a-f]{7,40}$/.test(core.commit) ? { commit: core.commit } : {}), ...(str(core.fellBack, 200) ? { fellBack: str(core.fellBack, 200) } : {}) };
  }
  const ls = b.localServer as Record<string, unknown> | null | undefined;
  if (ls === null) out.localServer = null;
  else if (ls && typeof ls === "object" && str(ls.url, 200)) out.localServer = { url: str(ls.url, 200)!, ...(str(ls.version, 40) ? { version: str(ls.version, 40) } : {}), ...(str(ls.rev, 64) ? { rev: str(ls.rev, 64) } : {}) };
  return out;
}

export type HostBuildRecord = HostBuild & { at: string };
export type Watch = { id: string; conv: string; vault: string; host: Host; since: { version: string; revision: string } | null; want?: { version?: string; revision?: string }; at: number; expires: number; byCarl?: boolean };

const lastPath = (stateDir: string) => join(stateDir, "host-builds.json");
const watchPath = (stateDir: string) => join(stateDir, "host-build-watch.json");
const log = (stateDir: string) => new RotatingLog(join(stateDir, "logs", "host-builds.jsonl"), { maxBytes: 128 * 1024, keep: 1 });

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(v, null, 1));
  renameRetry(p + ".tmp", p);
}

export function lastHostBuild(stateDir: string, host: Host = "laptop"): HostBuildRecord | null {
  const all = readJson<Record<string, HostBuildRecord>>(lastPath(stateDir), {});
  return all[host] ?? null;
}
export function hostBuildHistory(stateDir: string, max = 20): HostBuildRecord[] {
  return (log(stateDir).since(0, 5000) as HostBuildRecord[]).slice(-max);
}
export function readWatches(stateDir: string): Watch[] {
  const v = readJson<unknown>(watchPath(stateDir), []);
  return Array.isArray(v) ? (v as Watch[]).filter((w) => w && typeof w.conv === "string" && typeof w.vault === "string") : [];
}

const sameBuild = (a: { version: string; revision: string } | null | undefined, b: { version: string; revision: string }) => !!a && a.version === b.version && a.revision === b.revision;
const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);

/** Does this report satisfy the watcher? A wanted version / revision (prefix) must match; else any build that differs from `since`. */
export function watchMet(w: Watch, b: HostBuild): boolean {
  if (w.host !== b.host) return false;
  if (w.want?.version || w.want?.revision) {
    return (!w.want.version || w.want.version.replace(/^v/, "") === b.version.replace(/^v/, "")) && (!w.want.revision || b.revision.startsWith(w.want.revision));
  }
  return !sameBuild(w.since, b);
}

export function buildLine(b: HostBuild): string {
  return `v${b.version} (frontend revision ${short(b.revision)}${b.nativeVersion && b.nativeVersion !== b.version ? `, native app v${b.nativeVersion}` : ""}, ${b.surface}${b.runtime ? `, ${b.runtime} ${b.runtimeVersion ?? ""}`.trimEnd() : ""})`;
}

export type RecordResult = { status: number; body: { ok?: boolean; error?: string; newBuild?: boolean; woke?: number } };

/**
 * POST /api/v1/host/build. Appends the report, keeps the newest per host, and wakes every conversation whose watcher
 * it satisfies. Only an installed app (surface tauri-production) wakes anyone: a dev or browser build is recorded only.
 */
export function recordHostBuild(stateDir: string, raw: unknown, o: { now?: number; nativeTransport?: boolean; wake?: typeof addWake } = {}): RecordResult {
  const b = cleanHostBuild(raw);
  if (typeof b === "string") return { status: 400, body: { error: b } };
  const now = o.now ?? Date.now();
  const rec: HostBuildRecord = { ...b, at: new Date(now).toISOString() };
  const all = readJson<Record<string, HostBuildRecord>>(lastPath(stateDir), {});
  const prev = all[b.host] ?? null;
  const newBuild = !sameBuild(prev, b);
  all[b.host] = rec;
  try {
    writeJson(lastPath(stateDir), all);
  } catch {
    /* the log below still has it */
  }
  log(stateDir).append({ ...rec, newBuild, nativeTransport: !!o.nativeTransport });
  let woke = 0;
  if (b.surface === "tauri-production") {
    const watches = readWatches(stateDir);
    const keep: Watch[] = [];
    for (const w of watches) {
      if (w.expires <= now) continue;
      if (!watchMet(w, b)) {
        keep.push(w);
        continue;
      }
      try {
        (o.wake ?? addWake)(w.vault, {
          conv: w.conv,
          at: now,
          reason: `${b.host} now on build ${buildLine(b)}${w.since ? `; it was on v${w.since.version} (${short(w.since.revision)})` : ""}. Run your laptop checks now (LaptopBuild, Drive, Timing, Screen).`,
          ...(w.byCarl ? { byCarl: true } : {}),
        });
        woke++;
      } catch {
        keep.push(w);
      }
    }
    if (keep.length !== watches.length) writeJson(watchPath(stateDir), keep);
  }
  return { status: 200, body: { ok: true, newBuild, woke } };
}

/** Add a one-shot watcher for this conversation (a second one for the same conversation and host replaces it). */
export function addWatch(stateDir: string, w: Omit<Watch, "id" | "at">, now = Date.now()): Watch {
  const watch: Watch = { ...w, id: `hb-${now.toString(36)}-${randomBytes(3).toString("hex")}`, at: now };
  writeJson(watchPath(stateDir), [...readWatches(stateDir).filter((x) => !(x.conv === w.conv && x.host === w.host) && x.expires > now), watch]);
  return watch;
}

// ---------------------------------------------------------------- the agent's tool

export const LAPTOP_BUILD_DESCRIPTION =
  "Which build Carl's laptop app runs, so you can tell whether a release has reached it. " +
  "action \"get\" (default): asks the laptop app live (when it is open and connected) for its frontend version and git revision, the installed native app version, its webview runtime, its last launch-to-interactive time and the server it carries if it runs one; shows the last build it reported at launch and the box's own server build next to it. " +
  "Its frontend (the core) comes apart from the native shell: the box builds a core bundle from each accepted main itself and the app's loader takes it with no installer (it falls back to the previous bundle, then the installed app's own, when one does not boot); the answer says which core runs. " +
  "Native changes (Rust commands, plugins, the installer) still arrive only through the app's updater: " + "a push to main that touches the app is built by GitHub Actions (ship.yml: version bump commit vX.Y.Z on a release tag, Windows installer, latest.json) and the app offers \"Install & restart\" (it checks at launch and every 5 min; Carl clicks it unless the app runs in background mode, which installs when idle). The revision the app reports is that version-bump commit, whose parent is the main commit it was built from. " +
  "action \"wake\": wake this conversation with one short turn the next time the laptop reports a different build at launch (or the given version / revision), instead of polling. Use it after shipping something the laptop must get; then run your checks (Drive, Timing, Screen) in that turn.";

export const LAPTOP_BUILD_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", "wake"], description: "get (default) or wake." },
    version: { type: "string", description: "wake: wake when the laptop reports this version (e.g. 0.7.30)." },
    revision: { type: "string", description: "wake: wake when the laptop's revision starts with this." },
    hours: { type: "number", description: "wake: give up after this many hours (default 72, at most 168)." },
  },
  additionalProperties: false,
} as const;

export type LaptopBuildDeps = {
  vault: string;
  stateDir: string;
  conv: string;
  byCarl?: boolean;
  emit: (ev: Record<string, unknown>) => void;
  server: { version: string; rev: string };
  ackMs?: number;
  /** The box's newest app/core change record (Carl's Try is not one; a keep, discard or switch is), so a core seen as
   *  "the installed app's own" right after a Discard is not read as a failed boot. */
  coreChange?: () => { change: string; version: string; by: string; at: number; reason?: string } | null;
};

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

function describe(b: HostBuild): string[] {
  const lines = [`build ${buildLine(b)}`];
  if (b.core) lines.push(b.core.version === "built-in" ? "core: the installed app's own (baked into the installer)" : `core: bundle ${b.core.version} from the box (main ${short(b.core.commit ?? "?")}), native shell v${b.nativeVersion ?? "?"}`);
  if (b.core?.fellBack) lines.push(`core loader fell back: ${b.core.fellBack}`);
  if (b.launchMs !== undefined) lines.push(`last launch to interactive: ${b.launchMs} ms (${b.launchMethod ?? "method unknown"})${b.startedAt ? `, started ${b.startedAt}` : ""}`);
  if (b.localServer) lines.push(`runs its own server: ${b.localServer.url}${b.localServer.version ? ` v${b.localServer.version}` : ""}${b.localServer.rev ? ` (${short(b.localServer.rev)})` : ""}`);
  else if (b.localServer === null) lines.push(`carries a server but runs none (it uses the box${b.box ? ` at ${b.box}` : ""})`);
  return lines;
}

export async function laptopBuildTool(d: LaptopBuildDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const action = args.action === undefined || args.action === "" ? "get" : String(args.action);
  const now = Date.now();
  const last = lastHostBuild(d.stateDir, "laptop");
  if (action === "wake") {
    const version = str(args.version, 40)?.replace(/^v/, "");
    const revision = str(args.revision, 64)?.toLowerCase();
    if (revision && !/^[0-9a-f]{4,40}$/.test(revision)) return { ok: false, text: "revision must be a hex commit prefix (4-40 characters)." };
    const hours = typeof args.hours === "number" && args.hours > 0 ? Math.min(args.hours, 168) : 72;
    const w = addWatch(d.stateDir, { conv: d.conv, vault: d.vault, host: "laptop", since: last ? { version: last.version, revision: last.revision } : null, ...(version || revision ? { want: { ...(version ? { version } : {}), ...(revision ? { revision } : {}) } } : {}), expires: now + hours * 3_600_000, ...(d.byCarl ? { byCarl: true } : {}) }, now);
    const what = version || revision ? `reports ${[version && `v${version}`, revision && `revision ${revision}…`].filter(Boolean).join(" / ")}` : last ? `reports a build other than v${last.version} (${short(last.revision)})` : "next reports its build";
    if (last && watchMet(w, last) && (version || revision)) return { ok: true, text: `The laptop already reported that build ${ago(last.at, now)}: ${buildLine(last)}. A wake is set anyway for its next matching launch (watch ${w.id}); you can run your checks now.` };
    return { ok: true, text: `You'll get a wake turn in this conversation when the laptop ${what} at an app launch (watch ${w.id}, expires in ${hours} h). Nothing else to do until then: stop now, don't poll.` };
  }
  if (action !== "get") return { ok: false, text: `Unknown action "${action}". Use get or wake.` };
  const lines: string[] = [];
  let ok = false;
  const down = controlDown("laptop");
  if (down) {
    lines.push(`Live: ${down} So it couldn't be asked now.`);
  } else {
    const id = `build-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
    const ms = d.ackMs ?? 15_000;
    const got = waitAck(id, ms);
    d.emit({ type: "build", id, to: "laptop" });
    const ack = await got;
    noteAnswer("laptop", "build", !!ack);
    const live = ack?.ok ? cleanHostBuild(ack.data) : null;
    if (!ack) lines.push(`Live: asked the laptop, but it did not answer within ${Math.round(ms / 1000)} s (an app from before this tool, or busy).${unansweredNote("laptop")}`);
    else if (!live || typeof live === "string") lines.push(`Live: the laptop answered without a build${ack.error ? `: ${ack.error}` : typeof live === "string" ? ` (${live})` : ""}.`);
    else {
      ok = true;
      lines.push("Live (the laptop app answered now):", ...describe(live).map((l) => `- ${l}`));
    }
  }
  if (last) lines.push(`Last reported at launch, ${ago(last.at, now)} (${last.at}):`, ...describe(last).map((l) => `- ${l}`));
  else lines.push("No launch report from the laptop yet (an app from before build reports, or it has not started since).");
  lines.push(`Box server: v${d.server.version}${d.server.rev ? ` (${short(d.server.rev)})` : ""}.`);
  const cc = d.coreChange?.();
  if (cc) lines.push(`Last app/core change record: ${cc.change} ${cc.version} by ${cc.by}, ${ago(new Date(cc.at).toISOString(), now)}${cc.reason ? ` (${cc.reason.slice(0, 160)})` : ""}.`);
  const watches = readWatches(d.stateDir).filter((w) => w.conv === d.conv && w.expires > now);
  if (watches.length) lines.push(`This conversation is waiting for a laptop build report (watch ${watches.map((w) => w.id).join(", ")}).`);
  return { ok: ok || !!last, text: lines.join("\n") };
}
