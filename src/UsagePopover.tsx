// The context ring beside the composer, as a button: a click opens a small
// popover with what this chat's context holds, and Carl's Claude plan usage
// (the 5-hour window, the weekly limit, per-model weekly limits and extra usage
// when the plan has them: % used and when each resets), read from the box
// (server/planUsage.ts). The box keeps the figures (every turn updates them), and
// the app reads them ahead (watchUsage: at start and after each turn), so the
// popover shows them at once and only refreshes them. The same in the docked
// pane and fullscreen.
import { useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { useStore } from "./store";
import { boxGet, boxLinkFor } from "./boxChat";

type Window = { percent: number; resetsAt: number | null };
type Scoped = Window & { label: string };
type Extra = { enabled: boolean; used: number | null; limit: number | null; percent: number | null; currency: string };
export type Usage = { fiveHour: Window | null; weekly: Window | null; scoped?: Scoped[]; extra?: Extra | null; at?: number; source?: string | null; error?: string };

/** The popover's state: open, and the plan usage it read (app/composer's usage state; its openUsage action). */
export const useUsage = create<{ open: boolean; usage: Usage | null; loading: boolean; context: { used: number; limit: number; known: boolean } | null }>(() => ({ open: false, usage: null, loading: false, context: null }));
export const setUsageOpen = (open: boolean) => useUsage.setState({ open });

const hasFigures = (u: Usage | null | undefined): boolean => !!u && !!(u.fiveHour || u.weekly);

/**
 * Read the plan usage from the box (server/planUsage.ts). `fresh` (the popover opening): the box reads it again
 * when its figures are stale; otherwise it answers with what it keeps. Figures already here stay on screen
 * meanwhile, and a failed read never replaces them.
 */
export async function loadUsage(opts: { fresh?: boolean } = {}): Promise<Usage> {
  const had = useUsage.getState().usage;
  if (!hasFigures(had)) useUsage.setState({ loading: true });
  const vault = useStore.getState().vaultPath;
  const l = await boxLinkFor(vault).catch(() => null);
  const r: Usage = l
    ? await boxGet(l, `/api/v1/usage${opts.fresh ? "?fresh=1" : ""}`, 25_000).catch((e: unknown) => ({ fiveHour: null, weekly: null, error: String((e as Error)?.message ?? e).slice(0, 120) }))
    : { fiveHour: null, weekly: null, error: "no box is connected" };
  const now = useUsage.getState().usage;
  const keep = !!now && hasFigures(now) && (!hasFigures(r) || (now.at ?? 0) > (r.at ?? 0));
  useUsage.setState({ usage: keep ? now : r, loading: false });
  return keep && now ? now : r;
}

/**
 * Read it ahead, so opening never waits: when the app starts, when the box is reachable, and when a turn ends
 * (the box has the turn's figures by then). At most once a minute, unless a turn ended. Returns the unsubscribe.
 */
export function watchUsage(): () => void {
  let last = 0;
  const pre = (force = false) => {
    if (!force && Date.now() - last < 60_000) return;
    last = Date.now();
    void loadUsage().catch(() => {});
  };
  let busy = useStore.getState().busy;
  let vault = useStore.getState().vaultPath;
  if (vault) pre(true);
  const off = useStore.subscribe((s) => {
    if (s.vaultPath !== vault) {
      vault = s.vaultPath;
      if (vault) pre(true);
    }
    if (busy && !s.busy) pre(true);
    busy = s.busy;
    // Not read yet (the box was out of reach): try again as the store moves, once a minute.
    if (!hasFigures(useUsage.getState().usage) && vault) pre();
  });
  return off;
}

/** "resets 3:40 pm" today; "resets Thu 9:00 am" on another day. */
export function resetsAt(at: number | null, now = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `resets ${time}` : `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};

/** A window whose reset has passed is a new one, nothing used yet. */
const current = (w: Window | null, now: number): Window | null => (w && w.resetsAt && w.resetsAt <= now ? { percent: 0, resetsAt: null } : w);
const winText = (w: Window | null, now: number) => (w ? `${Math.round(w.percent)}%${w.resetsAt ? ` · ${resetsAt(w.resetsAt, now)}` : ""}` : "—");

/** The plan's rows, as the popover draws them (label, figures, bar). Exported for tests. */
export function planRows(u: Usage, now = Date.now()): { label: string; value: string; percent: number | null }[] {
  const rows: { label: string; value: string; percent: number | null }[] = [];
  const five = current(u.fiveHour, now);
  // No 5-hour window running: it starts with the next message.
  const idle = !five || (!five.resetsAt && five.percent === 0);
  rows.push({ label: "5-hour window", value: idle ? "not started" : winText(five, now), percent: idle ? 0 : five.percent });
  const week = current(u.weekly, now);
  rows.push({ label: "Weekly", value: winText(week, now), percent: week?.percent ?? null });
  for (const s of u.scoped ?? []) {
    const w = current(s, now)!;
    rows.push({ label: `${s.label} weekly`, value: winText(w, now), percent: w.percent });
  }
  const x = u.extra;
  if (x && (x.enabled || x.used)) {
    const spent = x.used != null ? money(x.used, x.currency) : null;
    const value = !x.enabled ? `${spent ?? "0"} · off` : spent != null && x.limit != null ? `${spent} / ${money(x.limit, x.currency)}` : spent ?? "on";
    const percent = x.percent ?? (x.used != null && x.limit ? (x.used / x.limit) * 100 : null);
    rows.push({ label: "Extra usage", value, percent });
  }
  return rows;
}

/** "as of 3:40 pm" when the figures are more than ten minutes old, else nothing. */
export function asOf(u: Usage, now = Date.now()): string {
  const at = u.at ?? 0;
  if (!at || now - at < 10 * 60_000) return "";
  return `as of ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase()}`;
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
  const open = useUsage((s) => s.open);
  const usage = useUsage((s) => s.usage);
  const loading = useUsage((s) => s.loading);
  const setOpen = setUsageOpen;
  const vault = useStore((s) => s.vaultPath);
  useEffect(() => useUsage.setState({ context: { used, limit, known } }), [used, limit, known]);
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
    if (open) void loadUsage({ fresh: true });
  }, [open, vault]);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const now = Date.now();
  return (
    <div className="relative" ref={ref}>
      <button data-offer="app/composer.openUsage"
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
            {usage && hasFigures(usage) ? (
              <>
                {planRows(usage, now).map((r, i) => (
                  <Row key={r.label} first={i === 0} label={r.label} value={r.value} percent={r.percent} />
                ))}
                {asOf(usage, now) && <div className="mt-1.5 text-[10.5px] text-muted-foreground/80" data-el="usage-as-of">{asOf(usage, now)}</div>}
              </>
            ) : loading || !usage ? (
              <div className="mt-1.5 text-[11px] text-muted-foreground">Reading…</div>
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
