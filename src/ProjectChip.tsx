// The project chip: which project this chat belongs to, set or change it, and
// "New chat in project". Built like the model picker (a quiet text button, a
// w-64 popover with a search line); typing a name that is not in the list
// creates the project.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Folder, Plus, Check } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { isArchivedThread } from "./conversations";
import {
  listProjects,
  projectName,
  setConversationProject,
  newChatInProject,
  slugify,
  type ProjectInfo,
} from "./projects";

/** The vault's projects, refreshed when a chip changes one. */
export function useProjects(): ProjectInfo[] {
  const vaultPath = useStore((s) => s.vaultPath);
  const [list, setList] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void listProjects(vaultPath).then((l) => live && setList(l));
    load();
    window.addEventListener("vc-projects-changed", load);
    return () => {
      live = false;
      window.removeEventListener("vc-projects-changed", load);
    };
  }, [vaultPath]);
  return list;
}

export function ProjectChip({ placement = "up" }: { placement?: "up" | "down" }) {
  const activeId = useStore((s) => s.activeConversationId);
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = conv?.project;
  const label = current ? projectName(current, projects) : "No project";

  useEffect(() => {
    if (!open) {
      setQuery("");
      setErr(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // "New project" in the chat list opens this picker on a fresh chat.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("vc-open-project-picker", onOpen);
    return () => window.removeEventListener("vc-open-project-picker", onOpen);
  }, []);

  // An archived mission thread is history: no project to set.
  if (!activeId || (conv && isArchivedThread(conv))) return null;

  const q = query.trim();
  const ql = q.toLowerCase();
  const shown = ql ? projects.filter((p) => p.name.toLowerCase().includes(ql) || p.slug.includes(slugify(q))) : projects;
  const exact = !!q && projects.some((p) => p.name.toLowerCase() === ql || p.slug === slugify(q));

  const pick = async (nameOrSlug: string | null) => {
    if (!activeId) return;
    const r = await setConversationProject(activeId, nameOrSlug, projects);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setOpen(false);
  };

  const Chevron = placement === "up" ? ChevronUp : ChevronDown;
  const row = "flex items-center gap-2 w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 text-[11px] hover:text-foreground transition-colors",
          current ? "text-foreground/80" : "text-muted-foreground",
        )}
        title="Project — memory this chat shares with the project's other chats"
      >
        <Folder className="h-3 w-3" />
        <span className="max-w-[160px] truncate">{label}</span>
        <Chevron className="h-3 w-3" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 w-64 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col",
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="p-1.5 border-b border-border/60">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && q) {
                  e.preventDefault();
                  void pick(shown[0] && !exact && shown.length === 1 ? shown[0].slug : q);
                }
              }}
              placeholder="Find or name a project…"
              className="w-full bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="py-1 max-h-64 overflow-auto">
            {shown.map((p) => (
              <button key={p.slug} onClick={() => void pick(p.slug)} className={row}>
                <span className="flex-1 truncate">{p.name}</span>
                {p.slug === current && <Check className="h-3 w-3 text-muted-foreground" />}
              </button>
            ))}
            {q && !exact && (
              <button onClick={() => void pick(q)} className={row}>
                <Plus className="h-3 w-3 text-muted-foreground" />
                <span className="flex-1 truncate">
                  New project “{q}”
                </span>
              </button>
            )}
            {!q && shown.length === 0 && (
              <div className="px-3 py-1.5 text-[11px] text-muted-foreground">No projects yet — type a name.</div>
            )}
            {!q && current && (
              <button onClick={() => void pick(null)} className={cn(row, "text-muted-foreground")}>
                <span className="flex-1">No project</span>
              </button>
            )}
          </div>
          {current && !q && (
            <div className="border-t border-border/60 py-1">
              <button
                onClick={() => {
                  newChatInProject(current);
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent("vc-focus-composer"));
                }}
                className={row}
              >
                <Plus className="h-3 w-3 text-muted-foreground" />
                <span className="flex-1 truncate">New chat in {label}</span>
              </button>
            </div>
          )}
          {err && <div className="px-3 py-1.5 border-t border-border/60 text-[11px] text-destructive">{err}</div>}
        </div>
      )}
    </div>
  );
}
