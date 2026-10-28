# Shared native MCP tools

All production host tools use the official MCP SDK and pi 1.1.0's native
`builtin:mcp` extension. There is no extension-editor tool bridge or fallback.
Typed turns, voice brain turns, voice action sides, Ctrl+K/Ctrl+L and workers
bind the same engine handlers through explicit loadouts. Pi still owns the model
loop, session log, streamed tool events and nested execution.

## Catalog and execution

`server/engine/engine.ts` owns the host schemas (`agentToolSpecs`,
`sideToolSpecs`, `voiceSideToolSpecs`) and handlers. Vault-defined tools use the
existing vault-tool loader. `mcp/subagent.ts` supplies the one parent-only
subagent schema/orchestration; `pi/subagents.ts` retains process management,
limits, results, cost and reports. There is no replacement agent loop.

`tools.ts` validates both the catalog and each call with the same schemas, and
adapts `ToolAnswer` text, images and embedded binary resources to standard MCP
content. `PdfPages` attaches the actual requested PDF slice as an embedded
`application/pdf` resource, while retaining the marker used by native pi's
provider hook. It never reads a host file inferred from arbitrary result text.

`filesystem.ts` imports definitions directly from the installed pinned pi's
`createAllToolDefinitions`; there are no copied filesystem schemas or tool
bodies. The same factories execute in `pi/ext/filesystem.mjs`, a plain one-call
subprocess inside the existing outer sandbox (not another agent loop). Bash
retains the nested shell sandbox, scrubbed environment, authorized command-key
injection and bounded timeout. The shared policy module still applies the
realpath guards. Pi's own per-file mutation queue serializes writes/edits across
MCP bindings. A cancelled call kills its sandbox process group.

Clients requesting progress receive standard `notifications/progress` messages
(including numeric token `0`). Cumulative text previews from pi's factory cross
the executor pipe as bounded NDJSON frames, with awaited consumers providing
backpressure; the 32 MiB limit applies per frame, not per command lifetime.
Notifications are ordered and drained before the final result, isolated per
request, and suppressed after cancellation. Pi's native MCP extension turns
these into normal `tool_execution_update` events. The existing conversation-log
projection exposes the open tool's preview in the chat ticker; final tool
content remains unchanged. This repairs the existing UI projection rather than
adding another streaming/event engine.

Native pi's explicit active-tool allowlist contains only `mcp__vault_chat__...`
names: no duplicate native read/write/edit/bash tools. Chat retains its coding
loadout; side queries retain read/grep/find/ls; worker definitions retain their
explicit tools. Missing tools are refused before dispatch. Voice talkers cannot
write/edit **or bash around the write gate** and must Delegate. Explicit voice
action side runs and authorized workers retain their write authority.
`http.ts` is the SDK's stateful Streamable HTTP transport. Every request,
including cancellation, GET and DELETE, is authenticated. Sessions are bound to
host authority, not used as authority themselves. Host/Origin validation, body,
session, concurrency and idle budgets are enforced. SDK request cancellation
reaches each bound call's AbortSignal; subagent orchestration propagates it to
child cancellation. Closing/revoking a binding aborts pending SDK operations.
Existing handlers without abort-aware APIs are not magically made cancellable.

## Native pi and private services

`runtime.ts` lazily listens on an ephemeral loopback port. **Loopback is never
privileged authority:** every request needs an unpredictable per-process bearer
capability. A binding fixes tool specs and its explicit private services. The
URL and capability arrive on fd 4, read once and closed, never in a tool spec,
environment variable, argv, generated tool file, session or log. The existing
model runtime key still arrives on fd 3.

`pi/ext/vc.mjs` calls `pi.registerMcpServer("vault_chat", ...)` in memory with
`exposure: "direct"`. Pi's native tools are named `mcp__vault_chat__NAME`; only
that exact namespace is shortened for vault-chat display/reducer logic. Other
MCP server names remain intact. `-ne -e builtin:mcp` excludes unrelated MCP
configuration; the one-shots with no host tools use `--no-mcp`.

The extension retains only the private incremental-context service:
`POST /context/you`, when the host explicitly enables it. It is **not a
discoverable agent tool**. Command-key env and write-authorization callbacks now
stay in the host-owned shared filesystem binding, not private HTTP endpoints.
`/context/env` and `/context/file-write` are no longer mounted.

An independent process binding cannot use another's MCP session or private
services. Process exit revokes the capability and closes all its sessions.
The existing env scrubbing, bash sandbox and realpath-based file guards remain
in place. The capability is in the trusted extension process's memory, not in
bash's environment. This does not treat arbitrary code inside that same trusted
process as an isolation boundary.

## Explicit proof and worker contracts

`ReadyForReview` requires a fresh `proofId` (16–60 letters, digits, `_` or `-`).
Proof artifacts use `.vault-chat/proof/<proofId>/`, exclusively reserved before
copying. The proof card resolves the same explicit ID from tool arguments.
Historical cards/review records can still read their old tool-call-ID paths;
new writes never derive proof identity from model tool-call IDs or MCP request
IDs. Concurrent questions/handoffs cannot overwrite an existing question or
handoff.

Each child owns an independent `sub-...` task row. A parent tool-call ID is not
borrowed to identify a child, and no newest-open-call heuristic remains.
Background result/report handling stays with the existing engine.

## Standard external endpoint

The existing HTTP server mounts standard Streamable HTTP at:

```
https://<private-host>/mcp?vault=<explicit-name>&device=laptop&conversation=none
```

Use `device=laptop|phone|board`. `conversation` must be a real explicit thread
ID or literal `none`; missing context is rejected, never defaulted to main or
the foreground chat. Unknown vaults/conversations are rejected. The session's
scope includes authenticated identity, vault, device and conversation; changing
any of those cannot reuse the session.

The server-side `VC_MCP_HOSTS` setting is a comma-separated exact Host allowlist
(including port where applicable), configured for the private service. An empty
allowlist disables the endpoint. Each request requires **both**:

1. an allowlisted Tailscale Serve user login on the existing HTTPS private path;
2. the existing phone/laptop credential in the `X-Vault-Token` header.

No browser cookie, URL credential, direct-loopback exception, model-selected
scope, new public token issuer or broad privileged listener is used. Requiring
the existing private credential as well as proxy identity prevents a local
sandbox process from gaining authority by forging Tailscale headers. Client
configuration must use its credential store/environment facility; never commit
credentials or put them in a URL. Requests with an Origin are denied unless
explicitly allowed by the adapter (the external endpoint allows none).

`main.ts` resolves the named vault and `Engine.mcpBinding` binds existing catalog
and handlers. External tools cannot borrow a live turn's question, proof gate,
worker or compaction ownership. They receive an actionable refusal instead.
Show defaults to the bound device; board sending requires the external client's
explicit request, not ambient screen presence. Private services are **not**
mounted at this external endpoint.

External read/write/edit/grep/find/ls use those same pi factories with explicit
vault-root authority, realpath containment (including missing write tails), the
installed deny-read/deny-write policy and outer sandbox. `PdfRead`/`PdfPages`
also validate external source paths against the bound root and deny policy.
External filesystem access fails closed without the installed sandbox, even
when unsafe native test mode is enabled. No command keys are provided to this
loadout. External bash is intentionally unavailable: the existing native shell
sandbox allows more than one vault and is not a vault-only external shell
policy. `StartJob` remains turn-owned; `RecordUI` is also refused externally
rather than providing an indirect command-execution route.

Standard clients can explicitly list/read `vault-chat://context/you`, a text
resource produced by the existing authoritative you-layer for their bound
vault/conversation, labelled with their bound device. This does not auto-inject
a prompt, expose the private service, return command keys or accept model/client
arguments selecting a different authority. The native per-turn hook is unchanged.

### Claude Code on the laptop

The laptop must be signed into the allowed Tailscale identity and able to reach
its private HTTPS hostname. On the server running this implementation, set
`VC_MCP_HOSTS` to that exact private hostname (for example
`thinkbox.tailbb647d.ts.net`, without a scheme or path). This is a server
configuration change/restart, not something an MCP client can enable. Do not
change Tailscale Serve to a public listener or bypass authentication to test it.

Claude Code supports HTTP transports and environment expansion in `.mcp.json`
([official client documentation](https://code.claude.com/docs/en/mcp)). Use:

```json
{
  "mcpServers": {
    "vault_chat": {
      "type": "http",
      "url": "${VAULT_CHAT_MCP_URL}",
      "headers": { "X-Vault-Token": "${VAULT_CHAT_TOKEN}" }
    }
  }
}
```

Set `VAULT_CHAT_MCP_URL` in the laptop's launch environment to
`https://<private-host>/mcp?vault=vault-chat&device=laptop&conversation=none`.
Supply `VAULT_CHAT_TOKEN` through the laptop's existing credential-manager/secret
injection facility, using its existing vault-chat credential. Do not paste a
credential into a shell command, configuration file, URL, transcript or issue;
do not run a CLI command that expands it into persisted header text. The
variable references above are literal references, not example credentials.
Start Claude Code from that environment, approve the configured server, and use
`/mcp` to check its connection. A harmless first request is “Use vault_chat's
BoardLook to tell me whether any boards exist; change nothing.” An explicit
conversation ID may replace `none` only when the client should be bound to that
real thread. Keep `none` for an independent client.

A missing variable, disabled Host allowlist, wrong vault/conversation, absent
header credential, or missing Tailscale login must fail closed. A successful
SDK call over an internal per-process capability does **not** establish that
this private HTTPS route or the laptop's Claude Code configuration works.

## Verification and limitations

Focused tests:

- `mcpTools.test.ts`: shared schemas/results, authenticated HTTP tool access,
  progress token `0`, concurrent request isolation and notification drain order;
- `mcpRuntime.test.ts`: official SDK cancellation in separate HTTP requests,
  capability isolation, revocation, and actual installed pinned pi discovery +
  native MCP execution via a deterministic local provider protocol fixture,
  including the private you-layer hook, live bash updates before tool completion,
  and requested `PdfPages` slice bytes in the next provider payload;
- `mcpExternal.test.ts`: private authority requirements, explicit scope, standard
  SDK client and session/device isolation;
- `mcpFilesystem.test.ts`: installed real pi factories inside real bubblewrap,
  independent standard SDK read/write/edit/grep/find/ls, lexical/absolute/symlink
  escapes, protected paths, read-only and voice authorization, scoped worker
  bash, live cumulative previews, cancellation without late updates,
  PNG/JPEG/GIF/WebP/BMP transport, standard PDF slice bytes and scoped
  context resources. Tests require the pinned pi installation (`VC_TEST_PI_DIR`
  overrides its default location); the scripted CLI fixture re-exports those
  actual factories rather than faking a filesystem;
- `mcpFilesystemFrames.test.ts`: split UTF-8/coalesced NDJSON, bounded frames
  over a >32 MiB stream lifetime, awaited consumers, malformed/incomplete/late
  frames, nonzero executor exit and cancellation under backpressure;
- `side.test.ts`, `backgroundTasks.test.ts`, `projectChanges.test.ts`: existing
  real-server integration surfaces through the MCP-speaking test pi fixture.

### Remaining limitations

External bash is not exposed; this is a deliberate scoped limitation, not shell
parity. The existing native Linux sandbox is retained, not a new hermetic
filesystem: system tools and explicitly configured native project folders keep
their installed permissions. Realpath checks do not turn a concurrently hostile
local filesystem into a new isolation boundary; the installed mount/hide policy
remains the protection for host credentials. No external command/env capability
is issued.

Each filesystem call starts a sandbox executor (startup overhead). Live text
previews require the client to request standard MCP progress; clients that do
not request it still receive the final result. Binary attachments remain final
content, not preview frames. Pi still owns tool execution events and the agent
loop; there is no replacement session/state/streaming engine. Large results
retain pi's tail/full-output-file behavior and transport/output limits.

The incremental you-layer hook is still enabled only for typed/voice-brain
conversation turns and Ctrl+K/Ctrl+L/voice sides. Workers and one-shots do not
receive it; independent clients may explicitly read the scoped standard
resource instead of receiving automatic prompt injection.

The native-pi provider fixture is a protocol test, **not** a model/UI proof.
Local SDK/temporary-board tests are not proof from Carl's external laptop.
The isolated real-app `streaming-native-mcp.mp4` and
`streaming-before-completion.png` show the first stdout line while a 12-second
bash command is still running; `streaming-completed.png` shows both final lines.
`streaming-ui-result.json` records the live stop control, first/final timestamps
and no page errors. These are in the vault's `.vault-chat/visuals/mcp-tools/`;
the realbox preview navigation is fixture chrome, not the isolated real chat
backend. This is not authenticated private-HTTPS/laptop-client proof, which is
still missing. Full regression gates
are run separately by the supervising agent; do not confuse focused passes
with those gates or claim that this document supplies release evidence.
