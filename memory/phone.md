# Phone (`phone/`, the home-screen PWA)

- **Return inserts a newline; the send button sends.** He composes multi-line on the iOS keyboard and rejected
  Shift+Enter (an iOS soft keyboard has none). Keep `enterkeyhint="enter"` (see `phone/src/boot.ts`). The desktop
  default is the opposite (Enter sends). Don't flip the phone default.
- **Viewport unit, not shell height.** The installed PWA showed a dead strip under every screen. Measured on device:
  in standalone mode `100dvh`/`100svh` come up short by the safe-area top (812 vs 874 px) while `100lvh` is the full
  screen; in a Safari tab they agree, which is why every fix "worked" elsewhere. Fix: `100dvh` by default,
  `100lvh` under `@media (display-mode: standalone)`. Four earlier ships (JS height pinning, `position:fixed`,
  keyboard padding) failed because they treated it as a layout bug.
- **Keyboard math is off by exactly the safe-area top** if it mixes `documentElement.clientHeight` (the short
  viewport) with a body sized to `100lvh`. Gate "keyboard up" on the clientHeight value; add the difference back only
  while it is up.
- **Sheets must not move when the keyboard opens.** "The top should not expand because I opened my keyboard; keep it
  in the same spot." Lifting the whole sheet with a transform dragged its top into the notch. Pattern that held: no
  transform on the open sheet; while editing, bottom padding equal to the keyboard height so only the composer rises.
  Verify that the top's y is invariant.
- **Diagnose iOS layout on the device**: a temporary on-screen readout (probe divs for `100dvh/svh/lvh`, safe-area
  insets, body rect). `100lvh > 100dvh` with no gap under the body = a short viewport unit.
- **Home-screen icon is a PNG** served as `apple-touch-icon` (`/icon.png`). iOS silently ignores SVG touch icons and
  invents a beveled snapshot. His design: pure black ground, white strokes, full-bleed (iOS masks the corners). iOS
  caches the icon at add time: he must remove and re-add the app to see a new one.
- **A push tap must land on the right thread across three layers:** the push payload carries the thread URL; the
  service worker, when the app is already open (the normal iOS case: backgrounded, not closed), must post a
  `deeplink` message, not just `focus()`; the page must route on that message and on a `?conv=` cold start. A tap that
  opened his last chat instead of the asking thread was all three broken at once.
- **Swipes on lists must lock the axis** (non-passive touchmove, `preventDefault` once horizontal) or every swipe
  fights vertical scroll and feels random.
- **Background refreshes must not rebuild a list he is touching** (it threw away a two-tap "armed" clear-all). Defer
  background rebuilds while a list is in use; user-initiated reloads stay immediate.
- **Work Wi-Fi blocks the phone's Tailscale tunnel** (cellular is fine). "Phone can't connect" is often that, or the
  box restarting after an update (`box.md`), not an outage.
