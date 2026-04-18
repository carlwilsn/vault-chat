#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// Spawns `tauri dev` fully detached and hidden — the user's terminal
// returns immediately and the app window appears ~2s later (for a warm
// cache). No output is captured. `--foreground` shows cargo's output
// inline for debugging.

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

if (process.argv.includes("--foreground")) {
  const child = spawn(npm, ["run", "tauri", "dev"], {
    cwd: repo,
    stdio: "inherit",
    shell: isWindows,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("vault-chat:", err.message);
    process.exit(1);
  });
} else if (isWindows) {
  // PowerShell's Start-Process -WindowStyle Hidden is the only reliable
  // way on Windows to launch cmd.exe fully headless (SW_HIDE in
  // STARTUPINFO before CreateProcess). Output is discarded; run with
  // --foreground if you need to see it.
  const psCmd =
    `Start-Process -WindowStyle Hidden -WorkingDirectory '${repo}' ` +
    `-FilePath 'cmd.exe' -ArgumentList '/c','npm run tauri dev'`;
  spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCmd],
    { stdio: "ignore", windowsHide: true, detached: true }
  ).unref();
  console.log("vault-chat: launching. App window will appear shortly.");
  process.exit(0);
} else {
  const child = spawn(npm, ["run", "tauri", "dev"], {
    cwd: repo,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  console.log("vault-chat: launching. App window will appear shortly.");
  process.exit(0);
}
