// The visible launcher for pinned apps (src/PinnedAppsHost.tsx), in the title bar: lists them and brings one to the
// front. Its menu's open state is the bar's (./model.ts), so the agent's openAppsLauncher opens the same menu.
import { LayoutGrid } from "lucide-react";
import { showPinnedApp, usePinnedApps } from "../../PinnedAppsHost";
import { emitBarEvent, setAppsOpen, useBar } from "./model";

export function AppsLauncher() {
  const { apps, front } = usePinnedApps();
  const open = useBar((s) => s.appsOpen);
  if (!apps.length) return null;
  return (
    <span className="relative">
      <button
        type="button"
        data-el="apps-launcher"
        onClick={() => setAppsOpen(!open)}
        className={`h-7 w-7 flex items-center justify-center rounded ${open || front ? "bg-accent text-foreground" : "hover:bg-accent/60 text-muted-foreground"}`}
        title="Apps (pinned pages)"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div data-el="apps-list" className="absolute left-0 top-8 z-50 min-w-[200px] rounded-md border border-border bg-card p-1 shadow-lg">
          {apps.map((a) => (
            <button
              key={a.id}
              type="button"
              data-el="apps-item"
              onClick={() => {
                showPinnedApp(a.id);
                setAppsOpen(false);
                emitBarEvent("appOpened", { name: a.name, path: a.path });
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-accent/60"
            >
              <span className="truncate">{a.name}</span>
              {a.html === null && <span className="text-destructive">failed</span>}
              {a.id === front && <span className="ml-auto text-muted-foreground">open</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
