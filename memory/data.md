# Data on disk, git and sync

Vaults and projects are git repos synced laptop ⇄ box, the box the hub, one branch per machine (laptop `master`, box
`box`); merges go through a gate that stops on a conflict and shows it. Files over 50 MB are never auto-committed;
nested-repo automation is off. Most of the rules below were paid for with lost or resurrected data.

## Deleting and merging
- **Never delete by omission; write a tombstone.** "Write the in-memory list to disk and remove files not in it"
  made chats flap in and out of existence between two machines. `*.jsonl` files merge with `merge=union`, so a row
  dropped on one machine comes back from the other. Deletes are explicit records: `conversations-deleted.jsonl`,
  `schedules-deleted.jsonl`; readers filter tombstoned ids. *Apply:* any cancellable record on a union-merged file
  needs a tombstone.
- **Union-merged stores duplicate; dedupe on read, by id.** Notes had 26 duplicate groups (a resolved twin and an
  open twin of the same note) because only that store lacked the guard. `dedupeNotes` in `src/notes.ts`: per id,
  the higher status wins (a terminal `cleared` outranks `resolved`), then the latest update. Reads must be correct no
  matter how many merged lines back a record.
- **Terminal states must be monotonic.** A stale "running" snapshot merged in after a "done" stamp resurrected a
  finished item forever. A merge must never move a record back out of a terminal state.
- **Classify on the discriminating field.** A conversation's meta line carried `role` like a message did, so a
  "filter by shape" parser read the meta as a message and dropped whole conversations. Classify id-first.
- **Messages without stable ids can't be deduped** — duplicates, vanished turns and forks all came from reconciling
  identity-less messages by "more messages = newer". Any id-union also needs a compaction watermark, or compacted
  messages come back.

## Writes
- **Durable before ack.** A delete returned before its tombstone was on disk; the client's immediate reload re-read
  the old file and the item flickered back ("weird delay-bug"). Never fire-and-forget a write the next read depends on.
- **An app-layer writer always beats a git-layer cleanup.** A sync step reset files to the hub's version and the
  in-memory store rewrote them a second later. Enforce ownership where the writes originate.
- **Per-machine settings never go in a synced file.** `<vault>/.vault-chat/config.json` is git-tracked; a per-machine
  flag there propagates to every machine. Machine-local state belongs in localStorage or ignored files.
- **Machine-local logs stay machine-local** (`sync-log.jsonl`, app logs are git-ignored; a synced log churns the sync
  it measures). Read the box's logs on the box.

## The git engine (rules that are now code; don't undo them)
- One lock per repo around every mutating git call; stale `index.lock` removed; a stuck rebase/merge aborted before
  committing. Two unlocked writers (autosave and sync) once wedged a vault for 9.5 hours.
- On timeout kill git's whole process tree (helpers like `git-remote-https` survived and held locks for days); Git
  Credential Manager forced non-interactive (`GCM_INTERACTIVE=never`); `GIT_TERMINAL_PROMPT=0`.
- Pull merges, never rebase-or-abort-and-loop; leftover conflicts are settled deterministically and the losing side
  kept as a `.conflict` sidecar. Pull must always make forward progress.
- Tracked-but-ignored files (heartbeats) were untracked by a sweep on every commit — they caused ~950 commits in
  three days.
- On a Linux box with an auto-login, the desktop keyring stays locked and calls *block* rather than fail; secrets
  have a file fallback for that reason.
- A sync sweep once NUL-filled nested repos' `.git/config`. Recover from `.gitmodules` + `FETCH_HEAD`, written as
  UTF-8 **without BOM** (PowerShell 5.1 adds one and breaks it again). Least destructive fix for an orphan gitlink:
  add the missing `.gitmodules` mapping, don't `git rm` the gitlink.
- When two machines both need to write the same vault, give each its own branch; "one writer" schemes stranded his
  laptop edits (the reason for today's branch-per-machine design).

## Attribution
Agent-written commits carry `[agent]` and the agent's identity; his edits keep his identity. He measures his own
deep work by `git log --grep='^\[agent\]'` vs the rest, so mis-crediting agent work to him corrupts that signal. When
in doubt, mark it agent.
