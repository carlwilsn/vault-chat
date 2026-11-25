// A vault file named in the chat, drawn as a chip: in the composer (an @-reference, src/plugins/composer), in Carl's
// sent messages (his @name) and in the agent's replies (a markdown link to a vault file, src/plugins/chat-rows). A small
// line icon of the file's type and its name on a faint fill (--file-chip-bg / --file-chip-bg-hover, per theme in
// src/App.css), the full path on hover. Carl approved the look ("Chip, Filled") from a mockup.
//
// What it does goes through the actions the agent has, never a path of its own: a click opens the file the way the
// agent's Show does (src/showOnLaptop.ts); the right-click menu's Open beside is box:workspace openInPane in the other
// pane, Show in files is box:workspace openLeftPanel and the tree's reveal (app/filetree reveal), Copy path copies it.
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { File, FileCode, FileText, Film, Folder, Globe, Image, Music, Table } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { fileKind } from "./fileKind";
import { findVaultFileByTail } from "./linkNav";
import { localPathFromUrl } from "./mdPipeline";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"]);
const DATA_EXTS = new Set(["csv", "tsv", "json", "jsonl", "xlsx", "xls", "yaml", "yml", "toml", "parquet"]);

/** A file's type as a line icon (a folder, or the file's kind), drawn in the text colour. */
export function FileTypeIcon({ path, isDir = false, className }: { path: string; isDir?: boolean; className?: string }) {
  const cls = className;
  if (isDir) return <Folder className={cls} />;
  const { kind, ext } = fileKind(path);
  if (AUDIO_EXTS.has(ext)) return <Music className={cls} />;
  if (DATA_EXTS.has(ext)) return <Table className={cls} />;
  if (kind === "markdown" || kind === "pdf" || kind === "tex" || kind === "notebook" || ext === "txt") return <FileText className={cls} />;
  if (kind === "image") return <Image className={cls} />;
  if (kind === "video") return <Film className={cls} />;
  if (kind === "html") return <Globe className={cls} />;
  if (kind === "code") return <FileCode className={cls} />;
  return <File className={cls} />;
}

const slash = (p: string) => p.replace(/\\/g, "/");

/** A path inside the open vault as vault-relative ("" when it is not inside). */
export function relInVault(path: string, vault: string | null = useStore.getState().vaultPath): string {
  if (!vault) return "";
  const v = slash(vault).replace(/\/+$/, "").toLowerCase();
  const p = slash(path);
  return p.toLowerCase().startsWith(v + "/") ? p.slice(v.length + 1) : "";
}

const indexes = new WeakMap<object, Map<string, FileEntry>>();
/** The vault's entries by lowercase path, built once per file list. */
function filesByPath(files: FileEntry[]): Map<string, FileEntry> {
  let m = indexes.get(files);
  if (!m) {
    m = new Map(files.map((f) => [slash(f.path).toLowerCase(), f]));
    indexes.set(files, m);
  }
  return m;
}

/** The vault file (or folder) a link, a path or an @name points at, as its laptop path; null when it names none. A path
 *  from elsewhere (the box's copy of the vault, another machine) is matched by its longest tail that is a vault file. */
export function resolveVaultFile(ref: string): { path: string; isDir: boolean } | null {
  const s = useStore.getState();
  if (!s.vaultPath || !ref) return null;
  // A web address or another scheme is no file (a drive letter and file: are).
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-zA-Z]:[\\/]/.test(ref) && !/^file:/i.test(ref)) return null;
  const cleaned = slash(localPathFromUrl(ref)).replace(/\/+$/, "");
  if (!cleaned || cleaned.startsWith("#")) return null;
  const byPath = filesByPath(s.files);
  const hit = (p: string) => byPath.get(p.toLowerCase());
  const abs = /^([a-zA-Z]:\/|\/)/.test(cleaned);
  const direct = abs ? hit(cleaned) : hit(`${slash(s.vaultPath)}/${cleaned.replace(/^\.\//, "")}`);
  if (direct) return { path: direct.path, isDir: direct.is_dir };
  const parts = cleaned.split("/").filter(Boolean);
  for (let i = abs ? 1 : 0; i < parts.length; i++) {
    const tail = parts.slice(i).join("/");
    const f = hit(`${slash(s.vaultPath)}/${tail}`);
    if (f) return { path: f.path, isDir: f.is_dir };
  }
  const t = findVaultFileByTail(cleaned);
  return t ? { path: t, isDir: false } : null;
}

/** What a chip's click and menu do: the agent's own actions. Tests swap these. */
export const chipIO = {
  /** Open in the viewer, as the agent's Show does (in place of the active pane's file). */
  async open(rel: string): Promise<void> {
    const { showOnLaptop } = await import("./showOnLaptop");
    const a = await showOnLaptop({ type: "show", id: "", to: "laptop", path: rel });
    if (!a.ok) console.warn("[chip] open:", a.error);
  },
  /** Open in the other pane (box:workspace openInPane). */
  async beside(rel: string): Promise<void> {
    const s = useStore.getState();
    const active = s.panes.findIndex((p) => p.id === s.activePaneId);
    const pane = s.panes.length >= 2 && active === 1 ? "left" : "right";
    const { layoutOnLaptop } = await import("./layoutOnLaptop");
    const a = await layoutOnLaptop({ type: "layout", id: "", ops: [{ op: "openInPane", path: rel, pane }] });
    if (!a.ok) console.warn("[chip] open beside:", a.error);
  },
  /** The file panel open (box:workspace openLeftPanel) and the entry revealed in the tree (app/filetree reveal). */
  async reveal(path: string): Promise<void> {
    const { layoutOnLaptop } = await import("./layoutOnLaptop");
    if (useStore.getState().leftCollapsed) await layoutOnLaptop({ type: "layout", id: "", ops: [{ op: "openLeftPanel" }] });
    const { reveal } = await import("./plugins/filetree/model");
    reveal(path);
  },
  async copy(text: string): Promise<void> {
    await navigator.clipboard?.writeText(text);
  },
};

type Menu = { x: number; y: number } | null;

/** One chip. `path` is the laptop path of a vault file or folder; `label` defaults to its name. */
export function FileChip({ path, isDir = false, label, className }: { path: string; isDir?: boolean; label?: ReactNode; className?: string }) {
  const [menu, setMenu] = useState<Menu>(null);
  const rel = relInVault(path) || slash(path);
  const name = slash(path).split("/").pop() ?? path;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const run = (f: () => Promise<void>) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    void f().catch((err) => console.error("[chip]", err));
  };
  const open = () => (isDir ? chipIO.reveal(path) : chipIO.open(rel));
  return (
    <>
      <span
        data-offer="box:workspace.openInPane"
        role="link"
        tabIndex={0}
        className={className ? `file-chip ${className}` : "file-chip"}
        data-el="file-chip"
        data-path={rel}
        title={rel}
        onClick={run(open)}
        onKeyDown={(e) => {
          if (e.key === "Enter") run(open)(e as unknown as ReactMouseEvent);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <FileTypeIcon path={path} isDir={isDir} className="file-chip-ic" />
        <span className="file-chip-name">{label ?? name}</span>
      </span>
      {menu &&
        createPortal(
          <div
            className="fixed z-[80] rounded-md border border-border bg-card shadow-lg py-1 text-[12.5px]"
            data-el="file-chip-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 130) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button data-offer="box:workspace.openInPane" className="file-chip-item" onClick={run(open)}>
              Open
            </button>
            {!isDir && (
              <button data-offer="box:workspace.openInPane" className="file-chip-item" onClick={run(() => chipIO.beside(rel))}>
                Open beside
              </button>
            )}
            <button data-offer="app/filetree.reveal" className="file-chip-item" onClick={run(() => chipIO.reveal(path))}>
              Show in files
            </button>
            <button data-offer-exempt="Copy path: puts a path on Carl's clipboard; the agent reads the path from the chat itself" className="file-chip-item" onClick={run(() => chipIO.copy(rel))}>
              Copy path
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
