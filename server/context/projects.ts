// Projects are plain groupings, like Claude.ai / ChatGPT Projects: a folder of
// chats (a conversation carries the slug in its `project` meta field) plus one
// optional shared file, `agent-projects/<slug>/project.md` — the project's
// instructions and notes, which the agent reads as context (like a CLAUDE.md).
// Carl makes projects and moves chats (the app's New project and the
// move-to-project menu); no agent tool creates a project or assigns a chat.
// The folder is hidden from the file tree by default (src/agentProjects.ts).
// Older projects may still hold memory.md / plan.md / progress.md: they stay on
// disk, untouched, and are no longer loaded.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** `.vault-chat/rules.md` (global) — "" when absent. */
export function readGlobalRules(): string {
  return readOr(join(vault(), ".vault-chat", "rules.md"));
}
