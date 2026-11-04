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
