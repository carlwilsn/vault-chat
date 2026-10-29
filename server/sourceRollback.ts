/** Specific accepted-change source recovery. This prepares a private service branch; the ONLY path from
 * it to main is the ordinary seven-gate/baseline/real-UI proof and same-process acceptance permit. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, withRepoLock } from "./git";
import { baseBranch } from "./projectChanges";
import { pinChange, type PinnedChange, type SubmitCheck } from "./changeHost";
import type { AcceptedChange } from "./changeShipping";

/** Host-owned recovery smoke, deliberately not agent-dependent and not a replay of UI a revert removes.
 * Source recovery is established by git revert of the accepted range; this proves usable real pre-change
 * app input/persistence through the actual server. It does not claim the removed feature still exists. */
export const ROLLBACK_CHECK: SubmitCheck = {
  assessment: "Service recovery: revert only the recorded accepted range, preserve unrelated later commits, then verify the recovered real app's Notes save flow.",
  evidence: ["Service-owned git revert --no-commit of accepted base..head", "Full pinned baseline/candidate gates and actual recovered candidate Notes persistence recording"],
  surface: "phone",
  ui: { mobile: true, steps: [
    { waitFor: "#menuBtn" }, { click: "#menuBtn" }, { click: '[data-page="notes"]' }, { waitFor: "#noteInput" },
    { type: "Source recovery checked by the installed host", into: "#noteInput" }, { click: "#noteAddBtn" },
    { waitFor: { text: "Source recovery checked by the installed host" } },
  ] },
};

export async function prepareSourceRollback(o: { vault: string; accepted: AcceptedChange; privateRoot: string }): Promise<{ pinned: PinnedChange; close(): void }> {
  const a = o.accepted, folder = a.review.folder;
  if (!a.acceptedAt || a.rollbackOf) throw new Error("Only an accepted original change can be rolled back; a revert release needs attention, never another automatic revert");
  mkdirSync(o.privateRoot, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(o.privateRoot, "source-revert-"));
  const branch = `agent/rollback-${createHash("sha256").update(a.id).digest("hex").slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const clone = join(work, "repo");
  const close = () => rmSync(work, { recursive: true, force: true });
  try {
    await withRepoLock(folder, async () => {
      const base = await baseBranch(folder);
      if (!base || base !== a.review.base || (await git(folder, ["status", "--porcelain"])).trim()) throw new Error("Source recovery blocked: project main must be clean and checked out; no files were changed");
      await git(folder, ["merge-base", "--is-ancestor", a.source.head, "HEAD"]);
      if ((await git(folder, ["rev-parse", `${a.source.head}^{tree}`])).trim() !== a.source.tree) throw new Error("Accepted change tree does not match its recorded identity");
      const commits = (await git(folder, ["rev-list", "--topo-order", a.source.head, `^${a.source.base}`])).trim().split("\n").filter(Boolean);
      if (!commits.length) throw new Error("Accepted range has no commits to revert");
      // No guessed merge mainline: ambiguous recovery must surface a conflict, not revert unrelated work.
      for (const rev of commits) if ((await git(folder, ["rev-list", "--parents", "-n", "1", rev])).trim().split(" ").length !== 2) throw new Error("Accepted range contains a merge/root commit; source recovery needs attention (no force/reset)");
      await git(work, ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-local", "--no-hardlinks", "--no-checkout", folder, clone]);
      await git(clone, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "-b", branch, (await git(folder, ["rev-parse", "HEAD"])).trim()]);
      // Configuring ONLY the service clone cannot touch the user's repo or agent branch.
      await git(clone, ["config", "core.hooksPath", "/dev/null"]);
      try { await git(clone, ["revert", "--no-commit", ...commits]); }
      catch { throw new Error("Specific-change source revert conflicts with later work; main and unrelated edits are unchanged. Needs attention, never force/reset."); }
      if (!(await git(clone, ["diff", "--cached", "--name-only"])).trim()) throw new Error("Specific source change is already absent; no empty revert was accepted");
      await git(clone, ["-c", "user.name=vault-chat-agent", "-c", "user.email=agent@vault-chat.local", "commit", "--quiet", "-m", `[agent] Roll back ${a.id}: ${a.review.title}`]);
    });
    const pinned = await pinChange({ vault: o.vault, convId: a.review.convId, slug: a.review.slug, folder, clone, title: `Roll back: ${a.review.title}` });
    return { pinned, close };
  } catch (e) { close(); throw e; }
}
