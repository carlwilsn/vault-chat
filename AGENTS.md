# vault-chat

vault-chat is Carl’s interface to pi, running on thinkbox with a Tauri laptop app,
phone web app, iPad whiteboard and voice. It is not AgentOS.

## Carl’s vault-chat instructions

- Done means Carl’s ask works for Carl, judged on the real app (and his laptop probe numbers for speed).
- Run the normal typecheck and tests before a ship request; nothing else is required.
  No proof cards, recordings, shipment proofs, real-data captures beyond what the
  ship script does itself, plans or progress reports.
- Talk to Carl only when an ask ships: one line, and for speed fixes his before and
  after probe numbers. Never invent missing measurements.
- No tracking files: no ASKS, PLAN, CURRENT or HANDOFF files. Carl's asks live in the chat.
- Sub-agents only to go faster on an ask, never for checking, auditing, owning or monitoring.
- Work in up to three independent lanes when Carl asks for parallel work. Each lane:
  fix → normal tests → ship request → read result; never duplicate another lane’s work.
- Use an agent/<name> branch in your own clone. Push it to publish, then write
  ~/agent-work/vault-chat/ship-requests/<unique>.req with exactly two lines:
  the branch name and a plain one-line title. Read its .result and .log.
  Only the installed ship script promotes main; its watcher publishes accepted
  main to GitHub. Do not duplicate that push; verify the remote SHA.
- Shipped means the box and Carl’s laptop run the release and autonomous checks on
  the real app pass (Carl’s native laptop probe for speed). Do not ask for a
  greenlight or wait for Carl’s confirmation.
- No source recovery or rollback of accepted work; no new shipping machinery,
  systemd-run units, owners, continuations, handoffs, receipts or waiting chains.
  Do not edit the installed simple-ship copy.
- Keep conversation ownership separate from the viewer/file workspace. Vaults and
  projects are many-to-many; the vault picker lists vaults, not project ownership.
- Ask only for money, irreversible actions or visual taste. Never read/copy secrets,
  server env/token files or private keys, or print keys. Other vaults’ .vault-chat
  and .git are private. Keep tests muted and off live ports 8848/8857.

## Source map

- server/: box HTTP server and pi integration; src/: React/Tauri laptop client.
- phone/, board/, voice-pipeline/: phone, whiteboard, and voice transport.
- package.json: normal typecheck/test commands. memory/: short source facts only.
- Inline HTML (src/inlineHtml.ts): `![label](.vault-chat/visuals/x.html)` in a reply shows that vault page live and
  interactive in the chat (laptop pane, fullscreen, phone): sandboxed, no network, so inline its scripts/data. Charts,
  widgets, explainers, mockups. For the app's look, link `<link rel="stylesheet" href="/app-styles.css">` and use
  the app's own classes (only classes src/ uses exist; anything else inline `style`); for exact fidelity, the real
  components in the preview harness (preview/, `npm run preview`, `?scenario=`) shot with RecordUI.
- Live pages (src/liveBridge.ts): a vault .html that declares `<meta name="vc-capabilities" content="ask, mic">` gets `window.vc` after Carl's one-time Allow
  (per path + content hash): `vc.ask(prompt,{system})` streams an ephemeral read-only AI reply (`for await`, `.text()`), `vc.fetch(path, init)` reaches only what the
  granted capabilities cover (box-checked token), `vc.mic()`/`vc.play()`, `vc.theme`/`vc.size`; no `<form>` (sandboxed), buttons + keydown. The services a page may name
  (ask, mic, voice-lab = `tool:voice-lab.*`, persist (an older word that opens nothing), theme, state, log, converse, catalog) are declared once in src/liveServices.ts; an unknown
  name is refused (`vc.refused`); `vc.services` lists what was granted, `vc.service(name)` returns its function. `state`: `vc.state.get/set/subscribe`, the page's own state as plugin.state records in the box's one log (src/pluginRecords.ts, server/pluginState.ts), the same in every view; `log`: `vc.log(record)` appends a plugin.log record. `converse` (src/pluginConverse.ts): `vc.converse.start(text)` makes a real chat in the chat list (the box's own send intent, `via: "page"`, the page named in the turn's context), `vc.converse.send(convId, text)`, `vc.converse.list()`, `vc.converse.read(convId, {after})`; no other intent. `catalog` (src/pluginCatalog.ts, server/pluginCatalog.ts): `vc.catalog()` → {services, plugins}: every registered service and the vault's plugins (.html pages with a vc-capabilities / vc-mount manifest: id = vault path, name, mount, needs), read from the vault each time; the same list at GET /api/v2/plugin/catalog (app, loopback) and the agent's read-only Catalog tool. Example: .vault-chat/visuals/live-chat-demo.html.
  Every vault .html also has its own link on the box, `https://<box>.<tailnet>.ts.net/p/<vault path>/` (`?vault=<name>` for a non-main vault; server/pageLink.ts):
  the same page and `vc` in a plain tab or on the phone, opened only through `tailscale serve` as an allowed login (no loopback, no token).
  In-process mount (src/mountHost.ts): a page with `<meta name="vc-mount" content="in-process">` runs in the app itself, no iframe: its styles + markup in a shadow root, its inline `<script type="module">` exporting `mount(el, api)` (widget contract: api.size/onResize/theme/onTheme/path; return a cleanup); anything it throws becomes an error card with Reload. No vc services there yet.
