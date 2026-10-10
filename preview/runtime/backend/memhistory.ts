// The readable-history commands (src-tauri/src/history.rs) over the in-memory
// git: the same grouping (sessions by actor/machine/conversation with a
// 10-minute gap, app state filtered, mission keeps as one entry, restore /
// undo / redo as their own entries) and the same one-commit actions. Undo
// here is per note: a note reverts only if it still reads as the entry left
// it; otherwise the whole undo is refused with that note listed as a conflict
// and nothing changes (real git's merge-tree also merges non-overlapping
// lines; the clone does not need to).

import * as fs from "../shims/memfs";
import { stat, unifiedPatch } from "./diff";
import { commitsOf, headOf, makeCommitFor, type Commit } from "./memgit";

const GAP_S = 600;
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type Cls = { kind: string; actor: string; machine: string | null; conv: string | null; mission: string | null; undoes: string | null; restores: string | null };
type File = { path: string; status: "A" | "M" | "D"; add: number; del: number };
type Entry = {
  id: string;
  kind: string;
  actor: string;
  machine: string | null;
  title: string;
  summary: string | null;
  start: number;
  end: number;
  commits: string[];
  base: string;
  files: File[];
  conversation_id: string | null;
  mission_id: string | null;
  cost_usd: number | null;
  undone_by: string | null;
  undoes: string | null;
  restores: string | null;
  inner: { hash: string; time: number; subject: string }[];
  noise: boolean;
};

const isNoise = (p: string) => p === ".vault-chat" || p.startsWith(".vault-chat/") || /(^|\/)\.git(ignore|attributes|modules)$/.test(p);

function trailers(c: Commit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of c.body.split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(l.trim());
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function classify(c: Commit): Cls {
  const t = trailers(c);
  const a = t["vault-chat-actor"];
  const actor = a === "agent" ? "agent" : a === "mission" ? "mission" : a ? "human" : c.subject.startsWith("[agent]") || c.author === "vault-chat-agent" ? "agent" : "human";
  const undoes = t["undoes"] ?? null;
  const restores = t["restores"] ?? null;
  const kind = undoes ? (c.subject.startsWith("Redo:") ? "redo" : "undo") : restores || c.subject.startsWith("Restore ") || c.subject.startsWith("Restore:") ? "restore" : "session";
  return { kind, actor, machine: t["vault-chat-machine"] ?? null, conv: t["conversation"] ?? null, mission: t["mission-id"] ?? null, undoes, restores };
}

const txt = (v: string | undefined | null) => (v == null ? null : v.startsWith("\0bin:") ? "" : v);

function filesOf(c: Commit): File[] {
  const before = c.parent?.tree ?? new Map<string, string>();
  const out: File[] = [];
  for (const p of [...new Set([...before.keys(), ...c.tree.keys()])].sort()) {
    const a = before.get(p) ?? null;
    const b = c.tree.get(p) ?? null;
    if (a === b) continue;
    const s = stat(txt(a), txt(b));
    out.push({ path: p, status: a === null ? "A" : b === null ? "D" : "M", add: s.additions, del: s.deletions });
  }
  return out;
}

function net(cs: Commit[] /* oldest first */, noise: boolean): File[] {
  const acc = new Map<string, { first: string; last: string; add: number; del: number }>();
  for (const c of cs)
    for (const f of filesOf(c)) {
      if (!noise && isNoise(f.path)) continue;
      const e = acc.get(f.path) ?? { first: f.status, last: f.status, add: 0, del: 0 };
      e.last = f.status;
      e.add += f.add;
      e.del += f.del;
      acc.set(f.path, e);
    }
  const out: File[] = [];
  for (const [path, e] of acc) {
    if (e.first === "A" && e.last === "D") continue;
    out.push({ path, status: e.first === "A" ? "A" : e.last === "D" ? "D" : "M", add: e.add, del: e.del });
  }
  return out;
}

const leaf = (p: string) => p.split("/").pop() ?? p;
function filesTitle(files: File[]): string {
  if (!files.length) return "No note changes";
  const verb = files.every((f) => f.status === "A") ? "Created" : files.every((f) => f.status === "D") ? "Deleted" : "Edited";
  const names = [...files].sort((a, b) => b.add + b.del - (a.add + a.del)).slice(0, 2).map((f) => leaf(f.path));
  return `${verb} ${names.join(", ")}${files.length > 2 ? ` +${files.length - 2}` : ""}`;
}

const secs = (c: Commit) => Math.floor(c.at / 1000);

function entries(vault: string, includeNoise = false): Entry[] {
  const all = commitsOf(vault);
  const out: Entry[] = [];
  const undoers = new Map<string, string>();
  const finalize = (e: Entry) => {
    e.undone_by = undoers.get(e.id) ?? null;
    if (e.undoes && !e.undone_by) undoers.set(e.undoes, e.id);
    out.push(e);
  };
  let open: { cls: Cls; noise: boolean; cs: Commit[] } | null = null; // cs newest first
  const close = () => {
    if (!open) return;
    const { cls, noise, cs } = open;
    open = null;
    const old = [...cs].reverse();
    const files = net(old, noise);
    finalize({
      id: cs[0].hash,
      kind: cls.kind,
      actor: cls.actor,
      machine: cls.machine,
      title: cls.kind === "session" ? (noise ? `App state · ${cs[0].subject}` : filesTitle(files)) : cs[0].subject,
      summary:
        cls.kind !== "session"
          ? cs[0].subject
          : cls.actor === "agent"
            ? (cs.find((c) => c.subject.startsWith("[agent]"))?.subject.replace(/^\[agent\]\s*/, "") ?? null)
            : null,
      start: secs(old[0]),
      end: secs(cs[0]),
      commits: old.map((c) => c.hash),
      base: old[0].parent?.hash ?? EMPTY,
      files,
      conversation_id: cls.conv,
      mission_id: cls.mission,
      cost_usd: null,
      undone_by: null,
      undoes: cls.undoes,
      restores: cls.restores,
      inner: [],
      noise,
    });
  };
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i];
    if (c.inner) continue; // inside a mission keep
    if (c.merge) {
      close();
      const inner: Commit[] = [];
      for (let j = i - 1; j >= 0 && all[j].inner; j--) inner.unshift(all[j]);
      const t = trailers(c);
      finalize({
        id: c.hash,
        kind: "mission",
        actor: "mission",
        machine: t["vault-chat-machine"] ?? null,
        title: c.subject.replace(/^Mission:\s*/, ""),
        summary: null,
        start: secs(inner[0] ?? c),
        end: secs(c),
        commits: [c.hash],
        base: (inner[0] ?? c).parent?.hash ?? EMPTY,
        files: net(inner, false),
        conversation_id: t["conversation"] ?? null,
        mission_id: t["mission-id"] ?? null,
        cost_usd: t["cost-usd"] ? Number(t["cost-usd"].replace("$", "")) : null,
        undone_by: null,
        undoes: null,
        restores: null,
        inner: [...inner].reverse().map((x) => ({ hash: x.hash, time: secs(x), subject: x.subject })),
        noise: false,
      });
      continue;
    }
    const cls = classify(c);
    const noise = !filesOf(c).some((f) => !isNoise(f.path));
    if (noise && !includeNoise) continue;
    const o = open as { cls: Cls; noise: boolean; cs: Commit[] } | null;
    if (
      o &&
      o.cls.kind === "session" &&
      cls.kind === "session" &&
      o.noise === noise &&
      o.cls.actor === cls.actor &&
      o.cls.machine === cls.machine &&
      (cls.actor !== "agent" || o.cls.conv === cls.conv) &&
      secs(o.cs[o.cs.length - 1]) - secs(c) <= GAP_S
    ) {
      o.cs.push(c);
      continue;
    }
    close();
    open = { cls, noise, cs: [c] };
  }
  close();
  return out;
}

function byHash(vault: string, h: string): Commit | null {
  return commitsOf(vault).find((c) => c.hash === h || c.hash.startsWith(h)) ?? null;
}

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function writeNote(vault: string, rel: string, v: string | null) {
  const full = `${vault}/${rel}`;
  if (v === null) fs.rmSync(full, { force: true });
  else if (!v.startsWith("\0bin:")) fs.seedText(full, v, Date.now());
}

function undo(vault: string, id: string, redo: boolean) {
  const es = entries(vault);
  const e = es.find((x) => x.id === id || x.id.startsWith(id));
  if (!e) throw `No history entry ${id}`;
  if (redo && e.kind !== "undo" && e.kind !== "redo") throw "Only an undo can be redone.";
  if (e.undone_by) throw "This change was already undone.";
  const base = byHash(vault, e.base)?.tree ?? new Map<string, string>();
  const after = byHash(vault, e.commits[e.commits.length - 1])!.tree;
  const head = headOf(vault)!.tree;
  const conflicts: string[] = [];
  const changes: Array<[string, string | null]> = [];
  for (const f of e.files) {
    const b = base.get(f.path) ?? null;
    const a = after.get(f.path) ?? null;
    const cur = head.get(f.path) ?? null;
    if (cur === b) continue;
    if (cur !== a) conflicts.push(f.path);
    else changes.push([f.path, b]);
  }
  if (conflicts.length) return { ok: false, commit: null, conflicts: conflicts.sort(), changed_paths: [] };
  if (!changes.length) throw "Nothing to undo: those changes are already gone.";
  const tree = new Map(headOf(vault)!.tree);
  for (const [p, v] of changes) {
    writeNote(vault, p, v);
    if (v === null) tree.delete(p);
    else tree.set(p, v);
  }
  const orig = e.title.replace(/^(Undo|Redo):\s*/, "");
  const title = e.kind === "undo" ? `Redo: ${orig}` : e.kind === "redo" ? `Undo: ${orig}` : `Undo: ${e.title}`;
  const c = makeCommitFor(vault, title, tree, `Undoes: ${e.id}\nVault-Chat-Actor: human\nVault-Chat-Machine: laptop`);
  return { ok: true, commit: c.hash, conflicts: [], changed_paths: changes.map(([p]) => p) };
}

export const historyCommands: Record<string, (a: Record<string, any>) => unknown> = {
  history_timeline: ({ vault, cursor, limit, includeNoise, path }) => {
    let es = entries(vault, !!includeNoise);
    if (path) es = es.filter((e) => e.files.some((f) => f.path === path));
    const start = cursor ? Number(String(cursor).split("@").pop()) || 0 : 0;
    const n = Math.max(1, Math.min(limit ?? 40, 500));
    const head = headOf(vault)?.hash ?? "";
    return { entries: es.slice(start, start + n), next_cursor: es.length > start + n ? `${head.slice(0, 12)}@${start + n}` : null, head };
  },
  history_note_versions: ({ vault, path, cursor, limit }) => {
    const all = commitsOf(vault).filter((c) => !c.merge && (c.parent?.tree.get(path) ?? null) !== (c.tree.get(path) ?? null));
    const owner = new Map<string, string>();
    for (const e of entries(vault)) for (const h of [...e.commits, ...e.inner.map((x) => x.hash)]) owner.set(h, e.id);
    const groups: { cls: Cls; cs: Commit[] }[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const c = all[i];
      const cls = classify(c);
      const g = groups[groups.length - 1];
      if (g && g.cls.kind === "session" && cls.kind === "session" && g.cls.actor === cls.actor && g.cls.machine === cls.machine && secs(g.cs[g.cs.length - 1]) - secs(c) <= GAP_S) g.cs.push(c);
      else groups.push({ cls, cs: [c] });
    }
    const start = cursor ? Number(String(cursor).replace("skip:", "")) || 0 : 0;
    const n = Math.max(1, Math.min(limit ?? 30, 200));
    const versions = groups.slice(start, start + n).map(({ cls, cs }) => {
      let add = 0;
      let del = 0;
      for (const c of cs)
        for (const f of filesOf(c))
          if (f.path === path) {
            add += f.add;
            del += f.del;
          }
      return {
        entry_id: owner.get(cs[0].hash) ?? cs[0].hash,
        hash: cs[0].hash,
        time: secs(cs[0]),
        start: secs(cs[cs.length - 1]),
        actor: cls.actor,
        machine: cls.machine,
        kind: cls.kind,
        summary: cls.actor === "agent" ? (cs.find((c) => c.subject.startsWith("[agent]"))?.subject.replace(/^\[agent\]\s*/, "") ?? null) : cls.kind !== "session" ? cs[0].subject : null,
        add,
        del,
        commits: cs.length,
        deleted: !cs[0].tree.has(path),
      };
    });
    return { versions, next_cursor: groups.length > start + n ? `skip:${start + n}` : null };
  },
  history_file_at: ({ vault, hash, path }) => txt(byHash(vault, hash)?.tree.get(path)) ?? "",
  history_diff: ({ vault, hash, path, against, base }) => {
    const c = byHash(vault, hash);
    if (!c) throw `bad revision ${hash}`;
    const ver = txt(c.tree.get(path));
    if ((against ?? "disk") === "disk") return unifiedPatch(path, fs.readText(`${vault}/${path}`), ver);
    const from = base ? byHash(vault, base) : c.parent;
    return unifiedPatch(path, txt(from?.tree.get(path)), ver);
  },
  history_restore_note: ({ vault, path, hash }) => {
    if (isNoise(path)) throw "History never restores app state (.vault-chat/).";
    const c = byHash(vault, hash);
    if (!c) throw `bad revision ${hash}`;
    const v = c.tree.get(path) ?? null;
    if ((headOf(vault)?.tree.get(path) ?? null) === v && (fs.readText(`${vault}/${path}`) ?? null) === v) throw "This note is already at that version.";
    writeNote(vault, path, v);
    const tree = new Map(headOf(vault)!.tree);
    if (v === null) tree.delete(path);
    else tree.set(path, v);
    const nc = makeCommitFor(vault, `Restore ${path} to ${fmtLocal(c.at)}`, tree, `Restores: ${c.hash}\nVault-Chat-Actor: human\nVault-Chat-Machine: laptop`);
    return { commit: nc.hash, reloaded_paths: [path] };
  },
  history_undo_entry: ({ vault, entryId }) => undo(vault, entryId, false),
  history_redo_entry: ({ vault, undoEntryId }) => undo(vault, undoEntryId, true),
};
