// Projects are plain groupings, like Claude.ai / ChatGPT Projects: a folder of
// chats (a conversation carries the slug in its `project` meta field) plus one
// optional shared file, `agent-projects/<slug>/project.md` — the project's
// instructions and notes, which the agent reads as context (like a CLAUDE.md).
// Carl makes projects and moves chats (the app's New project and the
// move-to-project menu, or by asking the agent in so many words: OpenProject,
// server/projectRoutes.ts); the agent never makes one on its own initiative.
// The folder is hidden from the file tree by default (src/agentProjects.ts).
// Older projects may still hold memory.md / plan.md / progress.md: they stay on
// disk, untouched, and are no longer loaded.
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ctxConfig } from "./config";
import { exists, readOr, slugify, writeFile } from "./files";
import { ensureProjectsHidden, prepareProjects, projectsPath } from "./layout";

export { ensureProjectsHidden, migrateLegacyProjects, prepareProjects, projectsPath } from "./layout";

/** The project's shared instructions/notes (its first `# ` heading is the display name). */
export const PROJECT_NOTES_FILE = "project.md";
/** Optional project rules, binding like .vault-chat/rules.md. */
export const PROJECT_RULES_FILE = "rules.md";

export type ProjectInfo = { slug: string; name: string; dir: string };

export type Project = ProjectInfo & {
  /** project.md: the shared instructions and notes; "" when there is none. */
  notes: string;
  /** rules.md; "" when there are none. */
  rules: string;
};

function vault(): string {
  return ctxConfig().vault;
}

export function projectDir(slug: string): string {
  return projectsPath(vault(), slug);
}

export function projectNotesPath(slug: string): string {
  return projectsPath(vault(), slug, PROJECT_NOTES_FILE);
}

/** The display name: project.md's first `# ` heading, else the slug. */
function nameOf(slug: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(readOr(projectNotesPath(slug)));
  return m ? m[1]! : slug;
}

export function listProjects(): ProjectInfo[] {
  prepareProjects(vault());
  const root = projectsPath(vault());
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      try {
        return statSync(projectsPath(vault(), n)).isDirectory() && n === slugify(n);
      } catch {
        return false;
      }
    })
    .sort()
    .map((slug) => ({ slug, name: nameOf(slug), dir: projectDir(slug) }));
}

export function projectExists(slug: string): boolean {
  prepareProjects(vault());
  if (!slug || slug !== slugify(slug)) return false;
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
    rules: readOr(projectsPath(vault(), slug, PROJECT_RULES_FILE)),
  };
}

/** Find a project by slug or by name (case-insensitive). */
export function findProject(nameOrSlug: string): ProjectInfo | null {
  const slug = slugify(nameOrSlug);
  const want = nameOrSlug.trim().toLowerCase();
  return listProjects().find((p) => p.slug === slug || p.name.toLowerCase() === want) ?? null;
}

/**
 * A new project, for Carl's own actions only (New project, move to a new
 * project): its folder and a project.md that names it — the shared notes he
 * may fill in. An existing project.md is never overwritten.
 */
export function createProject(name: string, description = ""): ProjectInfo {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" does not make a project name`);
  prepareProjects(vault());
  const p = projectNotesPath(slug);
  if (!exists(p)) writeFile(p, `# ${name.trim()}\n${description.trim() ? `\n${description.trim()}\n` : ""}`);
  ensureProjectsHidden(vault());
  return { slug, name: nameOf(slug), dir: projectDir(slug) };
}

/** Create-or-attach (Carl's UI routes). */
export function ensureProject(name: string, description = ""): { project: ProjectInfo; created: boolean } {
  const found = findProject(name);
  if (found) return { project: found, created: false };
  return { project: createProject(name, description), created: true };
}

/** Where a deleted project's own files go (recoverable; git keeps them too). Never listed: not a slug. */
export const DELETED_DIR = ".deleted";

/**
 * Carl's Delete on a project: its own folder (agent-projects/<slug>/: project.md with its memory, rules.md)
 * moves to agent-projects/.deleted/<slug>-<date>/, never deleted. The front-facing folder project.md names
 * (`folder:`) and every other file of his are not touched. Returns where it went (vault-relative).
 */
export function deleteProjectFiles(slug: string, now = new Date()): { name: string; movedTo: string } {
  if (!projectExists(slug)) throw new Error(`no project ${slug}`);
  const name = nameOf(slug);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const base = projectsPath(vault(), DELETED_DIR);
  mkdirSync(base, { recursive: true });
  let dest = join(base, `${slug}-${stamp}`);
  for (let i = 2; exists(dest); i++) dest = join(base, `${slug}-${stamp}-${i}`);
  renameSync(projectDir(slug), dest);
  return { name, movedTo: relative(vault(), dest).split(sep).join("/") };
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

/** `.vault-chat/rules.md` (global) — "" when absent. */
export function readGlobalRules(): string {
  return readOr(join(vault(), ".vault-chat", "rules.md"));
}
