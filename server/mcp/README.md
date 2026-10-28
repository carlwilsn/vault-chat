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
adapts existing `ToolAnswer` text/image/PDF results to standard MCP content.
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

The extension retains private services for incremental context, per-command key
env and guarded file writes. They are **not discoverable agent tools**:

- `POST /context/you`: only when the host explicitly enables incremental context;
- `POST /context/env`: only for command-capable loadouts;
- `POST /context/file-write`: only for write/edit loadouts, and still refused for
  a voice talker that must delegate file work.

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
explicit request, not ambient screen presence. Private context/env/write
services are **not** mounted at this external endpoint.

## Verification and limitations

Focused tests:

- `mcpTools.test.ts`: shared schemas/results and authenticated HTTP tool access;
- `mcpRuntime.test.ts`: official SDK cancellation in separate HTTP requests,
  capability isolation, revocation, and actual installed pinned pi discovery +
  native MCP execution via a deterministic local provider protocol fixture;
- `mcpExternal.test.ts`: private authority requirements, explicit scope, standard
  SDK client and session/device isolation;
- `side.test.ts`, `backgroundTasks.test.ts`, `projectChanges.test.ts`: existing
  real-server integration surfaces through the MCP-speaking test pi fixture.

The native-pi provider fixture is a protocol test, **not** a model/UI proof.
Local SDK/temporary-board tests are not proof from Carl's external laptop.
Real-app screenshots/video and an authenticated external-client proof still
must be collected before calling the migration proven. Full regression gates
are run separately by the supervising agent; do not confuse focused passes
with those gates or claim that this document supplies release evidence.
