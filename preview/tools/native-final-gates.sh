#!/run/current-system/sw/bin/bash
# PARENT StartJob ONLY except --check. Ordinary shared comparator; no retirement waiver/exception.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${1:?--check or --run}; pin=${2:?exact full candidate SHA}; base=${3:?exact readonly canonical base SHA}
[[ $mode == --check || $mode == --run ]]
[[ $pin =~ ^[a-f0-9]{40}$ && $base =~ ^[a-f0-9]{40}$ ]]
node=/nix/store/ya2lzgl9wj76175dwrhg2x4d3pif1xxg-nodejs-slim-22.23.2/bin/node
npm=/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/bin
python=/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin
out=$(mktemp -d /tmp/sg.XXXXXX); mkdir "$out/h" "$out/t" "$out/c"; : > "$out/u"; : > "$out/g"
printf 'Gate launcher private environment: %s\n' "$out"
cd "$repo"
args=(); [[ $mode != --check ]] || args+=(--check)
exec env -i PATH="$(dirname "$node"):$npm:$python:/run/current-system/sw/bin" HOME="$out/h" TMPDIR="$out/t" XDG_CACHE_HOME="$out/c" XDG_CONFIG_HOME="$out/c" \
 NPM_CONFIG_USERCONFIG="$out/u" NPM_CONFIG_GLOBALCONFIG="$out/g" NPM_CONFIG_CACHE="$out/c" \
 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
 VC_VOICE_BRAIN=off VC_VOICE_PIPELINE=off VC_SYNC=0 \
 timeout --signal=TERM --kill-after=5 5400 "$node" preview/tools/native-final-gates.mjs "$pin" "$base" "${args[@]}"
