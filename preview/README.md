# vault-chat preview harness (dev only)

The real desktop frontend and the real phone page, running in a browser against a fake backend. Nothing here is imported by `src/` or bundled into the app.

```
npm run preview                         # http://localhost:1500 — this tree only
npm run preview -- --after ../other-wt  # compare with another checkout
npm run preview -- --after p3-settings  # …or a git ref (exported to preview/.cache, read-only)
cd preview && npm install               # once: playwright-core for the tools below
node preview/test.mjs [--side both]     # self-test: every scenario, 0 console errors / unknown commands / outbound
node preview/inventory.mjs --runtime    # computed-style pass for the style inventory
node preview/fixtures/build.mjs --vault C:\Users\wada2\github\school2   # private fixture + REDACTION-REPORT.md
```

One smoke path stays (report 24 piece E, 11-22): this runner, its runtime and scenarios, `test.mjs` (the self-test),
`server/test/pdfTyping.test.ts` (in the ship gates), `scripts/core-boot.ts` and `scripts/typing-bench.mjs` (docs/perf-baseline.md).
The one-off proof tools, screenshots, the Tour and the record / conv-check scripts are in git history (main afa8ac7d).

**Narrated scenarios** (conv-a, conv-a-alt, phone conv-c, conv-c-alt): opened directly (`/after/?scenario=conv-a`, `/after/phone?scenario=conv-c`) they play with a tutorial caption before each step — a small card with the step's title, one sentence, a counter (3/19) and a soft outline on what it names. Space pauses/plays, → finishes this step quickly and moves on, ← goes back a step (the page replays up to it), −/+ or the ½× 1× 2× buttons set the speed (1× = the steps 2.5× slower than the plain play, plus a moment per caption; conv-a is about 2 min at 1×), R starts over. URL: `&narrate=0` plays it as before (fast, no captions — the self-test passes this; under automation it is off unless `&narrate=1`), `&speed=2`, `&narrateAt=5`, `&paused=1`. The captions live next to the steps in `scenarios/convFull.ts` (`beatsA`, `beatsC`); the player is `runtime/narrate.ts` (phone: `runtime/narratePhone.ts`). `node preview/test.mjs --narrated` plays them to the end; `node preview/tools/narrate-shots.mjs --id conv-a [--phone]` screenshots each step → preview-proof/narrated/.


- **Runner**: `serve.mjs` spawns one Vite dev server per tree (`vite-child.mjs`, cwd = tree; :1520 before, :1521 after, served under `/before/` and `/after/`) and serves the shell (`shell/`). The shell reverse-proxies both sides (HTTP and the HMR websocket) on its own port, so every frame is same-origin with it — no cross-port iframes (the Claude desktop app's browser pane can't show those). Each side gets its own localStorage view (`runtime/storage.ts`).
- **Boot**: `plugin.mjs` injects `runtime/boot.ts` before `/src/main.tsx`. It installs a fake `__TAURI_INTERNALS__` (`runtime/ipc.ts`), the network wall (`runtime/net.ts`: model APIs answered by `runtime/llm.ts`, everything else refused), a scenario clock, localStorage and an in-memory vault.
- **Backend**: `runtime/backend/` — the repo's own `server/commands` ports of lib.rs run on an in-memory FS, plus an in-memory git, scripted sync/keys/shell, and inert host commands. An unknown command shows "not faked: <cmd>".
- **Scenarios**: `scenarios/index.ts` (desktop + phone), all built on `scenarios/world.ts`; the phone's MockDB comes from `scenarios/phone.ts`.
- **Data**: `fixtures/synthetic/` (committed) + `demo-vault/` under `guide/`. Private bases built from a real vault land in `fixtures/private/` (gitignored until the redaction report is approved).
- `window.__preview` in a frame: `calls()`, `unknown()`, `refused()`, `llm()`, `release()` (finish a held stream), `advance(ms)` (scenario clock), `emit(event, payload)`.
