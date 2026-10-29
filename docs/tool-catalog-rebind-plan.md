# Existing-session tool catalog: candidate and manual activation plan

2026-10-28. **Proposal only: not deployed, not handed over, not UI-proven.**
Branch: `agent/rebind-tool-catalog`, created directly from
`599170bd9643fd470e8be638f91599071b640c94` (`agent/reconcile-folders`).
Main and GitHub are untouched. This worker's actual available tools do **not**
include ReadyForReview or a session reconnect control. No private endpoint,
handler invocation, fabricated proof card, or ownership workaround was used.

## What changes

This removes a persisted tool-schema snapshot's authority over a resumed
conversation. It is a patch to the old duplicated catalog/bootstrap layer, not a
second engine or a new tool registry. Engine supplies its existing current
ToolSpecs through one host-policy callback, for both new and resumed sessions.
Conversation loadouts include the current built-ins and collision-filtered vault
tools. Existing permission handlers and the native MCP adapter still enforce calls.

On resume, the same pi session file, ID, instructions and context are reopened
with the current host definitions. Updated schemas replace old schemas; withdrawn
tools disappear; newly allowed tools appear. The old `tools-*.json` files are only
bootstrap artifacts, not resume authority. The current bootstrap path remains in
metadata for workers and backward compatibility with the previous server.

A live pi with unchanged definitions is reused. If definitions change, only an
idle pi is closed (EOF, bounded grace, then kill if necessary) and reopened on its
existing session. Its old process-scoped MCP capability is revoked on exit. An
in-flight turn or background child pins the parent's in-use catalog until the
next idle resume; the fix never kills them just to change schemas. Workers still
receive only their explicit tool list intersected with the existing child-host
allowlist and their parent's **in-use** catalog. ReadyForReview is not granted to
workers. No model, conversation or worker authority is upgraded.

Side sessions persist a host-selected loadout (`readOnly`, `voiceRead`, `voiceAct`)
and reconstruct definitions from that policy, not saved schemas. Refinements
cannot change the saved authority. Legacy sides without a semantic loadout retain
only their original explicit tool names intersected with today's appropriate
policy; newly added tools are not inferred grants. One-shots remain tool-less.
The existing voice policy intentionally allows Carl's own vault tools; plain
Ctrl+K/L still gets only tools marked read-only and no arbitrary vault tools.

Pi 1.1.0 already supports MCP tool-list notifications and records tool changes
before the next model request. This candidate uses native MCP as before and pi's
normal session resume; it does **not** add a parallel tools-changed protocol or
pretend a source edit reloads a running Node server. **A server restart is needed
to activate this code.** Merely updating metadata in the running old server is
not a supported activation route. An ongoing model request cannot be retroactively
changed. After activation, the parent conversation's next resumed turn obtains
current tools; its transcript is not replaced or handed over.

## Checks and limits

- All four typechecks passed: desktop, phone, board and server.
- `npm run build:server` passed (phone and board embedded); standard chunk-size and
  stale Browserslist-data warnings remain.
- New tests: `server/test/piToolCatalog.test.ts` (4 tests: real installed pi 1.1.0,
  native MCP, local deterministic provider, no model spend) and
  `server/test/hostToolCatalog.test.ts` (2 actual Engine policy tests).
- Native regression starts with persisted ReadyForReview **without** `proofId`,
  then constructs a replacement backend and resumes the same file/ID. The actual
  provider request declares `mcp__vault_chat__ReadyForReview` with required
  `proofId`; additions/removals and original context are checked. The original
  transcript prefix remains byte-for-byte intact. No handoff tool is executed.
- Additional focused tests passed: mainThread, crossSurface, mcpRuntime and
  mcpSubagent. They are automated integration checks, **not real UI proof**.
- `contextAudit.test.ts` failed 3 snapshot checks. The same 3 failures reproduce
  from an isolated tracked-source archive of **599170bd**, with no candidate
  edits (machine prompt/snapshot and follow-on fixture differences). Snapshots
  were not rewritten. This is still a failed check, not a passing gate.
- Full harness and full server suites and real-UI validation have not been run
  for this proposal. They remain for the parent/release batch. Nothing here is
  claimed shipped, production-proven, or eligible to bypass a proof gate.

## One manual activation route, only if Carl chooses it

Use a **temporary user-service ExecStart drop-in** pointing at an immutable local
candidate bundle. No sudo, NixOS rebuild, main merge, GitHub push, key copying,
credential-file inspection, release-symlink edit or ReadyForReview call is needed.
This is Carl deliberately trying a local candidate under his existing admin
control; it is **not** a worker acquiring handoff authority.

Read-only inspection found the installed unit at
`/home/carlwilsn/.config/systemd/user/vault-chat-server.service`, matching
`server/deploy/vault-chat-server.service`. Its command is
`/usr/bin/env node %h/.local/state/vault-chat-server/current/vault-chat-server.mjs`;
its EnvironmentFile, service PATH and working directory remain unchanged by this
plan. **Do not print or copy the EnvironmentFile or any key store.** The sandbox
could not connect to the user systemd bus (XDG_RUNTIME_DIR/DBUS address absent), so
runtime overrides, current unit state and the effective ExecStart are not verified.
Carl must inspect these from his own ordinary logged-in terminal first:

```bash
systemctl --user show vault-chat-server.service \
  -p FragmentPath -p DropInPaths -p ExecStart -p WorkingDirectory -p MainPID
systemctl --user is-active vault-chat-update.timer
systemctl --user is-active vault-chat-update.service
```

Proceed below only if that confirms the expected user unit/command, no conflicting
drop-in, and an inactive updater service. Record whether the timer was active. If
runtime configuration differs, stop and adjust the plan rather than replacing
someone else's override. **Never use `systemctl revert`: it could remove unrelated
drop-ins.**

### Build and stage (no service changes)

Run from Carl's own terminal, after selecting this candidate commit:

```bash
set -euo pipefail
cd /home/carlwilsn/agent-work/vault-chat/changes/vault-chat
test "$(git branch --show-current)" = agent/rebind-tool-catalog
test -z "$(git status --porcelain)"
git merge-base --is-ancestor 599170bd HEAD
sha=$(git rev-parse HEAD)
VC_REV="$sha" npm run build:server
candidate="$HOME/agent-work/vault-chat/candidates/rebind-$sha"
test ! -e "$candidate"
mkdir -p "$candidate"
cp dist-server/vault-chat-server.mjs dist-server/vault-chat-server.mjs.map \
   dist-server/server-version.json "$candidate/"
sha256sum "$candidate/vault-chat-server.mjs"
```

This embeds phone/board assets and keeps the bundle outside build directories that
later tests overwrite. The service still resolves Node using its **existing** PATH,
so this plan does not change its Node version. Do not launch a second server on
live state to test the candidate. There is no migration added by this fix; metadata
retains fields the previous server reads. Normal live writes during a trial remain
real writes: rollback restores code, not a past snapshot of Carl's data.

### Activate (not executed by the agent)

**Restart drops connected calls, interrupts active agent/worker work and briefly
disconnects clients.** Let work finish or explicitly stop it first, and end calls.
A health read may help identify runs, but must not be mistaken for permission to
interrupt Carl. The existing update timer must not swap the normal release during
the trial. In the same shell as the build, after Carl decides to proceed:

```bash
# Only stop the timer if it was active; retain that fact for rollback.
systemctl --user stop vault-chat-update.timer
# Ensure a previously started updater is not still running; do not stop it mid-update.
if systemctl --user is-active --quiet vault-chat-update.service; then
  echo 'Updater is running; wait for it to finish before activation.' >&2
  exit 1
fi
dropin="$HOME/.config/systemd/user/vault-chat-server.service.d/90-rebind-tool-catalog.conf"
test ! -e "$dropin"
mkdir -p "$(dirname "$dropin")"
printf '[Service]\nExecStart=\nExecStart=/usr/bin/env node %s/vault-chat-server.mjs\n' \
  "$candidate" > "$dropin"
systemctl --user daemon-reload
systemctl --user restart vault-chat-server.service
systemctl --user show vault-chat-server.service -p ExecStart -p MainPID
```

Keep the original release `current` symlink untouched. Check `/api/v1/health`
using the **existing** configured loopback address/port (default 127.0.0.1:8848;
do not assume it if Carl configured another). Its `rev` must equal `$sha`, and
the relevant vault engine must be ready, not merely the socket listening. Reopen
the existing conversation in the real app: confirm its history is present, then
send a normal continuation. It must keep its conversation/thread identity. Only
then can the parent use its **actually available** current ReadyForReview tool
with an authentic proofId and the normal ownership/proof gate. If it still is not
available or the gate rejects the request, report that result; do not call the
handler or an alternate endpoint. No fabricated proof card.

### Roll back (same user, no data deletion)

```bash
# Remove only the trial drop-in created above, never other unit configuration.
rm "$HOME/.config/systemd/user/vault-chat-server.service.d/90-rebind-tool-catalog.conf"
systemctl --user daemon-reload
systemctl --user restart vault-chat-server.service
systemctl --user show vault-chat-server.service -p ExecStart -p MainPID
# Run the following ONLY if the update timer was active before this trial:
systemctl --user start vault-chat-update.timer
```

This returns ExecStart to the existing release symlink and preserves all sessions,
vaults, credentials and normal state locations. Check health and the original
conversation again. Leave the candidate bundle alone until Carl no longer needs
it. If he keeps using the candidate, the timer remains stopped during that trial;
restore its original state when the ordinary kept release replaces the override.
If the updater was active before an aborted activation, restore the timer as well.

## Eventual ordinary Keep

The fix branch descends directly from 599170bd, so reviewing/Keeping a descendant
that includes this fix also includes the original reconcile-folders work. It does
not automatically move the project's existing review/ownership record to a worker.
After activation, the owning parent must use its normal gate to submit the
intended candidate. `prepareReview` reads the project clone's current agent/
branch and HEAD; this clone is now on `agent/rebind-tool-catalog`, so a normal
parent handoff here would include both 599170bd and its fix descendant, without
rewriting any ownership record or moving main. If the parent intends to submit
only 599170bd, that omits this fix. Carl's Keep remains the merge decision. Do not
merge to main or push from this proposal, and do not treat a temporary service
override as Keep.
