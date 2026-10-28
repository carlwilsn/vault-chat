// Adopting existing repos into the vault-chat folder (server/master.ts), safely and reversibly.
//
//   copy    the vault's working copy and its hub, whole (every file, .git and all history), into
//           <folder>/vaults/<name> and <folder>/.hub/vaults/<name>.git; then verify: the same files (count and
//           bytes), the same HEAD and branch, the same refs in the hub. The originals are never moved or deleted.
//   adopt   a project folder: cloned with its full history into <folder>/projects/<name> (its `origin` stays its own
//           remote, e.g. GitHub); the copied vault's project registry points at the new folder.
//   switch  the server's env file names the copy (VC_MASTER, VC_VAULT, VC_BARE_REPO); the file as it was is kept
//           beside it, so
//   back    puts it back exactly, in one step.
// The server restarts to take a switch (systemd: `systemctl --user restart vault-chat-server`).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { masterLayout, repoPaths, validRepoName } from "./master";
import { rewriteSessionPaths, type Rewritten } from "./sessionPaths";

/** The engine's pi sessions and thread records to rewrite when a vault's path changes (server/sessionPaths.ts). */
export type SessionDirs = { sessions: string[]; instr: string[] };

/** Every moved repo's old path → its new one, in the sessions and thread records (pi refuses a session whose stored
 *  folder is gone). `back`: the other way. */
function rewriteMoves(rec: Rec, dirs: SessionDirs | undefined, back: boolean, only?: string): Rewritten {
  const total: Rewritten = { sessions: 0, records: 0, files: [] };
  if (!dirs) return total;
  const moves: [string, string][] = [];
  for (const [name, v] of Object.entries(rec.vaults)) if (!only || name === only) moves.push([v.from, v.to]);
  for (const p of Object.values(rec.projects)) moves.push([p.from, p.to]);
  for (const [from, to] of moves) {
    const r = rewriteSessionPaths({ ...dirs, from: back ? to : from, to: back ? from : to });
    total.sessions += r.sessions;
    total.records += r.records;
    total.files.push(...r.files);
  }
  return total;
}

export const RECORD = ".migration.json";

type Rec = {
  vaults: Record<string, { from: string; bareFrom: string | null; to: string; bareTo: string | null; at: string; verified: Verify }>;
  projects: Record<string, { from: string; to: string; origin: string | null; at: string; head: string }>;
  switched?: { envFile: string; backup: string; at: string; vault: string } | null;
};

export type Verify = { ok: boolean; files: [number, number]; bytes: [number, number]; head: [string | null, string | null]; branch: [string | null, string | null]; hubRefs: [string | null, string | null]; problems: string[] };

function gitOut(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.status === 0 ? r.stdout.trim() : null;
}

function readRec(m: string): Rec {
  try {
    const r = JSON.parse(readFileSync(join(m, RECORD), "utf8"));
    return { vaults: r.vaults ?? {}, projects: r.projects ?? {}, switched: r.switched ?? null };
  } catch {
    return { vaults: {}, projects: {}, switched: null };
  }
}

function writeRec(m: string, r: Rec): void {
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, RECORD), JSON.stringify(r, null, 2) + "\n");
}

/** Every file under `dir` (symlinks counted, never followed), with their total size. The repo's own .git/config is
 * left out: the copy's `origin` is repointed at the copy's hub (never the original's). */
export function countFiles(dir: string): { files: number; bytes: number } {
  const skip = join(dir, ".git", "config");
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (p === skip) continue;
      else {
        files++;
        bytes += st.isSymbolicLink() ? 0 : st.size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const refs = (bare: string | null) => (bare && existsSync(bare) ? gitOut(bare, ["for-each-ref", "--format=%(objectname) %(refname)"]) : null);

/** The copy against the original: files and bytes, HEAD, branch, the hub's refs. */
export function verifyCopy(from: string, to: string, bareFrom: string | null, bareTo: string | null): Verify {
  const a = countFiles(from);
  const b = countFiles(to);
  const head: [string | null, string | null] = [gitOut(from, ["rev-parse", "HEAD"]), gitOut(to, ["rev-parse", "HEAD"])];
  const branch: [string | null, string | null] = [gitOut(from, ["symbolic-ref", "--short", "HEAD"]), gitOut(to, ["symbolic-ref", "--short", "HEAD"])];
  const hubRefs: [string | null, string | null] = [refs(bareFrom), refs(bareTo)];
  const problems: string[] = [];
  if (a.files !== b.files) problems.push(`${a.files} files in the original, ${b.files} in the copy`);
  if (a.bytes !== b.bytes) problems.push(`${a.bytes} bytes in the original, ${b.bytes} in the copy`);
  if (!head[0] || head[0] !== head[1]) problems.push(`HEAD ${head[0] ?? "none"} in the original, ${head[1] ?? "none"} in the copy`);
  if (branch[0] !== branch[1]) problems.push(`branch ${branch[0]} in the original, ${branch[1]} in the copy`);
  if (hubRefs[0] !== hubRefs[1]) problems.push("the hub's branches differ");
  return { ok: problems.length === 0, files: [a.files, b.files], bytes: [a.bytes, b.bytes], head, branch, hubRefs, problems };
}

function copyTree(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${to} already exists: refusing to copy over it (nothing was changed)`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
}

/** Copy a vault (and its hub) into the folder, then verify. The original is only read. */
export function copyVault(o: { master: string; from: string; bareFrom?: string | null; name?: string }): { to: string; bareTo: string | null; verify: Verify } {
  const m = resolve(o.master);
  const from = resolve(o.from);
  const name = o.name ?? from.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  if (!validRepoName(name)) throw new Error(`"${name}" is not a valid vault name`);
  if (!existsSync(join(from, ".git"))) throw new Error(`${from} is not a git repo`);
  const bareFrom = o.bareFrom === undefined ? (existsSync(join(`${from}.git`, "HEAD")) ? `${from}.git` : null) : o.bareFrom ? resolve(o.bareFrom) : null;
  for (const d of Object.values(masterLayout(m))) mkdirSync(d, { recursive: true });
  const p = repoPaths(m, "vaults", name);
  copyTree(from, p.wc);
  let bareTo: string | null = null;
  if (bareFrom) {
    copyTree(bareFrom, p.bare);
    bareTo = p.bare;
  }
  // The copy's `origin` (the box's working copy pushes nothing through it, but a person might): its own hub, never
  // the original's.
  const origin = gitOut(p.wc, ["config", "--get", "remote.origin.url"]);
  if (origin && bareFrom && bareTo && resolve(origin) === resolve(bareFrom)) gitOut(p.wc, ["remote", "set-url", "origin", bareTo]);
  const verify = verifyCopy(from, p.wc, bareFrom, bareTo);
  const rec = readRec(m);
  rec.vaults[name] = { from, bareFrom, to: p.wc, bareTo, at: new Date().toISOString(), verified: verify };
  writeRec(m, rec);
  return { to: p.wc, bareTo, verify };
}

/** Adopt a project folder: cloned with its full history into <folder>/projects/<name>; `origin` stays its own remote.
 * `vault` (the copied vault): its project registry's entries for the old folder point at the new one. */
export function adoptProject(o: { master: string; from: string; name?: string; vault?: string }): { to: string; head: string; origin: string | null; repointed: string[] } {
  const m = resolve(o.master);
  const from = resolve(o.from);
  const name = o.name ?? from.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  if (!validRepoName(name)) throw new Error(`"${name}" is not a valid project folder name`);
  if (!existsSync(join(from, ".git"))) throw new Error(`${from} is not a git repo`);
  const head = gitOut(from, ["rev-parse", "HEAD"]);
  const branch = gitOut(from, ["symbolic-ref", "--short", "HEAD"]);
  if (!head || !branch) throw new Error(`${from} has no branch checked out`);
  const to = repoPaths(m, "projects", name).wc;
  if (existsSync(to)) throw new Error(`${to} already exists: refusing to clone over it`);
  mkdirSync(dirname(to), { recursive: true });
  const r = spawnSync("git", ["clone", "-q", "--no-hardlinks", "--branch", branch, from, to], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr}`);
  const origin = gitOut(from, ["config", "--get", "remote.origin.url"]);
  if (origin) gitOut(to, ["remote", "set-url", "origin", origin]);
  else gitOut(to, ["remote", "remove", "origin"]);
  const got = gitOut(to, ["rev-parse", "HEAD"]);
  if (got !== head) throw new Error(`the clone's HEAD ${got} is not ${head}`);
  const repointed: string[] = [];
  if (o.vault) {
    const reg = join(o.vault, ".vault-chat", "local", "project-folders.json");
    try {
      const j = JSON.parse(readFileSync(reg, "utf8"));
      for (const [slug, e] of Object.entries<any>(j.folders ?? {})) {
        if (e && typeof e.path === "string" && resolve(e.path) === from) {
          e.path = to;
          repointed.push(slug);
        }
      }
      if (repointed.length) writeFileSync(reg, JSON.stringify(j, null, 2) + "\n");
    } catch {
      /* no registry */
    }
  }
  const rec = readRec(m);
  rec.projects[name] = { from, to, origin, at: new Date().toISOString(), head };
  writeRec(m, rec);
  return { to, head, origin, repointed };
}

/** The env file's lines, with `set` replacing (or adding) keys. */
export function withEnv(text: string, set: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const out = lines.map((l) => {
    const k = /^\s*([A-Z0-9_]+)\s*=/.exec(l)?.[1];
    if (k && k in set) {
      seen.add(k);
      return `${k}=${set[k]}`;
    }
    return l;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(set)) if (!seen.has(k)) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

/** Point the server at the copy: VC_MASTER, VC_VAULT, VC_BARE_REPO. The file as it was is kept (<env>.before-master). */
export function switchToCopy(o: { master: string; name: string; envFile: string; sessions?: SessionDirs }): { envFile: string; backup: string; set: Record<string, string>; rewritten: { sessions: number; records: number } } {
  const m = resolve(o.master);
  const rec = readRec(m);
  const v = rec.vaults[o.name];
  if (!v) throw new Error(`${o.name} was not copied into ${m} yet (run copy first)`);
  if (!v.verified.ok) throw new Error(`the copy of ${o.name} did not verify: ${v.verified.problems.join("; ")}`);
  const backup = `${o.envFile}.before-master`;
  const cur = readFileSync(o.envFile, "utf8");
  // The first switch keeps the original; a second one never overwrites it.
  if (!existsSync(backup)) writeFileSync(backup, cur);
  const set: Record<string, string> = { VC_MASTER: m, VC_VAULT: v.to, ...(v.bareTo ? { VC_BARE_REPO: v.bareTo } : {}) };
  writeFileSync(o.envFile, withEnv(cur, set));
  rec.switched = { envFile: o.envFile, backup, at: new Date().toISOString(), vault: o.name };
  writeRec(m, rec);
  // The sessions that ran in the original now run in the copy: their stored folder follows.
  const rw = rewriteMoves(rec, o.sessions, false, o.name);
  return { envFile: o.envFile, backup, set, rewritten: { sessions: rw.sessions, records: rw.records } };
}

/** Back, in one step: the env file exactly as it was before the first switch. The copy stays where it is. */
export function switchBack(o: { master: string; envFile: string; sessions?: SessionDirs }): { envFile: string; restored: boolean; rewritten: { sessions: number; records: number } } {
  const m = resolve(o.master);
  const backup = `${o.envFile}.before-master`;
  if (!existsSync(backup)) return { envFile: o.envFile, restored: false, rewritten: { sessions: 0, records: 0 } };
  writeFileSync(o.envFile, readFileSync(backup, "utf8"));
  const rec = readRec(m);
  const was = rec.switched?.vault;
  rec.switched = null;
  writeRec(m, rec);
  // And the sessions' stored folders back to the originals.
  const rw = rewriteMoves(rec, o.sessions, true, was ?? undefined);
  return { envFile: o.envFile, restored: true, rewritten: { sessions: rw.sessions, records: rw.records } };
}

export function migrationRecord(master: string): Rec {
  return readRec(resolve(master));
}
