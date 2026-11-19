// The Mac friend channel (reports/11-mac section 4): a friend on a Mac (no box, the app's own local server) gets
// updates RARELY and in batches, and only a version that
//   (a) passed every Mac check on a real Mac: ship.yml's build_macos (launch check, self-test variants, .dmg) all
//       passed, which is the only way its release carries mac-update.json (mac_publish uploads it last, after the
//       signed .app.tar.gz), and
//   (b) soaked on Carl's own install: his laptop first reported running that release (native version, the
//       host-builds log of server/hostBuild.ts) at least SOAK_HOURS ago, and since then his laptop sent no NEW app
//       error (window.error, unhandledrejection, console.error in app.jsonl, src/appShip.ts): a signature the friend's
//       current version did not already live with. Transport noise (the box out of reach) is not an app error.
// Why rare: an ad-hoc signed build gets a new code identity each update, so macOS may ask the friend again for
// permissions and keychain access after every update (reports/11-mac section 5).
//
// Where it lives: the Mac app's updater reads ONE fixed manifest, latest-mac.json on the `mac-stable` release
// (src-tauri/tauri.macos.conf.json); Windows/Linux keep latest.json, which never names a Mac file. The box decides
// (it holds Carl's laptop health); GitHub writes. The box has no GitHub token, only the deploy key that pushes git, so a
// promotion is a pushed tag `mac-friend-v<version>` (on GitHub's main) that .github/workflows/mac-promote.yml turns into
// the manifest: it re-checks the release (published, Mac passed, no downgrade) with its own GITHUB_TOKEN. No new secret.
//
// When: the box looks every CHECK_MS (a timer in this server, like the core publisher), and promotes at most once every
// EVERY_DAYS (7) days; Carl asking (the MacFriend tool, action promote) skips the wait, never the gates. Only on the box
// (Linux, the vault-chat repo with its origin): a Mac running its own server never runs this.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RotatingLog } from "./boxLogs";

export const MAC_REPO = process.env.VC_MAC_FRIEND_REPO ?? "carlwilsn/vault-chat";
/** The friend manifest's fixed home; the Mac app's updater endpoint (tauri.macos.conf.json) is this URL. */
export const FRIEND_MANIFEST_URL = `https://github.com/${MAC_REPO}/releases/download/mac-stable/latest-mac.json`;
/** A release's Mac files are complete and passed every Mac check only when it carries this (ship.yml mac_publish). */
export const MAC_PASSED_ASSET = "mac-update.json";
export const TAG_PREFIX = "mac-friend-v";
export const SOAK_HOURS = 24;
export const EVERY_DAYS = 7;
const CHECK_MS = 6 * 3_600_000;

export type Release = { version: string; macPassed: boolean; publishedAt?: string };
export type LaptopBuild = { at: string; version: string; nativeVersion?: string };
export type LaptopError = { at: string; ev: string; data?: unknown };
export type Promotion = { version: string; at: string; tag: string; by: "timer" | "carl" };
export type Verdict = { version: string; ok: boolean; why: string };
export type Decision = {
  /** The version the friend manifest names now (null: none yet). */
  friend: string | null;
  /** The version to promote now, or null. */
  promote: string | null;
  /** Why nothing is promoted (or what is). */
  why: string;
  /** Every newer release, newest first, with its verdict. */
  candidates: Verdict[];
  nextWindow: string | null;
};

export const ERROR_EVENTS = new Set(["window.error", "unhandledrejection", "console.error"]);
/** The box or the network out of reach: the laptop's link, not its code. */
const TRANSPORT = /error sending request|failed to fetch|networkerror|load failed: HTTP 50[0-9]|ECONN|ETIMEDOUT|timed? ?out|network (?:error|changed)/i;

/** "0.9.12" > "0.9.9". Non-numeric parts compare as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** One error's identity across occurrences: numbers, addresses, ids and quoted parts folded away. */
export function errorSignature(e: LaptopError): string {
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "");
  const text = raw
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z]:\\[^\s)]+|\/[\w./-]{3,}/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${e.ev}: ${text}`;
}

export function isAppError(e: LaptopError): boolean {
  if (!ERROR_EVENTS.has(e.ev)) return false;
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "");
  return !TRANSPORT.test(raw);
}

/** When Carl's laptop first ran `version` (its native shell: the installer the friend would get), or null. */
export function firstRan(builds: readonly LaptopBuild[], version: string): number | null {
  let first: number | null = null;
  for (const b of builds) {
    if ((b.nativeVersion ?? b.version) !== version) continue;
    const t = Date.parse(b.at);
    if (Number.isFinite(t) && (first === null || t < first)) first = t;
  }
  return first;
}

/** The gating rules, pure. */
export function decide(o: {
  now: number;
  releases: readonly Release[];
  builds: readonly LaptopBuild[];
  errors: readonly LaptopError[];
  friend: string | null;
  last: Promotion | null;
  force?: boolean;
  soakHours?: number;
  everyDays?: number;
}): Decision {
  const soakMs = (o.soakHours ?? SOAK_HOURS) * 3_600_000;
  const everyMs = (o.everyDays ?? EVERY_DAYS) * 86_400_000;
  const friendSince = o.friend ? firstRan(o.builds, o.friend) : null;
  const errs = o.errors.filter(isAppError).map((e) => ({ t: Date.parse(e.at), sig: errorSignature(e) })).filter((e) => Number.isFinite(e.t));
  const newer = [...o.releases].filter((r) => !o.friend || cmpVersion(r.version, o.friend) > 0).sort((a, b) => cmpVersion(b.version, a.version));
  const candidates: Verdict[] = newer.map((r) => {
    if (!r.macPassed) return { version: r.version, ok: false, why: "the Mac checks did not pass (no mac-update.json on its release)" };
    const since = firstRan(o.builds, r.version);
    if (since === null) return { version: r.version, ok: false, why: "never ran on Carl's laptop" };
    if (o.now - since < soakMs) return { version: r.version, ok: false, why: `soaking: on Carl's laptop since ${new Date(since).toISOString()}, ${Math.floor((o.now - since) / 3_600_000)} of ${soakMs / 3_600_000} h` };
    // What the friend already lives with: the errors seen before the friend's version (or, with none yet, this one)
    // reached Carl's laptop. Anything else seen since this version arrived is new and holds it.
    const baseEnd = friendSince ?? since;
    const known = new Set(errs.filter((e) => e.t < baseEnd).map((e) => e.sig));
    const fresh = [...new Set(errs.filter((e) => e.t >= since && !known.has(e.sig)).map((e) => e.sig))];
    if (fresh.length) return { version: r.version, ok: false, why: `held: ${fresh.length} new app error${fresh.length > 1 ? "s" : ""} on Carl's laptop since it arrived (${fresh.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 100))).join("; ")})` };
    return { version: r.version, ok: true, why: `Mac checks passed; soaked ${Math.floor((o.now - since) / 3_600_000)} h on Carl's laptop with no new app errors` };
  });
  const pick = candidates.find((c) => c.ok)?.version ?? null;
  const lastAt = o.last ? Date.parse(o.last.at) : NaN;
  const nextWindow = Number.isFinite(lastAt) && o.now - lastAt < everyMs ? new Date(lastAt + everyMs).toISOString() : null;
  const base = { friend: o.friend, candidates, nextWindow };
  if (!pick) return { ...base, promote: null, why: newer.length ? "no newer release passes every gate yet" : "the friend is on the newest release" };
  if (nextWindow && !o.force) return { ...base, promote: null, why: `v${pick} is ready, but the last promotion (v${o.last!.version}) was under ${o.everyDays ?? EVERY_DAYS} days ago: next window ${nextWindow}` };
  return { ...base, promote: pick, why: `promote v${pick}` };
}

// ---- IO ----------------------------------------------------------------------------------------------------------------

type State = { last: Promotion | null; lastCheck?: { at: string; why: string } };
const statePath = (stateDir: string) => join(stateDir, "mac-friend.json");
export function readFriendState(stateDir: string): State {
  try {
    const v = JSON.parse(readFileSync(statePath(stateDir), "utf8")) as State;
    return { last: v.last ?? null, ...(v.lastCheck ? { lastCheck: v.lastCheck } : {}) };
  } catch {
    return { last: null };
  }
}
function writeFriendState(stateDir: string, s: State): void {
  const p = statePath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(s, null, 1));
  renameSync(p + ".tmp", p);
}

export function readLaptopBuilds(stateDir: string): LaptopBuild[] {
  return (new RotatingLog(join(stateDir, "logs", "host-builds.jsonl"), { keep: 1 }).since(0, 100_000) as Record<string, unknown>[])
    .filter((b) => b.host === "laptop" && typeof b.version === "string" && typeof b.at === "string")
    .map((b) => ({ at: b.at as string, version: b.version as string, ...(typeof b.nativeVersion === "string" ? { nativeVersion: b.nativeVersion } : {}) }));
}
export function readLaptopErrors(stateDir: string): LaptopError[] {
  return (new RotatingLog(join(stateDir, "logs", "app.jsonl"), { keep: 3 }).since(0, 1_000_000) as Record<string, unknown>[])
    .filter((e) => e.device === "laptop" && typeof e.ev === "string" && ERROR_EVENTS.has(e.ev as string) && typeof e.at === "string")
    .map((e) => ({ at: e.at as string, ev: e.ev as string, data: e.data }));
}

export type FriendDeps = {
  stateDir: string;
  repo: string;
  now?: number;
  fetchJson?: (url: string) => Promise<unknown | null>;
  git?: (args: string[]) => Promise<string>;
};

async function defaultFetchJson(url: string): Promise<unknown | null> {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "vault-chat-box" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
function gitIn(repo: string): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((res, rej) =>
      execFile("git", args, { cwd: repo, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out, err) => (e ? rej(new Error(`git ${args[0]}: ${String(err || e.message).trim().slice(0, 300)}`)) : res(String(out).trim()))),
    );
}

/** The published v* releases (public API, no token) and whether each passed the Mac checks. */
export function parseReleases(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(String(r.tag_name)))
    .map((r) => ({ version: String(r.tag_name).slice(1), macPassed: Array.isArray(r.assets) && r.assets.some((a: { name?: string }) => a?.name === MAC_PASSED_ASSET), ...(r.published_at ? { publishedAt: String(r.published_at) } : {}) }));
}

/** Look (and promote when the rules say so). `force`: Carl asked now (skips the 7-day wait, never a gate). `dry`: say, do nothing. */
export async function friendTick(d: FriendDeps, o: { force?: boolean; dry?: boolean; by?: Promotion["by"] } = {}): Promise<{ decision: Decision; promoted: Promotion | null; error?: string }> {
  const now = d.now ?? Date.now();
  const fetchJson = d.fetchJson ?? defaultFetchJson;
  const st = readFriendState(d.stateDir);
  const [rel, man] = await Promise.all([fetchJson(`https://api.github.com/repos/${MAC_REPO}/releases?per_page=100`), fetchJson(FRIEND_MANIFEST_URL)]);
  const friend = man && typeof (man as { version?: unknown }).version === "string" ? String((man as { version: string }).version) : null;
  const decision = decide({ now, releases: parseReleases(rel), builds: readLaptopBuilds(d.stateDir), errors: readLaptopErrors(d.stateDir), friend, last: st.last, force: o.force });
  // A promotion pushed but not yet in the manifest (the workflow runs): do not push another on top.
  const pending = st.last && (!friend || cmpVersion(st.last.version, friend) > 0) && now - Date.parse(st.last.at) < 6 * 3_600_000;
  if (o.dry || !decision.promote || pending) {
    if (pending && decision.promote && !o.dry) decision.why = `v${st.last!.version} was promoted ${st.last!.at} and its manifest is not out yet (mac-promote.yml): waiting`;
    writeFriendState(d.stateDir, { ...st, lastCheck: { at: new Date(now).toISOString(), why: decision.why } });
    return { decision, promoted: null };
  }
  const git = d.git ?? gitIn(d.repo);
  const tag = `${TAG_PREFIX}${decision.promote}`;
  try {
    // The tag sits on GitHub's main (which carries mac-promote.yml); the version is in its name.
    const sha = (await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("could not read GitHub's main");
    await git(["cat-file", "-e", `${sha}^{commit}`]).catch(() => git(["fetch", "origin", "main"]));
    await git(["push", "origin", `${sha}:refs/tags/${tag}`]);
  } catch (e) {
    const error = (e as Error).message;
    writeFriendState(d.stateDir, { ...st, lastCheck: { at: new Date(now).toISOString(), why: `promoting v${decision.promote} failed: ${error}` } });
    return { decision, promoted: null, error };
  }
  const promoted: Promotion = { version: decision.promote, at: new Date(now).toISOString(), tag, by: o.by ?? (o.force ? "carl" : "timer") };
  writeFriendState(d.stateDir, { last: promoted, lastCheck: { at: promoted.at, why: decision.why } });
  return { decision, promoted };
}

let timer: ReturnType<typeof setInterval> | null = null;
/** At boot, on the box only: look every few hours. Off with VC_MAC_FRIEND=0, off any machine that is not the box. */
export function startMacFriend(d: { stateDir: string; repo: string }): boolean {
  if (process.env.VC_MAC_FRIEND === "0" || process.platform !== "linux" || !existsSync(join(d.repo, ".git"))) return false;
  if (timer) clearInterval(timer);
  let lastLine = "";
  const look = () =>
    void friendTick(d)
      .then((r) => {
        const line = r.promoted ? `promoted v${r.promoted.version} (tag ${r.promoted.tag})` : r.error ? `promotion failed: ${r.error}` : r.decision.why;
        if (line !== lastLine) console.log(`[mac-friend] ${line}`);
        lastLine = line;
      })
      .catch((e) => console.error(`[mac-friend] ${(e as Error).message}`));
  timer = setInterval(look, CHECK_MS);
  timer.unref?.();
  setTimeout(look, 5 * 60_000).unref?.();
  return true;
}

// ---- The agent's tool ----------------------------------------------------------------------------------------------------

export const MAC_FRIEND_DESCRIPTION =
  "The Mac friend channel: which vault-chat version Carl's friend on a Mac is offered (the Mac app's updater reads only latest-mac.json on the mac-stable release, never latest.json). " +
  "A version is promoted only when it passed every Mac check on a real Mac (its release has mac-update.json) and ran on Carl's laptop for 24 h with no new app errors; the box does it by itself at most every 7 days. " +
  'action "status" (default): the friend\'s version, the last promotion, each newer release\'s verdict (Mac checks, soak, held on errors). ' +
  'action "promote": only when Carl asks for it now: skips the 7-day wait, never a gate; it pushes the tag mac-friend-v<version> that the mac-promote workflow turns into the manifest (minutes later).';
export const MAC_FRIEND_SCHEMA = {
  type: "object",
  properties: { action: { type: "string", enum: ["status", "promote"], description: "status (default) or promote (Carl asked now)." } },
  additionalProperties: false,
} as const;

export function describeDecision(r: { decision: Decision; promoted: Promotion | null; error?: string }, last: Promotion | null): string {
  const d = r.decision;
  const lines = [`Friend manifest: ${d.friend ? `v${d.friend}` : "none yet"} (${FRIEND_MANIFEST_URL}).`];
  if (last) lines.push(`Last promotion: v${last.version} at ${last.at} (${last.by}, tag ${last.tag}).`);
  if (r.promoted) lines.push(`Promoted v${r.promoted.version} now: pushed tag ${r.promoted.tag}; the mac-promote workflow writes latest-mac.json in a few minutes.`);
  else if (r.error) lines.push(`Promotion failed: ${r.error}`);
  else lines.push(d.why + ".");
  if (d.candidates.length) lines.push("Newer releases:", ...d.candidates.slice(0, 12).map((c) => `- v${c.version}: ${c.ok ? "ready" : "not yet"}, ${c.why}`));
  return lines.join("\n");
}

export async function macFriendTool(d: FriendDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const action = args.action === undefined || args.action === "" ? "status" : String(args.action);
  if (action !== "status" && action !== "promote") return { ok: false, text: `Unknown action "${action}". Use status or promote.` };
  try {
    const r = await friendTick(d, action === "promote" ? { force: true, by: "carl" } : { dry: true });
    return { ok: !r.error, text: describeDecision(r, readFriendState(d.stateDir).last) };
  } catch (e) {
    return { ok: false, text: `Could not read the releases or the friend manifest: ${(e as Error).message}` };
  }
}
