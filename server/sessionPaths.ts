// pi remembers where a session ran: the first line of every session file is its header, {"type":"session", "cwd": …},
// and pi refuses to resume one whose stored cwd does not exist ("Stored session working directory does not exist").
// The engine's own record of a thread (<pi>/instr/<threadId>.json) holds the same cwd. So when a vault or a project
// moves (server/masterMigrate.ts switch/back), both are rewritten, old prefix → new prefix,
// in both directions; and the engine's resume falls back to the thread's current folder when the stored one is gone
// or hidden by the sandbox (server/engine/pi/backend.ts resumeThread), so a missed rewrite never fails a turn.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { renameRetry } from "./atomic";

const inside = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};

/** `p` with its `from` prefix replaced by `to`; null when `p` is not under `from`. */
export function movePrefix(p: string, from: string, to: string): string | null {
  if (typeof p !== "string" || !p || !isAbsolute(p)) return null;
  const a = resolve(p);
  const f = resolve(from);
  if (!inside(a, f)) return null;
  const rest = relative(f, a);
  const out = rest ? join(resolve(to), rest) : resolve(to);
  // Keep the separators the file had (the box's are "/").
  return p.includes("/") && !p.includes("\\") ? out.split(sep).join("/") : out;
}

/** A session file's header (its first line), or null. */
export function sessionHeader(file: string): { cwd?: string; [k: string]: unknown } | null {
  let fd: string;
  try {
    fd = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const nl = fd.indexOf("\n");
  try {
    const h = JSON.parse(nl < 0 ? fd : fd.slice(0, nl));
    return h && h.type === "session" ? h : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(file + ".tmp", text);
  renameRetry(file + ".tmp", file);
}

/** Set a session file's header cwd (the rest of the file byte for byte). False when it has no header. */
export function setSessionCwd(file: string, cwd: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const nl = text.indexOf("\n");
  let h: any;
  try {
    h = JSON.parse(nl < 0 ? text : text.slice(0, nl));
  } catch {
    return false;
  }
  if (!h || h.type !== "session") return false;
  if (h.cwd === cwd) return true;
  h.cwd = cwd;
  writeAtomic(file, JSON.stringify(h) + (nl < 0 ? "\n" : text.slice(nl)));
  return true;
}

export type Rewritten = { sessions: number; records: number; files: string[] };

/**
 * Every session header (`*.jsonl` directly in each sessions folder) and every thread record (`*.json` in each instr
 * folder) whose paths lie under `from`: rewritten under `to`. Idempotent; a file with nothing under `from` is not
 * touched. Returns what changed.
 */
export function rewriteSessionPaths(o: { sessions: string[]; instr: string[]; from: string; to: string }): Rewritten {
  const out: Rewritten = { sessions: 0, records: 0, files: [] };
  const list = (d: string, ext: string) => {
    try {
      return readdirSync(d)
        .filter((n) => n.endsWith(ext))
        .map((n) => join(d, n))
        .filter((p) => statSync(p).isFile());
    } catch {
      return [];
    }
  };
  for (const d of o.sessions) {
    for (const f of list(d, ".jsonl")) {
      const h = sessionHeader(f);
      const next = h && typeof h.cwd === "string" ? movePrefix(h.cwd, o.from, o.to) : null;
      if (!next || next === h!.cwd) continue;
      if (setSessionCwd(f, next)) {
        out.sessions++;
        out.files.push(f);
      }
    }
  }
  for (const d of o.instr) {
    for (const f of list(d, ".json")) {
      let j: any;
      try {
        j = JSON.parse(readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      if (!j || typeof j !== "object") continue;
      let changed = false;
      for (const k of Object.keys(j)) {
        const next = typeof j[k] === "string" ? movePrefix(j[k], o.from, o.to) : null;
        if (next && next !== j[k]) {
          j[k] = next;
          changed = true;
        }
      }
      if (!changed) continue;
      writeAtomic(f, JSON.stringify(j));
      out.records++;
      out.files.push(f);
    }
  }
  return out;
}

/** The engine's sessions and thread-record folders under a server state folder: the main vault's and every other
 *  vault's (<state>/vaults/<name>/pi). */
export function stateSessionDirs(stateDir: string): { sessions: string[]; instr: string[] } {
  const sessions = [join(stateDir, "pi", "sessions")];
  const instr = [join(stateDir, "pi", "instr")];
  try {
    for (const n of readdirSync(join(stateDir, "vaults"))) {
      sessions.push(join(stateDir, "vaults", n, "pi", "sessions"));
      instr.push(join(stateDir, "vaults", n, "pi", "instr"));
    }
  } catch {
    /* one vault */
  }
  return { sessions: sessions.filter((d) => existsSync(d)), instr: instr.filter((d) => existsSync(d)) };
}

/**
 * Before a resume: a stored cwd that no longer resolves (gone, or under a root the sandbox empties) is replaced by
 * the thread's folder now. True when the header was rewritten.
 */
export function healSessionCwd(file: string, cwd: string, hiddenRoots: string[] = []): boolean {
  const h = sessionHeader(file);
  const stored = h && typeof h.cwd === "string" ? h.cwd : null;
  if (!stored || stored === cwd) return false;
  const gone = !existsSync(stored) || hiddenRoots.some((r) => inside(resolve(stored), resolve(r)) && !inside(resolve(cwd), resolve(stored)));
  if (!gone) return false;
  return setSessionCwd(file, cwd);
}
