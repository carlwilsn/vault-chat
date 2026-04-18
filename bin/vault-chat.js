#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// Runs `npm run tauri dev` in the foreground so the user sees cargo's
// output live. On Windows, once the app window boots, the launcher
// walks up the process tree to find the owning terminal window and
// minimizes it — the terminal stays alive with the dev server still
// attached, but disappears from the user's view.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

function need(cmd, hint) {
  const r = isWindows
    ? spawnSync("where", [cmd], { stdio: "ignore" })
    : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error(`vault-chat: missing '${cmd}'.`);
    console.error(hint);
    process.exit(1);
  }
}

need("node", "Install Node 20+ — https://nodejs.org");
need("cargo", "Install Rust via rustup — https://rustup.rs");
need("git", "Install git — https://git-scm.com/downloads");

if (!existsSync(join(repo, "node_modules"))) {
  console.log("vault-chat: installing node deps (one-time, ~1 min)…");
  const r = spawnSync(npm, ["install", "--silent"], {
    cwd: repo,
    stdio: "inherit",
    shell: isWindows,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const noHide = process.argv.includes("--no-hide");

function minimizeTerminal() {
  if (!isWindows || noHide) return;
  // Walk up from our PID until we find a process with a visible main
  // window (cmd.exe, PowerShell, Windows Terminal, etc.) and
  // ShowWindow it with SW_SHOWMINNOACTIVE (7). We pass our pid in; the
  // PS subprocess adds its own frame but Get-Process handles that.
  const script = `
$sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
$t = Add-Type -MemberDefinition $sig -Namespace VCW -Name U -PassThru
$id = ${process.pid}
for ($i = 0; $i -lt 10; $i++) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { break }
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
    [void]$t::ShowWindow($p.MainWindowHandle, 7)
    break
  }
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
  if (-not $parent -or $parent -eq $id) { break }
  $id = $parent
}
`;
  spawn("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  }).unref();
}

const child = spawn(npm, ["run", "tauri", "dev"], {
  cwd: repo,
  stdio: ["inherit", "pipe", "pipe"],
  shell: isWindows,
});

const readyMarker = /Running `target[\/\\]/;
let minimized = false;
let buf = "";

function watchForReady(chunk) {
  if (minimized) return;
  buf = (buf + chunk.toString()).slice(-500);
  if (readyMarker.test(buf)) {
    minimized = true;
    // Give the app window a moment to actually appear before hiding
    // the terminal — avoids the jarring "terminal gone, nothing here
    // yet" gap.
    setTimeout(minimizeTerminal, 800);
  }
}

child.stdout.on("data", (d) => { process.stdout.write(d); watchForReady(d); });
child.stderr.on("data", (d) => { process.stderr.write(d); watchForReady(d); });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("vault-chat:", err.message);
  process.exit(1);
});
