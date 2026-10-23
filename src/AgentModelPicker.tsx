// The composer's model menu (where it always was, under the composer on the left): the agent's model on
// the box, the same one setting as Settings → Models (src/agentModel.ts). Type to search, Enter picks the first.
import { useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "./lib/utils";
import { modelLabel, setAgentModel, useAgentModel } from "./agentModel";

export function AgentModelPicker() {
  const { current, options, error } = useAgentModel();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((id) => q.split(/\s+/).every((t) => id.toLowerCase().includes(t))) : options;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!current) return null;
  const pick = (id: string) => {
    setOpen(false);
    if (id !== current) void setAgentModel(id);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        data-el="model-picker"
        className={cn("flex items-center gap-1 text-[11px] hover:text-foreground transition-colors", error ? "text-amber-500/90" : "text-muted-foreground")}
        title={error ? `Not changed: ${error}` : `The agent's model: ${current} (typed and spoken; also in Settings → Models)`}
      >
        <span>{modelLabel(current)}</span>
        <ChevronUp className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col">
          <div className="p-1.5 border-b border-border/60">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && filtered.length > 0) {
                  e.preventDefault();
                  pick(filtered[0]!);
                }
              }}
              placeholder="Search models…"
              className="w-full bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="py-1 max-h-64 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground italic">No matches</div>
            ) : (
              filtered.map((id) => (
                <button
                  key={id}
                  onClick={() => pick(id)}
                  className={cn("block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors truncate", id === current ? "text-foreground font-medium" : "text-muted-foreground")}
                  title={id}
                >
                  {modelLabel(id)}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
