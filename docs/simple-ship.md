# Shipping through the installed script

Agents run normal typechecks and tests, commit on their own `agent/<name>` branch,
and push only that branch to the local `publish` remote. They write a unique
`~/agent-work/vault-chat/ship-requests/<name>.req` containing exactly two lines:
the branch name and a plain title. Read the corresponding `.result` and `.log`.
Only the installed watcher and script promote main; do not edit their installed copy.

The script pins baseline and candidate source, runs the seven normal gates, and
compares complete named test results. A missing retired case is absent, not a pass.
New failures/skips/todos, unavailable reports, crashes and failed type/build checks
block acceptance. Tests run with private HOME/tmp/network and read-only dependencies.
The script performs its existing real-copy preservation checks; agents do not add
proof cards, audit frameworks, capture helpers or replacement approval surfaces.

Git's expected-old transaction refuses moved main. The private journal retains
accepted source ranges and native release-health observations. Ordinary request/result
files and internal completion events remain available independently of chat presentation.
The source contains no shipment cards, Proof/Rollback links, proof viewer, projection
writer or source-recovery UI. Stored conversation records, human answers and historical
artifacts are not rewritten or deleted.

Normal notifications and AskUser questions remain. Native authenticated laptop health,
box readiness, ordinary project sync, CI publication and retained-binary fallback remain.
Acceptance and publication are not Shipped: the actual box and Carl's laptop must run
the release. See AGENTS.md for current working rules.
