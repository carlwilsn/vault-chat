# vault-chat source facts

These notes are rebuilt from vault-chat’s code, not AgentOS notes.
Carl’s instructions live in AGENTS.md; ASKS.md is the only plan.

- pi integration is in server/engine/; server/http.ts serves the box API.
- src/ is the React/Tauri laptop client; phone/ and board/ are separate clients.
- voice-pipeline/bot.py handles voice transport; server/voiceBrain.ts connects it to pi.
- src/convlog/ defines shared conversation records and projection code.
- server/convlog/ persists the feed; pi session entries are referenced by the feed.
- src/laptopPerf.ts sends bounded timing samples to /api/v1/laptop-perf.
- The installed watcher handles ship requests, captures, gates and main promotion.

- Plan cards use visible TodoWrite arguments (`src/planPlace.ts`), not cached conversation todos; Clear stays device-local.
