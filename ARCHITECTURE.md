# vault-chat — Architecture

A Tauri + React desktop app: a markdown/PDF/HTML viewer and editor whose chat is the box's. Every agent turn runs on the box (vault-chat-server running pi, `server/`); the app sends intents and shows the box's conversation feed. With no box connected the chat says "Connect your box to chat"; with the box unreachable it says why and retries, and files, the editor, notes and history keep working on the local copy (git sync catches up). Three boundaries: **React UI**, **Rust backend** (Tauri commands), **the box** (HTTP over the tailnet).

## Top-level layout

```
src/                   React + TypeScript frontend
  App.tsx              Top-level layout (Allotment 3-pane) + global shortcuts
  main.tsx             Boot: hydrateKeychain, render App
  store.ts             Zustand store — single source of UI truth
  chat-controller.ts   The chat's intents (send, steer, queue, take back, stop) → the box
  boxChat.ts           The box's conversation feed (/poll), intents, reachability
  convlog/             The feed's protocol and the one reducer every client folds
  complete.ts          One-shot calls on the box (Ctrl+K / Ctrl+L, note titles, voice math)
  skills.ts            /skill-name autocomplete
  meta.ts              Per-vault voice prompt, north star, memory index, vault tools (for voice)
  context.ts           Loads AGENTS.md / CLAUDE.md / goals as voice session context
  keychain.ts          OS-keychain wrapper (apiKeys, serviceKeys, userKeys)
  sync.ts              Chat popout ↔ main window state sync
  git.ts               Auto-commit after agent-touched files
  ChatPane.tsx         Chat UI: textarea, @-mention + /skill, stream render
  FileTree.tsx         File tree: drag-drop, multi-select, right-click menu
  Titlebar.tsx         Title bar: vault open, history, popout, settings
  SettingsPane.tsx     Settings: voice model + the box's models, keys, voice, box, theme
  MarkdownArea.tsx     Split-pane wrapper around MarkdownView
  MarkdownView.tsx     Markdown editor (Monaco) + viewer (remark/rehype)
  PdfView.tsx          PDF render + marquee ask
  HtmlView.tsx         HTML iframe + marquee ask
  ImageView.tsx        Image view + marquee ask
  NotebookView.tsx     Jupyter .ipynb read-only viewer
  InlineEditPrompt.tsx Ctrl+K inline edit and Ctrl+L / marquee ask
  inlineEdit.ts        What Ctrl+K / Ctrl+L send (a one-shot call on the box)
  dnd.ts               DataTransfer MIME constants + external-drop helpers
  fileKind.ts          File-type detection (markdown / pdf / image / unsupported)

src-tauri/             Rust backend
  src/lib.rs           All Tauri commands (file IO, git, sync, keychain, glob, box HTTP)
  tauri.conf.json      Bundle identifier, window config, permissions

docs/                  Subsystem documentation (this folder)
```

## One user turn — the happy path

1. **ChatPane.tsx** — user types, hits Enter. `send()` resolves `@name` tokens into a hidden preamble (text files inlined, binaries by path).
2. **chat-controller.ts** — `sendMessage` hands it to **boxChat.ts** `boxSend`: the message shows at once under the id the box will echo, and goes to the box as an intent (send; or steer / queue while a turn runs; or the answer to an open question).
3. **The box** (server/engine) runs the turn in pi and writes it to the vault's conversation feed.
4. **boxChat.ts** long-polls the feed (`/poll?after=N`), folds the records with the one reducer (`convlog/reduce.ts`) and projects them into the store (`messages`, the live text, tools and context).
5. **store.ts** — the chat UI re-renders; the popout gets the same state over `chat:state` / `chat:stream`.

## Data boundaries

- **UI → Rust**: every `invoke("...")` call is a Tauri command declared in `src-tauri/src/lib.rs`. Commands handle file IO, git and sync, keychain, glob, and the box's HTTP (`box_get_json` / `box_post_json`).
- **UI → the box**: the conversation feed and intents, one-shot model calls (`/api/v1/complete`), voice sessions and tools, the activity stream, keys (Settings → Box sends this machine's keys). The app calls no model provider itself.
- **Rust ↔ OS**: file-system walks (walkdir), keychain (OS credential store), git.

## Where state lives

| State | Where | Notes |
|---|---|---|
| Vault path, theme | `localStorage` | Loaded at boot (`store.ts`) |
| Chat history | the box's feed | A small cache in `localStorage` shows the last state at once |
| API keys, service keys | **OS keychain** via `invoke("keychain_*")` | Never in localStorage in v0.1.0+ |
| User-defined keys | OS keychain + localStorage registry | Name list tracked separately |
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
