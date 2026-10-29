import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChanges, discoverPublicRelease, followAcceptedRelease, prepareAcceptanceLocked, publicGithubRepository, reconcileAcceptancesLocked, type AcceptedChange, type PublishedChangeRelease } from "../changeShipping";
import { withRepoLock } from "../git";
import { BoxSync } from "../sync";
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "vc-shipping-")); roots.push(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8" }).trim();
  g("init", "--quiet", "-b", "main");
  g("remote", "add", "origin", "git@github.com:carlwilsn/vault-chat.git");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "0.7.18", scripts: { test: "safe" } }));
  writeFileSync(join(repo, "app.txt"), "before"); g("add", "."); g("commit", "--quiet", "-m", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "--quiet", "-c", "agent/change");
  writeFileSync(join(repo, "app.txt"), "after"); g("add", "."); g("commit", "--quiet", "-m", "candidate");
  const head = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}"); g("switch", "--quiet", "main");
  writeFileSync(join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\nif test "$1" = origin; then touch '${join(repo, "push-attempt")}'; exit 1; fi\n`, { mode: 0o755 });
  const c: AcceptedChange = { id: "host-receipt", source: { base, head, tree, branch: "agent/change" }, review: { convId: "project-repo", slug: "repo", folder: repo, clone: "/never-touch-clone", base: "main", branch: "agent/change", sha: head, title: "Actual change", at: new Date().toISOString() }, proofDir: "/private/proof", check: { assessment: "Agent self-check", evidence: ["app.txt"], surface: "phone", ui: { steps: [{ click: "button" }, { waitFor: "main" }] } }, preparedAt: new Date().toISOString() };
  const prepare = () => withRepoLock(repo, () => prepareAcceptanceLocked(repo, c));
  const accept = async () => { await prepare(); g("merge", "--ff-only", "--quiet", head); return acceptedChanges(repo); };
  function publish(edit?: () => void, skip = true): PublishedChangeRelease {
    g("switch", "--quiet", "--detach", head);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "0.7.19", scripts: { test: "safe" } })); edit?.();
    g("add", "."); g("commit", "--quiet", "-m", skip ? "v0.7.19 [skip ci]" : "arbitrary version change");
    const revision = g("rev-parse", "HEAD"); g("switch", "--quiet", "main");
    return { id: "release-19", tag: "v0.7.19", version: "0.7.19", revision, publishedAt: new Date().toISOString() };
  }
  const follow = (release: PublishedChangeRelease) => followAcceptedRelease(repo, { discover: async repository => { expect(repository).toBe("carlwilsn/vault-chat"); return release; }, fetch: async (_repo, repository, r) => { expect(repository).toBe("carlwilsn/vault-chat"); expect(r).toEqual(release); } });
  return { repo, g, c, base, head, prepare, accept, publish, follow };
}

describe("durable service acceptance facts, not persisted authority", () => {
  it("persists intent before ff; a pre-merge crash is inert and cannot move main", async () => {
    const f = fixture(); await f.prepare();
    expect(await acceptedChanges(f.repo)).toEqual([]);
    expect(f.g("rev-parse", "main")).toBe(f.base);
    await expect(f.prepare()).rejects.toThrow("already recorded");
    expect(f.g("rev-parse", "main")).toBe(f.base);
  });
  it("reconciles a post-ff crash from journal + actual main ancestry without merging or pushing again", async () => {
    const f = fixture(); await f.prepare(); f.g("merge", "--ff-only", "--quiet", f.head);
    const before = readFileSync(join(f.repo, ".git", "vault-chat-shipping", "accepted.json"), "utf8");
    expect(JSON.parse(before).changes[0].acceptedAt).toBeUndefined();
    const [c] = await acceptedChanges(f.repo);
    expect(c).toMatchObject({ id: f.c.id, source: f.c.source, acceptedAt: expect.any(String) });
    expect(await acceptedChanges(f.repo)).toEqual([c]);
    expect(f.g("status", "--porcelain")).toBe("");
    expect(existsSync(join(f.repo, "push-attempt"))).toBe(false);
  });
  it("does not mistake an agent branch checkout for accepted main", async () => {
    const f = fixture(); await f.prepare(); f.g("switch", "--quiet", "agent/change");
    expect(await acceptedChanges(f.repo)).toEqual([]);
  });
  it("fails closed on corrupt journal, rather than forgetting recorded acceptance", async () => {
    const f = fixture(); await f.accept();
    writeFileSync(join(f.repo, ".git", "vault-chat-shipping", "accepted.json"), "broken");
    await expect(acceptedChanges(f.repo)).rejects.toThrow();
  });
});

describe("actual published release commits follow accepted source, ff-only", () => {
  it("does nothing to old Keep repos without a service acceptance; no network lookup", async () => {
    const f = fixture(), discover = vi.fn();
    expect(await followAcceptedRelease(f.repo, { discover })).toBeNull(); expect(discover).not.toHaveBeenCalled();
  });
  it("follows only the public release version commit, records identity, and never pushes origin", async () => {
    const f = fixture(); await f.accept(); const r = f.publish();
    await f.follow(r);
    expect(f.g("rev-parse", "main")).toBe(r.revision);
    expect((await acceptedChanges(f.repo))[0].release).toEqual(r);
    await f.follow(r); expect((await acceptedChanges(f.repo))).toHaveLength(1);
    expect(existsSync(join(f.repo, "push-attempt"))).toBe(false);
  });
  it("keeps an older release pending instead of calling this change published", async () => {
    const f = fixture(); await f.accept();
    expect(await f.follow({ id: "older", version: "0.7.18", tag: "v0.7.18", revision: f.base, publishedAt: new Date().toISOString() })).toBeNull();
    expect((await acceptedChanges(f.repo))[0].release).toBeUndefined(); expect(f.g("rev-parse", "HEAD")).toBe(f.head);
  });
  it("rejects source edits hidden inside the version-only filename allowlist", async () => {
    const f = fixture(); await f.accept(); const r = f.publish(() => writeFileSync(join(f.repo, "package.json"), JSON.stringify({ version: "0.7.19", scripts: { test: "unapproved" } })));
    await expect(f.follow(r)).rejects.toThrow("non-version JSON");
    expect(f.g("rev-parse", "main")).toBe(f.head); expect((await acceptedChanges(f.repo))[0].release).toBeUndefined();
  });
  it("validates the release even if laptop sync already brought it to main", async () => {
    const f = fixture(); await f.accept(); const r = f.publish(() => writeFileSync(join(f.repo, "app.txt"), "unapproved"));
    f.g("merge", "--ff-only", "--quiet", r.revision);
    await expect(f.follow(r)).rejects.toThrow("unaccepted source");
    expect((await acceptedChanges(f.repo))[0].release).toBeUndefined();
  });
  it("refuses divergent local work without force/reset/merge", async () => {
    const f = fixture(); await f.accept(); const r = f.publish();
    writeFileSync(join(f.repo, "later.txt"), "preserve me"); f.g("add", "."); f.g("commit", "--quiet", "-m", "later local work");
    const before = f.g("rev-parse", "HEAD");
    await expect(f.follow(r)).rejects.toThrow("diverges");
    expect(f.g("rev-parse", "HEAD")).toBe(before); expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("preserve me");
  });
  it("does not overwrite dirty data or switch an actor's checked-out branch", async () => {
    const f = fixture(); await f.accept(); const r = f.publish();
    writeFileSync(join(f.repo, "app.txt"), "Carl's uncommitted edit");
    await expect(f.follow(r)).rejects.toThrow("clean");
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("Carl's uncommitted edit");
    f.g("restore", "app.txt"); f.g("switch", "--quiet", "agent/change");
    await expect(f.follow(r)).rejects.toThrow("checked out"); expect(f.g("branch", "--show-current")).toBe("agent/change");
  });
  it("does not use origin/main or accept a release with arbitrary source preceding a bump", async () => {
    const f = fixture(); await f.accept();
    const r = f.publish(() => writeFileSync(join(f.repo, "unapproved.txt"), "bad"));
    await expect(f.follow(r)).rejects.toThrow("unaccepted source");
    expect(f.g("rev-parse", "HEAD")).toBe(f.head);
  });
  it("requires publisher subject and matching package version", async () => {
    const f = fixture(); await f.accept(); const r = f.publish(undefined, false);
    await expect(f.follow(r)).rejects.toThrow("publisher");
  });
  it("keeps earlier publication mappings stable while a later accepted change awaits CI", async () => {
    const f = fixture(); await f.accept(); const r = f.publish(); await f.follow(r);
    f.g("switch", "--quiet", "-c", "agent/later"); writeFileSync(join(f.repo, "later.txt"), "next change"); f.g("add", "."); f.g("commit", "--quiet", "-m", "next accepted");
    const head = f.g("rev-parse", "HEAD"), tree = f.g("rev-parse", "HEAD^{tree}");
    f.g("switch", "--quiet", "main");
    await withRepoLock(f.repo, () => prepareAcceptanceLocked(f.repo, { ...f.c, id: "later-proof", source: { base: r.revision, head, tree, branch: "agent/later" }, review: { ...f.c.review, branch: "agent/later", sha: head } }));
    f.g("merge", "--ff-only", "--quiet", head); await f.follow(r);
    expect(f.g("rev-parse", "HEAD")).toBe(head);
    expect((await acceptedChanges(f.repo)).map(c => c.release?.id)).toEqual([r.id, undefined]);
  });
  it("uses the ordinary hub sync cycle and still transports accepted main when release lookup is offline", async () => {
    const f = fixture(); await f.accept(); const bare = join(f.repo, "..", `${f.repo.split("/").at(-1)}-hub.git`); roots.push(bare); mkdirSync(bare);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main"], { cwd: bare });
    const hook = vi.fn(async () => { await withRepoLock(f.repo, () => reconcileAcceptancesLocked(f.repo)); throw new Error("Public GitHub offline; release pending"); });
    const sync = new BoxSync(f.repo, bare, 60_000, async () => 0, 60_000, { local: "main", hub: "main" }, hook);
    try {
      await sync.ensure(false); await sync.runOnce();
      expect(hook).toHaveBeenCalledOnce(); expect(sync.status.ok).toBe(false); expect(sync.status.lastError).toContain("release pending");
      expect(execFileSync("git", ["rev-parse", "box"], { cwd: bare, encoding: "utf8" }).trim()).toBe(f.head);
    } finally { sync.stop(); }
  });
});

describe("public GitHub release provenance", () => {
  it.each(["https://github.com/carlwilsn/vault-chat.git", "git@github.com:carlwilsn/vault-chat.git", "ssh://git@github.com/carlwilsn/vault-chat.git"])("normalizes the existing origin form %s", origin => {
    expect(publicGithubRepository(origin)).toBe("carlwilsn/vault-chat");
  });
  it.each(["https://token@github.com/a/b", "https://github.com.evil/a/b", "https://github.com/a/b?secret=x", "https://github.com/a/../b", "file:///a/b", "https://github.com/-a/b"])("rejects credential-bearing/non-public/un-normalized origin %s", origin => {
    expect(publicGithubRepository(origin)).toBeNull();
  });
  it("refuses a published release missing the CI assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/releases/latest") ? { id: 19, tag_name: "v0.7.19", published_at: "2026-10-29T00:00:00Z", assets: [] } : { sha: "a".repeat(40) })));
    await expect(discoverPublicRelease("asset-check/repo")).rejects.toThrow("complete CI assets");
  });
  it("rejects drafts and does not resolve an unpublished tag", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 19, tag_name: "v0.7.19", draft: true, published_at: "2026-10-29T00:00:00Z" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverPublicRelease("draft-check/repo")).rejects.toThrow("published stable");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses public latest-release AND resolved tag, not target_commitish/main; requires complete assets", async () => {
    const names = ["latest.json", "server-version.json", "vault-chat-server.mjs", "vault-chat-server.mjs.sha256", "vault-chat-server-assets.tar.gz", "vault-chat-server-assets.tar.gz.sha256", "vault-chat-deploy.tar.gz", "vault-chat-deploy.tar.gz.sha256"];
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/releases/latest") ? { id: 19, tag_name: "v0.7.19", target_commitish: "main", published_at: "2026-10-29T00:00:00Z", assets: names.map(name => ({ name, state: "uploaded", size: 1 })) } : url.endsWith("/server-version.json") ? { version: "0.7.19", rev: "a".repeat(40), sha256: "b".repeat(64), assetsSha256: "c".repeat(64), deploySha256: "d".repeat(64) } : { sha: "a".repeat(40) })); vi.stubGlobal("fetch", fetcher);
    expect(await discoverPublicRelease("carlwilsn/vault-chat")).toMatchObject({ version: "0.7.19", revision: "a".repeat(40) });
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["https://api.github.com/repos/carlwilsn/vault-chat/releases/latest", "https://api.github.com/repos/carlwilsn/vault-chat/commits/v0.7.19", "https://github.com/carlwilsn/vault-chat/releases/download/v0.7.19/server-version.json"]);
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) expect(call[1].headers).not.toHaveProperty("Authorization");
    const first = await discoverPublicRelease("carlwilsn/vault-chat"); first.version = "mutated";
    expect((await discoverPublicRelease("carlwilsn/vault-chat")).version).toBe("0.7.19");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
