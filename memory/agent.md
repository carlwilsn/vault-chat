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
  Source changes still require a server restart; this is not permission for an agent to deploy or bypass installed service authority.

## Auto-ship authority (2026-10-29)
- Mandatory Keep is replaced by native SubmitChange once A is installed. The service resolves the actual
  conversation ask, pins both sources, runs seven gates on each, records actual candidate UI, and accepts
  only its same-process single-use proof permit under the existing repo mutex. Receipt JSON and agent
  test prose are not authority. Laptop sync alone pushes; CI publishes; actual authenticated device health
  determines Shipped. Historical cards remain readable, not a new default review gate.
- Carl explicitly approved ONE final legacy installed-service handoff for A + voice-mic fixture fix after
  complete candidate checks and real UI proof. A need not fake self-SubmitChange proof against immutable
  broken 6fcc7f6: its OOM is still incomplete/failure. No manual main merge/push or candidate sidecar is
  authorized. Parent performs that final handoff; B and later changes use installed A.
- Installed release assets include exact proof manifests. The host provisions each pinned lock once using
  credential-free public npm ci --ignore-scripts, no npmrc/hooks, registry-only SHA-512 entries. Both
  sources have independent immutable dependency snapshots; toolchain and Chromium use canonical paths
  before hiding HOME and /run. Missing network/tools fail visibly, never a weaker proof fallback.
- Specific source rollback is a service-owned branch from current main, git revert --no-commit of only
  accepted base..head. Later unrelated work survives; conflicts/merge ambiguity need attention, never
  reset/force. It uses the SAME gates/RecordUI/permit/acceptance path with rollbackOf journal identity.
  Notes-save UI smoke proves recovered app usability without replaying a feature the revert removes.
  Failed/stopped/timed-out jobs are terminal attention, not infinite health-triggered retries. Process-lost
  gone jobs may re-prove from the accepted identity; accepted rollbackOf dedupes across restart.
- Local clone --no-hardlinks alone races source auto-GC's temporary pack files. --no-local uses git's
  object transport for isolated clones; disable fetch auto-GC during source pinning. The unmocked real
  submission→UI→acceptance→source-revert integration exposed and verifies this case.
- First A can fail before its new recovery server is up: the reviewed updater must execute the retained,
  checksummed failed bundle's no-listener `recover-published-release` CLI only after healthy old fallback.
  Reuse the same installed proof/job pipeline; no model, key-store read, serialized permit or agent sidecar.
  Exit zero requires all matched source rollbacks accepted AND ordinary hub transport confirmed. No
  accepted/public identity is needs-attention, never a successful no-op. Preserve only the exact separately
  approved voice fixture in the ONE host-verified legacy A bootstrap; normal rollbacks remain full range.

## Shipping reset (Carl, 2026-10-30; supersedes earlier auto-ship A rules)
- Agents publish agent branches; one separately installed box script runs the seven baseline/candidate
  gates and promotes main by native git compare-and-swap, with no new named failures or surviving executed→skip/todo laundering.
  No permit, bootstrap importer, receipt authority or candidate-bound recorder in acceptance. Actual UI
  checking remains the agent's responsibility; post-release authenticated device health and rollback
  remain authoritative for Shipped. First activation goes through Claude once, not self-acceptance.
- See `docs/simple-ship.md` for exact installation/transport requirements and native rollback's exact-tree
  trust boundary. Parent explicitly resolved ordinary architectural retirement under Carl's standing
  same-name/file-failures rule: missing old tests stay ABSENT, not passes. The blanket identity-retention
  rule was extra policy and is removed for both forward changes and rollback, with no special exception.
  Exact native revert TREE + SOLE PARENT verification remains rollback correctness, not a retirement permit.
  Complete reports/runner consistency, both type/build successes and surviving-case skip guards remain.
  Old failed pair logs and 114 removed identities stay historical evidence; new source needs fresh proof.
- Finished Delegate navigation must use its native child id in the exact tool result to bind the
  pi tool-call id; MCP request ids and newest-open-call/title guesses are not ownership. Reuse
  ordinary conversations and PiFeed pointers to the completed native session, not a worker
  registry or copied report. Production App proof must click the finished chip into that child
  and return to its parent; recording a missing chip as a diagnostic is not a passing assertion.

## Hidden turn context (queue 1 preparation, 2026-10-30; not shipped)
- Do not concatenate host rules/memory into the native pi user prompt and rely on a feed presentation override
  to conceal them: recovering the session without that override exposes instructions as Carl's words. Use pi's
  persisted `custom_message` (`display:false`, model-visible) via the existing `/vc-note` path instead. Keep actual
  user text/images and native voice messages distinct. This removes forged-user-context encoding, not the host
  context builder or the broader duplicated presentation layer. Native resume/replay tests cover that distinction.

- Native pi 1.1.0 RPC `prompt` acknowledges only after preflight, which can include slow compaction/retries.
  Await that correlated native operation without a transport deadline; retain the caller/turn/session until pi
  accepts/rejects/exits. A 60-second transport timeout cleared ownership while pi later accepted the prompt,
  causing orphaned input and fresh-prompt/busy errors. This is not slow process startup. Native `steer` and
  `follow_up` accept input during preflight: no started-state polling loop is needed. Stop must reach native
  abort before acceptance AND be honored at acceptance if it raced model/context setup. Pi can abort its
  compaction yet still accept the original prompt. Offline native fake-clock regressions cover these boundaries;
  they do not prove the live 155k Main or an installed release.


## Native protocol fixtures must follow context ownership (2026-10-30)
- When moving context out of user prompts, update test backends to capture the separate
  `context` input and fake RPC extensions to persist `custom_message` (model-visible,
  display:false), not `custom` vc-note (display-only). Otherwise memory assertions fail
  and a hidden-context notice may appear as an assistant line only in the fake.
  Diagnose with paired whole affected files and the real pinned pi contract; preserve
  original model/feed assertions and verify raw typed entries, never hide the symptom
  or concatenate context back into user text. Eleven integration failures on startup
  source 8f6 were traced to these two fixture omissions; no production retry was needed.

## JobStop audit is not maintenance authority (2026-10-30)
- Audit the existing explicit native controller rather than add another process/ownership registry.
  Capture the host-bound caller before awaiting; refusal of disabled/unwritable audit happens before
  controller invocation. Do not claim rollback if the final audit write fails after the controller.
  A work-bound call may reach only its exact live native work identity, never sibling/projected jobs.
- This does not authorize PID/path cleanup, listener adoption or a systemd restart. Such operations
  still need demonstrable owned native identity plus actual start time; a timestamp in a writable
  projection is not sufficient. Retired proof-invalidation wording must not be restored for old tests.

## B integration on shipping reset (2026-10-31; prepared only)
- Preserve the reset's native child-start callback alongside per-ask cwd/tool scope. Scoped host
  calls receive the actual spawned pi child session id, never the parent's id or an invented fork;
  the existing child→conversation link resolves that call. Hidden custom context and preflight-stop
  ownership remain pi's contracts, not worker scope state. Share the CURRENT installed-script
  adapter (including native cancellation grace), not an older copy from B.

## Cross-vault content is not conversation authority (2026-10-30)
- A project cwd is context, not file scope. The registered server vault list is the
  authority for ordinary synced content; never grant arbitrary host paths from
  user/file/tool text. Bind registered content through the existing sandbox folder
  capabilities, then hide other vaults' `.vault-chat`, `.git`, bare repos and native
  state again AFTER project binds. Keep service-owned project sources read-only
  and their conversations/events/local private. Host PDF readers use the same
  private-path guard; they are not a way around the native file sandbox. Masked
  roots must be remounted read-only AFTER content binds: write tools create
  parents, and a writable tmpfs can falsely report editing a nonexistent copy.
- Native process mounts are snapshots; short-lived file executors revalidate on
  every command (never rebind replaced roots from stale argv). Registration changes
  rebind only idle pi processes (same session file/id/history); never cancel a live
  turn or its children to refresh mounts. Qualify viewer-relative paths with the
  server's vault root, and list only registered roots, not other chats/memories.
- A source commit does not alter the installed engine's capabilities. Editing the
  original cross-vault file waits for the legitimate engine update; never invent a
  replacement file or escape the sandbox while installation is pending.
