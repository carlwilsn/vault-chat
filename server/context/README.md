# server/context — projects and instructions (Order C)

A library ENGINE (Order A) calls. It owns plain files under `<vault>/.vault-chat/` and the projects home (the
machine's, in no vault: `server/projectsHome.ts`, `configureContext({projectsHome})`) and makes no model calls. It never writes conversation files: ENGINE does, from what these functions return.
Long sessions are pi's own compaction (no roll-over here since 2026-10-18), and there is no Done verifier: the
agent reads back what it changed (`WORK_RULES`).

```
npx vitest run --config server/context/vitest.config.ts   # temp vaults, no build
npx tsc -p server/tsconfig.json                             # type-checks this folder too
```

Import everything from `server/context/index.ts`.

## Files

```
.vault-chat/rules.md                       Carl's global rules (short; written by hand or by the agent's shell)
<projects home>/<slug>/project.md        # <Name>, then the project's shared instructions and notes, then ## Memory
<projects home>/<slug>/rules.md          optional project rules
(before 2026-10-28 these were <vault>/agent-projects/<slug>/; `vault-chat-server.mjs projects migrate` moves them)
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
// optional: agentModel ("openai/gpt-6.1-sol"), recapModel (the fast model for one-shots, "google/gemini-3.8-flash"),
//   caps {project 8000 (project.md), recap 12000 (an older roll-over's recap)} (chars)
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
```

## Interface

| Function | Use |
|---|---|
| `contextToolSpecs: DynamicToolSpec[]` | Add to `thread/start` `dynamicTools`: **ListProjects** (read-only). |
| `isContextTool(name)` / `handleContextTool(name, args, ctx): Promise<DynamicToolCallResponse>` | Answer `item/tool/call` for those names; reply with the result as is. Never throws. |
| `listProjectsText(project?, current?, convs?)` | ListProjects' answer, shared with voice (server/voice.ts). |
| `buildDeveloperInstructions(conv, {rolePrompt?}): string` | `developerInstructions` for a new thread (an older conversation that rolled over gets its recap in them). |
| `rulesPrefixForTurn(conv?): string` | Put in front of a turn's input text when the rules changed. `""` when there are no rules files. Read fresh each call. |
| `projectCost(nameOrSlug, convs?): ProjectCost \| null` | `Cost{project}`: `{slug, name, totalUsd, missingCalls, parts[{id,title,costUsd,missingCalls}]}` over conversations whose meta `project` is the slug. `convs` defaults to every conversation on disk. |
| `listProjects()`, `readProject(slug)` (`{slug, name, dir, notes, rules}`), `findProject(nameOrSlug)`, `ensureProject(name, desc?)`, `createProject(name, desc?)`, `readGlobalRules()` | Plain readers, and the writers for Carl's own actions (`/message {project}`, `POST /conversation/project`): a new project is its folder and a project.md that names it. |
| `latestRollover(conv)`, `ROLE_PROMPT`, `WORK_RULES`, `PROJECTS_RULE`, `RECHECK_RULE` | Constants and helpers. `WORK_RULES` (every thread): size the work to the ask (small asks in place, in the real file; git is the undo), do it now (no mission, schedule or job unless asked or needed), read back before claiming, and what a note is. |

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
4. **Cost{project}:** `projectCost(project, convsInMemory?)`.
