#!/usr/bin/env node
// Cross-platform entry point for the `vault-chat` command. Wired into
// npm via package.json's "bin" field so `npm link` exposes it on PATH
// everywhere.
//
// Every launch: spawn `tauri dev` detached with output redirected to
// the app's dev.log, tail the log, and exit when cargo prints its
// `Running \`target/…\`` line (the moment the app window boots). The
// terminal returns, tauri keeps running. Pass --foreground to keep
// everything inline instead.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
} else {
  // Truncate log so prior runs' ready-marker doesn't match this session.
  writeFileSync(logPath, "");
  let child;
  if (isWindows) {
    // Node's `detached: true` on Windows forces a new console that
    // `windowsHide` can't reliably suppress (libuv sets DETACHED_PROCESS
    // without SW_HIDE reaching cmd's window). Go through PowerShell's
    // Start-Process, which writes SW_HIDE into STARTUPINFO before
    // CreateProcess — this is the only path that truly runs headless.
    const psCmd =
      `Start-Process -WindowStyle Hidden -WorkingDirectory '${repo}' ` +
      `-FilePath 'cmd.exe' ` +
      `-ArgumentList '/c','npm run tauri dev > "${logPath}" 2>&1'`;
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCmd],
      { stdio: "ignore", windowsHide: true, detached: true }
    );
  } else {
    const logFd = openSync(logPath, "a");
    child = spawn(npm, ["run", "tauri", "dev"], {
      cwd: repo,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  }
  child.unref();

  console.log(`vault-chat: starting — logs ${logPath}`);

  const statsPath = join(appDataDir, "launch-stats.json");
  let priorDurationSec = null;
  try {
    const stats = JSON.parse(readFileSync(statsPath, "utf8"));
    if (typeof stats.lastDurationSec === "number" && stats.lastDurationSec > 0) {
      priorDurationSec = stats.lastDurationSec;
    }
  } catch {}

  const start = Date.now();
  const timeoutMs = 30 * 60 * 1000;
  const readyMarker = /Running `target[\/\\]/;
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let tick = 0;
  let lastLineLen = 0;

  const fmtTime = (sec) => {
    sec = Math.max(0, Math.round(sec));
    return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
  };
  const makeBar = (pct, width = 20) => {
    const filled = Math.round((pct / 100) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  };

  const iv = setInterval(() => {
    let log = "";
    try { log = readFileSync(logPath, "utf8"); } catch {}

    if (readyMarker.test(log)) {
      clearInterval(iv);
      const durationSec = Math.floor((Date.now() - start) / 1000);
      try {
        writeFileSync(statsPath, JSON.stringify({ lastDurationSec: durationSec }));
      } catch {}
      process.stdout.write("\r" + " ".repeat(lastLineLen) + "\r");
      console.log(`vault-chat: app launching (${fmtTime(durationSec)}). Terminal is yours.`);
      process.exit(0);
    }

    if (Date.now() - start > timeoutMs) {
      clearInterval(iv);
      process.stdout.write("\r" + " ".repeat(lastLineLen) + "\r");
      console.log(`vault-chat: taking >30min, detaching. Check ${logPath}`);
      process.exit(0);
    }

    // Most recent informative line drives the status text.
    const lines = log.split(/\r?\n/);
    let status = "starting";
    let finishedBuild = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      const m = l.match(/^Compiling\s+(\S+)/);
      if (m) { status = `compiling ${m[1]}`; break; }
      if (l.startsWith("Finished")) { status = "build finished, booting app"; finishedBuild = true; break; }
      if (l.includes("VITE v")) { status = "vite ready"; break; }
    }

    const elapsedSec = (Date.now() - start) / 1000;
    let pct, etaText;
    if (priorDurationSec) {
      pct = Math.min(99, Math.floor((elapsedSec / priorDurationSec) * 100));
      if (finishedBuild) pct = Math.max(pct, 95);
      etaText = `${fmtTime(elapsedSec)} / ~${fmtTime(priorDurationSec)}`;
    } else {
      // First run — estimate via compiled-crate count against a typical ~150 total.
      const compileCount = (log.match(/^\s*Compiling\s/gm) ?? []).length;
      pct = Math.min(finishedBuild ? 95 : 90, Math.floor((compileCount / 150) * 100));
      etaText = `${fmtTime(elapsedSec)} / ~10-15m (first run)`;
    }

    const bar = makeBar(pct);
    const line = `${spinner[tick++ % spinner.length]} ${status}  [${bar}] ${pct.toString().padStart(2)}%  ${etaText}`;
    process.stdout.write("\r" + line.padEnd(lastLineLen, " "));
    lastLineLen = line.length;
  }, 500);
}
