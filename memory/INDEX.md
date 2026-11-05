# vault-chat source facts

These notes are rebuilt from vault-chat’s code, not AgentOS notes.
Carl’s instructions live in AGENTS.md; ASKS.md is the only plan.

- pi integration is in server/engine/; server/http.ts serves the box API.
- src/ is the React/Tauri laptop client; phone/ and board/ are separate clients.
- voice-pipeline/bot.py handles the only voice transport; server/voiceBrain.ts connects it to pi.
- Legacy Classic preferences are inert, not migrated or deleted; microphone-off Health still shows pipeline startup failures.
- src/convlog/ defines shared conversation records and projection code.
- server/convlog/ persists the feed; pi session entries are referenced by the feed.
- src/laptopPerf.ts sends bounded timing samples to /api/v1/laptop-perf.
- The installed watcher handles ship requests, captures, gates and main promotion.

- Plan cards use visible TodoWrite arguments (`src/planPlace.ts`), not cached conversation todos; Clear stays device-local.
- Phone Clear lives in the composer bottom row (`phone/src/shell/Pages.tsx`); its existing
  `boot.ts` action stores only this phone’s view cutoff, without confirmation or shared-history deletion.
- Phone push defaults off in `server/pushGate.ts`, independently of device permission/subscriptions.
  `Notify(push:true)` is one requested event, bound to its originating turn (captured before a worker queues);
  the explicit `vc_push_legacy_automatic=true` server preference alone restores automatic delivery.
  The phone subscribes only on a user tap. In-app alerts and AskUser answers are not push-gated.
  `/api/v1/alert` is a legacy automatic producer: its encrypted push/tag integration fixture must
  explicitly enable `/push/preferences`, after proving a subscription alone leaves that route silent.

- Voice exclusive bind permits retired TCP TIME_WAIT via SO_REUSEADDR, never SO_REUSEPORT; live port owners still refuse startup.
- The Python voice entrypoint binds before unrelated standard-library imports as well as audio/provider imports. Ownership tests run both ordinary startup and a blocked asyncio import against the same live owned HTTP fixture; exit 98 and untouched original listener are required within the unchanged deadline.
- Native Pi user `vcRequest` is the persisted request identity/device authority, including queue delivery. Pass that same device into the existing delivered callback before assistant output; omitting it breaks typed-speech ownership even when the visible history is correct. Never replace it with the feed's expected-device hint or inferred human text.

- Ordinary Send (including the legacy client `steer` intent) during a busy turn uses Pi native follow-up on every surface, including the active surface. A split voice continuation alone refines that thought; new voice turns and explicit Send now retain the existing interrupt path. Request identity/device stays in native `vcRequest`; generated surface context is never prepended to human text. The in-process session fixture must apply the same public user `message_end` replacement before append, as genuine Pi and the RPC fixture do.
