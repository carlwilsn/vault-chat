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
```

- **Runner**: `serve.mjs` spawns one Vite dev server per tree (`vite-child.mjs`, cwd = tree; :1520 before, :1521 after) and serves the shell (`shell/`).
- **Boot**: `plugin.mjs` injects `runtime/boot.ts` before `/src/main.tsx`. It installs a fake `__TAURI_INTERNALS__` (`runtime/ipc.ts`), the network wall (`runtime/net.ts`: model APIs answered by `runtime/llm.ts`, everything else refused), a scenario clock, localStorage and an in-memory vault.
- **Backend**: `runtime/backend/` — the repo's own `server/commands` ports of lib.rs run on an in-memory FS, plus an in-memory git, scripted sync/keys/shell, and inert host commands. An unknown command shows "not faked: <cmd>".
- **Scenarios**: `scenarios/index.ts` (desktop + phone), all built on `scenarios/world.ts`; the phone's MockDB comes from `scenarios/phone.ts`.
- **Data**: `fixtures/synthetic/` (committed) + `demo-vault/` under `guide/`. Private bases built from a real vault land in `fixtures/private/` (gitignored until the redaction report is approved).
- `window.__preview` in a frame: `calls()`, `unknown()`, `refused()`, `llm()`, `release()` (finish a held stream), `advance(ms)` (scenario clock), `emit(event, payload)`.
