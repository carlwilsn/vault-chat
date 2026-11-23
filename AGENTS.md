# vault-chat

Claude Code with a window around it: the box server, the Tauri laptop app, the phone app (alerts, notes) and voice. Every principle is in the constitution, already in your system prompt (server/engine/prompt.ts). This file is a code map; read the code for how things work.

## Map

- server/: the box. main.ts (boot), http.ts (routes).
  - model/: the shared nouns (settings, notes, alerts, pages, workspace, history, jobs, chats); boxOffers.ts turns each into the box:<noun> offer PluginRead/PluginAct reach.
  - engine/: engine.ts (threads and turns), prompt.ts (role prompt + constitution), claude/ (the only code that drives Claude Code: session, backend, side threads, workers).
  - mcp/: the MCP transport; tools are defined in engine/ and server/*Tool.ts (e.g. pluginOffersTool.ts = PluginRead/PluginAct).
  - context/: builder.ts (thread instructions and the per-turn prefix), projects.ts.
  - convlog/: the conversation event log. test/: vitest, context-audit snapshots in test/__snapshots__/.
- src/: the laptop frontend (React). App.tsx, boxChat.ts (feed + intents), convlog/ (the reducer every client folds), plugins/ (app parts app/<name>, placed by places.ts), agencyCoverage.ts (parity map).
- src-tauri/: the native shell (Rust). Every command the frontend invokes must be in lib.rs shell_commands!; after changing a command's signature regenerate src-tauri/shell-abi.json with `npx tsx scripts/shell-abi.ts`.
- phone/: the phone app. voice-pipeline/: voice transport (Python).
- preview/: UI harness with fakes, `npm run preview` → http://localhost:1500/after/?scenario=<name> (scenarios in preview/scenarios/).
- scripts/: release, core bundle (core-publish.ts, core-boot.ts), event-log tools.
- test/harness/: frontend tests (node --test). test/selftest/: the app's self-test step files.

## Test (the ship gate's six)

```
npx tsc --noEmit -p . && npx tsc --noEmit -p phone && npx tsc -p server/tsconfig.json
npm run test:harness
npm run test:server
NODE_OPTIONS=--max-old-space-size=6144 npm run build:server   # plus `npx vite build` for desktop changes
```

Test instances never use the live ports 8848/8857.

## Parity gate

server/test/agencyCoverage.test.ts (with src/agencyCoverage.ts: every UI file and control names the offer action it runs or an exemption), test/harness/offerParity.test.ts (a control's data-offer names a real action) and server/test/model.test.ts (every UI action of a noun is reachable in server/model/).

## Ship

Branch agent/<name>, commit, then `~/agent-work/vault-chat/bin/submit <worktree> <name> "<title>"` (rebases on main, pushes, queues the request). Exit 75 means another ship is running or queued: wait in the background and retry. Wait for ~/agent-work/vault-chat/ship-results/<name>.result in the background; on failure read the .log, fix, resubmit. Only the ship script promotes main: never merge or push main, never edit the installed simple-ship copy. The box builds the frontend from main as a hot core bundle and swaps its own server; .github/workflows/ship.yml builds an installer only when the native shell changes.
