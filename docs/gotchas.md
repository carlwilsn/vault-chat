# Gotchas, Invariants, and Known Bugs

Cross-cutting weirdness that bit us once or is still latent. Read this before editing the chat pipeline, the store, or anything provider-specific.

## Provider quirks

### OpenRouter speaks Chat Completions, not Responses API
- Fixed in [providers.ts:52](../src/providers.ts): `r.chat(spec.id)` not `r(spec.id)`.
- Before the fix, every tool call through Qwen / DeepSeek bounced with *"Invalid Responses API request"*.
- Native OpenAI stays on `r(id)` (Responses API) because that's where `reasoningEffort` works.

### Opus 4.7 uses adaptive thinking, older Claude uses enabled+budgetTokens
- [agent.ts:148](../src/agent.ts): branch on `^claude-opus-4-7` regex.
- Opus 4.7: `{thinking: {type: "adaptive"}, output_config: {effort: "medium"}}`.
- Opus 4.6 / Sonnet 4.6 / Haiku 4.5: `{thinking: {type: "enabled", budgetTokens: 3000}}`.
- Sending the new shape to older models → API error `thinking.type.enabled is not supported`.

### Prompt caching is Anthropic-only
- [agent.ts:97](../src/agent.ts): `{anthropic: {cacheControl: {type: "ephemeral"}}}` on system + last history message.
- Other providers silently ignore `providerOptions.anthropic.*`. Gemini and OpenRouter pay full input tokens each turn.
- OpenAI has implicit caching (no param needed) so it's roughly fine.
- 5-minute TTL on Anthropic; older turns lose their cache.

### Image input — strip before non-vision models
- [agent.ts:107](../src/agent.ts): if `!supportsVision(spec)`, replace every `![...](data:image/...)` with `[image omitted — current model does not support vision]`.
- Without this, OpenRouter bounces Qwen3-235B with *"No endpoints found that support image input"*.
- `supportsVision` ([providers.ts:81](../src/providers.ts)) is allow-all for Anthropic/OpenAI/Google; regex-based for OpenRouter. **The regex has false positives**: it matches `gpt-4` broadly, which catches `gpt-4-turbo` (vision) but also `gpt-4-turbo-preview` (text-only on OpenRouter). If the error surfaces again, tighten the regex or allowlist specific ids.

## Platform quirks

### Windows Bash shell is cmd.exe
- [lib.rs:579](../src-tauri/src/lib.rs): `cmd /C <command>`. No bash semantics.
- The system prompt tells the model to use `powershell -NoProfile -Command "..."` for Unix-y behavior, `date /T` not `date` (which hangs interactively), `time /T` for time.
- `&&` and `||` work in cmd/C but behave per `cmd` rules, not bash.

### Path separator normalization
- All Rust file listings normalize `\` → `/` when returning to the UI. Internal comparisons use forward slashes.
- Windows terminal opener (`lib.rs:242`) converts back to `\` for `cmd`.

### Popout open on macOS may not notice window close immediately
- `setPopoutOpen(false)` runs on a window-destroyed event. If Tauri doesn't fire it (e.g. crash), the state can go stale and the docked chat won't re-render. Manual restart fixes.

## Silent failures

- **git auto-commit** ([chat-controller.ts:140](../src/chat-controller.ts)) — `.catch(() => {})`. If git is unavailable or unhappy, the user sees no warning. Their agent edits just aren't snapshotted.
- **keychain read/write** ([keychain.ts:8](../src/keychain.ts)) — wrapped in try/catch with `console.warn`. If the OS keychain is locked, boot returns `null` per slot; the user sees an empty Settings pane.
- **Model catalog fetch** ([modelCatalog.ts](../src/modelCatalog.ts)) — per-provider failures collect into `errors` and surface in Settings under the dropdown, but only if Settings is open. Otherwise the cache from last session is used invisibly.
- **Pane reload after agent edit** ([chat-controller.ts:156](../src/chat-controller.ts)) — if the file was deleted, the reload swallows the error; UI may show stale content until next click.
- **Meta-tool missing `requires_keys`** ([meta.ts:220](../src/meta.ts)) — script runs anyway with `env = {}`. Typical upstream behavior: unauthenticated fallback, rate-limited, no error.

## Undocumented invariants

### Chat history
- `hidden: true` messages are **persisted** to localStorage (they're in `messages`) and **sent to the model** every turn.
- `system: true` messages render as a centered italic line in the chat; the agent doesn't see them ([chat-controller.ts:74](../src/chat-controller.ts) filters them).
- Compaction does NOT filter `hidden: true`. Hidden preambles end up in summaries.

### Vault path comparison
- `setVault(p)` uses string equality to decide whether to wipe history. No canonicalization. Symlinks, trailing slashes, or case differences will wipe.

### The first user message after compaction
- `chat-controller.ts:76` prepends a synthetic `(user: [Earlier conversation summary] ... → assistant: Continuing from where we left off.)` pair. The model sees this as past history.

### Streaming closure
- Once the agent stream emits `done`, no more events should arrive. There is no re-entrancy guard; a buggy adapter that emits `done` twice would double-append the assistant message.

### Bash output truncation
- Rust caps at 50k bytes per stream and inserts a `…[truncated N bytes]` marker.
- The TS tool wrapper then truncates to 8k (`SHORT_CAP`). The agent sees "…[truncated]" but referencing the 8k cut, not the original 50k total. **The agent doesn't know the true size.**

### Vault boundary is not enforced
- `Read`, `Bash`, `Glob`, `Grep`, `ListDir` accept absolute paths and follow symlinks.
- `.git/` **write** is blocked by `path_touches_dot_git`; **read** is not — the agent can inspect git internals freely.
- Combined with Bash, the agent can do anything the user's shell can do on their machine.

### Catalog dropdown uses stale cache until a refresh
- `setLiveCatalog(cached)` runs on boot from localStorage. New models (e.g., a freshly released Sonnet version) won't appear until you hit "Refresh" in Settings or manually trigger a refresh.

## Things that look like bugs but are intentional

- The `@rel → /abs/path` footer in the visible user message. Looks redundant with the hidden preamble; is redundant. Kept because some models ignore the hidden preamble and re-search via Glob. Stripped from the bubble render by `stripAttachedFooter` so users don't see it.
- The `dangerously-direct-browser-access` header on Anthropic calls. Tauri is the only renderer; this flag is just a library warning wanted by the Anthropic SDK when called from non-Node. It's not a security escape.
- The `anthropic` key on `providerOptions` even for non-Anthropic providers (in `cacheControl`). The AI SDK routes providerOptions by provider key, so this is silently no-op for the wrong adapter.

## Performance smells to watch

- `Promise.all` with no timeout on provider catalog fetches and keychain reads. One hung provider can stall boot or the refresh.
- Markdown pipeline (remark + rehype + katex + highlight) is heavy; we throttle streaming text updates to ~5 Hz via `STREAM_FLUSH_MS = 200`. Don't remove.
- FileTree renders every row's drag handlers even when not visible. For vaults with thousands of files, collapse deep folders.

## Security notes

- The Bash tool has no shell escaping. If anything ever constructs tool calls from untrusted input, command injection is trivial. Today only the agent constructs them; the agent is trusted.
- `NotebookView` uses `dangerouslySetInnerHTML` for SVG / HTML cell outputs. Notebooks are assumed to be local and user-trusted. Don't open notebooks from random sources without reviewing them.
- API keys can be leaked via Bash — `echo $ANTHROPIC_API_KEY` from within a meta-tool with `requires_keys` would print it into chat history. User-facing footgun; not currently mitigated.
