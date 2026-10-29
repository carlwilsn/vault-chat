# Agent behaviour, prompts and decisions

## The story to fix against (Carl, 2026-07-13)
He asked for the app's story before any more fixes, because fixes built from isolated bug reports kept failing. His
attention is the scarce resource; the app spends it only on real judgment. Four truths:
1. **You direct; it runs itself.** Work keeps going whether or not he looks. Closing a view or backgrounding the app
   never pauses anything.
2. **It surfaces only at real forks, each fork ONE honest object.** One decision = one object with a clear start and
   end that shows wherever he'll see it. Two cards for one decision, a wait with no card, or a stranded wait break this.
3. **The surface never lies about its own state.** Muted means no motion; working says working; a dead card doesn't
   look tappable. (A supervisor once "waited for his confirmation" with no card anywhere: "I don't have a notification
   asking me to confirm." Never park on an invisible wait — he is never the unstick mechanism.)
4. **Reality is on the record.** What the machine did and what he saw/tapped are logged, so a broken moment is
   replayed, not re-described.

*Apply:* never add a second surface for something that has one, or a second owner for a signal. Decision cards need
a stakeholder: the plain assistant asks in prose; he types.

## Thin layer (the reason for AGENTS.md's first rule)
A week of chat bugs had one source: vault-chat had grown a second engine — conversations in many copies, pi's events
translated before display, three brains (pi, a laptop agent, ElevenLabs). Each fix added a reconciliation rule.
"Use pi as much as possible" means pi's native features and mature libraries, **not** custom code shaped as pi
extensions (same problems, new place). Migrate one duplicated piece per bug; no forced big rewrite.

## Prompts
- **No speculative prompt rules.** Add a rule only for a problem he reported. Two well-meant blocks (walkthrough
  pacing, a LaTeX guide for voice) were reverted within hours: "let's not make a solution for a problem that doesn't
  exist." Prefer deleting prescriptive blocks to rewriting them.
- **Confabulation is not fixed by prose.** The prompts already said "never claim an action a tool call didn't do" and
  the agent still invented live status ("88% GPU… I made up"). Inject ground truth into context instead.
- **Gates beat instructions for anything that must hold over a long run.** A run told to reproduce a paper
  faithfully and respect a cost cap drifted (bf16 vs the paper's fp32) and overran; a deterministic pre-flight check
  and a plateau watchdog fixed it. Per-step compliance below 1 compounds to failure over many steps.
- **Seeded prompt files go stale.** Per-vault prompts are copied from bundled defaults once; `ensureAgentConfig` in
  `src/meta.ts` refreshes a copy only if its hash matches a shipped default. After editing a file in
  `src-tauri/defaults/`, run `node scripts/gen-default-hashes.mjs` and commit the result, or vaults on the old
  default never upgrade. A hand-edited copy is never touched — so editing the bundle doesn't reach a vault that forked it.

## Judges and verifiers
- **Fix evidence gathering before tuning the judge.** A completion checker rejected valid work 36 times in one run;
  every cause was what it was *shown*: path roots that didn't match, a brief's wording poisoning every criterion,
  a silent prompt-size cap slicing off the only proof, its own earlier "FAILED" verdicts fed back as evidence. When
  every line of evidence says NOT FOUND, a correct skeptic rejects.
- **User authority needs a code rail, not a prompt rule.** The judge ignored four "force-close it" taps even with a
  rule telling it to honour them; matching his verbatim message in code did it deterministically.
- **An honest miss is a valid result.** "Report X vs the predicted band" must not become "X must be in the band", or
  every honestly documented miss is uncompletable.
- **Don't let the actor verify itself** from files it wrote; check the real clock, the real files, the real
  notification log.

## Memory and context
- When he says the agent is "dumb" or ignores corrections, check the forgetting design before the model. A "fresh
  context" mode meant for scheduled wakes leaked into live chat: the agent kept only the first message, re-obeyed it
  forever and ignored every correction. Signature: every turn re-answers message #1.
- He distrusts heavy memory systems and rarely needs deep recall: one long conversation kept bounded by pi's
  compaction, plus a few durable written memories (like this folder), is the chosen model.
- Very long single threads degrade (judgment made deep in a huge context was the worst); state worth keeping belongs
  in files the agent re-reads.

## Tool catalogs across server updates (2026-10-28)
- **Saved schemas are bootstrap artifacts, not session authority.** Resuming pi with a thread's frozen
  `tools-*.json` left old ReadyForReview parameters in the model request after its host gate required `proofId`.
  Reconstruct definitions from the current host loadout policy, preserve the pi session/file/history, and rebind
  only idle processes (running turns and children pin their existing scope). Persist side loadout semantics or
  legacy explicit names, never infer broader grants from a schema refresh; workers retain their child allowlist.
  Source changes still require a server restart; this is not permission for an agent to deploy or bypass Keep.

## Auto-ship authority foundation (2026-10-29, not activated)
- Carl requested replacing mandatory Keep with service-owned proof-gated acceptance and an after-the-fact
  Shipped/proof/Roll back card. The agent still never merges or pushes main. `changeProof.ts` introduces
  single-use host-process permits; receipt JSON/model test prose is not acceptance authority. Compare exact
  named baseline failures, not counts. Main/head/tree/branch pins are rechecked under the existing repo lock;
  fast-forward only avoids manufacturing an unproved merge tree. `acceptProvenReview` never pushes or resets
  another actor's clone. The installed host adapters/tool/card are not wired yet: see `docs/auto-ship-foundation.md`.
- The first deployment cannot self-authorize through an entry point the installed server does not have.
  A candidate sidecar against the real repo would bypass authority, not solve bootstrap. Report the constraint;
  no manual main merge/push or unapproved production drop-in is implied by implementing the new service.
- Concrete sandbox/RecordUI adapter and internal request-bound service job now exist in `changeHost.ts`,
  `changeUI.ts`, `submitChange.ts`; default tool/release/card cutover remains unfinished. Continue from
  `docs/auto-ship-host-integration.md`, not by exposing SubmitChange before release/rollback is wired.
  Installed dependency copies must preserve relative symlinks (`verbatimSymlinks`) and canonicalize the
  toolchain/browser before hiding `/run`; otherwise npx executes hidden host paths. Use distinct empty npm
  user/global config files, not `/dev/null` twice. A baseline test-process OOM/SIGABRT remains incomplete
  proof, never an allowed ordinary named failure; stabilize its fixture before service acceptance.
