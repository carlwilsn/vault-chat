// "+ New project" in the left panel: its name, and where it works (Claude Code's working folder).
// No folder (the vault, as before), a new ~/projects/<name>, or a folder Carl chooses on the box
// (FolderChooser: the box's folders, each marked whether it may be a project's; server/projectFolders.ts).
// A folder needs the box; without one the form is the name alone.
import { useEffect, useState } from "react";
import { ChevronLeft, Folder } from "lucide-react";
import { useStore } from "./store";
import { boxLinkFor } from "./boxChat";
import { browseBoxFolders, tildePath, type FolderListing } from "./boxFiles";
import { slugify } from "./projects";
import { cn } from "./lib/utils";

export type Where = { folder?: string; newFolder?: boolean };
type Choice = { kind: "none" } | { kind: "new" } | { kind: "pick"; path: string };

export function NewProjectForm({ onCreate, onCancel }: { onCreate: (name: string, where: Where) => void; onCancel: () => void }) {
  const vault = useStore((s) => s.vaultPath);
  const [name, setName] = useState("");
  const [onBox, setOnBox] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>({ kind: "none" });
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    let live = true;
    void boxLinkFor(vault).then((l) => live && setOnBox(!!l));
    return () => {
      live = false;
    };
  }, [vault]);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n, choice.kind === "new" ? { newFolder: true } : choice.kind === "pick" ? { folder: choice.path } : {});
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
            {chip(choice.kind === "new", `~/projects/${slug}`, () => setChoice({ kind: "new" }), "folder-new")}
            {chip(choice.kind === "pick", choice.kind === "pick" ? tildePath(choice.path, home) : "A folder on the box…", () => setChoosing(true), "folder-pick")}
          </div>
          {choosing && (
            <FolderChooser
              onHome={setHome}
              onPick={(p) => {
                setChoice({ kind: "pick", path: p });
                setChoosing(false);
              }}
              onClose={() => setChoosing(false)}
            />
          )}
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

/** The box's folders, one level at a time from the home: open one, go up, or use it. */
export function FolderChooser({ onPick, onClose, onHome }: { onPick: (path: string) => void; onClose: () => void; onHome?: (home: string) => void }) {
  const [at, setAt] = useState<string | null>(null);
  const [list, setList] = useState<FolderListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    browseBoxFolders(at)
      .then((l) => {
        if (!live) return;
        setList(l);
        setErr(null);
        onHome?.(l.home);
      })
      .catch((e) => live && setErr(String((e as Error)?.message ?? e)));
    return () => {
      live = false;
    };
  }, [at]);
  return (
    <div className="mt-1.5 rounded-md border border-border bg-background text-[12px]" data-el="folder-chooser">
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border/60">
        <button
          type="button"
          title="Up"
          disabled={!list?.parent}
          onClick={() => list?.parent && setAt(list.parent)}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 font-mono text-[10.5px] text-muted-foreground truncate" data-el="folder-chooser-path">
          {list ? tildePath(list.path, list.home) : "…"}
        </div>
      </div>
      <div className="max-h-[200px] overflow-auto py-0.5">
        {list?.dirs.map((d) => (
          <button
            type="button"
            key={d.path}
            data-el="folder-chooser-dir"
            onClick={() => setAt(d.path)}
            className="w-full flex items-center gap-1.5 px-2.5 h-6 text-left hover:bg-accent/60 text-foreground/90"
          >
            <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{d.name}</span>
          </button>
        ))}
        {list && !list.dirs.length && <div className="px-2.5 py-1.5 text-muted-foreground">No folders here.</div>}
      </div>
      {(err || (list && !list.ok && list.why)) && <div className="px-2.5 py-1 text-[11px] text-muted-foreground border-t border-border/60">{err ?? list?.why}</div>}
      <div className="flex justify-end gap-1.5 px-1.5 py-1 border-t border-border/60">
        <button type="button" onClick={onClose} className="h-6 px-2 rounded text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
          Cancel
        </button>
        <button
          type="button"
          data-el="folder-chooser-use"
          disabled={!list?.ok}
          onClick={() => list && onPick(list.path)}
          className="h-6 px-2 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
