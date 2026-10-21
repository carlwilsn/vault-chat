// The keyboard shortcut sheet: Ctrl+/ (Cmd+/ on a Mac) anywhere, or Settings →
// Keyboard shortcuts. One small panel, two columns of key → label, grouped as
// the registry is (shortcuts.ts — the sheet lists exactly that table). Esc,
// Ctrl+/ again or the backdrop closes it.

import { useEffect, useState } from "react";
import { SHORTCUTS, SHORTCUT_GROUPS, chordLabel, hit, type Shortcut } from "./shortcuts";

export const OPEN_SHORTCUTS_EVENT = "vc-open-shortcuts";

/** Open the sheet from anywhere (the Settings item). */
export function openShortcutSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

export function ShortcutSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Capture phase, so it opens from inside the editors too (CodeMirror and
    // Monaco would otherwise take Ctrl+/ as "toggle comment").
    const onKey = (e: KeyboardEvent) => {
      if (hit(e, "view.shortcuts")) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-el="shortcut-sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <ShortcutList />
    </div>
  );
}

/** The panel itself (no state: rendered by the sheet, and by the harness test). */
export function ShortcutList({ mac }: { mac?: boolean }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="w-[600px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-auto rounded-md border border-border bg-card shadow-xl px-4 py-3"
    >
      <div className="mb-2 text-[12px] font-semibold text-foreground">Keyboard shortcuts</div>
      <div className="columns-2 gap-6 text-[11.5px]">
        {SHORTCUT_GROUPS.map((g) => {
          const rows = (SHORTCUTS as readonly Shortcut[]).filter((s) => s.group === g);
          if (rows.length === 0) return null;
          return (
            <div key={g} className="break-inside-avoid mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-0.5">{g}</div>
              {rows.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-[1px]" data-shortcut={s.id} title={s.where}>
                  <span className="w-[104px] shrink-0 flex justify-end gap-1 text-muted-foreground">
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-[2px]">
                        {i > 0 && <span className="text-muted-foreground/50">/</span>}
                        {chordLabel(k, mac).map((cap, j) => (
                          <kbd key={j} className="min-w-[16px] rounded border border-border/80 bg-background px-1 font-sans text-[10.5px] leading-[15px] text-center">
                            {cap}
                          </kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                  <span className="truncate text-foreground/90">{s.label}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
