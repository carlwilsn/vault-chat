// Durability safety net — the guarantee that no change reaching the vault
// on disk can fail to reach git.
//
// The happy paths are already covered elsewhere:
//   - chat-controller.ts commits at the end of every agent turn that
//     touched files.
//   - commit-controller.ts commits user edits 10s after typing stops, and
//     synchronously on create/rename/delete.
//
// But changes slip through four cracks those paths don't watch:
//   1. an agent run aborted / interrupted / errored mid-write (the
//      "post.html vanished" class of loss — files written, turn never
//      reached its end-of-turn commit);
//   2. app quit with uncommitted edits still inside the 10s debounce;
//   3. a hard crash / force-quit / OS kill;
//   4. files written by something outside the tracked tool set.
//
// Everything here routes through gitCommitAll, which (a) no-ops when the
// working tree is clean — so firing it often is cheap — and (b) serializes
// through a process-wide mutex, so concurrent commits never race on
// index.lock. That makes "commit aggressively" safe.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./store";
import { gitCommitAll } from "./git";
import { flushEditCommit } from "./commit-controller";
import { vlog } from "./debugLog";

// Backstop cadence. The immediate triggers below (abort, quit) catch the
// common cases the instant they happen; this bounds worst-case loss from a
// hard crash / force-quit to one interval. 60s keeps history from filling
// with autosave commits during active chat (conversations.jsonl churns
// constantly) while still being a tight floor.
const PERIODIC_MS = 60_000;

// How long the graceful-quit handler will wait for the final commit before
// closing anyway — a hung git must never wedge the window shut.
const QUIT_COMMIT_BUDGET_MS = 4_000;

let periodicTimer: number | null = null;
let installed = false;

/**
 * Commit whatever is on disk right now.
 *
 * Attribution matters: the honesty sweep (summer/honesty.md) splits "my
 * work" from "agent work" purely on the `[agent]` commit-subject prefix.
 * A safety commit that rescues agent-written files MUST carry that prefix
 * or the work gets miscredited to the user. So:
 *
 *   - agent-origin (opts.agent, or a run in flight): tag `[agent]` and
 *     commit the whole tree as one agent commit. We deliberately do NOT
 *     flush the user-edit batch first — honesty.md's rule is "when in
 *     doubt, mark it agent," so any rare hand-edit made mid-run is folded
 *     into the agent commit rather than risk crediting agent output to me.
 *   - idle/user: let the debounced edit batch flush with its own nice
 *     "edit foo.md" (unprefixed = my work) message, then sweep the rest as
 *     an unprefixed user autosave.
 *
 * Best-effort: never throws.
 */
export async function safetyCommit(
  reason: string,
  opts?: { agent?: boolean },
): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return;
  // `busy` only reflects the foreground active-vault run; off-vault
  // background runs don't flip it (honesty.md gap #1). That's the known
  // ~10% blind spot — the foreground path this covers is the one most
  // likely to mislead.
  const isAgent = opts?.agent ?? useStore.getState().busy;
  try {
    if (!isAgent) {
      // Let any debounced user edit flush with its own message first;
      // gitCommitAll then no-ops if that cleaned the tree, or sweeps the
      // rest as an unprefixed (= user) autosave.
      await flushEditCommit();
    }
    const prefix = isAgent ? "[agent] " : "";
    const hash = await gitCommitAll(vault, `${prefix}autosave (${reason})`);
    if (hash) vlog("autosave", { reason, agent: isAgent, hash });
  } catch (e) {
    console.warn("[autosave] commit failed:", e);
  }
}

/**
 * Install the periodic backstop and the graceful-quit commit. Main window
 * only; idempotent.
 */
export function installAutosaveNet(): void {
  if (installed) return;
  installed = true;

  // (3) Periodic backstop — bounds loss from a crash / force-quit. Cheap:
  // gitCommitAll runs one `git status` and returns when the tree is clean.
  periodicTimer = window.setInterval(() => {
    safetyCommit("periodic").catch(() => {});
  }, PERIODIC_MS);

  // (2) Graceful quit — Tauri lets us defer the close until a final commit
  // lands. Both the OS title-bar X and the app's own close button route
  // through win.close(), which fires this; win.destroy() afterwards closes
  // without re-firing, so there's no loop. Time-boxed so a stuck commit
  // can't trap the user in an unclosable window.
  try {
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        event.preventDefault();
        const commit = safetyCommit("quit");
        const guard = new Promise<void>((r) => window.setTimeout(r, QUIT_COMMIT_BUDGET_MS));
        await Promise.race([commit, guard]);
        win.destroy();
      })
      .catch((e) => console.warn("[autosave] onCloseRequested wiring failed:", e));
  } catch {
    // Not running inside a Tauri window (e.g. plain web dev) — skip.
  }

  // Last-ditch fire-and-forget for unload paths the close hook can't catch
  // (renderer reload, webview killed out from under us). Can't await here,
  // but the invoke is dispatched before the context tears down.
  window.addEventListener("pagehide", () => {
    safetyCommit("pagehide").catch(() => {});
  });
}

/** Tear down the periodic backstop (tests / teardown). */
export function stopAutosaveNet(): void {
  if (periodicTimer !== null) {
    window.clearInterval(periodicTimer);
    periodicTimer = null;
  }
  installed = false;
}
