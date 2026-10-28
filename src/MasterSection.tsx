// Settings → "vault-chat folder": one folder per machine (src/master.ts here, server/master.ts on the box), with
// vaults/ and projects/ in it, everything in it synced with the box. Set it for this laptop and for the box; see
// what is in it and whether each repo syncs; bring the open vault into it (a whole copy, verified, then switch;
// switch back in one step; the original is never moved or deleted).
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Button, Input } from "./ui";
import {
  masterPath,
  suggestedMaster,
  setMasterPath,
  localVaults,
  localProjects,
  boxMasterInfo,
  setBoxMaster,
  syncMasterFolder,
  copyVaultIn,
  switchToCopy,
  switchBack,
  migrationState,
  masterLayout,
  joinPath,
  type BoxMasterInfo,
  type Migration,
} from "./master";
import { subscribeBoxSync, boxSyncStates, type BoxSyncState } from "./vaultSync";

function SyncDot({ st }: { st: BoxSyncState | undefined }) {
  const r = st?.report;
  const color = !r ? "bg-muted-foreground/40" : r.error || r.conflict ? "bg-destructive" : "bg-emerald-500";
  const title = !r ? "not synced yet" : r.error ? r.error : r.conflict ? `conflict: ${r.conflict.files.join(", ")}` : r.origin_push ? `synced; ${r.origin_push}` : "synced";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} title={title} />;
}

const projectOrigin = (p: unknown): string | null => (p && typeof (p as { origin?: unknown }).origin === "string" ? (p as { origin: string }).origin : null);

export function MasterSection({ openVault }: { openVault: (path: string) => Promise<void> | void }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const [mine, setMine] = useState<string | null>(masterPath());
  const [draft, setDraft] = useState(masterPath() ?? "");
  const [boxInfo, setBoxInfo] = useState<BoxMasterInfo | null | undefined>(undefined);
  const [boxDraft, setBoxDraft] = useState("");
  const [vaults, setVaults] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [mig, setMig] = useState<Migration | null>(migrationState());
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!masterPath()) void suggestedMaster().then((s) => setDraft((d) => d || s));
    return subscribeBoxSync(() => setTick((n) => n + 1));
  }, []);
  const refresh = async () => {
    const m = masterPath();
    setMine(m);
    setVaults(await localVaults(m));
    setProjects(await localProjects(m));
    const info = await boxMasterInfo();
    setBoxInfo(info);
    if (info) setBoxDraft((d) => d || info.master || info.suggested);
  };
  useEffect(() => {
    void refresh();
  }, [vaultPath]);

  const saveMine = async () => {
    setBusy(true);
    const r = await setMasterPath(draft);
    setMsg("error" in r ? r.error : `This laptop's folder is ${r.path}.`);
    if (!("error" in r)) {
      const s = await syncMasterFolder();
      if (s.made.length) setMsg(`This laptop's folder is ${r.path}. Brought from the box: ${s.made.join(", ")}.`);
      if (s.errors.length) setMsg(s.errors.join("; "));
    }
    await refresh();
    setBusy(false);
  };
  const saveBox = async () => {
    setBusy(true);
    const r = await setBoxMaster(boxDraft);
    setMsg(r.ok ? `The box's folder is ${r.info?.master}.` : `The box: ${r.error}`);
    await refresh();
    setBusy(false);
  };
  const copyIn = async () => {
    if (!vaultPath) return;
    setBusy(true);
    setMsg("Copying the whole vault (every file and its history)…");
    const r = await copyVaultIn(vaultPath);
    if ("error" in r) setMsg(r.error);
    else {
      setMig(r);
      setMsg(r.check.ok ? `Copied and verified: ${r.check.files[1]} files, HEAD ${String(r.check.head[1]).slice(0, 8)} on both.` : `The copy differs: ${r.check.problems.join("; ")}`);
    }
    await refresh();
    setBusy(false);
  };
  const doSwitch = async (back: boolean) => {
    setBusy(true);
    const r = back ? await switchBack(openVault) : await switchToCopy(openVault);
    if ("error" in r) setMsg(r.error);
    else {
      setMig(r);
      setMsg(back ? `Back on ${r.from}. The copy stays in the folder.` : `Now on ${r.to}. ${r.from} is untouched and no longer syncs.`);
    }
    setBusy(false);
  };

  const states = boxSyncStates();
  const stateOf = (p: string) => states.get(p) ?? [...states.entries()].find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1];
  const inFolder = !!(mine && vaultPath && vaultPath.toLowerCase().startsWith(masterLayout(mine).vaults.toLowerCase() + "/"));

  return (
    <section className="space-y-3" data-settings="master">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">vault-chat folder</h3>
        <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
          One folder on each machine: <code>vaults/</code> and <code>projects/</code> in it, everything in it synced with the box.
        </p>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-muted-foreground">This laptop</div>
        <div className="flex gap-1.5">
          <Input data-el="master-path" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-[12px]" />
          <Button size="sm" data-el="master-save" disabled={busy || !draft.trim() || draft.trim() === mine} onClick={() => void saveMine()}>
            {mine ? "Change" : "Set"}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-muted-foreground">The box</div>
        {boxInfo === undefined ? (
          <div className="text-[11.5px] text-muted-foreground/70">Asking the box…</div>
        ) : boxInfo === null ? (
          <div className="text-[11.5px] text-muted-foreground/70">No box connected (Box, below).</div>
        ) : (
          <div className="flex gap-1.5">
            <Input data-el="box-master-path" value={boxDraft} disabled={!!boxInfo.fromEnv} onChange={(e) => setBoxDraft(e.target.value)} className="h-7 text-[12px]" />
            <Button size="sm" variant="outline" data-el="box-master-save" disabled={busy || !!boxInfo.fromEnv || !boxDraft.trim() || boxDraft.trim() === boxInfo.master} onClick={() => void saveBox()}>
              {boxInfo.master ? "Change" : "Set"}
            </Button>
          </div>
        )}
      </div>
      {mine && (
        <div className="rounded-md border border-border divide-y divide-border text-[12px]" data-el="master-repos">
          {[...vaults.map((n) => ({ kind: "vaults", n })), ...projects.map((n) => ({ kind: "projects", n }))].map(({ kind, n }) => {
            const p = joinPath(mine, kind, n);
            const onBox = kind === "projects" ? boxInfo?.projects.find((x) => x.name === n) : boxInfo?.vaults.find((x) => x.name === n);
            return (
              <div key={p} className="flex items-center gap-2 px-2.5 py-1.5" data-el="master-repo" data-repo={`${kind}/${n}`}>
                <SyncDot st={stateOf(p)} />
                <span className="text-muted-foreground w-14 shrink-0">{kind === "vaults" ? "vault" : "project"}</span>
                <span className="truncate flex-1">{n}</span>
                {kind === "projects" && projectOrigin(onBox) && <span className="text-[10.5px] text-muted-foreground truncate max-w-[40%]" title={projectOrigin(onBox)!}>{projectOrigin(onBox)!.replace(/^https:\/\/|\.git$/g, "")}</span>}
                {!onBox && boxInfo?.master && <span className="text-[10.5px] text-muted-foreground">not on the box yet</span>}
              </div>
            );
          })}
          {!vaults.length && !projects.length && <div className="px-2.5 py-1.5 text-muted-foreground/70">Empty: new vaults and projects go here.</div>}
        </div>
      )}
      {mine && vaultPath && (!inFolder || mig?.active) && (
        <div className="space-y-1.5" data-el="master-migrate">
          <div className="text-[11px] text-muted-foreground">Bring this vault into the folder</div>
          {!mig || mig.from.toLowerCase() !== vaultPath.toLowerCase().replace(/\/+$/, "") && !mig.active ? (
            <Button size="sm" variant="outline" data-el="master-copy" disabled={busy} onClick={() => void copyIn()}>
              Copy {vaultPath.split("/").pop()} into the folder
            </Button>
          ) : (
            <div className="flex gap-1.5 flex-wrap">
              {!mig.active && (
                <Button size="sm" data-el="master-switch" disabled={busy || !mig.check.ok} onClick={() => void doSwitch(false)}>
                  Use the copy
                </Button>
              )}
              {mig.active && (
                <Button size="sm" variant="outline" data-el="master-back" disabled={busy} onClick={() => void doSwitch(true)}>
                  Switch back to {mig.from}
                </Button>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground/80">The original stays where it is, untouched. Switching back is one step.</p>
        </div>
      )}
      {msg && <p className="text-[11.5px] text-foreground/80" data-el="master-msg">{msg}</p>}
    </section>
  );
}
