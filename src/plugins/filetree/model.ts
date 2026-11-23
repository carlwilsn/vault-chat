// The file tree's model (app/filetree): which folders are open, what is selected, the filter, the hidden-name
// patterns, and what the tree does to the vault's files (open, create, rename, move, hide, delete). The tree
// (./Tree.tsx), its offers (./index.tsx) and the built-in fallback (src/FileTree.tsx) all use these, so a folder the
// agent opens is open on screen and a file Carl selects is the selection the agent reads.
//
// Hidden: the vault's hide list (.vaultchatignore) holds vault-relative paths, and the box's listing marks what is
// under them (FileEntry.hidden). A line `**/<name>` is a name pattern (`*` and `?` allowed): every file or folder of
// that name, anywhere, is hidden too ("hide the assets folders"). The listing does not know those lines; the tree
// applies them (visibleItems), and the Hidden files list (Titlebar) shows and removes them like any other line.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "../../store";
import { isUnreadableAsText } from "../../fileKind";
import { commitFsAction } from "../../commit-controller";
import { entryName } from "../../entryName";

export type TreeModel = {
  /** Folders opened (absolute paths). Empty: every folder closed, the default. */
  expanded: Set<string>;
  /** The selection (absolute paths): a plain click makes it one row, Shift+Click adds or removes one. */
  selected: Set<string>;
  /** The last plain-clicked row (Shift+Click keeps it in the selection). */
  anchor: string | null;
  /** The folder new files go in (a plain click on a folder selects it; again clears it). */
  selectedDir: string | null;
  /** Only the entries whose name has this in it (and the folders they are in); "" shows the tree. */
  filter: string;
  /** The hide list's lines (.vaultchatignore), as last read. */
  hiddenLines: string[];
  /** A folder to scroll to on the next render (revealed). */
  revealing: string | null;
};

const PATTERN_KEY = (vault: string) => `vc.filetree.hidden:${vault}`;

function cachedLines(vault: string | null): string[] {
  if (!vault) return [];
  try {
    const v = JSON.parse(localStorage.getItem(PATTERN_KEY(vault)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const useTree = create<TreeModel>(() => ({
  expanded: new Set(),
  selected: new Set(),
  anchor: null,
  selectedDir: null,
  filter: "",
  hiddenLines: cachedLines(useStore.getState().vaultPath),
  revealing: null,
}));

type Listener = (name: string, data: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
/** What the tree did (opened, created, renamed, moved, deleted, hidden, unhidden), for the plugin's events. */
export function onTreeEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** A tree event from the drawn tree (an OS drop's copy). */
export const notifyTree = (name: string, data: Record<string, unknown>) => tell(name, data);
const tell = (name: string, data: Record<string, unknown>) => {
  for (const f of [...listeners]) {
    try {
      f(name, data);
    } catch {
      /* a listener's fault is its own */
    }
  }
};

const S = () => useStore.getState();
const vaultNow = () => S().vaultPath;
/** A vault path as the hide list and commits name it. */
export const relOf = (p: string, vault = vaultNow()) => (vault && p.startsWith(vault + "/") ? p.slice(vault.length + 1) : p);

// ---- hidden-name patterns -------------------------------------------------------------------------------------------

/** A hide-list line that is a name pattern ("**\/assets"): its name part, else null. */
export const patternOf = (line: string): string | null => {
  const m = /^\*\*\/([^/\\]+)$/.exec(line.trim());
  return m ? m[1] : null;
};
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
/** The name patterns' test (one regexp per pattern), or null when there are none. */
export function namePatterns(lines: readonly string[]): ((name: string) => boolean) | null {
  const res = lines.map(patternOf).filter((x): x is string => !!x).map(globRe);
  return res.length ? (name: string) => res.some((r) => r.test(name)) : null;
}

/** Read the hide list afresh (the vault changed, the listing changed, a hide or unhide). */
export async function loadHidden(vault = vaultNow()): Promise<string[]> {
  if (!vault) return [];
  let lines: string[] = [];
  try {
    lines = (await invoke<string[]>("read_ignore_lines", { vault })) ?? [];
  } catch {
    return useTree.getState().hiddenLines;
  }
  if (vault !== vaultNow()) return lines;
  const was = useTree.getState().hiddenLines;
  if (was.length !== lines.length || was.some((l, i) => l !== lines[i])) useTree.setState({ hiddenLines: lines });
  try {
    localStorage.setItem(PATTERN_KEY(vault), JSON.stringify(lines.filter((l) => patternOf(l))));
  } catch {
    /* no storage: read again next time */
  }
  return lines;
}

// A new vault: every folder closed, nothing selected, its own hide list. A new listing (a sync, a hide, the Hidden
// files list's Unhide): the hide list again, so a pattern line added or removed anywhere shows.
{
  let lastVault: string | null = vaultNow();
  let lastFiles = S().files;
  useStore.subscribe((s) => {
    if (s.vaultPath !== lastVault) {
      const first = lastVault === null;
      lastVault = s.vaultPath;
      useTree.setState({
        ...(first ? {} : { expanded: new Set<string>(), selected: new Set<string>(), anchor: null, selectedDir: null, filter: "" }),
        hiddenLines: cachedLines(s.vaultPath),
      });
      void loadHidden(s.vaultPath);
    }
    if (s.files !== lastFiles) {
      lastFiles = s.files;
      if (s.vaultPath) void loadHidden(s.vaultPath);
    }
  });
}

// ---- what shows ----------------------------------------------------------------------------------------------------

export type PendingKind = "file" | "folder";
export type TreeItem = { kind: "row"; f: FileEntry; open: boolean } | { kind: "pending"; depth: number };

/**
 * Every row the tree shows, in order: the open entries, and the new-entry row under its folder (or last, for the vault
 * root). With a filter: the entries whose name has it, and the folders they are in (shown open).
 */
export function visibleItems(
  files: readonly FileEntry[],
  expanded: ReadonlySet<string>,
  vaultPath: string | null,
  pending: { kind: PendingKind; parent: string } | null,
  filter = "",
  hiddenLines: readonly string[] = [],
): TreeItem[] {
  const out: TreeItem[] = [];
  const hiddenName = namePatterns(hiddenLines);
  const q = filter.trim().toLowerCase();
  const pendingDepth = pending && pending.parent !== vaultPath ? (files.find((f) => f.path === pending.parent)?.depth ?? 0) + 1 : 0;
  if (!q) {
    // One pass: the list is depth-first (a folder, then what is in it), so an entry shows when the folder one level up
    // both shows and is open.
    const openAt: boolean[] = [];
    for (const f of files) {
      const shown = !f.hidden && !(hiddenName && hiddenName(f.name)) && (f.depth === 0 || !!openAt[f.depth - 1]);
      const open = f.is_dir && expanded.has(f.path);
      if (f.is_dir) openAt[f.depth] = shown && open;
      if (!shown) continue;
      out.push({ kind: "row", f, open });
      if (pending && pending.parent === f.path) out.push({ kind: "pending", depth: pendingDepth });
    }
  } else {
    // The matches (not under anything hidden), then each one's folders.
    const hiddenAt: boolean[] = [];
    const keep = new Set<string>();
    const chain: FileEntry[] = [];
    for (const f of files) {
      const hid = (f.depth > 0 && !!hiddenAt[f.depth - 1]) || f.hidden || !!(hiddenName && hiddenName(f.name));
      chain.length = f.depth;
      if (f.is_dir) {
        hiddenAt[f.depth] = hid;
        chain[f.depth] = f;
      }
      if (hid || !f.name.toLowerCase().includes(q)) continue;
      keep.add(f.path);
      for (let d = 0; d < f.depth; d++) if (chain[d]) keep.add(chain[d].path);
    }
    for (const f of files) {
      if (!keep.has(f.path)) continue;
      out.push({ kind: "row", f, open: f.is_dir });
      if (pending && pending.parent === f.path) out.push({ kind: "pending", depth: pendingDepth });
    }
  }
  if (pending && pending.parent === vaultPath) out.push({ kind: "pending", depth: 0 });
  return out;
}

// ---- open, select, expand ------------------------------------------------------------------------------------------

/** A path the agent gave (vault-relative or absolute, either slash) as the tree holds it, and its entry if listed. */
export function resolvePath(raw: unknown): { path: string; entry: FileEntry | null } {
  const vault = vaultNow();
  if (!vault) throw new Error("no vault is open");
  let p = String(raw ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p || p === "." || p === vault) return { path: vault, entry: null };
  if (!p.startsWith(vault + "/")) p = `${vault}/${p.replace(/^\.?\/+/, "")}`;
  const files = S().files;
  const entry = files.find((f) => f.path === p) ?? files.find((f) => f.path.toLowerCase() === p.toLowerCase()) ?? null;
  return { path: entry?.path ?? p, entry };
}

/** Show a file in the viewer (an unreadable one by its path only), as clicking its row does. */
export async function openFile(f: Pick<FileEntry, "path" | "is_dir">): Promise<void> {
  if (f.is_dir) return;
  const content = isUnreadableAsText(f.path) ? "" : await invoke<string>("read_text_file", { path: f.path });
  S().setCurrentFile(f.path, content);
  tell("opened", { path: relOf(f.path) });
}

export const setExpanded = (fn: (prev: Set<string>) => Set<string>) => useTree.setState((s) => ({ expanded: fn(s.expanded) }));
export const toggleFolder = (path: string) =>
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
/** Open folders (and every folder they are in, so they show). */
export const expandFolders = (paths: string[]) => {
  const vault = vaultNow();
  setExpanded((prev) => {
    const next = new Set(prev);
    for (const p of paths) for (let i = p.indexOf("/", (vault?.length ?? 0) + 1); ; i = p.indexOf("/", i + 1)) {
      next.add(i < 0 ? p : p.slice(0, i));
      if (i < 0) break;
    }
    return next;
  });
};
export const collapseFolders = (paths: string[] | "all") =>
  setExpanded((prev) => (paths === "all" ? new Set() : new Set([...prev].filter((p) => !paths.some((c) => p === c || p.startsWith(c + "/"))))));

/** The selection, set (a plain click: one row, the anchor; with the folder for new files). */
export function select(paths: string[]): void {
  const last = paths[paths.length - 1] ?? null;
  const entry = last ? S().files.find((f) => f.path === last) : null;
  useTree.setState({ selected: new Set(paths), anchor: last, selectedDir: paths.length === 1 && entry?.is_dir ? last : null });
}
/** Shift+Click: the row in or out of the selection, one at a time, not a range (the anchor stays in). */
export function toggleSelection(path: string): void {
  useTree.setState((s) => {
    const next = new Set(s.selected);
    if (s.anchor && !next.has(s.anchor)) next.add(s.anchor);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { selected: next };
  });
}

/** A plain click on a row: the selection is that row; a folder opens or closes, a file opens. */
export function clickRow(f: FileEntry, shift: boolean): void {
  if (shift) return toggleSelection(f.path);
  useTree.setState((s) => ({ selected: new Set([f.path]), anchor: f.path, selectedDir: f.is_dir ? (s.selectedDir === f.path ? null : f.path) : null }));
  if (f.is_dir) toggleFolder(f.path);
  else void openFile(f).catch((e) => console.error("[tree] open failed:", e));
}

/** Reveal an entry: the folders it is in open, it selected and scrolled to (a folder stays as it is). */
export function reveal(path: string): string | null {
  const norm = (p: string) => p.split("\\").join("/").replace(/\/+$/, "");
  const want = norm(path);
  if (!want) return null;
  const files = S().files;
  const ups = files.filter((f) => f.is_dir && (norm(f.path) === want || want.startsWith(norm(f.path) + "/"))).map((f) => f.path);
  const hit = files.find((f) => norm(f.path) === want) ?? null;
  if (!ups.length && !hit) return null;
  setExpanded((s) => new Set([...s, ...ups]));
  useTree.setState({
    selectedDir: hit?.is_dir ? hit.path : null,
    revealing: hit?.path ?? null,
    ...(hit ? { selected: new Set([hit.path]), anchor: hit.path } : {}),
  });
  return hit?.path ?? null;
}

export const setFilter = (filter: string) => useTree.setState({ filter: String(filter ?? "").slice(0, 200) });

// ---- the vault's files ---------------------------------------------------------------------------------------------

export async function refreshFiles(): Promise<void> {
  const vault = vaultNow();
  if (!vault) return;
  const listed = await invoke<FileEntry[]>("list_markdown_files", { vault });
  S().setFiles(listed);
}

const commit = (msg: string) => {
  const vault = vaultNow();
  if (vault) commitFsAction(vault, msg).catch(() => {});
};

/** Re-read the open file after a rename or move, so the editor shows it under its new path. */
async function rereadCurrent(paths: string[]): Promise<void> {
  const cur = S().currentFile;
  if (!cur || !paths.includes(cur)) return;
  try {
    S().setCurrentFile(cur, isUnreadableAsText(cur) ? "" : await invoke<string>("read_text_file", { path: cur }));
  } catch (e) {
    console.error("[tree] reread current failed:", e);
  }
}

/** The open folders and the selection, after entries moved. */
function rewriteAfterMoves(moves: { from: string; to: string }[]) {
  const shift = (p: string) => {
    for (const m of moves) {
      if (p === m.from) return m.to;
      if (p.startsWith(m.from + "/")) return m.to + p.slice(m.from.length);
    }
    return p;
  };
  useTree.setState((s) => ({ expanded: new Set([...s.expanded].map(shift)), selectedDir: s.selectedDir ? shift(s.selectedDir) : null }));
}

/** Keep the hide list's paths with an entry that moved on disk (hidden descendants stay hidden). */
async function moveInHideList(from: string, to: string): Promise<void> {
  const vault = vaultNow();
  if (!vault || !from.startsWith(vault + "/") || !to.startsWith(vault + "/")) return;
  try {
    await invoke("rename_in_ignore", { vault, oldRelative: relOf(from, vault), newRelative: relOf(to, vault) });
  } catch (e) {
    console.error("[tree] update hide list failed:", e);
  }
}

/** A new file or folder in `parent`. A file without an extension gets .md, and it opens in the editor. Returns its path. */
export async function createEntry(kind: PendingKind, parent: string, rawName: string, opts: { open?: boolean } = {}): Promise<string | null> {
  const raw = entryName(rawName);
  if (!raw) return null;
  const base = parent.replace(/\/$/, "");
  if (kind === "file") {
    const path = `${base}/${/\.[^./\\]+$/.test(raw) ? raw : `${raw}.md`}`;
    await invoke("write_text_file", { path, contents: "" });
    await refreshFiles();
    if (opts.open !== false) {
      S().setCurrentFile(path, await invoke<string>("read_text_file", { path }));
      // A brand-new file is empty: there is nothing to view, so it opens in the editor. In split mode the active pane
      // carries its own mode, so that one flips rather than the global default.
      const s = S();
      if (s.activePaneId && s.panes.some((p) => p.id === s.activePaneId && p.mode !== "edit")) s.togglePaneMode(s.activePaneId);
      else if (!s.activePaneId) s.setMode("edit");
    }
    commit(`create ${relOf(path)}`);
    tell("created", { path: relOf(path), kind });
    return path;
  }
  const path = `${base}/${raw}`;
  await invoke("create_dir", { path });
  await refreshFiles();
  // git tracks files, not empty folders: no commit until the first file lands inside.
  tell("created", { path: relOf(path), kind });
  return path;
}

/** Rename an entry in place (one name: a "/" in it becomes "-"). Returns the new path, or null when nothing changed. */
export async function renameEntry(from: string, rawName: string): Promise<string | null> {
  const next = entryName(rawName) ?? "";
  const cur = from.split("/").pop() ?? "";
  if (!next || next === cur) return null;
  const to = `${from.substring(0, from.lastIndexOf("/"))}/${next}`;
  await invoke("rename_path", { from, to });
  await moveInHideList(from, to);
  // Panes, the open file and note anchors that pointed at it (or under it) follow.
  await S().applyRenameCascade([{ from, to }]);
  await rereadCurrent([to]);
  rewriteAfterMoves([{ from, to }]);
  useTree.setState((s) => (s.selected.has(from) ? { selected: new Set([...s.selected].map((p) => (p === from ? to : p))), anchor: s.anchor === from ? to : s.anchor } : {}));
  await refreshFiles();
  commit(`rename ${relOf(from)} → ${relOf(to)}`);
  tell("renamed", { from: relOf(from), to: relOf(to) });
  return to;
}

/**
 * Move entries into a folder (the vault root: the vault's path). Moves that do nothing, into itself or under itself
 * are left out. Returns the moves made.
 */
export async function moveEntries(sources: string[], dstDir: string): Promise<{ from: string; to: string }[]> {
  const vault = vaultNow();
  if (!vault) return [];
  const dstClean = dstDir.replace(/\/$/, "");
  const moves: { from: string; to: string }[] = [];
  for (const src of sources) {
    if (!src.startsWith(vault + "/") || src === dstDir || dstDir.startsWith(src + "/")) continue;
    const base = src.split("/").pop();
    if (!base) continue;
    const to = `${dstClean}/${base}`;
    if (to !== src) moves.push({ from: src, to });
  }
  if (moves.length === 0) return [];
  const done: { from: string; to: string }[] = [];
  for (const m of moves) {
    try {
      await invoke("rename_path", { from: m.from, to: m.to });
    } catch (e) {
      console.error("[move] rename failed:", m, e);
      continue;
    }
    done.push(m);
    await moveInHideList(m.from, m.to);
  }
  if (done.length > 0) {
    await S().applyRenameCascade(done);
    await rereadCurrent(done.map((m) => m.to));
  }
  rewriteAfterMoves(moves);
  useTree.setState({ selected: new Set(moves.map((m) => m.to)), anchor: moves[moves.length - 1].to });
  await refreshFiles();
  if (done.length > 0) {
    commit(done.length === 1 ? `move ${relOf(done[0].from)} → ${relOf(done[0].to)}` : `move ${done.length} items`);
    tell("moved", { moves: done.map((m) => ({ from: relOf(m.from), to: relOf(m.to) })) });
  }
  return done;
}

/** Delete entries from disk (folders with what is in them). The vault's git keeps what it had committed. */
export async function deleteEntries(paths: string[]): Promise<{ deleted: string[]; failures: { path: string; error: string }[] }> {
  const vault = vaultNow();
  const deleted: string[] = [];
  const failures: { path: string; error: string }[] = [];
  for (const p of paths) {
    try {
      await invoke("delete_file", { path: p });
      deleted.push(p);
    } catch (e) {
      console.error("[delete]", p, e);
      failures.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (deleted.length > 0) {
    const rels = vault ? deleted.filter((p) => p.startsWith(vault + "/")).map((p) => relOf(p, vault)) : [];
    if (vault && rels.length > 0) {
      try {
        await invoke("remove_prefix_from_ignore", { vault, relativePrefixes: rels });
      } catch (e) {
        console.error("[delete] prune hide list failed:", e);
      }
    }
    await S().applyDeleteCascade(deleted);
  }
  await refreshFiles();
  useTree.setState({ selected: new Set(), anchor: null });
  if (deleted.length > 0) {
    commit(deleted.length === 1 ? `delete ${relOf(deleted[0])}` : `delete ${deleted.length} items`);
    tell("deleted", { paths: deleted.map((p) => relOf(p)) });
  }
  return { deleted, failures };
}

/** Hide entries (added to the hide list). */
export async function hideEntries(paths: string[]): Promise<string[]> {
  const vault = vaultNow();
  if (!vault) return [];
  const hidden: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(vault + "/")) continue;
    try {
      await invoke("add_to_ignore", { vault, relativePath: relOf(p, vault) });
      hidden.push(relOf(p, vault));
    } catch (e) {
      console.error("[hide]", p, e);
    }
  }
  await refreshFiles();
  useTree.setState({ selected: new Set(), anchor: null });
  if (hidden.length) tell("hidden", { lines: hidden });
  return hidden;
}

/** Hide every file or folder with a name ("assets", "*.log"), anywhere in the vault: a `**\/name` line. */
export async function hideName(name: string): Promise<string> {
  const vault = vaultNow();
  if (!vault) throw new Error("no vault is open");
  const n = String(name ?? "").trim();
  if (!n || /[/\\]/.test(n) || n === "*" || n === "." || n === "..") throw new Error('a name, or a pattern of one with * and ? (no "/"; not "*" alone)');
  const line = `**/${n}`;
  await invoke("add_to_ignore", { vault, relativePath: line });
  await loadHidden(vault);
  tell("hidden", { lines: [line] });
  return line;
}

/** Show again: hide-list lines (a path or a `**\/name` pattern), as the Hidden files list's Unhide does. */
export async function unhide(lines: string[]): Promise<string[]> {
  const vault = vaultNow();
  if (!vault) throw new Error("no vault is open");
  const have = await loadHidden(vault);
  const want = lines.map((l) => String(l ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const gone = want.map((w) => have.find((h) => h === w) ?? have.find((h) => h === `**/${w}`) ?? have.find((h) => h.toLowerCase() === w.toLowerCase())).filter((x): x is string => !!x);
  if (!gone.length) return [];
  await invoke("remove_from_ignore", { vault, relativePaths: gone });
  await refreshFiles();
  await loadHidden(vault);
  tell("unhidden", { lines: gone });
  return gone;
}

/** Upload files from this laptop's disk into a vault folder (the tree's Upload…, its dialog's picks): each copied
 *  with collision-renaming (the Rust copy_into_vault), the tree re-listed, one commit. The agent's upload action is
 *  this. Returns the vault paths made. */
export async function uploadInto(parent: string, sources: string[]): Promise<string[]> {
  const vault = vaultNow();
  if (!vault) throw new Error("no vault is open");
  if (parent !== vault) setExpanded((prev) => new Set(prev).add(parent));
  const copied: string[] = [];
  for (const src of sources) {
    try {
      copied.push(await invoke<string>("copy_into_vault", { dstDir: parent, src }));
    } catch (e) {
      console.error("[upload] copy failed:", src, e);
    }
  }
  if (!copied.length) return [];
  await refreshFiles();
  commitFsAction(vault, copied.length === 1 ? `upload ${relOf(copied[0]!, vault)}` : `upload ${copied.length} items`).catch(() => {});
  tell("uploaded", { paths: copied.map((p) => relOf(p, vault)) });
  return copied;
}
