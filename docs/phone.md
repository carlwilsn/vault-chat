# Phone app — vault-chat in your pocket

## North star

One surface on the phone that matches how the owner actually works: short
conversational bursts, trust-but-verify run monitoring, and decisions made
on the move. The box does everything; the phone is a thin, honest window.

The bar, taken from real usage pain (June 2026 transcript audit):

- **No more walls.** Replies stream in and render as real markdown — no
  4000-char plain-text chunks, no stripped tables.
- **No more "How's it going? It's been over 15 min."** Run state is a
  glance, not a model turn: live status strip, heartbeats, a deterministic
  kill button.
- **No more "details in the goal doc" pointing at a file the phone can't
  open.** Vault files (markdown, PDFs, images) open in a tap.
- **No more silence.** Push notifications carry the coach check-in, ALERT
  markers, and run-done pings — through Apple's push service, so they land
  even when the tailnet VPN is idle.

Telegram has been removed entirely — the phone cockpit (PWA + Web Push) is the
sole remote surface. The old Telegram subsystem (poller, markdown stripper,
chunker, per-vault bot config, outbound send) is gone; scheduled briefings now
surface only in the Alerts feed + push.

## Architecture

Everything rides the existing phone-voice plumbing (`voice_server.rs`):
tiny_http on the box, Tailscale HTTPS (`tailscale serve`) as transport,
the per-machine token as the gate, and the proven relay pattern —
HTTP request → `emit()` to the webview → frontend answers by `reqId`
over an mpsc channel (`voice_tool_respond`).

```
phone (PWA)                    box (Rust)                  box (webview TS)
GET  /phone            →  serve embedded page (token-free shell)
GET  /conversations    →  read conversations/*.jsonl directly
GET  /conversation?id  →  read + strip attachments, cap content
GET  /file?path=       →  within_vault() → bytes + mime
GET  /poll?after=N     →  event ring (long-poll) ←  phone_broadcast(json)
POST /message          →  relay "phone:msg"   →   sendMessage(targetConvId)
POST /kill             →  relay "phone:kill"  →   abortRun(convId)
GET  /status           →  relay "phone:status" →  heartbeats + runs
GET  /schedules        →  relay "phone:schedules" → readSchedules()
POST /schedule         →  relay "phone:schedule"  → toggle/delete
POST /push/subscribe   →  store subscription on disk
                          push send: TS encrypts (WebCrypto, RFC 8291)
                          → push_post (reqwest) → APNs/FCM web push
```

Key decisions:

- **Streaming without core changes.** Background runs already mirror
  every delta into `store.convRuntime[convId].streamingText`
  (chat-controller.ts). The phone host subscribes to the store and
  forwards diffs into a long-polled event ring — SSE proved buffer-prone
  through tiny_http → `tailscale serve` → iOS. Foreground runs forward
  `store.streamingText` for the active conversation the same way.
- **Phone messages run like Telegram messages**: background target runs
  via `sendMessage(text, …, convId)` — parallel to the foreground agent,
  never steals desktop focus. Unlike Telegram, phone-sourced runs use the
  **desktop default model**, not the cheap Telegram brain — the phone is a
  full-fidelity surface.
- **Busy threads queue, then auto-run.** A message sent while that thread
  is mid-run is held and dispatched when the run ends (the Telegram
  "black hole" — message absorbed, no reply until you text again — does
  not exist here).
- **Web Push with zero new Rust deps.** RFC 8291 (aes128gcm) encryption
  and the VAPID ES256 JWT are done in the webview with WebCrypto; Rust
  only does the raw POST (`push_post`, reqwest + rustls already in tree).
  VAPID keys are generated once and live in localStorage; subscriptions
  live in the app config dir. Push triggers piggyback the exact delivery
  semantics that already exist: whatever text is actually delivered to
  Telegram (after [[SILENT]] / quiet-unless-ALERT filtering) is mirrored
  to push, plus run-done/error for phone-sourced conversations. A quiet
  supervisor stays quiet on push too.
- **PWA, not a store app.** Added to the iOS home screen (standalone),
  with a service worker only for push + notification clicks. No offline
  cache in v1 — the box being reachable is the product. The manifest has
  deliberately NO `start_url`: iOS would launch it verbatim and drop the
  `?token=` from the added link (the home-screen 401 bug); without it the
  add-time URL launches and the page persists the token to the web app's
  own storage container.

## Security model (unchanged from phone voice, stated honestly)

- Tailscale is the perimeter; the shared token is defense-in-depth. The
  server binds 0.0.0.0 (the LAN exposure trade-off predates this page).
- The page SHELL at /phone is token-free (static HTML, zero vault data);
  every data route stays token-gated. The token rides in the URL for page
  loads and /poll (EventSource-era constraint kept: home-screen launch
  URLs keep their query). Mutating routes also accept `X-Vault-Token`.
- The relay executes with **full desktop parity** — same as phone voice
  tool calls since the tool-parity commit. This page adds /message (runs
  the agent, which can Bash) and /kill. Anyone with the token and tailnet
  access can drive the agent; that is the explicit, accepted model:
  "the user owns the agent."
- `/file` is read-only and vault-contained (`within_vault`, symlink-safe
  via canonicalize).

## v2 additions (the owner's feature round)

- **In-app keyboard** (`inputmode=none` + custom QWERTY) — kills the iOS
  form-assistant bar. Commit-on-touch-down, key-pop bubbles, shift
  one-shot + double-tap caps lock, backspace auto-repeat, double-space
  period, number/symbol layers. Drawer toggle falls back to the system
  keyboard so a keyboard bug can never lock typing out.
- **Supervisor thread**: a pinned entry point that binds to ONE
  conversation with `role: "supervisor"`. Its turns get the vault's
  `supervisor.md` orchestrator prompt (new `supervisorMode` in runAgent)
  WITHOUT the Telegram brevity contract — rich surface, full role, and
  the desktop default model rather than the Telegram brain.
- **Workers are visible**: `StartWorker` conversations are tagged
  `source: "worker"` and grouped in the list with live run dots
  (merged from /status).
- **Schedules are manageable**: the drawer lists every schedule with
  cadence/last-fired, and can enable/disable/delete (relayed to the
  scheduler's own CRUD). Creating/editing schedules stays an agent task —
  ask the agent; it has the Schedule tool.
- **One-off lifecycle fix** (app-wide, not just phone): fired `once`
  schedules now auto-disable — at fire time, plus a startup sweep that
  cleans rows fired by older builds.

## Removed with Telegram

- Off-vault inbound (texting a vault that isn't open in the UI) is gone —
  the phone talks to the currently-open vault only.
- The 7am daily coach now surfaces in the Alerts feed + push (no Telegram
  mirror); `sendViaTelegram` schedules no longer exist.

## v1 limitations (known, deliberate)

- One vault: whatever the box has open.
- No image *upload* from the phone yet; files flow box→phone only.
- No math rendering in chat (KaTeX is heavy; markdown only).
- Push on iOS requires: page added to home screen, notifications enabled
  from the in-page button (user gesture), and iOS 16.4+. Subscriptions
  can be dropped by iOS; the page re-checks and re-subscribes on open.
- No autocorrect/dictation on the in-app keyboard (owner-accepted trade;
  the drawer toggle restores the system keyboard any time).
