import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { publishUpdate } from "./updateState";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Sparkles, X, RefreshCcw, Check } from "lucide-react";
import { dismissLanded, landedNow, onLandedChanged } from "./landed";
import { laterReady, onReadyChanged, pressReadyOk, readyNow } from "./coreReady";
import { Button } from "./ui";
import { isRunInBackground } from "./background";
import { activeRuns } from "./runRegistry";
import { useStore } from "./store";
import { isSelfTestLaunch } from "./selfTestLaunch";

type Phase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };


const isDev = import.meta.env.DEV;

// How often a long-lived process re-checks for updates. The on-mount check only
// fires at launch; an always-on box can run for days without relaunching, so it
// would never see a new release without this. Kept SHORT (5 min) so a shipped fix
// reaches the box — and the phone that reads it — in minutes, not hours: this is
// the whole test loop. It's cheap (a manifest GET) and the box only RELAUNCHES
// when idle (boxIsIdle), so a tight interval never interrupts a live mission.
const RECHECK_MS = 5 * 60 * 1000;

// Module-level: once an unattended download has staged the new version, only a
// relaunch is needed to apply it — don't re-download on every later check.
let unattendedStaged = false;

// The box is safe to restart only when nothing is mid-run — otherwise an
// auto-relaunch would kill a live mission/worker. activeRuns() is the headless
// run registry; conversation status covers in-window turns.
function boxIsIdle(): boolean {
  if (activeRuns().length > 0) return false;
  return !useStore.getState().conversations.some((c) => c.status === "running");
}

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const installRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (isDev) return;
    let cancelled = false;

    // The always-on box (Run in background) has nobody to click "Install &
    // restart", so it would sit on a stale build forever — which is exactly how
    // the box kept missing shipped fixes. Auto-apply updates there, but only
    // when idle so a restart never kills a live mission. Interactive machines
    // keep the manual banner.
    const unattended = isRunInBackground();

    const applyUnattended = async (update: Update) => {
      try {
        if (!unattendedStaged) {
          await update.downloadAndInstall();
          unattendedStaged = true;
        }
        // Staged but busy → leave it; a later idle check (or any restart)
        // applies it. Re-check idle right before the restart, not just before
        // the download, since a run can start during the download.
        if (cancelled || !boxIsIdle()) return;
        await relaunch();
      } catch (e) {
        // A non-AppImage Linux install (deb/rpm can't self-replace) or a
        // transient error. Don't hard-loop or crash the box; surface the banner
        // in case a human is watching, and reset so a later check can retry.
        console.error("[updater] unattended update failed:", e);
        unattendedStaged = false;
        if (!cancelled) setPhase({ kind: "available", update });
      }
    };

    const runCheck = async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        if (unattended) await applyUnattended(update);
        else setPhase({ kind: "available", update });
      } catch (e) {
        console.warn("[updater] check failed:", e);
      }
    };

    // A self-test launch (CI driving the built app on a fresh machine) never checks: no prompt over its steps, no
    // download, no relaunch mid-run.
    let timer: number | undefined;
    void isSelfTestLaunch().then((selfTest) => {
      if (cancelled || selfTest) return;
      void runCheck();
      timer = window.setInterval(() => void runCheck(), RECHECK_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, []);

  // The banner as state the agent reads and acts on (src/updateState.ts → app/titlebar's `update`).
  publishUpdate(
    phase.kind === "available"
      ? { state: "available", version: phase.update.version, ...(phase.update.body ? { notes: String(phase.update.body).slice(0, 400) } : {}) }
      : phase.kind === "downloading"
        ? { state: "downloading", downloaded: phase.downloaded, total: phase.total }
        : phase.kind === "error"
          ? { state: "error", message: phase.message }
          : { state: phase.kind },
    { install: () => installRef.current?.(), dismiss: () => setPhase({ kind: "idle" }) },
  );

  if (phase.kind === "idle" || phase.kind === "error") return null;

  const dismiss = () => setPhase({ kind: "idle" });

  const install = async () => {
    if (phase.kind !== "available") return;
    installRef.current = null;
    const update = phase.update;
    setPhase({ kind: "downloading", downloaded: 0, total: null });
    try {
      let total: number | null = null;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setPhase({ kind: "downloading", downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setPhase({ kind: "downloading", downloaded, total });
        } else if (event.event === "Finished") {
          setPhase({ kind: "installing" });
        }
      });
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed:", e);
      setPhase({ kind: "error", message: String(e) });
    }
  };
  installRef.current = install;

  return (
    <NoticeCard
      title="Claude shipped an update"
      sub={phase.kind === "available" ? `v${phase.update.version}` : undefined}
      close={<button data-offer="app/titlebar.dismissUpdate" onClick={dismiss} className="text-muted-foreground hover:text-foreground" title="Dismiss"><X className="h-3.5 w-3.5" /></button>}
    >

      {phase.kind === "available" && (
        <div className="p-3 space-y-2.5">
          {phase.update.body && (
            <div className="text-[11.5px] text-muted-foreground/90 leading-relaxed max-h-64 overflow-auto whitespace-pre-wrap">
              {phase.update.body}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              data-offer="app/titlebar.installUpdate"
              size="sm"
              onClick={install}
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1"
            >
              <RefreshCcw className="h-3 w-3 mr-1.5" />
              Install &amp; restart
            </Button>
            <Button data-offer="app/titlebar.dismissUpdate" size="sm" variant="ghost" onClick={dismiss}>
              Later
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "downloading" && (
        <div className="p-3 space-y-1.5">
          <div className="text-[11px] text-muted-foreground">
            Downloading{phase.total ? ` ${pct(phase.downloaded, phase.total)}%` : "…"}
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-[width]"
              style={{
                width: phase.total
                  ? `${Math.min(100, (phase.downloaded / phase.total) * 100)}%`
                  : "30%",
              }}
            />
          </div>
        </div>
      )}

      {phase.kind === "installing" && (
        <div className="p-3 text-[11.5px] text-muted-foreground">
          Installing — the app will restart momentarily…
        </div>
      )}
    </NoticeCard>
  );
}

/** The bottom-right card both notices use: a header (icon, title, a mono line under it, an optional close) and a body. */
function NoticeCard({ title, sub, close, children, offer }: { title: string; sub?: string; close?: ReactNode; children: ReactNode; offer?: string }) {
  return (
    <div data-el={offer} className="rounded-lg border border-border bg-card shadow-xl overflow-hidden">
      <div className="flex items-start gap-2.5 p-3 border-b border-border bg-gradient-to-br from-accent/40 to-transparent">
        <div className="h-7 w-7 rounded-md bg-accent/60 text-foreground flex items-center justify-center shrink-0">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-foreground/95">{title}</div>
          {sub && <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">{sub}</div>}
        </div>
        {close}
      </div>
      {children}
    </div>
  );
}

/** After a newer core loaded (src/landed.ts): what landed, and OK. No install, no restart. */
function LandedCard() {
  const s = useSyncExternalStore(onLandedChanged, landedNow);
  if (!s.shown) return null;
  return (
    <NoticeCard title="Landed" offer="landed-card">
      <div className="p-3 space-y-2.5">
        <ul className="text-[11.5px] text-muted-foreground/90 leading-relaxed max-h-64 overflow-auto space-y-1 list-disc pl-4">
          {(s.what ?? []).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <Button data-offer="app/titlebar.dismissLanded" size="sm" onClick={dismissLanded} className="bg-primary text-primary-foreground hover:bg-primary/90 w-full">
          <Check className="h-3 w-3 mr-1.5" />
          OK
        </Button>
      </div>
    </NoticeCard>
  );
}

/** The box has a newer core (src/coreReady.ts): what it brings, OK (swap in now) and Later. Nothing swaps without OK. */
function ReadyCard() {
  const s = useSyncExternalStore(onReadyChanged, readyNow);
  if (!s.shown) return null;
  const busy = s.phase === "switching";
  return (
    <NoticeCard title="Ready" offer="ready-card">
      <div className="p-3 space-y-2.5">
        <ul className="text-[11.5px] text-muted-foreground/90 leading-relaxed max-h-64 overflow-auto space-y-1 list-disc pl-4">
          {(s.what ?? []).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        {s.phase === "failed" && <div className="text-[11px] text-destructive">Couldn't switch: {s.error}</div>}
        <div className="flex gap-2">
          <Button data-offer="app/titlebar.acceptReady" size="sm" disabled={busy} onClick={() => void pressReadyOk()} className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1">
            {busy ? <RefreshCcw className="h-3 w-3 mr-1.5 animate-spin" /> : <Check className="h-3 w-3 mr-1.5" />}
            {busy ? "Switching…" : "OK"}
          </Button>
          <Button data-offer="app/titlebar.laterReady" size="sm" variant="outline" disabled={busy} onClick={laterReady} className="flex-1">
            Later
          </Button>
        </div>
      </div>
    </NoticeCard>
  );
}

/** The bottom-right notices, stacked: a new core waiting for OK, what landed, then a native update's Install card. */
export function Notices() {
  return (
    <div className="fixed bottom-4 right-4 w-80 z-50 flex flex-col gap-2">
      <ReadyCard />
      <LandedCard />
      <UpdateBanner />
    </div>
  );
}

function pct(downloaded: number, total: number): number {
  return Math.round((downloaded / total) * 100);
}
