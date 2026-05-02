import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ArrowUpCircle, X } from "lucide-react";

// Auto-checks for a maintainer update on mount and surfaces a
// dismissible banner if one's available — same UX shape as the main
// app's UpdateBanner so the two feel like a single product. Manual
// install (user clicks button); we never auto-install in the
// background. Per-version dismiss key so a user who dismisses v0.1.5
// still gets prompted when v0.1.6 lands.

const DISMISS_KEY = "vault_chat_maintainer_update_dismissed_version";

type Phase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed === update.version) return;
        setPhase({ kind: "available", update });
      } catch (e) {
        // Dev mode and offline launches fail here — silent, not actionable.
        console.warn("[maintainer-updater] check failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === "idle") return null;

  const dismiss = () => {
    if (phase.kind === "available") {
      localStorage.setItem(DISMISS_KEY, phase.update.version);
    }
    setPhase({ kind: "idle" });
  };

  const install = async () => {
    if (phase.kind !== "available") return;
    const update = phase.update;
    setPhase({ kind: "downloading", update, progress: 0 });
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength ?? 0;
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setPhase({ kind: "downloading", update, progress: pct });
        }
      });
      setPhase({ kind: "ready" });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div className="px-4 py-2 bg-indigo-500/15 border-b border-indigo-500/30 text-[12px] text-foreground/95 flex items-center gap-3">
      <ArrowUpCircle className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
      {phase.kind === "available" && (
        <>
          <span>Maintainer update available — v{phase.update.version}</span>
          {phase.update.body && (
            <span className="text-muted-foreground/90 truncate flex-1 min-w-0">
              {phase.update.body.split("\n")[0]}
            </span>
          )}
          <button
            onClick={() => void install()}
            className="ml-auto bg-indigo-500 hover:bg-indigo-400 text-white px-2.5 py-1 rounded text-[11.5px]"
          >
            Install
          </button>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground"
            title="Dismiss until next release"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {phase.kind === "downloading" && (
        <span>Downloading v{phase.update.version}… {phase.progress}%</span>
      )}
      {phase.kind === "ready" && (
        <>
          <span className="text-emerald-500">Update ready — restart to apply.</span>
          <button
            onClick={() => void relaunch()}
            className="ml-auto bg-emerald-500 hover:bg-emerald-400 text-white px-2.5 py-1 rounded text-[11.5px]"
          >
            Restart now
          </button>
        </>
      )}
      {phase.kind === "error" && (
        <>
          <span className="text-destructive">Update failed: {phase.message}</span>
          <button
            onClick={() => setPhase({ kind: "idle" })}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
