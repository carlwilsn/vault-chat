// The context ring beside the composer, as a button: a click opens a small
// popover with what this chat's context holds, and Carl's Claude plan usage
// (the 5-hour window and the weekly limit: % used and when each resets), read
// from the box (server/planUsage.ts). The same in the docked pane and fullscreen.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "./store";
import { boxGet, boxLinkFor } from "./boxChat";

type Window = { percent: number; resetsAt: number | null };
type Usage = { fiveHour: Window | null; weekly: Window | null; error?: string };

/** "resets 3:40 pm" today; "resets Thu 9:00 am" on another day. */
export function resetsAt(at: number | null, now = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `resets ${time}` : `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

const fmtTokens = (n: number) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);

/** One line (label left, figures right) and its thin bar, as in Carl's approved mockup. */
function Row({ label, value, percent, first }: { label: string; value: string; percent: number | null; first?: boolean }) {
  return (
    <div data-el="usage-row">
      <div className={`${first ? "mt-1.5" : "mt-2"} flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground`}>
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="mt-1 rounded-full bg-muted overflow-hidden" style={{ height: 3 }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%`, background: "hsl(var(--muted-foreground))" }} />
      </div>
    </div>
  );
}

const Heading = ({ children }: { children: ReactNode }) => <div className="text-[11px] text-foreground font-medium">{children}</div>;

/**
 * `used`/`limit`: this chat's context in tokens and its window (`known`: the model said so; else an estimate).
 * `ring`: what the button shows (the ring and the count).
 */
export function UsagePopover({ ring, used, limit, known, title }: { ring: ReactNode; used: number; limit: number; known: boolean; title: string }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(false);
  const vault = useStore((s) => s.vaultPath);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      const l = await boxLinkFor(vault).catch(() => null);
      const r: Usage | null = l ? await boxGet(l, "/api/v1/usage", 25_000).catch((e: unknown) => ({ fiveHour: null, weekly: null, error: String((e as Error)?.message ?? e).slice(0, 120) })) : { fiveHour: null, weekly: null, error: "no box is connected" };
      if (alive) {
        setUsage(r);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, vault]);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const win = (w: Window | null) => (w ? `${Math.round(w.percent)}%${w.resetsAt ? ` · ${resetsAt(w.resetsAt)}` : ""}` : "—");
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        data-el="context-ring"
        title={title}
        className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-accent/60 hover:text-foreground transition-colors ${open ? "bg-accent/60 text-foreground" : "text-muted-foreground"}`}
      >
        {ring}
      </button>
      {open && (
        <div data-el="usage-popover" className="absolute bottom-full right-0 mb-1.5 z-20 w-72 rounded-lg border border-border bg-popover p-1 shadow-lg text-[12.5px]">
          <div className="px-2.5 py-2">
            <Heading>This chat</Heading>
            <div data-el="usage-context">
              <Row first label="Context used" value={`${fmtTokens(used)} / ${known ? "" : "~"}${fmtTokens(limit)} · ${pct}%`} percent={pct} />
            </div>
          </div>
          <div className="my-1 border-t border-border" />
          <div className="px-2.5 py-2">
            <Heading>Claude plan</Heading>
            {loading && !usage ? (
              <div className="mt-1.5 text-[11px] text-muted-foreground">Reading…</div>
            ) : usage && (usage.fiveHour || usage.weekly) ? (
              <>
                <Row first label="5-hour window" value={win(usage.fiveHour)} percent={usage.fiveHour?.percent ?? null} />
                <Row label="Weekly" value={win(usage.weekly)} percent={usage.weekly?.percent ?? null} />
              </>
            ) : (
              <div className="mt-1.5 text-[11px] text-muted-foreground" data-el="usage-unavailable">
                Usage isn't available{usage?.error ? `: ${usage.error}` : ""}.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
