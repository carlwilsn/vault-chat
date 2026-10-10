import type { DefaultSkill } from "./index";

// The merge gate (src-tauri/src/box_sync.rs) refuses to merge the box's branch
// into master when they conflict, and the Titlebar says "Ask the agent:
// resolve the sync conflict". This is what the agent then does.
export const RESOLVE_SYNC_CONFLICT: DefaultSkill = {
  name: "resolve-sync-conflict",
  description:
    "Resolve the sync conflict that keeps the box's changes out of master (the Titlebar's 'Sync: conflict in …'). " +
    "Use whenever the user asks to resolve the sync conflict: show both sides, propose a merge that loses nothing, " +
    "commit only after the user agrees, then complete the merge and push.",
  body: `# Resolve the sync conflict

The laptop's sync merges the box's branch (\`box/box\`) into \`master\` only when the merge is clean. When both sides changed the same lines, it merges nothing and leaves \`master\` untouched until someone resolves it. The laptop's edits keep reaching the box meanwhile.

Work in the vault root with Bash. Never \`git stash\`, \`git reset --hard\`, \`git checkout -- <file>\` or force-push: each of those can lose someone's work.

## 1. Show both sides

1. \`git fetch box\` to get the box's latest.
2. \`git diff --stat master...box/box\`: everything the box changed since the two last met.
3. List the conflicting files without touching anything: \`git merge-tree --write-tree --name-only --no-messages master box/box\` (the lines after the first are the files).
4. For each conflicting file, show the three versions:
   - base: \`git show $(git merge-base master box/box):<file>\`
   - laptop: \`git show master:<file>\`
   - box: \`git show box/box:<file>\`

   Plus \`git diff master...box/box -- <file>\` (the box's change) and \`git diff box/box...master -- <file>\` (the laptop's change).

Tell the user plainly, per file, what each side changed.

## 2. Propose merged text that loses nothing

For each file, write out the merged version: every addition from both sides is kept. Where both sides changed the same passage differently, keep both, one after the other, and say which is which. Never silently drop either side.

Paths under \`.vault-chat/supervisor\`, \`.vault-chat/schedules.jsonl\`, \`.vault-chat/notifications.jsonl\`, \`.vault-chat/jobs.jsonl\`, \`.vault-chat/selftest\`, and mission/worker/ask conversations belong to the box: take the box's version for those.

## 3. Wait for the user to agree

Show the proposal and ask. **Do not commit anything until the user says yes.** Adjust the proposal if they ask.

## 4. Complete the merge

Do it in a scratch worktree inside \`.git\`, so the user's open files and the app's autosave are never caught in a half-done merge:

\`\`\`sh
git worktree add --detach .git/vc-resolve master
cd .git/vc-resolve
git merge --no-ff --no-commit box/box   # conflicts are expected here
# write each agreed merged file (the full text from step 2), then:
git add -A
git commit -m "vault-chat: merge box (sync conflict resolved)"
RESOLVED=$(git rev-parse HEAD)
cd ../..
git worktree remove --force .git/vc-resolve
git merge --no-edit "$RESOLVED"
\`\`\`

The final \`git merge\` is a fast-forward when \`master\` has not moved, and an ordinary clean merge when the user kept editing meanwhile. If it reports a conflict, stop, run \`git merge --abort\`, and start again from step 1.

## 5. Push

\`git push box master\`. Then check \`git merge-base --is-ancestor box/box master && echo merged\`. The Titlebar chip clears on the next sync cycle (within about 15 seconds).
`,
};
