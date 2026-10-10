#!/bin/sh
# dev helper: (re)start `npm run preview` in the background; args go to serve.mjs
for port in 1500 1520 1521; do for p in $(netstat -ano | grep ":$port " | grep LISTEN | awk '{print $5}' | sort -u); do taskkill //F //PID $p >/dev/null 2>&1; done; done
cd "$(dirname "$0")/../.." && nohup node preview/serve.mjs "$@" > "${TMPLOG:-/tmp/serve.log}" 2>&1 &
