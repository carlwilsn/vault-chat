# Reproduction

- Reproduce the bug on the real thing first.
- Prefer real input over synthetic events.
- Never pipe a verify command; preserve its actual exit status.
- Judge speed changes by Carl’s laptop probe numbers, not a substitute benchmark.

- Native image proof must check exact source bytes, decoded dimensions and viewport hit-testing before the screenshot. WebKitGTK bitmap clipboard can expose no pixels; report HTML-inline clipboard proof as such, not Windows bitmap-paste proof.

- Phone bottom-follow uses the viewport latch and native scroll anchoring/ResizeObserver. A queued programmatic scroll can arrive after image decode enlarged the gap; only upward motion/input releases the latch, not that new gap. Keep image URLs/ownership and the shared conversation fold independent of this layout state.

## Device routing
- A poll proves reachability only, never where Carl is. Show/board policy reads the
  last delivered human input in the owning native conversation feed. Keep voice's
  `via: voice` separate from its actual phone/board/laptop origin. Deferred workers
  retain the original request's permission but default to the current delivered
  interaction, not a later request's explicit iPad permission or ambient focus.
