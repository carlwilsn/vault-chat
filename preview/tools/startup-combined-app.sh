#!/run/current-system/sw/bin/bash
# Parent StartJob ONLY for --full. No publication/install, old receipt reuse or full gate pair.
set -euo pipefail
umask 077
SOURCE=$(cd -- "$(dirname -- "$0")/../.." && pwd)
DONOR=/home/carlwilsn/agent-work/vault-chat/changes/vault-chat
# Preserve the exact arguments across env-i reentry. No source/pin inference from receipts.
if [[ ${1-} == --isolated ]]; then PIN=$4; MAIN=$5; else PIN=${2:?full combined source SHA}; MAIN=${3:?readonly canonical main SHA}; fi
[[ $PIN =~ ^[a-f0-9]{40}$ && $MAIN =~ ^[a-f0-9]{40}$ ]]
NODE=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
NPM=/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/lib/node_modules/npm/bin/npm-cli.js
PYTHON=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin/python3.14
BROWSER=/nix/store/agamzskapmh5018k98bqfwrrb738bgpv-chromium-153.0.8010.52/bin/chromium
FFMPEG=/nix/store/x3z5lz0xv3jxw3ka05ifaajl0w8lhrw8-ffmpeg-headless-9.0.1-bin/bin/ffmpeg
SDK=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0
EVIDENCE=/tmp/q1envelope.kxZPWI/evidence
SAFE_PATH=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin:/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/bin:/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin:/run/current-system/sw/bin
if [[ ${1-} != --isolated ]]; then
  MODE=${1---full}
  [[ $MODE == --full || $MODE == --preflight || $MODE == --check ]]
  OUT=$(mktemp -d /tmp/sru.XXXXXX)
  mkdir -p "$OUT/h" "$OUT/t" "$OUT/cache" "$OUT/evidence"
  : > "$OUT/u"; : > "$OUT/g"
  echo "Combined native App job artifacts (failures retained): $OUT"
  exec env -i PATH="$SAFE_PATH" HOME="$OUT/h" TMPDIR="$OUT/t" XDG_CACHE_HOME="$OUT/cache" XDG_CONFIG_HOME="$OUT/cache" \
    NPM_CONFIG_USERCONFIG="$OUT/u" NPM_CONFIG_GLOBALCONFIG="$OUT/g" NPM_CONFIG_CACHE="$OUT/cache/npm" \
    VC_PROOF_SERIAL_WORKERS=1 VC_TEST_PI_DIR="$SDK" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 VC_VOICE_PIPELINE=off \
    VC_HOST=127.0.0.1 VC_PORT=29661 VC_VOICE_PIPELINE_PORT=29662 VC_VOICE_PORT=29662 VC_VOICE_BRAIN=off VC_SYNC=0 \
    VC_TEST_BROWSER="$BROWSER" VC_TEST_FFMPEG="$FFMPEG" VC_UI_OUT="$OUT/evidence" VC_REV="$PIN" \
    VC_STARTUP_EVIDENCE="$EVIDENCE" VC_PROTOCOL_RESULT="$OUT/header-contract-preflight.json" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
    /run/current-system/sw/bin/bash "$0" --isolated "$OUT" "$MODE" "$PIN" "$MAIN"
fi
OUT=$2; MODE=$3
[[ $OUT == /tmp/sru.* && -d $OUT/evidence ]]
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$PIN" && -z $(git -C "$SOURCE" status --porcelain) ]]
[[ $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse HEAD) == "$MAIN" && $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse main) == "$MAIN" ]]
for SUB in '' preview/; do
 cmp "$SOURCE/${SUB}package-lock.json" "$DONOR/${SUB}package-lock.json"
done
for FILE in "$NODE" "$PYTHON" "$BROWSER" "$FFMPEG"; do [[ -x $FILE ]]; done
[[ -f $NPM && -f $SDK/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js ]]
[[ $(readlink -f "$(command -v node)") == "$NODE" ]]
[[ $(readlink -f "$(command -v python3)") == "$PYTHON" ]]
[[ $(readlink -f "$(command -v npm)") == "$NPM" ]]
[[ ! -s $NPM_CONFIG_USERCONFIG && ! -s $NPM_CONFIG_GLOBALCONFIG ]]
"$NODE" --input-type=module - "$SOURCE" "$SDK" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,sdk]=process.argv.slice(2);
assert.equal(JSON.parse(readFileSync(join(root,'preview/node_modules/playwright-core/package.json'))).version,'1.54.0');
assert.equal(JSON.parse(readFileSync(join(sdk,'node_modules/@earendil-works/pi-coding-agent/package.json'))).version,'1.1.0');
JS
printf 'base=%s\ncombined=%s\nnode=%s\nnpm=%s\npython=%s\nbrowser=%s\nffmpeg=%s\nsdk=%s\n' "$MAIN" "$PIN" "$NODE" "$NPM" "$PYTHON" "$BROWSER" "$FFMPEG" "$SDK" > "$OUT/pins.txt"
# Bind and close only. No listener adoption or foreign process control.
"$NODE" --input-type=module - <<'JS'
import net from 'node:net';
for(const port of [29661,29662]) {
 if(port<=0||[8848,8857].includes(port))throw Error('forbidden port');
 const s=net.createServer();await new Promise((yes,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',yes);});await new Promise(yes=>s.close(yes));
}
JS
if [[ $MODE == --check ]]; then echo 'Exact clean combined pin/toolchain/locks/owned ports checked; no build/browser/native work.'; exit 0; fi
# Immutable private source and owned per-package dependency snapshots, no installs.
git -c gc.auto=0 clone --no-local --no-checkout --quiet "$SOURCE" "$OUT/source"
git -C "$OUT/source" checkout --quiet --detach "$PIN"
# Staging only: allow cold package copies 120s, not a product-test deadline change.
timeout -k 1s 120s /run/current-system/sw/bin/bash -c 'set -e; for sub in "" preview/; do cp -aL --reflink=auto "$1/${sub}node_modules" "$2/${sub}node_modules"; done' _ "$DONOR" "$OUT/source"
for SUB in '' preview/; do
 "$NODE" "$SOURCE/preview/tools/private-package-bins.mjs" "$OUT/source/${SUB}node_modules" "$DONOR/${SUB}node_modules" "$OUT/source/${SUB}package-lock.json" > "$OUT/$(echo "${SUB:-root}" | tr / _)-package-entrypoints.json"
done
# Only this job's copied cache, never the source or another actor's cache.
rm -rf "$OUT/source/node_modules/.vite"
cp "$0" "$OUT/launcher.sh"
cd "$OUT/source"
run() {
  local NAME=$1 RC=0; shift
  timeout -k 10s 12m "$@" > "$OUT/$NAME.log" 2>&1 || RC=$?
  printf '%s\t%s\n' "$NAME" "$RC" | tee -a "$OUT/status.tsv"
  [[ $RC == 0 ]]
}
# Faithful source-extracted real reader/header/caller and native SDK contracts,
# run before the expensive build/browser. No new engine/controller/mock App.
run recorder-preflight "$NODE" preview/tools/check-native-recording.mjs
run header-contract-preflight "$NODE" --import tsx preview/tools/check-native-header.mjs
run preflight-server-bundle "$NODE" server/build.mjs
run native-api-preflight "$NODE" node_modules/vitest/vitest.mjs run --config server/vitest.config.ts --no-cache server/test/crossSurfaceNativeAPI.test.ts server/test/piPromptWait.test.ts server/test/enginePreflight.test.ts
if [[ $MODE == --preflight ]]; then echo "Bounded combined-source preflight only; retained $OUT"; exit 0; fi
# New reset UI differs from the original startup desktop. ALWAYS freshly build it.
run build-server "$NODE" "$NPM" run build:server
run desktop-build "$NODE" --max-old-space-size=1536 preview/tools/startup-context-desktop-build.mjs
run identity-preflight env VC_UI_IDENTITY_PREFLIGHT=1 "$NODE" --import tsx preview/tools/startup-context-ui-proof.ts
run native-ui "$NODE" --import tsx preview/tools/startup-context-ui-proof.ts
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$PIN" && -z $(git -C "$SOURCE" status --porcelain) ]]
[[ $(git -C "$OUT/source" rev-parse HEAD) == "$PIN" && -z $(git -C "$OUT/source" status --porcelain) ]]
[[ $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse HEAD) == "$MAIN" && $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse main) == "$MAIN" ]]
echo "Combined actual-App/native scenarios passed (not acceptance, installation or shipping); retained $OUT"
