# Phone app â€” vault-chat in your pocket

## North star

One surface on the phone that matches how the owner actually works: short
conversational bursts, trust-but-verify run monitoring, and decisions made
on the move. The box does everything; the phone is a thin, honest window.

The bar, taken from real usage pain (June 2026 transcript audit):

- **No more walls.** Replies stream in and render as real markdown â€” no
  4000-char plain-text chunks, no stripped tables.
- **No more "How's it going? It's been over 15 min."** Run state is a
  glance, not a model turn: live status strip, heartbeats, a deterministic
  kill button.
- **No more "details in the goal doc" pointing at a file the phone can't
  open.** Vault files (markdown, PDFs, images) open in a tap.
- **No more silence.** Push notifications carry the coach check-in, ALERT
  markers, and run-done pings â€” through Apple's push service, so they land
  even when the tailnet VPN is idle.

Telegram stays wired up until this surface has earned the 7am coach for a
full week without a missed ping. Then the Telegram subsystem (poller,
markdown stripper, chunker, per-vault bot config) can be deleted.

## Architecture

Everything rides the existing phone-voice plumbing (`voice_server.rs`):
tiny_http on the box, Tailscale HTTPS (`tailscale serve`) as transport,
the per-machine token as the gate, and the proven relay pattern â€”
HTTP request â†’ `emit()` to the webview â†’ frontend answers by `reqId`
over an mpsc channel (`voice_tool_respond`).

```
phone (PWA)                    box (Rust)                  box (webview TS)
GET  /phone            â†’  serve embedded page
GET  /conversations    â†’  read conversations/*.jsonl directly
GET  /conversation?id  â†’  read + strip attachments, cap content
GET  /file?path=       â†’  within_vault() â†’ bytes + mime
GET  /events (SSE)     â†’  register client â†â”€â”€â”€â”€â”€â”€  phone_broadcast(json)
POST /message          â†’  relay "phone:msg"   â†’   sendMessage(targetConvId)
POST /kill             â†’  relay "phone:kill"  â†’   abortRun(convId)
GET  /status           â†’  relay "phone:status" â†’  heartbeats + runs + schedules
POST /push/subscribe   â†’  store subscription on disk
                          push send: TS encrypts (WebCrypto, RFC 8291)
                          â†’ push_post (reqwest) â†’ APNs/FCM web push
```

Key decisions:

- **Streaming without core changes.** Background runs already mirror
  every delta into `store.convRuntime[convId].streamingText`
  (chat-controller.ts). The phone host subscribes to the store and
  forwards diffs into a long-polled event ring (SSE proved buffer-prone through tailscale serve / iOS). Foreground runs forward
  `store.streamingText` for the active conversation the same way.
- **Phone messages run like Telegram messages**: background target runs
  via `sendMessage(text, â€¦, convId)` â€” parallel to the foreground agent,
  never steals desktop focus. Unlike Telegram, phone-sourced runs use the
  **desktop default model**, not the cheap Telegram brain â€” the phone is a
  full-fidelity surface.
- **Busy threads queue, then auto-run.** A message sent while that thread
  is mid-run is held and dispatched when the run ends (the Telegram
  "black hole" â€” message absorbed, no reply until you text again â€” does
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
  cache in v1 â€” the box being reachable is the product.

## Security model (unchanged from phone voice, stated honestly)

- Tailscale is the perimeter; the shared token is defense-in-depth. The
  server binds 0.0.0.0 (the LAN exposure trade-off predates this page).
- The token rides in the URL for page loads and SSE (EventSource cannot
  set headers; home-screen launch URLs keep their query). Mutating routes
  also accept `X-Vault-Token`.
- The relay executes with **full desktop parity** â€” same as phone voice
  tool calls since the tool-parity commit. This page adds /message (runs
  the agent, which can Bash) and /kill. Anyone with the token and tailnet
  access can drive the agent; that is the explicit, accepted model:
  "the user owns the agent."
- `/file` is read-only and vault-contained (`within_vault`, symlink-safe
  via canonicalize).

## What stays on Telegram until parity

- The 7am daily coach (`sendViaTelegram` schedules) â€” mirrored to push,
  delivered to both during the trial week.
- Off-vault inbound (texting a vault that isn't open in the UI). The
  phone page talks to the currently-open vault only in v1.

## v1 limitations (known, deliberate)

- One vault: whatever the box has open.
- No image *upload* from the phone yet (Telegram photoâ†’vision flow stays
  for that); files flow boxâ†’phone only.
- No math rendering in chat (KaTeX is heavy; markdown only).
- Push on iOS requires: page added to home screen, notifications enabled
  from the in-page button (user gesture), and iOS 16.4+. Subscriptions
  can be dropped by iOS; the page re-checks and re-subscribes on open.
