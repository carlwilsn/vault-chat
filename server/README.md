# vault-chat-server

vault-chat's **existing** mission/phone machinery, run headless as one node process on the box. It is
the only machine that fires schedules and runs missions. It also serves the phone PWA, hosts the vault's
git repo over smart HTTP, and keeps the box's working copy in sync.

```
npm run build:server     # → dist-server/vault-chat-server.mjs (+ .map, server-version.json)
npm run test:server      # build + vitest (server/test)
npx tsc -p server/tsconfig.json   # type-check server/ and the src/ modules it bundles
node dist-server/vault-chat-server.mjs
```

The bundle is self-contained: node 22 and `git` on `PATH` are all it needs at run time. The phone assets
(`phone.html`, `phone-sw.js`, `voice.html`, the icon) and the default agent prompts are inlined.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `VC_HOST` / `VC_PORT` | `127.0.0.1` / `8848` | listen address (`tailscale serve` proxies https → this) |
| `VC_VAULT` | `~/vaults/school2` | the box working copy (branch `box`) |
| `VC_VAULT_NAME` | basename of `VC_VAULT` | the name in `/git/<name>.git` |
| `VC_BARE_REPO` | `<VC_VAULT>/../<name>.git` | bare repo behind `/git` and the sync loop |
| `VC_LOCALSTORAGE` | `~/.local/share/com.vault-chat.app/mission-engine.localstorage` | file-backed `localStorage` (flat JSON `{key: string}`); holds the VAPID keys, model choices, flags |
| `VC_PUSH_SUBS` | `~/.config/com.vault-chat.app/phone-push-subs.json` | Web Push subscriptions — the same file the desktop app's phone server used (`app_config_dir`, voice_server.rs:1435); missing = none yet |
| `VC_TOKEN_FILE` | `~/.local/share/com.vault-chat.app/phone-token` | the existing phone token |
| `VC_SECRETS_DIR` | `$XDG_CONFIG_HOME/vault-chat` or `~/.config/vault-chat` | `secrets.age` + `fallback.key` (vault-chat's headless key store; read-only here) |
| `VC_STATE_DIR` | `~/.local/state/vault-chat-server` | server state (`poll-seq`, the `/poll` sequence floor) |
| `VC_ALLOWED_LOGINS` | `carwilson0929@gmail.com` | comma list for `Tailscale-User-Login` |
| `VC_SYNC` | `1` | `0` disables the sync loop |
| `VC_SYNC_INTERVAL_MS` | `15000` | sync cycle period |
| `VC_INIT` | unset | `1` = create the bare repo / working copy if missing (never in prod otherwise) |
| `VC_ASSETS_DIR` | unset | dev: serve phone assets from this dir instead of the inlined copies |
| `VC_OPENROUTER_BASE` | unset | **tests only**: rewrite `https://openrouter.ai/api/v1` to a fake |

Boot fails (exit 2, message on stderr) if `VC_VAULT` is not a directory or the key store has no
`api.openrouter`. Key values are never logged.

## Layout

```
server/
  main.ts           boot: shims → commands → keys → store/conversations → phone host → HTTP → scheduler → sync
  config.ts         env → config
  shims/            @tauri-apps/* stand-ins: core (invoke), event (bus), app, window, plugins; globals.ts
                    (file-backed localStorage, window/document stubs, __VC_HEADLESS__)
  commands/         node implementations of every reachable invoke command — see COMMANDS.md
  bus.ts            in-process listen/emit + the reqId relay (voice_server.rs relay_request)
  ring.ts           /poll event ring; seq survives restarts (blocks reserved in VC_STATE_DIR/poll-seq)
  http.ts           phone routes (ported from voice_server.rs), /api/v1/*, /git
  auth.ts           loopback / Tailscale-User-Login / phone token
  phoneData.ts      disk readers behind the phone GETs (same JSON shapes as voice_server.rs)
  gitHttp.ts        smart HTTP via `git http-backend`
  git.ts            git runner (timeout + tree kill), per-repo lock, the 50 MB staging rule
  sync.ts           the box sync loop
  keys.ts           age key store reader
  build.mjs         esbuild bundle (aliases, ?url/?raw, text/binary loaders)
  test/             vitest: boot+mission+answer, auth, poll continuity, missing key, sync, git http
```

## HTTP

- **Auth** (every route except `/health`, `/phone`, `/phone-sw.js`, `/manifest.webmanifest`, icons):
  a direct loopback caller (no `X-Forwarded-*` / `Tailscale-User-Login` headers), **or**
  `Tailscale-User-Login` ∈ `VC_ALLOWED_LOGINS`, **or** the phone token (`X-Vault-Token`, `vc_token` cookie,
  `?token=`). `tailscale serve` connects from 127.0.0.1 too, so a proxied request is recognised by its
  forwarding headers and must carry an allowed login or the token.
- **Phone routes**: same paths, methods and JSON as `src-tauri/src/voice_server.rs` v0.6.32. GETs read disk;
  mutations are relayed in-process to `phoneApp.ts`'s `phone:*` handlers. `/session` (voice) answers 503 —
  there is no voice host headless; `/tool` uses the read-only voice tool fallback. The Claude/feedback
  screen's `/feedback`, `/coder*` and `/alert-followup` are gone (404; Phase 3).
- **Projects** (Phase 3): `GET /projects` → `{projects:[{slug,name}]}`; `POST /conversation/project
  {convId, project: name|slug|null}` → `{ok, project}` (create-or-attach via `server/context`; a `project`
  event on `/poll`). `/conversations` rows and `/conversation` carry `project`, `state`, `nextWakeAt`,
  `costUsd`, `working` and (sleeping) `wakeReason` when set — the clients' ongoing-work line.
- **`GET /api/v1/health`** → `{ok, version, rev, vault, git:"ok"|"missing", keys:{openrouter}, busy:{runs}, conversations, sync:{…}}`
- **`POST /api/v1/alert`** `{title, body, tag?}` → Web Push to every subscribed phone → `{ok, sent}`
- **`GET /api/v1/sync`** → full sync status (every step with its full stderr on failure).
- **`/git/<vault>.git/*`** → `git http-backend` on the bare repo. A push of `master` triggers a sync cycle.

## Engine (Phase 2): every agent turn runs in Codex

`server/engine/` replaces the in-process agent loop for every turn (chats and long work) with the pinned
**Codex 0.162.1** app-server. The old loop stays only for `VC_ENGINE=0` and the
laptop's local chats; the missions system is gone and its mission/worker/ask threads are archived, read-only
(a message to one is refused). `VC_ENGINE=0` boots without the engine (old loop for everything).

```
server/engine/
  backend.ts        the runtime seam: EngineBackend + neutral BackendEvents (see below)
  codexBackend.ts   EngineBackend on Codex: thread/turn/steer/interrupt, items → events, server requests, rollout usage
  appServer.ts      `codex app-server` child over stdio JSON-RPC, restarted on exit with backoff (health in /api/v1/health)
  install.ts        npm-installs @openai/codex@0.162.1 into $VC_STATE_DIR/codex/0.162.1 on first start (VC_CODEX_BIN overrides)
  codexConfig.ts    $VC_STATE_DIR/codex-home/config.toml, regenerated at every start
  engine.ts         runtime-neutral: conversations ↔ threads, AskUser/ScheduleWake/KeepWorking/Done/Blocked/Notify,
                    keep-going rule, watchdog, resume after a crash, roll-over, cost, subagent children, paid probe
  convs.ts          one-conversation locked read-modify-write, mirrored into the store (→ /poll events)
  wakes.ts          durable one-off wakes: <vault>/.vault-chat/local/wakes.json (added to .git/info/exclude)
  ledger.ts         dollars from the rollout's token_usage_record response ids + GET /generation (state: ledger.json)
  capabilities.ts   per-model tools/subagents/images/pdf/caching: catalog (free) + learned from use; seed capabilities.json
  catalog.ts        OpenRouter /models (cached, refreshed daily): context windows, compaction limits, capabilities
  extraTools.ts     PdfRead, WebSearch, StartJob/JobStatus
  context.ts        the seam to server/context (CONTEXT, Order C)
```

**EngineBackend** (backend.ts) — what each runtime implements (Codex: codexBackend.ts; pi: pi/backend.ts):
`start()`, `ready(ms)`, `health()`, `setHandlers({toolCall(threadId, name, args) → {ok, text}, userInput(threadId, question, options) → answer})`,
`startThread({cwd, model, instructions, tools, subagents}) → {threadId, ref}`, `resumeThread(threadId, {model, subagents})`,
`startTurn(threadId, {texts, images, model}) → {turnId}`, `steer(threadId, turnId, {texts, images})`, `interrupt(threadId, turnId)`,
`forget(threadId)`, `usageCalls(ref, turnId?)`, `childUsageCalls(threadId)` (ledger), `killHard()` (tests);
optional `followUp(threadId, {texts})` (wakes/nudges arriving mid-turn queue instead of steering);
events `"event"` (`turnStarted | textDelta | text | tool | reasoning | usage | subagents | subagentStatus | turnCompleted | threadLost`),
`"up"`, `"down"`. `threadLost` = one thread's runtime died while the rest is fine (pi: one process per thread): that turn is
cut and resumed. `resumeThread` throws `ThreadUnknownError` for a thread it doesn't know (the other runtime's, after
switching `VC_ENGINE`): the engine starts a fresh thread and hands the visible transcript to its first turn. Everything else (wakes, keep-going, watchdog, AskUser/Done/Blocked, ledger, CONTEXT, /poll, phone API) is
runtime-neutral in engine.ts.

**Sandbox.** Codex refuses a deny entry on `danger-full-access`, and under it the key store is readable. Tool shells
therefore run under the custom profile `vc`: `/` readable; `$HOME`, `/tmp` and the vault writable; `~/.config` and
`$VC_STATE_DIR` read-only; **denied**: the key store, the phone token, the localStorage file (VAPID), the push
subscriptions, `/run/user/<uid>` (the systemd/D-Bus sockets: `systemd-run --user` from the agent otherwise escapes
the sandbox and reads the key store — measured) and `/tmp/tmux-<uid>`. `OPENROUTER_*` is excluded from tool shells.
Long jobs that must outlive a turn use **StartJob** (the server runs `systemd-run --user … codex sandbox` under the same
profile, so they survive turns and restarts and still can't read the keys).

**Routes.** `/message {text, convId?, project?, context?, images?: [{name?, mime, dataBase64}], imagePaths?: [vault-relative]}`
→ `{ok, convId}` (creates a conversation without `convId`; a message to a running turn steers it → `steered: true`;
a message while a question is open answers it → `answered: true`). `/answer {convId, text | defer, notifId?}`,
`/kill {convId}` (interrupt, keep-going off, wakes cancelled). Archived mission threads fall through to the old relay, which refuses them.
`GET /conversation?id=&full=1` adds `full`, `meta` and the stored messages. `GET /api/v1/models` →
`{models: [{id, capabilities, source: catalog|learned|untested, status, checkedAt}]}`. `POST /api/v1/models/<id>/probe`
(and `node vault-chat-server.mjs probe-model <id>`) runs a short paid probe — only on request.

**Conversation meta** written by the engine: `codexThreadId`, `codexThreadPath`, `project`, `working`, `nextWakeAt`,
`state` (`idle|running|sleeping|waiting_user|blocked|done`), `pendingAsk`, `verdict`, `recap`, `subagents[]`, `costUsd`;
assistant messages carry `toolCalls`, `thinking`, `usage`, `costUsd`, `turnId`.

| Var | Default | Meaning |
|---|---|---|
| `VC_ENGINE` | `codex` | `codex`, `pi` (see below), or `0` = no engine (old loop) |
| `VC_ENGINE_MODEL` | `localStorage.vault_chat_engine_model` or `openai/gpt-6.1-sol` | the agent's model |
| `VC_VISION_MODEL` | `openai/gpt-6.1-sol` | a turn with images on a model that can't see uses this |
| `VC_WEBSEARCH_MODEL` | `google/gemini-2.5-flash-lite` | WebSearch (OpenRouter web plugin) |
| `VC_ENGINE_STALL_MS` | 30 min | watchdog: no events for this long → interrupt + resume turn |
| `VC_CODEX_BIN` | unset | use this pinned binary instead of installing |
| `VC_CODEX_COMPACT_CAP` | roll threshold × 1.25 | Codex's auto-compaction limit (CONTEXT's roll-over goes first) |

Tests: `VC_TEST_CODEX_BIN=<pinned codex binary> npm run test:server` runs `server/test/engine.test.ts` against the real
binary and a fake Responses-API OpenRouter (`server/test/fakeResponses.ts`); without it those tests skip and the other
server tests run on the old loop.

### `VC_ENGINE=pi`: the same engine on pi 1.1.0

The runtime-neutral engine is unchanged; `server/engine/pi/` is a second `EngineBackend`:

```
server/engine/pi/
  backend.ts   PiBackend: thread = pi session (id; ref = its session file), one pi process per thread with work in hand
               (idle 10 min → closed; ≤ 6 at once), RPC prompt/steer/follow_up/abort, pi events → BackendEvents,
               host calls from the extension → the engine's tool handlers, usage from the session's vc-cost entries
  proc.ts      one `pi --mode rpc` child: strict LF-split JSONL, own process group, key written to fd 3 then closed
  install.ts   npm-installs @earendil-works/pi-coding-agent@1.1.0 into $VC_STATE_DIR/pi/1.1.0 (VC_PI_DIR overrides); finds bwrap
  config.ts    $VC_STATE_DIR/pi/{agent/settings.json (compaction per model, above CONTEXT's roll threshold),
               agent/models.json (models pi's bundled catalog lacks), ext/, instr/, sessions/}
  index.ts     boot: the sandbox (below), the neutral Engine with PiBackend, StartJob on bubblewrap
  jobs.ts      StartJob/JobStatus: `systemd-run --user` + bubblewrap with the same hiding
  ext/vc.mjs   the pi extension (copied to $VC_STATE_DIR/pi/ext at boot): vault-chat's tools as blocking host calls
               (`extension_ui_request` editor "vc:host-call"), the key from fd 3 (runtime key, in-process), the
               scrubbed + bubblewrapped `bash` with a default timeout, the path guard, the vc-cost ledger entries,
               Gemini cache markers
  ext/policy.mjs  pure helpers (env scrub, path guard with symlinks resolved, cache markers, schema → TypeBox)
```

- **Key safety.** No key in pi's env or argv: it goes in on fd 3 and is set with `setRuntimeApiKey` (TS-private; pi is
  pinned). pi itself runs in bubblewrap: own pid namespace (killing it kills every descendant, detached or not —
  pi's `bash` detaches its children into their own process groups, so a process group alone would not), the key
  store, phone token, localStorage file and push subscriptions hidden, `/run/user/<uid>` and `/tmp/tmux-<uid>`
  hidden (no `systemd-run --user`/tmux escape), `$VC_STATE_DIR` read-only except pi's sessions and agent dir, the
  conversations and wakes read-only. Each `bash` command runs in a second bubblewrap (own pid namespace: it can't
  see pi's process) with `OPENROUTER*`/`*API_KEY*`/`VC_*`/tokens scrubbed. pi's in-process `read/write/edit/grep/find/ls`
  pass a **path guard** (realpath through symlinks): no reads of the key store, tokens or `/proc`; no writes to the
  state dir or the conversations. Without bwrap on Linux the pi engine refuses to start (`VC_PI_UNSAFE=1` overrides).
- **Crash and resume.** Before any resume the old process group/namespace is killed; at boot, groups listed in
  `pi/pids.json` are killed. A pi that dies mid-turn → `threadLost` → the turn is marked "Interrupted by a restart"
  and a resume turn runs on the same session (3 crashes in 10 min → no more automatic resumes).
- **Cost.** Never pi's own price (53% high for DeepSeek; measured live 7× low for Gemini 3.8 Flash). The extension
  records OpenRouter's `x-generation-id` and the `usage.cost` OpenRouter streams, per call, as `vc-cost` session entries;
  the shared ledger uses that cost and falls back to `GET /generation?id=` when the stream had none.
- **Caching.** Claude: pi sends Anthropic `cache_control` itself (live: 96–99% of input read from cache, across a
  server restart). Gemini: a marker on the system prompt (one fixed breakpoint; `VC_PI_GEMINI_CACHE=last|0`).
- **Not on pi (yet):** subagents (no `subagents` events; `childUsageCalls` is empty), the paid capability probe's
  subagent half.

| Var | Default | Meaning |
|---|---|---|
| `VC_PI_DIR` | unset | npm prefix holding pi 1.1.0 (else installed into `$VC_STATE_DIR/pi/1.1.0`) |
| `VC_BWRAP` | PATH, then /nix/store | bubblewrap binary (required on Linux) |
| `VC_PI_UNSAFE` | unset | `1` = run without bubblewrap (path guard + env scrub only) |
| `VC_PI_THINKING` | `medium` | pi's thinking level |
| `VC_PI_IDLE_MS` / `VC_PI_MAX_PROCS` | 10 min / 6 | idle pi processes are closed; at most this many |
| `VC_PI_SHELL_TIMEOUT_S` | 1800 | default `bash` timeout (pi has none) |
| `VC_PI_GEMINI_CACHE` | `system` | `last` also marks the newest user message; `0` off |
| `VC_PI_CACHE_RETENTION` | unset | → `PI_CACHE_RETENTION` (`long` = 1 h Claude cache) |

Tests: `VC_TEST_PI_DIR=<npm prefix with pi 1.1.0> npm run test:server` runs `server/test/piEngine.test.ts` (the same
scenarios as the Codex suite, plus the key/path-guard probes, cache markers, kill -9 tree death) against real pi and a
fake chat-completions OpenRouter (`server/test/fakeChat.ts`); `server/test/piPolicy.test.ts` needs nothing.

## Sync (box side)

Every `VC_SYNC_INTERVAL_MS`, after every turn that ends, and after a push over `/git`:

1. commit the working copy on `box` as `vault-chat-agent` with an `[agent] box autosave: N file(s)` message,
   under the same per-repo lock as the app's own end-of-turn commits; a file over 50 MB is never staged (an
   untracked one goes to `.git/info/exclude`), is listed in the status and alerts once;
2. push `box` to the bare repo;
3. fetch `master`; fast-forward `box` when `master` contains it. **Never a merge on the box.**

The bare repo's `pre-receive` hook keeps `box` box-only (refused over `/git`) and stops the box from writing
`master`. Failing for over 10 min → one push alert; one more on recovery. The box does **not** mirror to
GitHub (no credential there); the laptop backs up.

## Box notes

- `tools.ts` drops the Bash tool when `localStorage["vault_chat_bash_disabled"]` is absent or `"true"`
  (the production default). Missions that need Bash need `"false"` in `VC_LOCALSTORAGE`.
- Phone/cockpit chats run on `vault_chat_assistant_model` (same default). With no key for that model's
  provider, `chat-controller` returns silently — set it to an OpenRouter model too.

## Runtime dependencies of the bundle

Only node 22 and `git`. Everything else is inside the `.mjs`; `server/test/isolated.test.ts` copies the
bundle alone into a directory with no `node_modules` above it and boots it. The bundle's remaining runtime
`require`s are all optional and guarded: `@napi-rs/canvas` (pdf.js page rendering), `esprima` (js-yaml's
`!!js` types) and an ElevenLabs `import()` on the voice path, which the server never loads.

**PDFs.** `pdfjs-dist` resolves to `server/shims/pdfjs.ts`: geometry-only `DOMMatrix`/`ImageData`/`Path2D`
stubs, the legacy (node) build, and its worker bundled and run on the main thread. **Text extraction
(`PdfExtract`) works.** Page rendering (`PdfPageSnapshot`) needs a canvas and fails with an error message
headless. pdf.js prints one warning at start ("Cannot load @napi-rs/canvas") and may warn about
`standardFontDataUrl`; both are harmless for text extraction.
