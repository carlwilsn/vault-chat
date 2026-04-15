# vault-chat

A minimal desktop app: file tree on the left, rendered markdown in the middle, Claude chat on the right. Built to be a bare-bones Obsidian + Claude Code replacement without baking in any workflow-specific structure.

## What this is (and isn't)

- **Is:** a viewer + chat. Point it at any folder; browse `.md` files; chat with an agent that can read/write files in that folder.
- **Isn't:** an editor, a full Obsidian replacement, a multi-tab IDE, a plugin host, an agent framework. Deliberately.

## Stack

- **Tauri 2** (Rust shell) + **React 19 + TypeScript + Vite**
- **react-markdown + remark-gfm + remark-math + rehype-katex + rehype-highlight** for the render pipeline
- **allotment** for resizable 3-pane layout
- **zustand** for app state
- **@anthropic-ai/sdk** (not the agent SDK) with `dangerouslyAllowBrowser: true`, plus a hand-rolled ~50-line tool loop in `src/agent.ts`

### Why the regular SDK, not the Claude Agent SDK

The Agent SDK is Node-first and doesn't run cleanly in a Tauri renderer (browser context). Bundling a Node sidecar was more work than writing a tiny tool loop. If you ever want Agent SDK features (MCP, compaction, sub-agents, hooks), the migration path is: add a Node sidecar binary via Tauri, move `agent.ts` into it, and IPC between renderer and sidecar.

## Architecture

```
src/
├── App.tsx           3-pane Allotment shell
├── FileTree.tsx      folder picker + list of .md files
├── MarkdownView.tsx  renders the selected file
├── ChatPane.tsx      conversation UI + streaming + tool-call display
├── agent.ts          Anthropic client + tool loop + tool definitions
├── store.ts          Zustand store (vault, files, current file, messages, api key)
├── App.css           all styles
└── main.tsx

src-tauri/
├── src/lib.rs        3 Rust commands: list_markdown_files, read_text_file, write_text_file
├── Cargo.toml        adds tauri-plugin-dialog, tauri-plugin-fs, walkdir
├── tauri.conf.json   window 1400x900, min 800x500
└── capabilities/default.json   permissions: dialog:allow-open, fs:default
```

### Data flow

1. **Open vault** → dialog returns path → Zustand `vaultPath`
2. `list_markdown_files` (Rust, uses walkdir, skips dotdirs + node_modules + target) → file tree renders
3. Click file → `read_text_file` → Zustand `currentContent` → react-markdown renders it
4. Chat: user message → `runAgent()` in `agent.ts` loops: call Anthropic → if `tool_use` stop reason, execute tools via Tauri invokes → send `tool_result` back → repeat until `end_turn`
5. On agent turn end: refresh file tree + reload current file (so edits the agent made appear live)

### Tools the agent has

Defined in `agent.ts`:
- `read_file(path)` → wraps `read_text_file` Rust command
- `write_file(path, contents)` → wraps `write_text_file`
- `list_files()` → wraps `list_markdown_files`, returns paths joined by newlines

All paths are absolute inside the vault. Model is `claude-opus-4-6` (constant at top of `agent.ts`).

### State (zustand)

Fields on the store:
- `vaultPath`, `files` (FileEntry[]), `currentFile`, `currentContent`
- `messages` (ChatMessage[]), `busy`
- `apiKey` — persisted in `localStorage` under key `anthropic_api_key`

## Build

```bash
npm run tauri dev     # dev with hot reload — USE THIS FOR ITERATION
npm run tauri build   # prod MSI + NSIS installers — only for shipping a new copy
```

### Dev workflow (important — tell the user this if they forget)

**The user does not need to reinstall the app to test changes.** Default to `npm run tauri dev` for all iteration.

- `tauri dev` opens the app from source with React hot reload; TS changes update instantly, Rust changes auto-recompile in ~30s.
- `tauri build` is only for producing a distributable installer. It's slow (~3–5 min incremental, ~18 min first time on a clean `target/`) and has no iteration benefit.
- The installed app (from the MSI/NSIS) and `tauri dev` share the same `localStorage` because they use the same app identifier (`com.vault-chat.app`). So the saved API key persists across both.
- **Only rebuild the installer when the user explicitly asks for a new shipped copy**, or when you've completed a meaningful milestone and they want to use it outside a dev shell.

If asked about slow builds: the only genuinely slow path is *first-ever* Rust compile or after a `Cargo.toml` dependency change (~18 min). Normal Rust edits incremental-compile in ~30s. TS-only edits are instant via Vite HMR.

Artifacts land at:
- `src-tauri/target/release/vault-chat.exe` — raw exe
- `src-tauri/target/release/bundle/msi/vault-chat_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/vault-chat_0.1.0_x64-setup.exe`

Unsigned → SmartScreen warning on first launch.

## Conventions

- **Chat math**: agent is system-prompted to use `$$...$$` display math only. The chat pane's renderer supports both, but user preference (from the parent Obsidian vault's CLAUDE.md) is display-only in chat.
- **File math**: `.md` files use standard Obsidian conventions (`$...$` inline, `$$...$$` display). Both render in MarkdownView and ChatPane.
- **No comments in source files** unless explaining a non-obvious *why*.

## Known limitations (v1 non-goals — don't add without a reason)

- No editor (viewer only)
- No tabs / split editor
- No wikilinks, backlinks, tags, graph view
- No PDF rendering (filtered out of the tree)
- No code signing (unsigned installers)
- No multi-vault memory (opens one folder at a time)
- No chat history persistence across app restarts
- Chat pane is Anthropic-only (no OpenAI/local model fallback)

## Reasonable next improvements

In rough priority order, each scoped small:

1. **Persist chat history** per vault (write to `.vault-chat/history.json` in the vault root, gitignored).
2. **Editor mode** — ~2 hrs, not 1–2 days. Copy Obsidian + Claude Code's policy: filesystem is source of truth, no locking, no conflict UI. CodeMirror 6 with debounced autosave (300 ms) → `write_text_file`. Tauri file watcher on the currently-open file → re-invoke `read_text_file` on external change and replace the buffer. Last write wins. Don't build dirty-state tracking, reload prompts, or diff views — they're not in the Obsidian experience the user was happy with.
3. **Wikilinks** (`[[foo]]`) — write a remark plugin that rewrites to `<a href="#foo">`; add click handler in MarkdownView to `setCurrentFile` on match.
4. **Streaming responses** — swap `client.messages.create` for `client.messages.stream` in `agent.ts`. Requires splitting the current event shape but otherwise clean.
5. **Non-md file support** — images inline, PDFs via `pdfjs-dist`, plain text as-is.
6. **API key in OS keychain** via `@tauri-apps/plugin-stronghold` or Windows Credential Manager instead of localStorage.
7. **System-prompt awareness of vault conventions** — if the vault has a `CLAUDE.md`, load it into the agent's system prompt automatically.
8. **Model picker** in settings (Sonnet/Haiku/Opus).
9. **Tool call approval prompt** — intercept `write_file` and ask the user before executing. Currently auto-runs.
10. **Windows code signing** — real cert or sigstore; kills the SmartScreen warning.

## Gotchas when extending

- **Tauri permissions**: any new filesystem or OS operation needs a permission added to `src-tauri/capabilities/default.json`. If something silently fails, check the DevTools console (Ctrl+Shift+I) — permission denials show there.
- **Adding a Rust command**: define it in `lib.rs` with `#[tauri::command]`, add to `generate_handler![]`, call from TS via `invoke<T>("cmd_name", { argName })`. Argument names in JS are camelCase and match the Rust snake_case automatically? No — **Tauri converts camelCase JS args to snake_case Rust args by default**. If you name a Rust arg `vault_path`, call it with `{ vaultPath: ... }` from JS.
- **React 19 + strict mode**: effects run twice in dev. The agent loop guards against that via the `busy` flag; anything stateful you add should too.
- **Building takes forever the first time** (~18 min). Incremental rebuilds are fast (~30 sec for Rust-only changes, instant for TS).
- **CSS is all in `App.css`** — single file, no CSS modules. Keep it that way unless the file gets painful.

## File-size landmarks

- `agent.ts` ≈ 130 lines — the whole agent loop
- `ChatPane.tsx` ≈ 140 lines
- `lib.rs` ≈ 65 lines
- `App.css` ≈ 200 lines

If any of these cross 300 lines, split before it becomes unreadable.
