// The titlebar picker lists only vault folders. Main and projects stay in ChatsPanel.
// Folder/project operations retain their existing recoverable deletion semantics.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FolderOpen, MoreHorizontal, Plus } from "lucide-react";
import { useStore } from "./store";
import { joinPath, localVaults, masterPath, newVault } from "./master";
import { openVaultAt } from "./openVault";
import { createProjectThread, deleteProject, folderAction, listProjects, renameProject, type ProjectInfo } from "./projects";
import { cn } from "./lib/utils";

/** Windows paths are case-insensitive; distinct POSIX vault paths must not share a checkmark. */
export const pickerPathKey = (p: string) => {
  const path = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
};

/** A vault folder relative to the vault-chat folder, with existing operation metadata only. */
export type FolderRow = { rel: string; name: string; repo: string; project: ProjectInfo | null };

/** Vault identities come from localVaults, not the project registry or name deduplication.
 * Project metadata is retained only for the existing operations on a vault that is itself a project. */
export function folderRows(vaults: string[], projects: ProjectInfo[]): FolderRow[] {
  const byRel = new Map(projects.filter((p) => p.rel).map((p) => [p.rel!, p]));
  return vaults.map((n) => ({ rel: `vaults/${n}`, name: n, repo: `vaults/${n}`, project: byRel.get(`vaults/${n}`) ?? null }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

export function VaultPicker() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [isOpen, setOpen] = useState(false);
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ rel: string; left: number; top: number } | null>(null);
  const [renaming, setRenaming] = useState<{ rel: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const m = masterPath();

  const dismissActions = () => {
    setMenu(null);
    actionTrigger.current?.focus();
  };
  const showActions = (r: FolderRow, trigger: HTMLButtonElement) => {
    if (menu?.rel === r.rel) return dismissActions();
    actionTrigger.current = trigger;
    const parent = ref.current?.querySelector('[data-el="vault-picker-menu"]')?.getBoundingClientRect();
    const row = trigger.getBoundingClientRect();
    if (!parent) return;
    // A separate body portal beside the picker, never inside its scrolling list.
    const width = 176;
    const rightFits = parent.right + width + 8 <= window.innerWidth;
    const leftFits = parent.left - width - 8 >= 8;
    const left = rightFits ? parent.right + 8 : leftFits ? parent.left - width - 8 : Math.max(8, Math.min(parent.left, window.innerWidth - width - 8));
    const top = rightFits || leftFits ? Math.max(8, Math.min(row.top, window.innerHeight - 120)) : parent.bottom + 8;
    setMenu({ rel: r.rel, left, top });
  };

  useEffect(() => {
    if (!menu) return;
    actionRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = () => setMenu(null);
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [menu]);

  const load = () => {
    void Promise.all([localVaults(m), listProjects(useStore.getState().vaultPath)]).then(([v, pr]) => setRows(folderRows(v, pr)));
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
      if (actionRef.current?.contains(e.target as Node)) return;
      if (ref.current && !ref.current.contains(e.target as Node)) close();
      else if (!actionTrigger.current?.contains(e.target as Node)) setMenu(null);
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
        if (menu) dismissActions();
        setRenaming(null);
        setDeleting(null);
      } else {
        close();
        ref.current?.querySelector<HTMLButtonElement>('[data-el="vault-picker"]')?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, menu, renaming, deleting]);

  const pick = async (r: FolderRow) => {
    close();
    if (m) await openVaultAt(joinPath(m, r.repo));
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
    await act(() => createProjectThread(r.name, { folder: r.rel }));
  };
  const remove = async (r: FolderRow, folderToo: boolean) => {
    const ok = await act(() => (r.project ? deleteProject(r.project.slug, { folder: folderToo }) : folderAction("delete", r.rel)));
    if (!ok) return;
    setDeleting(null);
    // The folder that was open is gone: back to the one that held it.
    if (folderToo && m && vaultPath && r.rel === r.repo && pickerPathKey(vaultPath) === pickerPathKey(joinPath(m, r.rel))) {
      const other = rows.find((x) => x.rel !== r.rel && x.rel === x.repo);
      if (other) await openVaultAt(joinPath(m, other.repo));
    }
  };

  const openPath = vaultPath ? pickerPathKey(vaultPath) : null;
  const isOpenRow = (r: FolderRow) => !!openPath && !!m && r.rel === r.repo && pickerPathKey(joinPath(m, r.repo)) === openPath;
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;
  const list = rows;
  const rowCls = "group relative w-full h-7 pl-2.5 pr-1 flex items-center gap-2 rounded text-[12px] text-left hover:bg-accent/60";
  const item = "w-full text-left px-3 py-1 hover:bg-accent disabled:opacity-50";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => (isOpen ? close() : setOpen(true))}
        data-el="vault-picker"
        className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-accent/60 text-[12px] text-foreground/90"
        title="Change vault"
        aria-expanded={isOpen}
      >
        <FolderOpen className="h-3.5 w-3.5 opacity-80" />
        <span className="max-w-[220px] truncate">{vaultName ?? "Open folder"}</span>
      </button>
      {isOpen && (
        <div data-el="vault-picker-menu" className="absolute left-0 top-8 z-50 w-72 rounded-md border border-border bg-popover shadow-lg p-1">
          {!m && (
            <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">Set the vault-chat folder in Settings to list your vaults here.</div>
          )}
          <div className="max-h-[60vh] overflow-auto" onScroll={() => setMenu(null)}>
            {m && !list.length && (
              <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">No vaults yet.</div>
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
                    data-el="vault-picker-item"
                    data-path={m ? joinPath(m, r.rel) : r.rel}
                    data-rel={r.rel}
                    className={cn(rowCls, "cursor-pointer")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const trigger = e.currentTarget.querySelector<HTMLButtonElement>('[data-el="picker-row-menu"]');
                      if (trigger) showActions(r, trigger);
                    }}
                  >
                    <button className="flex items-center gap-2 min-w-0 flex-1 h-full text-left" onClick={() => void pick(r)}>
                      <span className="w-3.5 shrink-0">
                        {isOpenRow(r) && <Check className="h-3.5 w-3.5 text-primary" />}
                      </span>
                      <span className="truncate">{r.name}</span>
                    </button>
                    <button
                      data-el="picker-row-menu"
                      title="More"
                      aria-label={`Actions for ${r.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.rel === r.rel}
                      onClick={(e) => {
                        e.stopPropagation();
                        showActions(r, e.currentTarget);
                      }}
                      className="h-6 w-6 shrink-0 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                    {menu?.rel === r.rel && createPortal(
                      <div
                        ref={actionRef}
                        role="menu"
                        aria-label={`Actions for ${r.name}`}
                        style={{ position: "fixed", left: menu.left, top: menu.top, width: 176 }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape" || e.key === "Tab") {
                            if (e.key === "Escape") e.preventDefault();
                            dismissActions();
                          }
                          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                            e.preventDefault();
                            const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                            const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                            buttons[next]?.focus();
                          }
                        }}
                        data-el="picker-row-menu-list"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="z-[60] py-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md text-[12px]"
                      >
                        <button role="menuitem" data-el="picker-rename" className={item} onClick={() => (setMenu(null), setRenaming({ rel: r.rel, value: r.name }))}>
                          Rename
                        </button>
                        {!r.project && (
                          <button role="menuitem" data-el="picker-make-project" disabled={busy} className={item} onClick={() => void makeProject(r)}>
                            Make this a project
                          </button>
                        )}
                        <button role="menuitem" data-el="picker-delete" className={cn(item, "text-destructive")} onClick={() => (setMenu(null), setDeleting(r))}>
                          Delete
                        </button>
                      </div>, document.body,
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
                            <button data-el="picker-delete-conversation" disabled={busy} onClick={() => void remove(r, false)} className="min-h-6 py-1 px-2 rounded text-left leading-snug hover:bg-accent">
                              Remove the conversation, keep the folder
                            </button>
                            <button data-el="picker-delete-everything" disabled={busy} onClick={() => void remove(r, true)} className="min-h-6 py-1 px-2 rounded text-left leading-snug text-destructive hover:bg-accent">
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
