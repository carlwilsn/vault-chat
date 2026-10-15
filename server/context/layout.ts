// Projects as a vault folder: `<vault>/agent-projects/<slug>/` (src/agentProjects.ts
// names it). Moving projects out of `.vault-chat/projects/`, and hiding the folder
// once. Plain node:fs only — the preview runs this (as the `prepare_agent_projects`
// command, server/commands/fs.ts) on its in-memory file system; lib.rs's
// agent_projects.rs is the app's copy of the same moves.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HIDE_DEFAULTS_FILE, HIDE_FILE, LEGACY_PROJECTS_DIR, PROJECTS_DIR, hideOnce } from "../../src/agentProjects";

export type Prepared = { moved: string[]; kept: string[]; hidden: boolean };

/** `<vault>/agent-projects` (or a path under it). */
export function projectsPath(v: string, ...parts: string[]): string {
  return join(v, PROJECTS_DIR, ...parts);
}

const isDir = (p: string) => {
  try {
    return !!statSync(p)?.isDirectory();
  } catch {
    return false;
  }
};

const readOr = (p: string) => {
  try {
    return readFileSync(p, "utf8") as string;
  } catch {
    return "";
  }
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function removeIfEmpty(dir: string): void {
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

/**
 * Move `<vault>/.vault-chat/projects/*` to `<vault>/agent-projects/*`. Idempotent;
 * never overwrites: a project not there yet is renamed whole, otherwise file by
 * file — a file the new place lacks moves, an identical one is dropped, a
 * different one stays where it was (reported in `kept`). Folders emptied are
 * removed. The sync commits the move; the other machine, moving the same files
 * the same way, makes the same rename, so the merge is clean.
 */
export function migrateLegacyProjects(v: string, log: (m: string) => void = (m) => console.log(`[projects] ${m}`)): { moved: string[]; kept: string[] } {
  const out = { moved: [] as string[], kept: [] as string[] };
  const legacy = join(v, LEGACY_PROJECTS_DIR);
  if (!isDir(legacy)) return out;
  const move = (src: string, dst: string, rel: string) => {
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      out.moved.push(rel);
    } else if (isDir(src) && isDir(dst)) {
      for (const n of readdirSync(src) as string[]) move(join(src, n), join(dst, n), `${rel}/${n}`);
      removeIfEmpty(src);
    } else if (!isDir(src) && !isDir(dst) && sameBytes(readFileSync(src), readFileSync(dst))) {
      rmSync(src);
      out.moved.push(`${rel} (already there)`);
    } else out.kept.push(rel);
  };
  for (const n of (readdirSync(legacy) as string[]).sort()) move(join(legacy, n), projectsPath(v, n), n);
  removeIfEmpty(legacy);
  if (out.moved.length) log(`${v}: moved ${LEGACY_PROJECTS_DIR}/ → ${PROJECTS_DIR}/: ${out.moved.join(", ")}`);
  if (out.kept.length) log(`${v}: left in ${LEGACY_PROJECTS_DIR}/ (a different file is already in ${PROJECTS_DIR}/): ${out.kept.join(", ")}`);
  return out;
}

/**
 * Hide `agent-projects` in the vault's hide list the first time the folder
 * exists, and record that in `.vault-chat/hidden-by-default`; once recorded it
 * is never hidden again (Carl unhid it). True when it was hidden now.
 */
export function ensureProjectsHidden(v: string): boolean {
  if (!isDir(projectsPath(v))) return false;
  const next = hideOnce(PROJECTS_DIR, readOr(join(v, HIDE_FILE)), readOr(join(v, HIDE_DEFAULTS_FILE)));
  if (!next) return false;
  if (next.hide !== null) writeFileSync(join(v, HIDE_FILE), next.hide);
  mkdirSync(dirname(join(v, HIDE_DEFAULTS_FILE)), { recursive: true });
  writeFileSync(join(v, HIDE_DEFAULTS_FILE), next.record);
  return next.hide !== null;
}

/** Both (lib.rs prepare_agent_projects). Throws on an I/O error. */
export function prepareAgentProjects(v: string): Prepared {
  const r = migrateLegacyProjects(v);
  return { ...r, hidden: ensureProjectsHidden(v) };
}

/** Both, cheaply, before the server reads projects: a stat when there is nothing to move;
 *  the hide list is read until the folder exists and has been seen once. Never throws. */
const hiddenSeen = new Set<string>();
export function prepareProjects(v: string): void {
  try {
    if (existsSync(join(v, LEGACY_PROJECTS_DIR))) migrateLegacyProjects(v);
    if (!hiddenSeen.has(v) && isDir(projectsPath(v))) {
      ensureProjectsHidden(v);
      hiddenSeen.add(v);
    }
  } catch (e) {
    console.warn(`[projects] ${v}: ${(e as Error).message}`);
  }
}
