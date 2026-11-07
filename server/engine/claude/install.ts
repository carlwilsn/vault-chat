// Finding a Claude Code the box can actually run.
//
// The Agent SDK ships the matching CLI in a per-platform package
// (@anthropic-ai/claude-agent-sdk-linux-x64), which is the one we want: its
// version is pinned with the SDK's. On an ordinary distribution it runs as it
// is. On NixOS it does not — it is a dynamically linked generic binary and
// there is no /lib64/ld-linux-x86-64.so.2 — so we run it through the glibc
// loader this very Node process is using, named in a one-line wrapper script
// under the state dir. That needs nothing installed (the spike's patchelf copy
// needed patchelf and 325 MB of duplicate binary).
//
// Last resort: a `claude` already on PATH, whatever version the box has.
import { chmodSync, existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export type ClaudeInstall = {
  /** What to give the SDK as `pathToClaudeCodeExecutable`. */
  cli: string;
  version: string;
  /** How it was found, for health and the boot line. */
  source: "env" | "bundled" | "loader" | "path";
};

/** `claude --version` → its version, or null (it did not run). */
export function probe(cli: string, args: string[] = []): string | null {
  try {
    const r = spawnSync(cli, [...args, "--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout ?? ""}`);
    return r.status === 0 && m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** The dynamic loader an ELF executable names in its PT_INTERP header (null: static, or not an ELF). */
export function elfInterpreter(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(64);
    if (readSync(fd, head, 0, 64, 0) < 64) return null;
    if (head.toString("latin1", 0, 4) !== "\x7fELF" || head[4] !== 2) return null; // ELF64 only
    const phoff = Number(head.readBigUInt64LE(0x20));
    const phentsize = head.readUInt16LE(0x36);
    const phnum = head.readUInt16LE(0x38);
    const phs = Buffer.alloc(phentsize * phnum);
    readSync(fd, phs, 0, phs.length, phoff);
    for (let i = 0; i < phnum; i++) {
      const p = phs.subarray(i * phentsize, (i + 1) * phentsize);
      if (p.readUInt32LE(0) !== 3) continue; // PT_INTERP
      const off = Number(p.readBigUInt64LE(8));
      const size = Number(p.readBigUInt64LE(32));
      if (!size) return null;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, off);
      return buf.toString("latin1").replace(/\0.*$/, "") || null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The CLI the installed SDK brought with it, or null (no platform package for this box). */
export function bundledCli(): string | null {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const bin = join(dirname(require.resolve(`${pkg}/package.json`)), "claude");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** A one-line wrapper that runs `bin` through `loader`, written once under the state dir. */
export function loaderWrapper(dir: string, bin: string, loader: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  // `exec` so signals and the exit code are the CLI's own, and the host's job
  // control still sees one process where it expects one.
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(loader)} ${JSON.stringify(bin)} "$@"\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * The Claude Code this box runs, or null with the reasons each candidate was
 * rejected (the boot logs them; Settings → Agent shows them).
 */
export function findClaude(o: { stateDir: string; env?: NodeJS.ProcessEnv }): { install: ClaudeInstall } | { error: string; tried: string[] } {
  const env = o.env ?? process.env;
  const tried: string[] = [];
  const want = env.VC_CLAUDE_BIN?.trim();
  if (want) {
    const v = probe(want);
    if (v) return { install: { cli: want, version: v, source: "env" } };
    tried.push(`VC_CLAUDE_BIN=${want}: did not answer --version`);
  }
  const bundled = bundledCli();
  if (bundled) {
    const v = probe(bundled);
    if (v) return { install: { cli: bundled, version: v, source: "bundled" } };
    tried.push(`${bundled}: did not run (a generic dynamically linked binary)`);
    // NixOS: run it through the loader this Node process uses.
    const loader = elfInterpreter(process.execPath);
    if (loader && existsSync(loader)) {
      const viaLoader = probe(loader, [bundled]);
      if (viaLoader) return { install: { cli: loaderWrapper(join(o.stateDir, "claude", "bin"), bundled, loader), version: viaLoader, source: "loader" } };
      tried.push(`${loader} ${bundled}: did not answer --version either`);
    } else {
      tried.push("this Node names no dynamic loader, so the bundled binary cannot be run through one");
    }
  } else {
    tried.push(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch} is not installed`);
  }
  const v = probe("claude");
  if (v) return { install: { cli: "claude", version: v, source: "path" } };
  tried.push("claude on PATH: not found, or it did not answer --version");
  return { error: "no Claude Code executable this box can run", tried };
}
