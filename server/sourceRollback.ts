/** Specific accepted-change source recovery. This prepares a private service branch; the ONLY path from
 * it to main is the ordinary seven-gate/baseline/real-UI proof and same-process acceptance permit. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, withRepoLock } from "./git";
import { baseBranch } from "./projectChanges";
import { pinChange, type PinnedChange, type SubmitCheck } from "./changeHost";
import type { AcceptedChange } from "./changeShipping";
import { CHANGE_GATES, type ChangeReceipt, type RollbackTestPolicy, type RemovedTestAllowance, type ProofSource } from "./changeProof";

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

export const BOOTSTRAP_BASE = "6fcc7f683d32598ba2657918e266e4e25c770547";
export const BOOTSTRAP_FIXTURE = "5a83c620305301dba9f33be7b3272a82f8dd71dd";
/** Only the host-verified ONE-TIME legacy bootstrap separates its two logical changes. The exact
 * already-approved fixture repair must survive recovery of A; normal accepted changes revert in full. */
export async function sourceRollbackCommits(repo: string, a: AcceptedChange): Promise<string[]> {
  const range = (await git(repo, ["rev-list", "--topo-order", a.source.head, `^${a.source.base}`])).trim().split("\n").filter(Boolean);
  const selected = a;
  if (selected.basis !== "legacy-bootstrap") {
    if (selected.revertCommits) throw new Error("Selective source revert is only valid for the exact host-verified legacy bootstrap");
    return range;
  }
  if (a.source.base !== BOOTSTRAP_BASE || a.source.branch !== "agent/auto-ship" || a.review.branch !== "agent/auto-ship" || a.review.proofId !== "auto_ship_bootstrap_A_6fcc7f68" || a.bootstrap?.proofId !== a.review.proofId || a.bootstrap.fixtureCommit !== BOOTSTRAP_FIXTURE || a.bootstrap.toolCallId !== a.review.toolCallId || !a.bootstrap.toolCallId || !range.includes(BOOTSTRAP_FIXTURE)) throw new Error("Legacy bootstrap recovery identity does not match the approved A + fixture handoff");
  const files = (await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", BOOTSTRAP_FIXTURE])).trim();
  if (files !== "test/harness/voicemic.test.ts") throw new Error("Pinned bootstrap fixture repair has unexpected scope");
  const expected = range.filter(c => c !== BOOTSTRAP_FIXTURE);
  if (!expected.length || JSON.stringify(selected.revertCommits) !== JSON.stringify(expected)) throw new Error("Bootstrap source recovery must revert exactly A while preserving only the exact approved fixture repair");
  return expected;
}

export async function prepareSourceRollback(o: { vault: string; accepted: AcceptedChange; privateRoot: string }): Promise<{ pinned: PinnedChange; rollbackRemovedTests: RollbackTestPolicy; rollbackGateInfrastructure(source: ProofSource): Promise<void>; close(): void }> {
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
      const commits = await sourceRollbackCommits(folder, a);
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
    const expected = structuredClone(pinned.source);
    const key = (t: { file: string; name: string }) => JSON.stringify([t.file.replace(/\\/g, "/"), t.name]);
    const receiptPath = join(a.proofDir, "receipt.json");
    // Ordinary authority is the original private service receipt, never caller-chosen case names.
    // Legacy bootstrap has no such receipt; only its exact historical range was separately verified.
    let receiptBytes: Buffer | undefined, receipt: ChangeReceipt | undefined;
    if (a.basis !== "legacy-bootstrap" && existsSync(receiptPath)) {
      if (!lstatSync(receiptPath).isFile() || lstatSync(receiptPath).isSymbolicLink()) throw new Error("Original recovery receipt must be a private regular file");
      receiptBytes = readFileSync(receiptPath);
      receipt = JSON.parse(receiptBytes.toString()) as ChangeReceipt;
      if (receipt.id !== a.id || JSON.stringify(receipt.source) !== JSON.stringify(a.source)) throw new Error("Original recovery receipt does not match accepted identity");
    }
    const rollbackGateInfrastructure = async (source: ProofSource): Promise<void> => {
      if (JSON.stringify(source) !== JSON.stringify(expected) || (await git(clone, ["rev-parse", "HEAD"])).trim() !== expected.head || (await git(clone, ["rev-parse", "HEAD^{tree}"])).trim() !== expected.tree || (await git(clone, ["status", "--porcelain"])).trim()) throw new Error("Recovery test policy requires the exact service-generated revert");
      if (a.basis !== "legacy-bootstrap" && !receipt) throw new Error("Original private service receipt is required to authorize removed tests");
      if (receiptBytes && !readFileSync(receiptPath).equals(receiptBytes)) throw new Error("Original recovery receipt changed during proof");
    };
    const rollbackRemovedTests: RollbackTestPolicy = async (source, baseline, candidate) => {
      await rollbackGateInfrastructure(source);
      const allowed: RemovedTestAllowance = {};
      for (const gate of CHANGE_GATES) {
        if (gate !== "test:harness" && gate !== "test:server") continue;
        const before = baseline.find(r => r.gate === gate), after = candidate.find(r => r.gate === gate);
        if (!before?.complete || !after?.complete || !before.tests || !after.tests) throw new Error("Recovery requires complete current test receipts");
        const present = new Set(after.tests.map(key));
        let introduced: Set<string> | undefined;
        if (receipt) {
          const originalBase = receipt.baseline.find(r => r.gate === gate), originalHead = receipt.candidate.find(r => r.gate === gate);
          if (!originalBase?.complete || !originalHead?.complete || !originalBase.tests || !originalHead.tests || originalBase.source !== a.source.base || originalHead.source !== a.source.head) throw new Error("Original recovery test receipts are incomplete or mismatched");
          const prior = new Set(originalBase.tests.map(key));
          introduced = new Set(originalHead.tests.filter(t => !prior.has(key(t))).map(key));
        }
        // Exact bootstrap reversal is already source-attested and preserves the pinned mic fixture.
        // No generic missing-test exemption reaches ordinary submissions or later unrelated edits.
        allowed[gate] = before.tests.filter(t => !present.has(key(t)) && (!introduced || introduced.has(key(t)))).map(t => ({ file: t.file, name: t.name }));
      }
      return allowed;
    };
    return { pinned, rollbackRemovedTests, rollbackGateInfrastructure, close };
  } catch (e) { close(); throw e; }
}
