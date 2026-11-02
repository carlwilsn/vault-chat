# Composer typing regression: development evidence, not a shipped/native claim

Application change: `bd950514` (stable worker-link callback and per-message worker arrays in `src/ChatPane.tsx`). No side-API ownership, shipping, layout or updater changes.

## Scope

This is **headless Chromium, production Vite frontends freshly compiled at exact release source pins**, a test-only native IPC adapter and an isolated copy of genuine backend/history. It is **not the physical laptop, Tauri/WebView2, or extracted signed release binaries**. No messages submitted, inference/audio used, or production data written. Browser muted, backend network isolated.

Pins: v0.7.22 `e74b705dc6168dfc64a6e0bc193f9da2e58c6642`; v0.7.26 `942a80b065f42697bc2791913098886078dce1b3`; fix `bd950514`. All three show the same populated conversation (2,000 message bubbles). Backend is the existing genuine `5565bb26` build against the same previously validated immutable snapshot. This old snapshot is useful for comparison but **does not satisfy fresh candidate startup validation**.

## Clean comparison (r6, exit 0)

41 real CDP keyboard characters per field, each observed input event through two animation frames; Performance metrics, sampled allocations, long-task observer and Chrome timeline traces. Render counting is a separate pass: its whole-tree traversal is disabled during latency measurement. No frontend errors in any build.

| Measurement | v22 | v26 | fix |
|---|---:|---:|---:|
| Composer median input → two RAFs | 25.8 ms | 61.9 ms | 25.9 ms |
| Composer p95 input → two RAFs | 26.7 ms | 74.9 ms | 26.9 ms |
| Composer median JS per key | 3.50 ms | 47.71 ms | 3.67 ms |
| Composer cumulative observed long tasks | 0 ms | 1,778 ms | 0 ms |
| Composer sampled allocated bytes | 492,020 | 13,926,788 | 590,536 |
| Historical bubble renders, 41-key counting pass | 0 | 82,000 | 0 |
| Ctrl+K median input → two RAFs | 22.8 ms | 22.1 ms | 23.2 ms |
| Ctrl+K median JS per key | 0.83 ms | 0.79 ms | 0.71 ms |

Layout counts during the composer typing runs are identical (124 each). The regression is JS/reconciliation, not extra layout. Allocation figures are sampling estimates, not retained heap or a precise accounting of global-project work. The fix restores practical v22 parity; these measurements cannot establish a meaningful difference of tenths of a millisecond.

## Causality and regression check

Every v26 composer keystroke changes **only `spawns` and `onOpenSubagent`** on all 2,000 historical memoized bubbles: a freshly allocated array (often `[]`) and callback defeat `memo`. Both identities are now stable until their real inputs change. There is no history truncation, comparator ignoring updates, or UI authority/state copy added.

`preview/tools/typing-check.mjs` passed the copied-real-data regression run (r8 exit 0): v22 passes, v26 fails with 60,000 historical rerenders for 30 characters, fix passes. All three had zero frontend errors. It uses real keyboard input and a React commit hook, checks zero historical bubble renders, draft retention and a real-wheel scrolled-away reader position. Reused bailout fibers retain old flags: the counter excludes fibers already visited in the preceding tree rather than falsely counting their stale `PerformedWork` flag. No wall-clock threshold makes the regression assertion flaky.

Shipping polling is unchanged between the two release pins: a five-second minimum refresh and an equality check before setting shipment state. The fresh bubble props alone explain the per-input regression; no evidence here justifies removing shipping or changing project-store ownership. This does not claim live polling has zero cost.

Standalone Ctrl+K typing slowdown was **not reproduced**. This branch does not claim to fix its separate side-thread 404 or to prove a successful edit submission. The known Ctrl+Shift+F remount occurs in both release sources and was not folded into this urgent typing fix.

## Checks and remaining acceptance

Production build succeeded. Affected `workerNavigation.test.ts` and `backgroundtasks.test.ts`: 10/10 passed; desktop `tsc --noEmit -p .` passed. An initial sandbox test failed because `/tmp` was read-only; its receipt is retained, and the private writable-tmp retry passed.

The separate Ctrl+K ownership candidate `ec91f1a7` is now installed healthy in v0.7.27 (`966a0286`); both typing commits have been rebased onto it, preserving client and server ownership changes. The reusable regression check now types a 41-character unsent draft, matching the controlled comparison length. All seven final gates, fresh whole-selected-live-data startup validation, actual laptop typing evidence, release request and installed-health verification of this typing candidate remain **uncompleted at source freeze**. Exact-pin receipts and eventual installation evidence are recorded externally in `/home/carlwilsn/agent-work/vault-chat/typing-release-1102/`; physical laptop latency remains unmeasured. No typing ship request or main push has been made at this source freeze.

Private evidence root (not committed, contains real-data views): `/home/carlwilsn/agent-work/vault-chat/focus-0726-evidence/`. Clean metrics: `results-r6-clean.json`; Chrome traces: `trace-{22,26,fix}.json`; allocation profiles: `heap-*.json`; affected checks: `affected-r2.exit`, `affected-fix-r2.log`, `types-fix-r2.log`. Failed capture/adapter/recorder receipts remain alongside them and are not substituted for a pass.

Permanent regression proof: `typing-regression-result-r8.json`, `snapshot-compare-r8.exit`, `recorded-typing-fix.mp4` (actual browser screencast, not a native/Tauri recording), `typing-regression-fix.png`. The earlier r7 recorder-teardown failure is retained and was rerun, not waived.
