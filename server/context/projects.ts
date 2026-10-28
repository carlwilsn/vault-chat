// Projects are the machine's, not a vault's (Carl, 2026-10-28: "a vault is my UI thing, projects are general
// machine path stuff"). Every project lives in the projects home (server/projectsHome.ts), the same whatever
// vault is open, on the laptop, the phone and the board:
//
//   <home>/<slug>/project.md   its name (the first `# ` heading), Carl's instructions, then its memory under
//                              `## Memory` (the agent's own lines); rules.md optional, binding like .vault-chat/rules.md
//   <home>/.deleted/           deleted projects (Carl's Delete; RestoreProject brings one back whole)
//
// A project has one thread (src/threads.ts, `project-<slug>`), in the projects home's log; it works in its own
// folder (server/projectFolders.ts), whose AGENTS.md pi loads. Carl makes projects (the app's "+ New project", or
// by asking the agent in so many words: OpenProject, server/projectRoutes.ts); the agent never makes one on its
// own initiative.
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ctxConfig, hasProjectsHome, projectsRoot } from "./config";
import { exists, readOr, slugify, writeFile } from "./files";

export { ensureProjectsHidden, migrateLegacyProjects, prepareProjects, projectsPath } from "./layout";

/** The project's shared instructions/notes (its first `# ` heading is the display name). */
export const PROJECT_NOTES_FILE = "project.md";
/** Optional project rules, binding like .vault-chat/rules.md. */
export const PROJECT_RULES_FILE = "rules.md";
/** Where a deleted project's own files go (recoverable). Never listed: not a slug. */
export const DELETED_DIR = ".deleted";

export type ProjectInfo = { slug: string; name: string; dir: string };

export type Project = ProjectInfo & {
  /** project.md: the shared instructions and notes; "" when there is none. */
  notes: string;
  /** rules.md; "" when there are none. */
  rules: string;
};

/** A path in the projects home. */
export function homePath(...parts: string[]): string {
  return join(projectsRoot(), ...parts);
}

export function projectDir(slug: string): string {
  return homePath(slug);
}

export function projectNotesPath(slug: string): string {
  return homePath(slug, PROJECT_NOTES_FILE);
}

/** The display name: project.md's first `# ` heading, else the slug. */
function nameOf(slug: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(readOr(projectNotesPath(slug)));
  return m ? m[1]! : slug;
}

/** Every project, by slug (none when no projects home is configured). */
export function listProjects(): ProjectInfo[] {
  if (!hasProjectsHome()) return [];
  let names: string[];
  try {
    names = readdirSync(projectsRoot());
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      try {
        return n === slugify(n) && statSync(homePath(n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((slug) => ({ slug, name: nameOf(slug), dir: projectDir(slug) }));
}

export function projectExists(slug: string): boolean {
  if (!hasProjectsHome() || !slug || slug !== slugify(slug)) return false;
  try {
    return statSync(projectDir(slug)).isDirectory();
  } catch {
    return false;
  }
}

export function readProject(slug: string): Project | null {
  if (!projectExists(slug)) return null;
  return {
    slug,
    name: nameOf(slug),
    dir: projectDir(slug),
    notes: readOr(projectNotesPath(slug)),
    rules: readOr(homePath(slug, PROJECT_RULES_FILE)),
  };
}

/** Find a project by slug or by name (case-insensitive). */
export function findProject(nameOrSlug: string): ProjectInfo | null {
  const slug = slugify(nameOrSlug);
  const want = nameOrSlug.trim().toLowerCase();
  return listProjects().find((p) => p.slug === slug || p.name.toLowerCase() === want) ?? null;
}

/**
 * A new project, for Carl's own actions only (New project, move to a new project): its folder in the projects home
 * and a project.md that names it — the shared notes he may fill in. An existing project.md is never overwritten.
 */
export function createProject(name: string, description = ""): ProjectInfo {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" does not make a project name`);
  const p = projectNotesPath(slug);
  if (!exists(p)) writeFile(p, `# ${name.trim()}\n${description.trim() ? `\n${description.trim()}\n` : ""}`);
  return { slug, name: nameOf(slug), dir: projectDir(slug) };
}

/** Create-or-attach (Carl's UI routes). */
export function ensureProject(name: string, description = ""): { project: ProjectInfo; created: boolean } {
  const found = findProject(name);
  if (found) return { project: found, created: false };
  return { project: createProject(name, description), created: true };
}

/**
 * Carl's Delete on a project: its own folder in the projects home (project.md with its memory, rules.md) moves to
 * <home>/.deleted/<slug>-<date>/, never deleted. Its working folder and every other file of his are not touched.
 * Returns where it went (relative to the projects home).
 */
export function deleteProjectFiles(slug: string, now = new Date()): { name: string; movedTo: string } {
  if (!projectExists(slug)) throw new Error(`no project ${slug}`);
  const name = nameOf(slug);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const base = homePath(DELETED_DIR);
  mkdirSync(base, { recursive: true });
  let entry = `${slug}-${stamp}`;
  for (let i = 2; exists(join(base, entry)); i++) entry = `${slug}-${stamp}-${i}`;
  renameSync(projectDir(slug), join(base, entry));
  return { name, movedTo: `${DELETED_DIR}/${entry}` };
}

export type DeletedProject = { slug: string; name: string; entry: string; deletedAt: number };

/** What <home>/.deleted/ holds: each deleted project's folder (`<slug>-<YYYYMMDD-HHMMSS>[-n]`), newest first. */
export function listDeletedProjects(): DeletedProject[] {
  if (!hasProjectsHome()) return [];
  const base = homePath(DELETED_DIR);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const out: DeletedProject[] = [];
  for (const entry of names) {
    const m = /^(.+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(entry);
    if (!m) continue;
    try {
      if (!statSync(join(base, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    const h = /^#\s+(.+?)\s*$/m.exec(readOr(join(base, entry, PROJECT_NOTES_FILE)));
    const deletedAt = Date.UTC(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
    out.push({ slug: m[1]!, name: h ? h[1]! : m[1]!, entry, deletedAt });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt || b.entry.localeCompare(a.entry));
}

/**
 * The inverse of deleteProjectFiles: a deleted project's folder back to <home>/<slug>/ — the newest one of that
 * slug (or name), or the exact `.deleted/` entry named. Refused when a project of that slug exists.
 */
export function restoreProjectFiles(slugNameOrEntry: string): { slug: string; name: string; entry: string } {
  const want = slugNameOrEntry.trim();
  const all = listDeletedProjects();
  const low = want.toLowerCase();
  const hit = all.find((d) => d.entry === want) ?? all.find((d) => d.slug === want || d.slug === slugify(want) || d.name.toLowerCase() === low);
  if (!hit) throw new Error(`nothing deleted under "${want}"${all.length ? ` (deleted: ${all.map((d) => d.name).join(", ")})` : ""}`);
  if (projectExists(hit.slug)) throw new Error(`a project "${nameOf(hit.slug)}" (${hit.slug}) exists already`);
  renameSync(homePath(DELETED_DIR, hit.entry), projectDir(hit.slug));
  return { slug: hit.slug, name: nameOf(hit.slug), entry: hit.entry };
}

/** Carl's Rename: project.md's first `# ` heading (the slug, its folder and its thread stay). */
export function renameProject(slug: string, name: string): ProjectInfo {
  const n = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!n) throw new Error("a project needs a name");
  if (!projectExists(slug)) throw new Error(`no project ${slug}`);
  const p = projectNotesPath(slug);
  const text = readOr(p);
  const next = /^#\s+.+$/m.test(text) ? text.replace(/^#\s+.+$/m, `# ${n}`) : `# ${n}\n${text ? `\n${text}` : ""}`;
  writeFile(p, next);
  return { slug, name: nameOf(slug), dir: projectDir(slug) };
}

/** `.vault-chat/rules.md` (global, the vault's) — "" when absent. */
export function readGlobalRules(): string {
  return readOr(join(ctxConfig().vault, ".vault-chat", "rules.md"));
}
