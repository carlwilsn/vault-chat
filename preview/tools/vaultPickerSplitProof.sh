#!/run/current-system/sw/bin/bash
# Parent StartJob entry point, finite 240s preparation against a pinned baseline.
# No canonical-main/service operations. Rebase/retest on accepted actual main before ordinary shipping.
# Development evidence only, NEVER an acceptance/install bypass.
set -euo pipefail
umask 077
src=$(cd -- "$(dirname -- "$0")/../.." && pwd)
expected=${1:?candidate full SHA required}
main=${2:?pinned preparation baseline SHA required}
out=${3:?new absolute output directory required}
[[ $expected =~ ^[0-9a-f]{40}$ && $main =~ ^[0-9a-f]{40}$ && $out == /tmp/* && ! -e $out ]]
[[ $(git -C "$src" rev-parse HEAD) == "$expected" ]]
[[ $(git -C "$src" branch --show-current) == agent/picker-on-reset-startup-1031 ]]
[[ -z $(git -C "$src" status --porcelain) ]]
git -C "$src" merge-base --is-ancestor "$main" "$expected"
# No inherited keys, npm settings, live HOME, localStorage or provider endpoints.
mkdir -m 700 -- "$out"
scratch=$(mktemp -d /tmp/vp.XXXXXX)
mkdir -m 700 "$scratch/home" "$scratch/tmp" "$scratch/browsers" "$scratch/cache" "$scratch/config"
# Existing system ffmpeg, exposed only in this private Playwright cache; no browser/package download.
mkdir "$scratch/browsers/ffmpeg-1011"
ffmpeg=/nix/store/x3z5lz0xv3jxw3ka05ifaajl0w8lhrw8-ffmpeg-headless-9.0.1-bin/bin/ffmpeg
[[ -x $ffmpeg ]]
ln -s "$ffmpeg" "$scratch/browsers/ffmpeg-1011/ffmpeg-linux"
: > "$scratch/npm-user.conf"
: > "$scratch/npm-global.conf"
node=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
npm=/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/lib/node_modules/npm/bin/npm-cli.js
npmroot=${npm%/bin/npm-cli.js}
# npm's actual nested bin (not a guessed sibling of the node executable).
npmbin=${npmroot%/lib/node_modules/npm}/bin
[[ -x $npmbin/npm ]]
python=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin/python3.14
[[ -x $python ]]
path="${node%/node}:$npmbin:$npmroot/bin/node-gyp-bin:${python%/*}:/run/current-system/sw/bin"
[[ -x $node && -f $npm && -d $npmroot/bin/node-gyp-bin ]]
export VP_SOURCE=$src VP_EXPECTED=$expected VP_MAIN=$main VP_OUT=$out VP_SCRATCH=$scratch
exec timeout --signal=TERM --kill-after=5s 240s env -i PATH="$path" HOME="$scratch/home" TMPDIR="$scratch/tmp" \
  XDG_CACHE_HOME="$scratch/cache" XDG_CONFIG_HOME="$scratch/config" npm_config_cache="$scratch/cache/npm" \
  NPM_CONFIG_USERCONFIG="$scratch/npm-user.conf" NPM_CONFIG_GLOBALCONFIG="$scratch/npm-global.conf" \
  npm_config_userconfig="$scratch/npm-user.conf" npm_config_globalconfig="$scratch/npm-global.conf" \
  npm_config_script_shell=/run/current-system/sw/bin/bash \
  VC_TEST_PI_DIR=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0 \
  VC_VOICE_PIPELINE=off VC_VOICE_PIPELINE_PORT=19483 \
  PLAYWRIGHT_BROWSERS_PATH="$scratch/browsers" \
  PREVIEW_BROWSER=/nix/store/agamzskapmh5018k98bqfwrrb738bgpv-chromium-153.0.8010.52/bin/chromium \
  VP_SOURCE="$src" VP_EXPECTED="$expected" VP_MAIN="$main" VP_OUT="$out" VP_SCRATCH="$scratch" \
  /run/current-system/sw/bin/bash -s -- "$node" "$npm" <<'INNER'
set -euo pipefail
node=$1; npm=$2
src=$VP_SOURCE; out=$VP_OUT; scratch=$VP_SCRATCH
cd "$src"
printf '%s\n' "source=$VP_EXPECTED" "baseline=$VP_MAIN" "scratch=$scratch" "dependencies=private-physical-closure-development-only" "scope=source-native-frontend/throwaway-server-fixture; not user-registration/production-Tauri/shipment" > "$out/source.txt"
children=()
cleanup() {
  for p in "${children[@]}"; do kill "$p" 2>/dev/null || true; done
  for p in "${children[@]}"; do wait "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 124' TERM INT
# A fresh baseline export, not another actor's working copy. Exact source, matching lockfile, no downloads.
mkdir "$scratch/baseline"
git archive "$VP_MAIN" > "$scratch/baseline.tar"
tar -xf "$scratch/baseline.tar" -C "$scratch/baseline"
cmp package-lock.json "$scratch/baseline/package-lock.json"
# Dependencies were physically copied without donor .bin; npm's genuine bin-links reconstructed
# 42 private relative launchers. Refuse shared symlinks/flattened bins or missing native optionals.
"$node" --input-type=module - "$src" <<'DEPS'
import assert from 'node:assert/strict';
import {realpathSync, lstatSync, readlinkSync, readdirSync, readFileSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
const root = realpathSync(process.argv[2]);
let count = 0;
function bins(dir) {
  assert(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), dir);
  for (const name of readdirSync(dir, {withFileTypes:true})) {
    const p=join(dir,name.name);
    if (name.name === '.bin') for (const b of readdirSync(p)) {
      const link=join(p,b);
      assert(lstatSync(link).isSymbolicLink() && !isAbsolute(readlinkSync(link)),link);
      assert(realpathSync(link).startsWith(root+'/'),link); count++;
    } else if (name.isDirectory() && !name.name.startsWith('.')) bins(p);
    else if (name.isSymbolicLink()) assert(realpathSync(p).startsWith(root+'/'),p);
  }
}
for(const sub of ['node_modules','preview/node_modules']) bins(join(root,sub));
assert.equal(count,42);
for(const p of ['node_modules/@esbuild/linux-x64/bin/esbuild','node_modules/tsx/node_modules/@esbuild/linux-x64/bin/esbuild','node_modules/@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node']) assert(realpathSync(join(root,p)).startsWith(root+'/'));
assert.equal(JSON.parse(readFileSync(join(root,'preview/node_modules/playwright-core/package.json'))).version,'1.54.0');
assert.equal(JSON.parse(readFileSync(process.env.VC_TEST_PI_DIR+'/node_modules/@earendil-works/pi-coding-agent/package.json')).version,'1.1.0');
assert.equal(process.versions.node.split('.')[0],'22');
console.log('Private closure, 42 genuine relative bins, native optionals, PW 1.54, Pi 1.1, Node22 checked');
DEPS
# Independent baseline package caches: no shared writable Vite/Vitest state with candidate or donors.
rsync -a --exclude='.vite*' --exclude=.cache node_modules/ "$scratch/baseline/node_modules/"
rsync -a --exclude='.vite*' --exclude=.cache preview/node_modules/ "$scratch/baseline/preview/node_modules/"
# Early owned-port refusal; never adopt another listener.
"$node" --input-type=module -e 'import{createServer}from"node:net";for(const port of [19481,19482,19483])await new Promise((ok,no)=>{const s=createServer();s.once("error",no);s.listen({host:"127.0.0.1",port,exclusive:true},()=>s.close(ok))})'
"$node" "$npm" run build:server > "$out/build.log" 2>&1
# Refuse occupied ports; never adopt or kill somebody else's listeners.
"$node" --input-type=module -e 'import{createServer}from"node:net";for(const port of [19481,19482,19483])await new Promise((ok,no)=>{const s=createServer();s.once("error",no);s.listen({host:"127.0.0.1",port,exclusive:true},()=>s.close(ok))})'
"$node" --import tsx preview/tools/finalModelBox.ts --root "$scratch/box" --picker-history > "$out/box.log" 2>&1 &
children+=("$!")
# Existing fixture allocates its own positive loopback server/provider ports. Never pass its broken --port override.
for i in {1..180}; do
  if grep -q '"base":"http://127.0.0.1:' "$out/box.log"; then break; fi
  kill -0 "${children[0]}" || { cat "$out/box.log"; exit 1; }
  sleep 1
done
box=$("$node" --input-type=module -e 'import{readFileSync}from"node:fs";const l=readFileSync(process.argv[1],"utf8").split("\n").find(l=>l.startsWith("{\"base\""));if(!l)throw Error("fixture not ready");const b=JSON.parse(l).base;const u=new URL(b);if(u.hostname!=="127.0.0.1"||!Number(u.port)||[8848,8857].includes(Number(u.port)))throw Error("unsafe port");console.log(b)' "$out/box.log")
"$node" --input-type=module -e 'const r=await fetch(`${process.argv[1]}/phone`,{signal:AbortSignal.timeout(10000)});if(!r.ok||!(/\/phone\/assets\/[^" ]+\.js/.test(await r.text())))throw Error("bundled phone not served")' "$box"
export VC_REALBOX=$box
"$node" preview/vite-child.mjs --tree "$scratch/baseline" --port 19481 --side before > "$out/baseline-vite.log" 2>&1 &
children+=("$!")
"$node" preview/vite-child.mjs --tree "$src" --port 19482 --side after > "$out/candidate-vite.log" 2>&1 &
children+=("$!")
# Check only processes we started before probing their listeners; strictPort refuses a raced bind.
for p in "${children[@]}"; do kill -0 "$p"; done
"$node" --input-type=module -e 'const pids=process.argv.slice(1).map(Number);for(const p of [19481,19482]){let ok=false;for(let i=0;i<180;i++){for(const pid of pids)process.kill(pid,0);try{if((await fetch(`http://127.0.0.1:${p}/${p===19481?"before":"after"}/`,{signal:AbortSignal.timeout(3000)})).ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,1000))}if(!ok)throw Error(`Vite ${p} not ready`)}' "${children[@]}"
for p in "${children[@]}"; do kill -0 "$p"; done
"$node" preview/tools/vaultPickerSplitRecord.mjs http://127.0.0.1:19481/before "$out/baseline" baseline > "$out/baseline-record.log" 2>&1
"$node" preview/tools/vaultPickerSplitRecord.mjs http://127.0.0.1:19482/after "$out/candidate" candidate > "$out/candidate-record.log" 2>&1
[[ $(git rev-parse HEAD) == "$VP_EXPECTED" && -z $(git status --porcelain) ]]
git merge-base --is-ancestor "$VP_MAIN" "$VP_EXPECTED"
printf '%s\n' 'Development UI checks passed; inspect candidate/03-separate-actions.png and videos. Not acceptance or shipment.' > "$out/completed.txt"
INNER
