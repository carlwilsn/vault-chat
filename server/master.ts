// The vault-chat folder (Carl, 2026-10-27: "in settings I need to set a vault chat master path and then vaults and
// projects will be sub folders there and everything else will sync from there and similar shape on the other
// machine"). One folder per machine, the same shape on both:
//
//   <folder>/vaults/<name>/          a vault (its own git repo)
//   <folder>/projects/<name>/        a project's folder (its own git repo)
//   <folder>/.hub/vaults/<name>.git  the box only: the bare hub each vault syncs through
//   <folder>/.hub/projects/<name>.git
//
// Every repo under it syncs laptop <-> box with the one sync engine (server/sync.ts BoxSync here, the laptop's
// box_sync.rs there), one instance per repo, the box the hub. A vault keeps its branches (`box` here, `master` on
// the laptop). A project's working copy here stays on its own main branch (Keep merges there:
// server/projectChanges.ts) and is pushed to the hub as `box`; the laptop's copy of that branch is the hub's
// `main` (or whatever the project's branch is called). A project with its own remote (vault-chat on GitHub): its
// remote is pushed from where credentials exist. Keep tries here; the laptop's sync pushes after it pulls a kept
// change.
//
// Where it is: VC_MASTER, else what Settings set (<state>/master.json), else none. Without one everything is as
// before (vaults beside VC_VAULT, new projects in ~/projects/<name>, no project syncs).
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "./config";
import { writeAtomic } from "./atomic";
import { runGit, git, AGENT_IDENTITY_ARGS } from "./git";
import { BoxSync, type Alert } from "./sync";

export type RepoKind = "vaults" | "projects";
export const HUB_DIR = ".hub";

/** A repo's name under the folder: `^[A-Za-z0-9._-]{1,64}$`, no leading dot, no `.git` (as a vault's on the box). */
export function validRepoName(n: unknown): n is string {
  return typeof n === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(n) && !n.startsWith(".") && !n.endsWith(".git");
}

/** "Lecture Tools" -> "lecture-tools": a project's folder name from its slug or name. */
export function repoNameOf(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|-+$/g, "")
      .replace(/\.git$/, "")
      .slice(0, 64) || "project"
  );
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** "~/vc" -> absolute; null when not a full path. */
export function expandPath(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const e = s === "~" ? home() : s.startsWith("~/") ? join(home(), s.slice(2)) : s;
  return isAbsolute(e) ? resolve(e) : null;
}

/** The default Settings suggests (never active until set): ~/vc. */
export function defaultMaster(): string {
  return join(home(), "vc");
}

function stateFile(): string {
  return join(loadConfig().stateDir, "master.json");
}

/** This machine's vault-chat folder, or null (none set: everything as before). */
export function masterDir(): string | null {
  const env = process.env.VC_MASTER;
  if (env && env.trim()) return expandPath(env) ?? resolve(env);
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf8"));
    return typeof j?.path === "string" && j.path ? resolve(j.path) : null;
  } catch {
    return null;
  }
}

export function masterLayout(m: string): { vaults: string; projects: string; hub: string } {
  return { vaults: join(m, "vaults"), projects: join(m, "projects"), hub: join(m, HUB_DIR) };
}

/** A repo's working copy and its hub (the hub is used on the box only). */
export function repoPaths(m: string, kind: RepoKind, name: string): { wc: string; bare: string } {
  return { wc: join(m, kind, name), bare: join(m, HUB_DIR, kind, `${name}.git`) };
}

/** The repos of one kind under the folder: each `<kind>/<name>` that is a git repo. */
export function masterRepoNames(m: string, kind: RepoKind): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(m, kind));
  } catch {
    return [];
  }
  return names.filter((n) => validRepoName(n) && existsSync(join(m, kind, n, ".git"))).sort();
}

function under(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r === "" || (!!r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Set the folder (Settings): made with its layout; the projects in it start syncing. VC_MASTER, when set, wins. */
export async function setMasterDir(raw: string): Promise<{ ok: true; path: string } | { error: string }> {
  const abs = expandPath(raw);
  if (!abs) return { error: `"${String(raw ?? "").trim()}" is not a full path (start it with / or ~/)` };
  if (process.env.VC_MASTER) return { error: "this box's folder is set by VC_MASTER in its env file: change it there" };
  const h = resolve(home());
  if (abs === h || under(h, abs)) return { error: `${abs} is your whole home folder or holds it: choose a folder in it (e.g. ~/vc)` };
  const cfg = loadConfig();
  for (const p of [cfg.stateDir, cfg.secretsDir, join(h, ".ssh"), join(h, ".config"), join(h, ".local")]) {
    if (under(abs, p) || under(p, abs)) return { error: `${abs} is inside or around ${p}: choose another folder` };
  }
  try {
    for (const d of Object.values(masterLayout(abs))) mkdirSync(d, { recursive: true });
  } catch (e) {
    return { error: `could not make ${abs}: ${(e as Error).message}` };
  }
  mkdirSync(cfg.stateDir, { recursive: true });
  writeAtomic(stateFile(), JSON.stringify({ path: abs, at: new Date().toISOString() }, null, 2) + "\n");
  await restartMasterProjects();
  return { ok: true, path: abs };
}

// ---------------------------------------------------------------- the projects' syncs

const projects = new Map<string, { sync: BoxSync; path: string }>();
let alertFn: Alert = async () => 0;
let projectErrors = new Map<string, string>();

/** The branch a working copy has checked out (its main), or null (detached, no repo). */
async function headBranch(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["symbolic-ref", "--short", "HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Start (or keep) one project's sync. Its hub is made when missing (an adopted project). */
export async function startProjectSync(name: string): Promise<BoxSync | null> {
  const m = masterDir();
  if (!m || !validRepoName(name)) return null;
  const { wc, bare } = repoPaths(m, "projects", name);
  const hit = projects.get(name);
  if (hit && hit.path === wc) return hit.sync;
  if (hit) hit.sync.stop();
  const branch = await headBranch(wc);
  if (!branch || branch === "box") {
    projectErrors.set(name, branch ? `${wc} is on a branch called "box", the name the sync uses for the box's side: not synced` : `${wc} has no branch checked out: not synced`);
    return null;
  }
  const cfg = loadConfig();
  const s = new BoxSync(wc, bare, cfg.syncIntervalMs, alertFn, undefined, { local: branch, hub: branch });
  try {
    await s.ensure(true);
  } catch (e) {
    projectErrors.set(name, String((e as Error)?.message ?? e));
    return null;
  }
  projectErrors.delete(name);
  projects.set(name, { sync: s, path: wc });
  if (cfg.syncEnabled) s.start();
  return s;
}

/** Every project already under the folder (at boot, after the folder changed). */
export async function startMasterProjects(alert?: Alert): Promise<void> {
  if (alert) alertFn = alert;
  const m = masterDir();
  if (!m) return;
  for (const name of masterRepoNames(m, "projects")) await startProjectSync(name).catch((e) => console.error(`[sync] project ${name}:`, e));
}

async function restartMasterProjects(): Promise<void> {
  stopMasterProjects();
  projectErrors = new Map();
  await startMasterProjects();
}

export function stopMasterProjects(): void {
  for (const p of projects.values()) p.sync.stop();
  projects.clear();
}

/** A project's sync (tests, status). */
export function projectSync(name: string): BoxSync | null {
  return projects.get(name)?.sync ?? null;
}

export function triggerProject(name: string): void {
  projects.get(name)?.sync.trigger();
}

export async function flushProject(name: string): Promise<void> {
  await projects.get(name)?.sync.flush();
}

/** The project under the folder whose working copy `folder` is, or null. */
export function masterProjectOf(folder: string): string | null {
  const m = masterDir();
  if (!m) return null;
  const r = relative(join(m, "projects"), resolve(folder));
  if (!r || r.startsWith("..") || isAbsolute(r) || r.includes(sep) || r.includes("/")) return null;
  return validRepoName(r) ? r : null;
}

/** Sync a project now (after Keep); no-op when it is not under the folder. */
export function triggerProjectAt(folder: string): void {
  const n = masterProjectOf(folder);
  if (n) triggerProject(n);
}

/** The repo's own remote (`origin`'s URL, from .git/config), or null. The hub is never a remote of the box's copy. */
export function originUrl(dir: string): string | null {
  try {
    const cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\]([^[]*)/.exec(cfg);
    const u = m && /^\s*url\s*=\s*(.+)$/m.exec(m[1]!);
    return u ? u[1]!.trim() : null;
  } catch {
    return null;
  }
}

/** A project under the folder with no remote of its own: synced like a vault, and the agent writes it directly (no
 * "you keep it" gate: the gate guards a project whose main goes somewhere else, e.g. GitHub). */
export function syncedWithoutRemote(folder: string): boolean {
  return masterProjectOf(folder) !== null && !originUrl(folder);
}

/** "+ New project" with the folder set: `<folder>/projects/<name>`, a git repo on `main` with a first commit, synced. */
export async function newMasterProject(raw: string): Promise<{ abs: string } | { error: string }> {
  const m = masterDir();
  if (!m) return { error: "no vault-chat folder is set on the box" };
  const name = repoNameOf(raw);
  const { wc } = repoPaths(m, "projects", name);
  try {
    mkdirSync(wc, { recursive: true });
    if (!existsSync(join(wc, ".git"))) {
      await git(wc, ["init", "-q", "-b", "main"]);
      await git(wc, [...AGENT_IDENTITY_ARGS, "commit", "-q", "--allow-empty", "-m", `[agent] new project ${name}`]);
    }
  } catch (e) {
    return { error: `could not make ${wc}: ${(e as Error).message}` };
  }
  await startProjectSync(name);
  return { abs: wc };
}

export type MasterProjectInfo = { name: string; path: string; branch: string | null; origin: string | null; syncing: boolean; ok: boolean | null; error: string | null; lastOkAt: number | null };
export type MasterInfo = {
  master: string | null;
  suggested: string;
  fromEnv: boolean;
  layout: { vaults: string; projects: string; hub: string } | null;
  vaults: Array<{ name: string; path: string }>;
  projects: MasterProjectInfo[];
};

/** GET /api/v1/master: the folder, its layout, its vaults and its projects (the laptop clones what it lacks). */
export function masterInfo(): MasterInfo {
  const m = masterDir();
  const out: MasterInfo = { master: m, suggested: defaultMaster(), fromEnv: !!process.env.VC_MASTER, layout: m ? masterLayout(m) : null, vaults: [], projects: [] };
  if (!m) return out;
  out.vaults = masterRepoNames(m, "vaults").map((name) => ({ name, path: repoPaths(m, "vaults", name).wc }));
  for (const name of masterRepoNames(m, "projects")) {
    const path = repoPaths(m, "projects", name).wc;
    const p = projects.get(name);
    let branch: string | null = null;
    try {
      const h = readFileSync(join(path, ".git", "HEAD"), "utf8").trim();
      branch = h.startsWith("ref: refs/heads/") ? h.slice("ref: refs/heads/".length) : null;
    } catch {
      /* not readable */
    }
    out.projects.push({
      name,
      path,
      branch,
      origin: originUrl(path),
      syncing: !!p,
      ok: p ? p.sync.status.ok : null,
      error: p ? p.sync.status.lastError : (projectErrors.get(name) ?? null),
      lastOkAt: p ? p.sync.status.lastOkAt : null,
    });
  }
  return out;
}
