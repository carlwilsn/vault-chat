// The folder picker (the titlebar's folder name; Carl, 2026-10-29): everything is a folder in the vault-chat folder.
// Two tabs:
//   - Vaults: every folder — the vaults and the repos under projects/, and every project's folder (one inside a vault
//     shows where it is). Picking one opens it in the file tree; the conversations stay as they are.
//   - Projects: the folders with a conversation of their own. Picking one opens its folder and its thread.
// A ⋯ on hover (or right-click) on a row: Rename, Delete, and on a folder that is not a project "Make this a project".
// Deleting a project asks what goes: its conversation (the folder stays, a plain folder again), or everything.
// Nothing is hard-deleted: the box commits a folder before removing it in git (server/folderOps.ts).
import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, MoreHorizontal, Plus } from "lucide-react";
import { useStore } from "./store";
import { joinPath, localProjects, localVaults, masterPath, newVault } from "./master";
import { openVaultAt } from "./openVault";
import { createProjectThread, deleteProject, folderAction, listProjects, openThread, renameProject, type ProjectInfo } from "./projects";
import { projectThreadId } from "./threads";
import { cn } from "./lib/utils";

const fwd = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** One row of the picker. `rel`: the folder relative to the vault-chat folder; `repo`: the top-level folder that holds it
 *  (what the laptop opens); `where`: for a folder inside one, the folders above it; `project`: its project, if any. */
export type FolderRow = { rel: string; name: string; repo: string; where: string | null; project: ProjectInfo | null };

/** The rows of both tabs, from this laptop's folder and the box's projects. Pure. */
export function folderRows(vaults: string[], repos: string[], projects: ProjectInfo[]): { vaults: FolderRow[]; projects: FolderRow[] } {
  const byRel = new Map(projects.filter((p) => p.rel).map((p) => [p.rel!, p]));
  const top: FolderRow[] = [
    ...vaults.map((n) => ({ rel: `vaults/${n}`, name: n, repo: `vaults/${n}`, where: null, project: byRel.get(`vaults/${n}`) ?? null })),
    ...repos.map((n) => ({ rel: `projects/${n}`, name: n, repo: `projects/${n}`, where: null, project: byRel.get(`projects/${n}`) ?? null })),
  ];
  const tops = new Set(top.map((r) => r.rel));
  const nested: FolderRow[] = projects
    .filter((p) => p.rel && !tops.has(p.rel))
    .map((p) => {
      const parts = p.rel!.split("/");
      return { rel: p.rel!, name: p.name, repo: parts.slice(0, 2).join("/"), where: parts.slice(1, -1).join(" / ") || null, project: p };
    });
  const all = [...top, ...nested].sort((a, b) =>
    a.repo === b.repo ? (a.rel === a.repo ? -1 : b.rel === b.repo ? 1 : a.name.localeCompare(b.name)) : a.repo.localeCompare(b.repo),
  );
  const withProjects = projects.map(
    (p) => all.find((r) => r.project?.slug === p.slug) ?? { rel: p.rel ?? "", name: p.name, repo: p.rel?.split("/").slice(0, 2).join("/") ?? "", where: null, project: p },
  );
  return { vaults: all, projects: withProjects.sort((a, b) => a.name.localeCompare(b.name)) };
}

type Tab = "vaults" | "projects";

export function VaultPicker() {
  const vaultPath = useStore((s) => s.vaultPath);
  const activeId = useStore((s) => s.activeConversationId);
  const [isOpen, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("vaults");
  const [rows, setRows] = useState<{ vaults: FolderRow[]; projects: FolderRow[] }>({ vaults: [], projects: [] });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ rel: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const m = masterPath();

  const load = () => {
    void Promise.all([localVaults(m), localProjects(m), listProjects(useStore.getState().vaultPath)]).then(([v, p, pr]) => setRows(folderRows(v, p, pr)));
  };

  const close = () => {
    setOpen(false);
    setNaming(false);
    setName("");
    setErr(null);
    setMenu(null);
    setRenaming(null);
    setDeleting(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    load();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("vc-projects-changed", load);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("vc-projects-changed", load);
    };
  }, [isOpen, vaultPath, m]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu || renaming || deleting) {
        setMenu(null);
        setRenaming(null);
        setDeleting(null);
      } else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, menu, renaming, deleting]);

  /** Open a row's folder: its top-level folder here, and a folder inside it revealed in the tree. */
  const openFolder = async (r: FolderRow) => {
    if (!m || !r.repo) return;
    await openVaultAt(joinPath(m, r.repo));
    if (r.rel !== r.repo) window.dispatchEvent(new CustomEvent("vc-reveal-folder", { detail: { path: joinPath(m, r.rel) } }));
  };
  const pick = async (r: FolderRow, t: Tab) => {
    close();
    await openFolder(r);
    // A project: its conversation too. A plain folder: the conversations stay as they are.
    if (t === "projects" && r.project) openThread(projectThreadId(r.project.slug), r.project.name);
  };
  const create = async () => {
    const r = await newVault(name);
    if ("error" in r) return setErr(r.error);
    close();
    await openVaultAt(r.path);
  };
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true);
    const r = await fn().catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }));
    setBusy(false);
    setErr(r.ok ? null : (r.error ?? "it did not work"));
    if (r.ok) load();
    return r.ok;
  };
  const rename = async (r: FolderRow, to: string) => {
    const want = to.trim();
    setRenaming(null);
    if (!want || want === r.name) return;
    await act(() => (r.project ? renameProject(r.project.slug, want) : folderAction("rename", r.rel, want)));
  };
  const makeProject = async (r: FolderRow) => {
    setMenu(null);
    if (await act(() => createProjectThread(r.name, { folder: r.rel }))) {
      setTab("projects");
    }
  };
  const remove = async (r: FolderRow, folderToo: boolean) => {
    const ok = await act(() => (r.project ? deleteProject(r.project.slug, { folder: folderToo }) : folderAction("delete", r.rel)));
    if (!ok) return;
    setDeleting(null);
    // The folder that was open is gone: back to the one that held it.
    if (folderToo && m && vaultPath && r.rel === r.repo && fwd(vaultPath).toLowerCase() === fwd(joinPath(m, r.rel)).toLowerCase()) {
      const other = rows.vaults.find((x) => x.rel !== r.rel && x.rel === x.repo);
      if (other) await openVaultAt(joinPath(m, other.repo));
    }
  };

  const openPath = vaultPath ? fwd(vaultPath).toLowerCase() : null;
  const isOpenRow = (r: FolderRow) => !!openPath && !!m && r.rel === r.repo && fwd(joinPath(m, r.repo)).toLowerCase() === openPath;
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;
  const list = tab === "vaults" ? rows.vaults : rows.projects;
  const rowCls = "group relative w-full h-7 pl-2.5 pr-1 flex items-center gap-2 rounded text-[12px] text-left hover:bg-accent/60";
  const item = "w-full text-left px-3 py-1 hover:bg-accent disabled:opacity-50";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => (isOpen ? close() : setOpen(true))}
        data-el="vault-picker"
        className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-accent/60 text-[12px] text-foreground/90"
        title="Change folder"
      >
        <FolderOpen className="h-3.5 w-3.5 opacity-80" />
        <span className="max-w-[220px] truncate">{vaultName ?? "Open folder"}</span>
      </button>
      {isOpen && (
        <div data-el="vault-picker-menu" className="absolute left-0 top-8 z-50 w-72 rounded-md border border-border bg-popover shadow-lg p-1">
          {!m ? (
            <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">Set the vault-chat folder in Settings to list your folders here.</div>
          ) : (
            <div className="flex items-center gap-1 px-1 pb-1 mb-1 border-b border-border/60" data-el="picker-tabs">
              {(["vaults", "projects"] as const).map((t) => (
                <button
                  key={t}
                  data-el={`picker-tab-${t}`}
                  onClick={() => {
                    setTab(t);
                    setMenu(null);
                    setDeleting(null);
                    setRenaming(null);
                  }}
                  className={cn("h-6 px-2 rounded text-[11.5px]", tab === t ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/50")}
                >
                  {t === "vaults" ? "Vaults" : "Projects"}
                </button>
              ))}
            </div>
          )}
          <div className="max-h-[60vh] overflow-auto">
            {m && !list.length && (
              <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">{tab === "vaults" ? "No folders yet." : "No projects yet: ⋯ on a folder makes it one."}</div>
            )}
            {list.map((r) =>
              renaming?.rel === r.rel ? (
                <div key={r.rel} className="px-1.5 py-1">
                  <input
                    autoFocus
                    data-el="picker-rename-input"
                    value={renaming.value}
                    onChange={(e) => setRenaming({ rel: r.rel, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(r, renaming.value);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => setRenaming(null)}
                    className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
                  />
                </div>
              ) : (
                <div key={r.rel}>
                  <div
                    role="button"
                    data-el="vault-picker-item"
                    data-path={m ? joinPath(m, r.rel) : r.rel}
                    data-rel={r.rel}
                    data-project={r.project?.slug ?? ""}
                    className={cn(rowCls, "cursor-pointer")}
                    onClick={() => void pick(r, tab)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu(r.rel);
                    }}
                  >
                    <span className="w-3.5 shrink-0">
                      {(tab === "vaults" ? isOpenRow(r) : !!r.project && activeId === projectThreadId(r.project.slug)) && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="truncate flex-1 min-w-0">
                      {r.name}
                      {r.where && <span className="ml-1.5 text-[10.5px] text-muted-foreground">in {r.where}</span>}
                    </span>
                    {tab === "vaults" && r.project && (
                      <span className="text-[10px] text-muted-foreground/80 shrink-0" data-el="picker-is-project">
                        project
                      </span>
                    )}
                    <button
                      data-el="picker-row-menu"
                      title="More"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(menu === r.rel ? null : r.rel);
                      }}
                      className={cn("h-6 w-6 shrink-0 flex items-center justify-center rounded hover:bg-accent text-muted-foreground", menu === r.rel ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                    {menu === r.rel && (
                      <div
                        data-el="picker-row-menu-list"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-1 top-7 z-50 min-w-[160px] py-1 rounded-md border border-border bg-popover shadow-md text-[12px]"
                      >
                        <button data-el="picker-rename" className={item} onClick={() => (setMenu(null), setRenaming({ rel: r.rel, value: r.name }))}>
                          Rename
                        </button>
                        {!r.project && (
                          <button data-el="picker-make-project" disabled={busy} className={item} onClick={() => void makeProject(r)}>
                            Make this a project
                          </button>
                        )}
                        <button data-el="picker-delete" className={cn(item, "text-destructive")} onClick={() => (setMenu(null), setDeleting(r))}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {deleting?.rel === r.rel && (
                    <div data-el="picker-delete-confirm" className="mx-1 mb-1 mt-0.5 px-2.5 py-2 rounded-md border border-border bg-muted/40 text-[11.5px]">
                      {r.project ? (
                        <>
                          <div>
                            Delete project <span className="font-medium">{r.name}</span>? Git keeps a copy either way.
                          </div>
                          <div className="mt-1.5 flex flex-col gap-1">
                            <button data-el="picker-delete-conversation" disabled={busy} onClick={() => void remove(r, false)} className="h-6 px-2 rounded text-left hover:bg-accent">
                              Remove the conversation, keep the folder
                            </button>
                            <button data-el="picker-delete-everything" disabled={busy} onClick={() => void remove(r, true)} className="h-6 px-2 rounded text-left text-destructive hover:bg-accent">
                              Delete everything, the folder too
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            Delete <span className="font-medium">{r.name}</span>? Git keeps a copy.
                          </div>
                          <button data-el="picker-delete-yes" disabled={busy} onClick={() => void remove(r, true)} className="h-6 px-2.5 rounded text-destructive hover:bg-accent">
                            Delete
                          </button>
                        </div>
                      )}
                      <div className="mt-1 flex justify-end">
                        <button data-el="picker-delete-cancel" disabled={busy} onClick={() => setDeleting(null)} className="h-6 px-2 rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
          {m &&
            tab === "vaults" &&
            (naming ? (
              <div className="px-1.5 py-1">
                <input
                  autoFocus
                  data-el="vault-picker-new-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim()) void create();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setNaming(false);
                    }
                  }}
                  placeholder="New vault's name, then Enter"
                  className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
                />
              </div>
            ) : (
              <button data-el="vault-picker-new" className={cn(rowCls, "border-t border-border mt-1 pt-1")} onClick={() => setNaming(true)}>
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                <span>New vault</span>
              </button>
            ))}
          {err && (
            <div className="px-2.5 py-1 text-[11px] text-destructive" data-el="picker-error">
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
