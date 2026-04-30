#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// Checks toolchain, installs node deps on first run, fast-forward
// pulls origin/main if the working tree is clean, and execs
// `npm run tauri dev` in the foreground. Same output you'd see
// running `npm run tauri dev` directly — just reachable by a shorter
// name.

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

// Auto-pull origin/main before launching, so the cloud auto-fix
// agent's overnight commits land in the user's working copy. Strict
// safety: only fast-forwards on `main` with a clean working tree.
// Anything else (feature branch, uncommitted changes, no network) is
// a soft skip — print why, launch the app anyway. We never want
// updater logic to block the user from running their app.
function tryAutoPull() {
  const git = (args, opts = {}) =>
    spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      shell: false,
      ...opts,
    });

  const branchRes = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchRes.status !== 0) {
    console.log("vault-chat: not a git checkout, skipping auto-pull.");
    return;
  }
  const branch = (branchRes.stdout || "").trim();
  if (branch !== "main") {
    console.log(`vault-chat: on '${branch}', not 'main' — skipping auto-pull.`);
    return;
  }

  const statusRes = git(["status", "--porcelain"]);
  if (statusRes.status === 0 && (statusRes.stdout || "").trim().length > 0) {
    console.log("vault-chat: working tree has local changes — skipping auto-pull.");
    return;
  }

  console.log("vault-chat: pulling origin/main…");
  const pullRes = git(["pull", "--ff-only", "--quiet", "origin", "main"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (pullRes.status !== 0) {
    console.log("vault-chat: auto-pull failed (offline? non-FF?) — launching anyway.");
    return;
  }
  // Concise status: print the new HEAD and the count of new commits if any.
  const headRes = git(["log", "-1", "--oneline"]);
  if (headRes.status === 0) {
    console.log(`vault-chat: at ${(headRes.stdout || "").trim()}`);
  }
}

tryAutoPull();

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
