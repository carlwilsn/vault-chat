#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// Checks toolchain, installs node deps on first run, and execs
// `npm run tauri dev` in the foreground. Same output you'd see running
// `npm run tauri dev` directly — just reachable by a shorter name.

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
