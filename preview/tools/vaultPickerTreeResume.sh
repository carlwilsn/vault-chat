#!/run/current-system/sw/bin/bash
# Development-only resume of the retained b65 proof. No build, install, publication or live data.
set -euo pipefail
umask 077
helper=$(cd -- "$(dirname -- "$0")/../.." && pwd)
source=/home/carlwilsn/agent-work/vault-chat/changes/picker-on-reset-startup-1031/agent/picker-on-reset-startup-1031
retained=/tmp/vp.udsrRP
prior=/tmp/picker-on-reset-startup-1031-populated-r1
out=${1:?new /tmp output directory required}
kind=${2:-full}
[[ $out == /tmp/* && ! -e $out && ( $kind == full || $kind == preflight ) ]]
[[ $(git -C "$source" rev-parse HEAD) == b65fc80cd3ba33d2c85adaca4f13e9125d8b330b && -z $(git -C "$source" status --porcelain) ]]
mkdir -m 700 "$out"
node=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
exec env -i PATH="${node%/*}:/run/current-system/sw/bin" HOME="$retained/home" TMPDIR="$retained/tmp" XDG_CACHE_HOME="$retained/cache" XDG_CONFIG_HOME="$retained/config" \
 VC_TEST_PI_DIR=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0 VC_VOICE_PIPELINE=off VC_VOICE_PIPELINE_PORT=19483 \
 PLAYWRIGHT_BROWSERS_PATH="$retained/browsers" PREVIEW_BROWSER=/nix/store/agamzskapmh5018k98bqfwrrb738bgpv-chromium-153.0.8010.52/bin/chromium \
 /run/current-system/sw/bin/bash -s -- "$helper" "$source" "$retained" "$prior" "$out" "$kind" "$node" <<'INNER'
set -euo pipefail
helper=$1; source=$2; retained=$3; prior=$4; out=$5; kind=$6; node=$7
cd "$source"
# Verify the retained baseline export against its pin and original candidate against its pin.
# Helpers differ; all tracked product inputs and assets remain byte-identical to those already built.
"$node" --input-type=module - "$retained/baseline" "$source" > "$out/inputs.log" <<'JS'
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
for (const [root, pin] of [[process.argv[2], '93837b6c4dde00f4e6f0a4a18511a524c2aa8dd7'], [process.argv[3], 'b65fc80cd3ba33d2c85adaca4f13e9125d8b330b']]) {
 const entries=execFileSync('git',['ls-tree','-r',pin],{encoding:'utf8'}).trim().split('\n');
 let count=0;
 for (const row of entries) { const [meta,path]=row.split('\t'); if(path.startsWith('preview/')||path.startsWith('memory/'))continue;
 const bytes=readFileSync(`${root}/${path}`); const hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 if(hash!==meta.split(' ')[2])throw Error(`changed input ${root}/${path}`); count++;
 }
 console.log(`${root}: ${count} pinned non-preview inputs byte-identical (${pin})`);
}
const bundle=readFileSync('dist-server/vault-chat-server.mjs');
const digest=createHash('sha256').update(bundle).digest('hex');
if(digest!=='a547512cadd03577a0d9b809d862cccd907dfc6005208a1e004c7636f9047492')throw Error('retained b65 bundle changed');
console.log(`Reusing original b65 build, bundle sha256=${digest}; prior gates/build log retained, no rebuild claimed`);
JS
cp "$prior/source.txt" "$out/original-source.txt"
printf '%s\n' "helper=$(git -C "$helper" rev-parse HEAD)" "kind=$kind" "original failure retained: $prior" > "$out/resume.txt"
"$node" --input-type=module -e 'import{createServer}from"node:net";for(const port of [19481,19482,19483])await new Promise((ok,no)=>{const s=createServer();s.once("error",no);s.listen({host:"127.0.0.1",port,exclusive:true},()=>s.close(ok))})'
children=(); starts=()
owned() { local pid=$1 start=$2; [[ -r /proc/$pid/stat && $(awk '{print $22}' /proc/$pid/stat) == "$start" ]]; }
add() { children+=("$1"); starts+=("$(awk '{print $22}' /proc/$1/stat)"); }
cleanup() { for i in "${!children[@]}"; do if owned "${children[i]}" "${starts[i]}"; then kill "${children[i]}" 2>/dev/null || true; wait "${children[i]}" 2>/dev/null || true; fi; done; }
trap cleanup EXIT
trap 'exit 124' TERM INT
# Existing seeder: migration is ONLY on a new throwaway synthetic fixture, never retained/live data.
"$node" --import tsx preview/tools/finalModelBox.ts --root "$out/synthetic-box" --picker-history > "$out/box-synthetic-only.log" 2>&1 &
add "$!"
for i in {1..60}; do grep -q '^{"base"' "$out/box-synthetic-only.log" && break; owned "${children[0]}" "${starts[0]}"; sleep .1; done
box=$("$node" --input-type=module -e 'import{readFileSync}from"node:fs";const line=readFileSync(process.argv[1],"utf8").split("\n").find(l=>l.startsWith("{\"base\""));const u=new URL(JSON.parse(line).base);if(u.hostname!=="127.0.0.1"||!Number(u.port)||[8848,8857].includes(+u.port))throw Error("unsafe fixture");console.log(u.origin)' "$out/box-synthetic-only.log")
export VC_REALBOX=$box
"$node" preview/vite-child.mjs --tree "$retained/baseline" --port 19481 --side before > "$out/baseline-vite.log" 2>&1 &
add "$!"
"$node" preview/vite-child.mjs --tree "$source" --port 19482 --side after > "$out/candidate-vite.log" 2>&1 &
add "$!"
"$node" --input-type=module -e 'for(const port of [19481,19482]){let ok=false;for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/${port===19481?"before":"after"}/`,{signal:AbortSignal.timeout(1000)})).ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}if(!ok)throw Error("Vite not ready")}'
extra=(); [[ $kind == full ]] || extra+=(--preflight)
for mode in baseline candidate; do
 for i in "${!children[@]}"; do owned "${children[i]}" "${starts[i]}"; done
 port=19481; side=before; [[ $mode == baseline ]] || { port=19482; side=after; }
 "$node" "$helper/preview/tools/vaultPickerSplitRecord.mjs" "http://127.0.0.1:$port/$side" "$out/$mode" "$mode" "${extra[@]}" > "$out/$mode-record.log" 2>&1
done
printf '%s\n' "$kind development checks passed; no acceptance/shipment claimed" > "$out/completed.txt"
INNER
