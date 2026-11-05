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
  Existing maker entry IDs are not destination permission: recheck their sends
  too. Native wake/job/delegate/resume inputs are not new human interactions.

- Send now's existing replay adapter had an enqueue-after-settle race: Pi RPC
  steer/follow_up accepts an idle queue without starting a run. A fast replacement
  prompt could settle before the remaining input's asynchronous native input hook
  finished. This is a patch to the duplicated replay boundary, not a second queue:
  preload the original PiFeed's undelivered records into Pi before the replacement
  prompt, preserving kind/identity/context/device. Keep pending through interruption
  and clear each only when its actual native entry arrives (including the selected
  prompt). A bounded public Pi input hook reproduces it on baseline 6c7078a2 too;
  SDK files remain read-only. Wakes cannot acquire human device/board permission.
