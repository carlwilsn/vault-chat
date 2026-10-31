#!/run/current-system/sw/bin/bash
# --run: PARENT StartJob ONLY. --packages: finite native package preflight only.
# --check: package preflight then finite actual App+HTTP/native Git protocol, no full CLI.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${1:---check}; pin=${2:?exact full proof-source SHA}; main=${3:?observed readonly canonical main SHA}; port=${4:-19441}; web=${5:-19442}
[[ $mode == --check || $mode == --run || $mode == --packages ]]
[[ $pin =~ ^[a-f0-9]{40}$ && $main =~ ^[a-f0-9]{40}$ ]]
for p in "$port" "$web"; do [[ $p =~ ^[0-9]+$ ]] && ((p>1024 && p<65536 && p!=8848 && p!=8857)); done
[[ $port != "$web" ]]
node=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
npm=/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/bin/npm
python=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin
chromium=/nix/store/agamzskapmh5018k98bqfwrrb738bgpv-chromium-153.0.8010.52/bin/chromium
ffmpeg=/nix/store/x3z5lz0xv3jxw3ka05ifaajl0w8lhrw8-ffmpeg-headless-9.0.1-bin/bin
bwrap=/nix/store/y0ra9qr3rz81d9wl7dfrldv3j25dc98q-bubblewrap-0.12.0/bin/bwrap
if [[ ${VC_APP_PRIVATE:-} != yes ]]; then
 out=$(mktemp -d /tmp/sa.XXXXXX)
 mkdir "$out/h" "$out/t" "$out/c"; : > "$out/u"; : > "$out/g"
 printf 'Private App evidence: %s\n' "$out"
 exec env -i PATH="$(dirname "$node"):$(dirname "$npm"):$python:$ffmpeg:/run/current-system/sw/bin" HOME="$out/h" TMPDIR="$out/t" XDG_CACHE_HOME="$out/c" XDG_CONFIG_HOME="$out/c" \
 NPM_CONFIG_USERCONFIG="$out/u" NPM_CONFIG_GLOBALCONFIG="$out/g" NPM_CONFIG_CACHE="$out/c" \
 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
 VC_APP_PRIVATE=yes VC_APP_PROOF_OUT="$out" VC_VAULT="$out/vault" VC_STATE_DIR="$out/state" VC_TOKEN_FILE="$out/no-token" VC_ALLOWED_LOGINS=fixture@example.invalid \
 VC_HOST=127.0.0.1 VC_PORT="$port" VC_APP_PROOF_PORT="$web" VC_APP_SOURCE="$pin" \
 VC_VOICE_BRAIN=off VC_VOICE_PIPELINE=off VC_VOICE_PIPELINE_PORT=19443 VC_SYNC=0 \
 VC_TEST_PI_DIR=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0 VC_PROOF_CHROMIUM="$chromium" VC_PROOF_NPM="$npm" VC_PROOF_BWRAP="$bwrap" \
 /run/current-system/sw/bin/bash --noprofile --norc "$0" "$@"
fi
cd "$repo"
[[ $(git rev-parse HEAD) == "$pin" && -z $(git status --porcelain) ]]
[[ $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse main) == "$main" && $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse HEAD) == "$main" ]]
# The exact clean source pin above includes this ordinary-policy/product batch. Prior proof pins
# do not certify it; no comparison to an obsolete product pin or bootstrap authority.
[[ $("$node" --version) == v22.* && -x $chromium && -x $ffmpeg/ffmpeg && -x $bwrap ]]
"$node" --input-type=module - <<'JS'
import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {readFileSync} from 'node:fs';
const req=createRequire(process.cwd()+'/preview/tools/check.cjs');
assert.equal(req('playwright-core/package.json').version,'1.54.0');
assert.equal(JSON.parse(readFileSync(process.env.VC_TEST_PI_DIR+'/node_modules/@earendil-works/pi-coding-agent/package.json')).version,'1.1.0');
JS
"$npm" --version > "$VC_APP_PROOF_OUT/npm-version.txt"; python3 --version > "$VC_APP_PROOF_OUT/python-version.txt"; ffmpeg -version > "$VC_APP_PROOF_OUT/ffmpeg-version.txt"
printf '%s\n' "$pin" > "$VC_APP_PROOF_OUT/source-pin.txt"
# Fail before App/CLI on incomplete native optionals; unchanged production bwrap/gate argv.
# Parent-only --run allows cold private package COPYING (not any product gate) up to 120s.
set +e
timeout --signal=TERM --kill-after=1 "$([[ $mode == --run ]] && echo 120 || echo 27)" "$node" preview/tools/native-package-preflight.mjs > "$VC_APP_PROOF_OUT/packages.log" 2>&1
rc=$?
set -e
printf '%s\n' "$rc" > "$VC_APP_PROOF_OUT/packages.exit"
cat "$VC_APP_PROOF_OUT/packages.log"
((rc==0)) || exit "$rc"
[[ $mode != --packages ]] || { printf 'CHECKED private native packages: %s\n' "$VC_APP_PROOF_OUT"; exit 0; }
# Keep raw stdout/stderr and exact failure codes. Every process is owned by this invocation.
set +e
timeout --signal=TERM --kill-after=1 27 "$node" preview/tools/native-http-entry.mjs --check > "$VC_APP_PROOF_OUT/preflight.log" 2>&1
rc=$?
set -e
printf '%s\n' "$rc" > "$VC_APP_PROOF_OUT/preflight.exit"
cat "$VC_APP_PROOF_OUT/preflight.log"
((rc==0)) || exit "$rc"
[[ $mode == --run ]] || { printf 'CHECKED actual App/native HTTP preflight: %s\n' "$VC_APP_PROOF_OUT"; exit 0; }
# Preflight already passed before the first build/full native gate. Separate private fixture.
full="$VC_APP_PROOF_OUT/full"; mkdir "$full"
export VC_APP_PROOF_OUT="$full" VC_VAULT="$full/vault" VC_STATE_DIR="$full/state"
set +e
timeout --signal=TERM --kill-after=5 2400 "$node" preview/tools/native-http-entry.mjs --run > "$full/run.log" 2>&1
rc=$?
set -e
printf '%s\n' "$rc" > "$full/run.exit"
cat "$full/run.log"
[[ $(git rev-parse HEAD) == "$pin" && -z $(git status --porcelain) ]]
[[ $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse main) == "$main" && $(git -C /home/carlwilsn/vc/projects/vault-chat rev-parse HEAD) == "$main" ]]
exit "$rc"
