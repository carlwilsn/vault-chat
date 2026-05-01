import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Sparkles, X, RefreshCcw } from "lucide-react";
import { Button } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

const DISMISS_KEY = "vault_chat_update_dismissed_version";

// Dev mode: the updater plugin throws on `check()` because there's no
// installed binary to compare against. Detect that and stay silent so we
// don't spam errors during local dev.
const isDev = import.meta.env.DEV;

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (isDev) return;
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed === update.version) return;
        setPhase({ kind: "available", update });
      } catch (e) {
        console.warn("[updater] check failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === "idle" || phase.kind === "error") return null;

  const dismiss = () => {
    if (phase.kind === "available") {
      localStorage.setItem(DISMISS_KEY, phase.update.version);
    }
    setPhase({ kind: "idle" });
  };

  const install = async () => {
    if (phase.kind !== "available") return;
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

  return (
    <div className="fixed bottom-4 right-4 w-80 z-50 rounded-lg border border-indigo-500/40 bg-card shadow-xl overflow-hidden">
      <div className="flex items-start gap-2.5 p-3 border-b border-border bg-gradient-to-br from-indigo-500/10 to-transparent">
        <div className="h-7 w-7 rounded-md bg-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-foreground/95">
            Claude shipped an update
          </div>
          {phase.kind === "available" && (
            <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
              v{phase.update.version}
            </div>
          )}
        </div>
        <button
          onClick={dismiss}
          className="text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {phase.kind === "available" && (
        <div className="p-3 space-y-2.5">
          {phase.update.body && (
            <div className="text-[11.5px] text-muted-foreground/90 leading-relaxed max-h-32 overflow-auto whitespace-pre-wrap">
              {phase.update.body}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={install}
              className="bg-indigo-500 text-white hover:bg-indigo-400 flex-1"
            >
              <RefreshCcw className="h-3 w-3 mr-1.5" />
              Install &amp; restart
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
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
              className="h-full bg-indigo-500 transition-[width]"
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
    </div>
  );
}

function pct(downloaded: number, total: number): number {
  return Math.round((downloaded / total) * 100);
}
