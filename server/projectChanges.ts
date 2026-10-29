// "You keep it": the gate on a project that is a git repo (Carl, 2026-10-27). The agent never changes the
// project's main branch. It works in a clone of the project in its work area (~/agent-work/<vault>/changes/
// <slug>), on a branch agent/<short-name>; the project's own folder is read-only to it (the sandbox binds it
// so). When a change is ready it calls ReadyForReview: the branch is fetched into the project's repo (beside
// main, never into it) and a proof card goes to the project's thread — what changed, why, the test results,
// the screenshots — with two actions, Keep and Send back, on the laptop and the phone (the AskUser card).
// Keep is the server's, never the agent's: the branch merged into the project's main branch (fast-forward,
// else a merge commit) and pushed when the repo has a remote that takes it. Send back: Carl's note goes to the
// agent, which goes on with the same branch. Nothing reaches main without Keep.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { runGit } from "./git";
import { agentWorkDir } from "./workArea";
import { wallsOf } from "./projectFolders";
import { writeAtomic } from "./atomic";
import { masterProjectOf, syncedWithoutRemote, triggerProjectAt } from "./master";
import { withRepoLock } from "./git";
import type { ChangePermit, ChangeProofService } from "./changeProof";

// The card's names and its images' place in the vault: one definition for the box, the laptop and the phone.
import { KEEP, OUTCOME_SEP, REVIEW_TOOL, SEND_BACK, proofImagePath } from "../src/review";
export { KEEP, OUTCOME_SEP, REVIEW_TOOL, SEND_BACK, proofImagePath };

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

/** The "you keep it" gate applies: a git project, unless it is a project in the vault-chat folder with no remote of
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

/** "Bigger tap targets on the phone" → "bigger-tap-targets-on-the-phone" (≤ 40). */
export function shortName(s: string): string {
  return (
    s
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "change"
  );
}


const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm"]);

export type ReadyArgs = { proofId?: unknown; title?: unknown; branch?: unknown; what?: unknown; why?: unknown; tests?: unknown; images?: unknown };

/**
 * ReadyForReview, before Carl sees it: the change committed on agent/<name> in the clone, ahead of main;
 * the branch fetched into the project's repo beside main; the proof images copied into the vault. Returns
 * the review, or what the agent must do first.
 */
export async function prepareReview(o: { vault: string; convId: string; slug: string; folder: string; args: ReadyArgs }): Promise<{ review: Review; images: string[]; stat: string } | { error: string }> {
  const { vault, slug, folder } = o;
  // Explicit artifact identity, never an MCP request id or model tool-call id.
  const proofId = typeof o.args.proofId === "string" ? o.args.proofId : "";
  if (!/^[A-Za-z0-9_-]{16,60}$/.test(proofId)) return { error: "ReadyForReview needs a fresh proofId (16–60 letters, digits, _ or -)." };
  const title = String(o.args.title ?? "").trim().slice(0, 120);
  if (!title) return { error: "ReadyForReview needs title: the change in a few words." };
  const c = await ensureClone(vault, slug, folder);
  if ("error" in c) return c;
  const { clone, base } = c;
  const dirty = await git(clone, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.out) return { error: `Uncommitted changes in ${clone}: commit them on your agent/ branch first (git add -A && git commit -m "…"), then call ReadyForReview again.` };
  await git(clone, ["fetch", "--quiet", "origin"]);
  let branch = (await git(clone, ["symbolic-ref", "--short", "HEAD"])).out;
  const ahead = Number((await git(clone, ["rev-list", "--count", `origin/${base}..HEAD`])).out || "0");
  if (!ahead) return { error: `Nothing to keep: ${branch || "HEAD"} has no commits beyond ${base}. Commit the change on a branch agent/<short-name> first.` };
  if (!branch.startsWith("agent/")) {
    // Committed on main (or elsewhere) in the clone: the work moves to agent/<name>; the clone's main goes back to the project's.
    const want = typeof o.args.branch === "string" && /^agent\/[a-z0-9][a-z0-9._/-]{0,60}$/.test(o.args.branch) ? o.args.branch : `agent/${shortName(title)}`;
    const sw = await git(clone, ["switch", "-C", want]);
    if (!sw.ok) return { error: `could not make ${want}: ${sw.err.slice(0, 200)}` };
    if (branch === base) await git(clone, ["branch", "-f", base, `origin/${base}`]);
    branch = want;
  }
  const sha = (await git(clone, ["rev-parse", "HEAD"])).out;
  // Beside main in the project's repo (the server's write; the agent's sandbox can't): Carl sees the branch there.
  const f = await git(folder, ["fetch", "--quiet", clone, `+${branch}:${branch}`]);
  if (!f.ok) return { error: `could not hand ${branch} to the project's repo: ${f.err.slice(0, 300)}` };
  const stat = (await git(clone, ["diff", "--stat", `origin/${base}...HEAD`])).out.split("\n").slice(-12).join("\n");
  // The proof: images copied into the vault where the card shows them (laptop and phone).
  const images: string[] = [];
  const dir = join(vault, ".vault-chat", "proof", proofId);
  mkdirSync(join(dir, ".."), { recursive: true });
  try { mkdirSync(dir); } catch { return { error: "proofId already used; choose a fresh ID. Existing proof was not changed." }; }
  const list = Array.isArray(o.args.images) ? o.args.images.map(String).filter(Boolean).slice(0, 8) : [];
  for (let i = 0; i < list.length; i++) {
    const src = isAbsolute(list[i]!) ? list[i]! : resolve(clone, list[i]!);
    try {
      if (!statSync(src).isFile() || !IMAGE_EXT.has(extname(src).toLowerCase())) return { error: `images: ${list[i]} is not an image or video file` };
    } catch {
      return { error: `images: ${list[i]} does not exist` };
    }
    const rel = proofImagePath(proofId, i, src);
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    copyFileSync(src, join(vault, rel));
    images.push(rel);
  }
  const review: Review = { convId: o.convId, slug, folder, clone, base, branch, sha, title, at: new Date().toISOString(), proofId };
  const all = readReviews(vault);
  all[o.convId] = review;
  writeReviews(vault, all);
  return { review, images, stat };
}

/** The proof card's question (its markdown): the same text the chat's view makes from the call (src/convlog/view.ts). */
export function proofQuestion(r: { title: string; branch: string; base: string }, stat: string): string {
  return `Ready to keep: ${r.title} (${r.branch} → ${r.base})${stat ? `\n\n${stat}` : ""}`;
}

/**
 * Keep: the branch into the project's main branch (fast-forward, else a merge commit), then a push when the
 * repo has a remote. A merge that can't be made cleanly is undone and said; main is then as it was.
 */
export async function keepReview(vault: string, r: Review): Promise<{ ok: boolean; text: string }> {
  // Under the folder's repo lock: a project in the vault-chat folder is also committed and pushed by its sync.
  const out = await withRepoLock(r.folder, () => keepLocked(vault, r));
  // Its sync takes the kept change to the hub now; the laptop's sync brings it to the laptop (and to its remote).
  if (out.ok) triggerProjectAt(r.folder);
  return out;
}

async function keepLocked(vault: string, r: Review): Promise<{ ok: boolean; text: string }> {
  const { folder, base, branch } = r;
  const head = await baseBranch(folder);
  const tip = (await git(folder, ["rev-parse", branch])).out;
  if (!tip) return { ok: false, text: `Couldn't keep it: ${branch} is not in ${folder} any more.` };
  let how = "";
  if (head === base) {
    // Main is checked out: merge there (the working tree follows; Carl's uncommitted edits block a merge that touches them).
    const ff = await git(folder, ["merge", "--ff-only", "--quiet", branch]);
    if (ff.ok) how = "fast-forward";
    else {
      const m = await git(folder, ["-c", `user.name=${AGENT_NAME}`, "-c", `user.email=${AGENT_EMAIL}`, "merge", "--no-ff", "--no-edit", "-m", `Keep ${branch}: ${r.title}`, branch]);
      if (!m.ok) {
        await git(folder, ["merge", "--abort"]);
        return { ok: false, text: `Couldn't keep it: ${branch} doesn't merge cleanly into ${base} (${m.err.split("\n")[0]?.slice(0, 200)}). ${base} is unchanged. Bring ${branch} up to date with ${base} and hand it over again.` };
      }
      how = "merge commit";
    }
  } else {
    // Another branch checked out: main moves only by a fast-forward (its working tree is not on main).
    const ff = await git(folder, ["fetch", "--quiet", ".", `${branch}:${base}`]);
    if (!ff.ok) return { ok: false, text: `Couldn't keep it: ${folder} has ${head ?? "no branch"} checked out and ${branch} is not a fast-forward of ${base}. ${base} is unchanged.` };
    how = "fast-forward";
  }
  const sha = (await git(folder, ["rev-parse", "--short", base])).out;
  // Pushed when the repo has a remote and the credentials on the box take it.
  let push = "not pushed (no remote)";
  const remote = (await git(folder, ["config", "--get", `branch.${base}.remote`])).out || ((await git(folder, ["remote"])).out.split("\n").includes("origin") ? "origin" : "");
  if (remote) {
    const p = await git(folder, ["push", "--quiet", remote, `${base}:${base}`], 120_000);
    push = p.ok ? `pushed to ${remote}` : `not pushed: ${p.err.split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "the push failed"}`;
    // A project in the vault-chat folder: the laptop, which has the credentials, pushes it after its sync pulls it.
    if (!p.ok && masterProjectOf(folder)) push = `not pushed from the box (no credentials here); the laptop's sync pushes ${base} to ${remote} once it has it`;
  }
  settle(vault, r.convId);
  // The clone back on main for the next change.
  await git(r.clone, ["fetch", "--quiet", "origin"]);
  await git(r.clone, ["switch", "-C", base, `origin/${base}`]);
  return { ok: true, text: `Kept: ${branch} is in ${base} (${how}, now ${sha}); ${push}. Your clone is back on ${base}; start the next change on a new agent/<name> branch.` };
}

/** Auto-ship foundation: same service repo lock as Keep/sync, but ONLY a host-run proof permit authorizes
 * acceptance. No model summary, user answer, disk JSON or naked SHA can replace that permit. This is not yet
 * a tool/route: the installed runner, release-health and rollback adapters must be connected before activation.
 * Never push here: only laptop sync is allowed to push the accepted main to GitHub.
 */
export async function acceptProvenReview(vault: string, r: Review, proof: ChangeProofService, permit: ChangePermit, assertRequest?: () => Promise<void>): Promise<{ ok: boolean; text: string }> {
  const out = await withRepoLock(r.folder, async () => {
    const current = await baseBranch(r.folder);
    if (current !== r.base) return { ok: false, text: "Acceptance blocked: the project's base branch is not checked out." };
    const dirty = await git(r.folder, ["status", "--porcelain"]);
    if (!dirty.ok || dirty.out) return { ok: false, text: "Acceptance blocked: the project has local edits; no files were changed." };
    const base = await git(r.folder, ["rev-parse", r.base]);
    const tip = await git(r.folder, ["rev-parse", r.branch]);
    const tree = await git(r.folder, ["rev-parse", `${r.sha}^{tree}`]);
    if (!base.ok || !tip.ok || !tree.ok || tip.out !== r.sha) return { ok: false, text: "Acceptance blocked: candidate branch moved; rerun proof." };
    const ancestor = await git(r.folder, ["merge-base", "--is-ancestor", base.out, r.sha]);
    if (!ancestor.ok) return { ok: false, text: "Acceptance blocked: candidate is not based on current main; update it and rerun proof." };
    try {
      await proof.consume(permit, { base: base.out, head: r.sha, tree: tree.out, branch: r.branch });
      // A long-running job may outlive a turn or a new user request. Check the captured ask/cancellation
      // under this same acceptance lock AFTER artifact decoding, immediately before the ff transaction.
      await assertRequest?.();
    } catch (e) { return { ok: false, text: `Acceptance blocked: ${e instanceof Error ? e.message : String(e)}` }; }
    // Fast-forward only: a new merge commit would have an unproved tree/source identity.
    const merged = await git(r.folder, ["merge", "--ff-only", "--quiet", r.sha]);
    if (!merged.ok) return { ok: false, text: `Acceptance blocked: ${merged.err.slice(0, 200)}. Rerun proof before retrying.` };
    settle(vault, r.convId);
    // Leave the agent clone alone: another actor may already be working there.
    return { ok: true, text: `Accepted: ${r.title} (${r.sha}). Laptop sync must push it; release and device health are still pending. This is not yet Shipped.` };
  });
  if (out.ok) triggerProjectAt(r.folder);
  return out;
}

/** Send back: his note to the agent; the branch stays as it is. */
export function sendBack(vault: string, r: Review, note: string): string {
  settle(vault, r.convId);
  const n = note.trim() && note.trim().toLowerCase() !== SEND_BACK.toLowerCase() ? note.trim().replace(/[.!?]+$/, "") : "";
  return `Sent back${n ? `: ${n}` : " (no note: ask him what to change)"}. ${r.base} is unchanged. Go on with ${r.branch} in your clone and hand it over again with ReadyForReview.`;
}

/** Carl's answer to a proof card → what the server did (Keep: the merge; anything else: sent back with it as the note). */
export async function answerReview(vault: string, r: Review, answer: string): Promise<{ kept: boolean; text: string }> {
  if (/^\s*keep\b/i.test(answer)) {
    const k = await keepReview(vault, r);
    return { kept: k.ok, text: k.text };
  }
  return { kept: false, text: sendBack(vault, r, answer) };
}
