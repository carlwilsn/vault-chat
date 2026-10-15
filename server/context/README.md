# server/context — projects, memory, instructions, roll-over, verifier (Order C)

A library ENGINE (Order A) calls. It owns plain files under `<vault>/.vault-chat/` and `<vault>/agent-projects/` and makes model
calls only for the roll-over recap and the Done verifier (OpenRouter Responses API, non-streaming,
key read in-process from the key store; never logged). It never writes conversation files: ENGINE does,
from what these functions return.

```
npx vitest run --config server/context/vitest.config.ts   # 22 tests, temp vaults + a fake model, no build
npx tsc -p server/tsconfig.json                             # type-checks this folder too
```

Import everything from `server/context/index.ts`.

## Files

```
.vault-chat/rules.md                       Carl's global rules (short; written by hand or by the agent's shell)
agent-projects/<slug>/project.md          # <Name> · What · Why · Done when · Status
agent-projects/<slug>/memory.md           # Memory · Decisions · Tried and learned · Conventions (+ any ## section)
agent-projects/<slug>/plan.md
agent-projects/<slug>/progress.md         dated lines appended by Plan{progressNote}
agent-projects/<slug>/rules.md            optional project rules
agent-projects/<slug>/learnings.md        workers' one-liners (ENGINE appends)
.vault-chat/local/projects/<slug>/        the server's own state (pinned check/metric/budget, tasks): read-only to the agent
```

`agent-projects/` is a plain vault folder (`src/agentProjects.ts` names it), hidden by default: the first
time a vault has it, `agent-projects` is added to `.vaultchatignore` (the file tree's "Hidden files") and
recorded in `.vault-chat/hidden-by-default`, so unhiding it there sticks. Projects used to live in
`.vault-chat/projects/`; `prepareProjects` moves them (the app does the same on vault open,
`prepare_agent_projects` in lib.rs), never overwriting a file.

`<slug>` = `slugify(name)` (`"Coconut Detector"` → `coconut-detector`). The display name is project.md's
first `# ` heading. Writes are atomic (temp + rename). A project is found by slug or by name, case-insensitively.

## Setup (once, at boot)

```ts
configureContext({ vault: cfg.vault });         // required
// optional: baseUrl (default $VC_OPENROUTER_BASE or https://openrouter.ai/api/v1), apiKey: () => string|null
//   (default: the key store's "api.openrouter"), agentModel ("openai/gpt-6.1-sol"),
//   recapModel ("google/gemini-3.8-flash"), verifierModel ("anthropic/claude-sonnet-5.5"),
//   verifierModelAlt ("openai/gpt-6.1-sol", used when the agent is Anthropic), verifierTimeoutMs (90000),
//   verifierDeny (extra paths the verifier may not read; the key store dir is always denied),
//   rollFraction (0.6), rollMaxTokens (300000), caps {project 4000, memory 8000, plan 4000, progress 3000, recap 12000} (chars)
await loadCatalog();                            // optional: OpenRouter /models → context windows for shouldRoll
setModelWindow(model, tokens);                  // or feed it windows ENGINE already read
```

## Types

```ts
type ContextConv = {                 // the conversation's meta + messages, as ENGINE holds it
  id: string; title?: string; project?: string; model?: string; threadId?: string;
  messages?: ContextMessage[]; costUsd?: number; costMissingCalls?: number; [k: string]: unknown;
};
type ContextMessage = { role: "user"|"assistant"; content: string; toolCalls?: {...}[]; system?: boolean;
  hidden?: boolean; costUsd?: number; rollover?: RolloverInfo; [k: string]: unknown };
type RolloverInfo = { at: number; fromThread?: string; recap: string };
type ThreadTokenUsage = { total?: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow?: number|null };
                                     // = the last model call's usage, from the engine
type DynamicToolSpec = { type: "function"; name: string; description: string; inputSchema: object };
type DynamicToolCallResponse = { success: boolean; contentItems: { type: "inputText"; text: string }[] };
type ToolContext = { conv: ContextConv; setConversationProject: (slug: string) => void | Promise<void> };
type Verdict = { verdict: "pass"|"fail"|"unsure"; notes: string[]; model: string; at: number; costUsd: number|null };
```

## Interface

| Function | Use |
|---|---|
| `contextToolSpecs: DynamicToolSpec[]` | Add to `thread/start` `dynamicTools`: **SetProject**, **ProjectMemory**, **Plan**, **ProjectCost**. |
| `isContextTool(name)` / `handleContextTool(name, args, ctx): Promise<DynamicToolCallResponse>` | Answer `item/tool/call` for those names; reply with the result as is. Never throws. |
| `buildDeveloperInstructions(conv, {rolePrompt?}): string` | `developerInstructions` for `thread/start` (new conversation, and the new thread after a roll-over). |
| `rulesPrefixForTurn(conv?): string` | Put in front of **every** turn's input text (`turn/start`, wake and nudge turns, steers optional). `""` when there are no rules files. Read fresh each call. |
| `shouldRoll(conv, usage): boolean` | Call on `thread/tokenUsage/updated` (or at turn end) with `params.tokenUsage`. |
| `rollThreshold(model, window?)` | `min(window × 0.6, 300k)`; window = the engine's `modelContextWindow`, else the catalog, else 258,400. |
| `buildRecap(conv, {signal?}): Promise<Recap>` | `{recap, marker, model, costUsd, fallback}`. Never throws (a failed model → a verbatim excerpt, `fallback:true`). |
| `verifyDone({conv, summary, evidence[]}): Promise<Verdict>` | For the **Done** tool. Resolves within 90 s; a model failure or the time limit → `"unsure"`. Never throws. |
| `formatVerdict(v): string` | One line for the reply and the push: `Verifier (anthropic/claude-sonnet-5.5): pass — <first note>`. |
| `verifierModelFor(agentModel)` | Sonnet 5.5 unless the agent is Anthropic, then GPT-6.1 Sol. |
| `projectCost(nameOrSlug, convs?): ProjectCost \| null` | `Cost{project}`: `{slug, name, totalUsd, missingCalls, parts[{id,title,costUsd,missingCalls}]}` over conversations whose meta `project` is the slug. `convs` defaults to every conversation on disk. |
| `listProjects()`, `readProject(slug)`, `findProject(nameOrSlug)`, `ensureProject(name, desc?)`, `createProject(name, desc?)`, `readGlobalRules()` | Plain readers/writers, for `/message {project}` and any UI. |
| `latestRollover(conv)`, `ROLE_PROMPT`, `RECHECK_RULE`, `ROLLOVER_TEXT` | Constants and helpers. |

### Tools (what the agent sees)

- `SetProject {name, description?}` — a proposal Carl decides: `ctx.ask` raises an AskUser card ("Move this chat to
  <existing>?" Yes / Not now, or "Turn this into a new project '<name>'?" Create / Not now) and waits. Only a yes
  creates-or-attaches: `ctx.setConversationProject(slug)` (ENGINE persists `project` on the meta) and
  `ctx.conv.project`; returns the project's files, capped. "Not now" leaves the chat as it was and is kept on the
  meta (`projectDeclined {name, at}`): a later SetProject is refused without a card until Carl mentions a project
  (or that name) himself. Already in that project: no card. No `ctx.ask`: refused. Carl's own choice (the chip,
  the phone's sheet, `POST /conversation/project`) applies directly.
- `ProjectMemory {action: read|append|update, file?: memory|project|rules (default memory), section?, text?}` —
  `read` the file or one `## section`; `append` to a section's end (or the file's end with no section); `update`
  replaces a section's text (created when missing). Needs a tagged project.
- `Plan {action: read|update, plan?, progress?, progressNote?}` — `plan`/`progress` replace the files;
  `progressNote` appends `- YYYY-MM-DD HH:MM <note>` to progress.md.
- `ProjectCost {project?}` — the project's spend; defaults to the conversation's project.

### How ENGINE wires it

1. **New conversation / new thread:** `developerInstructions = buildDeveloperInstructions(conv)` (ENGINE may prepend
   its adapted system prompt, or pass it as `rolePrompt` to replace `ROLE_PROMPT`).
2. **Every turn:** `text = rulesPrefixForTurn(conv) + userText`.
3. **Tools:** `dynamicTools: [...engineTools, ...contextToolSpecs]`; on `item/tool/call` with `isContextTool(tool)`,
   reply `await handleContextTool(tool, arguments, {conv, setConversationProject})`.
4. **Roll-over:** when `shouldRoll(conv, usage)` and the turn has ended: `const r = await buildRecap(conv)`; append
   `r.marker` to the **same** conversation (a `system` message: both renderers draw it as a quiet divider, and it
   carries the recap in `rollover`); add `r.costUsd` to the conversation's cost; `thread/start` a new thread with
   `buildDeveloperInstructions(convWithMarker)`; store the new `threadId`. Set pi's
   compaction above `rollThreshold(model)` so roll-over wins over pi's own compaction (the engine does).
5. **Done:** `const v = await verifyDone({conv, summary, evidence})`; store it on the conversation (e.g. a
   `verdicts[]` meta field or on the message), add `v.costUsd` to the conversation's cost, show `formatVerdict(v)`
   in the reply and the push. Never block on it.
6. **Cost{project}:** `projectCost(project, convsInMemory?)`.

### The verifier

Default `anthropic/claude-sonnet-5.5` for a non-Anthropic agent. It gets Carl's asks from the conversation, the
project's project.md ("done when"), the summary and the evidence, and three read-only tools built on the server's
fs commands: `read_file {path, offset?, limit?}`, `list_dir {path}`, `grep {pattern, path?, glob?}` (relative paths
resolve against the vault). It cannot run commands: command outputs must be quoted in `evidence`. It may not read
`.git` or the key store (`$VC_SECRETS_DIR`, else `$XDG_CONFIG_HOME/vault-chat` or `~/.config/vault-chat`, symlinks
resolved), plus `verifierDeny`. At most 10 model rounds; it answers `{"verdict","notes"}` JSON.

## Live smoke (box, 2026-10-10)

Real OpenRouter, scratch vault `~/p2-context/vault`: Sonnet 5.5 verified a true claim (`pass`, read the file
itself, 12.5 s) and a false one (`fail`, 4.4 s); Gemini 3.8 Flash wrote a recap that included the project memory
(5.4 s). Total spend $0.03.
