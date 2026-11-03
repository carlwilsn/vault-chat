# Current priority — preserve chat through viewer-root navigation

ASKS: 0% — the native same-root file-open typing regression is unresolved.
This is a narrow, independently proved draft/reader correctness fix, not a latency fix.
Base: accepted probe `2429ad5204291d694f2afd32c5ea0909e4b02811`.

## The one forward change

`App.tsx` keyed the entire Allotment, including ChatPane, by the viewer root.
Changing School2 → VC replaced the composer/reader and discarded the unsent draft,
although conversation ownership and HTTP history stayed unchanged. Remove that
second UI reset; retain the existing popout/dock key. No conversation routing,
history, engine ownership, autosizing, containment or framework changes.

Allotment's `preferredSize` updates its preference, NOT its existing width. The
production short/long-tree check initially failed (160 → 160px). Use its native
handle's `reset()` when computed fit width changes, rather than remounting chat.
The same real-pointer check now passes 160 → 301 → 160px; sash dragging reaches
230px and resizing the viewport preserves the viewer minimum and visible composer.

## Proof and checks

- Baseline `/tmp/file-open-chat-jank-1103/perf-baseline/` reproduces different-root
  composer replacement/draft loss. Same-root file opening retains the composer on
  BOTH baseline and candidate: do not claim that remount explains same-root jank.
- `/tmp/file-open-chat-jank-1103/perf-candidate-final/` proves draft, selection,
  reader DOM/scroll and conversation identity through actual folder-picker/file
  navigation. Checkpoint loads remain 1 → 1; no page errors/outbound/model calls.
- Fresh narrower `/tmp/file-open-chat-jank-1103/identity-final-pin/` checks the
  checked-in `preview/proof/viewer-chat-identity.mjs`, native Allotment refitting,
  real sash dragging and viewport resize, with screenshots and muted WebM.
  Exact committed-pin rebuild/recheck and the seven checks follow this source pin;
  their command logs and the single installed watcher result are authoritative.
- Strict original-data startup passes 110 original conversations / 10,087 original
  items, 547 native and 115 canonical prefixes, original instructions and captured
  worker authority. Actual halloween bytes / 22 public assets; genuine HTTP/Pi,
  bounded copied storage and browser IPC adapter, NOT physical Windows/Tauri.
  Original School2 storage, secrets and live histories are untouched.
- Affected pane-layout, worker-navigation and box-chat tests previously passed
  19/19; production desktop build and the new width/identity UI pass. Full seven
  and publication were not yet run at this source pin; no green/shipped claim.

## Experiments explicitly NOT retained

Native CSS autosize reduced separate trace Layout counts 81 → 29 (composer) and
81 → 27 (inline), but 81-key A/B double-rAF read-file median/p95 22.7/30.0 →
17.9/41.1ms and Ctrl+K 16.8/46.7 → 24.2/51.7ms were not a consistent latency win.
Repeated reader containment also worsened Ctrl+K median and composer p95.
Both interventions were removed. Keep CPU work, instrumented Linux browser
rendering-opportunity timing and actual Windows Event Timing distinct.
Historical diagnostic artifacts remain outside the vault; failed/interrupted runs
are not green exits. No historical proof, unrelated voice source or paused card changed.

## Delivery boundary and remaining work

Publish only `agent/file-open-chat-jank-1103`, then one exact two-line installed
watcher request. Its actual named baseline/candidate seven checks decide acceptance;
known raw server failures are not waived or called local-seven green. No manual
main merge/promotion, new service/unit/timer or shipping-framework edits.
Acceptance/publication is not Shipped: normal CI/updater and actual box plus
native laptop versions must verify. Last confirmed box v0.7.33 / `2b461889…`;
native endpoint still had five batches, latest v0.7.32, no native AFTER comparison.

Same-root native file-open latency and fullscreen/docked root remount remain
explicitly unresolved. Popout transitions are not fixed by this viewer-root change.
