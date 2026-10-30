#!/usr/bin/env bash
# Parent StartJob ONLY for the ~968MB backup. No live writes/listeners/service operations.
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
PIN=${1:?Pass exact committed source HEAD}
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]]
cd "$ROOT"
[[ $(git rev-parse HEAD) == "$PIN" ]]
[[ -z $(git status --porcelain --untracked-files=no) ]]
CANONICAL=/home/carlwilsn/vc/projects/vault-chat
EXPECTED=0bd8d08d6776541c9b04031265a6ca38a3db73b3
[[ $(git -C "$CANONICAL" rev-parse HEAD) == "$EXPECTED" ]]
[[ $(git -C "$CANONICAL" rev-parse refs/heads/main) == "$EXPECTED" ]]
BACKUPS=/home/carlwilsn/agent-work/vault-chat/event-log-backups
INPUT="$BACKUPS/project-vault-chat-prefix-c5dzxg_c/project-vault-chat.jsonl"
OUTPUT="$BACKUPS/project-vault-chat-compact-${PIN:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
# Script creates an EXCLUSIVE new output directory. Collision/missing pins fail, never overwrite.
NODE=$(readlink -f "$(command -v node)")
GIT_BIN=$(dirname "$(readlink -f "$(command -v git)")")
env -i PATH="$(dirname "$NODE"):$GIT_BIN" "$NODE" --import tsx scripts/compact-event-log-offline.ts \
  "$INPUT" "$OUTPUT" \
  6ea50764cb89478efe6d58453ffb36a0ee91a38a8fe0024345c0f0c085b198c0 \
  968407060 "$PIN"
[[ $(git -C "$CANONICAL" rev-parse HEAD) == "$EXPECTED" ]]
[[ $(git -C "$CANONICAL" rev-parse refs/heads/main) == "$EXPECTED" ]]
printf 'OFFLINE COPY VERIFIED ONLY; LIVE NOT CHANGED. Output: %s\n' "$OUTPUT"
