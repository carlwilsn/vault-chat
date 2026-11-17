# 11 — Verifying the macOS build before any Mac user gets it

Research only (2026-11-17). Nothing was changed or pushed. Repo read: `wt-caseguard` checkout.

## Recommendation

**Stack: free GitHub-hosted macOS runners + the app's own step driver run in a "self-test" mode + native
`screencapture`/`osascript` for the window chrome + a release gate that keeps Mac clients on a separate,
promote-later manifest. Add an Apple Developer ID once a second person uses the Mac build. Rent a real Mac
for a day only for the few things a CI VM can't show (keychain prompts after an update, Gatekeeper on a
browser download).**

| Piece | What it proves | Cost |
|---|---|---|
| `build_macos` job on `macos-15` (arm64, M1) and `macos-15-intel` | The release artifact (.app, .app.tar.gz + updater .sig) builds for both arches | $0 (standard runners are free and unlimited on public repos) |
| `verify_macos` job, same runners, on the **exact artifact** that will ship | Launch, bundled server, paths/HOME, case-insensitive APFS, spaces in paths, keychain, git, opening a vault, chat (fake model), editor, updater install | $0 |
| Self-test mode of the existing Drive step engine (`src/driveSteps.ts`) | The UI works in WKWebView: same click/type/press/waitFor steps the agent already uses on Windows | $0 (build work only) |
| `screencapture` + `osascript` (System Events) from the job's bash | Real pixels of the real window incl. native traffic lights; AX check that close/minimize/zoom buttons exist | $0 (runner image pre-grants bash Screen Recording + Accessibility) |
| Gate: Mac entries only reach a manifest after `verify_macos` passes; friend channel promoted after a soak with automatic hold | A broken Mac build never reaches anyone; a bad-but-passing build reaches Carl's channel first | $0 |
| Apple Developer Program (Developer ID + notarization) | Gatekeeper-clean installs, stable code identity so keychain/TCC grants survive updates | $99/yr ≈ **$8.25/mo** |
| Occasional real Mac (Scaleway M4, 24 h minimum) | Interactive check of the things a CI VM fakes (login keychain ACL prompts after update, quarantined browser download, multi-display, Retina) | ≈ €5.30 per session (€0.22/h × 24 h); only when signing/updater/keychain code changes |

**Monthly cost: $0 without Developer ID, ~$8/mo with it, plus ~€5 per rare deep-check day.**

Why not the alternatives as the main driver: `tauri-driver` has no macOS support at all (Apple ships no
WKWebView WebDriver); CrabNebula's macOS driver needs a paid subscription (price on request); the community
`tauri-plugin-(wdio-)webdriver` works on macOS but is debug-build-only by design and pre-1.0/young — so it
would test a *different binary* than the one shipped. The app already owns a tested step engine that is
pure DOM, so it runs in WKWebView unchanged; it only needs a non-box entry point.

## Can the app's own Drive be the e2e driver on a macOS runner?

What it is today (read from source):
- `src/driveSteps.ts` — the step engine: `click/hover/type/press/wait/waitFor/scroll/shot`, max 40 steps,
  synthetic DOM events (`isTrusted:false`). **Pure DOM, no native code → works in WKWebView as-is.**
- `src/driveHost.ts` / `src/driveRunner.ts` — runs the steps in a hidden second `WebviewWindow`
  (`index.html?view=drive`) that is **read-only** (`src/driveGuard.ts`, `capabilities/drive.json`).
- `src/driveOnLaptop.ts` — the trigger: a `drive` signal from the box over the feed (control link), with an
  idle check on Carl's input.
- `shot` uses `src/screenCapture.ts`, which paints the DOM into an SVG `foreignObject`; the file itself says
  **WebKit taints that canvas and returns an error** — so `shot` fails on macOS (and never shows native chrome anyway).

Verdict: **yes as the step engine, no as-is as the harness.** Three gaps, all small:
1. **Trigger without a box.** Add a self-test entry point: e.g. env `VC_SELFTEST=/path/steps.json` (or
   `--selftest`) makes the main window run `runSteps(document, steps)` after load and write
   `{steps, errors, text}` JSON to a path, then exit with 0/1. No feed, no idle check.
2. **Not read-only.** Self-test must run in the main window (or a writable Drive copy) because the checks
   must open a vault, send a chat and save an edit — exactly what the read-only copy forbids.
3. **Screenshots from outside.** Replace `shot` in self-test with a marker the job polls for, or just take
   `screencapture` from bash between step batches (see below). Native pixels are what we need anyway.

Plus a fake model: the server already passes `ANTHROPIC_BASE_URL` through (`server/engine/claude/cliEnv.ts`)
and has a fake Anthropic API for tests (`server/test/claudeFakeApi`, used by `server/test/helpers.ts`), so
the chat check can run against a local fake with a canned reply — no key, no spend, deterministic text to `waitFor`.

## Comparison

### 1. GitHub-hosted macOS runners
- Labels: `macos-15` / `macos-26` / `macos-latest` = **arm64 M1, 3 CPU, 7 GB RAM, 14 GB SSD**;
  `macos-15-intel` / `macos-26-intel` = Intel, 4 CPU, 14 GB. **Free and unlimited for public repos.**
  Larger (`-xlarge`) runners are billed. Jobs max 6 h; free plan allows 5 concurrent macOS jobs. Queues
  can be slow under high demand. No nested virtualization on arm64.
- **GUI works:** the image enables automatic GUI login (`configure-autologin.sh`), so a launched `.app`
  gets a real WindowServer session. The image's TCC database (`configure-tccdb-macos.sh`) pre-grants
  `kTCCServiceScreenCapture` and `kTCCServiceAccessibility` to `/bin/bash`, and Accessibility + AppleEvents
  (System Events) to `/usr/bin/osascript`. So from a `shell: bash` step: `screencapture -l <windowid>` or
  full-screen `screencapture`, and `osascript -e 'tell application "System Events" to get buttons of window 1 of process "vault-chat"'`
  (traffic lights are `AXCloseButton`/`AXMinimizeButton`/`AXZoomButton`).
- Known caveat: a runner-images issue reported green *video* recordings from `screencapture` on macOS 12;
  maintainers suggested newer images. Stills on 14/15 should be fine, but the first job should assert the PNG
  is not uniform.
- Keychain: a CI user has no human login-keychain history; create and unlock a dedicated keychain in the job
  (`security create-keychain` / `default-keychain` / `unlock-keychain`) so the `keyring` crate's
  `apple-native` backend can write/read without a prompt. This proves the code path, **not** the real-user
  ACL-prompt behaviour (that is the deep-check item).
- Filesystem: runner disk is APFS case-insensitive (assert with `diskutil info /`); additionally mount a
  `hdiutil create -fs "Case-sensitive APFS"` image to test both.

### 2. macOS e2e drivers for Tauri / WKWebView
| Option | macOS? | Tests the shipped binary? | Cost | Notes |
|---|---|---|---|---|
| `tauri-driver` (official) | **No** — Windows/Linux only | — | free | Tauri docs: "macOS has no WKWebView driver tool available" |
| CrabNebula `@crabnebula/tauri-driver` + `tauri-plugin-automation` | Yes | No (plugin in debug builds) | **paid subscription**, price on request, `CN_API_KEY` | Mature vendor, but extra service + key |
| `tauri-plugin-wdio-webdriver` (WebdriverIO "embedded" provider) | Yes, "full support" via WKWebView APIs | No (gate with `cfg(debug_assertions)`; exposes HTTP automation) | free | v1.3.0 (Aug 2026), fork of Choochmeque's `tauri-plugin-webdriver` (0.1.x); screenshots of the page only (no native chrome) |
| Appium Mac2 (XCTest) | Yes | Yes | free | Sees the accessibility tree; web content inside WKWebView is exposed only partially (ARIA) — fine for window chrome/menus, poor for the app UI; needs Xcode + Appium 3 |
| Playwright | No attach to a third-party app's WKWebView (its WebKit is its own browser build) | — | free | Only usable via a WebDriver plugin as a W3C client, per that plugin's README |
| **App's own step engine (self-test mode)** | Yes (pure DOM) | **Yes — the release artifact** | free | Needs the 3 small changes above; same steps reused on Windows via Drive |

Recommended split: app step engine for everything inside the webview; `osascript`/AX + `screencapture` for
the native window; optionally `tauri-plugin-wdio-webdriver` later in a debug build if you want a
standard WebDriver suite — not needed for the gate.

### 3. Real remote Macs (deeper checks, agent-driven over SSH; GUI over VNC)
| Provider | Price | Minimum | Agent access |
|---|---|---|---|
| **Scaleway** Mac mini M4-S (16 GB/256 GB) | €0.22/h or €149/mo; M4-M €0.29/h; M4 Pro €0.49/h | **24 h** (Apple licence), optional auto-delete after 24 h | SSH key at creation; remote desktop (VNC) documented |
| AWS EC2 Mac (dedicated host) | M1 launched at $0.6498/h; M2 ~$0.88/h, M4 ~$1.23–1.35/h (third-party figures) | **24 h** host allocation, per-second after | SSH, SSM Session Manager; Screen Sharing off by default (enable it) |
| MacStadium | M2.S $109/mo, M4.S $149/mo, M4.M $249/mo | monthly billing | root access, dedicated IPv4 (SSH/VNC not spelled out on pricing page) |

An agent on the box can drive any of these with `ssh` + `screencapture` + `osascript` (grant Screen
Recording/Accessibility to `sshd-keygen-wrapper` once via VNC) — the same scripts as CI. Scaleway is the
cheapest per session; nothing here justifies a monthly Mac yet.

### 4. Release gating and a delayed friend channel
Today `ship.yml` already does draft → build → one `latest.json` → publish, and the updater reads
`releases/latest/download/latest.json`. Tauri validates the *whole* static manifest before reading the
version, and missing a platform makes that platform's check fail. Two ways in:
- **Simple:** add `build_macos` + `verify_macos`; the `manifest` job `needs:` them, so nothing publishes
  unless Mac passes. Downside: a Mac-only failure also blocks Windows/Linux.
- **Recommended:** give Mac its own manifest location from day one (no Mac installs exist yet, so no
  migration). Endpoint e.g. `https://github.com/carlwilsn/vault-chat/releases/download/updater/{{target}}-{{arch}}-{channel}.json`
  — a fixed `updater` release whose JSON assets are overwritten by promotion (asset URLs inside point at the
  versioned release). Tauri supports `{{target}}`/`{{arch}}`/`{{current_version}}` in endpoints and
  runtime endpoints via `updater_builder().endpoints(...)`, so the app picks its channel (`carl` / `friend`)
  from a setting. Then:
  1. `verify_macos` passes → write `darwin-*-carl.json` (Carl's channel / test Mac).
  2. A promotion job (box cron, since health data lives on the box; or an Actions cron) writes
     `darwin-*-friend.json` only when: version is ≥ N hours old (e.g. 24 h), Carl's install has reported
     that version at launch (the LaptopBuild report) and no error/crash reports for it, and no
     `hold` flag. Any error report → set `hold`, Notify Carl, friend stays on the previous version.
  3. Same mechanism can later move Windows/Linux to channels.
- GitHub alternative for the delay: an Environment with a **wait timer** (up to 30 days, free on public
  repos) or required reviewer on the promotion job; custom protection rules need a GitHub App. The box
  cron is simpler because the hold signal is on the box.
- Caveat: if Carl has no Mac, "Carl's install" soaks only the shared code; the Mac-specific safety comes
  from `verify_macos` (including the update-install test below).

### 5. Unsigned distribution, updater, Developer ID
- **curl install avoids quarantine:** Apple DTS: "Most Unix-y tools don't quarantine their downloads,
  including curl and scp", and Gatekeeper "usually only kicks in [if] the app is quarantined". So
  `curl … | tar x` into `/Applications` launches without the Gatekeeper dialog. A browser download of the
  same build is quarantined and gets the "damaged / Open Anyway" path.
- **Apple Silicon needs a signature:** Tauri docs: code-signing is required for all apps from the Internet
  on Apple Silicon; use ad-hoc (`signingIdentity: "-"`). Ad-hoc still doesn't satisfy Gatekeeper for
  quarantined files.
- **Updater on unsigned/ad-hoc:** Tauri's updater signature (minisign, mandatory) is separate from Apple's.
  Evidence is mixed: one guide says the first auto-update of an un-notarized build ends in "app is damaged";
  the Apple DTS reasoning says a non-quarantining download shouldn't trigger Gatekeeper. **Do not trust
  either — make it a CI check** (install vN, update to vN+1 from a local manifest, relaunch, re-run smoke).
- **Ad-hoc identity changes every build**, so macOS forgets TCC grants (and, by the same designated-
  requirement logic, keychain item ACLs) after each update → keychain "allow access" prompts per update.
  This alone is the strongest reason to buy Developer ID before a friend uses it daily.
- **Developer ID + notarization:** Apple Developer Program **$99/yr**; Developer ID Application cert (Account
  Holder creates it). Tauri bundler signs + notarizes in CI with `APPLE_CERTIFICATE` (base64 .p12),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and either `APPLE_API_ISSUER`/`APPLE_API_KEY`/
  `APPLE_API_KEY_PATH` (App Store Connect key, preferred) or `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`.
  The cert must be created once on a Mac or via the developer portal with a CSR (can be done from Linux
  with `openssl`).

## What the verify_macos job checks (each one a pass/fail line + artifacts)

1. **Launch**: `open -n vault-chat.app` with `HOME` = a fresh temp home; window appears (osascript `count windows` > 0 within 30 s); process alive after 60 s; no crash report in `~/Library/Logs/DiagnosticReports`.
2. **Bundled server**: the app's `node` + `binaries/vault-chat-server.mjs` starts; health URL answers; log written under the expected `~/Library/Application Support/<id>/` path.
3. **Paths**: vault at `~/Documents/My Vault/Ünïcode dir` (spaces + non-ASCII); state under `~/Library/...`; a test that writes `Notes.md` and reads `notes.md` on case-insensitive APFS behaves as the app expects (the case-guard work), repeated on a case-sensitive APFS disk image; no `\` separators in stored paths.
4. **Keychain**: in a dedicated unlocked keychain, the app stores, reads back and deletes a canary secret.
5. **Git**: vault init/commit/autosave works with the system `git` (Xcode CLT on runner) and with `git` absent from PATH (expected error message, no crash).
6. **UI (self-test steps)**: open the vault → file tree shows `README.md` → open it in the editor, type, save, reload → text persisted; send a chat message → fake model's canned reply appears; Ctrl/Cmd shortcuts map correctly (`Meta` vs `Control`).
7. **Native chrome**: osascript lists AXClose/Minimize/Zoom buttons on the main window; `screencapture -l` PNG of the window uploaded as an artifact (light + dark appearance) and checked not to be uniform.
8. **Updater**: install previous release's `.app`, serve new `latest.json` + `.app.tar.gz` from `python3 -m http.server`, run the update, relaunch, repeat steps 1–2 and 6.
9. **Both arches**: whole job on `macos-15` (arm64) and `macos-15-intel`.

Artifacts (PNGs, self-test JSON, app logs) are uploaded so the box agent can fetch them with
`gh run download` and look at the screenshots before promotion.

## Build steps (in order)

1. **Fix the chrome first:** `tauri.conf.json` has `decorations:false` + `titleBarStyle:"Overlay"`. On macOS,
   `decorations:false` removes the native titlebar (Tauri docs: custom titlebars "lose some features
   provided by the system"); Overlay needs decorations on. Use a per-platform config
   (`tauri.macos.conf.json` with `decorations:true`, `titleBarStyle:"Overlay"`, `hiddenTitle:true`) and leave
   Windows/Linux as is; reserve ~70 px left padding for the lights in the CSS on macOS.
2. **Self-test entry point** (`VC_SELFTEST` steps file → run in main window via `runSteps` → JSON result →
   exit code), plus a `shot` that writes a marker/pauses so the job takes a native screenshot. Keep it inert
   unless the env var is set.
3. **Fake model hook for the app** (env `ANTHROPIC_BASE_URL` → local fake from `server/test/claudeFakeApi`,
   started by the job).
4. **Steps files** `test/macos/*.json` (open vault, edit/save, chat, shortcuts) — reusable via Drive on Windows.
5. **`scripts/macos-verify.sh`**: fresh HOME, keychain setup, APFS images, launch, osascript/AX checks,
   screencapture, server health, git, updater round-trip; prints one line per check.
6. **`ship.yml`**: `build_macos` (matrix arm64 + intel, ad-hoc `signingIdentity:"-"` until Developer ID,
   `includeUpdaterJson:false`, upload `.app.tar.gz` + `.sig` to the draft) → `verify_macos` (downloads
   those exact assets, runs step 5) → write `darwin-*-carl.json` to the `updater` release. Optional: a
   PR-time `verify_macos` on `workflow_dispatch` for testing changes before shipping.
7. **Channels in the app**: updater endpoints set at runtime from a `updateChannel` setting (`carl` default,
   `friend`), Mac endpoint pointing at the `updater` release JSON.
8. **Promotion + hold** (box script on a timer): soak window, LaptopBuild/health check, `hold` flag,
   Notify on hold; writes `*-friend.json` with `gh release upload --clobber`.
9. **Install script** for the friend: `curl` the `.app.tar.gz` → `/Applications` (no quarantine), verify
   the minisign signature first.
10. **Developer ID** ($99/yr) when a friend starts using it daily: add the six `APPLE_*` secrets, enable
    notarization in `build_macos`, add `spctl -a -vv` and `codesign --verify --deep --strict` to the verify job.
11. **Deep check on a rented Mac** (Scaleway, 24 h) after steps 8 and 10 land: browser download + Gatekeeper,
    real login keychain prompts across an update, Retina/multi-display screenshots.

## Sources (read)
- GitHub-hosted runners reference: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Actions limits (6 h jobs, 5 concurrent macOS): https://docs.github.com/en/actions/reference/limits
- Environments (wait timer, reviewers, custom rules): https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- Arm64 runners GA (Linux/Windows only, not macOS): https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/
- runner-images TCC grants: https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh
- runner-images autologin: https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-autologin.sh
- runner-images green screen recordings issue: https://github.com/actions/runner-images/issues/9047
- Tauri WebDriver docs: https://v2.tauri.app/develop/tests/webdriver/
- WebdriverIO Tauri platform support: https://webdriver.io/docs/desktop-testing/tauri/platform-support
- CrabNebula Tauri e2e: https://docs.crabnebula.dev/plugins/tauri-e2e-tests/
- tauri-plugin-webdriver README: https://docs.rs/crate/tauri-plugin-webdriver/0.1.2/source/README.md
- tauri-plugin-wdio-webdriver: https://docs.rs/crate/tauri-plugin-wdio-webdriver/1.3.0
- Tauri updater: https://v2.tauri.app/plugin/updater/
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri window customization: https://v2.tauri.app/learn/window-customization/
- Apple DTS on quarantine/curl: https://developer.apple.com/forums/thread/666452
- Un-notarized auto-update "damaged" claim: https://stuffbucket.github.io/skills/catalog/tauri-updater/
- TCC grants tied to signature (ad-hoc loses them): https://docs.openclaw.ai/platforms/mac/permissions
- AWS EC2 Mac FAQ (24 h, SSH/SSM/VNC): https://aws.amazon.com/ec2/instance-types/mac/faqs/
- MacStadium pricing: https://macstadium.com/pricing
- Scaleway prices/24 h minimum (search-result excerpts of scaleway.com pricing and docs pages; the pages
  themselves returned 403 to the fetcher — confirm before renting): https://www.scaleway.com/en/pricing/apple-silicon ,
  https://www.scaleway.com/en/docs/apple-silicon/faq/
- AWS M2/M4 hourly figures are third-party (runs-on.com, computingforgeeks) seen only in search excerpts; Appium Mac2
  WKWebView limits from appium XCUITest troubleshooting docs seen only in search excerpts — treat as leads.
