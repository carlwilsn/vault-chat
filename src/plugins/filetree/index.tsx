// The file tree plugin (Track 1; src/appPlugins.ts FILETREE_PLUGIN_ID): the left panel's tree of the open vault
// (./Tree.tsx), mounted through the plugin host (src/mountHost.ts) under the supervisor's records like the chat list,
// the composer and the vault picker. The left panel mounts it (src/FileTree.tsx); turned off or failing, a minimal
// built-in tree stands in there (open folders and files, nothing else), and while the records are unknown the tree
// itself is drawn in the app's tree.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the vault, the open folders, the selection, the filter,
// the hide list and the rows on screen as state; open, reveal, expand, collapse, select, new file / folder, rename,
// move, delete, hide (a path or every entry of a name, "assets"), unhide, filter and refresh as actions; what it did as
// events. The agent reaches them through PluginRead / PluginAct, and what they change is on screen at once (one model,
// ./model.ts). A selection in the tree is published to the shared context (api.context: {kind: "files", paths}).
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import type { Offers } from "../../pluginOffers";
import { useStore } from "../../store";
import { Tree } from "./Tree";
import {
  collapseFolders,
  createEntry,
  deleteEntries,
  expandFolders,
  hideEntries,
  hideName,
  loadHidden,
  moveEntries,
  onTreeEvent,
  openFile,
  patternOf,
  refreshFiles,
  relOf,
  renameEntry,
  resolvePath,
  reveal,
  select,
  setFilter,
  unhide,
  useTree,
  visibleItems, uploadInto } from "./model";

const S = () => useStore.getState();
/** The rows the state lists at most (a whole vault open is thousands). */
const ROWS_MAX = 400;

/** A listed entry by the agent's path, or a clear error naming what is there. */
function entryAt(raw: unknown, want?: "file" | "folder") {
  const { path, entry } = resolvePath(raw);
  if (!entry) throw new Error(`nothing at ${relOf(path) || "(the vault)"} in the tree${raw ? "" : ": a path is needed"} (paths are vault-relative, as the state lists them)`);
  if (want === "file" && entry.is_dir) throw new Error(`${relOf(path)} is a folder`);
  if (want === "folder" && !entry.is_dir) throw new Error(`${relOf(path)} is a file`);
  return entry;
}
/** A folder by the agent's path; "" or "." the vault itself. */
function folderAt(raw: unknown): string {
  const { path, entry } = resolvePath(raw);
  if (path === S().vaultPath) return path;
  if (!entry?.is_dir) throw new Error(`${relOf(path)} is not a folder in the tree`);
  return entry.path;
}
const paths = (a: Record<string, unknown>, key = "paths"): string[] => {
  const v = a[key] ?? a.path;
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
  if (!list.length) throw new Error(`${key} is needed (vault-relative paths)`);
  return list.map((p) => entryAt(p).path);
};
const rels = (ps: Iterable<string>) => [...ps].map((p) => relOf(p));

const PATH = { type: "string", description: "A vault-relative path, as the state lists it." };
const PATHS = { type: "array", items: { type: "string" }, description: "Vault-relative paths." };

/** The plugin's offers (exported for tests). */
export function fileTreeOffers(): Offers {
  return {
    watch: (fn) => {
      const offs = [useTree.subscribe(fn), useStore.subscribe(fn), onTreeEvent(() => fn())];
      return () => offs.forEach((f) => f());
    },
    state: {
      root: {
        description: "The vault the tree shows (its name and path), how many entries it lists and how many are hidden; null with no vault open.",
        read: () => {
          const v = S().vaultPath;
          if (!v) return null;
          const files = S().files;
          return { name: v.split("/").filter(Boolean).pop() ?? v, path: v, entries: files.length, hiddenEntries: files.filter((f) => f.hidden).length };
        },
      },
      expanded: { description: "The open folders (vault-relative).", read: () => rels(useTree.getState().expanded).sort() },
      selected: {
        description: "The selection (vault-relative paths; Shift+Click adds), the folder new files go in, and the file open in the viewer.",
        read: () => {
          const t = useTree.getState();
          const cur = S().currentFile;
          return { paths: rels(t.selected), folder: t.selectedDir ? relOf(t.selectedDir) : null, open: cur ? relOf(cur) : null };
        },
      },
      filter: { description: 'The filter: only names with this text (and their folders) show; "" the whole tree.', read: () => useTree.getState().filter },
      hidden: {
        description: "The hide list (.vaultchatignore): paths hidden with what is under them, and name patterns (every file or folder of that name, anywhere; a line **/<name>).",
        read: () => {
          const lines = useTree.getState().hiddenLines;
          return { paths: lines.filter((l) => !patternOf(l)), patterns: lines.map(patternOf).filter(Boolean) };
        },
      },
      rows: {
        description: `The rows the tree shows now, in order (path, dir, depth, open, and a nested git repo's markers: gitDirty = its uncommitted changes, gitWarn = why it won't sync), at most ${ROWS_MAX}, and how many there are.`,
        read: () => {
          const t = useTree.getState();
          const items = visibleItems(S().files, t.expanded, S().vaultPath, null, t.filter, t.hiddenLines);
          const rows = items.flatMap((it) => (it.kind === "row" ? [{ path: relOf(it.f.path), dir: it.f.is_dir, depth: it.f.depth, ...(it.f.is_dir ? { open: it.open } : {}), ...(it.f.git_dirty_count ? { gitDirty: it.f.git_dirty_count } : {}), ...(it.f.git_warn != null ? { gitWarn: it.f.git_warn } : {}) }] : []));
          return { count: rows.length, rows: rows.slice(0, ROWS_MAX) };
        },
      },
    },
    actions: {
      open: {
        description: "Open a file in the viewer, as clicking its row does (it is revealed and selected in the tree). A folder: revealed and opened.",
        args: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
        run: async (a) => {
          const f = entryAt(a.path);
          reveal(f.path);
          if (f.is_dir) {
            expandFolders([f.path]);
            return { revealed: relOf(f.path) };
          }
          await openFile(f);
          return { opened: relOf(f.path) };
        },
      },
      reveal: {
        description: "Show an entry: the folders it is in open, it selected and scrolled to.",
        args: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
        run: (a) => ({ revealed: relOf(reveal(entryAt(a.path).path) ?? "") }),
      },
      expand: {
        description: "Open folders (and the folders they are in).",
        args: { type: "object", properties: { paths: PATHS }, required: ["paths"], additionalProperties: false },
        run: (a) => {
          const ps = paths(a).map((p) => folderAt(p));
          expandFolders(ps);
          return { expanded: rels(useTree.getState().expanded).sort() };
        },
      },
      collapse: {
        description: "Close folders (with the folders under them); all: true closes every folder.",
        args: { type: "object", properties: { paths: PATHS, all: { type: "boolean" } }, additionalProperties: false },
        run: (a) => {
          collapseFolders(a.all === true ? "all" : paths(a).map((p) => folderAt(p)));
          return { expanded: rels(useTree.getState().expanded).sort() };
        },
      },
      select: {
        description: "Set the tree's selection (what Delete / Hide on the menu act on; shared as the context's selection). [] clears it.",
        args: { type: "object", properties: { paths: PATHS }, required: ["paths"], additionalProperties: false },
        run: (a) => {
          const ps = Array.isArray(a.paths) && a.paths.length === 0 ? [] : paths(a);
          select(ps);
          return { selected: rels(ps) };
        },
      },
      create: {
        description: "A new file or folder (in: a vault-relative folder; the vault when left out). A file without an extension gets .md and opens in the editor (open: false leaves the viewer as it is).",
        args: {
          type: "object",
          properties: { kind: { type: "string", enum: ["file", "folder"] }, name: { type: "string" }, in: PATH, open: { type: "boolean" } },
          required: ["kind", "name"],
          additionalProperties: false,
        },
        run: async (a) => {
          const parent = folderAt(a.in ?? "");
          const kind = a.kind === "folder" ? "folder" : "file";
          const path = await createEntry(kind, parent, String(a.name ?? ""), { open: a.open !== false });
          if (!path) throw new Error("a name is needed");
          if (parent !== S().vaultPath) expandFolders([parent]);
          return { created: relOf(path), kind };
        },
      },
      rename: {
        description: 'Rename a file or folder in place (to: the new name only; a "/" in it becomes "-"). Open panes and note anchors follow. Only when Carl asks.',
        args: { type: "object", properties: { path: PATH, to: { type: "string" } }, required: ["path", "to"], additionalProperties: false },
        run: async (a) => {
          const f = entryAt(a.path);
          const to = await renameEntry(f.path, String(a.to ?? ""));
          return to ? { renamed: relOf(f.path), to: relOf(to) } : { renamed: null, why: "the same name, or no usable name" };
        },
      },
      move: {
        description: "Move files or folders into a folder (to: vault-relative; \"\" the vault itself), as dragging them does. Only when Carl asks.",
        args: { type: "object", properties: { paths: PATHS, to: PATH }, required: ["paths", "to"], additionalProperties: false },
        run: async (a) => {
          const dst = folderAt(a.to);
          const done = await moveEntries(paths(a), dst);
          return { moved: done.map((m) => ({ from: relOf(m.from), to: relOf(m.to) })) };
        },
      },
      delete: {
        description: "Delete files or folders (with everything in them) from disk, only when Carl asks. There is no trash: the vault's git keeps what it had committed, and the delete is committed.",
        args: { type: "object", properties: { paths: PATHS }, required: ["paths"], additionalProperties: false },
        run: async (a) => {
          const { deleted, failures } = await deleteEntries(paths(a));
          if (!deleted.length && failures.length) throw new Error(failures.map((f) => `${relOf(f.path)}: ${f.error}`).join("; "));
          return { deleted: rels(deleted), ...(failures.length ? { failed: failures.map((f) => ({ path: relOf(f.path), error: f.error })) } : {}) };
        },
      },
      hide: {
        description:
          'Hide from the tree (the Hidden files list shows them again): paths (with what is under them), or name: every file or folder of that name anywhere ("assets"; * and ? allowed, e.g. "*.log").',
        args: { type: "object", properties: { paths: PATHS, name: { type: "string" } }, additionalProperties: false },
        run: async (a) => {
          if (typeof a.name === "string" && a.name.trim()) return { hidden: [await hideName(a.name)] };
          return { hidden: await hideEntries(paths(a)) };
        },
      },
      unhide: {
        description: "Show again what the hide list hides: its lines as the hidden state lists them (a path, or a name pattern).",
        args: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
        run: async (a) => {
          const lines = Array.isArray(a.lines) ? a.lines.map(String) : [];
          const gone = await unhide(lines);
          if (!gone.length) throw new Error(`not in the hide list: ${lines.join(", ")} (it has: ${useTree.getState().hiddenLines.join(", ") || "nothing"})`);
          return { unhidden: gone };
        },
      },
      setFilter: {
        description: 'Filter the tree to names with this text (and their folders), shown with a bar to clear it; "" shows the whole tree.',
        args: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        run: (a) => {
          setFilter(String(a.text ?? ""));
          return { filter: useTree.getState().filter };
        },
      },
      upload: {
        description: "Upload files from this laptop's disk into a vault folder, as the tree's Upload… does (each copied, renamed on a clash; one commit): sources are absolute laptop paths; into a vault folder (left out: the selected folder, else the vault). Only when Carl asks.",
        args: { type: "object", properties: { sources: { type: "array", items: { type: "string" } }, into: PATH }, required: ["sources"], additionalProperties: false },
        run: async (a) => {
          const v = S().vaultPath;
          if (!v) throw new Error("no vault is open");
          const dir = a.into !== undefined ? entryAt(a.into) : null;
          if (dir && !dir.is_dir) throw new Error(`${relOf(dir.path)} is not a folder`);
          const srcs = Array.isArray(a.sources) ? a.sources.map(String) : [];
          if (!srcs.length) throw new Error("sources: the laptop paths to upload");
          const made = await uploadInto(dir?.path ?? useTree.getState().selectedDir ?? v, srcs);
          if (!made.length) throw new Error("nothing was copied (see the app's log)");
          return { uploaded: made.map((p) => relOf(p)) };
        },
      },
      refresh: {
        description: "List the vault's files again (as the title bar's refresh does).",
        run: async () => {
          await refreshFiles();
          await loadHidden();
          return { entries: S().files.length };
        },
      },
    },
    events: {
      opened: { description: "A file was opened from the tree: path." },
      created: { description: "A file or folder was made: path, kind." },
      renamed: { description: "An entry was renamed: from, to." },
      moved: { description: "Entries were moved: moves [{from, to}]." },
      deleted: { description: "Entries were deleted: paths." },
      hidden: { description: "Hide-list lines were added: lines." },
      unhidden: { description: "Hide-list lines were removed: lines." },
      selected: { description: "The selection changed: paths." },
      uploaded: { description: "Files from the laptop's disk were copied in (Upload…, an OS drop): paths, or into and files." },
    },
  };
}

/** The offers, headless: mounted in every layout (src/places.ts "offers"), drawn or not. */
export const offers = { mount: mountOffers };

function mountOffers(_el: HTMLElement, api: PluginApi): void {
  const offers = api.offer(fileTreeOffers());
  api.effect(onTreeEvent((name, data) => offers.emit(name, data)));
  // The selection, to the shared context (and as an event): a file or folder Carl selects is what other plugins and
  // the agent see as selected. Cleared only if it is still the tree's.
  let last = useTree.getState().selected;
  api.effect(
    useTree.subscribe((s) => {
      if (s.selected === last) return;
      last = s.selected;
      const ps = [...s.selected];
      if (ps.length) api.context.publish({ selection: { kind: "files", paths: ps } });
      else if (api.context.get().selection?.kind === "files") api.context.publish({ selection: null });
      offers.emit("selected", { paths: rels(ps) });
    }),
  );
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  // A render error the tree does not catch is the plugin's failure (src/FileTree.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // Drawn right after the app's commit (before the browser paints: the left panel never lacks it), unmounted outside it.
  let alive = true;
  queueMicrotask(() => alive && flushSync(() => root.render(<Tree />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
