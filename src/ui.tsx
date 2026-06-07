import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./lib/utils";

type ButtonVariant = "default" | "ghost" | "secondary" | "outline" | "destructive";
type ButtonSize = "default" | "sm" | "icon";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(({ className, variant = "default", size = "default", ...props }, ref) => {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap";
  const variants: Record<ButtonVariant, string> = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "hover:bg-accent hover:text-accent-foreground text-foreground/80",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  };
  const sizes: Record<ButtonSize, string> = {
    default: "h-8 px-3 text-[13px]",
    sm: "h-7 px-2.5 text-[12px]",
    icon: "h-8 w-8",
  };
  return (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
});
Button.displayName = "Button";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] leading-relaxed transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

export type MenuOption = { value: string; label: string };
export type MenuGroup = { label?: string; options: MenuOption[] };

/**
 * A custom dropdown whose OPEN menu is styled (unlike a native <select>, whose
 * popup is drawn by the OS and can't be themed). Modeled on the ElevenLabs voice
 * picker: a <details> with outside-click-close and a bordered, scrollable list
 * with hover/active states. Supports option groups (the equivalent of <optgroup>).
 * Pass `mono` for dropdowns that show raw identifiers (model ids).
 */
export function MenuSelect({
  value,
  onChange,
  groups,
  triggerLabel,
  placeholder = "Select…",
  emptyHint,
  mono = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  groups: MenuGroup[];
  /** Override the trigger text (e.g. when the selected item is filtered out of `groups`). */
  triggerLabel?: string;
  placeholder?: string;
  emptyHint?: string;
  mono?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) el.open = false;
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const all = groups.flatMap((g) => g.options);
  const label = triggerLabel ?? all.find((o) => o.value === value)?.label ?? placeholder;
  const pick = (v: string) => {
    onChange(v);
    if (ref.current) ref.current.open = false;
  };
  const textCls = mono ? "text-[12px] font-mono" : "text-[13px]";
  return (
    <details ref={ref} className={cn("w-full rounded-md border border-input bg-background group", className)}>
      <summary className={cn("h-8 px-2.5 flex items-center justify-between cursor-pointer list-none", textCls)}>
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-open:rotate-180 transition-transform" />
      </summary>
      <div className="border-t border-input max-h-64 overflow-y-auto">
        {all.length === 0 && emptyHint && (
          <div className="px-2.5 py-2 text-[11px] text-muted-foreground/70">{emptyHint}</div>
        )}
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.label && (
              <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold sticky top-0 bg-background">
                {g.label}
              </div>
            )}
            {g.options.map((o) => (
              <div
                key={o.value}
                onClick={() => pick(o.value)}
                className={cn(
                  "px-2.5 py-1.5 cursor-pointer hover:bg-muted/40",
                  textCls,
                  o.value === value && "bg-muted/60",
                )}
              >
                {o.label}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
      {children}
    </kbd>
  );
}
