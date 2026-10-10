#!/bin/sh
# dev helper: restart the before child on :1520
for p in $(netstat -ano | grep ':1520 ' | grep LISTEN | awk '{print $5}' | sort -u); do taskkill //F //PID $p >/dev/null 2>&1; done
cd "$(dirname "$0")/../.." && nohup node preview/vite-child.mjs --tree . --port 1520 --side before > "${TMPLOG:-/tmp/child.log}" 2>&1 &
