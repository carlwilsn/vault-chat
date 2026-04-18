#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// First launch runs foreground so the user sees the ~10-15 min Rust
// compile. Subsequent launches detach and return the terminal — logs
// go to the app's config dir.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";

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

const appDataDir = isWindows
  ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.vault-chat.app")
  : process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "com.vault-chat.app")
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "com.vault-chat.app");
mkdirSync(appDataDir, { recursive: true });
const logPath = join(appDataDir, "dev.log");

const firstLaunch = !existsSync(join(repo, "src-tauri", "target"));
const foreground = firstLaunch || process.argv.includes("--foreground");

if (foreground) {
  if (firstLaunch) {
    console.log("vault-chat: first launch — Rust will compile (~10-15 min). Running in foreground so you can see progress.");
    console.log("vault-chat: next launch will detach and return your terminal.");
  }
  const child = spawn(npm, ["run", "tauri", "dev"], {
    cwd: repo,
    stdio: "inherit",
    shell: isWindows,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("vault-chat: failed to launch:", err.message);
    process.exit(1);
  });
} else {
  const logFd = openSync(logPath, "a");
  const child = spawn(npm, ["run", "tauri", "dev"], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    shell: isWindows,
  });
  child.unref();
  console.log(`vault-chat: launching in background. Logs: ${logPath}`);
}
