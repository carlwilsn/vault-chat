// "+ New project" in the left panel: its name, and where it works (Claude Code's working folder): the vault (as
// before) or a new folder in the vault-chat folder, <box folder>/projects/<name>, synced with the laptop (Carl,
// 2026-10-28: everything lives in the folder; no folder elsewhere). A folder needs the box; without one the form is the
// name alone.
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { boxLinkFor } from "./boxChat";
import { tildePath } from "./boxFiles";
import { slugify } from "./projects";
import { boxMasterInfo } from "./master";
import { cn } from "./lib/utils";

export type Where = { folder?: string; newFolder?: boolean };

/** What syncs: the vault, and a new folder in the vault-chat folder's projects/. */
export function projectSyncNote(choice: { kind: string }, boxMaster: string | null): string {
  if (choice.kind === "none") return "In the vault: synced with this laptop.";
  return boxMaster ? "Its own folder in projects/: synced with this laptop." : "Its own folder on the box (the box has no vault-chat folder, so it does not sync).";
}
type Choice = { kind: "none" } | { kind: "new" };

export function NewProjectForm({ onCreate, onCancel }: { onCreate: (name: string, where: Where) => void; onCancel: () => void }) {
  const vault = useStore((s) => s.vaultPath);
  const [name, setName] = useState("");
  const [onBox, setOnBox] = useState(false);
  const [choice, setChoice] = useState<Choice>({ kind: "none" });
  // The box's vault-chat folder (server/master.ts): a new folder goes in its projects/ and syncs with the laptop.
  const [boxMaster, setBoxMaster] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void boxLinkFor(vault).then((l) => {
      if (!live) return;
      setOnBox(!!l);
      if (l) void boxMasterInfo(l.url).then((i) => live && setBoxMaster(i?.master ?? null));
    });
    return () => {
      live = false;
    };
  }, [vault]);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n, choice.kind === "new" ? { newFolder: true } : {});
  };
  const slug = slugify(name) || "name";
  const chip = (on: boolean, label: string, onClick: () => void, el: string) => (
    <button
      type="button"
      data-el={el}
      onClick={onClick}
      className={cn("h-6 px-2 rounded border text-[11px] truncate max-w-full", on ? "border-ring/50 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50")}
    >
      {label}
    </button>
  );

  return (
    <div className="px-4 pt-2 pb-2" data-el="new-project-form">
      <input
        autoFocus
        value={name}
        data-el="new-project-name"
        onChange={(ev) => setName(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && name.trim()) submit();
          if (ev.key === "Escape") {
            ev.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => !name.trim() && !onBox && onCancel()}
        placeholder="Project name, then Enter"
        className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/40"
      />
      {onBox && (
        <>
          <div className="mt-1.5 text-[10.5px] text-muted-foreground/80" data-el="new-project-where">
            Works in
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {chip(choice.kind === "none", "The vault", () => setChoice({ kind: "none" }), "folder-none")}
            {chip(choice.kind === "new", boxMaster ? `${tildePath(boxMaster, null)}/projects/${slug}` : `~/projects/${slug}`, () => setChoice({ kind: "new" }), "folder-new")}
          </div>
          <div className="mt-1 text-[10.5px] text-muted-foreground/80" data-el="new-project-sync-note">
            {projectSyncNote(choice, boxMaster)}
          </div>
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={onCancel} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel
            </button>
            <button
              type="button"
              data-el="new-project-create"
              disabled={!name.trim()}
              onClick={submit}
              className="h-6 px-2.5 rounded text-[11.5px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </>
      )}
    </div>
  );
}
