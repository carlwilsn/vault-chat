// Changing vaults: the titlebar's vault name opens a short list of the vaults in the vault-chat folder
// (src/master.ts), the open one ticked, then "New vault" (made here and on the box, then synced). Everything lives in
// the folder (Carl, 2026-10-28): no folder elsewhere. Without a folder set, the list says where to set it.
import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Plus } from "lucide-react";
import { useStore } from "./store";
import { localVaults, masterPath, newVault, pickerItems, type PickerItem } from "./master";
import { openVaultAt } from "./openVault";

export function VaultPicker() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [isOpen, setOpen] = useState(false);
  const [items, setItems] = useState<PickerItem[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const m = masterPath();

  useEffect(() => {
    if (!isOpen) return;
    void localVaults(m).then((names) => setItems(pickerItems(m, names, vaultPath)));
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, vaultPath, m]);

  const close = () => {
    setOpen(false);
    setNaming(false);
    setName("");
    setErr(null);
  };
  const pick = async (path: string) => {
    close();
    await openVaultAt(path);
  };
  const create = async () => {
    const r = await newVault(name);
    if ("error" in r) return setErr(r.error);
    await pick(r.path);
  };

  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;
  const row = "w-full h-7 px-2.5 flex items-center gap-2 rounded text-[12px] text-left hover:bg-accent/60";
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => (isOpen ? close() : setOpen(true))}
        data-el="vault-picker"
        className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-accent/60 text-[12px] text-foreground/90"
        title="Change vault"
      >
        <FolderOpen className="h-3.5 w-3.5 opacity-80" />
        <span className="max-w-[220px] truncate">{vaultName ?? "Open vault"}</span>
      </button>
      {isOpen && (
        <div data-el="vault-picker-menu" className="absolute left-0 top-8 z-50 w-64 rounded-md border border-border bg-popover shadow-lg p-1">
          {m ? (
            <div className="px-2.5 pt-1 pb-1.5 text-[10.5px] text-muted-foreground truncate" title={m}>
              Vaults in {m}
            </div>
          ) : (
            <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">Set the vault-chat folder in Settings to list your vaults here.</div>
          )}
          {items.map((it) =>
            it.kind === "vault" ? (
              <button key={it.path} data-el="vault-picker-item" data-path={it.path} className={row} onClick={() => void pick(it.path)}>
                <span className="w-3.5 shrink-0">{it.open && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                <span className="truncate">{it.name}</span>
              </button>
            ) : (
              naming ? (
                <div key="new" className="px-1.5 py-1">
                  <input
                    autoFocus
                    data-el="vault-picker-new-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && name.trim()) void create();
                      if (e.key === "Escape") setNaming(false);
                    }}
                    placeholder="New vault's name, then Enter"
                    className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
                  />
                  {err && <div className="mt-1 text-[11px] text-destructive">{err}</div>}
                </div>
              ) : (
                <button key="new" data-el="vault-picker-new" className={`${row} border-t border-border mt-1 pt-1`} onClick={() => setNaming(true)}>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>New vault</span>
                </button>
              )
            ),
          )}
        </div>
      )}
    </div>
  );
}
