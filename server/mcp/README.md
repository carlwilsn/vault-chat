# MCP migration: reconnaissance and first chunk

**Status: staged foundation, NOT the requested completed migration.** The two
adapter modules in this directory are not mounted by `server/http.ts`, and pi
still uses `vc:host-call`. No existing tool path or device behavior was changed.
Do not present this branch as ready for Carl to Keep.

Branch: `agent/mcp-tools`, based on verified local `main` **and** `origin/main`
`94b7daad1989ead21d37adad1daf96a295dab02a`. Nothing merged or pushed.

## What is implemented

- `tools.ts`: official MCP SDK server using existing `ToolSpec` JSON Schemas and
  a host-bound execution closure. No copied tool schemas, no protocol parser,
  no agent, no conversation state, no model calls. The SDK's JSON Schema
  validator checks arguments before invoking the existing implementation.
- `http.ts`: standard Streamable HTTP adapter, no listener opened by importing
  it. Every request must obtain a binding from an authentication/scope callback;
  denial or resolver failure fails closed. Exact Host protection and rejection
  of unapproved browser Origins precede authentication. No ambient main-vault
  fallback, no credential creation, no authentication based on MCP session id.
- `server/test/mcpTools.test.ts`: discovery of the complete existing catalog;
  schema and allowlist enforcement; text/images/errors; schema snapshot isolation;
  SDK cancellation over linked SDK transports; an independent official SDK
  HTTP client calling the **real BoardLook handler** on temporary vault/board
  files and receiving the saved PNG; concurrent vault isolation and HTTP
  boundary rejection. Unit failure-path callbacks are not UI proof.
- `package.json` / `package-lock.json`: official `@modelcontextprotocol/sdk`
  dependency (resolved 1.32.2). Existing package versions were not intentionally
  upgraded; production-vs-dev flags change for dependencies now also needed by
  the SDK. The repository's pre-existing lockfile root version is preserved.

The low-level SDK `Server` is intentional: these tools already have authoritative
JSON Schemas. Converting them all to Zod would introduce precisely the duplicate
schema layer Carl rejected. The SDK, not vault-chat, owns MCP framing,
negotiation, protocol validation and transport implementation.

## Native pi support: use it, do not write an MCP client

Read in full from the pinned pi 1.1.0 installation: `mcp.md`, `sdk.md`,
`extensions.md`, `security.md`, `configuration.md`, `settings.md`, `cli.md`,
`cli-integration.md`, `rpc-extension-ui.md`, and the checked SDK example
`examples/sdk/14-codemode-mcp.ts`. These docs live under the pi installation,
not this repository. Read the actual installed MCP execution code as well.

- pi supports stdio and Streamable HTTP natively; legacy SSE is not supported.
- `pi.registerMcpServer(name, config)` registers a standard server. A direct
  exposure server is appropriate for the existing small, directly callable
  tool loadout. Pi owns its lifecycle and tools/results pipeline.
- Current launch is `-ne --no-mcp ... -e <vc-extension>` in
  `server/engine/pi/backend.ts`. Merely removing `--no-mcp` is insufficient:
  `-ne` disables built-ins too. Explicit `-e builtin:mcp` enables native MCP
  without loading unrelated discovered extensions. If embedding the SDK
  instead, `createMcpExtension()` and `session.bindExtensions()` are necessary,
  but replacing the RPC engine is NOT needed or recommended for this task.
- Native names are `mcp__<server>__<tool>`. With a `vault_chat` server, Show
  becomes `mcp__vault_chat__Show`. Keep historical unprefixed transcripts working;
  normalize only this server's known prefix at the UI/host boundary, never
  indiscriminately strip arbitrary MCP server prefixes.
- `--tools`/`--no-tools` semantics matter: MCP tools can remain callable through
  codemode despite an ordinary built-in allowlist. Restrict the **server binding**
  itself, and update MCP name patterns in explicit side/worker allowlists.
  Tool-less one-shots must not accidentally receive an MCP loadout.

### Critical pi correlation gap — do not silently work around it

In the installed `pi-coding-agent/dist/bundle/chunks/chunk-MXTZIDYW.js`,
`createMcpToolDefinition()` has `execute(_toolCallId, params, signal, onUpdate)`.
It calls `pi-mcp`'s `client.callTool(tool.name, params, options)` without forwarding
that id. `pi-mcp/dist/client.js` sends `{name, arguments}` (and progress metadata),
not the model's tool-call id.

The existing bridge explicitly forwards `toolCallId`. `Engine.onToolCall` uses
it for ReadyForReview's proof paths/bookkeeping, and the vendored subagent
orchestration uses it to associate children with the parent call. The scope is
narrower than an initial concern: AskUser makes its own pending-input id, and
TodoWrite is read from pi's transcript, so neither requires forwarding this id.
The adapter exposes MCP request id separately and **does not pretend it is pi's
model call id**. Equating those ids risks incorrect proof/worker ownership.
Matching RPC tool-start events to HTTP requests by name/arguments/order would
be a fragile second synchronization layer, especially for concurrent calls.

Before adopting the affected tools, either obtain a native pi facility to
transmit the id as standard request `_meta` (correlation, never authority), or
prove/adjust the small proof/worker contract so it does not require it. Do not re-register every MCP tool
inside vc.mjs merely to wrap execute: that would restore duplicate definitions.
This is an implementation/API boundary question, not a reason to replace pi.

## Tool inventory and current ownership

`agentToolSpecs()` in `server/engine/engine.ts` assembles 36 built-in host tools:

| Definition source | Tools |
| --- | --- |
| `ENGINE_TOOL_SPECS` (26) | AskUser, ReadyForReview (`REVIEW_TOOL`), ScheduleWake, Notify, PdfRead, WebSearch, StartJob, JobList, JobStop, JobStatus, JobSteer, BoardSend, BoardMake, BoardInbox, BoardLook, Show, RecordUI, OpenProject, RestoreProject, TodoWrite, RecentActivity, Cost, Compact, SearchHistory, Lookup, Delegate |
| `server/engine/extraTools.ts` (1) | PdfPages |
| `server/notesTools.ts` (6) | ListNotes, CreateNote, UpdateNote, ResolveNote, ReopenNote, DeleteNote |
| `server/context/tools.ts` (3) | ListProjects, ListConversations, ReadConversation |

Additional definitions:

- `server/vaultTools.ts`: Carl's per-vault `.vault-chat/tools/<name>/TOOL.md`
  schemas, filtered against built-in name collisions, with existing sandboxed
  execution. These must remain vault-local, not a global union of all vaults.
- `server/engine/pi/ext/subagent.mjs`: the vendored pi example's `subagent`
  definition and parallel/chain orchestration; the host actually launches
  sibling pi processes in `server/engine/pi/subagents.ts`. This is an additional
  vc tool path outside `agentToolSpecs()`; it cannot be forgotten when deleting
  the bridge. Prefer moving its single definition/orchestration into the MCP
  server while keeping pi's current worker/session lifecycle, not a new engine.
- pi's built-in read, write, edit, bash, grep, find, ls are pi tools, not vc host
  tools today. `vc.mjs` replaces bash for sandbox/env policy and guards the file
  tools. Reading/writing vault files must retain those constraints. Do not copy
  pi's filesystem implementation into the MCP server; decide whether shared
  filesystem access should wrap mature pi tool factories or a mature filesystem
  server, with the existing path/sandbox policy. This chunk does neither.

The existing one-definition catalog can initially be supplied directly to
`createToolServer`. Later extracting it out of the large engine module is a
mechanical move, not an opportunity to duplicate it in MCP-specific schemas.

### Current loadouts and scope

- Typed chat and the new voice brain: `Engine` handlers bind via `this.scoped`
  to the vault, then resolve thread→conversation/child-parent. The new voice
  brain uses the same engine, not a separate tool agent.
- Ctrl+K / Ctrl+L: `sideToolSpecs()` includes only definitions marked readOnly;
  pi's built-ins are read/grep/find/ls. The side run uses the originating
  conversation or explicit none, and forks the pi session. Refinements resume
  that same side session. The you-layer is delivered before each prompt.
- Older voice Ask side path: read-only tools plus Show for questions; actions
  can use the side-safe writable tools and Carl's own vault tools. The
  TURN_ONLY_TOOLS set excludes AskUser, ReadyForReview, TodoWrite, BoardMake,
  Delegate, StartJob, JobStop, JobSteer and ScheduleWake.
- Subagents: allowlisted host tools Notify/PdfRead/WebSearch/BoardSend, selected
  from the parent's available definitions, never AskUser or a subagent tool.
  They execute in parent conversation context. Background BoardMake/Delegate
  ownership, stopped/steered workers and resumed sessions must be preserved.
- A `readOnly` catalog marker is existing policy, not a new security guarantee:
  Compact is marked readOnly even though it changes pi context; do not silently
  expand the external-client loadout solely from this flag.

## The bridge carries more than tools

All present `vc:host-call` receivers: `backend.ts`, `side.ts`, `subagents.ts`.
All senders: `ext/vc.mjs`, `ext/subagent.mjs`.

| Internal operation | Existing purpose | Migration constraint |
| --- | --- | --- |
| `__you` | `before_agent_start` fetches activity since the last persisted `vc-you` watermark; pi appends a hidden custom message | Keep it context, not a fake tool. Retain fork/resume/compaction semantics. Use a narrowly bound context service/resource and the existing hook, not an agent-callable private command. |
| `__env` | Bash asks for current key environment; values never reach the model | Never publish through MCP tools/resources, listTools, argv or logs. Keep a private capability/IPC boundary and existing environment scrubbing. |
| `__fileWrite` | Checks whether a live voice call requires Delegate instead of inline edit/write | Keep an enforced hook, including filesystem MCP equivalents if introduced. Do not turn this into an agent choice. |
| `__subagent` | Starts/stops/manages sibling workers using host-owned policy | Migrate its single orchestration definition and preserve lifetime/cost/report behavior. |

`vc.mjs` still has legitimate non-bridge responsibilities after migration:
fd-3 provider-key handling, bash sandbox/env, path guard, memory-cap reminder,
provider cost ledger/cache markers, PDF provider parts, `vc-note`/voice entries,
and you-layer context. Delete the bridge registration and RPC UI-call handlers
when all paths are replaced; do not delete unrelated policy with them.

PdfPages is special: `ext/pdf.mjs` currently finds a marker in result text and
attaches a native PDF part to provider payloads. Native MCP's binary resources
can be saved to another path and may not preserve this marker contract. Prove
scan/handwriting/PDF pages still reach both pi and an external client; a text
path claiming a PDF was attached is not proof.

## Authentication and external clients — unresolved production boundary

No endpoint was exposed and no credentials were read or created. A real
external-client binding remains a deliberate host integration step.

The current HTTP `authorize()` admits direct loopback, an allowed login from
Tailscale Serve headers, or the phone token. A new **privileged** endpoint must
not blindly inherit direct-loopback trust: agent sandboxes can reach loopback,
and a read-only side/worker must not upgrade itself by calling the broad server
endpoint. Host-supplied, short-lived binding authority needs to preserve the
allowed tool set and vault/device/thread (or explicit absence of thread) across
requests. Credentials must be hidden from shell descendants and logs. Never
trust clientInfo, roots, tool args or an MCP session id as authority.

Recommended external approach to evaluate: reuse Carl's authenticated private
Tailscale path, with a server-validated, explicit vault and device binding and
no fabricated conversation/project. Turn-owned tools require a real authorized
conversation binding or an honest unavailable response; do not silently attach
Claude Code to whichever chat is currently foreground. An SSH stdio relay is
another standards-compatible option if existing laptop authentication supports
it, but do not build three competing auth routes. Parent should resolve any
actual credential/pairing consent fork before deployment; this worker cannot
ask Carl.

The included HTTP adapter is **stateless**, useful for discovery and independent
file-backed tool calls. Cancellation was tested on the SDK's linked transports,
not across separate stateless HTTP requests: cancellation notifications on a new
HTTP transport do not find the original in-flight request. Before adopting it
for long tools, use the SDK's authenticated stateful transport/session lifecycle
(or another supported end-to-end cancellation route) and test stop/disconnect
behavior. Transport sessions are MCP transport state, not a second agent engine.
Also add production body/concurrency limits and connection/lifetime tests.

## Checks and proof status

Completed on this branch:

- `npx --no-install tsc --noEmit -p .`: PASS.
- `npm run typecheck:phone`: PASS.
- `npm run typecheck:board`: PASS.
- `npm run typecheck:server`: PASS.
- `npx --no-install vitest run --config server/vitest.config.ts server/test/mcpTools.test.ts server/test/piPolicy.test.ts server/test/side.test.ts`:
  **3 files, 25 tests PASS** (12 new MCP, 5 policy, 8 side).
- `npm run build:server`: PASS, phone+board bundled. Existing chunk-size and
  stale Browserslist warnings were not changed. The production bundle does not
  import the new unmounted MCP adapter; this build does not prove its deployment.

Initial attempts failed because dev dependencies were absent and npm's default
cache was on a read-only filesystem. Installed dev dependencies with
`npm --cache /tmp/vc-mcp-npm-cache install --include=dev --ignore-scripts --no-audit --no-fund`
and reran the checks. The first focused run also exposed a test error: Node
fetch normalizes Host, so the rebinding assertion now uses a raw Node HTTP
request. The corrected focused run passed. No failed attempt is claimed as a
pass.

Logs are clone-local `.review-proof/mcp-tools/{typechecks,focused-tests,build-server}.log`.
No video/screenshot exists, and nothing was copied to vault visuals because no
real-app proof was made. The independent MCP HTTP test is genuine protocol +
file-handler integration on temporary data, **not** Claude Code laptop proof or
real-app proof.

NOT RUN / NOT COMPLETE: full main/change harness and server suites, baseline
failure-identity comparison, real UI tool use from typed chat, voice, Ctrl+K,
Ctrl+L, and background workers, external Claude Code client setup, native pi MCP
runtime integration, bridge deletion, production auth/scoping, file-tool MCP
policy, and HTTP cancellation. This worker has no StartJob tool; it requested
that the parent launch durable full suites rather than start a hanging shell.

## Ordered continuation

1. Parent starts durable baseline suites against the verified main commit;
   save per-test failure identities and artifacts, not just aggregate totals.
2. Resolve native pi call-id forwarding and external-client authority before
   replacing live runtime tool calls. Preserve security over a superficial demo.
3. Bind engine handlers through this MCP adapter; select one standard SDK
   transport endpoint shared by pi and the external client. Keep authority
   request-local and verify expiry/revocation, vault and read-only isolation.
4. Register that server with native pi, normalize its tool names at the UI
   boundary, migrate all parent/voice/side/worker allowlists and private context
   hooks, then delete every old `vc:host-call` sender/receiver. No fallback bridge.
5. Prove questions/plan/proof cards, PDF/images, writes/live file refresh,
   board routing, job/worker lifetimes, you-layer watermark/fork behavior,
   cancellation, failures and restarted/resumed sessions.
6. Run durable full change suites, compare baseline failures by identity, record
   the muted REAL UI on real data from every requested entrypoint plus the
   external MCP client; save `.review-proof/mcp-tools/` and copy only genuine
   visual proof to vault `.vault-chat/visuals/mcp-tools/`.
7. Commit checked changes. Do not merge, push or call ReadyForReview on this task.
