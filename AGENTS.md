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
