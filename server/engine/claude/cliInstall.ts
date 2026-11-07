// Putting the pinned Claude Code CLI where a box can run it.
//
// The deployed box installs a bundle and assets, never node_modules, so the CLI
// the Agent SDK pins (@anthropic-ai/claude-agent-sdk-<platform>-<arch>) exists
// only where the repo does — development and the gates. Until this, a real box
// had no Claude Code unless somebody copied one in by hand, which is exactly the
// "a fresh install works without anyone" hole.
//
// findClaude already looks for <stateDir>/claude/cli/claude first, and already
// knows how to run a generic Linux binary through this Node's own glibc loader
// on NixOS (install.ts). So placing the CLI is a verified copy and nothing more:
// no wrapper is written here, because findClaude writes the one it needs.
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { elfInterpreter, findClaude, probe, type ClaudeInstall } from "./install";

/** Where a placed CLI lives, the one path findClaude prefers. */
export function placedCliPath(stateDir: string): string {
  return join(stateDir, "claude", "cli", "claude");
}

/**
 * Copy a Claude Code executable to the place a box reads it from, after proving
 * this machine can actually run it — directly, or through the loader on a box
 * whose Node is not dynamically linked the usual way. A file that cannot be run
 * is never installed: a box with no Claude Code at all is a box that still
 * answers, while a box with a broken one fails every turn.
 */
export function placeCli(o: { from: string; stateDir: string; env?: NodeJS.ProcessEnv }): { install: ClaudeInstall } | { error: string } {
  const from = o.from;
  if (!existsSync(from)) return { error: `no such file: ${from}` };
  if (!statSync(from).isFile()) return { error: `not a file: ${from}` };

  // Prove it runs BEFORE it replaces whatever is already installed.
  let version = probe(from);
  if (!version) {
    const loader = elfInterpreter(process.execPath);
    if (loader && existsSync(loader)) version = probe(loader, [from]);
  }
  if (!version) return { error: `${from} did not answer --version, directly or through this Node's loader` };

  const dest = placedCliPath(o.stateDir);
  mkdirSync(join(o.stateDir, "claude", "cli"), { recursive: true });
  // Write beside it and rename, so a box that is running keeps the CLI it has
  // until the new one is whole.
  const tmp = `${dest}.incoming`;
  try {
    rmSync(tmp, { force: true });
    copyFileSync(from, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { error: `could not install ${from} to ${dest}: ${(e as Error).message}` };
  }

  // Ask the resolver, not ourselves: what matters is that the next boot finds it.
  const found = findClaude({ stateDir: o.stateDir, env: { ...(o.env ?? {}), VC_CLAUDE_BIN: "" } });
  if ("error" in found) return { error: `installed ${dest}, but it is still not runnable: ${found.tried.join("; ")}` };
  return { install: found.install };
}

/**
 * `vault-chat-server.mjs install-claude-cli <path> [stateDir]` — what the box
 * updater calls once a release is unpacked, and what the desktop app calls with
 * the CLI it ships, so neither needs to know where the file belongs or how a
 * NixOS box runs it.
 */
export function installClaudeCli(argv: string[], stateDirDefault: string): number {
  const from = argv[0];
  if (!from) {
    console.error("install-claude-cli: give the path of the Claude Code executable to install");
    return 2;
  }
  const stateDir = argv[1] || stateDirDefault;
  const r = placeCli({ from, stateDir });
  if ("error" in r) {
    console.error(`install-claude-cli: ${r.error}`);
    return 1;
  }
  console.log(`install-claude-cli: Claude Code ${r.install.version} at ${r.install.cli} (${r.install.source})`);
  return 0;
}
