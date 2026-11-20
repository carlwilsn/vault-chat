// Is this launch a self-test (VC_SELFTEST, src-tauri/src/self_test.rs)? Asked once of the native side, which answers
// only the main window and only when the launch environment set it; a browser, a dev build or any error says no.
// Kept apart from src/selfTest.ts so what only needs the answer (the updater, src/UpdateBanner.tsx) does not load
// the step engine.
let asked: Promise<boolean> | null = null;

export function isSelfTestLaunch(): Promise<boolean> {
  asked ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<unknown>("selftest_config"))
    .then((cfg) => cfg != null && !wantsUpdates(cfg), () => false);
  return asked;
}

/** A self-test of the updater itself (`"updates": true` in its steps file: test/selftest/update-a.json, the Mac
 *  check's A -> B update) lets the updater run as on a real launch; every other self-test keeps it off. */
export function wantsUpdates(cfg: unknown): boolean {
  const steps = (cfg as { steps?: { updates?: unknown } } | null)?.steps;
  return steps?.updates === true;
}
