// Agents publish branches; the separately installed box script alone promotes main.
// Legacy review answer decoding does not create presentation or proof artifacts.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git";
import { agentWorkDir } from "./workArea";
import { wallsOf } from "./projectFolders";
import { writeAtomic } from "./atomic";
import { syncedWithoutRemote } from "./master";

// Historical answer compatibility shared with the conversation reducer.
import { KEEP, OUTCOME_SEP, REVIEW_TOOL, SEND_BACK } from "../src/review";
export { KEEP, OUTCOME_SEP, REVIEW_TOOL, SEND_BACK };

const AGENT_NAME = "vault-chat agent";
const AGENT_EMAIL = "agent@vault-chat.local";

/** The project's folder is a git repo of its own (its root holds .git). */
export function isGitProject(folder: string): boolean {
  try {
    // A repo: .git/HEAD, or a .git file (a worktree or a submodule pointing at its git dir).
    return existsSync(join(folder, ".git", "HEAD")) || statSync(join(folder, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Service-owned main applies: a git project, unless it is a project in the vault-chat folder with no remote of
 * its own (synced with the laptop like a vault; the agent writes it directly). */
export function isGatedProject(folder: string): boolean {
  return isGitProject(folder) && !syncedWithoutRemote(folder);
}

/** Where the agent works on a git project: its clone in the vault's work area. */
export function cloneDirOf(vault: string, slug: string): string {
  return join(agentWorkDir(wallsOf(vault).home, vault), "changes", slug);
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await runGit(cwd, args, { timeoutMs });
    return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

/** The project's main branch: the branch its folder has checked out (e.g. main). */
export async function baseBranch(folder: string): Promise<string | null> {
  const r = await git(folder, ["symbolic-ref", "--short", "HEAD"]);
  return r.ok && r.out ? r.out : null;
}

/** The agent's clone of a git project, made the first time (then left as the agent keeps it). */
export async function ensureClone(vault: string, slug: string, folder: string): Promise<{ clone: string; base: string } | { error: string }> {
  const base = await baseBranch(folder);
  if (!base) return { error: `${folder} has no branch checked out` };
  const clone = cloneDirOf(vault, slug);
  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(join(clone, ".."), { recursive: true });
    const r = await git(join(clone, ".."), ["clone", "--quiet", "--branch", base, folder, clone], 300_000);
    if (!r.ok) return { error: `could not clone ${folder}: ${r.err.slice(0, 300)}` };
    await git(clone, ["config", "user.name", AGENT_NAME]);
    await git(clone, ["config", "user.email", AGENT_EMAIL]);
  }
  // Fetch current accepted main from the local project, publish ONLY agent branches through its
  // existing remote. Never make the protected local origin writable just to transport a branch.
  const publish = await git(clone, ["remote", "get-url", "publish"]);
  if (!publish.ok) {
    const remote = await git(folder, ["remote", "get-url", "origin"]);
    if (remote.ok && remote.out) await git(clone, ["remote", "add", "publish", remote.out]);
  }
  return { clone, base };
}

// ---------------------------------------------------------------- the reviews waiting for Carl

export type Review = { convId: string; slug: string; folder: string; clone: string; base: string; branch: string; sha: string; title: string; at: string; proofId?: string; toolCallId?: string };

function reviewsFile(vault: string): string {
  return join(vault, ".vault-chat", "local", "reviews.json");
}

function readReviews(vault: string): Record<string, Review> {
  try {
    const r = JSON.parse(readFileSync(reviewsFile(vault), "utf8"));
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

function writeReviews(vault: string, r: Record<string, Review>): void {
  mkdirSync(join(vault, ".vault-chat", "local"), { recursive: true });
  writeAtomic(reviewsFile(vault), JSON.stringify(r, null, 2) + "\n");
}

/** The change waiting for Carl on this conversation, if any. */
export function pendingReview(vault: string, convId: string): Review | null {
  return readReviews(vault)[convId] ?? null;
}

function settle(vault: string, convId: string): void {
  const r = readReviews(vault);
  if (!r[convId]) return;
  delete r[convId];
  writeReviews(vault, r);
}

/** Compatibility for historical pending cards only: never revive Keep as an acceptance route. */
export async function answerReview(vault: string, r: Review, _answer: string): Promise<{ kept: boolean; text: string }> {
  settle(vault, r.convId);
  return { kept: false, text: "Historical review closed. Publish an agent branch and use the installed box shipping script; main is unchanged." };
}
