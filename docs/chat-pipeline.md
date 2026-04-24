# Chat Pipeline

The chat loop: user types → ChatPane → chat-controller → agent → streamText → store → UI.

## Files

- [src/ChatPane.tsx](../src/ChatPane.tsx) — textarea, @-mention picker, /skill picker, message bubbles, streaming render
- [src/chat-controller.ts](../src/chat-controller.ts) — orchestrator (compaction check → history build → runAgent → event loop → persist → git commit)
- [src/agent.ts](../src/agent.ts) — one agent turn: builds the system prompt + messages, picks provider options, calls `streamText`, pumps events
- [src/providers.ts](../src/providers.ts) — `buildModel()` per provider, `findModel()`, `supportsVision()`, live catalog accessor
- [src/modelCatalog.ts](../src/modelCatalog.ts) — fetchers for each provider's `/v1/models` endpoint + localStorage cache
- [src/skills.ts](../src/skills.ts) — meta-vault skill loader + `/name` expansion
- [src/context.ts](../src/context.ts) — AGENTS.md / CLAUDE.md / goals autoload
- [src/meta.ts](../src/meta.ts) — meta-vault path, system prompt, tool loader
- [src/compactor.ts](../src/compactor.ts) — summarize-older-turns when context > 85%

## End-to-end trace — one message

### 1. `ChatPane.send()` ([ChatPane.tsx:202](../src/ChatPane.tsx))

- `typed = input.trim()`. Empty + no mentions → return.
- Scan text for every `@token` matching `/(?:^|\s)@([\w][\w./-]*)/g`.
- For each token: use the picked-mention set first (has exact path from dropdown); fall back to case-insensitive basename match against `files` (the vault's file list). Union deduped by path.
- Build the **hidden preamble** via `buildMentionPreamble(resolved)`:
  - Text files → inline content + absolute path.
  - Binaries (PDFs, images, Office) → just `@rel — absolute path: /abs/path (binary)`.
  - Header says *"paths below are authoritative, do not search"*.
- Build the **visible footer** `[attached: @name → /abs/path, ...]` and append it to `text`. Stripped from the bubble render by `stripAttachedFooter()` in `MessageBubble`.
- `dispatchChatAction({kind: "send", text, contextPreamble})`.

### 2. `sendMessage()` ([chat-controller.ts:19](../src/chat-controller.ts))

- Look up `ModelSpec` and the corresponding `apiKey`. Return if any missing.
- **Compaction gate**: if `lastContext > 0.85 * MODEL_CONTEXT_LIMIT` AND `messages.length > KEEP_RECENT (4)`, call `compactConversation()` and `applyCompaction(summary, 4, banner)`.
- Append the **hidden preamble** (if any) as `{role: "user", content: preamble, hidden: true}` — visible to the agent, not rendered in the bubble list.
- Append the **visible user message**.
- Build history: filter out `system` messages, prepend the compaction summary as a synthetic user/assistant pair if present.
- Create a fresh `AbortController`, stash on `abortRef`.
- Call `runAgent({modelId, apiKey, vault, history, userMessage, onEvent, abortSignal, tavilyKey})`.

### 3. `runAgent()` ([agent.ts:39](../src/agent.ts))

Parallel load:
- `loadSessionContext(vault)` — reads `AGENTS.md` / `AGENT.md` / `CLAUDE.md` / `LEARNING_RULES.md` from vault root or `learn/`, plus `goals/*.md`.
- `loadSkills(vault)` — scans meta-vault `skills/*/SKILL.md`, returns `{name, description, body}[]`.
- `loadMetaSystemPrompt()` — reads `meta/system.md`; falls back to `FALLBACK_SYSTEM` if missing.
- `loadMetaTools()` — scans meta-vault `tools/*/TOOL.md`, returns `{[name]: ai.tool}`.

**Skill expansion** (`expandSkillInvocation(userMessage, skills)`):
- Regex `/(?:^|\s)\/([\w-]+)(?=\s|$)/g` finds every `/name` word-boundary token anywhere in the message.
- Each match's `skill.body` is wrapped in `<skill name="...">...</skill>` and prepended to the message. Original text is preserved.
- Multiple skills in one message → multiple blocks, deduped by name. `/a /a` counts once.

**System prompt assembled** from:
```
{metaSystem or FALLBACK_SYSTEM}
Vault root: {vault}
{platform shell note}
{session context files}
{skill index}
{meta tool list}
```

**Prompt caching** (Anthropic only): `providerOptions.anthropic.cacheControl: {type: "ephemeral"}` on the system message and the last history message. Ignored silently by other providers. ~10× cheaper input for repeat turns on Claude, 5-min TTL.

**Per-provider reasoning options** ([agent.ts:148](../src/agent.ts)):
- Anthropic **Opus 4.7+** → `{thinking: {type: "adaptive"}, output_config: {effort: "medium"}}`.
- Other Anthropic → `{thinking: {type: "enabled", budgetTokens: 3000}}`.
- OpenAI **o-series / gpt-5** → `{reasoningEffort: "medium"}`.
- Google **Gemini 2.5+** → `{thinkingConfig: {thinkingBudget: 3000}}`.
- OpenRouter → none (no universal flag).

**Vision scrubbing** ([agent.ts:107](../src/agent.ts)): if `supportsVision(spec)` is false, replace every `![...](data:image/...)` in every turn with `[image omitted — current model does not support vision]`. This is why marquee-to-Qwen used to bounce with *"No endpoints found that support image input"*.

Call `streamText({ model, messages, tools: {...builtinTools, ...metaTools}, stopWhen: stepCountIs(25), ... })`.

### 4. Event loop ([agent.ts:180](../src/agent.ts))

The AI SDK's `fullStream` emits structured parts:
- `text-delta` → `onEvent({kind: "text", delta})`
- `reasoning-start` / `reasoning-delta` → `reasoning_start` / `reasoning`
- `tool-call` → `tool_use` with name + input
- `tool-result` → `tool_result`
- `finish` → `done` with token totals

### 5. `onEvent` in chat-controller ([chat-controller.ts:109](../src/chat-controller.ts))

- Text deltas accumulate in a local `acc` string and append to `store.streamingText`. `STREAM_FLUSH_MS = 200` caps repaints at ~5 Hz so markdown/katex re-parsing doesn't freeze the UI.
- Tool events push to a local `tools: LiveTool[]` and `store.liveTools`.
- On `done`: `store.appendMessage({role: "assistant", content: acc, toolCalls: tools, usage})`, reset streaming buffers, update `tokenUsage` and `lastContext`, then `gitAutoCommit()` if the agent touched any files.

## Provider-specific branching (every place)

| Location | What branches |
|---|---|
| [providers.ts:38](../src/providers.ts) `buildModel` | SDK per provider; OpenRouter uses `createOpenAI(...).chat(id)` not `(id)` |
| [providers.ts:81](../src/providers.ts) `supportsVision` | allow-all for Anthropic/OpenAI/Google; id-regex for OpenRouter |
| [agent.ts:148](../src/agent.ts) providerOptions | thinking / reasoningEffort / thinkingConfig |
| [agent.ts:97](../src/agent.ts) cacheControl | only Anthropic honors it; others ignore |
| [modelCatalog.ts](../src/modelCatalog.ts) | fetcher shape per provider |
| [compactor.ts:25](../src/compactor.ts) | pick a cheap model from the same provider |

## Skills flow

1. **Discovery** ([skills.ts:12](../src/skills.ts)) — `loadSkills()` scans `<meta-vault>/skills/*/SKILL.md`. Front-matter keys: `name` (falls back to folder name), `description`. Body is the markdown after the front-matter.
2. **Index** — `skillPromptIndex()` emits a markdown list `- /name — description` into the system prompt so the model knows they exist.
3. **Invocation** — `expandSkillInvocation()` scans the user text for `/name` tokens. Each matched skill's body is wrapped in `<skill name="...">...</skill>` and prepended. Multiple skills in one message = multiple blocks.
4. **The model** decides whether to follow the skill instructions.

UI side ([ChatPane.tsx](../src/ChatPane.tsx)):
- `onInputChange` tracks a `skillMention` caret token like `fileMention` tracks `@`.
- Arrow keys / Tab / Enter pick; Escape closes.
- `pickSkill` inserts `/name ` at the caret, not at input start.

## @-mention flow

1. **Pick** ([ChatPane.tsx](../src/ChatPane.tsx) `pickMention`) — dropdown click inserts `@name ` at the caret and stores `{rel, path, name, raw}` in `mentions`.
2. **Manual typing** — user can also type `@foo.md` without picking. The mention isn't tracked, but `send()` backfills by basename match against `files`.
3. **Sync on edit** — `onInputChange` filters `mentions` down to entries whose `@name` still appears in the text (via negative-lookahead regex that tolerates trailing punctuation).
4. **Send** — builds `resolved = picked ∪ matched_from_text`, then:
   - hidden preamble with content + path per file;
   - inline footer `[attached: @name → /abs/path]` on the user text;
   - visible bubble strips the footer via `stripAttachedFooter`.

## Compaction

- Triggered in `sendMessage()` before the new turn is sent. One-turn lag: `lastContext` reflects the previous turn's usage.
- `compactConversation()` in `compactor.ts` picks a cheap same-provider model (haiku / mini / flash), filters out `system: true` messages, builds a transcript, and calls `generateText()` (non-streaming) with a compact-focused prompt.
- Result is applied via `applyCompaction(summary, keepCount = 4, banner)` → `messages = [banner, ...messages.slice(-4)]`, `compactionSummary = summary`.
- Subsequent turns prepend the summary as a synthetic `(user: [Earlier conversation summary] → assistant: Continuing from where we left off.)` pair before the retained messages.

## Streaming performance

- Text deltas are buffered into `acc` and `store.streamingText` is written every token. React subscribers to `streamingText` repaint.
- `STREAM_FLUSH_MS = 200` on a debounced flush avoids rebuilding the whole message markdown tree (remark + rehype + katex + highlight) 60 times per second.
- Live-tool rows render separately from the message body so they don't re-trigger the markdown pipeline.

## Live UI during a stream

Three pieces of feedback render while a turn is in progress — see `docs/frontend-layout.md` for the visual details.

- `streamingText` drives the in-progress assistant bubble.
- `streamingReasoning` drives a separate "Thinking..." collapsible above the main bubble (only for models that emit reasoning deltas — Anthropic Opus thinking, OpenAI o-series, Gemini 2.5).
- `liveTools` is an array of `{id, name, input, result?, startedAt}` objects that renders as one row per tool call. Updated via `pushLiveTool` on `tool_use` events and `updateLiveToolResult` on `tool_result`.
- `agentTodos` is populated by the built-in `TodoWrite` tool (which is **client-side** — see `docs/tools-and-meta.md`). Its execute step writes straight to the store via `useStore.getState().setAgentTodos`.

On the `done` event, all three are snapshot-copied into a single final assistant `ChatMessage` and the streaming buffers are cleared.

## Chat-pane actions

- **Send** (Enter) — see above.
- **Stop** — calls `dispatchChatAction({kind: "stop"})`, which fires `abortRef.current?.abort()` in `chat-controller.ts`. The `streamText` promise rejects with an abort error, the agent turn ends cleanly, partial text is preserved in the bubble.
- **Clear** — `dispatchChatAction({kind: "clear"})` resets `messages`, `tokenUsage`, `lastContext`, `compactionSummary`, streaming buffers, `liveTools`, `agentTodos` for the current vault. The 500 ms localStorage debounce picks it up on the next cycle, so the persisted history is also wiped.
- **setModel** — persists to `localStorage["vault_chat_model"]` and updates the store. Popout mirrors it.

## Known edge cases

- **Skills don't see the hidden preamble** — `expandSkillInvocation` receives only the user's trimmed text. If user does `/skill @file.md`, the skill body doesn't know about the file's contents. Workaround: skill has access via tools, or user pastes content.
- **Footer is redundant with preamble** when both are present — intentional belt-and-suspenders after models were observed ignoring the hidden preamble.
- **Compaction includes hidden messages** ([compactor.ts:37](../src/compactor.ts) filters only `system:true`, not `hidden:true`). Hidden preambles with file contents end up in the summary, bloating it. Minor fix candidate.
