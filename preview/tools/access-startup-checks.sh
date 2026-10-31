#!/usr/bin/env bash
# Parent StartJob ONLY for --run. Source preparation; not installed acceptance.
set -euo pipefail
umask 077
SOURCE=$(cd -- "$(dirname -- "$0")/../.." && pwd)
DONOR=/tmp/sru.yBUd1T/source
NODE=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
NPM=/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/lib/node_modules/npm/bin/npm-cli.js
PYTHON=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin/python3.14
BROWSER=/nix/store/agamzskapmh5018k98bqfwrrb738bgpv-chromium-153.0.8010.52/bin/chromium
FFMPEG=/nix/store/x3z5lz0xv3jxw3ka05ifaajl0w8lhrw8-ffmpeg-headless-9.0.1-bin/bin/ffmpeg
SDK=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0
BWRAP=/nix/store/y0ra9qr3rz81d9wl7dfrldv3j25dc98q-bubblewrap-0.12.0/bin/bwrap
SAFE_PATH="$(dirname "$BWRAP"):$(dirname "$PYTHON"):/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/bin:$(dirname "$NODE"):/run/current-system/sw/bin"
if [[ ${1-} != --isolated ]]; then
  MODE=${1:?--check or --run}; PIN=${2:?exact clean source SHA}
  [[ $MODE == --check || $MODE == --run ]]
  [[ $PIN =~ ^[a-f0-9]{40}$ ]]
  OUT=$(mktemp -d /tmp/as.XXXXXX)
  mkdir -p "$OUT/h" "$OUT/t" "$OUT/c" "$OUT/evidence"; : > "$OUT/u"; : > "$OUT/g"
  echo "Access/startup finite batch artifacts: $OUT"
  exec env -i PATH="$SAFE_PATH" HOME="$OUT/h" TMPDIR="$OUT/t" XDG_CACHE_HOME="$OUT/c" XDG_CONFIG_HOME="$OUT/c" \
    NPM_CONFIG_USERCONFIG="$OUT/u" NPM_CONFIG_GLOBALCONFIG="$OUT/g" NPM_CONFIG_CACHE="$OUT/c/npm" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
    VC_TEST_PI_DIR="$SDK" VC_BWRAP="$BWRAP" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 VC_VOICE_PIPELINE=off VC_VOICE_BRAIN=off VC_SYNC=0 \
    VC_HOST=127.0.0.1 VC_PORT=29781 VC_VOICE_PIPELINE_PORT=29782 VC_VOICE_PORT=29782 \
    VC_TEST_BROWSER="$BROWSER" VC_TEST_FFMPEG="$FFMPEG" VC_UI_OUT="$OUT/evidence" VC_REV="$PIN" \
    VC_STARTUP_EVIDENCE=/tmp/q1envelope.kxZPWI/evidence VC_PROTOCOL_RESULT="$OUT/header-contract.json" VC_PROOF_SERIAL_WORKERS=1 \
    /run/current-system/sw/bin/bash "$0" --isolated "$OUT" "$MODE" "$PIN"
fi
OUT=$2; MODE=$3; PIN=$4
[[ $OUT == /tmp/as.* && -d $OUT/evidence ]]
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$PIN" && -z $(git -C "$SOURCE" status --porcelain) ]]
git -C "$SOURCE" merge-base --is-ancestor 61dc4924115aa5a3ffa3ddb1aa0909bb093efe3e "$PIN"
for SUB in '' preview/; do cmp "$SOURCE/${SUB}package-lock.json" "$DONOR/${SUB}package-lock.json"; done
for FILE in "$NODE" "$PYTHON" "$BROWSER" "$FFMPEG" "$BWRAP"; do [[ -x $FILE ]]; done
[[ -f $NPM && -f $SDK/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js ]]
[[ $(readlink -f "$(command -v node)") == "$NODE" ]]
[[ $(readlink -f "$(command -v npm)") == "$NPM" ]]
[[ $(readlink -f "$(command -v python3)") == "$PYTHON" ]]
[[ ! -s $NPM_CONFIG_USERCONFIG && ! -s $NPM_CONFIG_GLOBALCONFIG ]]
"$BWRAP" --ro-bind / / --proc /proc --unshare-pid --die-with-parent -- /run/current-system/sw/bin/true
"$NODE" --input-type=module - "$DONOR" "$SDK" <<'JS'
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import net from 'node:net';
const [root,sdk]=process.argv.slice(2);
assert.equal(JSON.parse(readFileSync(root+'/preview/node_modules/playwright-core/package.json')).version,'1.54.0');
assert.equal(JSON.parse(readFileSync(sdk+'/node_modules/@earendil-works/pi-coding-agent/package.json')).version,'1.1.0');
for(const port of [29781,29782]) {assert(port>0 && ![8848,8857].includes(port));const s=net.createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',ok)});await new Promise(ok=>s.close(ok));}
JS
printf 'source=%s\nbase=93837b6c4dde00f4e6f0a4a18511a524c2aa8dd7\nnode=%s\nnpm=%s\npython=%s\npi=%s\nbrowser=%s\ndonor=%s\n' "$PIN" "$NODE" "$NPM" "$PYTHON" "$SDK" "$BROWSER" "$DONOR" > "$OUT/pins.txt"
if [[ $MODE == --check ]]; then echo 'CHECKED exact clean source/base, locks, genuine toolchain/SDK/PW and positive free ports only; no tests/build/UI executed.'; exit 0; fi
# Independent immutable source and per-package private copied caches. No installs.
git -c gc.auto=0 clone --no-local --no-checkout --quiet "$SOURCE" "$OUT/source"
git -C "$OUT/source" checkout --quiet --detach "$PIN"
timeout -k 1s 120s /run/current-system/sw/bin/bash -c 'set -e; for sub in "" preview/; do cp -aL --reflink=auto "$1/${sub}node_modules" "$2/${sub}node_modules"; done' _ "$DONOR" "$OUT/source"
for SUB in '' preview/; do
  "$NODE" "$SOURCE/preview/tools/private-package-bins.mjs" "$OUT/source/${SUB}node_modules" "$DONOR/${SUB}node_modules" "$OUT/source/${SUB}package-lock.json" > "$OUT/$(echo "${SUB:-root}" | tr / _)-package-entrypoints.json"
done
rm -rf "$OUT/source/node_modules/.vite" # own disposable cache only
cp "$0" "$OUT/launcher.sh"
cd "$OUT/source"
FAILED=0
run() {
  local NAME=$1 RC=0; shift
  timeout -k 10s 12m "$@" > "$OUT/$NAME.log" 2>&1 || RC=$?
  printf '%s\t%s\n' "$NAME" "$RC" | tee -a "$OUT/status.tsv"
  if [[ $RC != 0 ]]; then FAILED=1; fi
  return "$RC"
}
# Keep every failure, including legacy context snapshots; no filters or snapshot rewrite.
run type-desktop "$NODE" node_modules/typescript/bin/tsc --noEmit -p . || :
run type-phone "$NODE" "$NPM" run typecheck:phone || :
run type-board "$NODE" "$NPM" run typecheck:board || :
run type-server "$NODE" "$NPM" run typecheck:server || :
run convlog-boundaries "$NODE" --import tsx --import ./test/harness/register.mjs --test test/harness/convlog.test.ts test/harness/convlogWorkers.test.ts || :
run recorder-contract "$NODE" preview/tools/check-native-recording.mjs || :
run header-contract "$NODE" --import tsx preview/tools/check-native-header.mjs || :
if run preflight-bundle "$NODE" server/build.mjs; then
  VITEST=("$NODE" node_modules/vitest/vitest.mjs run --config server/vitest.config.ts --no-cache --reporter=default --reporter=json)
  run access-native "${VITEST[@]}" --outputFile="$OUT/access-native.json" server/test/vaultContent.test.ts server/test/piToolCatalog.test.ts server/test/mcpFilesystem.test.ts server/test/mcpFilesystemFrames.test.ts server/test/sandbox.test.ts server/test/pdfPages.test.ts || :
  run context-voice "${VITEST[@]}" --outputFile="$OUT/context-voice.json" server/test/contextAudit.test.ts server/test/youLayer.test.ts server/test/voice.test.ts || :
  run startup-native "${VITEST[@]}" --outputFile="$OUT/startup-native.json" server/test/crossSurfaceNativeAPI.test.ts server/test/viewerRootNative.test.ts server/test/piPromptWait.test.ts server/test/enginePreflight.test.ts server/test/workerRows.test.ts || :
fi
# Actual current App, fresh build at THIS pin. Existing realbox IPC adapter, no fake App/public API.
# Browser fixture already launches with --mute-audio; only local deterministic provider, voice off.
if run build-server "$NODE" "$NPM" run build:server && run desktop-build "$NODE" --max-old-space-size=1536 preview/tools/startup-context-desktop-build.mjs; then
  if run identity-preflight env VC_UI_IDENTITY_PREFLIGHT=1 "$NODE" --import tsx preview/tools/startup-context-ui-proof.ts; then
    run actual-app "$NODE" --import tsx preview/tools/startup-context-ui-proof.ts || :
  fi
fi
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$PIN" && -z $(git -C "$SOURCE" status --porcelain) ]]
echo "Finite checks exit=$FAILED; all failures/skips retained in $OUT. Not full gates, baseline comparison, installed proof or shipment."
exit "$FAILED"
