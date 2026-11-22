# Performance baseline harness

Two small tools to record and compare the speeds that must not get worse: launch-to-interactive, composer keystroke-to-paint, Ctrl+K, Ctrl+Shift+F and chat-panel opening. Neither changes the app. The allowed margin is Carl's number: both tools have no default margin.

## 1. `scripts/perf-baseline.mjs`: the laptop's own numbers

Reads what the box already stores from the app's probe (`src/laptopPerf.ts` -> `POST /api/v1/laptop-perf` -> `<state>/logs/laptop-perf.jsonl` and `.1`, see `docs/laptop-perf.md`). Read-only on those files. Run on the box.

```
node scripts/perf-baseline.mjs show
node scripts/perf-baseline.mjs record  --out ~/agent-work/vault-chat/perf-baselines/base.json [--merge]
node scripts/perf-baseline.mjs compare --baseline base.json (--margin-pct 10 | --margin-ms 5) [--now other.json]
```

- `show` prints a markdown table: count, median, p95, min, max per `metric/method`. A metric and its method are never mixed (`event-timing` and `double-raf-estimate` are different measurements; `docs/laptop-perf.md`). Required metrics with no sample are listed as missing, never filled in.
- `record` prints the same table and writes the baseline JSON: the stats, the revisions seen and every raw sample (`at`, session, revision, ms). `--merge` adds the current records to an existing file, counting a sample once.
- `compare` puts the baseline next to now (the live records, or another baseline file with `--now`) and flags a metric whose median or p95 is above the baseline by more than the margin. `--margin-pct` is a percentage of the baseline, `--margin-ms` is milliseconds; with both, exceeding either flags. Faster is never flagged; a metric on one side only is listed, not flagged. Exit 0 = nothing worse, 1 = something worse, 2 = usage error or no records.
- Filters, for all three: `--dir <state dir>` (default `$VC_STATE_DIR`, else `~/.local/state/vault-chat-server`), `--file <jsonl>` (repeatable), `--surface` (default `tauri-production`, the only surface that can be Carl's laptop; `any` for all), `--revision <hex prefix>`, `--since <ISO time>`, `--include-hidden` (hidden-window samples are dropped by default).
- Percentile: nearest rank. Median of an even count is the mean of the middle two.

Two things to know about the data:

- **The box keeps minutes, not days.** The log is capped at 256 KiB plus one older file. At typing rates that is roughly six minutes of keys, and a once-per-start `launch-interactive` sample is rotated out quickly. To build a baseline, do the five actions on the laptop (restart the app; type in the composer; type in Ctrl+K; Ctrl+Shift+F; open the chat panel), then run `record --merge` straight away. Do it for several sessions and the file accumulates.
- **`event-timing` only reports events of 16 ms or more**, so its median is biased high and its count is not the key count. `double-raf-estimate` covers every key. Judge typing on `double-raf-estimate`, and use `event-timing` as the browser's own presentation check.

## 2. `scripts/typing-bench.mjs`: A/B typing in headless Chromium

Real key events (CDP `Input.dispatchKeyEvent`) into the composer; for each `input` event the time until two animation frames later, the same quantity as `docs/typing-performance-0726.md`. It does not use Playwright (no dependency): it drives `/run/current-system/sw/bin/chromium` (override with `CHROMIUM`) with `--headless=old --no-sandbox --disable-gpu` and a throwaway profile under the temp dir. It never presses Enter; the draft is cleared.

It needs a test instance of the desktop UI. The one that exists is the preview harness (`preview/README.md`), which serves two trees side by side, so an A/B is one command pair. Use ports that are not the live 8848/8857 (the tool refuses those and anything not on loopback):

```
node preview/serve.mjs --port 1531 --before-port 1532 --after-port 1533 --before main --after /path/to/other-checkout
node scripts/typing-bench.mjs \
  --url A="http://127.0.0.1:1531/before/?scenario=conv-a" \
  --url B="http://127.0.0.1:1531/after/?scenario=conv-a" \
  --keys 41 --runs 3 --out /tmp/typing-ab.json
```

Runs of the URLs are interleaved (A, B, A, B, ...) in fresh pages so drift hits both. The table gives samples, median, p95, min, max and the median of the per-run medians. `--warmup` keys (default 5) are typed first and dropped. A busy scenario matters: `conv-a` is long enough to show typing cost (about 21 ms median here), `chat-tools` is nearly empty (about 4 ms). Run A against A first to see the noise before reading an A/B difference.

Limits: this is Chromium, a fake backend and a synthetic conversation, not WebView2 on Carl's laptop and not his history. It shows a regression in render cost between two trees; it does not give the laptop's absolute number (that is section 1). Sample counts can be one or two above keys x runs when the app emits an extra input event.

## 3. On the real laptop, per build: `box:perf`

The raw records of section 1 rotate within hours. Each accepted batch is also folded per build revision into `<state>/perf-builds.json` (server/perfLog.ts: the newest 300 samples per metric/method key, the newest 20 builds; tauri-production and visible only, as `flatten`). The agent reads it with `PluginRead {plugin: "box:perf"}` (each build's median/p95 per key and the last launch the app reported, server/hostBuild.ts) and compares with `PluginAct {plugin: "box:perf", action: "compare", args: {from?, to?, baseline?, marginPct | marginMs}}` (default: the newest build against the one before; section 1's `compare` and margin rule). These are Carl's own keystrokes and transitions, not synthetic runs. (This replaced the `Timing` tool, which typed synthetic keys into a hidden copy of the app.)

## Tests

`server/test/perfBaseline.test.ts` and `server/test/perfLog.test.ts` (box:perf; both run in `npm run test:server`): statistics, filters, merge, compare flags and exit codes over records written by the box's own `recordLaptopPerf`, and the typing tool's URL guard. The browser run itself is not in the test suite.

`server/test/pdfTyping.test.ts` (runs in `npm run test:server`, serial, so in the ship gates): the preview harness in headless Chromium at a laptop's speed (CPU 4x throttled, DPR 2), a 640-page PDF in split view beside a note in the editor; composer and editor keystroke-to-paint medians must stay under 50 ms (best of three fresh tries). Skipped without a browser.
