// Is this launch a self-test (VC_SELFTEST, src-tauri/src/self_test.rs)? Asked once of the native side, which answers
// only the main window and only when the launch environment set it; a browser, a dev build or any error says no.
// Kept apart from src/selfTest.ts so what only needs the answer (the updater, src/UpdateBanner.tsx) does not load
// the step engine.
let asked: Promise<boolean> | null = null;

export function isSelfTestLaunch(): Promise<boolean> {
  asked ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<unknown>("selftest_config"))
    .then((cfg) => cfg != null, () => false);
  return asked;
}
