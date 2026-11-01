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

## Shipping reset (Carl, 2026-10-30; supersedes earlier auto-ship A rules)
- Agents publish agent branches; one separately installed box script runs the seven baseline/candidate
  gates and promotes main by native git compare-and-swap, with no new named failures or lost coverage.
  No permit, bootstrap importer, receipt authority or candidate-bound recorder in acceptance. Actual UI
  checking remains the agent's responsibility; post-release authenticated device health and rollback
  remain authoritative for Shipped. First activation goes through Claude once, not self-acceptance.
- See `docs/simple-ship.md` for exact installation/transport requirements and native rollback's exact-tree
  trust boundary. Forward branches cannot remove coverage; only the host-generated recorded-range revert
  can remove its feature's added tests, with all other gates unchanged. Initial architectural deletion's
  identities are explicit RETIRED entries, never an ongoing gate waiver.

## Final initial-reset audit (2026-10-31)
- A zero-new-failure identity pair is not green when 114 required/obsolete mixed cases disappear.
  The final 8e→8b pair is complete but strict comparison rejects retirement; the dependency scope
  is a private existing lock-matched copy, not host npm-ci acceptance provisioning.
- Review retired assertions individually: historical-media sanitization, original ask/self-check,
  restart recovery and actual Shipped/card UI may remain required after their old authority route
  disappears. Explicit initial Claude review cannot itself make the strict self-install route work.
  See `docs/simple-ship-final-report.md` and exact audit; no new waiver/permit is implied.

## Private native-package closure
- Resolving only a top-level scoped directory before copying is insufficient: its child
  packages can still be host-home symlinks (`@esbuild/linux-x64`, `@rollup/*`). The native
  sandbox correctly cannot resolve those donor paths. Dereference the complete genuine
  lock-matched package closure into a private dependency tree (existing GNU cp -aL with
  reflinks is finite here); do not bind a whole writable donor or override binary versions.
  Before a long fixture, invoke actual esbuild transform/build and Vite/Vitest through
  the unchanged native gate sandbox/private caches. A host --version check misses this.

## Pure chat renderers must not eagerly initialize browser stores (2026-10-30)
- A runtime useStore import added for native child navigation made importing chatExtras
  initialize localStorage in Node, breaking both devjobs at file level and historical
  reviewCard rendering. The real browser navigation still worked. Keep renderer imports
  type-only and supply child availability from the existing store-owning pane; prove
  original detailed-reporter red/green plus real native child/parent navigation. A pure
  render test is not obsolete merely because its historical Keep text is old authority.

## Historical chat media selectors
- `ChatImage` reads a public vault path through the normal file API, then displays an
  opaque blob URL. A filename-in-`img.src` locator cannot find that image, even when
  the original historical schema/reader works. Use its genuine accessible identity,
  require visible + native decode/naturalWidth, correlate the exact public API path,
  and hash rendered bytes against the original fixture. Do not weaken to existence
  or rewrite old fixture schemas. The retained df21 actual-App 15s failure exposed it.

## Full conversation contract is not EngineConv
- `GET /conversation?full=1` returns `{id,title,source,status,full,meta,messages}`;
  native worker rows and parent session identity are in **meta.subagents / meta.threadId**.
  B's retained genuine phone run failed at 24.6s by reading a nonexistent top-level mirror,
  not by timing out or losing children. Read the current serializer and phone feed reducer
  before adding product fields. Bind children through their actual Delegate toolCallId,
  returned nativeWorkerId, session header/cwd and original request, not row position.
  A fast replay of retained native journals through the same serializer catches this call-contract
  error before spawning another long UI run. Such a replay is not new native UI/shipping evidence.

## Collapsed file-tree recorder input
- A fresh `folders-final` preview opens the synthetic laptop vault `summer-demo`, not the private server's
  `school2` working copy. Its top-level directories start collapsed: no Markdown row is mounted yet. Click
  the known `reading` directory, then the exact seeded `reading/README.md` and assert rendered content before
  testing a vault switch; `.first()` over Markdown rows times out before reaching either picker. Preserve DOM,
  IPC calls and read-only store/API observations on failure without replacing the primary error. This is a
  recorder correction, not a product empty-tree fix or permission to migrate real folders.

## Context audit cascades and native input exactness
- A failing first-turn snapshot aborts the rest of that test: later snapshots then miss the Ctrl+L activity and
  changed standing rule posted afterward. Inspect the first diff and fix fixture paths (`project-memory.md`,
  not `memory.md`) before updating snapshots; never accept the missing later activity as a product change.
- Viewer-root hints belong to pi's existing hidden typed context, not a new prefix on native user input. Capture
  the registered viewer at request receipt separately from conversation ownership/project cwd. Native Read/Bash
  relative paths still use cwd; a context hint does not install a path resolver. Assert exact native input.

## Shared dependency trees are read-only inputs
- Vitest `--no-cache` disables result caching but does not stop Vite's bundled TS
  config from writing `node_modules/.vite-temp`. With an immutable donor closure,
  use `--no-cache --configLoader runner`, `env -i`, private HOME/tmp/cache and a
  read-only donor mount. Preview's optimized-deps cache also defaults under
  node_modules: use a genuine private copied closure, never a writable donor or
  hardlinks. A skipped/blocked check is not a pass; retain failed-run receipts.
