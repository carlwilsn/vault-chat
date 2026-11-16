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
- Inline web pages (src/inlineWeb.ts, src/InlineWebPage.tsx, src-tauri/src/web_embed.rs): `![title](https://…)` on its own line (not an image/video/PDF address)
  shows that public page live in the chat on the Windows/macOS app: a native browser view (wry, made outside Tauri's webview manager: no Tauri IPC, no app
  protocols, its own InPrivate data folder) laid over a placeholder and kept on its visible part as the chat scrolls; hidden when an app menu/dialog covers it.
  Back/Forward/Reload, Full window, Browser, Close. Public http(s) hosts only (no loopback/LAN/tailnet/*.ts.net); popups load in place; downloads refused.
  Phone, browsers, Linux, refused addresses or any failure: the title is a plain link.
- Live pages (src/liveBridge.ts): a vault .html that declares `<meta name="vc-capabilities" content="ask, mic">` gets `window.vc` after Carl's one-time Allow
  (per path + content hash): `vc.ask(prompt,{system})` streams an ephemeral read-only AI reply (`for await`, `.text()`), `vc.fetch(path, init)` reaches only what the
  granted capabilities cover (box-checked token), `vc.mic()`/`vc.play()`, `vc.theme`/`vc.size`; no `<form>` (sandboxed), buttons + keydown. The services a page may name
  (ask, mic, voice-lab = `tool:voice-lab.*`, persist (an older word that opens nothing), theme, state, log, converse, catalog) are declared once in src/liveServices.ts; an unknown
  name is refused (`vc.refused`); `vc.services` lists what was granted, `vc.service(name)` returns its function. `state`: `vc.state.get/set/subscribe`, the page's own state as plugin.state records in the box's one log (src/pluginRecords.ts, server/pluginState.ts), the same in every view; `log`: `vc.log(record)` appends a plugin.log record. `converse` (src/pluginConverse.ts): `vc.converse.start(text)` makes a real chat in the chat list (the box's own send intent, `via: "page"`, the page named in the turn's context), `vc.converse.send(convId, text)`, `vc.converse.list()`, `vc.converse.read(convId, {after})`; no other intent. `catalog` (src/pluginCatalog.ts, server/pluginCatalog.ts): `vc.catalog()` → {services, plugins}: every registered service and the vault's plugins (.html pages with a vc-capabilities / vc-mount manifest: id = vault path, name, mount, needs), read from the vault each time; the same list at GET /api/v2/plugin/catalog (app, loopback) and the agent's read-only Catalog tool. Example: .vault-chat/visuals/live-chat-demo.html.
  Every vault .html also has its own link on the box, `https://<box>.<tailnet>.ts.net/p/<vault path>/` (`?vault=<name>` for a non-main vault; server/pageLink.ts):
  the same page and `vc` in a plain tab or on the phone, opened only through `tailscale serve` as an allowed login (no loopback, no token).
  In-process mount (src/mountHost.ts): a page with `<meta name="vc-mount" content="in-process">` runs in the app itself, no iframe: its styles + markup in a shadow root, its inline `<script type="module">` exporting `mount(el, api)` (widget contract: api.size/onResize/theme/onTheme/path; api.listen/timer/effect, undone on unmount; return a cleanup); anything it throws becomes an error card with Reload. No vc services there yet.
  Supervisor (src/pluginSupervisor.ts, server/supervisor.ts): a page's on/off is plugin.desired records in the one log (`{plugin, state: running|stopped, from?, by, reason?}`;
  newest word in effect wins, `from` = later, e.g. an end date) and plugin.budget records (`callsPerMinute`: over it the box writes `stopped`, by budget). Stopped: the box
  gives it nothing (no token, gateway 403, its page not served: phone inline, raw, /p/ link) and every view (viewer, chat inline, iframe or in-process, phone, link) takes it
  down and shows "<name> is turned off" + Turn on; running again, it mounts afresh. Write one with the agent's `Plugins` tool (server/supervisorTools.ts) or POST /api/v2/supervisor; GET reads the records.
  Layout (src/layoutOps.ts): the screen's layout as data and ops (panes and files, split, left panel, chat, window and column sizes), `api.host.layout.get()/apply(ops)` for plugins and the agent's `Layout` tool (server/layoutTool.ts, over Show's signal + ack channel, laptop only); every apply answers with the layout read back from the screen.
  Screen (server/screenTool.ts): the agent sees the real laptop app. A "capture" signal on Show's channel; the laptop (the device host supplying `capture`) draws its own window from the DOM (src/screenCapture.ts: the document cloned with form values, scroll offsets, canvases and images as pixels, in an SVG foreignObject, onto a canvas; sandboxed live pages as a labelled box; window only, never the desktop), downscaled to <= 1600 px wide, and acks with the PNG (src/captureOnLaptop.ts); the box checks the PNG's own size and the tool returns it as an image, or offline / no answer / the laptop's reason. Plugins get the same as `api.host.capture(target)`.
  LaptopBuild (server/hostBuild.ts): which build the laptop app runs. At each launch the main window reports its build (frontend version + revision, native version, runtime, launch-to-interactive, the server it runs if any; src/hostBuild.ts) to POST /api/v1/host/build; the box logs it (<state>/logs/host-builds.jsonl, newest per host in <state>/host-builds.json). The tool asks live (a "build" signal, acked) and shows the last report; `action: "wake"` leaves a one-shot watcher (<state>/host-build-watch.json) and an installed app's report of a different (or the named) build adds a durable wake for that chat (server/engine/wakes.ts), so the agent checks the laptop then instead of polling. The laptop gets builds only through the updater (ship.yml release, latest.json; "Install & restart").
  Drive (server/driveTool.ts) and Timing (server/timingTool.ts): scripted steps (click/hover/type/press/wait/waitFor/scroll/shot, src/driveSteps.ts) and the perf harness's five speeds (src/driveTiming.ts: synthetic keys to two frames, metric/method keys as docs/perf-baseline.md) run on the real laptop app, never in Carl's window: a "drive"/"timing" signal; his main window (src/driveOnLaptop.ts) refuses while he used the app within idleMinutes (src/userActivity.ts, trusted input in its windows only) unless force, opens the Drive copy (src/driveHost.ts: native, a second off-screen unfocused window `vc-drive` at index.html?view=drive with its own capability src-tauri/capabilities/drive.json; browser/preview, a hidden frame), aborts when he starts, acks with outcomes, errors, visible text, shots. The Drive copy is read-only: own in-memory localStorage (src/driveGuard.ts, imported first), only read commands through invoke (vite.config.ts aliases @tauri-apps/api/core to src/tauriCoreGuarded.ts in builds; it refuses to run without that guard), follows the feed as client=drive and ignores signals. Timing also shows Carl's recorded probe samples on the current build, the last launch from the build report, and compares with a perf-baseline JSON.
  App plugins (src/appPlugins.ts, Stage 2): parts of the app that are plugins, id `app/<name>`, code in src/plugins/<name>/ exporting `mount(el, api)`, mounted through the same host
  from the module (light DOM, the app's styles; `api.error(e)` = its error card) by `AppPluginMount` (src/PluginMount.tsx) and following the same records. First: the Notes panel
  (`app/notes`, src/plugins/notes; "disable notes" also hides its titlebar button). Second: the chat list (`app/chats`, src/plugins/chats: the overlay `mount` and fullscreen
  chat's sidebar `sidebar.mount`, mounted by src/ChatsPanel.tsx); AppPluginMount's `fallback` stands in when it is off or fails (a minimal built-in list, Turn on / Reload). Third: the composer (`app/composer`, src/plugins/composer, mounted by the chat pane through src/ComposerPanel.tsx ComposerSlot; its own React root, so a keystroke redraws only it); its draft is module state (src/plugins/composer/draft.ts) shared with its fallback (a plain text box + Send/Stop, New chat, Chats) and, while the records are unknown, the composer drawn in the app's tree; src/chatGate.ts is the one ready/held/box-down rule for pane and composer. The Plugins tool and the catalog (`app` list) name them.
  Offers (src/pluginOffers.ts): a mounted plugin declares what it offers the agent with `api.offer({state: {name: {description, read}}, actions: {name: {description, args: <JSON schema>, run}}, events: {name: {description}}})` → `{emit}`
  (an effect of its run: gone when it stops). The agent reaches every such plugin through two generic tools, PluginRead (list live plugins' offers; read one's state + recent events) and PluginAct
  (run an action; result + state read back), server/pluginOffersTool.ts, routed to the laptop on Show's signal + ack channel (`{type:"plugin"}`, src/boxChat.ts). No tool per plugin. A throwing action is an error result; the plugin keeps running. First: Notes (notes, panel; add/edit/resolve/reopen/delete/open/close/view). Chats: places, selected, panel; open/expand/collapse/showMore/showLess/newChat/rename/renameProject/delete/restore/openPanel/closePanel. Composer: draft, model, send; setDraft/attach/detach/clear/setModel/setEffort/send/stop/focus; events sent, attached.
  Settings (src/settingsRecords.ts, server/settings.ts, src/settings.ts): Carl's settings (theme, model, effort, voice, pushAutomatic, chatSidebar) are `setting` records in the main vault's log
  (`{type:"setting", key, value, by}`, a fold, newest wins; null = default), carried on every feed. The engine's model/effort, the call voice and the push switch read the fold; the app reads
  GET/POST /api/v2/settings and follows the signals (localStorage keeps only a first-paint copy); the phone's push switch follows them. The agent's `Settings` tool (server/settingsTool.ts)
  lists or sets one; unknown keys refused. The box's old localStorage entries move once at boot (backed up to <stateDir>/backups first). Never secrets: keys stay in the key store.
