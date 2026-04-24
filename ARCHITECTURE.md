# vault-chat — Architecture

A Tauri + React desktop app: a markdown/PDF/HTML viewer with an LLM chat pane that can read and edit the vault through tools. Three boundaries: **React UI**, **Rust backend** (Tauri commands), **LLM provider** (Vercel AI SDK).

## Top-level layout

```
src/                   React + TypeScript frontend
  App.tsx              Top-level layout (Allotment 3-pane) + global shortcuts
  main.tsx             Boot: hydrateKeychain, render App
  store.ts             Zustand store — single source of UI truth
  chat-controller.ts   Orchestrates a chat turn (compact → send → stream → persist)
  agent.ts             Builds the model request + streams events back
  providers.ts         Anthropic/OpenAI/Google/OpenRouter SDK wiring
  modelCatalog.ts      /v1/models fetchers — live dropdown catalog
  tools.ts             Built-in agent tools (Read, Write, Bash, Glob, ...)
  skills.ts            /skill-name prompt injection
  meta.ts              Meta-vault: user-defined tools + system prompt
  context.ts           Loads AGENTS.md / CLAUDE.md / goals as session context
  compactor.ts         Context-window compaction (summarize old turns)
  keychain.ts          OS-keychain wrapper (apiKeys, serviceKeys, userKeys)
  sync.ts              Chat popout ↔ main window state sync
  git.ts               Auto-commit after agent-touched files
  ChatPane.tsx         Chat UI: textarea, @-mention + /skill, stream render
  FileTree.tsx         File tree: drag-drop, multi-select, right-click menu
  Titlebar.tsx         Title bar: vault open, history, popout, settings
  SettingsPane.tsx     Settings: keys, model picker w/ search, theme
  MarkdownArea.tsx     Split-pane wrapper around MarkdownView
  MarkdownView.tsx     Markdown editor (Monaco) + viewer (remark/rehype)
  PdfView.tsx          PDF render + marquee ask
  HtmlView.tsx         HTML iframe + marquee ask
  ImageView.tsx        Image view + marquee ask
  NotebookView.tsx     Jupyter .ipynb read-only viewer
  InlineEditPrompt.tsx Ctrl+K inline edit and Ctrl+L / marquee ask
  inlineEdit.ts        Agent call used by inline edit & marquee ask
  dnd.ts               DataTransfer MIME constants + external-drop helpers
  fileKind.ts          File-type detection (markdown / pdf / image / unsupported)

src-tauri/             Rust backend
  src/lib.rs           All Tauri commands (file IO, bash, git, keychain, glob, grep, http)
  tauri.conf.json      Bundle identifier, window config, permissions

docs/                  Subsystem documentation (this folder)
```

## One user turn — the happy path

1. **ChatPane.tsx** — user types, hits Enter. `send()` (~line 202):
   - Scans the text for `@name` tokens, resolves each to an absolute path (picked-mention set first, then case-insensitive basename match against `files`).
   - Builds a **hidden preamble** via `buildMentionPreamble()`: for text files inlines content + path; for binaries just gives `@rel → /abs/path`.
   - Appends an inline **footer** `[attached: @name → /abs/path]` to the outgoing text so the agent sees paths even if it ignores the preamble. Stripped from the bubble render via `stripAttachedFooter()`.
2. **chat-controller.ts** — `sendMessage(text, preamble)`:
   - If context > 85% of model limit, calls `compactor.ts` to summarize older turns, keeps last 4.
   - Pushes the hidden preamble (if any) + the visible user turn into `store.messages`.
   - Calls `runAgent(...)` with the full history.
3. **agent.ts** — `runAgent()`:
   - Parallel-loads session context (AGENTS.md etc.), skills, meta system prompt, meta tools.
   - Runs `expandSkillInvocation()` on the user message — every `/name` token anywhere in the text adds a `<skill>` XML block before the original text.
   - Builds the final system message: baseline + vault root + shell note + session context + skill index + meta-tool list.
   - Builds per-provider `providerOptions` (Anthropic thinking, OpenAI reasoningEffort, Google thinkingConfig).
   - Scrubs `data:image/...` embeds if the model doesn't support vision.
   - Calls `streamText()` from the AI SDK; events feed back via `onEvent(...)`.
4. **chat-controller.ts** — `onEvent`:
   - `text` → append to `store.streamingText`, buffered at ~5 Hz flush.
   - `reasoning_*` → `store.streamingReasoning`.
   - `tool_use` / `tool_result` → `store.liveTools` + tools array.
   - `done` → append final assistant message, clear streaming, persist chat, trigger git auto-commit if files were touched.
5. **store.ts** — subscribe callbacks fire, chat UI re-renders. Chat history debounce-persists to localStorage (500 ms). Popout sync broadcasts `chat:state` / `chat:stream` to the other window.

## Data boundaries

- **UI → Rust**: every `invoke("...")` call is a Tauri command declared in `src-tauri/src/lib.rs`. Commands handle file IO, bash, git, keychain, glob, grep, http_fetch, tavily_search, run_script (meta-tool).
- **UI → LLM provider**: via the Vercel AI SDK (`@ai-sdk/anthropic`, `-openai`, `-google`). OpenRouter reuses the OpenAI adapter with a custom `baseURL` and forced `.chat()` path.
- **Rust ↔ OS**: file-system walks (walkdir), keychain (OS credential store), sidecar processes for bash and meta-tool scripts.

## Where state lives

| State | Where | Notes |
|---|---|---|
| Vault path, model id, theme | `localStorage` | Loaded at boot (`store.ts`) |
| Live model catalog | `localStorage` | Refreshed on demand from `/v1/models` |
| Chat history | `localStorage` (`vault_chat_history`) | Debounce 500ms, per-vault |
| API keys, service keys | **OS keychain** via `invoke("keychain_*")` | Never in localStorage in v0.1.0+ |
| User-defined keys | OS keychain + localStorage registry | Name list tracked separately |
| Meta-vault (skills, tools, system.md) | `%APPDATA%/com.vault-chat.app/meta/` | OS-level app data dir |
| Per-vault ignore list | `<vault>/.vault-chat-ignore` | Hidden files, agent can still see |

## Cross-references

- [docs/chat-pipeline.md](docs/chat-pipeline.md) — how messages flow, providers, skills, @-refs
- [docs/tools-and-meta.md](docs/tools-and-meta.md) — tool catalog, meta-vault, security boundaries
- [docs/frontend-layout.md](docs/frontend-layout.md) — panes, shortcuts, marquee, popout
- [docs/state-and-persistence.md](docs/state-and-persistence.md) — store shape, persistence, sync
- [docs/gotchas.md](docs/gotchas.md) — provider quirks, invariants, known bugs

## What the app is not

- Not a cloud-synced note app. Vault is a local folder.
- Not sandboxed. The agent has full read/write on the vault AND whatever the user's shell can reach via Bash.
- Not a general chat client. It's tightly coupled to a **vault root** and expects to edit files there.
