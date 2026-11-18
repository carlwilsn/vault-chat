/** macOS: what a Finder/Dock-launched app's server needs from its environment.
 *
 * A GUI app on macOS starts with launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin): no Homebrew, no ~/.local/bin, so
 * the server found no npm/npx/python3/uv/gh, and `git` was /usr/bin/git, a stub that pops up Apple's "install the
 * Command Line Tools" dialog when they are missing. At startup the server takes its user's login-shell PATH (with a
 * time limit), adds the usual folders, and, when the Command Line Tools are missing and no other git is there,
 * puts a `git` first on PATH that only says so: no dialog from anything the server or its agent runs, and Health
 * says `git: "needs-command-line-tools"`. Linux and Windows are left as they are.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARK = "__VC_PATH__";

/** The PATH out of the login shell's output, between our markers (rc files may print other things). */
export function parseLoginPath(out: string): string[] {
  const i = out.indexOf(MARK), j = out.indexOf(MARK, i + MARK.length);
  if (i < 0 || j < 0) return [];
  return out.slice(i + MARK.length, j).split(":").map((s) => s.trim()).filter((s) => s.startsWith("/"));
}

/** The user's login-shell PATH, or [] when the shell fails or takes longer than `timeoutMs`. */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 4000): string[] {
  const r = spawnSync(shell, ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
    stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8",
  });
  return r.error ? [] : parseLoginPath(r.stdout ?? "");
}

/** Folders a Mac's tools live in that launchd's PATH leaves out. */
export function fixedMacDirs(home = homedir()): string[] {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", join(home, ".local", "bin")];
}

/** Login PATH first, then the fixed folders (Homebrew before /usr/bin, so its git wins over the stub), then what
 * the process already had; each folder once, in that order. */
export function mergePath(login: string[], fixed: string[], current: string): string {
  const out: string[] = [];
  for (const d of [...login, ...fixed, ...current.split(delimiter)]) if (d && !out.includes(d)) out.push(d);
  return out.join(delimiter);
}

export type GitState = "ok" | "missing" | "needs-command-line-tools";

/** First `git` on `path` (not running it: /usr/bin/git may be the stub). */
export function whichGit(path: string, exists = existsSync): string | null {
  for (const d of path.split(delimiter)) if (d && exists(join(d, "git"))) return join(d, "git");
  return null;
}

/** git on a Mac: a git other than /usr/bin/git is real; /usr/bin/git works only with the Command Line Tools
 * (or Xcode), which `xcode-select -p` reports without any dialog. */
export function macGitState(git: string | null, xcodeSelectOk: () => boolean): GitState {
  if (!git) return "missing";
  if (git !== "/usr/bin/git") return "ok";
  return xcodeSelectOk() ? "ok" : "needs-command-line-tools";
}

const xcodeSelectOk = () => spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 5000 }).status === 0;

export const GIT_STUB = `#!/bin/sh
echo "git is not installed: macOS's Command Line Tools are missing. Install them with: xcode-select --install (or: brew install git)" >&2
exit 127
`;

/** Fix PATH for a Mac GUI launch (no-op elsewhere). `stateDir` holds the stand-in git when one is needed. */
export function prepareMacEnv(stateDir: string, platform = process.platform): void {
  if (platform !== "darwin") return;
  const before = process.env.PATH ?? "";
  process.env.PATH = mergePath(loginShellPath(), fixedMacDirs(), before);
  stubDir = join(stateDir, "git-missing-bin");
  if (macGitStatus() !== "ok") console.error(`[vault-chat-server] git: ${macGitStatus()} (PATH ${process.env.PATH})`);
}

let stubDir: string | null = null;

/** Where git stands now on a Mac; keeps the stand-in git first on PATH exactly while the tools are missing. */
export function macGitStatus(dir = stubDir, xcode = xcodeSelectOk, exists = existsSync): GitState {
  const path = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== dir).join(delimiter);
  const state = macGitState(whichGit(path, exists), xcode);
  if (state === "needs-command-line-tools" && dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "git"), GIT_STUB);
    chmodSync(join(dir, "git"), 0o755);
    process.env.PATH = [dir, path].join(delimiter);
  } else {
    process.env.PATH = path;
  }
  return state;
}
