# Vault-only picker on reset/startup — preparation, not shipped

Owned branch: `agent/picker-on-reset-startup-1031`.
Owned worktree: `/home/carlwilsn/agent-work/vault-chat/changes/picker-on-reset-startup-1031/agent/picker-on-reset-startup-1031`.
Preparation baseline: `93837b6c4dde00f4e6f0a4a18511a524c2aa8dd7`.

## Narrow port

Located the prepared source with `git show 13d73467edbfe21b7c172b138e9018d5bc95e8b9:reports/vault-picker-split-1030.md` and its diff from `8e540669`. Ported only `src/VaultPicker.tsx`, its `master.test.ts` coverage, and the three owned picker proof tools plus the opt-in existing fixture hook. Product source and affected test file are byte-identical to that prepared tip; the new launcher/recorder are adapted to this preparation baseline.

The titlebar lists only existing `localVaults` folders, not project repositories/nested folders, tabs, badges or “in school2” labels. Main/projects remain in the unchanged chat pane. Uses existing React portal and recoverable rename/delete actions; no new library, project assignment/creation, registry or ownership model. Existing explicit user operations remain available; no such operation was performed on user data.

Viewer vault, conversation log owner and project are distinct. Existing global-feed/current API behavior is retained, not replaced with vault-owned projects or a new all-access grant. `5f658750` is NOT integrated. No backend/migration/store/chat-controller change: `openVaultAt`/`setVault` still clear local chat/file projections and reload the global feed. This port does not claim to eliminate that existing transient reset or change in-flight-stop behavior. The pending recorder requires the same populated Main/history identities after reload, the same project through both registered viewer scopes, scoped checkpoint reads, and unknown-vault HTTP 404. It additionally opens a real file with browser input before switching, rejects stale panes/paths, opens the new vault's Queue file, and rechecks bound Main/history. Read-only app-store observations are in the dev recorder only, not a runtime/SSR/ChatExtras import.

## Fresh finite checks

All logs retained under `/tmp/picker938-checks/`:

- Four affected harness files (`master`, `projects`, `projectDelete`, `projectFolder`): **26/26 pass**, zero skipped/cancelled/todo; `affected.log`, exit 0, bounded 23 seconds.
- Desktop `tsc --noEmit -p .`: exit 0; `types.log`, bounded 23 seconds.
- Opt-in seeder: two Main plus two older-history stable IDs/text verified using current engine reads AND a newly disk-reopened `ConvLog`; `seed.log`, exit 0. No server/browser/model launched.
- Bash/recorder syntax, both fixture TypeScript syntax transforms, diff whitespace: pass; `syntax.log`.
- Private physical dependency copies exclude donor `.bin` and writable caches. Genuine npm 10.9.8 `bin-links` reconstructed **42 relative private links**, checking pinned lock/package metadata and original target hashes; three original optional native executable hashes matched. Evidence: `bin-links.json`, helper `relink-bins.mjs`.
- The launcher's exact dependency preflight executed successfully: 42 private links, original optional esbuild/Rollup closure, Node 22, Playwright 1.54.0 and actual installed Pi 1.1.0; `closure.log`. Tests used `env -i`, private HOME/cache/config/short TMP, separate empty npm configs, actual npm executable bin, genuine Python, voice off; no installs, ABI replacements or shared writable caches.

No fresh browser run: this new worktree has no warm built server/frontend, so faithful App recording cannot fit the requested sub-25-second foreground bound. `/tmp/vault-picker-split-resumed-8e540669-populated-r1` is an OLD receipt only, not proof for this pin. The strengthened recorder has syntax/preflight checks, not a fresh browser pass. No full suite, full harness, baseline/candidate server pair, native acceptance or shipping check was run.

## Finite parent job (development proof only)

Run via parent StartJob, using the final clean HEAD from the handoff and a nonexistent output directory:

```sh
/run/current-system/sw/bin/bash /home/carlwilsn/agent-work/vault-chat/changes/picker-on-reset-startup-1031/agent/picker-on-reset-startup-1031/preview/tools/vaultPickerSplitProof.sh <FULL_FINAL_HEAD> 93837b6c4dde00f4e6f0a4a18511a524c2aa8dd7 /tmp/picker-on-reset-startup-1031-populated-r1
```

Launcher checks exact clean source/branch/ancestry; finite 240 seconds plus 5-second kill grace. Uses private HOME/TMP/config/npm cache, physical independent baseline package caches, genuine Node/npm/Python/Pi/PW/Chromium/ffmpeg, muted browser, deterministic local provider/dummy fixture credentials, voice off. Refuses occupied ports **19481/19482/19483**, uses the existing helper's dynamically allocated positive loopback box/provider ports, checks only owned child liveness, and cleans up only its children. No inherited keys, paid API, mic/audio, OS push, live vault changes, foreign listener adoption or downloads. The opt-in fixture exits if its own server dies. Fresh bundled phone/board/server build is for the recording, not a full gate pass. Both frontend source pins use the same unchanged production backend plus private fixture history. Inspect both `result.json` files, candidate screenshots `03-separate-actions.png`, `08-projects-and-history-retained.png`, `09-correct-viewer-file-main-bound.png`, and muted `laptop.webm`; retain failures unchanged.

938's seven-gate *comparison* had known raw failures (baseline 22, candidate 21, zero new), not seven raw-zero passes. Its outside-host first-ship handoff remains separate/pending. After 938 is actually accepted, rebase this owned work onto actual main and retest before ordinary shipping; do not treat this preparation baseline or old receipt as acceptance authority. No permits/bootstrap/recovery operation, main merge/push, service installation/restart or publication was attempted.

Historical-media-reader/938, canonical main/8e, other workers and their worktrees, root PLAN/rules, live Main/events, School2Poll.md and other private files were not changed. Broad migration/cleanup/GitHub backup failure/reasoning-leak work remains Claude's, not this port's.
