// Moving projects out of the vaults into the projects home (server/projectsHome.ts), safely and reversibly. Run with
// the server stopped (`vault-chat-server.mjs projects migrate …`, server/masterCli.ts); it never deletes anything.
//
// For each vault, each project in <vault>/agent-projects/<slug>/ (and each deleted one in .deleted/):
//   copy     its folder (project.md: Carl's instructions and its memory; rules.md) to <home>/<slug>/;
//   folder   its registered folder (the vault's .vault-chat/local/project-folders.json) into the home's registry; a
//            project.md `folder:` inside the vault becomes that folder's absolute path there (it stays its working folder);
//   thread   its conversation (<vault>/.vault-chat/events/project-<slug>.jsonl) into the home's log, its records
//            renumbered above the home's sequence, every pi session file it points to copied into
//            <home>/.vault-chat/sessions/ (each session's stored cwd rewritten when its folder moved), the engine's
//            record of its pi thread (<pi>/instr/<id>.json) where the main engine reads it;
//   verify   the copied thread folds to the same items as the original (ids, roles, text), and every file copied is
//            the same bytes;
//   hide     only then the originals go to <vault>/.vault-chat/local/moved-projects/<stamp>/ (out of git, out of the
//            agent's reach, never deleted).
// A slug already in the home is left where it is, reported. `back` undoes one migration: the originals back where they
// were, the home's copies of them set aside in <home>/.vault-chat/local/rolled-back/<stamp>/.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConvLog } from "./convlog/log";
import { migrateLegacyProjects } from "./context/layout";
import { readRegistryFile } from "./projectFolders";
import { ensureHome, homeLayout } from "./projectsHome";
import { movePrefix, sessionHeader, setSessionCwd } from "./sessionPaths";

const PROJECTS_DIR = "agent-projects";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECORD = "migrated-projects.json";

export type VaultIn = {
  /** The vault's working copy. */
  path: string;
  /** Its engine's pi sessions and thread records (main vault: <state>/pi; another: <state>/vaults/<name>/pi). */
  piSessions: string;
  piInstr: string;
};

export type MigrateOpts = {
  home: string;
  vaults: VaultIn[];
  /** Where the main engine (which runs every project thread now) reads its thread records: <state>/pi/instr. */
  mainInstr: string;
  /** The main vault (a project with no folder of its own runs there). */
  mainVault: string;
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
  /** A vault's work area (server/workArea.ts): a git project's clone (<area>/changes/<slug>) moves to the main vault's. */
  workArea?: (vault: string) => string;
};

export type MovedProject = {
  vault: string;
  slug: string;
  deleted?: string;
  folder: string | null;
  thread: { records: number; items: number; sessions: string[] } | null;
};

export type MigrateResult = {
  ok: boolean;
  stamp: string;
  moved: MovedProject[];
  skipped: { vault: string; slug: string; why: string }[];
  problems: string[];
  hiddenAt: Record<string, string>;
};

type Rec = {
  runs: Array<{
    stamp: string;
    at: string;
    vaults: Array<{ vault: string; hidden: string; slugs: string[]; deleted: string[]; threads: string[]; sessions: string[]; instr: string[]; registry: Record<string, string>; clones?: string[]; reviews?: string[]; media?: string[] }>;
  }>;
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (p: string, v: unknown) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

function readRec(home: string): Rec {
  const r = readJson(join(homeLayout(home).local, RECORD));
  return { runs: Array.isArray(r?.runs) ? r.runs : [] };
}

/** The same tree, byte for byte: every file's path and sha-256 (one file in memory at a time; symlinks by target). */
function sameTree(a: string, b: string): string | null {
  const walk = (d: string, base: string, out: Map<string, string>) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.set(relative(base, p), `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p, base, out);
      else out.set(relative(base, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
    return out;
  };
  const x = walk(a, a, new Map());
  const y = walk(b, b, new Map());
  if (x.size !== y.size) return `${x.size} files in ${a}, ${y.size} in ${b}`;
  for (const [k, v] of x) if (y.get(k) !== v) return `${k} differs`;
  return null;
}

/** project.md's front matter `folder:` (vault-relative), or null. */
function folderOf(md: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const m = fm && /^folder:\s*(.+?)\s*$/m.exec(fm[1]!);
  const v = m ? m[1]!.replace(/^["']|["']$/g, "").trim() : "";
  return v || null;
}

/** A conversation's items as compared: id, role/kind and text (what Carl sees). */
function itemsKey(log: ConvLog, id: string): { n: number; key: string } {
  const p = log.picture(id);
  const items = (p?.items ?? []).map((i: any) => [i.id, i.role ?? i.kind ?? "", String(i.text ?? i.content ?? "").slice(0, 400)]);
  return { n: items.length, key: JSON.stringify(items) };
}

/** Open a log read-mostly: its seq floor file as it was is put back after (opening one reserves a block). */
function openLog(vault: string, dir: string): { log: ConvLog; close: () => void } {
  const seqFile = join(dir, "_seq");
  const had = existsSync(seqFile) ? readFileSync(seqFile, "utf8") : null;
  const log = new ConvLog(vault, null, dir);
  return {
    log,
    close: () => {
      if (had === null) return;
      writeFileSync(seqFile, had);
    },
  };
}

/** Rewrite every string in `v` that the map names. */
function mapStrings(v: any, map: Map<string, string>): any {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, map));
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = mapStrings(x, map);
    return o;
  }
  return v;
}

export function migrateProjects(o: MigrateOpts): MigrateResult {
  const log = o.log ?? ((s: string) => console.log(`[projects-migrate] ${s}`));
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const H = o.dryRun ? homeLayout(o.home) : ensureHome(o.home);
  const out: MigrateResult = { ok: true, stamp, moved: [], skipped: [], problems: [], hiddenAt: {} };
  const rec = readRec(o.home);
  const run: Rec["runs"][number] = { stamp, at: now.toISOString(), vaults: [] };
  // The home's registry, merged into (never an entry overwritten).
  const reg = readRegistryFile(H.registry);

  // The home's log: the next seq above everything it holds.
  let nextSeq = 1;
  if (!o.dryRun) {
    const { log: hl } = openLog(o.home, H.events);
    nextSeq = hl.latest() + 1;
    for (const f of ["_seq", "_clock"]) {
      const v = Number((existsSync(join(H.events, f)) ? readFileSync(join(H.events, f), "utf8") : "0").trim()) || 0;
      nextSeq = Math.max(nextSeq, v + 1);
    }
  }

  for (const v of o.vaults) {
    const V = resolve(v.path);
    if (!o.dryRun) migrateLegacyProjects(V, log);
    const src = join(V, PROJECTS_DIR);
    const vReg = readRegistryFile(join(V, ".vault-chat", "local", "project-folders.json"));
    const events = join(V, ".vault-chat", "events");
    const hidden = join(V, ".vault-chat", "local", "moved-projects", stamp);
    const done = { vault: V, hidden, slugs: [] as string[], deleted: [] as string[], threads: [] as string[], sessions: [] as string[], instr: [] as string[], registry: {} as Record<string, string>, clones: [] as string[], reviews: [] as string[], media: [] as string[] };
    // A git project's clone (the agent's branches, its work in progress) and a change waiting for Carl's Keep: the main
    // engine runs the project now, in the main vault's work area.
    const fromArea = o.workArea ? o.workArea(V) : null;
    const toArea = o.workArea ? o.workArea(o.mainVault) : null;
    const cloneMoves: [string, string][] = [];
    const names = isDir(src) ? readdirSync(src).sort() : [];
    const slugs = names.filter((n) => SLUG.test(n) && isDir(join(src, n)));
    const deleted = isDir(join(src, ".deleted")) ? readdirSync(join(src, ".deleted")).filter((n) => isDir(join(src, ".deleted", n))) : [];
    const threadFiles = existsSync(events) ? readdirSync(events).filter((n) => /^project-[a-z0-9-]+\.jsonl$/.test(n)) : [];
    if (!slugs.length && !deleted.length && !threadFiles.length) {
      log(`${V}: no projects`);
      continue;
    }
    // Copy files first; nothing of the original moves until every copy verified.
    let vaultOk = true;
    const problem = (s: string) => {
      out.problems.push(`${V}: ${s}`);
      vaultOk = false;
    };

    for (const slug of slugs) {
      const from = join(src, slug);
      const to = join(H.home, slug);
      if (existsSync(to)) {
        out.skipped.push({ vault: V, slug, why: `${to} exists already` });
        continue;
      }
      // Its working folder: the vault's registry, else project.md's `folder:` inside the vault.
      let folder: string | null = vReg.folders[slug]?.path ?? null;
      const md = existsSync(join(from, "project.md")) ? readFileSync(join(from, "project.md"), "utf8") : "";
      const fm = folderOf(md);
      if (!folder && fm) {
        const abs = resolve(V, fm);
        const rel = relative(V, abs);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel) && isDir(abs)) folder = abs;
        else log(`${slug}: its folder "${fm}" is not a folder in ${V}: no working folder recorded`);
      }
      if (reg.folders[slug] && folder && reg.folders[slug]!.path !== folder) {
        out.skipped.push({ vault: V, slug, why: `the home's registry already gives ${slug} the folder ${reg.folders[slug]!.path}` });
        continue;
      }
      const moved: MovedProject = { vault: V, slug, folder, thread: null };
      if (!o.dryRun) {
        cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        const diff = sameTree(from, to);
        if (diff) problem(`${slug}: the copy differs (${diff})`);
        if (folder) {
          reg.folders[slug] = { path: folder, at: vReg.folders[slug]?.at ?? now.toISOString() };
          done.registry[slug] = folder;
        }
      }
      done.slugs.push(slug);
      out.moved.push(moved);
      if (fromArea && toArea && resolve(fromArea) !== resolve(toArea)) {
        const a = join(fromArea, "changes", slug);
        const b = join(toArea, "changes", slug);
        if (isDir(a)) {
          if (existsSync(b)) out.skipped.push({ vault: V, slug, why: `its clone ${a} stays: ${b} exists already` });
          else cloneMoves.push([a, b]);
        }
      }
    }
    if (!o.dryRun)
      for (const [a, b] of cloneMoves) {
        mkdirSync(dirname(b), { recursive: true });
        cpSync(a, b, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        const diff = sameTree(a, b);
        if (diff) problem(`the clone ${a}: its copy differs (${diff})`);
        done.clones.push(b);
      }
    for (const entry of deleted) {
      const to = join(H.deleted, entry);
      if (existsSync(to)) {
        out.skipped.push({ vault: V, slug: entry, why: `${to} exists already` });
        continue;
      }
      if (!o.dryRun) {
        mkdirSync(H.deleted, { recursive: true });
        cpSync(join(src, ".deleted", entry), to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        const diff = sameTree(join(src, ".deleted", entry), to);
        if (diff) problem(`.deleted/${entry}: the copy differs (${diff})`);
        const d = vReg.deleted[entry];
        if (d && !reg.deleted[entry]) reg.deleted[entry] = d;
      }
      done.deleted.push(entry);
      out.moved.push({ vault: V, slug: entry.replace(/-\d{8}-\d{6}(?:-\d+)?$/, ""), deleted: entry, folder: vReg.deleted[entry]?.path ?? null, thread: null });
    }

    // The threads: every project-<slug>.jsonl of this vault whose project moved (or was deleted: its thread stays restorable).
    const movedSlugs = new Set([...done.slugs, ...out.moved.filter((m) => m.vault === V && m.deleted).map((m) => m.slug)]);
    const skippedSlugs = new Set(out.skipped.filter((s) => s.vault === V).map((s) => s.slug));
    for (const f of threadFiles) {
      const id = f.replace(/\.jsonl$/, "");
      const slug = id.slice("project-".length);
      if (skippedSlugs.has(slug)) continue;
      if (!movedSlugs.has(slug)) log(`${id}: its project is gone from ${PROJECTS_DIR}/; its thread moves too (it stays readable)`);
      if (existsSync(join(H.events, f))) {
        out.skipped.push({ vault: V, slug, why: `the home's log already has ${id}` });
        continue;
      }
      const lines = readFileSync(join(events, f), "utf8").split("\n").filter(Boolean);
      const recs = lines.flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      // The session files it points to: pi's (in the vault engine's sessions folder) and its own (in the feed's folder).
      const map = new Map<string, string>();
      const copies: [string, string][] = [];
      const fileOf = (p: string) => (isAbsolute(p) ? p : resolve(events, p));
      for (const r of recs) {
        for (const p of [r.type === "entry" ? r.file : null, r.type === "meta" ? r.patch?.threadPath : null]) {
          if (typeof p !== "string" || !p || map.has(p)) continue;
          const abs = fileOf(p);
          const inEvents = !isAbsolute(p);
          const target = inEvents ? join(H.events, p) : join(H.sessions, basename(abs));
          map.set(p, inEvents ? p : target);
          if (existsSync(abs)) copies.push([abs, target]);
        }
      }
      const moved = out.moved.find((m) => m.vault === V && m.slug === slug && !m.deleted) ?? out.moved.find((m) => m.vault === V && m.slug === slug);
      const sessions = copies.map(([, t]) => t);
      if (moved) moved.thread = { records: recs.length, items: 0, sessions };
      else out.moved.push({ vault: V, slug, folder: null, thread: { records: recs.length, items: 0, sessions } });
      if (o.dryRun) {
        done.threads.push(id);
        continue;
      }
      for (const [a, t] of copies) {
        if (existsSync(t)) {
          if (!readFileSync(a).equals(readFileSync(t))) problem(`${id}: ${t} exists and differs from ${a}`);
          continue;
        }
        mkdirSync(dirname(t), { recursive: true });
        cpSync(a, t, { preserveTimestamps: true, errorOnExist: true, force: false });
        done.sessions.push(t);
      }
      // A session that ran in the vault while its project's folder is elsewhere now keeps its own stored folder
      // unless that is gone (the engine heals it at resume: server/sessionPaths.ts); one that ran under another
      // vault's path runs in the main vault now.
      if (resolve(V) !== resolve(o.mainVault)) for (const t of sessions) {
        const h = sessionHeader(t);
        const next = h && typeof h.cwd === "string" ? movePrefix(h.cwd, V, o.mainVault) : null;
        if (next && !moved?.folder) setSessionCwd(t, next);
      }
      // A session that ran in the old clone: in the new one.
      for (const [a, b] of cloneMoves)
        for (const t of sessions) {
          const h = sessionHeader(t);
          const next = h && typeof h.cwd === "string" ? movePrefix(h.cwd, a, b) : null;
          if (next) setSessionCwd(t, next);
        }
      const renumbered = recs.map((r) => mapStrings({ ...r, seq: nextSeq++ }, map));
      writeFileSync(join(H.events, f), renumbered.map((r) => JSON.stringify(r)).join("\n") + "\n");
      done.threads.push(id);
      // The engine's record of its pi thread, where the main engine reads it.
      for (const r of recs) {
        const tid = r.type === "meta" ? r.patch?.threadId : null;
        if (typeof tid !== "string" || !tid) continue;
        const from = join(v.piInstr, `${tid}.json`);
        const to = join(o.mainInstr, `${tid}.json`);
        if (resolve(from) === resolve(to) || !existsSync(from) || existsSync(to)) continue;
        const j = readJson(from);
        if (j && typeof j.instr === "string" && existsSync(j.instr) && resolve(dirname(j.instr)) === resolve(v.piInstr)) {
          const ti = join(o.mainInstr, basename(j.instr));
          if (!existsSync(ti)) cpSync(j.instr, ti);
          j.instr = ti.split("\\").join("/");
        }
        if (j && typeof j.cwd === "string" && !moved?.folder) j.cwd = movePrefix(j.cwd, V, o.mainVault) ?? j.cwd;
        for (const [a, b] of cloneMoves) if (j && typeof j.cwd === "string") j.cwd = movePrefix(j.cwd, a, b) ?? j.cwd;
        writeJson(to, j);
        done.instr.push(to);
      }
    }

    if (o.dryRun) {
      run.vaults.push(done);
      continue;
    }
    writeJson(H.registry, reg);
    // The images a project thread shows (proof cards, captures, Show), vault-relative: the main vault's now (only what
    // it lacks is added; nothing is overwritten, the second vault keeps its own).
    if (resolve(V) !== resolve(o.mainVault) && done.threads.length) {
      for (const rel of [".vault-chat/proof", ".vault-chat/captures", ".vault-chat/visuals", ".vault-chat/local/captures"]) {
        const a = join(V, rel);
        if (!isDir(a)) continue;
        cpSync(a, join(o.mainVault, rel), { recursive: true, preserveTimestamps: true, force: false, errorOnExist: false });
        done.media = [...(done.media ?? []), rel];
      }
    }
    // A change waiting for Carl's Keep (server/projectChanges.ts reviews.json, by conversation): the main vault's now.
    if (resolve(V) !== resolve(o.mainVault)) {
      const from = readJson(join(V, ".vault-chat", "local", "reviews.json")) ?? {};
      const toFile = join(o.mainVault, ".vault-chat", "local", "reviews.json");
      const to = readJson(toFile) ?? {};
      for (const [id, r] of Object.entries<any>(from)) {
        if (!done.threads.includes(id) || to[id]) continue;
        for (const [a, b] of cloneMoves) if (typeof r?.clone === "string") r.clone = movePrefix(r.clone, a, b) ?? r.clone;
        to[id] = r;
        done.reviews.push(id);
      }
      if (done.reviews.length) writeJson(toFile, to);
    }
    // Verify each thread: the copy folds to the same items as the original.
    if (done.threads.length) {
      const oldL = openLog(V, events);
      const newL = openLog(o.home, H.events);
      try {
        for (const id of done.threads) {
          const a = itemsKey(oldL.log, id);
          const b = itemsKey(newL.log, id);
          const m = out.moved.find((x) => x.vault === V && `project-${x.slug}` === id && x.thread);
          if (m?.thread) m.thread.items = b.n;
          if (a.key !== b.key) problem(`${id}: the copied thread shows ${b.n} item(s), the original ${a.n}`);
        }
      } finally {
        oldL.close();
        newL.close();
      }
    }
    // The home's sequence floor: above every record now in its log.
    for (const f of ["_seq", "_clock"]) writeFileSync(join(H.events, f), String(nextSeq + 1000));
    if (!vaultOk) {
      out.ok = false;
      log(`${V}: NOT hidden (a copy did not verify); the originals are untouched`);
      run.vaults.push({ ...done, hidden: "" });
      continue;
    }
    // Hide the originals (out of git and the agent's reach; never deleted).
    mkdirSync(hidden, { recursive: true });
    if (isDir(src)) renameSync(src, join(hidden, PROJECTS_DIR));
    for (const f of readdirSync(events)) {
      if (!/^project-[a-z0-9-]+\.(jsonl|ckpt\.json)$/.test(f)) continue;
      const id = f.replace(/\.(jsonl|ckpt\.json)$/, "");
      if (!done.threads.includes(id)) continue;
      mkdirSync(join(hidden, "events"), { recursive: true });
      renameSync(join(events, f), join(hidden, "events", f));
    }
    const vr = join(V, ".vault-chat", "local", "project-folders.json");
    if (existsSync(vr)) renameSync(vr, join(hidden, "project-folders.json"));
    out.hiddenAt[V] = hidden;
    run.vaults.push(done);
    log(`${V}: ${done.slugs.length} project(s), ${done.deleted.length} deleted, ${done.threads.length} thread(s) moved; originals in ${hidden}`);
  }
  if (!o.dryRun && run.vaults.length) {
    rec.runs.push(run);
    writeJson(join(H.local, RECORD), rec);
  }
  return out;
}

/** Undo the last migration (or the one stamped): the originals back, the home's copies of them set aside. */
export function migrateBack(o: { home: string; stamp?: string; log?: (s: string) => void }): { ok: boolean; stamp: string | null; restored: string[]; problems: string[] } {
  const log = o.log ?? ((s: string) => console.log(`[projects-migrate] ${s}`));
  const H = homeLayout(o.home);
  const rec = readRec(o.home);
  const run = o.stamp ? rec.runs.find((r) => r.stamp === o.stamp) : rec.runs[rec.runs.length - 1];
  if (!run) return { ok: false, stamp: null, restored: [], problems: ["no migration recorded"] };
  const aside = join(H.local, "rolled-back", run.stamp);
  const problems: string[] = [];
  const restored: string[] = [];
  const reg = readRegistryFile(H.registry);
  const move = (a: string, b: string) => {
    if (!existsSync(a)) return;
    if (existsSync(b)) {
      problems.push(`${b} exists: ${a} left where it is`);
      return;
    }
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
  };
  for (const v of run.vaults) {
    for (const slug of v.slugs) {
      move(join(H.home, slug), join(aside, "projects", slug));
      delete reg.folders[slug];
    }
    for (const e of v.deleted) move(join(H.deleted, e), join(aside, "deleted", e));
    for (const id of v.threads) {
      move(join(H.events, `${id}.jsonl`), join(aside, "events", `${id}.jsonl`));
      move(join(H.events, `${id}.ckpt.json`), join(aside, "events", `${id}.ckpt.json`));
    }
    for (const s of v.sessions) move(s, join(aside, "sessions", basename(s)));
    for (const c of v.clones ?? []) move(c, join(aside, "clones", basename(c)));
    for (const i of v.instr) move(i, join(aside, "instr", basename(i)));
    if (v.hidden && existsSync(v.hidden)) {
      move(join(v.hidden, PROJECTS_DIR), join(v.vault, PROJECTS_DIR));
      const ev = join(v.hidden, "events");
      if (existsSync(ev)) for (const f of readdirSync(ev)) move(join(ev, f), join(v.vault, ".vault-chat", "events", f));
      move(join(v.hidden, "project-folders.json"), join(v.vault, ".vault-chat", "local", "project-folders.json"));
    }
    restored.push(v.vault);
    log(`${v.vault}: its projects are back in ${PROJECTS_DIR}/ (the home's copies in ${aside})`);
  }
  writeJson(H.registry, reg);
  rec.runs = rec.runs.filter((r) => r !== run);
  writeJson(join(H.local, RECORD), rec);
  return { ok: problems.length === 0, stamp: run.stamp, restored, problems };
}

/** The vaults that still hold projects of their own (agent-projects/<slug>/, a deleted one, a project thread in their log). */
export function vaultsWithProjects(vaults: string[]): string[] {
  return vaults.filter((v) => {
    const src = join(v, PROJECTS_DIR);
    const ev = join(v, ".vault-chat", "events");
    const slugs = isDir(src) ? readdirSync(src).filter((n) => (SLUG.test(n) || n === ".deleted") && isDir(join(src, n))) : [];
    const deleted = slugs.includes(".deleted") ? readdirSync(join(src, ".deleted")).length > 0 : false;
    const threads = isDir(ev) ? readdirSync(ev).some((n) => /^project-[a-z0-9-]+\.jsonl$/.test(n)) : false;
    return slugs.some((n) => n !== ".deleted") || deleted || threads;
  });
}

/** Whether `projects migrate` has run into this home (its record): from then on the home is the projects' place. */
export function migratedInto(home: string): boolean {
  return readRec(home).runs.length > 0;
}

/**
 * At boot: the projects home is used once the migration ran, or when no vault holds projects of its own (a new box).
 * Until then each vault keeps its projects where they were (an update never hides them before the move).
 */
export function projectsMode(home: string, vaults: string[]): { mode: "home" | "vaults"; waiting: string[] } {
  const waiting = vaultsWithProjects(vaults);
  if (migratedInto(home) || !waiting.length) return { mode: "home", waiting };
  return { mode: "vaults", waiting };
}
