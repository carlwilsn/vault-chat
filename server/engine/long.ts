// Long-run controls the agent cannot move: a project's check (the command that
// gates Done), its progress metric, its budget. They live in
// <vault>/.vault-chat/local/projects/<slug>/ — read-only inside the sandbox, so
// only the server (Carl's API, or the agent's one-time SetCheck through the
// server) writes them. A command is pinned when set: its text and every file it
// names are hashed, and a run whose command or scripts changed since is refused.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeAtomic } from "../atomic";

/** A pinned command: the check, or the progress metric. */
export type CommandSpec = {
  command: string;
  /** Pass when the output matches (the check); otherwise exit 0 passes. */
  passRegex?: string;
  timeoutS?: number;
  /** sha256 of the command text, and of each file it names (absolute path → hash). */
  cmdHash: string;
  files: Record<string, string>;
  /** Who set it: Carl (API), the agent (SetCheck, once), or project.md's own block. */
  source: "carl" | "agent" | "project.md";
  setAt: number;
};

export type MetricSpec = CommandSpec & {
  /** Minutes between samples while the project has work going (default 15). */
  everyMin?: number;
  /** Hours of active work without a rise before the plateau alert (default 6). */
  windowH?: number;
};

export type ProjectLong = {
  check?: CommandSpec;
  metric?: MetricSpec;
  /** USD cap over the project's conversations (Carl's). */
  budgetUsd?: number;
  /** The plateau alert, sent once per best value. */
  plateau?: { best: number; alertedAt: number };
  /** Models for workers: cheap by default, strong for a task's last attempt after `escalateAfter` failures. */
  models?: { cheap?: string; strong?: string; escalateAfter?: number };
  /** Attempts before a task is given up (default 3). */
  maxAttempts?: number;
};

export function longDir(vault: string, slug: string): string {
  return join(vault, ".vault-chat", "local", "projects", slug);
}

export function readLong(vault: string, slug: string): ProjectLong {
  try {
    const v = JSON.parse(readFileSync(join(longDir(vault, slug), "long.json"), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function writeLong(vault: string, slug: string, fn: (s: ProjectLong) => ProjectLong | void): ProjectLong {
  const dir = longDir(vault, slug);
  mkdirSync(dir, { recursive: true });
  const cur = readLong(vault, slug);
  const next = fn(cur) ?? cur;
  writeAtomic(join(dir, "long.json"), JSON.stringify(next, null, 1), join(dir, `long.json.${process.pid}.tmp`));
  return next;
}

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** The files a command names (relative to cwd or absolute), that exist: scripts, configs. At most 20, each under 50 MB. */
export function namedFiles(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const tok of command.split(/[\s;&|()<>"'`=,]+/)) {
    if (!tok || tok.startsWith("-") || out.length >= 20) continue;
    const p = isAbsolute(tok) ? tok : resolve(cwd, tok);
    try {
      const st = statSync(p);
      if (st.isFile() && st.size < 50 * 1024 * 1024 && !out.includes(p)) out.push(p);
    } catch {
      /* not a file */
    }
  }
  return out;
}

function hashFile(p: string): string | null {
  try {
    return sha(readFileSync(p));
  } catch {
    return null;
  }
}

export function pinCommand(o: { command: string; passRegex?: string; timeoutS?: number; cwd: string; source: CommandSpec["source"] }): CommandSpec {
  const command = o.command.trim();
  const files: Record<string, string> = {};
  for (const f of namedFiles(command, o.cwd)) files[f] = hashFile(f)!;
  return {
    command,
    ...(o.passRegex ? { passRegex: o.passRegex } : {}),
    ...(o.timeoutS ? { timeoutS: o.timeoutS } : {}),
    cmdHash: sha(command),
    files,
    source: o.source,
    setAt: Date.now(),
  };
}

/** Null when the pinned command and its files are as they were set; else what changed. `declared`: project.md's block now (for a check set from it). */
export function tampered(spec: CommandSpec, declared?: string | null): string | null {
  if (sha(spec.command) !== spec.cmdHash) return "the stored command does not match its hash";
  if (spec.source === "project.md" && declared != null && declared.trim() !== spec.command) return "the command in project.md changed since the check was set";
  for (const [f, h] of Object.entries(spec.files)) {
    const now = hashFile(f);
    if (now === null) return `${f} is gone since the check was set`;
    if (now !== h) return `${f} changed since the check was set`;
  }
  return null;
}

/** The first fenced block under `## <heading>` in a markdown doc, and an optional `pass_regex: …` line there. */
export function declaredCommand(doc: string, heading: string): { command: string; passRegex?: string } | null {
  const lines = doc.split(/\r?\n/);
  const want = heading.trim().toLowerCase();
  let i = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === want);
  if (i < 0) return null;
  let command: string | null = null;
  let passRegex: string | undefined;
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,2}\s/.test(l)) break;
    const pr = /^\s*pass_regex:\s*`?(.+?)`?\s*$/i.exec(l);
    if (pr) passRegex = pr[1];
    if (command === null && /^\s*```/.test(l)) {
      const body: string[] = [];
      for (i = i + 1; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      command = body.join("\n").trim();
    }
  }
  return command ? { command, ...(passRegex ? { passRegex } : {}) } : null;
}

export type RunEnv = {
  /** bubblewrap argv ending in "--" (the jobs' sandbox), or null. */
  wrap: string[] | null;
  /** The whole environment the command gets (nothing of the server's leaks). */
  env: Record<string, string>;
};

export type RunResult = { ok: boolean; code: number | null; out: string; timedOut: boolean; refused?: string };

/** Tail of a command's output, for the agent and the verifier. */
export function tailOf(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Run a command from the server: sandboxed like jobs, with a time limit, its output captured. */
export function runCommand(r: RunEnv, o: { command: string; cwd: string; timeoutMs: number; passRegex?: string; extraEnv?: Record<string, string> }): Promise<RunResult> {
  const unsafeOk = process.platform !== "linux" || process.env.VC_PI_UNSAFE === "1";
  if (!r.wrap && !unsafeOk) return Promise.resolve({ ok: false, code: null, out: "", timedOut: false, refused: "no sandbox (bubblewrap) on the box" });
  const env = { ...r.env, ...(o.extraEnv ?? {}) };
  if (!r.wrap && process.platform === "win32") {
    // Windows (development): cmd needs these to start at all.
    for (const k of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]) if (process.env[k] && !env[k]) env[k] = process.env[k]!;
    if (!env.PATH && !env.Path) env.PATH = process.env.PATH ?? process.env.Path ?? "";
  }
  return new Promise((done) => {
    const child = r.wrap
      ? spawn(r.wrap[0]!, ["--die-with-parent", ...r.wrap.slice(1), "sh", "-c", o.command], { cwd: o.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(o.command, { cwd: o.cwd, env, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 256_000) out = out.slice(-128_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, o.timeoutMs);
    const finish = (code: number | null, err?: string) => {
      clearTimeout(timer);
      if (err) out += `\n${err}`;
      const passed = !timedOut && (o.passRegex ? safeRegex(o.passRegex).test(out) : code === 0);
      done({ ok: passed, code, out, timedOut });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

function safeRegex(s: string): RegExp {
  try {
    return new RegExp(s, "m");
  } catch {
    return /$^/; // matches nothing
  }
}

/** Keep the last run's full output where the verifier can read it. */
export function saveRunLog(vault: string, slug: string, name: string, r: RunResult, command: string): string {
  const dir = longDir(vault, slug);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}-last.log`);
  writeAtomic(p, `$ ${command}\n${r.out}\n[exit ${r.code ?? "none"}${r.timedOut ? ", timed out" : ""}]\n`, `${p}.${process.pid}.tmp`);
  return p;
}

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial line */
    }
  }
  return out;
}
