// "+ New project" in the left panel: its name, and it is a new folder of that name in the open folder, with a
// conversation of its own (Carl, 2026-10-29: a project is a folder that has its own conversation). Any existing folder
// becomes a project from the folder picker's ⋯ ("Make this a project").
import { useState } from "react";

export function NewProjectForm({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="px-4 pt-2 pb-2" data-el="new-project-form">
      <input
        autoFocus
        value={name}
        data-el="new-project-name"
        onChange={(ev) => setName(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && name.trim()) onCreate(name.trim());
          if (ev.key === "Escape") {
            ev.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => !name.trim() && onCancel()}
        placeholder="Project name, then Enter"
        className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/40"
      />
      <div className="mt-1 text-[10.5px] text-muted-foreground/80" data-el="new-project-where">
        A new folder of that name in the open folder.
      </div>
    </div>
  );
}
