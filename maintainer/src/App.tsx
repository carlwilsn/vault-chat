import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Wrench, ListChecks, AlertTriangle, X, Minus, Square, Copy, Newspaper } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib";
import { Activity } from "./Activity";
import { System } from "./System";
import { Tasks } from "./Tasks";
import { Triage } from "./Triage";
import { UpdateBanner } from "./UpdateBanner";
import { getMe } from "./github";

export function App() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const githubPat = useStore((s) => s.githubPat);
  const setGithubPat = useStore((s) => s.setGithubPat);
  const setGhLogin = useStore((s) => s.setGhLogin);
  const [maximized, setMaximized] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const win = getCurrentWindow();

  // On first paint, pull the GitHub PAT from the OS keychain via the
  // Rust shim — same key the main app uses. If it's missing or lacks
  // workflow scope, we surface a banner pointing the user back to the
  // main app's settings.
  useEffect(() => {
    (async () => {
      try {
        // Main app stores secrets keyed as `service.<name>` — see
        // src/keychain.ts in the main app. Must match exactly or we
        // read nothing.
        const pat = await invoke<string | null>("keychain_get", { key: "service.github_pat" });
        if (!pat) {
          setTokenError("No GitHub PAT in the OS keychain. Add one in vault-chat → Settings → Send feedback.");
          return;
        }
        setGithubPat(pat);
        try {
          const me = await getMe(pat);
          setGhLogin(me.login);
        } catch (e) {
          setTokenError(`GitHub auth failed: ${(e as Error).message}`);
        }
      } catch (e) {
        setTokenError(`keychain_get failed: ${(e as Error).message}`);
      }
    })();
  }, [setGithubPat, setGhLogin]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [win]);

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

  return (
    <div className="h-full w-full flex flex-col bg-background text-foreground">
      {/* Custom titlebar — mirrors the main app's pattern. */}
      <div
        data-tauri-drag-region
        className="h-9 flex items-center bg-card border-b border-border select-none shrink-0"
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 text-[12px] text-foreground/90"
          style={isMac ? { paddingLeft: 76 } : undefined}
        >
          <Wrench className="h-3.5 w-3.5 text-indigo-400" />
          <span className="font-medium">vault-chat maintainer</span>
        </div>
        <div data-tauri-drag-region className="flex-1 h-full" />
        {!isMac && (
          <div className="flex items-center">
            <button
              onClick={() => win.minimize()}
              className="h-9 w-11 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
              title="Minimize"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => win.toggleMaximize()}
              className="h-9 w-11 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
              title={maximized ? "Restore" : "Maximize"}
            >
              {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
            </button>
            <button
              onClick={() => win.close()}
              className="h-9 w-11 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground text-muted-foreground"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <UpdateBanner />

      {tokenError && (
        <div className="px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-[11.5px] text-amber-500 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{tokenError}</span>
        </div>
      )}

      <div className="flex items-stretch border-b border-border bg-card/50 shrink-0">
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")} icon={<Newspaper className="h-3.5 w-3.5" />}>
          Activity
        </TabButton>
        <TabButton active={tab === "triage"} onClick={() => setTab("triage")} icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          Triage
        </TabButton>
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} icon={<ListChecks className="h-3.5 w-3.5" />}>
          Tasks
        </TabButton>
        <TabButton active={tab === "system"} onClick={() => setTab("system")} icon={<Wrench className="h-3.5 w-3.5" />}>
          System
        </TabButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!githubPat ? (
          <div className="px-6 py-10 text-center text-[12px] text-muted-foreground">
            Waiting for a configured GitHub PAT…
          </div>
        ) : tab === "activity" ? (
          <Activity token={githubPat} />
        ) : tab === "triage" ? (
          <Triage token={githubPat} />
        ) : tab === "tasks" ? (
          <Tasks token={githubPat} />
        ) : (
          <System token={githubPat} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium border-b-2 -mb-[2px] transition-colors",
        active
          ? "border-indigo-500 text-indigo-400"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
