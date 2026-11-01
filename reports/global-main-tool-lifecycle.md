# Offline Main import: normal native tool lifecycle rejection

## Diagnosis (temporary synthetic data only)

Historical pin `c76de230ebfdac362f69a19ff006cb62bec66f36` had native
PASS3 at `/tmp/global-main-native-c76de230-r1` (parent evidence), but **actual
UI setup FAILED**, not a UI pass. Phone, board and server had built successfully;
production preview failed before making the runtime descriptor. Failed setup
`/tmp/global-workspace-ui-c76de230-r1` is preserved, never edited/relabelled.

Bounded structural inspection of its exact named temporary native session found:

- native `8cdacc38`: message/assistant, `toolCall.id=call_1`, raw tool name
  `mcp__vault_chat__bash`;
- native `571ea84e`, parent `8cdacc38`: message/toolResult,
  `toolCallId=call_1`, same raw name, result `released\n`;
- original feed pointers seq 2009 and 2015 target those distinct native IDs in
  the SAME source Main and SAME session file.

The second actual request uses `call_3`, not a reused `call_1`. The scratch
provider already generates `call_${n}`. This is a production offline validator
bug, not a fixture identifier bug. Pi 1.1 native types and SessionManager's
appendMessage confirm distinct native entry IDs are normal for this lifecycle.

## Minimal change

Replace the single-native-entry-per-rendered-item assumption ONLY in the offline
Main materializer. Retain the first native ownership; accept at most one result
entry for an earlier assistant tool request iff source, absolute native session,
logical call ID, tool kind and raw tool name match. Repeated pointers to those
same entries are unchanged. Reused requests, extra result entries, wrong names,
other sessions/sources and user/assistant collisions still refuse. No renaming,
new controller, side history registry, native-format change or reducer change.
This patches an overstrict validator around the existing canonical projection;
it does not add another runtime projection/state owner.

Tests cover home and imported peer, hidden pre-Clear pairs, visible archived
completed tool with original args/result, cold restart, unchanged original native
bytes, all original entry pointers, clocks/provenance, Clear and sessionFrom.
Actual native proof now requests one genuine Pi tool in EACH original Main and
checks distinct native IDs and matching logical call/name before migration.
Its existing full peer-record/provider/context and project assertions remain.

## Executed checks (new source, not relabelled c76 results)

Receipts: `/tmp/global-toolpair-fix/`.

- `red.log`: 2 causal regression failures at the original materializer collision
  check (both home and peer normal request/result pairs).
- `green-focused-final.log`: 13 selected tests pass, including all 10 new
  progression/refusal cases and 3 existing original collision guards. 24 cases
  deselected by explicit `-t`; this is NOT a whole-file/full-suite pass.
- `types-affected-final.log`: strict standalone affected importer/CLI/history and
  actual-native test typecheck passes, exit 0.
- `types-server-final.log`: server typecheck passes, exit 0.
- Whole history-file invocation `green-file.log` exceeded this helper's 25-second
  command ceiling: INCOMPLETE/failed invocation, no whole-file pass claimed.
- `failed-stage-readonly-verification.json`: independently verified historical
  exact tracked HEAD/tree/clean status, scratch SHA
  `64cf0edbac9b9b9e2a7c389916f0de9215182c4cb582b329bbf22433be5e3af0`,
  43,152 private package-file hashes and 50 relative link targets; hashed all
  134 existing phone/board/server artifact files. Historical outputs unchanged;
  they are NOT builds/proof of this changed source.

All commands used private env-i HOME/config/cache/tmp/npm configuration and
read-only donor mounts. No installs, secrets, live history/registry/native paths,
service control, foreign listeners, API spend, device audio, main or push.

## Still pending: parent StartJob, then real UI, then seven gates

The new actual-native fixture has NOT been run by this helper; parent must run
it on the new frozen pin and preserve its own new evidence. No new build, real
UI proof or seven-gate success claimed. Parent must not reuse the old c76 native
PASS as a result for this source. Use exact-pin launchers under
`/tmp/global-toolpair-fix/`; generic UI prep still takes an explicit full pin and
unchanged scratch SHA. The failed old stage stays read-only historical evidence.
A production fix requires a new exact-source UI stage, not editing/resuming the
old private clone. Do not push until native reproof, actual UI and final gates.
