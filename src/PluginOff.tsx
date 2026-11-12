// What a view shows where a stopped plugin was (change 1.6, src/pluginSupervisorApp.ts): one line, and Turn on.
import { useState } from "react";
import { offLine, type Desired } from "./pluginSupervisor";
import { setPluginRunning } from "./pluginSupervisorApp";

export function PluginOff({ path, desired, className }: { path: string; desired: Desired; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <span data-el="plugin-off" data-vc-plugin={path} className={["flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground", className].filter(Boolean).join(" ")}>
      <span className="truncate">{offLine(path, desired)}</span>
      <button
        type="button"
        data-el="plugin-turn-on"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void setPluginRunning(path, true).finally(() => setBusy(false));
        }}
        className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground disabled:opacity-50"
      >
        Turn on
      </button>
    </span>
  );
}
