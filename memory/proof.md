# Proof: what counts, and the traps that faked a pass

"Done" = the gates in AGENTS.md pass **and** the change is seen working in the real UI. Every rule below exists
because something passed a weaker check and broke for Carl.

## Real UI, real input
- **Mocks and fixtures prove the mock.** The phone's old `?mock=1` page had its own data and render path: a fix was
  "verified" there and never touched what Carl hit; a server endpoint that hand-picked JSON fields dropped a new
  field (`completedAt`, `direct`) so the real app broke while the mock (which had the field) passed. *Apply:* verify
  against the real server path (the preview harness's `realbox` mode or the box), and when a client reads a new
  field, check the server code that builds that response actually includes it.
- **Real input, not synthetic events.** A window-drag "worked" via a debug global and via JS-dispatched
  `PointerEvent`s while real dragging was broken (pointer capture retargeted the events). Only CDP
  `Input.dispatchMouseEvent`/`dispatchKeyEvent` exposed it. A debug hook proves the handler runs, never that the user
  can reach it.
- **Reproduce the bug first**, on the real thing, then show the fix removes it.
- **Sub-frame flashes need a MutationObserver.** 200 ms polling and screenshots missed a reply that vanished for
  ~530 ms. Read the mutation *records* (addedNodes/removedNodes), not the state in the callback — an add+remove in one
  batch is invisible otherwise.
- **Never gate live UI on a persisted status field.** The on-disk "running" flag was written before the in-memory
  flip, so it always read idle and the live view never showed. Use the live event stream / health for liveness.
- **Preview browsers can lie about compositor properties** (transform, opacity, filter) and hang on screenshots.
  DOM, class, colour and geometry reads were reliable; motion feel needs a real device or a recording.
- **iOS bugs: measure on the device.** Four ships failed on reasoning alone before an on-screen readout found the
  cause (see `phone.md`).

## Tooling traps
- **Never pipe a verify command.** `cargo check | tail` reported exit 0 while cargo failed; the commit claimed
  "compiles clean" and CI broke. Keep the exit code (`cmd >log 2>&1; rc=$?`) and read the output.
- **`grep` treats big single-file HTML as binary** and silently drops matches: use `grep -a`.
- **Line endings:** an editor flipped a whole file to CRLF (a 4,700-line phantom diff). Normalize to LF before
  committing.
- **Before adding a tiny helper** (`now_ms`, `clamp`) to a big file, grep for an existing one — a duplicate broke CI.
- **A fetch deadline includes its body.** Clearing an abort timer after `fetch()` returned headers let an OpenRouter
  catalog body stall engine startup forever; the server listened but never became engine-ready. Keep the deadline
  through body consumption and cleanup in `finally`; do not weaken readiness checks to accept a listening socket.
- **Give age-based file fixtures explicit mtimes.** Filesystem timestamps can be fractions of a millisecond ahead
  of `Date.now()` on the same tick; a zero-age sweep then correctly leaves a just-written file. Set known ages
  rather than sleeping or changing production cutoffs.
- **Tests never use his speakers** (AGENTS.md). A headless browser with autoplay once played test speech through the
  laptop while he worked; he thought voice was broken. If he reports phantom audio, look for test processes first.
- **Don't drive a screen or pointer he is using**; it fights him for the input. Use your own thread and test data,
  never his current conversation (a test once typed into his live chat).

## Stateful fixture timing
- **Hold delivery, not the next request.** In boxchat, setting FakeBox's poll delay after a long-poll was already
  waiting let the echo beat the optimistic-pending assertion; its skipped cleanup then cascaded into nine failures.
  Use `holdPolls()` and release in `finally`. Assert pending after the POST is accepted and the box's log contains
  the echo, then explicitly release delivery. Larger sleeps or deleting the pending assertion do not test the contract.

## Shared working copies
Several agents and sessions have worked in the same checkout at once. One switched branches mid-session and the next
`rebase`+`push` went to the wrong branch; another swept someone else's edits into its commit. *Apply:* re-check the
current branch before rebase/push; when `git status` shows files you didn't touch, someone else is live — commit only
your own hunks, never `git add` a shared file wholesale; never `reset --hard`/`checkout` over another actor's tree.
(In this project your work is on your own clone and branch, which removes most of this — the rule still holds for the
project's main folder and Carl's machines.)

## Self-tests
Carl wants you to test on your own, end to end, without him in the loop — but cost-free by default (simulated GPU
boxes, local processes); real spend stays his call. Never trust a test agent's own report: read the ground truth it
was supposed to produce (files, logs, the real clock). A run that wrote its own heartbeat log once fabricated
timestamps and "verified" itself.
