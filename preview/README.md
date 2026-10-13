# vault-chat preview harness (dev only)

The real desktop frontend and the real phone page, running in a browser against a fake backend. Nothing here is imported by `src/` or bundled into the app.

```
npm run preview                         # http://localhost:1500 — this tree only
npm run preview -- --after ../other-wt  # compare with another checkout
npm run preview -- --after p3-settings  # …or a git ref (exported to preview/.cache, read-only)
cd preview && npm install               # once: playwright-core for the tools below
node preview/test.mjs [--side both]     # self-test: every scenario, 0 console errors / unknown commands / outbound
node preview/record.mjs chat-tools --side both   # video → preview/out/videos/
node preview/inventory.mjs --runtime    # computed-style pass for the style inventory
node preview/fixtures/build.mjs --vault C:\Users\wada2\github\school2   # private fixture + REDACTION-REPORT.md
node preview/tools/tour-check.mjs http://127.0.0.1:1500   # play the whole Tour; shots + result.json → preview/proof/tour/
node preview/conv-check.mjs [--url http://127.0.0.1:1521/after]   # the full test conversation (A box, B local, C phone; both option sets): every element asserted, shots → preview-proof/
```

**Tour**: the ▶ Tour button (or `http://localhost:1500/#tour`) plays every new thing full screen: a title card, then the steps live on the before tree ("Before · today"), then the same steps on the after tree ("After · new"; once per option where there is a choice to make), then the next change. It autoplays; Space pauses, ←/→ step through phases, R replays the phase, Esc exits. Slides: `tour/tour.json`. The paced player is `runtime/tour.ts` (a pointer that glides to what it clicks, typing a character at a time, key badges, tooltips, a pulse on what changed — after side only).

- **Runner**: `serve.mjs` spawns one Vite dev server per tree (`vite-child.mjs`, cwd = tree; :1520 before, :1521 after, served under `/before/` and `/after/`) and serves the shell (`shell/`). The shell reverse-proxies both sides (HTTP and the HMR websocket) on its own port, so every frame is same-origin with it — no cross-port iframes (the Claude desktop app's browser pane can't show those). Each side gets its own localStorage view (`runtime/storage.ts`).
- **Boot**: `plugin.mjs` injects `runtime/boot.ts` before `/src/main.tsx`. It installs a fake `__TAURI_INTERNALS__` (`runtime/ipc.ts`), the network wall (`runtime/net.ts`: model APIs answered by `runtime/llm.ts`, everything else refused), a scenario clock, localStorage and an in-memory vault.
- **Backend**: `runtime/backend/` — the repo's own `server/commands` ports of lib.rs run on an in-memory FS, plus an in-memory git, scripted sync/keys/shell, and inert host commands. An unknown command shows "not faked: <cmd>".
- **Scenarios**: `scenarios/index.ts` (desktop + phone), all built on `scenarios/world.ts`; the phone's MockDB comes from `scenarios/phone.ts`.
- **Data**: `fixtures/synthetic/` (committed) + `demo-vault/` under `guide/`. Private bases built from a real vault land in `fixtures/private/` (gitignored until the redaction report is approved).
- `window.__preview` in a frame: `calls()`, `unknown()`, `refused()`, `llm()`, `release()` (finish a held stream), `advance(ms)` (scenario clock), `emit(event, payload)`.
