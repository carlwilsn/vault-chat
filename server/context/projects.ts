// Projects: memory in <vault>/agent-projects/<slug>/ (src/agentProjects.ts has
// the layout), a folder of its own hidden from the file tree by default.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ctxConfig } from "./config";
import { exists, readOr, slugify, writeFile } from "./files";
import { ensureProjectsHidden, prepareProjects, projectsPath } from "./layout";

export { ensureProjectsHidden, migrateLegacyProjects, prepareProjects, projectsPath } from "./layout";

export const PROJECT_FILES = {
  project: "project.md",
  memory: "memory.md",
  plan: "plan.md",
  progress: "progress.md",
  rules: "rules.md",
} as const;
export type ProjectFile = keyof typeof PROJECT_FILES;

export type ProjectInfo = { slug: string; name: string; dir: string };

export type Project = ProjectInfo & {
  project: string;
  memory: string;
  plan: string;
  progress: string;
  /** Project rules; "" when there are none. */
  rules: string;
};

function vault(): string {
  return ctxConfig().vault;
}

export function projectDir(slug: string): string {
  return projectsPath(vault(), slug);
}

export function projectFilePath(slug: string, file: ProjectFile): string {
  return projectsPath(vault(), slug, PROJECT_FILES[file]);
}

/** The display name: project.md's first `# ` heading, else the slug. */
function nameOf(slug: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(readOr(projectFilePath(slug, "project")));
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
  return !!slug && slug === slugify(slug) && exists(projectFilePath(slug, "project"));
}

export function readProject(slug: string): Project | null {
  if (!projectExists(slug)) return null;
  const f = (k: ProjectFile) => readOr(projectFilePath(slug, k));
  return {
    slug,
    name: nameOf(slug),
    dir: projectDir(slug),
    project: f("project"),
    memory: f("memory"),
    plan: f("plan"),
    progress: f("progress"),
    rules: f("rules"),
  };
}

/** Find a project by slug or by name (case-insensitive). */
export function findProject(nameOrSlug: string): ProjectInfo | null {
  const slug = slugify(nameOrSlug);
  const want = nameOrSlug.trim().toLowerCase();
  return listProjects().find((p) => p.slug === slug || p.name.toLowerCase() === want) ?? null;
}

/** Create the project's files. Existing files are never overwritten. */
export function createProject(name: string, description = ""): ProjectInfo {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" does not make a project name`);
  const title = name.trim();
  const seed: Record<ProjectFile, string | null> = {
    project:
      `# ${title}\n\n## What\n\n${description.trim() || "(not written yet)"}\n\n## Why\n\n(not written yet)\n\n` +
      `## Done when\n\n(not decided yet)\n\n## Status\n\nstarted ${new Date().toISOString().slice(0, 10)}\n`,
    memory: `# Memory: ${title}\n\n## Decisions\n\n## Tried and learned\n\n## Conventions\n`,
    plan: `# Plan: ${title}\n\n(no plan yet)\n`,
    progress: `# Progress: ${title}\n`,
    rules: null,
  };
  prepareProjects(vault());
  for (const [k, body] of Object.entries(seed) as [ProjectFile, string | null][]) {
    const p = projectFilePath(slug, k);
    if (body !== null && !exists(p)) writeFile(p, body);
  }
  ensureProjectsHidden(vault());
  return { slug, name: nameOf(slug), dir: projectDir(slug) };
}

/** Create-or-attach. */
export function ensureProject(name: string, description = ""): { project: ProjectInfo; created: boolean } {
  const found = findProject(name);
  if (found) return { project: found, created: false };
  return { project: createProject(name, description), created: true };
}

/** `.vault-chat/rules.md` (global) — "" when absent. */
export function readGlobalRules(): string {
  return readOr(join(vault(), ".vault-chat", "rules.md"));
}
