// A project's folder on the box (Carl, 2026-10-27: "a vault is my UI thing, projects are general
// machine-path stuff", modelled on Claude Code's working directory).
//
// A project (agent-projects/<slug>/project.md: its notes and memory, in the vault as before) may
// work in any folder on the box Carl chose: ~/github/vault-chat, ~/machine, ~/projects/<name>.
// That folder is its thread's working directory (pi loads the folder's AGENTS.md itself), has its
// own git, and is never synced with the vault.
//
// Who may name such a folder matters: the sandbox makes it writable. So the choice is recorded
// where the agent cannot write — `.vault-chat/local/project-folders.json`, the server's own state
// (read-only in the sandbox, out of git) — and only Carl's own action writes it (the app's
// "+ New project", POST /projects). A `folder:` the agent writes into a project.md reaches only a
// folder inside the vault, as before.
//
// Never a project folder: the root, the system's folders, the home itself or anything holding it,
// and every path the agent never sees (the key store, ~/.ssh and the other credentials,
// ~/.local/state, the server's state and env file, other vaults and their repos), nor anything
// that holds one of those.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "./atomic";
import { PROJECTS_DIR } from "../src/agentProjects";

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

/** Where "+ New project" makes a new folder: ~/projects/<slug>. */
export const NEW_PROJECTS_DIR = "projects";

/** The registry, relative to the vault (server state: read-only to the agent, out of git). */
export const FOLDERS_FILE = ".vault-chat/local/project-folders.json";

export type FolderWalls = {
  home: string;
  /** Paths the agent never sees or must not write (a project folder may be neither inside nor around one). */
  protect: () => string[];
};

const walls = new Map<string, FolderWalls>();

const key = (vault: string) => resolve(vault);

/** The engine's walls for this vault (server/engine/index.ts): the exact state, key store and other vaults. */
export function setFolderWalls(vault: string, w: FolderWalls): void {
  walls.set(key(vault), w);
}

/** This vault's walls: the engine's, else the defaults from the environment (a server without an engine, tests). */
export function wallsOf(vault: string): FolderWalls {
  const hit = walls.get(key(vault));
  if (hit) return hit;
  const home = process.env.HOME || homedir();
  const env = [process.env.VC_STATE_DIR, process.env.VC_SECRETS_DIR, process.env.VC_ENV_FILE, process.env.VC_TOKEN_FILE].filter((x): x is string => !!x);
  return { home, protect: () => [...env, join(home, "vaults")] };
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
function protectedPaths(vault: string, w: FolderWalls): string[] {
  const home = w.home;
  const fixed = [...HOME_CREDENTIALS, ".local/state"].map((p) => join(home, p));
  const own = [join(vault, ".git"), join(vault, ".vault-chat")];
  const all = [...fixed, ...own, ...w.protect()].filter(Boolean).map((p) => resolve(p));
  return [...new Set(all.flatMap((p) => [p, realish(p)]))];
}

/** "~/github/x" or "/home/c/github/x" as an absolute path (null: not a full path). */
export function expandFolder(raw: string, home: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const e = s === "~" ? home : s.startsWith("~/") ? join(home, s.slice(2)) : s;
  return isAbsolute(e) ? resolve(e) : null;
}

/**
 * Whether `raw` may be a project's folder: an existing folder (its real path), anywhere on the box
 * but the forbidden places. `error` says why not, in a line Carl can read.
 */
export function checkFolder(vault: string, raw: string, w: FolderWalls = wallsOf(vault)): { abs: string } | { error: string } {
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
  const vaultReal = realish(vault);
  // Inside the vault (as projects always could be), away from its .git and .vault-chat.
  const inVault = under(abs, vaultReal);
  for (const p of protectedPaths(vault, w)) {
    if (inVault && !under(p, vaultReal) && under(vaultReal, p)) continue; // the vault's own root (~/vaults) holds it: fine
    if (abs === p) return { error: `${tilde(abs, home)} is off limits: the agent never touches it` };
    if (under(abs, p)) return { error: `${tilde(abs, home)} is inside ${tilde(p, home)}, which the agent never touches` };
    if (under(p, abs)) return { error: `${tilde(abs, home)} holds ${tilde(p, home)}, which the agent never touches: choose a folder inside it` };
  }
  if (!inVault && under(vaultReal, abs)) return { error: `${tilde(abs, home)} holds the vault: choose a folder inside it, or one beside it` };
  return { abs };
}

// ---------------------------------------------------------------- the registry

type Entry = { path: string; at: string };
type Registry = { folders: Record<string, Entry>; deleted: Record<string, Entry & { slug: string }> };

function regPath(vault: string): string {
  return join(vault, FOLDERS_FILE);
}

function readReg(vault: string): Registry {
  try {
    const r = JSON.parse(readFileSync(regPath(vault), "utf8"));
    return { folders: r?.folders && typeof r.folders === "object" ? r.folders : {}, deleted: r?.deleted && typeof r.deleted === "object" ? r.deleted : {} };
  } catch {
    return { folders: {}, deleted: {} };
  }
}

function writeReg(vault: string, r: Registry): void {
  mkdirSync(dirname(regPath(vault)), { recursive: true });
  writeAtomic(regPath(vault), JSON.stringify(r, null, 2) + "\n");
}

/** The folder Carl chose for a project (its real path as recorded), or null. Not re-checked: see projectFolderOf. */
export function registeredFolder(vault: string, slug: string): string | null {
  const e = readReg(vault).folders[slug];
  return e && typeof e.path === "string" && e.path ? e.path : null;
}

/** Carl's choice: `slug` works in `raw` (checked first). Replaces an earlier one. */
export function registerFolder(vault: string, slug: string, raw: string, now = new Date()): { abs: string } | { error: string } {
  const c = checkFolder(vault, raw);
  if ("error" in c) return c;
  const r = readReg(vault);
  r.folders[slug] = { path: c.abs, at: now.toISOString() };
  writeReg(vault, r);
  return c;
}

/** No folder of its own any more (a new project of that slug without one). */
export function unregisterFolder(vault: string, slug: string): void {
  const r = readReg(vault);
  if (!r.folders[slug]) return;
  delete r.folders[slug];
  writeReg(vault, r);
}

/** Delete: the choice goes with the project's files to agent-projects/.deleted/<entry> (its folder itself is never touched). */
export function retireFolder(vault: string, slug: string, entry: string): void {
  const r = readReg(vault);
  const e = r.folders[slug];
  if (!e) return;
  delete r.folders[slug];
  r.deleted[entry] = { ...e, slug };
  writeReg(vault, r);
}

/** Restore: the choice comes back with the project. */
export function reviveFolder(vault: string, entry: string, slug: string): void {
  const r = readReg(vault);
  const e = r.deleted[entry];
  if (!e) return;
  delete r.deleted[entry];
  r.folders[slug] = { path: e.path, at: e.at };
  writeReg(vault, r);
}

type Exists = (slug: string) => boolean;

/** Whether the project `slug` is there (its own folder, agent-projects/<slug>/). */
export function projectThere(vault: string): Exists {
  return (slug) => {
    try {
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && statSync(join(vault, PROJECTS_DIR, slug)).isDirectory();
    } catch {
      return false;
    }
  };
}

/** A project's folder now: registered, its project still there, and still allowed (a moved or changed path is not). */
export function projectFolderOf(vault: string, slug: string, exists: Exists = projectThere(vault)): { abs: string } | { error: string } | null {
  const p = registeredFolder(vault, slug);
  if (!p || !exists(slug)) return null;
  return checkFolder(vault, p);
}

/** Every project folder the sandbox makes writable: registered, of a project that exists, still allowed. */
export function activeFolders(vault: string, exists: Exists = projectThere(vault)): { slug: string; abs: string }[] {
  const out: { slug: string; abs: string }[] = [];
  for (const slug of Object.keys(readReg(vault).folders).sort()) {
    const f = projectFolderOf(vault, slug, exists);
    if (f && "abs" in f) out.push({ slug, abs: f.abs });
  }
  return out;
}

/** A new folder for a project: ~/projects/<slug> (made; an existing one is used as it is). */
export function newProjectFolder(vault: string, slug: string): { abs: string } | { error: string } {
  const w = wallsOf(vault);
  const dir = join(w.home, NEW_PROJECTS_DIR, slug);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: `could not make ${dir}: ${(e as Error).message}` };
  }
  return checkFolder(vault, dir, w);
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
export function browseFolders(vault: string, raw: string | null): { path: string; parent: string | null; home: string; ok: boolean; why?: string; dirs: DirEntry[] } | { error: string } {
  const w = wallsOf(vault);
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
  for (const p of protectedPaths(vault, w)) if (under(abs, p) && !under(abs, realish(vault))) return { error: `${tilde(abs, home)} is off limits` };
  const here = checkFolder(vault, abs, w);
  const dirs = listDir(abs, true)
    .filter((d) => !protectedPaths(vault, w).some((p) => under(d.path, p) && !under(d.path, realish(vault))))
    .map((d) => ({ ...d, ok: "abs" in checkFolder(vault, d.path, w) }));
  const parent = dirname(abs) === abs ? null : dirname(abs).split(sep).join("/");
  return { path: abs.split(sep).join("/"), parent, home: home.split(sep).join("/"), ok: "abs" in here, ...("error" in here ? { why: here.error } : {}), dirs };
}

/** The project folder `raw` (an absolute path) lies in, and the path itself; null when it is in none. */
export function inProjectFolder(vault: string, raw: string, exists: Exists = projectThere(vault)): { slug: string; root: string; abs: string } | null {
  if (!raw || !isAbsolute(raw)) return null;
  const abs = realish(resolve(raw));
  for (const f of activeFolders(vault, exists)) {
    if (!under(abs, f.abs)) continue;
    const rel = relative(f.abs, abs);
    if (rel.split(sep).includes(".git")) return null;
    return { slug: f.slug, root: f.abs, abs };
  }
  return null;
}

/** A project folder's entries (GET /api/v1/box/dir?path=): files and folders, folders first, .git left out. */
export function projectDirListing(vault: string, raw: string, exists: Exists = projectThere(vault)): { path: string; root: string; slug: string; entries: DirEntry[] } | { error: string } {
  const hit = inProjectFolder(vault, raw, exists);
  if (!hit) return { error: `${raw} is not in a project's folder` };
  if (!existsSync(hit.abs)) return { error: `${raw} does not exist` };
  return { path: hit.abs.split(sep).join("/"), root: hit.root.split(sep).join("/"), slug: hit.slug, entries: listDir(hit.abs, false) };
}
