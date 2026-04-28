# State & Persistence

Single Zustand store. Three persistence layers: **localStorage** (cheap UI state), **OS keychain** (credentials), and the **meta-vault directory** (user-editable files). Chat history is localStorage-scoped per vault.

## Files

- [src/store.ts](../src/store.ts) — Zustand store + persistence glue
- [src/keychain.ts](../src/keychain.ts) — OS-keychain wrapper via Tauri `invoke`
- [src/sync.ts](../src/sync.ts) — main ↔ popout sync
- [src/compactor.ts](../src/compactor.ts) — context compaction
- [src/git.ts](../src/git.ts) — auto-commit after agent-touched files
- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) — `keychain_*`, `read_ignore_lines`, git commands

## Store shape

Grouped by concern. See [store.ts:203](../src/store.ts) for the `State` type.

**UI / layout** (memory only):
`files`, `currentFile`, `currentContent`, `panes`, `splitDirection`, `activePaneId`, `busy`, `showSettings`, `mode`, `leftCollapsed`, `rightCollapsed`, `popoutOpen`, `streamingText`, `streamingReasoning`, `liveTools`, `agentTodos`, `compacting`, `catalogRefreshing`, `catalogErrors`.

**Persisted to localStorage**:
- `vaultPath` → `vault_chat_last_vault`
- `modelId` → `vault_chat_model`
- `theme` → `vault_chat_theme`
- `catalog` → `vault_chat_model_catalog` (live model list cache)
- `messages`, `tokenUsage`, `lastContext`, `compactionSummary` → `vault_chat_history` (debounced 500 ms, per-vault)

**Persisted to OS keychain** ([keychain.ts](../src/keychain.ts)):
- `api.anthropic`, `api.openai`, `api.google`, `api.openrouter`
- `service.tavily`
- `user.<name>` for user-managed custom keys (registry in localStorage `vault_chat_user_keys`)

**Persisted to disk (not store)**:
- `%APPDATA%/com.vault-chat.app/meta/system.md` — user system prompt
- `%APPDATA%/com.vault-chat.app/meta/skills/<n>/SKILL.md`
- `%APPDATA%/com.vault-chat.app/meta/tools/<n>/TOOL.md` + `run.*`
- `<vault>/.vault-chat-ignore` — hidden-file list (see below)

## `.vault-chat-ignore`

Plain text file at the vault root. Each non-empty, non-comment line is a path or pattern the UI should hide from the file tree. The agent still sees hidden files — this is UI sugar only, not access control. Add entries via:
- Right-click a file in the tree → Hide
- Edit `.vault-chat-ignore` directly — it's a convention file, not a walled API.

Unhide via the Titlebar's Eye-icon modal (check the lines to remove, click Unhide).

Rust commands: `read_ignore_lines`, `add_to_ignore`, `rename_in_ignore`, `remove_from_ignore`.

## Boot sequence ([main.tsx](../src/main.tsx))

1. `hydrateKeychain()` ([store.ts:197](../src/store.ts)):
   - `migrateLocalStorageKeys()` — one-time migration of legacy `vault_chat_api_keys` / `vault_chat_service_keys` into the keychain, then clears the localStorage entries. Silent — user never re-enters.
   - `fetchAllFromKeychain()` — parallel read of `anthropic / openai / google / openrouter / tavily`, loaded into `apiKeys` + `serviceKeys`.
   - `loadCatalogFromLocalStorage()` — seed the model catalog from last session's cache; `setLiveCatalog(cached)`.
2. `hydratePersistedChat()` ([store.ts:723](../src/store.ts)) — if the persisted chat's `vaultPath` equals the current vault path, restore messages + usage + compaction summary. Silent no-op on mismatch.
3. `<App />` mounts, subscribes schedule the first debounce cycle.

## Chat history persistence

### Write path ([store.ts:691](../src/store.ts))
- A `subscribe` callback watches `(vaultPath, messages, tokenUsage, lastContext, compactionSummary)`.
- On change, it computes a signature and reschedules a **500 ms debounce**. Only writes if the signature changed vs. the last write.
- Snapshot object: `{vaultPath, messages, tokenUsage, lastContext, compactionSummary}` → `localStorage["vault_chat_history"]` as JSON.
- **Hidden messages ARE persisted** (they're in `messages` with `hidden: true`). Streaming buffers are not.

### Read path
- On boot, `hydratePersistedChat()` parses the JSON and only applies it if `vaultPath` matches.
- Cross-vault history is implicitly dropped: you can switch vaults and come back, but only one vault's history is cached at a time.

### Vault switching
- `setVault(p)` ([store.ts:340](../src/store.ts)):
  - Writes new path to `VAULT_STORAGE`.
  - If `p === s.vaultPath` (string equality), chat is untouched.
  - Otherwise clears `messages`, `tokenUsage`, `lastContext`, `compactionSummary`, streaming buffers, live tools, agent todos.

**Gotcha — path canonicalization is absent.** Switching via symlink or case-mismatched path will look like a different vault and silently wipe the chat. If this matters, normalize via a `realpath()` Rust call before comparing.

## Keychain model ([keychain.ts](../src/keychain.ts))

Service name: `com.vault-chat.app` (one service, many keys — namespace is baked into the key string).

**API key shape**:
```
api.anthropic     api.openai     api.google     api.openrouter
service.tavily
user.<name>       ← user-registered custom keys (Gmail tokens, SerpAPI, etc.)
```

**User key registry** is a separate `localStorage["vault_chat_user_keys"]` JSON array tracking names (the keychain API has no list-by-service call). Two writes per `setUserKey`: one to the keychain, one to the registry. **Not atomic** — a crash between the two leaves an orphan.

**Async writes** are fire-and-forget with `console.warn` on failure. The store value updates synchronously; if the keychain write fails, the next boot's `fetchAllFromKeychain` will drop that key and the app will ask for it again.

## Model catalog cache ([modelCatalog.ts](../src/modelCatalog.ts))

- `fetchAllCatalog(apiKeys)` hits every provider's `/models` endpoint in parallel. Per-provider failures populate `errors` and the seed list backfills missing providers.
- `saveCatalogToLocalStorage()` writes the merged + sorted list to `vault_chat_model_catalog`.
- `loadCatalogFromLocalStorage()` reads it on boot.
- `providers.ts` exports `setLiveCatalog(list)` to overwrite the module-level `_liveCatalog` variable that `findModel()` reads first (falling back to the seed `MODELS`).

## Popout sync ([sync.ts](../src/sync.ts))

Two-tier broadcast:
- **`chat:state`** — slow-moving things (messages, modelId, tokenUsage, vaultPath, compaction state). Fires when reference changes.
- **`chat:stream`** — fast-moving (busy, streamingText, streamingReasoning, liveTools, agentTodos). Fires at ~5 Hz during a stream.

**Handshake**: popout sends `chat:ready`, main broadcasts current state. Retry backoff `[0, 150, 400, 900, 1800, 3000]`ms if the first snapshot lands before the popout is subscribed.

**Action dispatch from popout**:
- `send`, `stop`, `clear`, `setModel` are emitted as events. Main applies them locally.
- Popout doesn't run the agent; only main does. Popout is a read-slave + action sender.

**Divergence risk**: both windows are live processes. If both run a turn simultaneously (e.g., popout opens while main mid-stream), whichever broadcasts last wins. In practice only one instance runs the agent because the popout dispatches through events, but edge cases exist.

## Compaction ([compactor.ts](../src/compactor.ts))

- Triggered by `sendMessage()` when `lastContext > 0.85 * MODEL_CONTEXT_LIMIT (200_000)` AND `messages.length > KEEP_RECENT (4)`.
- **One-turn lag**: `lastContext` is updated from the *previous* turn, so compaction fires at the start of the next turn.
- `compactConversation()`:
  - Picks a cheap same-provider model (`/haiku|mini|flash/` match first).
  - Filters `system: true` messages. **Does not filter `hidden: true`** — hidden preambles with file contents end up in the summary, which is a minor bloat.
  - Builds a transcript and calls `generateText()` (non-streaming).
  - Returns a summary string.
- `applyCompaction(summary, keepCount=4, banner)` ([store.ts:602](../src/store.ts)) replaces `messages` with `[banner, ...messages.slice(-keepCount)]`.
- On next turn, the summary is prepended to history as a synthetic `(user: Earlier summary → assistant: Continuing)` pair.

**Failure**: if `compactConversation()` throws, the catch isn't in the store — it propagates up from `sendMessage()`. The caller logs. Store isn't updated, so the next boot will replay the same old history + next turn, potentially triggering another compaction.

## Git auto-commit ([git.ts](../src/git.ts), [chat-controller.ts:140](../src/chat-controller.ts))

- After a turn finishes, if any tool touched files (`Write`, `Edit`, `Delete`, `Bash`, `NotebookEdit`), call `gitCommit(vault, subject, body)`.
- `subject` derives from the user prompt (minus any leading `/skill-name`), clipped to 72 chars. Falls back to `"agent <verb> <file>"` if the user didn't type anything (e.g. just a marquee ask).
- `body` lists touched files.
- Errors are `.catch(() => {})` — silent. If git is unavailable, the app continues but the changes aren't snapshotted.
- `gitInitIfNeeded(vault)` runs on every `setVault` that opens a folder — auto-initializes a repo if none exists, so the "history" UI has something to show.

## History UI ([Titlebar.tsx](../src/Titlebar.tsx))

- "History" icon opens a modal listing recent commits via `git log` (anchor marker `vault-chat start` marks the first commit this app made in the repo).
- Click a commit → shows `git show` diff (summary by default, "show file contents" expands to full diff).
- "Go back to this commit" → `gitRestoreToCommit(vault, hash)` — runs `git reset --hard <hash>` then reloads the tree. Destructive; user click is the confirmation.

## Keys model glance (what gets read where)

| Consumer | Reads |
|---|---|
| Agent stream | `apiKeys.anthropic/openai/google/openrouter` |
| Tavily WebSearch tool | `serviceKeys.tavily` |
| Meta-vault tool with `requires_keys` | `user.<name>` via `getUserKeysAsEnv()` |
| Model catalog refresh | `apiKeys.*` (all non-null providers) |

## Migrations

- **v0.1.0 keychain migration** ([store.ts:171](../src/store.ts)): one-time sweep of legacy `localStorage.vault_chat_api_keys` / `vault_chat_service_keys` into the OS keychain. After successful move, clears the localStorage. No rollback.
