/** Durable service acceptance/release journal. This records facts, NEVER authorization: restart cannot
 * reconstruct a proof permit. Stored in git's private directory, outside the synced working tree. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { git, runGit, withRepoLock } from "./git";
import type { ChangeReceipt } from "./changeProof";
import type { Review } from "./projectChanges";

export type PublishedChangeRelease = { id: string; version: string; revision: string; tag: string; publishedAt: string };
export type AcceptedChange = {
  id: string; source: ChangeReceipt["source"]; review: Review; proofDir: string;
  /** Retain the recorder request with the receipt; these steps are NOT evidence in themselves. */
  check: import("./changeHost").SubmitCheck;
  preparedAt: string; acceptedAt?: string; release?: PublishedChangeRelease; rollbackOf?: string;
};
export type ShippingJournal = { format: 1; changes: AcceptedChange[]; delivery?: import("./changeDelivery").DeliveryState };
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
