# Populated picker recording: collapsed-tree helper correction

Development evidence only; no acceptance, install, shipping, main merge or push.

## Measured cause

Original failed job remains `/tmp/picker-on-reset-startup-1031-populated-r1` (baseline locator timeout;
original candidate recording never reached). Its retained `baseline/error.png` shows six collapsed directories.
Both actual-App preflight observations show exactly these directory rows, all with `data-tree-dir`:
`courses`, `daily`, `guide`, `notes`, `projects`, `reading` under `/home/carl/vaults/summer-demo`.
`FileTree.tsx` correctly omits `data-tree-dir` on file rows; no selector attribute regression or empty tree.
The preview supplies an in-memory laptop filesystem through the existing Tauri command bridge; the real private
server owns chat/history/projects. The initial laptop path is intentionally not the private box's disk path.

## Minimal correction and scope

`preview/tools/vaultPickerSplitRecord.mjs` genuinely clicks the exact `reading` directory and seeded
`reading/README.md`, checks its exact path/content plus the visible Reading list heading, then performs the
original picker/history/navigation assertions. No `.first()` file identity, forced input, status injection,
timeout inflation or product edits. Added failure DOM/IPC/read-only store capture, retaining the primary error.

`preview/tools/vaultPickerTreeResume.sh` reuses the original private dependencies, baseline export and b65 server
bundle. It checks all tracked non-preview/non-memory inputs against the two original git pins, pins the reused
bundle digest, refuses occupied ports, uses process PID plus Linux start-time identity for owned cleanup, and
creates a NEW private synthetic fixture with the existing seeder. Its migration output is synthetic only.
No backend migration change. Existing 42 genuine npm bin links/native optionals were not altered.

Public protocol source check: `GET /api/v1/health` returns `vaultPath`; `GET /api/v1/master` returns
`master`, `layout: {vaults, projects, hub}`, and `vaults: [{name,path}]`, not an invented `defaultPaths` field.
`vault_box_config` intentionally uses an empty scope for initial summer-demo (server default school2), then
`vault-chat` for `/home/carl/vc/vaults/vault-chat`. No protocol/fixture metadata fix was needed.

## Actual checks and evidence

- Bounded preflight: exit 0 in **21.814 s**, `/tmp/picker-tree-preflight-r1`.
- Full baseline AND candidate actual-App recording: exit 0 in **24.321 s**, `/tmp/picker-tree-full-r1`.
- Each full result has empty errors, pageErrors and outbound arrays. Muted browser, voice disabled.
- Both reopen Main with the exact original two message IDs; separate older history has its exact two IDs.
  Full message objects, conversation metadata and all history are unchanged before/after.
- Both registered scopes list identical shared projects and resolve Main identically; unknown scope remains 404.
- The viewer switches to `/home/carl/vc/vaults/vault-chat`, clears old currentFile/panes, and genuinely opens
  `reports/QUEUE.md` without changing Main/history. Candidate picker/menu assertions all pass.
- Private disk event logs after shutdown retain `picker-main-user`, `picker-main-assistant`,
  `picker-older-user`, `picker-older-assistant`, under school2's original conversation owner.
- Source check: 773 baseline / 774 candidate non-preview inputs match original pins byte-for-byte.
  Reused bundle SHA256 `a547512cadd03577a0d9b809d862cccd907dfc6005208a1e004c7636f9047492`.
- Original candidate worktree remains b65fc80cd3ba33d2c85adaca4f13e9125d8b330b, clean and untouched.
  Original passed full builds/gates were reused, not rerun or relabeled. No full harness/server pair run.

Useful evidence: each mode's `01-main-and-projects.png`, `03-separate-actions.png`,
`08-projects-and-history-retained.png`, `09-correct-viewer-file-main-bound.png`, `laptop.webm`, `result.json`.
`panes` is captured as observed (the visible native single-file viewer need not retain a nonempty panes array).

## Optional parent repeat

From this helper worktree, with an unused output directory:

```sh
timeout --signal=TERM --kill-after=5s 120s preview/tools/vaultPickerTreeResume.sh /tmp/picker-tree-full-r2 full
```

This is a retained-fixture development resume, not a generic release gate. b65 still requires rebase onto actual
accepted main and the ordinary installed acceptance/shipping path; pending one-time setup is not resurrected
SubmitChange authority.
