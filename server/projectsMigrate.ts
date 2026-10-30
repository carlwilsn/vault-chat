// The move to Carl's final model (2026-10-29): one Main for the box, and every project a folder with its own
// conversation (server/context/projects.ts). Run from a shell on the box with the server STOPPED
// (`vault-chat-server.mjs projects migrate`, server/projectsCli.ts). Never deletes: every file it changes or moves
// is kept under the backup (<state>/migrations/projects-<stamp>/), and `back` puts each one back exactly.
//
// Per vault (the main one and every other vault the box has):
//   - Main: the main vault's stays Main. Another vault's old Main is hidden by the box's feed already; when it holds
//     anything, it is kept readable as an older chat ("Main (<vault>)"), its file moved to the backup.
//   - Each agent-projects/<slug>/ (not .deleted): its folder is the one the registry names, else `--map slug=path`,
//     else project.md's `folder:`, else a new folder <vault>/<its name>. Into the folder's .vault-chat/: memory.md
//     (the ## Memory lines of project.md, and memory.md, plan.md, progress.md as they were) and rules.md; the
//     instructions above ## Memory, when there are any, become its AGENTS.md (or go in memory.md when it has one).
//     The folder is registered under the same slug in the same vault, so the thread (project-<slug>, in that
//     vault's log) is its conversation, unchanged.
//   - agent-projects/ leaves the tree (the box's autosave commits that: git keeps it, the deleted projects too).
//   - The hide lists (.vaultchatignore, .vault-chat/hidden-by-default) lose the entries for paths that are not there.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { folderNameFor, PROJECT_DIR, PROJECT_NOTES_FILE, PROJECT_RULES_FILE } from "./context/projects";
import { slugify } from "./context/files";
import { FOLDERS_FILE } from "./projectFolders";
import { HIDE_DEFAULTS_FILE, HIDE_FILE, listEntries, PROJECTS_DIR } from "../src/agentProjects";

export type MigrateVault = { name: string; path: string; main: boolean };

export type Change =
  /** A file or folder that was there: its original is in the backup at `kept` (moved or copied). */
  | { kind: "changed"; path: string; kept: string }
  | { kind: "moved"; path: string; kept: string }
  /** A file the migration made (back moves it into the backup's undone/). */
  | { kind: "created"; path: string };

export type Manifest = { stamp: string; at: string; dryRun: boolean; changes: Change[]; report: string[] };

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readOr = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** What a project.md holds: its title, the instructions above ## Memory (placeholders dropped), the memory lines. */
export function splitProjectMd(text: string): { title: string | null; instructions: string; memory: string } {
  const t = /^#\s+(.+?)\s*$/m.exec(text);
  let body = t ? text.slice(0, t.index) + text.slice(t.index + t[0].length) : text;
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const m = /^##\s+Memory\s*$/im.exec(body);
  const above = m ? body.slice(0, m.index) : body;
  const memory = m ? body.slice(m.index + m[0].length).trim() : "";
  // A section that says only that nothing is written yet is no instruction.
  const sections = above.split(/^(?=##\s)/m).filter((s) => {
    const rest = s.replace(/^##\s+.*$/m, "").trim();
    return rest && !/^\((not written yet|not decided yet|none yet|no plan yet)\)$/i.test(rest);
  });
  return { title: t ? t[1]! : null, instructions: sections.join("").trim(), memory };
}

/** A file's text unless it is only a heading and a placeholder. */
function meaningful(text: string): string {
  const rest = text.replace(/^#.*$/gm, "").replace(/^\((not written yet|no plan yet|none yet)\)$/gim, "").trim();
  return rest ? text.trim() : "";
}

export type MigrateOptions = {
  vaults: MigrateVault[];
  stateDir: string;
  /** slug → folder (absolute, or relative to its vault). */
  map?: Record<string, string>;
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
};

export function migrateProjects(o: MigrateOptions): Manifest {
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const backup = join(o.stateDir, "migrations", `projects-${stamp}`);
  const man: Manifest = { stamp, at: now.toISOString(), dryRun: !!o.dryRun, changes: [], report: [] };
  const say = (s: string) => {
    man.report.push(s);
    o.log?.(s);
  };
  const keepPath = (p: string) => join(backup, "kept", resolve(p).replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, ""));
  // Before a file changes: its original into the backup (once).
  const saved = new Set<string>();
  const before = (p: string) => {
    if (saved.has(p)) return;
    saved.add(p);
    if (!existsSync(p)) {
      man.changes.push({ kind: "created", path: p });
      return;
    }
    const k = keepPath(p);
    if (!o.dryRun) {
      mkdirSync(dirname(k), { recursive: true });
      cpSync(p, k, { recursive: true });
    }
    man.changes.push({ kind: "changed", path: p, kept: k });
  };
  const write = (p: string, text: string) => {
    before(p);
    if (o.dryRun) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const moveAway = (p: string) => {
    const k = keepPath(p);
    if (!o.dryRun) {
      mkdirSync(dirname(k), { recursive: true });
      renameSync(p, k);
    }
    man.changes.push({ kind: "moved", path: p, kept: k });
  };

  for (const v of o.vaults) {
    // ---- an old Main of a vault that is not the main one
    const ev = join(v.path, ".vault-chat", "events");
    if (!v.main && existsSync(join(ev, "main.jsonl"))) {
      const text = readOr(join(ev, "main.jsonl"));
      const entries = text.split("\n").filter((l) => /"type":"entry"/.test(l)).length;
      if (entries) {
        // Kept readable: the same records under another id, an older chat titled after its vault.
        const id = `main-${slugify(v.name) || "vault"}`;
        const out = text
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              const r = JSON.parse(l);
              if (r.conv === "main") r.conv = id;
              if (r.type === "meta" && r.patch) {
                if (r.patch.kind === "main") r.patch.kind = null;
                if (typeof r.patch.title === "string") r.patch.title = `Main (${v.name})`;
              }
              return JSON.stringify(r);
            } catch {
              return l;
            }
          })
          .join("\n");
        write(join(ev, `${id}.jsonl`), out + "\n");
        say(`${v.name}: its old Main (${entries} entries) is kept readable as the older chat "Main (${v.name})"`);
      } else say(`${v.name}: its old Main was empty`);
      moveAway(join(ev, "main.jsonl"));
      if (existsSync(join(ev, "main.ckpt.json"))) moveAway(join(ev, "main.ckpt.json"));
    }

    // ---- its projects
    const ap = join(v.path, PROJECTS_DIR);
    const regFile = join(v.path, FOLDERS_FILE);
    let reg: { folders: Record<string, { path: string; at: string }>; deleted: Record<string, unknown> } = { folders: {}, deleted: {} };
    try {
      const r = JSON.parse(readOr(regFile) || "{}");
      reg = { folders: r.folders ?? {}, deleted: r.deleted ?? {} };
    } catch {
      /* none */
    }
    const regBefore = JSON.stringify(reg);
    for (const slug of isDir(ap) ? readdirSync(ap).sort() : []) {
      const dir = join(ap, slug);
      if (slug.startsWith(".") || !isDir(dir) || slug !== slugify(slug)) continue;
      const md = readOr(join(dir, "project.md"));
      const parts = splitProjectMd(md);
      const fm = /^---\r?\n[\s\S]*?^folder:\s*(.+?)\s*$/m.exec(md)?.[1]?.replace(/^["']|["']$/g, "");
      const mapped = o.map?.[slug];
      const registered = reg.folders[slug]?.path;
      const name = folderNameFor(parts.title ?? slug) || slug;
      const folder = mapped ? (isAbsolute(mapped) ? resolve(mapped) : resolve(v.path, mapped)) : registered ? resolve(registered) : fm ? resolve(v.path, fm) : join(v.path, name);
      const how = mapped ? "as mapped" : registered ? "its registered folder" : fm ? "its folder: in project.md" : "a new folder";
      if (!isDir(folder)) {
        if (mapped || registered) {
          say(`${v.name}/${slug}: SKIPPED — its folder ${folder} does not exist`);
          continue;
        }
        if (!o.dryRun) mkdirSync(folder, { recursive: true });
        man.changes.push({ kind: "created", path: folder });
      }
      const own = join(folder, PROJECT_DIR);
      // Memory: everything the project's files remembered, as it was.
      const mem: string[] = [];
      if (parts.memory) mem.push(parts.memory);
      for (const f of ["memory.md", "progress.md", "plan.md"]) {
        const t = meaningful(readOr(join(dir, f)));
        if (t) mem.push(`<!-- from agent-projects/${slug}/${f} -->\n${t.replace(/^#\s+.*\r?\n+/, "")}`);
      }
      const agentsMd = join(folder, "AGENTS.md");
      const repo = existsSync(join(folder, ".git"));
      const instrToAgents = !!parts.instructions && !existsSync(agentsMd) && !repo;
      if (parts.instructions && !instrToAgents) mem.unshift(`<!-- instructions from agent-projects/${slug}/project.md -->\n${parts.instructions}`);
      const memFile = join(own, PROJECT_NOTES_FILE);
      const oldMem = readOr(memFile).trim();
      if (mem.length || !oldMem) write(memFile, `${oldMem || `# ${basename(folder)}: memory`}\n\n${mem.join("\n\n")}\n`.replace(/\n{3,}/g, "\n\n"));
      if (instrToAgents) write(agentsMd, `# ${basename(folder)}\n\n${parts.instructions}\n`);
      const rules = readOr(join(dir, "rules.md")).trim();
      if (rules) {
        const rf = join(own, PROJECT_RULES_FILE);
        const old = readOr(rf).trim();
        write(rf, old ? `${old}\n\n${rules.replace(/^#\s+Rules\s*\r?\n+/i, "")}\n` : `${rules}\n`);
      }
      if (repo) {
        const ex = join(folder, ".git", "info", "exclude");
        const have = readOr(ex);
        if (!/^\/?\.vault-chat\/?$/m.test(have)) write(ex, `${have}${have && !have.endsWith("\n") ? "\n" : ""}/.vault-chat/\n`);
      }
      reg.folders[slug] = { path: folder, at: reg.folders[slug]?.at ?? now.toISOString() };
      say(`${v.name}/${slug} → ${folder} (${how}): memory ${mem.length ? `${mem.length} part(s)` : "empty"}${rules ? ", rules" : ""}${instrToAgents ? ", instructions → AGENTS.md" : ""}; its thread project-${slug} stays in ${v.name}'s log`);
    }
    if (JSON.stringify(reg) !== regBefore) write(regFile, JSON.stringify(reg, null, 2) + "\n");
    if (isDir(ap)) {
      const deleted = isDir(join(ap, ".deleted")) ? readdirSync(join(ap, ".deleted")) : [];
      moveAway(ap);
      say(`${v.name}: ${PROJECTS_DIR}/ left the tree${deleted.length ? ` (with its deleted projects: ${deleted.join(", ")}); git keeps them` : ""}`);
    }

    // ---- the hide lists: no entry for a path that is not there
    for (const f of [HIDE_FILE, HIDE_DEFAULTS_FILE]) {
      const p = join(v.path, f);
      const text = readOr(p);
      if (!text) continue;
      const gone = listEntries(text).filter((e) => !existsSync(join(v.path, e)) || e === PROJECTS_DIR);
      if (!gone.length) continue;
      const next = text
        .split(/\r?\n/)
        .filter((l) => {
          const e = l.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
          return !(e && !l.trim().startsWith("#") && gone.includes(e));
        })
        .join("\n");
      write(p, next);
      say(`${v.name}/${f}: dropped ${gone.join(", ")}`);
    }
  }
  if (!o.dryRun) {
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(man, null, 2));
  }
  say(o.dryRun ? "dry run: nothing changed" : `backup and manifest: ${backup}`);
  return man;
}

/** The newest migration's stamp (or none). */
export function migrations(stateDir: string): string[] {
  try {
    return readdirSync(join(stateDir, "migrations"))
      .filter((n) => n.startsWith("projects-") && existsSync(join(stateDir, "migrations", n, "manifest.json")))
      .map((n) => n.slice("projects-".length))
      .sort();
  } catch {
    return [];
  }
}

/** Undo a migration (the newest, or `stamp`): every changed file back as it was, every moved one back in place, every
 *  created one moved into the backup's undone/. Never deletes. */
export function migrateBack(o: { stateDir: string; stamp?: string; log?: (s: string) => void }): { stamp: string; restored: number; undone: number } {
  const stamp = o.stamp ?? migrations(o.stateDir).pop();
  if (!stamp) throw new Error("no projects migration to undo");
  const backup = join(o.stateDir, "migrations", `projects-${stamp}`);
  const man = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as Manifest;
  if (man.dryRun) throw new Error("that was a dry run");
  let restored = 0;
  let undone = 0;
  for (const c of [...man.changes].reverse()) {
    if (c.kind === "created") {
      if (!existsSync(c.path)) continue;
      // A folder the migration made keeps whatever was put in it since: moved aside, never removed.
      const to = join(backup, "undone", resolve(c.path).replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, ""));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(c.path, existsSync(to) ? `${to}-${Date.now()}` : to);
      undone++;
    } else if (c.kind === "moved") {
      if (existsSync(c.path)) {
        const to = join(backup, "undone", resolve(c.path).replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, ""));
        mkdirSync(dirname(to), { recursive: true });
        renameSync(c.path, existsSync(to) ? `${to}-${Date.now()}` : to);
      }
      mkdirSync(dirname(c.path), { recursive: true });
      renameSync(c.kept, c.path);
      restored++;
    } else {
      cpSync(c.kept, c.path, { recursive: true });
      restored++;
    }
  }
  writeFileSync(join(backup, "undone-at"), new Date().toISOString());
  o.log?.(`${stamp}: ${restored} restored, ${undone} made by it moved to ${join(backup, "undone")}`);
  return { stamp, restored, undone };
}

/** What the vaults hold now (status). */
export function projectsStatus(vaults: MigrateVault[]): { vault: string; agentProjects: string[]; registered: Record<string, string>; oldMain: boolean }[] {
  return vaults.map((v) => {
    let registered: Record<string, string> = {};
    try {
      registered = Object.fromEntries(Object.entries(JSON.parse(readOr(join(v.path, FOLDERS_FILE)) || "{}").folders ?? {}).map(([k, e]: [string, any]) => [k, e.path]));
    } catch {
      /* none */
    }
    const ap = join(v.path, PROJECTS_DIR);
    return { vault: v.name, agentProjects: isDir(ap) ? readdirSync(ap) : [], registered, oldMain: !v.main && existsSync(join(v.path, ".vault-chat", "events", "main.jsonl")) };
  });
}
