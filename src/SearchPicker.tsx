// The search-and-scroll menu as a field (the chat pane's model menu, as one tight row): open it and type to search, or
// scroll. Shared by Settings (the box's vault picker) and the ElevenLabs voice plugin's voice picker
// (src/plugins/elevenlabs-voice).
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/** `disabled`: shown, not pickable (its hint says why). */
export type PickOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** The chat pane's model menu, as a Settings field: one tight row; open it and
 *  type to search, or scroll. */
export function Picker({
  value,
  label,
  options,
  onChange,
  placeholder = "Search…",
  defaultOpen = false,
  footer,
}: {
  value: string;
  label?: string;
  options: PickOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  defaultOpen?: boolean;
  /** One quiet action under the list (it closes the menu). */
  footer?: { label: string; onClick: () => void };
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => {
        const hay = `${o.label} ${o.value} ${o.hint ?? ""}`.toLowerCase();
        return q.split(/\s+/).every((t) => hay.includes(t));
      })
    : options;
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const current = label ?? options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full h-7 px-2.5 flex items-center justify-between gap-2 rounded-md border border-input bg-background text-[12px] hover:border-border transition-colors"
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col">
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
                } else if (e.key === "Enter" && shown.some((o) => !o.disabled)) {
                  e.preventDefault();
                  pick(shown.find((o) => !o.disabled)!.value);
                }
              }}
              placeholder={placeholder}
              className="w-full bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="py-1 max-h-64 overflow-auto">
            {shown.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground italic">No matches</div>
            ) : (
              shown.map((o) => (
                <button
                  key={o.value}
                  onClick={() => !o.disabled && pick(o.value)}
                  disabled={o.disabled}
                  aria-disabled={o.disabled || undefined}
                  className={`block w-full text-left px-3 py-1.5 text-[11px] transition-colors truncate ${
                    o.disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-accent"
                  } ${o.value === value ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  title={o.disabled && o.hint ? o.hint : o.value}
                  data-option={o.value}
                >
                  {o.label}
                  {o.hint && <span className="ml-1.5 opacity-60 text-[10px]">{o.hint}</span>}
                </button>
              ))
            )}
          </div>
          {footer && (
            <button
              onClick={() => {
                setOpen(false);
                footer.onClick();
              }}
              className="block w-full text-left px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground border-t border-border/60 transition-colors"
            >
              {footer.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
