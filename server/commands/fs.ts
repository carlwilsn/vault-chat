// File-system commands. Each mirrors the lib.rs command cited above it.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  appendFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { emitLocal } from "../bus";
import { globFiles, globMatchName } from "./glob";
import type { CommandFn } from "./registry";
import { prepareAgentProjects } from "../context/layout";

const NOTES_DIR = ".vault-chat"; // lib.rs:122
const IGNORE_FILE = ".vaultchatignore"; // lib.rs:114
const DENY_FILE = ".vaultchatdeny"; // lib.rs:121

/** lib.rs:6478 path_touches_dot_git / 6483 git_guard. */
export function gitGuard(path: string): void {
  const p = path.replace(/\\/g, "/");
  if (p.includes("/.git/") || p.endsWith("/.git") || p === ".git") {
    throw `refusing to touch ${path} — the .git folder is the undo system and must not be modified directly`;
  }
}

/** lib.rs:1568 decode_text — BOM-aware UTF-8 / UTF-16 decode. */
export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8Strict(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  return utf8Strict(bytes);
}
function utf8Strict(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch (e) {
    throw `invalid UTF-8: ${(e as Error).message}`;
  }
}

function ioErr(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/** lib.rs:199 load_list_set / 423 read_list_lines_sync — normalised lines. */
function readListLines(vault: string, file: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(join(vault, file), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const n = t.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\\/g, "/");
    if (n) out.push(n);
  }
  return out;
}

/** lib.rs:237 load_humanized_set. */
function readHumanized(vault: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(join(vault, NOTES_DIR, "humanized.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const set = new Set<string>();
  for (const item of v) {
    const rel = typeof item === "string" ? item : item && typeof item === "object" ? (item as any).path : null;
    if (typeof rel !== "string") continue;
    const n = rel.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\\/g, "/");
    if (n) set.add(n);
  }
  return [...set].sort();
}

/** lib.rs:290 is_listed_path — the path or any ancestor is listed. */
function isListed(rel: string, set: Set<string>): boolean {
  if (set.has(rel)) return true;
  for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) {
    if (set.has(rel.slice(0, i))) return true;
  }
  return false;
}

/** lib.rs:175 is_hidden_ext. */
const HIDDEN_EXT = new Set(["pyc", "pyo", "class", "o", "obj", "a", "lib", "rlib", "rmeta", "dll", "so", "dylib", "exe", "bin", "out"]);

type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  depth: number;
  hidden: boolean;
  denied: boolean;
  humanized: boolean;
};

function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.endsWith("\n") ? line : line + "\n");
}

export const fsCommands: Record<string, CommandFn> = {
  // lib.rs:1559
  read_text_file: ({ path }) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw ioErr(e);
    }
    return decodeText(bytes);
  },

  // lib.rs:1591 (emits file-changed like emit_file_changed, lib.rs:110)
  write_text_file: ({ path, contents }) => {
    gitGuard(path);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(contents ?? ""));
    } catch (e) {
      throw ioErr(e);
    }
    emitLocal("file-changed", path);
    return null;
  },

  // lib.rs:1465 — Vec<u8> crosses the Tauri IPC as a JSON number array.
  read_binary_file: ({ path }) => {
    try {
      return Array.from(readFileSync(path));
    } catch (e) {
      throw ioErr(e);
    }
  },

  // lib.rs:1900
  delete_file: ({ path }) => {
    gitGuard(path);
    try {
      const st = statSync(path);
      rmSync(path, { recursive: st.isDirectory(), force: false });
    } catch (e) {
      throw ioErr(e);
    }
    return null;
  },

  // lib.rs:1915 — CRLF-preserving exact-string edit.
  edit_text_file: ({ path, oldString, newString, replaceAll }) => {
    gitGuard(path);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw ioErr(e);
    }
    const hadCrlf = raw.includes("\r\n");
    const contents = hadCrlf ? raw.replace(/\r\n/g, "\n") : raw;
    const needle = String(oldString ?? "").replace(/\r\n/g, "\n");
    const replacement = String(newString ?? "").replace(/\r\n/g, "\n");
    const all = !!replaceAll;
    const count = needle ? contents.split(needle).length - 1 : 0;
    if (count === 0) throw `old_string not found in ${path}`;
    if (!all && count > 1) {
      throw `old_string matches ${count} times in ${path} — provide more context to make it unique, or set replace_all=true`;
    }
    const body = all ? contents.split(needle).join(replacement) : contents.replace(needle, () => replacement);
    writeFileSync(path, hadCrlf ? body.replace(/\n/g, "\r\n") : body);
    emitLocal("file-changed", path);
    return all ? `replaced ${count} occurrence(s) in ${path}` : `edited ${path}`;
  },

  // lib.rs:1964 — files only, newest mtime first.
  glob_files: ({ pattern, cwd }) => {
    let full = String(pattern);
    if (cwd) {
      try {
        if (statSync(cwd).isDirectory()) full = join(cwd, full).replace(/\\/g, "/");
      } catch {
        /* not a dir: pattern used as-is */
      }
    }
    const hits = globFiles(full).map((p) => {
      let m = 0;
      try {
        m = statSync(p).mtimeMs;
      } catch {
        /* vanished */
      }
      return [p.replace(/\\/g, "/"), m] as const;
    });
    hits.sort((a, b) => b[1] - a[1]);
    return hits.map(([p]) => p);
  },

  // lib.rs:1999 grep_files / 2013 grep_files_sync
  grep_files: ({ pattern, path, globFilter, caseInsensitive, maxResults }) => {
    let re: RegExp;
    try {
      re = new RegExp(String(pattern), caseInsensitive ? "i" : "");
    } catch (e) {
      throw ioErr(e);
    }
    if (!existsSync(path)) throw `path does not exist: ${path}`;
    const limit = maxResults ?? 500;
    const results: { path: string; line: number; text: string }[] = [];
    const skip = (name: string) => name.startsWith(".") || name === "node_modules" || name === "target";
    const visitFile = (p: string): boolean => {
      const name = p.split(/[\\/]/).pop() ?? "";
      if (globFilter && !globMatchName(globFilter, name)) return false;
      let content: string;
      try {
        const buf = readFileSync(p);
        content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        return false; // binary / unreadable: skipped like read_to_string's Err
      }
      const lines = content.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.replace(/\r$/, "");
        if (re.test(line)) {
          results.push({ path: p.replace(/\\/g, "/"), line: i + 1, text: line });
          if (results.length >= limit) return true;
        }
      }
      return false;
    };
    const walk = (dir: string): boolean => {
      let ents: Dirent[];
      try {
        ents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of ents) {
        if (skip(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (walk(full)) return true;
        } else if (e.isFile()) {
          if (visitFile(full)) return true;
        }
      }
      return false;
    };
    if (statSync(path).isDirectory()) walk(path);
    else visitFile(path);
    return results;
  },

  // lib.rs:2400
  list_dir: ({ path }) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw `not a directory: ${path}`;
    }
    if (!st.isDirectory()) throw `not a directory: ${path}`;
    const out: FileEntry[] = [];
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(path, e.name).replace(/\\/g, "/");
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          /* dangling */
        }
      }
      out.push({ path: full, name: e.name, is_dir: isDir, depth: 0, hidden: false, denied: false, humanized: false });
    }
    out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || cmpLower(a.name, b.name));
    return out;
  },

  // lib.rs:307 list_markdown_files / 313 list_markdown_files_sync. The git
  // badge fields (git_branch / git_dirty_count / git_warn) are UI-only and
  // omitted headless.
  list_markdown_files: ({ vault }) => {
    let st;
    try {
      st = statSync(vault);
    } catch {
      throw `Not a directory: ${vault}`;
    }
    if (!st.isDirectory()) throw `Not a directory: ${vault}`;
    const ignored = new Set(readListLines(vault, IGNORE_FILE));
    const denied = new Set(readListLines(vault, DENY_FILE));
    const humanized = new Set(readHumanized(vault));
    const out: FileEntry[] = [];
    const walk = (dir: string, depth: number) => {
      let ents: Dirent[];
      try {
        ents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || cmpLower(a.name, b.name));
      for (const e of ents) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "target") continue;
        const full = join(dir, e.name);
        const isDir = e.isDirectory();
        if (!isDir) {
          const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "";
          if (HIDDEN_EXT.has(ext)) continue;
        }
        const rel = relative(vault, full).replace(/\\/g, "/");
        out.push({
          path: full.replace(/\\/g, "/"),
          name: e.name,
          is_dir: isDir,
          depth,
          hidden: isListed(rel, ignored),
          denied: isListed(rel, denied),
          humanized: humanized.has(rel),
        });
        if (isDir) walk(full, depth + 1);
      }
    };
    walk(vault, 0);
    return out;
  },

  // lib.rs prepare_agent_projects (agent_projects.rs): projects out of .vault-chat/, agent-projects/ hidden once
  prepare_agent_projects: ({ vault }) => prepareAgentProjects(vault),
  // lib.rs:668
  read_deny_lines: ({ vault }) => readListLines(vault, DENY_FILE),
  // lib.rs:732
  read_humanized: ({ vault }) => readHumanized(vault),

  // lib.rs:1617
  append_debug_log: ({ vaultPath, text }) => {
    const p = join(vaultPath, ".vault-chat", "app-log.txt");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, String(text ?? ""));
    return null;
  },

  // lib.rs:893
  client_event_append: ({ vault, line }) => {
    appendLine(join(vault, NOTES_DIR, "client-events.jsonl"), String(line));
    return null;
  },

  // lib.rs:846
  notes_read: ({ vault }) => {
    const p = join(vault, NOTES_DIR, "notes.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim());
  },
  // lib.rs:864
  notes_append: ({ vault, line }) => {
    appendLine(join(vault, NOTES_DIR, "notes.jsonl"), String(line));
    return null;
  },
  // lib.rs:917
  notes_write_all: ({ vault, lines }) => {
    const dir = join(vault, NOTES_DIR);
    mkdirSync(dir, { recursive: true });
    let body = (lines as string[]).join("\n");
    if (body && !body.endsWith("\n")) body += "\n";
    writeFileSync(join(dir, "notes.jsonl"), body);
    return null;
  },
};

function cmpLower(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
