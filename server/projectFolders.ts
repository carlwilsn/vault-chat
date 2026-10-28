// A project's folder on the box (Carl, 2026-10-27: "a vault is my UI thing, projects are general
// machine-path stuff", modelled on Claude Code's working directory).
//
// A project (its notes and memory in the projects home: server/projectsHome.ts) works in a folder on the box Carl
// chose: <vault-chat folder>/projects/<name>, ~/github/vault-chat, ~/machine, or a folder inside a vault. That
// folder is its thread's working directory (pi loads the folder's AGENTS.md itself) and has its own git.
//
// Who may name such a folder matters: the sandbox makes it writable. So the choice is recorded where the agent
// cannot write — the projects home's `.vault-chat/local/project-folders.json`, the server's own state (read-only in
// the sandbox) — and only Carl's own action writes it (the app's "+ New project", POST /projects). One registry for
// the machine, whatever vault is open (before 2026-10-28 each vault had its own: the migration,
// server/projectsMigrate.ts, merges them).
//
// Never a project folder: the root, the system's folders, the home itself or anything holding it, and every path
// the agent never sees (the key store, ~/.ssh and the other credentials, ~/.local/state, the server's state and env
// file, the vaults' hubs, a vault's own .git and .vault-chat, the projects home), nor anything that holds one of
// those. Inside a vault is fine (a course folder): a vault is Carl's files, and a project may work in some of them.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "./atomic";
import { hasProjectsHome, projectsRoot } from "./context/config";

/** Credential locations in the user's home the agent never sees (hidden in both sandbox layers, denied to pi's own tools). */
export const HOME_CREDENTIALS = [
  ".ssh",
  ".gnupg",
  ".config/gh",
  ".config/hub",
  ".config/git/credentials",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".aws",
  ".kube",
  ".password-store",
  ".local/share/keyrings",
  ".config/rclone",
  ".local/state/thinkbox",
  // The default key store and server env file, hidden even when this server is configured elsewhere
  // (a second instance — the test one — must not expose the live box's).
  ".config/vault-chat",
  ".config/vault-chat-server.env",
];

/** The system's own folders: never a project folder, nor anything inside one. */
export const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/nix", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];

/** Where "+ New project" makes a new folder without a vault-chat folder: ~/projects/<slug>. */
export const NEW_PROJECTS_DIR = "projects";

/** The registry, relative to the projects home (server state: read-only to the agent). */
export const FOLDERS_FILE = ".vault-chat/local/project-folders.json";

export type FolderWalls = {
  home: string;
  /** Paths the agent never sees or must not write (a project folder may be neither inside nor around one). */
  protect: () => string[];
  /** The vaults on this box: a folder inside one is allowed (its root's walls never refuse it), its .git and .vault-chat never. */
  vaults?: () => string[];
};

let walls: FolderWalls | null = null;

/** The machine's walls (server/engine/index.ts): the exact state, key store, tokens, hubs and vaults. */
export function setFolderWalls(w: FolderWalls | null): void {
  walls = w;
}

/** The engine's walls, else the defaults from the environment (a server without an engine, tests). */
export function wallsOf(): FolderWalls {
  if (walls) return walls;
  const home = process.env.HOME || homedir();
  const env = [process.env.VC_STATE_DIR, process.env.VC_SECRETS_DIR, process.env.VC_ENV_FILE, process.env.VC_TOKEN_FILE].filter((x): x is string => !!x);
  return { home, protect: () => env };
}

export function under(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r === "" || (!!r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** `p` through symlinks as far as it exists (the missing tail re-appended). */
function realish(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      const r = realpathSync(cur);
      return rest.length ? join(r, ...rest.reverse()) : r;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

function tilde(p: string, home: string): string {
  return under(p, home) ? `~${p.slice(resolve(home).length).replace(/\\/g, "/")}` || "~" : p;
}

/** Everything a project folder may be neither inside nor around (resolved, with their real paths too). */
function protectedPaths(w: FolderWalls): string[] {
  const home = w.home;
  const fixed = [...HOME_CREDENTIALS, ".local/state"].map((p) => join(home, p));
  const own = (w.vaults?.() ?? []).flatMap((v) => [join(v, ".git"), join(v, ".vault-chat")]);
  const projects = hasProjectsHome() ? [projectsRoot()] : [];
  const all = [...fixed, ...own, ...projects, ...w.protect()].filter(Boolean).map((p) => resolve(p));
  return [...new Set(all.flatMap((p) => [p, realish(p)]))];
}

/** The vault `abs` lies inside (its real path), or null. */
function vaultOf(abs: string, w: FolderWalls): string | null {
  for (const v of w.vaults?.() ?? []) {
    const r = realish(v);
    if (under(abs, r) && abs !== r) return r;
  }
  return null;
}

/** "~/github/x" or "/home/c/github/x" as an absolute path (null: not a full path). */
export function expandFolder(raw: string, home: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const e = s === "~" ? home : s.startsWith("~/") ? join(home, s.slice(2)) : s;
  return isAbsolute(e) ? resolve(e) : null;
}

/**
 * Whether `raw` may be a project's folder: an existing folder (its real path), anywhere on the box but the
 * forbidden places. `error` says why not, in a line Carl can read.
 */
export function checkFolder(raw: string, w: FolderWalls = wallsOf()): { abs: string } | { error: string } {
  const home = resolve(w.home);
  const exp = expandFolder(String(raw ?? ""), home);
  if (!exp) return { error: `"${String(raw ?? "").trim()}" is not a full path (start it with / or ~/)` };
  let abs: string;
  try {
    abs = realpathSync(exp);
  } catch {
    return { error: `${tilde(exp, home)} does not exist` };
  }
  try {
    if (!statSync(abs).isDirectory()) return { error: `${tilde(abs, home)} is not a folder` };
  } catch {
    return { error: `${tilde(abs, home)} does not exist` };
  }
  if (dirname(abs) === abs) return { error: `${abs} is the whole machine: choose a folder` };
  if (process.platform !== "win32") {
    for (const d of SYSTEM_DIRS) if (under(abs, d)) return { error: `${abs} is a system folder (${d}): choose one of your own` };
  }
  const realHome = realish(home);
  if (abs === realHome || under(realHome, abs)) return { error: `${tilde(abs, home)} is ${abs === realHome ? "your whole home folder" : "around your home folder"}: choose a folder in it` };
  // Inside a vault (a course folder): the walls around the vault (its root, ~/vaults) don't refuse it.
  const inVault = vaultOf(abs, w);
  for (const p of protectedPaths(w)) {
    if (inVault && !under(p, inVault) && under(inVault, p)) continue;
    if (abs === p) return { error: `${tilde(abs, home)} is off limits: the agent never touches it` };
    if (under(abs, p)) return { error: `${tilde(abs, home)} is inside ${tilde(p, home)}, which the agent never touches` };
    if (under(p, abs)) return { error: `${tilde(abs, home)} holds ${tilde(p, home)}, which the agent never touches: choose a folder inside it` };
  }
  return { abs };
}

// ---------------------------------------------------------------- the registry

type Entry = { path: string; at: string };
type Registry = { folders: Record<string, Entry>; deleted: Record<string, Entry & { slug: string }> };

/** The registry's file (in the projects home); null when no projects home is configured. */
export function registryPath(): string | null {
  return hasProjectsHome() ? join(projectsRoot(), FOLDERS_FILE) : null;
}

/** A registry file as it is (the migration merges the vaults' old ones). */
export function readRegistryFile(file: string): Registry {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    return { folders: r?.folders && typeof r.folders === "object" ? r.folders : {}, deleted: r?.deleted && typeof r.deleted === "object" ? r.deleted : {} };
  } catch {
    return { folders: {}, deleted: {} };
  }
}

function readReg(): Registry {
  const p = registryPath();
  return p ? readRegistryFile(p) : { folders: {}, deleted: {} };
}

function writeReg(r: Registry): void {
  const p = registryPath();
  if (!p) throw new Error("no projects home is configured");
  mkdirSync(dirname(p), { recursive: true });
  writeAtomic(p, JSON.stringify(r, null, 2) + "\n");
}

/** The folder Carl chose for a project (its real path as recorded), or null. Not re-checked: see projectFolderOf. */
export function registeredFolder(slug: string): string | null {
  const e = readReg().folders[slug];
  return e && typeof e.path === "string" && e.path ? e.path : null;
}

/** Record a folder for `slug` without a check (the migration: a folder the old registry or project.md held). */
export function recordFolder(slug: string, abs: string, at = new Date().toISOString()): void {
  const r = readReg();
  r.folders[slug] = { path: abs, at };
  writeReg(r);
}

/** Carl's choice: `slug` works in `raw` (checked first). Replaces an earlier one. */
export function registerFolder(slug: string, raw: string, now = new Date()): { abs: string } | { error: string } {
  const c = checkFolder(raw);
  if ("error" in c) return c;
  recordFolder(slug, c.abs, now.toISOString());
  return c;
}

/** No folder of its own any more (a new project of that slug without one). */
export function unregisterFolder(slug: string): void {
  const r = readReg();
  if (!r.folders[slug]) return;
  delete r.folders[slug];
  writeReg(r);
}

/** Delete: the choice goes with the project's files to .deleted/<entry> (its folder itself is never touched). */
export function retireFolder(slug: string, entry: string): void {
  const r = readReg();
  const e = r.folders[slug];
  if (!e) return;
  delete r.folders[slug];
  r.deleted[entry] = { ...e, slug };
  writeReg(r);
}

/** Restore: the choice comes back with the project. */
export function reviveFolder(entry: string, slug: string): void {
  const r = readReg();
  const e = r.deleted[entry];
  if (!e) return;
  delete r.deleted[entry];
  r.folders[slug] = { path: e.path, at: e.at };
  writeReg(r);
}

type Exists = (slug: string) => boolean;

/** Whether the project `slug` is there (its own folder in the projects home). */
export function projectThere(): Exists {
  return (slug) => {
    if (!hasProjectsHome()) return false;
    try {
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && statSync(join(projectsRoot(), slug)).isDirectory();
    } catch {
      return false;
    }
  };
}

/** A project's folder now: registered, its project still there, and still allowed (a moved or changed path is not). */
export function projectFolderOf(slug: string, exists: Exists = projectThere()): { abs: string } | { error: string } | null {
  const p = registeredFolder(slug);
  if (!p || !exists(slug)) return null;
  return checkFolder(p);
}

/** Every project folder: registered, of a project that exists, still allowed. */
export function activeFolders(exists: Exists = projectThere()): { slug: string; abs: string }[] {
  const out: { slug: string; abs: string }[] = [];
  for (const slug of Object.keys(readReg().folders).sort()) {
    const f = projectFolderOf(slug, exists);
    if (f && "abs" in f) out.push({ slug, abs: f.abs });
  }
  return out;
}

/** A new folder for a project: ~/projects/<slug> (made; an existing one is used as it is). */
export function newProjectFolder(slug: string): { abs: string } | { error: string } {
  const w = wallsOf();
  const dir = join(w.home, NEW_PROJECTS_DIR, slug);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: `could not make ${dir}: ${(e as Error).message}` };
  }
  return checkFolder(dir, w);
}

// ---------------------------------------------------------------- the box's files, for the app

export type DirEntry = { name: string; path: string; is_dir: boolean; ok?: boolean };

const MAX_ENTRIES = 2000;

function listDir(abs: string, dirsOnly: boolean): DirEntry[] {
  const out: DirEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  for (const name of names) {
    if (name === ".git") continue;
    if (dirsOnly && name.startsWith(".")) continue;
    const p = join(abs, name);
    let dir = false;
    try {
      dir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (dirsOnly && !dir) continue;
    out.push({ name, path: p.split(sep).join("/"), is_dir: dir });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
}

/**
 * The folder chooser (GET /api/v1/box/folders?path=): the folders in `raw` (default: the home),
 * each marked `ok` when it may be a project's folder. Never lists inside a protected path.
 */
export function browseFolders(raw: string | null): { path: string; parent: string | null; home: string; ok: boolean; why?: string; dirs: DirEntry[] } | { error: string } {
  const w = wallsOf();
  const home = resolve(w.home);
  const want = raw && raw.trim() ? expandFolder(raw, home) : home;
  if (!want) return { error: `"${raw}" is not a full path` };
  let abs: string;
  try {
    abs = realpathSync(want);
    if (!statSync(abs).isDirectory()) return { error: `${want} is not a folder` };
  } catch {
    return { error: `${want} does not exist` };
  }
  const prot = protectedPaths(w);
  const hidden = (p: string) => {
    const v = vaultOf(p, w);
    return prot.some((x) => under(p, x) && !(v && !under(x, v) && under(v, x)));
  };
  if (hidden(abs)) return { error: `${tilde(abs, home)} is off limits` };
  const here = checkFolder(abs, w);
  const dirs = listDir(abs, true)
    .filter((d) => !hidden(resolve(d.path)))
    .map((d) => ({ ...d, ok: "abs" in checkFolder(d.path, w) }));
  const parent = dirname(abs) === abs ? null : dirname(abs).split(sep).join("/");
  return { path: abs.split(sep).join("/"), parent, home: home.split(sep).join("/"), ok: "abs" in here, ...("error" in here ? { why: here.error } : {}), dirs };
}

/** The project folder `raw` (an absolute path) lies in, and the path itself; null when it is in none. */
export function inProjectFolder(raw: string, exists: Exists = projectThere()): { slug: string; root: string; abs: string } | null {
  if (!raw || !isAbsolute(raw)) return null;
  const abs = realish(resolve(raw));
  // A project's own folder in the projects home (its project.md, rules.md): Carl opens its notes from any vault.
  if (hasProjectsHome()) {
    const home = realish(projectsRoot());
    const rel = relative(home, abs);
    const slug = rel.split(sep)[0] ?? "";
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && exists(slug)) return { slug, root: join(home, slug), abs };
  }
  for (const f of activeFolders(exists)) {
    if (!under(abs, f.abs)) continue;
    const rel = relative(f.abs, abs);
    if (rel.split(sep).includes(".git")) return null;
    return { slug: f.slug, root: f.abs, abs };
  }
  return null;
}

/** A project folder's entries (GET /api/v1/box/dir?path=): files and folders, folders first, .git left out. */
export function projectDirListing(raw: string, exists: Exists = projectThere()): { path: string; root: string; slug: string; entries: DirEntry[] } | { error: string } {
  const hit = inProjectFolder(raw, exists);
  if (!hit) return { error: `${raw} is not in a project's folder` };
  if (!existsSync(hit.abs)) return { error: `${raw} does not exist` };
  return { path: hit.abs.split(sep).join("/"), root: hit.root.split(sep).join("/"), slug: hit.slug, entries: listDir(hit.abs, false) };
}
