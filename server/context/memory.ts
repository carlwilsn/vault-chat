// Memory, after reports/Project memory SOTA research.md: plain markdown files the agent keeps
// itself with its ordinary file tools, Claude Code style. No memory tool, no database, nothing
// in the background.
//
//   global   .vault-chat/MEMORY.md                       about 200 lines (25 KB) loaded
//   project  agent-projects/<slug>/project.md            Carl's instructions on top, the
//            under its `## Memory` heading                agent's dated lines (about 60)
//
// Both reach a thread through the per-turn prefix that is re-sent only when it changed
// (builder.ts turnSections; the engine keeps what each thread last got), so Carl's edits, or
// another thread's, reach a running thread on its next turn. Another project's memory is never
// loaded anywhere: threads outside a project get the list of projects with each memory's path.
//
// A project may name a main folder (`folder:` in project.md's front matter, vault-relative): its
// thread runs pi with that folder as the working directory, so pi loads the folder's AGENTS.md
// itself (and the vault's, walking up). Only a folder inside the vault: the sandbox lets the
// agent write there, and pi walks up to the vault's AGENTS.md.
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readOr } from "./files";

export const MEMORY_REL = ".vault-chat/MEMORY.md";
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_CHARS = 25_000;
export const PROJECT_MEMORY_MAX_LINES = 60;
/** At this share of a cap a near-cap reminder goes with the file. */
export const NEAR_CAP = 0.8;

export function memoryPath(vault: string): string {
  return resolve(vault, MEMORY_REL);
}

const lines = (s: string) => (s.trim() ? s.trim().split(/\r?\n/).length : 0);

/** The global memory as loaded (its first 200 lines / 25 KB) and a near-cap reminder, or null when empty. */
export function loadedMemory(vault: string): { text: string; note: string | null; lines: number } | null {
  const raw = readOr(memoryPath(vault)).trim();
  if (!raw) return null;
  const all = raw.split(/\r?\n/);
  let text = all.slice(0, MEMORY_MAX_LINES).join("\n");
  if (text.length > MEMORY_MAX_CHARS) text = text.slice(0, MEMORY_MAX_CHARS);
  const cut = text.length < raw.length;
  return {
    text: cut ? `${text}\n[… the rest of ${MEMORY_REL} is not loaded: it is over its cap]` : text,
    note: memoryNote(raw),
    lines: all.length,
  };
}

/** The near-cap reminder for MEMORY.md's text (Claude Code's: merge, drop stale lines), or null. */
export function memoryNote(raw: string): string | null {
  const n = lines(raw);
  if (n >= MEMORY_MAX_LINES * NEAR_CAP || raw.length >= MEMORY_MAX_CHARS * NEAR_CAP) {
    return `${MEMORY_REL} is at ${n} of ${MEMORY_MAX_LINES} lines (${Math.round(raw.length / 1000)} of ${MEMORY_MAX_CHARS / 1000} KB): merge related lines and drop stale ones; past the cap the rest is not loaded.`;
  }
  return null;
}

/** The lines under project.md's `## Memory` heading (to the next `## `). */
export function projectMemoryLines(projectMd: string): string[] {
  const m = /^##\s+Memory\s*$/im.exec(projectMd);
  if (!m) return [];
  const rest = projectMd.slice(m.index + m[0].length);
  const end = /^##\s+/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).split(/\r?\n/).filter((l) => l.trim());
}

/** The near-cap reminder for a project.md (its `## Memory` lines, the file's loaded size), or null. */
export function projectMemoryNote(projectMd: string, rel: string, maxChars: number): string | null {
  const n = projectMemoryLines(projectMd).length;
  const parts: string[] = [];
  if (n >= PROJECT_MEMORY_MAX_LINES * NEAR_CAP) parts.push(`its ## Memory is at ${n} of ${PROJECT_MEMORY_MAX_LINES} lines`);
  if (projectMd.trim().length >= maxChars * NEAR_CAP) parts.push(`the file is at ${Math.round(projectMd.trim().length / 100) / 10}k of ${maxChars / 1000}k characters loaded`);
  return parts.length ? `${rel}: ${parts.join(", and ")}: merge related memory lines and drop stale ones (never Carl's instructions above ## Memory).` : null;
}

/** project.md's front matter `folder:` (vault-relative), or null. */
export function folderOf(projectMd: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(projectMd);
  if (!fm) return null;
  const m = /^folder:\s*(.+?)\s*$/m.exec(fm[1]!);
  if (!m) return null;
  const v = m[1]!.replace(/^["']|["']$/g, "").trim();
  return v || null;
}

/**
 * A project's main folder as a working directory: absolute, inside the vault, an existing
 * folder. `error` says why a named folder can't be used (the thread then stays in the vault).
 */
export function projectFolder(vault: string, projectMd: string): { abs: string; rel: string } | { error: string } | null {
  const want = folderOf(projectMd);
  if (!want) return null;
  const abs = resolve(vault, want);
  const rel = relative(resolve(vault), abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: `the main folder "${want}" is not inside the vault (only a folder in the vault can be a project's working folder)` };
  try {
    if (!statSync(abs).isDirectory()) return { error: `the main folder "${want}" is not a folder` };
  } catch {
    return { error: `the main folder "${want}" does not exist` };
  }
  return { abs, rel };
}
