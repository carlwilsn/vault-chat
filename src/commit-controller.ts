// Owns the "every meaningful change becomes a commit" criteria so the
// vault's git history reads as a real timeline of who-did-what instead
// of one big "agent X" line per turn. Three entry points:
//
//   noteEditedFile(path)
//     Called after a successful autosave. Adds the path to a pending
//     batch and resets a debounce timer; once the user goes quiet for
//     EDIT_DEBOUNCE_MS, the batch flushes as a single "edit foo.md"
//     (or "edit N files") commit.
//
//   commitFsAction(vault, message)
//     Synchronous "create / rename / delete / move" commit. Always
//     flushes any pending edit batch first so the FS action lands as
//     its own clean commit instead of getting conflated with stray
//     in-progress keystrokes.
//
//   flushEditCommit()
//     Public flush for callers that want to make sure the working
//     tree is committed before they do something else (chat send,
//     agent end-of-turn, etc.).

import { useStore } from "./store";
import { gitCommitAll } from "./git";

const EDIT_DEBOUNCE_MS = 10_000;

let editTimer: number | null = null;
let pendingPaths: Set<string> = new Set();

function commitMessageFor(vault: string, paths: string[]): string {
  if (paths.length === 1) {
    const p = paths[0];
    const rel = p.startsWith(vault + "/") ? p.slice(vault.length + 1) : p;
    return `edit ${rel}`;
  }
  return `edit ${paths.length} files`;
}

export function noteEditedFile(path: string) {
  pendingPaths.add(path);
  if (editTimer !== null) window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    flushEditCommit().catch(() => {});
  }, EDIT_DEBOUNCE_MS);
}

export async function flushEditCommit(): Promise<void> {
  if (editTimer !== null) {
    window.clearTimeout(editTimer);
    editTimer = null;
  }
  if (pendingPaths.size === 0) return;
  const vault = useStore.getState().vaultPath;
  if (!vault) {
    pendingPaths.clear();
    return;
  }
  const paths = Array.from(pendingPaths);
  pendingPaths.clear();
  try {
    await gitCommitAll(vault, commitMessageFor(vault, paths));
  } catch (e) {
    console.warn("[commit-controller] flush failed:", e);
  }
}

// Filesystem actions — flush any pending edit batch first so the
// action's commit only contains the action itself, then commit with
// the supplied message. Caller has already done the on-disk work.
export async function commitFsAction(vault: string, message: string): Promise<void> {
  await flushEditCommit();
  try {
    await gitCommitAll(vault, message);
  } catch (e) {
    console.warn("[commit-controller] fs-action commit failed:", e);
  }
}
