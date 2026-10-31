#!/usr/bin/env bash
# Operator-only, after review and an explicitly authorized maintenance window.
# Never controls services; --apply currently refuses before opening any source.
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"
exec node --import tsx scripts/offline-event-log.ts "$@"
