// A project is a folder with a conversation of its own (Carl, 2026-10-29: "everything is a folder"; "every project
// is a vault; not every vault is a project"). The record is thin: the thread (project-<slug>, in the log of the vault
// that owns it) and its working folder (cwd), kept in that vault's folder registry (server/projectFolders.ts: the
// server's own state, which the agent cannot write). Nothing else: the folder carries the rest.
//
//   <folder>/AGENTS.md              the project's instructions; pi loads it itself (the thread's cwd is the folder)
//   <folder>/.vault-chat/memory.md  the project's memory: the agent's dated lines
//   <folder>/.vault-chat/rules.md   the project's rules, binding on every turn of its thread
//
// The name is the folder's name. Carl makes projects (the app's "Make this a project" or "+ New project", or by asking
// in so many words: OpenProject); the agent never makes one on its own initiative. Delete takes the conversation
// away (the registry keeps the choice under `deleted`, and the log keeps the thread: Restore brings both back); the
// folder stays unless Carl also deleted it (server/folderOps.ts, recoverable through git).
import { existsSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ctxConfig } from "./config";
import { readOr, slugify, writeFile } from "./files";
import { deletedFolders, registeredFolder, registeredFolders, registerFolder, retireFolder, reviveFolder, setRegisteredPath } from "../projectFolders";

export { ensureProjectsHidden, migrateLegacyProjects, prepareProjects, projectsPath } from "./layout";

/** A project's own files, inside its folder. */
export const PROJECT_DIR = ".vault-chat";
/** The project's memory (the agent's dated lines). */
export const PROJECT_NOTES_FILE = "memory.md";
/** Optional project rules, binding like the vault's .vault-chat/rules.md. */
export const PROJECT_RULES_FILE = "rules.md";
/** The project's instructions: pi loads the cwd's AGENTS.md itself. */
export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/** `folder`: the project's folder (its thread's cwd); `dir`: its own files (`<folder>/.vault-chat`). */
export type ProjectInfo = { slug: string; name: string; dir: string; folder: string };

export type Project = ProjectInfo & {
  /** .vault-chat/memory.md: the project's memory; "" when there is none. */
  notes: string;
  /** .vault-chat/rules.md; "" when there are none. */
  rules: string;
};

function vault(): string {
  return ctxConfig().vault;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A folder's name as a project's name. */
export function folderName(folder: string): string {
  return basename(folder.replace(/[\\/]+$/, "")) || folder;
}

function infoOf(slug: string, folder: string): ProjectInfo {
  return { slug, name: folderName(folder), dir: join(folder, PROJECT_DIR), folder };
}

export function projectDir(slug: string): string {
  const f = registeredFolder(vault(), slug);
  return f ? join(f, PROJECT_DIR) : "";
}

export function projectNotesPath(slug: string): string {
  const d = projectDir(slug);
  return d ? join(d, PROJECT_NOTES_FILE) : "";
}

/** This vault's projects: every registered folder that is there. */
export function listProjects(): ProjectInfo[] {
  return registeredFolders(vault())
    .filter((e) => isDir(e.path))
    .map((e) => infoOf(e.slug, e.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function projectExists(slug: string): boolean {
  if (!slug || slug !== slugify(slug)) return false;
  const f = registeredFolder(vault(), slug);
  return !!f && isDir(f);
}

export function readProject(slug: string): Project | null {
  if (!projectExists(slug)) return null;
  const p = infoOf(slug, registeredFolder(vault(), slug)!);
  return { ...p, notes: readOr(join(p.dir, PROJECT_NOTES_FILE)), rules: readOr(join(p.dir, PROJECT_RULES_FILE)) };
}

/** Every project on the box, from every vault's registry (configureContext({vaults})); `vault`: the one that owns it. */
export function allProjects(): (ProjectInfo & { vault: string })[] {
  const c = ctxConfig();
  const vaults = [...new Set([c.vault, ...(c.vaults?.() ?? [])])];
  const out: (ProjectInfo & { vault: string })[] = [];
  const seen = new Set<string>();
  for (const v of vaults)
    for (const e of registeredFolders(v)) {
      if (seen.has(e.slug) || !isDir(e.path)) continue;
      seen.add(e.slug);
      out.push({ ...infoOf(e.slug, e.path), vault: v });
    }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a project by slug or by name (case-insensitive). */
export function findProject(nameOrSlug: string): ProjectInfo | null {
  const slug = slugify(nameOrSlug);
  const want = nameOrSlug.trim().toLowerCase();
  return listProjects().find((p) => p.slug === slug || p.name.toLowerCase() === want) ?? null;
}

/** A folder name from what Carl typed: the name itself, without what no file system takes. */
export function folderNameFor(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
}

/**
 * A folder becomes a project (Carl's "Make this a project", or a new folder for "+ New project"): it is registered
 * under a slug of its name (`taken`: slugs in use anywhere on the box; a clash gets -2, -3 …). Its files are not
 * touched. Returns the project, or why not.
 */
export function makeProject(folder: string, taken: (slug: string) => boolean = () => false, now = new Date()): ProjectInfo | { error: string } {
  const have = registeredFolders(vault()).find((e) => e.path === folder);
  if (have) return infoOf(have.slug, have.path);
  const base = slugify(folderName(folder)) || "project";
  let slug = base;
  for (let i = 2; taken(slug) || registeredFolder(vault(), slug); i++) slug = `${base}-${i}`.slice(0, 60);
  const r = registerFolder(vault(), slug, folder, now);
  if ("error" in r) return r;
  excludeOwnFiles(r.abs);
  // Its memory file, so Carl's "Project notes" and the agent have it from the start.
  const mem = join(r.abs, PROJECT_DIR, PROJECT_NOTES_FILE);
  if (!existsSync(mem)) writeFile(mem, `# ${folderName(r.abs)}: memory\n`);
  return infoOf(slug, r.abs);
}

/** A repo of its own made a project: its .vault-chat/ (memory, rules) stays out of its git (.git/info/exclude). */
export function excludeOwnFiles(folder: string): void {
  const ex = join(folder, ".git", "info", "exclude");
  if (!existsSync(join(folder, ".git"))) return;
  const have = readOr(ex);
  if (/^\/?\.vault-chat\/?$/m.test(have)) return;
  writeFile(ex, `${have}${have && !have.endsWith("\n") ? "\n" : ""}/.vault-chat/\n`);
}

/**
 * A new project by name (OpenProject with create, "+ New project"): a new folder of that name in this vault (an
 * existing folder of that name is used as it is), made a project.
 */
export function createProject(name: string, taken?: (slug: string) => boolean): ProjectInfo {
  const n = folderNameFor(name);
  if (!n || !slugify(n)) throw new Error(`"${name}" does not make a project name`);
  const found = findProject(name);
  if (found) return found;
  const folder = join(vault(), n);
  if (!existsSync(folder)) writeFile(join(folder, PROJECT_DIR, PROJECT_NOTES_FILE), `# ${n}: memory\n`);
  const r = makeProject(folder, taken);
  if ("error" in r) throw new Error(r.error);
  return r;
}

/** Create-or-attach by name (OpenProject). */
export function ensureProject(name: string, taken?: (slug: string) => boolean): { project: ProjectInfo; created: boolean } {
  const found = findProject(name);
  if (found) return { project: found, created: false };
  return { project: createProject(name, taken), created: true };
}

/**
 * Carl's Delete on a project (the conversation only): the folder stays, a plain folder again. The registry keeps the
 * choice under `deleted` (Restore brings it back). Returns the name and the entry it is kept under.
 */
export function deleteProjectFiles(slug: string, now = new Date()): { name: string; movedTo: string; folder: string } {
  const f = registeredFolder(vault(), slug);
  if (!f) throw new Error(`no project ${slug}`);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let entry = `${slug}-${stamp}`;
  for (let i = 2; deletedFolders(vault())[entry]; i++) entry = `${slug}-${stamp}-${i}`;
  retireFolder(vault(), slug, entry);
  return { name: folderName(f), movedTo: entry, folder: f };
}

export type DeletedProject = { slug: string; name: string; entry: string; deletedAt: number; folder: string };

/** The deleted projects the registry keeps, newest first. */
export function listDeletedProjects(): DeletedProject[] {
  const out: DeletedProject[] = [];
  for (const [entry, e] of Object.entries(deletedFolders(vault()))) {
    const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(entry);
    const deletedAt = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : 0;
    out.push({ slug: e.slug, name: folderName(e.path), entry, deletedAt, folder: e.path });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt || b.entry.localeCompare(a.entry));
}

/** Restore: the newest deleted project of that slug or name (or the exact entry), its folder still there. */
export function restoreProjectFiles(slugNameOrEntry: string): { slug: string; name: string; entry: string } {
  const want = slugNameOrEntry.trim();
  const all = listDeletedProjects();
  const low = want.toLowerCase();
  const hit = all.find((d) => d.entry === want) ?? all.find((d) => d.slug === want || d.slug === slugify(want) || d.name.toLowerCase() === low);
  if (!hit) throw new Error(`nothing deleted under "${want}"${all.length ? ` (deleted: ${all.map((d) => d.name).join(", ")})` : ""}`);
  if (registeredFolder(vault(), hit.slug)) throw new Error(`a project "${hit.slug}" exists already`);
  if (!isDir(hit.folder)) throw new Error(`its folder ${hit.folder} is gone (it was deleted too: git has it)`);
  reviveFolder(vault(), hit.entry, hit.slug);
  return { slug: hit.slug, name: hit.name, entry: hit.entry };
}

/**
 * Carl's Rename: the folder is renamed in place (same parent); the slug and the thread stay. A folder that is a
 * repo of its own (its hub and its sync are named after it) is not renamed here.
 */
export function renameProject(slug: string, name: string): ProjectInfo {
  const n = folderNameFor(name);
  if (!n) throw new Error("a project needs a name");
  const f = registeredFolder(vault(), slug);
  if (!f) throw new Error(`no project ${slug}`);
  if (n === folderName(f)) return infoOf(slug, f);
  if (existsSync(join(f, ".git"))) throw new Error(`${folderName(f)} is a repository of its own (its hub and its sync carry its name): rename it from the box's shell, not here`);
  const to = join(dirname(f), n);
  if (existsSync(to)) throw new Error(`there is already a ${n} beside it`);
  renameSync(f, to);
  setRegisteredPath(vault(), slug, to);
  return infoOf(slug, to);
}

/** `.vault-chat/rules.md` (global) — "" when absent. */
export function readGlobalRules(): string {
  return readOr(join(vault(), ".vault-chat", "rules.md"));
}
