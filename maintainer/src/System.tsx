import { useEffect, useState } from "react";
import { Play, RefreshCw, Download, ExternalLink, X as XIcon, ArrowUpCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  type Release,
  type WorkflowRun,
  listReleases,
  listWorkflowRuns,
  dispatchWorkflow,
  cancelWorkflowRun,
  OWNER,
  REPO,
} from "./github";
import { cn, relativeTime } from "./lib";

// System tab — release management + manual ship + run status.
//
// "Install" downloads a release's Windows .msi via the Rust shim
// (`download_and_install`) and runs it in-place over the current
// vault-chat install. "Ship now" dispatches the main app's ship
// workflow. The status panel polls the latest two ship runs every
// 5s while the tab is mounted.

type SelfUpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "available"; update: Update }
  | { phase: "installing"; progress: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export function System({ token }: { token: string }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [shipState, setShipState] = useState<"idle" | "dispatching" | { error: string }>("idle");
  const [installState, setInstallState] = useState<Record<number, "idle" | "downloading" | "running" | { error: string }>>({});
  const [selfUpdate, setSelfUpdate] = useState<SelfUpdateState>({ phase: "idle" });

  // Check for maintainer updates via Tauri's updater plugin (signed
  // update flow, not the raw download-and-run we use for installing
  // arbitrary releases). Manual trigger only — no auto-check on
  // launch by design, so a bad maintainer release never auto-pushes.
  const checkSelfUpdate = async () => {
    setSelfUpdate({ phase: "checking" });
    try {
      const update = await check();
      if (!update) {
        setSelfUpdate({ phase: "none" });
        return;
      }
      setSelfUpdate({ phase: "available", update });
    } catch (e) {
      setSelfUpdate({ phase: "error", message: (e as Error).message });
    }
  };

  const installSelfUpdate = async () => {
    if (selfUpdate.phase !== "available") return;
    const update = selfUpdate.update;
    setSelfUpdate({ phase: "installing", progress: 0 });
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength ?? 0;
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setSelfUpdate({ phase: "installing", progress: pct });
        } else if (evt.event === "Finished") {
          setSelfUpdate({ phase: "ready" });
        }
      });
      setSelfUpdate({ phase: "ready" });
    } catch (e) {
      setSelfUpdate({ phase: "error", message: (e as Error).message });
    }
  };

  const refreshReleases = async () => {
    try {
      const list = await listReleases(token);
      setReleases(list);
      setReleasesError(null);
    } catch (e) {
      setReleasesError((e as Error).message);
    }
  };

  const refreshRuns = async () => {
    try {
      const list = await listWorkflowRuns(token, "ship.yml", 5);
      setRuns(list);
      setRunsError(null);
    } catch (e) {
      setRunsError((e as Error).message);
    }
  };

  useEffect(() => {
    void refreshReleases();
    void refreshRuns();
    // Poll runs every 5s while mounted so manual ship status is live.
    const id = setInterval(() => void refreshRuns(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const shipNow = async () => {
    setShipState("dispatching");
    try {
      await dispatchWorkflow(token, "ship.yml");
      // Give GitHub a beat before refreshing — dispatch returns 204
      // before the run is queryable.
      setTimeout(() => void refreshRuns(), 1500);
      setShipState("idle");
    } catch (e) {
      setShipState({ error: (e as Error).message });
    }
  };

  const cancelRun = async (id: number) => {
    try {
      await cancelWorkflowRun(token, id);
      setTimeout(() => void refreshRuns(), 1500);
    } catch (e) {
      console.error("cancel failed:", e);
    }
  };

  const installRelease = async (release: Release) => {
    // Find a Windows installer asset. Prefer NSIS (.exe), fall back to MSI.
    const asset =
      release.assets.find((a) => /\.(exe)$/i.test(a.name) && /setup|installer/i.test(a.name)) ??
      release.assets.find((a) => /\.exe$/i.test(a.name)) ??
      release.assets.find((a) => /\.msi$/i.test(a.name));
    if (!asset) {
      setInstallState((s) => ({ ...s, [release.id]: { error: "No Windows installer asset on this release." } }));
      return;
    }
    setInstallState((s) => ({ ...s, [release.id]: "downloading" }));
    try {
      await invoke("download_and_install", { url: asset.browser_download_url, filename: asset.name });
      setInstallState((s) => ({ ...s, [release.id]: "running" }));
    } catch (e) {
      setInstallState((s) => ({ ...s, [release.id]: { error: (e as Error).message } }));
    }
  };

  return (
    <div className="p-4 space-y-6 max-w-[820px]">
      {/* Self-update — manual check only, signed via Tauri updater
          plugin. Different mechanism from the Releases list below
          (which uses raw download_and_install). */}
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
          Maintainer self-update
        </h2>
        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
          Pulls the latest signed maintainer release through the Tauri updater. Manual
          trigger only — no auto-check on launch, so a bad release can't auto-push itself.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void checkSelfUpdate()}
            disabled={selfUpdate.phase === "checking" || selfUpdate.phase === "installing"}
            className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded border border-border bg-background/60 hover:bg-accent disabled:opacity-50"
          >
            <ArrowUpCircle className="h-3 w-3" />
            {selfUpdate.phase === "checking" ? "Checking…" : "Check for updates"}
          </button>
          {selfUpdate.phase === "none" && (
            <span className="text-[11.5px] text-muted-foreground">You're on the latest.</span>
          )}
          {selfUpdate.phase === "available" && (
            <>
              <span className="text-[11.5px] text-foreground/90">
                v{selfUpdate.update.version} available
              </span>
              <button
                onClick={() => void installSelfUpdate()}
                className="bg-indigo-500 hover:bg-indigo-400 text-white text-[12px] px-3 py-1.5 rounded inline-flex items-center gap-1.5"
              >
                <Download className="h-3 w-3" />
                Install
              </button>
            </>
          )}
          {selfUpdate.phase === "installing" && (
            <span className="text-[11.5px] text-muted-foreground">
              Downloading… {selfUpdate.progress}%
            </span>
          )}
          {selfUpdate.phase === "ready" && (
            <>
              <span className="text-[11.5px] text-emerald-500">Ready — restart to apply.</span>
              <button
                onClick={() => void relaunch()}
                className="bg-emerald-500 hover:bg-emerald-400 text-white text-[12px] px-3 py-1.5 rounded"
              >
                Restart now
              </button>
            </>
          )}
          {selfUpdate.phase === "error" && (
            <span className="text-[11.5px] text-destructive">{selfUpdate.message}</span>
          )}
        </div>
      </section>

      {/* Manual ship */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
            Manual ship
          </h2>
          <button
            onClick={() => void refreshRuns()}
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <RefreshCw className="h-3 w-3" /> refresh
          </button>
        </div>
        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
          Triggers the <code className="font-mono bg-muted px-1 rounded text-[10.5px]">ship.yml</code>{" "}
          workflow on <code className="font-mono bg-muted px-1 rounded text-[10.5px]">main</code>.
          Bumps the patch version and publishes a new GitHub release.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={shipNow}
            disabled={shipState === "dispatching"}
            className="bg-indigo-500 hover:bg-indigo-400 text-white text-[12px] px-3 py-1.5 rounded inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {shipState === "dispatching" ? "Dispatching…" : "Ship now"}
          </button>
          {typeof shipState === "object" && "error" in shipState && (
            <span className="text-[11.5px] text-destructive">{shipState.error}</span>
          )}
        </div>

        {/* Recent ship runs */}
        <div className="rounded border border-border bg-card/40 mt-2">
          {runsError && <div className="px-3 py-2 text-[11.5px] text-destructive">{runsError}</div>}
          {runs === null && !runsError && (
            <div className="px-3 py-2 text-[11.5px] text-muted-foreground italic">Loading…</div>
          )}
          {runs && runs.length === 0 && (
            <div className="px-3 py-2 text-[11.5px] text-muted-foreground italic">No runs yet.</div>
          )}
          {runs && runs.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 px-3 py-1.5 border-b border-border/40 last:border-b-0 text-[11.5px]"
            >
              <RunBadge run={r} />
              <span className="font-mono text-muted-foreground">{r.head_sha.slice(0, 7)}</span>
              <span className="text-muted-foreground/80">{r.event}</span>
              <span className="text-muted-foreground/80">{relativeTime(r.created_at)}</span>
              <div className="ml-auto flex items-center gap-2">
                {(r.status === "queued" || r.status === "in_progress") && (
                  <button
                    onClick={() => void cancelRun(r.id)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Cancel run"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
                <a
                  href={r.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline inline-flex items-center gap-0.5"
                >
                  logs <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Releases */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
            Releases
          </h2>
          <button
            onClick={() => void refreshReleases()}
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <RefreshCw className="h-3 w-3" /> refresh
          </button>
        </div>
        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
          Roll the installed app back to (or forward to) any published version. The installer
          runs over the existing install in place — your settings, keys, and vault path are
          preserved.
        </p>
        {releasesError && (
          <div className="text-[11.5px] text-destructive">{releasesError}</div>
        )}
        <div className="rounded border border-border bg-card/40 divide-y divide-border/40">
          {releases === null && !releasesError && (
            <div className="px-3 py-2 text-[11.5px] text-muted-foreground italic">Loading…</div>
          )}
          {releases && releases.map((rel) => {
            const st = installState[rel.id] ?? "idle";
            const downloading = st === "downloading";
            const running = st === "running";
            const stError = typeof st === "object" && "error" in st ? st.error : null;
            return (
              <div key={rel.id} className="px-3 py-2 flex items-center gap-3 text-[12px]">
                <span className="font-mono text-foreground/90 shrink-0 w-[80px]">{rel.tag_name}</span>
                <span className="text-[11px] text-muted-foreground/90 shrink-0">
                  {relativeTime(rel.published_at)}
                </span>
                {rel.prerelease && (
                  <span className="text-[10px] uppercase tracking-wider rounded bg-amber-500/15 text-amber-500 px-1.5 py-0.5">
                    prerelease
                  </span>
                )}
                <div className="flex-1 min-w-0 truncate text-muted-foreground/80">
                  {rel.name}
                </div>
                {stError && <span className="text-[11px] text-destructive truncate">{stError}</span>}
                <button
                  onClick={() => void installRelease(rel)}
                  disabled={downloading || running}
                  className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-background/60 hover:bg-accent disabled:opacity-50"
                >
                  <Download className="h-3 w-3" />
                  {downloading ? "Downloading…" : running ? "Running…" : "Install"}
                </button>
                <a
                  href={rel.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline inline-flex items-center gap-0.5 text-[11px]"
                >
                  notes <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })}
        </div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono">
          {OWNER}/{REPO}
        </div>
      </section>
    </div>
  );
}

function RunBadge({ run }: { run: WorkflowRun }) {
  const cls = cn(
    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold shrink-0",
    run.status === "queued" && "bg-muted text-muted-foreground border-border",
    run.status === "in_progress" && "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
    run.status === "completed" && run.conclusion === "success" && "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    run.status === "completed" && run.conclusion === "failure" && "bg-rose-500/15 text-rose-400 border-rose-500/40",
    run.status === "completed" && run.conclusion === "cancelled" && "bg-muted/40 text-muted-foreground/60 border-border/60",
  );
  const label =
    run.status === "completed" ? (run.conclusion ?? "done") : run.status.replace("_", " ");
  return <span className={cls}>{label}</span>;
}
