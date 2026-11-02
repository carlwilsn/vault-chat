# Source recovery removal (a)

Based on canonical main `6436747f`, independently of the unshipped UI-removal branch.

- Delete source rollback dispatch, native job registration, accepted-range selection,
  native revert creation and obsolete host CLI modes. Historical journal fields and
  stored human answers remain untouched; existing shipment UI stays until (c).
- The old POST shipment rollback endpoint now returns 410 without looking up a
  range or starting a job. Failed health stays telemetry, not recovery work, a
  new persisted failure card or an updater alert. Ordinary Notify is unchanged.
- Updater failure retains its first durable observation, failed-version suppression,
  proper HTTP readiness and last-good binary fallback with one outcome log line.
  Suppression also applies when the failed version is still current with no fallback.
- Server bundle entry rejects every unsupported argument before importing main;
  no arguments (server), exact `build-info` / `record-ui`, and the existing
  `master` / `projects` CLI modes remain supported. The first full development
  run exposed the over-broad guard breaking RecordUI; the guard now preserves
  those ordinary commands while still rejecting retired recovery modes before main.
- `ROLLOVER_RECOVERY_PROTOCOL=1` is only the transitional installed updater refresh
  compatibility marker. It introduces no log-cap activation or source-revert policy.

## Protected installed host

No installed host, installer, bundle preparation or capture guard was changed.
The existing normal `--branch` request still uses its fresh stable real-copy capture,
strict original IDs/items/native and canonical prefix/instruction/worker checks,
pinned baseline/candidate gates and expected-old promotion.

Read-only inspection of `~/.local/lib/vault-chat/simple-ship/simple-ship.mjs` found
remaining obsolete **direct operator-only** entrypoints at lines 902 (`--failed-release`)
and 927 (`--rollback`), backed by its historical `ship(input.rollback)` /
`prepareRevert` implementation. They remain in the protected old bundle by explicit
instruction; new server/updater/repo CLI code cannot call them. The watcher calls
only `--branch`. No obsolete command or native git revert was executed.

Development logs and UI proof live outside the vault in
`/tmp/source-recovery-removal-1102`. Local/full gates and installed watcher results
must be read as actual outcomes, not assumed green. Acceptance/publication is not
Shipped until actual box and paired native laptop versions/readiness agree.
