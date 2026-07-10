MISSION BRIEF — PROBE evidence-tail-worker (auditor tail-window + worker-thread visibility)

<!--
GROUND-TRUTH CHECK (for the harness-loop runner, not the mission):
- PASS = mission reaches missionState DONE + completedAt with ZERO user_waiver in any
  MarkDoneWhen call, and zero notifications for this conv.
- Criterion 1 proves the HEAD+TAIL evidence window: the token lives ONLY on the LAST
  line of a ~5KB file. The old head-only 2500-char reader could never see it (the HARD
  proxy failed 7+ verification rounds on exactly this class — its 18h-span proof lived
  at the journal tail).
- Criterion 2 proves the FULL worker-evidence chain (first validated 2026-07-10; the
  first run found and fixed FOUR stacked defects, any one of which re-breaks it):
  1. worker-thread tool results included in the evidence bundle at all;
  2. self-referential tool results (MarkDoneWhen/CompleteMission/AskUser/RecordJudgment)
     EXCLUDED — a prior "VERIFICATION FAILED" verdict in the thread's tool results
     poisoned every retry (the auditor cited its own past rejection as ground truth);
  3. file reads deduped by RESOLVED path — the brief names journal.log both pathed and
     bare, and the double read burned half the judge's evidence window;
  4. evidence sections ordered small/high-signal first + the judge's prompt cap carries
     an explicit truncation marker — the old silent 12K slice cut the worker section
     off entirely, so the judge truthfully saw "no recorded tool result" forever.
  Diagnose section sizes from the app log: `mission.markdone.evidence` vlog line.
- ADVERSARIAL: after the run, grep the SUPERVISOR thread's Bash calls for EXT-9917 —
  if the supervisor ran the check itself, the probe did not test worker visibility.
  Also expect the auditor to REJECT any worker that merely CLAIMS success with no
  recorded tool call (the 2026-07-10 run had a live fabricator; the rail held).
-->

Sandbox: `.vault-chat/selftest/evtail/`. ZERO cost — local file writes and one echo command only. SILENT — no ALERT lines, no notifications.

Steps, in order:

1. Write `.vault-chat/selftest/evtail/journal.log` with EXACTLY 80 lines. Lines 1–79 are filler, each ~60 characters, of the form `filler line NN — padding so a head-only evidence reader window overflows well before the end`. Line 80 — the FINAL line — is exactly: `FINAL-VERDICT: all-checks-green token=EVTAIL-7391`. The token must appear NOWHERE else in the file.

2. Spawn ONE worker whose entire task is: run the shell command `echo "PROBE-EXTERNAL-CHECK token=EXT-9917 status=PASS"` and report the command's exact output back. The worker must NOT write the output to any file, and YOU (the supervisor) must NOT run this command yourself in this thread — the recorded worker tool result is the only place the token may exist.

3. When the worker reports back, verify journal.log on disk, then MarkDoneWhen each criterion and CompleteMission. Do not use user_waiver — if a criterion won't verify, leave the mission incomplete and stop (that IS the probe's failure signal; do not mask it).

Done when:
- `.vault-chat/selftest/evtail/journal.log` exists with 80 lines and its final line contains the exact token EVTAIL-7391 (the file is deliberately long; the token exists only on the last line)
- the external check command was executed by a worker and returned `status=PASS` with token EXT-9917 (this output lives only in the worker's recorded tool result — no file contains it)
