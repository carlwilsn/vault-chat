/** Durable service acceptance/release journal. This records facts, NEVER authorization: restart cannot
 * reconstruct a proof permit. Stored in git's private directory, outside the synced working tree. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { git, runGit, withRepoLock } from "./git";
import type { ChangeReceipt } from "./changeProof";
import type { Review } from "./projectChanges";
import { logOf } from "./engine/convs";
import { hostToolName } from "../src/mcpNames";
import { KEEP, OUTCOME_SEP, proofImagePath, REVIEW_TOOL } from "../src/review";

export type PublishedChangeRelease = { id: string; version: string; revision: string; tag: string; publishedAt: string };
export type AcceptedChange = {
  id: string; source: ChangeReceipt["source"]; review: Review; proofDir: string;
  /** Retain the recorder request with the receipt; these steps are NOT evidence in themselves. */
  check: import("./changeHost").SubmitCheck;
  /** One explicitly approved old-service handoff. This is a historical fact, NEVER a proof permit. */
  basis?: "legacy-bootstrap";
  /** Bootstrap only: host verifies the exact range excluding the separate voice fixture baseline repair. */
  revertCommits?: string[];
  bootstrap?: { proofId: string; toolCallId: string; fixtureCommit: string; media: { name: string; hash: string }[] };
  preparedAt: string; acceptedAt?: string; release?: PublishedChangeRelease; rollbackOf?: string;
};
export type ShippingJournal = { format: 1; changes: AcceptedChange[]; delivery?: import("./changeDelivery").DeliveryState; recoverySelections?: Record<string, FailedReleaseSelection> };
/** Frozen at the first trusted negative observation, shared by live and retained recovery. */
export type FailedReleaseSelection = { revision: string; changeIds: string[]; selectedAt: string };
export function selectAcceptedFailedRelease(j: ShippingJournal, releaseId: string, revision: string): AcceptedChange[] {
  const selections = j.recoverySelections ??= {};
  let selection = selections[releaseId];
  if (!selection) {
    const changes = j.changes.filter(c => c.acceptedAt && c.release?.id === releaseId && c.release.revision === revision);
    if (!changes.length) throw new Error("Failed release has no accepted source changes");
    selection = selections[releaseId] = { revision, changeIds: changes.map(c => c.id).reverse(), selectedAt: new Date().toISOString() };
  }
  if (selection.revision !== revision || !selection.changeIds.length || new Set(selection.changeIds).size !== selection.changeIds.length) throw new Error("Invalid frozen failed-release recovery selection");
  return selection.changeIds.map(id => {
    const c = j.changes.find(c => c.id === id && c.acceptedAt && c.release?.id === releaseId && c.release.revision === revision);
    if (!c) throw new Error("Frozen failed-release source identity no longer matches acceptance");
    return c;
  });
}
/** Call only after a trusted negative has been verified. Selection is fsynced before any revert. */
export async function acceptedFailedRelease(repo: string, releaseId: string, revision: string): Promise<AcceptedChange[]> {
  return updateShippingJournal(repo, j => structuredClone(selectAcceptedFailedRelease(j, releaseId, revision)));
}
type Journal = ShippingJournal;
const sha = (s: string) => /^[a-f0-9]{40}$/.test(s);

async function journalPath(repo: string): Promise<string> {
  const p = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  return join(isAbsolute(p) ? p : resolve(repo, p), "vault-chat-shipping", "accepted.json");
}
function read(path: string): Journal {
  if (!existsSync(path)) return { format: 1, changes: [] };
  const j = JSON.parse(readFileSync(path, "utf8")) as Journal;
  if (j.format !== 1 || !Array.isArray(j.changes) || new Set(j.changes.map(c => c.id)).size !== j.changes.length) throw new Error("Invalid service acceptance journal; no release following");
  for (const c of j.changes) if (!c.id || !sha(c.source.base) || !sha(c.source.head) || !sha(c.source.tree)) throw new Error("Invalid accepted source identity");
  return j;
}
/** fsync file + rename + directory: acknowledgment must survive a process/power failure. Caller holds repo lock. */
function save(path: string, j: Journal): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(j, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  // Also persist the private journal directory's link when this is its first creation.
  for (const directory of [dirname(path), dirname(dirname(path))]) {
    const dir = openSync(directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

/** Called ONLY after consuming the live same-process permit, immediately before ff, under the repo mutex.
 * An intent is not an accepted change. A crash before merge leaves it inert; after merge reconciliation
 * checks ancestry without performing another merge or treating journal JSON as authorization. */
export async function prepareAcceptanceLocked(repo: string, change: AcceptedChange): Promise<void> {
  const path = await journalPath(repo), j = read(path);
  const old = j.changes.find(c => c.id === change.id);
  if (old) throw new Error("Acceptance identity already recorded; rerun proof instead of replaying it");
  j.changes.push(structuredClone(change)); save(path, j);
}
export async function reconcileAcceptancesLocked(repo: string): Promise<AcceptedChange[]> {
  const path = await journalPath(repo), j = read(path);
  // Match the actual base branch, never whichever agent branch happens to be checked out.
  let changed = false;
  for (const c of j.changes) {
    if (c.acceptedAt) continue;
    const base = await runGit(repo, ["rev-parse", `refs/heads/${c.review.base}`]);
    if (base.code !== 0) continue;
    if ((await runGit(repo, ["merge-base", "--is-ancestor", c.source.head, base.stdout.trim()])).code !== 0) continue;
    if ((await git(repo, ["rev-parse", `${c.source.head}^{tree}`])).trim() !== c.source.tree) throw new Error("Recorded acceptance tree no longer matches git");
    c.acceptedAt = new Date().toISOString(); changed = true;
  }
  if (changed) save(path, j);
  return structuredClone(j.changes.filter(c => c.acceptedAt));
}
export async function acceptedChanges(repo: string): Promise<AcceptedChange[]> {
  return withRepoLock(repo, () => reconcileAcceptancesLocked(repo));
}

/** Serialize delivery facts with acceptance under the SAME repository mutex and durable file.
 * Never consumes permits or accepts client-written projection files as authority. */
export async function updateShippingJournal<T>(repo: string, fn: (journal: ShippingJournal) => T | Promise<T>): Promise<T> {
  return withRepoLock(repo, async () => {
    await reconcileAcceptancesLocked(repo);
    const path = await journalPath(repo), journal = read(path), before = JSON.stringify(journal);
    const result = await fn(journal);
    if (JSON.stringify(journal) !== before) save(path, journal);
    return result;
  });
}

/** No GitHub credentials, git config URL rewrites, SSH, arbitrary remote hosts or supplied release URLs.
 * Only a normalized public repository identity is allowed; the caller must compare it to origin. */
export function publicGithubRepository(origin: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin.trim());
  if (!m || m.slice(1).some(p => p === "." || p === ".." || p.startsWith("-"))) return null;
  return `${m[1]}/${m[2]}`;
}
async function publicJson(url: string): Promise<any> {
  // Deadline covers headers AND body, with no inherited key/token headers.
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "vault-chat-release-follow" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public release lookup failed (${response.status})`);
  return response.json();
}
// Cache observations on the existing sync cadence, not another poller. Two public requests every few
// seconds would exhaust GitHub's anonymous rate limit and stall otherwise healthy sync.
const releaseLookups = new Map<string, { until: number; result: Promise<PublishedChangeRelease> }>();
export function discoverPublicRelease(repository: string): Promise<PublishedChangeRelease> {
  if (publicGithubRepository(`https://github.com/${repository}`) !== repository) return Promise.reject(new Error("Invalid public GitHub repository"));
  const prior = releaseLookups.get(repository);
  if (prior && prior.until > Date.now()) return prior.result.then(r => structuredClone(r));
  const entry = { until: Date.now() + 5 * 60_000, result: lookupPublicRelease(repository) };
  releaseLookups.set(repository, entry);
  void entry.result.catch(() => { entry.until = Date.now() + 60_000; });
  return entry.result.then(r => structuredClone(r));
}
async function lookupPublicRelease(repository: string): Promise<PublishedChangeRelease> {
  if (publicGithubRepository(`https://github.com/${repository}`) !== repository) throw new Error("Invalid public GitHub repository");
  const api = `https://api.github.com/repos/${repository}`;
  const r = await publicJson(`${api}/releases/latest`);
  if (r.draft || r.prerelease || !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(r.tag_name) || !r.id || !r.published_at) throw new Error("Latest release is not a published stable version");
  // target_commitish may be 'main' or an obsolete SHA: resolve the actual release tag instead.
  const commit = await publicJson(`${api}/commits/${encodeURIComponent(r.tag_name)}`);
  if (!sha(commit.sha)) throw new Error("Public release tag has no exact commit identity");
  // The publisher only declares a release usable after these actual CI assets exist.
  const required = ["latest.json", "server-version.json", "vault-chat-server.mjs", "vault-chat-server.mjs.sha256", "vault-chat-server-assets.tar.gz", "vault-chat-server-assets.tar.gz.sha256", "vault-chat-deploy.tar.gz", "vault-chat-deploy.tar.gz.sha256"];
  if (!Array.isArray(r.assets) || required.some(name => !r.assets.some((a: any) => a.name === name && a.state === "uploaded" && a.size > 0))) throw new Error("Published release is missing its complete CI assets");
  const meta = await publicJson(`https://github.com/${repository}/releases/download/${encodeURIComponent(r.tag_name)}/server-version.json`);
  if (meta.version !== r.tag_name.slice(1) || meta.rev !== commit.sha || ![meta.sha256, meta.assetsSha256, meta.deploySha256].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) throw new Error("Published server metadata does not match the resolved release tag");
  return { id: String(r.id), version: r.tag_name.slice(1), revision: commit.sha, tag: r.tag_name, publishedAt: r.published_at };
}

/** Execute git without a credential helper, host environment, URL rewrite config or caller-selected remote.
 * GitHub's HTTPS endpoint is public. Only a tag from the public release API is fetched, NEVER origin/main. */
async function fetchPublicTag(repo: string, repository: string, release: PublishedChangeRelease): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.keys(process.env).map(k => [k, undefined])), PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: "0" };
  // runGit merges its env, so explicitly clear inherited git config/SSH/askpass variables too.
  for (const key of Object.keys(process.env)) if (/^(GIT_|SSH_)/.test(key)) env[key] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" });
  // --git-dir alone still reads local config. --config-env does not disable URL rewrites, so fetch through
  // a private empty bare repo, then copy the exact object locally. No repository-selected network config.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "vc-release-fetch-"));
  try {
    await git(tmp, ["init", "--bare", "--quiet"], { env });
    await git(tmp, ["-c", "credential.helper=", "-c", "http.extraHeader=", "fetch", "--no-tags", `https://github.com/${repository}.git`, `refs/tags/${release.tag}:refs/tags/release`], { env });
    if ((await git(tmp, ["rev-parse", "refs/tags/release^{commit}"], { env })).trim() !== release.revision) throw new Error("Public release tag moved during fetch");
    const bundle = join(tmp, "release.bundle");
    await git(tmp, ["bundle", "create", bundle, "refs/tags/release"], { env });
    await git(repo, ["bundle", "unbundle", bundle], { env });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Called in the ordinary project sync cycle BEFORE its repo-locked commit/ff sequence. No second timer.
 * Accepted changes opt a repo in; the application also follows already-published CI releases before its
 * first acceptance journal exists. Other legacy Keep projects and non-GitHub projects stay untouched. */
export async function followAcceptedRelease(repo: string, adapters: {
  discover?: typeof discoverPublicRelease;
  fetch?: (repo: string, repository: string, release: PublishedChangeRelease) => Promise<void>;
} = {}): Promise<PublishedChangeRelease | null> {
  const initial = await acceptedChanges(repo);
  const originResult = await runGit(repo, ["config", "--get", "remote.origin.url"]);
  if (originResult.code !== 0) { if (!initial.length) return null; throw new Error("Accepted project has no public origin"); }
  const origin = originResult.stdout.trim();
  const repository = publicGithubRepository(origin);
  if (!repository) { if (!initial.length) return null; throw new Error("Release following requires a normalized public GitHub origin"); }
  // Existing application projects follow already-published CI releases even before the first service acceptance.
  // Other legacy Keep projects are NOT opted into a new release policy.
  if (!initial.length && repository !== "carlwilsn/vault-chat") return null;
  const release = await (adapters.discover ?? discoverPublicRelease)(repository);
  if (!sha(release.revision) || !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag) || release.version !== release.tag.slice(1)) throw new Error("Invalid published release identity");
  const followed = await withRepoLock(repo, async () => {
    const changes = await reconcileAcceptancesLocked(repo);
    if ((await git(repo, ["config", "--get", "remote.origin.url"])).trim() !== origin) throw new Error("Project origin changed during release discovery");
    const path = await journalPath(repo), j = read(path);
    const latest = changes.at(-1);
    const base = latest?.review.base ?? "main";
    if ((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() !== base || (await git(repo, ["status", "--porcelain"])).trim()) throw new Error("Release follow blocked: main must be checked out and clean");
    if (adapters.fetch || (await runGit(repo, ["cat-file", "-e", `${release.revision}^{commit}`])).code !== 0) await (adapters.fetch ?? fetchPublicTag)(repo, repository, release);
    const isAncestor = async (a: string, b: string) => (await runGit(repo, ["merge-base", "--is-ancestor", a, b])).code === 0;
    const included: AcceptedChange[] = [];
    for (const c of changes) if (await isAncestor(c.source.head, release.revision)) included.push(c);
    // An older release not containing any service acceptance is not a deploy of this submission.
    const approved = included.at(-1);
    if (!approved) {
      const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
      if (await isAncestor(release.revision, head)) return false;
      if (!await isAncestor(head, release.revision)) throw new Error("Release follow blocked: project main diverges from the published release; no reset or merge attempted");
      // No local acceptance is being authorized here: this source is ALREADY a public CI release.
      // Require the known publisher's version-only final commit, then ff without manufacturing a merge.
      if (latest) throw new Error("Published release does not descend from latest service acceptance");
      await verifyPublisherCommit(repo, release);
      await git(repo, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--quiet", release.revision]);
      return true;
    }
    // CI may only add its own version bump after accepted source. Check this EVEN IF laptop sync
    // already brought the release commit here, or later accepted main is ahead of the published release.
    const extra = (await git(repo, ["rev-list", `${approved.source.head}..${release.revision}`])).trim().split("\n").filter(Boolean);
    if (extra.length !== 1) throw new Error("Release must contain exactly the CI version bump after accepted source");
    const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", release.revision])).trim().split(" ");
    const subject = (await git(repo, ["show", "-s", "--format=%s", release.revision])).trim();
    const files = (await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", release.revision])).trim().split("\n");
    if (parents.length !== 2 || parents[1] !== approved.source.head || subject !== `v${release.version} [skip ci]` || !files.length || files.some(f => !["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"].includes(f))) throw new Error("Release adds unaccepted source, not the publisher's version-only commit");
    for (const file of files) {
      const before = await git(repo, ["show", `${approved.source.head}:${file}`]);
      const after = await git(repo, ["show", `${release.revision}:${file}`]);
      if (file.endsWith(".json")) {
        const a = JSON.parse(before), b = JSON.parse(after);
        if (b.version !== release.version || typeof a.version !== "string") throw new Error("CI version mismatch");
        b.version = a.version;
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Release changes non-version JSON content");
      } else if (before.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${release.version}"`) !== after) throw new Error("Release changes non-version Cargo content");
    }
    if (JSON.parse(await git(repo, ["show", `${release.revision}:package.json`])).version !== release.version) throw new Error("Release commit version does not match the published tag");
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    if (!await isAncestor(release.revision, head)) {
      if (!await isAncestor(head, release.revision)) throw new Error("Release follow blocked: project main diverges from the published release; no reset or merge attempted");
      if (latest && !await isAncestor(latest.source.head, release.revision)) throw new Error("Published release does not descend from latest service acceptance");
      await git(repo, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--quiet", release.revision]);
    }
    let changed = false;
    for (const c of j.changes) if (c.acceptedAt && !c.release && await isAncestor(c.source.head, release.revision)) { c.release = release; changed = true; }
    if (changed) save(path, j);
    return true;
  });
  return followed ? release : null;
}

async function verifyPublisherCommit(repo: string, release: PublishedChangeRelease): Promise<void> {
  const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", release.revision])).trim().split(" ");
  if (parents.length !== 2 || (await git(repo, ["show", "-s", "--format=%s", release.revision])).trim() !== `v${release.version} [skip ci]`) throw new Error("Published release lacks the CI version commit");
  const files = (await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", release.revision])).trim().split("\n");
  if (!files.length || files.some(f => !["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"].includes(f))) throw new Error("Published release final commit is not version-only");
  for (const f of files) {
    const before = await git(repo, ["show", `${parents[1]}:${f}`]), after = await git(repo, ["show", `${release.revision}:${f}`]);
    if (f.endsWith(".json")) {
      const a = JSON.parse(before), b = JSON.parse(after);
      if (b.version !== release.version || typeof a.version !== "string") throw new Error("CI version mismatch");
      b.version = a.version;
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Release changes non-version JSON content");
    } else if (before.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${release.version}"`) !== after) throw new Error("Release changes non-version Cargo content");
  }
  if (JSON.parse(await git(repo, ["show", `${release.revision}:package.json`])).version !== release.version) throw new Error("CI version mismatch");
}

/** ONE final old-service handoff, not a general importer for historical Keeps. The cue is fixed in
 * installed source so a caller cannot choose a different review/base/branch to import. */
export const LEGACY_BOOTSTRAP = Object.freeze({
  base: "6fcc7f683d32598ba2657918e266e4e25c770547",
  fixtureCommit: "5a83c620305301dba9f33be7b3272a82f8dd71dd",
  branch: "agent/auto-ship",
  proofId: "auto_ship_bootstrap_A_6fcc7f68",
  title: "Automatic delivery A + voice mic fixture repair",
});

/** Import an ALREADY published, user-kept fact. No ref movement, merge, push, permit, transcript
 * writes or tool/client endpoint. installedRevision comes from this running binary's build metadata.
 * Public release verification and the protected native conversation stream are both mandatory. */
export async function importLegacyBootstrap(repo: string, installedRevision: string,
  contexts: { vault: string; slug: string }[],
  discover: typeof discoverPublicRelease = discoverPublicRelease,
  fetch: typeof fetchPublicTag = fetchPublicTag): Promise<AcceptedChange | null> {
  if (!sha(installedRevision)) return null; // unbundled development is not an installed release
  const existing = (await acceptedChanges(repo)).find(c => c.basis === "legacy-bootstrap");
  if (existing) return existing;
  const originResult = await runGit(repo, ["config", "--get", "remote.origin.url"]);
  const origin = originResult.stdout.trim();
  if (originResult.code !== 0 || publicGithubRepository(origin) !== "carlwilsn/vault-chat") return null;
  const release = await discover("carlwilsn/vault-chat");
  if (release.revision !== installedRevision) return null; // not the actual installed published release
  // A can fail before ordinary project sync fetched the CI version commit. Fetch only its verified
  // public tag OBJECTS using the same credential-free transport; no local refs are moved.
  if ((await runGit(repo, ["cat-file", "-e", `${installedRevision}^{commit}`])).code !== 0) await fetch(repo, "carlwilsn/vault-chat", release);
  const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", installedRevision])).trim().split(" ");
  if (parents.length !== 2) return null;
  const head = parents[1]!;
  // Old pre-A binaries/releases cannot be misidentified as this exception.
  if ((await runGit(repo, ["merge-base", "--is-ancestor", LEGACY_BOOTSTRAP.fixtureCommit, head])).code !== 0) return null;
  await verifyPublisherCommit(repo, release);
  const fail = (why: string): never => { throw new Error(`Bootstrap A acceptance needs attention: ${why}; no acceptance imported`); };
  const branch = await runGit(repo, ["rev-parse", `refs/heads/${LEGACY_BOOTSTRAP.branch}`]);
  if (branch.code !== 0 || branch.stdout.trim() !== head) fail("published source does not match the pinned final A branch");
  if ((await runGit(repo, ["merge-base", "--is-ancestor", LEGACY_BOOTSTRAP.base, head])).code !== 0 ||
      (await runGit(repo, ["merge-base", "--is-ancestor", head, "refs/heads/main"])).code !== 0) fail("actual main does not contain the exact bootstrap source");
  const matches: { vault: string; slug: string; convId: string; toolCallId: string; args: Record<string, unknown>; at: number }[] = [];
  for (const { vault, slug } of contexts) {
    const log = logOf(vault);
    for (const row of log.rows().filter(r => r.project === slug)) {
      // Read the framework's protected server stream, NOT agent-written conversation JSON or a
      // review/settled-review cache. Only native pi messages can supply a call and completed result.
      const entries = new Map<string, { message: import("../src/convlog/protocol").PiMessage; at: number }>();
      for (const r of log.eventsOf(row.id)) if (r.type === "entry" && r.entry.type === "message" && r.entry.message && !r.entry.id.startsWith("imp")) {
        const old = entries.get(r.entry.id);
        if (old && JSON.stringify(old.message) !== JSON.stringify(r.entry.message)) fail("ambiguous conversation entry");
        entries.set(r.entry.id, { message: r.entry.message, at: r.at });
      }
      for (const { message, at: callAt } of entries.values()) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const b of message.content) {
          if (b.type !== "toolCall" || hostToolName(b.name ?? "") !== REVIEW_TOOL || b.arguments?.proofId !== LEGACY_BOOTSTRAP.proofId) continue;
          const a = b.arguments as Record<string, unknown>;
          if (!b.id || a.branch !== LEGACY_BOOTSTRAP.branch || a.title !== LEGACY_BOOTSTRAP.title || typeof a.tests !== "string" || !a.tests.trim() || !Array.isArray(a.images) || !a.images.length || a.images.length > 8 || a.images.some(i => typeof i !== "string" || !i)) fail("final handoff cue, checks or UI media are missing");
          const results = [...entries.values()].filter(e => e.message.role === "toolResult" && e.message.toolCallId === b.id && hostToolName(e.message.toolName ?? "") === REVIEW_TOOL);
          if (results.length !== 1) fail("missing or ambiguous completed user Keep receipt");
          const result = results[0]!, m = result.message;
          const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
          const prefix = `Carl answered: ${KEEP}${OUTCOME_SEP}Kept: ${LEGACY_BOOTSTRAP.branch} is in main (fast-forward, now `;
          const short = text.startsWith(prefix) ? /^([a-f0-9]{7,40})\); /.exec(text.slice(prefix.length))?.[1] : undefined;
          if (m.isError || !short || !head.startsWith(short) || !Number.isFinite(result.at) || result.at < callAt || !Number.isFinite(Date.parse(release.publishedAt)) || result.at > Date.parse(release.publishedAt)) fail("completed user Keep does not match the published source");
          // Resolve the actual object, not just a convenient prefix comparison (ambiguous short SHAs fail).
          const resolved = await runGit(repo, ["rev-parse", "--verify", `${short}^{commit}`]);
          if (resolved.code !== 0 || resolved.stdout.trim() !== head) fail("Keep source identity is ambiguous");
          matches.push({ vault, slug, convId: row.id, toolCallId: b.id!, args: a, at: result.at });
        }
      }
    }
  }
  if (matches.length !== 1) fail("missing or ambiguous protected final ReadyForReview/Keep receipt");
  const match = matches[0]!, proofDir = join(match.vault, ".vault-chat", "proof", LEGACY_BOOTSTRAP.proofId);
  const media = (match.args.images as string[]).map((image, i) => {
    const path = join(match.vault, proofImagePath(LEGACY_BOOTSTRAP.proofId, i, image));
    // Check every path component. Synced/model-written symlinks must not expose private host files.
    let dir = resolve(match.vault);
    for (const component of path.slice(join(match.vault).length + 1).split(sep)) {
      dir = join(dir, component);
      if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) fail("retained legacy UI media is missing or unsafe");
    }
    if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(realpathSync(proofDir) + sep) || ![".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"].includes(extname(path).toLowerCase())) fail("retained legacy UI media is invalid");
    return { name: path.slice(proofDir.length + 1), hash: createHash("sha256").update(readFileSync(path)).digest("hex") };
  });
  const at = new Date(match.at).toISOString(), tree = (await git(repo, ["rev-parse", `${head}^{tree}`])).trim();
  const change: AcceptedChange = { id: LEGACY_BOOTSTRAP.proofId, basis: "legacy-bootstrap",
    bootstrap: { proofId: LEGACY_BOOTSTRAP.proofId, toolCallId: match.toolCallId, fixtureCommit: LEGACY_BOOTSTRAP.fixtureCommit, media },
    source: { base: LEGACY_BOOTSTRAP.base, head, tree, branch: LEGACY_BOOTSTRAP.branch },
    review: { convId: match.convId, slug: match.slug, folder: repo, clone: repo, base: "main", branch: LEGACY_BOOTSTRAP.branch, sha: head, title: LEGACY_BOOTSTRAP.title, at, proofId: LEGACY_BOOTSTRAP.proofId, toolCallId: match.toolCallId },
    proofDir, check: { assessment: "Explicit final legacy bootstrap handoff; not a new host proof receipt", evidence: [], surface: "phone", ui: { steps: [] } },
    revertCommits: (await git(repo, ["rev-list", "--topo-order", head, `^${LEGACY_BOOTSTRAP.base}`])).trim().split("\n").filter(rev => rev && rev !== LEGACY_BOOTSTRAP.fixtureCommit),
    preparedAt: at, acceptedAt: at, release };
  return updateShippingJournal(repo, async j => {
    const old = j.changes.find(c => c.basis === "legacy-bootstrap" || c.id === change.id);
    if (old) { if (old.source.head !== head || old.basis !== "legacy-bootstrap") fail("bootstrap identity already conflicts with the journal"); return structuredClone(old); }
    // Recheck host refs under the same lock as the ordinary acceptance journal. This path NEVER moves them.
    if ((await git(repo, ["config", "--get", "remote.origin.url"])).trim() !== origin ||
        (await git(repo, ["rev-parse", `refs/heads/${LEGACY_BOOTSTRAP.branch}`])).trim() !== head ||
        (await runGit(repo, ["merge-base", "--is-ancestor", head, "refs/heads/main"])).code !== 0) fail("source moved during migration");
    j.changes.push(change); return structuredClone(change);
  });
}
