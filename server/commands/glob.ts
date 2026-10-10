// A small glob matcher with the semantics of the Rust `glob` crate the desktop
// uses (lib.rs:1964 glob_files, lib.rs:2030 grep's glob_filter):
//   *  any run of characters except '/'
//   ?  one character except '/'
//   [abc] / [!abc] character classes
//   ** a whole path component matching zero or more directories
// Leading dots are matched by wildcards (require_literal_leading_dot = false).
import { readdirSync, statSync, type Dirent } from "node:fs";

function classToRegex(body: string): string {
  let neg = false;
  if (body.startsWith("!")) {
    neg = true;
    body = body.slice(1);
  }
  const esc = body.replace(/[\\\]^]/g, (c) => "\\" + c);
  return neg ? `[^/${esc}]` : `[${esc}]`;
}

/** Compile one glob (with '/' separators) to an anchored RegExp. */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  const p = pattern;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**` as a whole component: (anything/)*
        const atStart = i === 0 || p[i - 1] === "/";
        const atEnd = i + 2 === p.length || p[i + 2] === "/";
        if (atStart && atEnd) {
          if (i + 2 === p.length) {
            re += ".*";
            i += 2;
          } else {
            re += "(?:[^/]*/)*";
            i += 3; // consume "**/"
          }
          continue;
        }
        re += "[^/]*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const close = p.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += classToRegex(p.slice(i + 1, close));
        i = close + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, (m) => "\\" + m);
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Match a single file NAME against a pattern (grep's glob_filter). */
export function globMatchName(pattern: string, name: string): boolean {
  try {
    return globToRegex(pattern).test(name);
  } catch {
    return false;
  }
}

/** Expand a full-path glob to existing FILES. The walk starts at the longest
 * wildcard-free directory prefix. */
export function globFiles(fullPattern: string): string[] {
  const pat = fullPattern.replace(/\\/g, "/");
  const parts = pat.split("/");
  const firstWild = parts.findIndex((s) => /[*?[]/.test(s));
  if (firstWild === -1) {
    try {
      return statSync(pat).isFile() ? [pat] : [];
    } catch {
      return [];
    }
  }
  // "" = relative to the cwd (results stay relative, like the Rust crate).
  const base = parts.slice(0, firstWild).join("/") || (pat.startsWith("/") ? "/" : "");
  const re = globToRegex(pat);
  const recursive = parts.slice(firstWild).some((s) => s === "**") || parts.length - firstWild > 1;
  const maxDepth = parts.slice(firstWild).includes("**") ? Infinity : parts.length - firstWild;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir || ".", { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = dir === "" ? e.name : (dir.endsWith("/") ? dir : dir + "/") + e.name;
      if (e.isDirectory()) {
        if (recursive && depth + 1 < maxDepth && e.name !== ".git") walk(full, depth + 1);
      } else if (re.test(full)) {
        out.push(full);
      }
    }
  };
  walk(base, 0);
  return out;
}
