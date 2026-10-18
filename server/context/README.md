# server/context — projects, instructions, roll-over, verifier (Order C)

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
agent-projects/<slug>/project.md          # <Name>, then the project's shared instructions and notes (optional)
agent-projects/<slug>/rules.md            optional project rules
```

**Projects are plain groupings** (Carl, 2026-10-18), like Claude.ai / ChatGPT Projects: a folder of chats (a
conversation's `project` meta field holds the slug) plus one optional shared file, project.md, which every chat
in the project gets in its instructions. Only Carl decides what is a project: he makes one and moves chats in or
out in the app (the chip, the chats list, the phone's sheet: `POST /conversation/project`, `/message {project}`).
No agent tool, on any surface, creates a project or changes a chat's project. A project is context, not a
boundary: the agent reads and writes anywhere in the vault, other projects' files and project.md included. Older
projects may still hold memory.md, plan.md and progress.md: they stay on disk, untouched, and are not loaded.

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
//   rollFraction (0.6), rollMaxTokens (300000), caps {project 8000 (project.md), recap 12000} (chars)
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
type ToolContext = { conv: ContextConv; convs?: ContextConv[] };   // convs: every conversation (ListProjects)
type Verdict = { verdict: "pass"|"fail"|"unsure"; notes: string[]; model: string; at: number; costUsd: number|null };
```

## Interface

| Function | Use |
|---|---|
| `contextToolSpecs: DynamicToolSpec[]` | Add to `thread/start` `dynamicTools`: **ListProjects** (read-only). |
| `isContextTool(name)` / `handleContextTool(name, args, ctx): Promise<DynamicToolCallResponse>` | Answer `item/tool/call` for those names; reply with the result as is. Never throws. |
| `listProjectsText(project?, current?, convs?)` | ListProjects' answer, shared with voice (server/voice.ts). |
| `buildDeveloperInstructions(conv, {rolePrompt?}): string` | `developerInstructions` for `thread/start` (new conversation, and the new thread after a roll-over). |
| `rulesPrefixForTurn(conv?): string` | Put in front of **every** turn's input text (`turn/start`, wake and nudge turns, steers optional). `""` when there are no rules files. Read fresh each call. |
| `shouldRoll(conv, usage): boolean` | Call on `thread/tokenUsage/updated` (or at turn end) with `params.tokenUsage`. |
| `rollThreshold(model, window?)` | `min(window × 0.6, 300k)`; window = the engine's `modelContextWindow`, else the catalog, else 258,400. |
| `buildRecap(conv, {signal?}): Promise<Recap>` | `{recap, marker, model, costUsd, fallback}`. Never throws (a failed model → a verbatim excerpt, `fallback:true`). |
| `verifyDone({conv, summary, evidence[]}): Promise<Verdict>` | For the **Done** tool. Resolves within 90 s; a model failure or the time limit → `"unsure"`. Never throws. |
| `formatVerdict(v): string` | One line for the reply and the push: `Verifier (anthropic/claude-sonnet-5.5): pass — <first note>`. |
| `verifierModelFor(agentModel)` | Sonnet 5.5 unless the agent is Anthropic, then GPT-6.1 Sol. |
| `projectCost(nameOrSlug, convs?): ProjectCost \| null` | `Cost{project}`: `{slug, name, totalUsd, missingCalls, parts[{id,title,costUsd,missingCalls}]}` over conversations whose meta `project` is the slug. `convs` defaults to every conversation on disk. |
| `listProjects()`, `readProject(slug)` (`{slug, name, dir, notes, rules}`), `findProject(nameOrSlug)`, `ensureProject(name, desc?)`, `createProject(name, desc?)`, `readGlobalRules()` | Plain readers, and the writers for Carl's own actions (`/message {project}`, `POST /conversation/project`): a new project is its folder and a project.md that names it. |
| `latestRollover(conv)`, `ROLE_PROMPT`, `WORK_RULES`, `PROJECTS_RULE`, `RECHECK_RULE`, `ROLLOVER_TEXT` | Constants and helpers. `WORK_RULES` (every thread): size the work to the ask (small asks in place, in the real file; git is the undo), do it now (no mission, schedule or job unless asked or needed), read back before claiming, and what a note is. |

### Tools (what the agent sees)

- `ListProjects {project?}` — Carl's projects with their chats' titles; with `project`, its notes file (path and
  text) and all its chats. Read-only. The agent edits project.md, like any file, with its file tools.

The notes tools (ListNotes, CreateNote, UpdateNote, ResolveNote, ReopenNote, DeleteNote) are not CONTEXT's: they
are server/notesTools.ts, the same code for pi and voice.

### How ENGINE wires it

1. **New conversation / new thread:** `developerInstructions = buildDeveloperInstructions(conv)` (ENGINE may prepend
   its adapted system prompt, or pass it as `rolePrompt` to replace `ROLE_PROMPT`).
2. **Every turn:** `text = rulesPrefixForTurn(conv) + userText`.
3. **Tools:** `dynamicTools: [...engineTools, ...noteToolSpecs, ...contextToolSpecs]`; on `item/tool/call` with
   `isContextTool(tool)`, reply `await handleContextTool(tool, arguments, {conv, convs})`.
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
summary and the evidence, and three read-only tools built on the server's
fs commands: `read_file {path, offset?, limit?}`, `list_dir {path}`, `grep {pattern, path?, glob?}` (relative paths
resolve against the vault). It cannot run commands: command outputs must be quoted in `evidence`. It may not read
`.git` or the key store (`$VC_SECRETS_DIR`, else `$XDG_CONFIG_HOME/vault-chat` or `~/.config/vault-chat`, symlinks
resolved), plus `verifierDeny`. At most 10 model rounds; it answers `{"verdict","notes"}` JSON.

## Live smoke (box, 2026-10-10)

Real OpenRouter, scratch vault `~/p2-context/vault`: Sonnet 5.5 verified a true claim (`pass`, read the file
itself, 12.5 s) and a false one (`fail`, 4.4 s); Gemini 3.8 Flash wrote a recap that included the project memory
(5.4 s). Total spend $0.03.
