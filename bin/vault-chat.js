#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere. Dispatches to the real POSIX or Windows launcher.
//
// Node is the one dependency common to all three OSes (we already
// require it as a prereq), so using it as the dispatcher is the
// reliable cross-OS path.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const script = isWindows
  ? join(here, "vault-chat.cmd")
  : join(here, "vault-chat");

const child = spawn(script, process.argv.slice(2), {
  stdio: "inherit",
  shell: isWindows,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("vault-chat: failed to launch:", err.message);
  process.exit(1);
});
