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
  prompt as native follow-ups, preserving identity/context/device and answering
  the selected input first. Keep pending through interruption
  and clear each only when its actual native entry arrives (including the selected
  prompt). A bounded public Pi input hook reproduces it on baseline 6c7078a2 too;
  SDK files remain read-only. Wakes cannot acquire human device/board permission.
- Recheck that SAME original feed after native clear/abort: a user entry may land
  while interruption is in flight. Never replay a pre-abort snapshot already
  delivered by Pi; if the selected input landed, continue as nonhuman resume.
  Native A's local held provider must release on the real HTTP `now` success
  AFTER Pi abort, not merely relay intent receipt (which races the old step).
  Keep exact original prefix/private-appends and native provider-input guards.

- Integrating device sense with accepted typed speech must preserve TWO native
  bindings: the entry's physical `device` (phone/board/laptop) for visual routing,
  and its original `via: voice` actor for the voice delivery callback. Passing a
  phone device as that callback's origin accidentally treats spoken input as typed
  and closes its active completion. Derive voice origin from the matched native
  Expected record, never the current viewer; keep Send now prompt callbacks as
  well as steer/queue callbacks, and clear pending only after actual entry delivery.
  The native unpaid queue test now opens its owned phone call AFTER held input,
  then checks SECOND/FIRST exact native inputs, per-device speech exactly once,
  and wake refusal. The call's exact one-time rules prefix belongs on SECOND;
  its local provider must advertise the accepted Haiku model too. Neither fixture
  adjustment changes the native exact-input or pending-before-delivery guards.
