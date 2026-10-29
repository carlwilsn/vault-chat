// Settings → "vault-chat folder": the laptop's one folder (src/master.ts), vaults/ and projects/ in it, everything in
// it synced with the box. The box's folder is its own (VC_MASTER, set at install) and is only shown here. Everything
// lives in the folder (Carl, 2026-10-28): no copy-in from elsewhere in the app (the record is the box's CLI,
// server/masterCli.ts).
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Button, Input } from "./ui";
import { masterPath, suggestedMaster, setMasterPath, localVaults, localProjects, boxMasterInfo, syncMasterFolder, joinPath, type BoxMasterInfo } from "./master";
import { subscribeBoxSync, boxSyncStates, type BoxSyncState } from "./vaultSync";

function SyncDot({ st }: { st: BoxSyncState | undefined }) {
  const r = st?.report;
  const color = !r ? "bg-muted-foreground/40" : r.error || r.conflict ? "bg-destructive" : "bg-emerald-500";
  const title = !r ? "not synced yet" : r.error ? r.error : r.conflict ? `conflict: ${r.conflict.files.join(", ")}` : r.origin_push ? `synced; ${r.origin_push}` : "synced";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} title={title} />;
}

const originOf = (p: unknown): string | null => (p && typeof (p as { origin?: unknown }).origin === "string" ? (p as { origin: string }).origin : null);

export function MasterSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [mine, setMine] = useState<string | null>(masterPath());
  const [draft, setDraft] = useState(masterPath() ?? "");
  const [boxInfo, setBoxInfo] = useState<BoxMasterInfo | null | undefined>(undefined);
  const [vaults, setVaults] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
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
    setBoxInfo(await boxMasterInfo());
  };
  useEffect(() => {
    void refresh();
  }, [vaultPath]);

  const save = async () => {
    setBusy(true);
    const r = await setMasterPath(draft);
    if ("error" in r) setMsg(r.error);
    else {
      const s = await syncMasterFolder();
      setMsg(s.errors.length ? s.errors.join("; ") : s.made.length ? `Brought from the box: ${s.made.join(", ")}.` : null);
    }
    await refresh();
    setBusy(false);
  };

  const states = boxSyncStates();
  const stateOf = (p: string) => states.get(p) ?? [...states.entries()].find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1];

  return (
    <section className="space-y-3" data-settings="master">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">vault-chat folder</h3>
        <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
          Your vaults and projects live here, each synced with the box{boxInfo?.master ? <> (its folder: <code>{boxInfo.master}</code>)</> : null}.
        </p>
      </div>
      <div className="flex gap-1.5">
        <Input data-el="master-path" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-[12px]" />
        <Button size="sm" data-el="master-save" disabled={busy || !draft.trim() || draft.trim() === mine} onClick={() => void save()}>
          {mine ? "Change" : "Set"}
        </Button>
      </div>
      {mine && (
        <div className="rounded-md border border-border divide-y divide-border text-[12px]" data-el="master-repos">
          {[...vaults.map((n) => ({ kind: "vaults", n })), ...projects.map((n) => ({ kind: "projects", n }))].map(({ kind, n }) => {
            const p = joinPath(mine, kind, n);
            const onBox = kind === "projects" ? boxInfo?.projects.find((x) => x.name === n) : boxInfo?.vaults.find((x) => x.name === n);
            const origin = originOf(onBox);
            return (
              <div key={p} className="flex items-center gap-2 px-2.5 py-1.5" data-el="master-repo" data-repo={`${kind}/${n}`}>
                <SyncDot st={stateOf(p)} />
                <span className="text-muted-foreground w-14 shrink-0">{kind === "vaults" ? "vault" : "project"}</span>
                <span className="truncate flex-1">{n}</span>
                {origin && <span className="text-[10.5px] text-muted-foreground truncate max-w-[40%]" title={origin}>{origin.replace(/^https:\/\/|\.git$/g, "")}</span>}
                {!onBox && boxInfo?.master && <span className="text-[10.5px] text-muted-foreground">not on the box yet</span>}
              </div>
            );
          })}
          {!vaults.length && !projects.length && <div className="px-2.5 py-1.5 text-muted-foreground/70">Empty: new vaults and projects go here.</div>}
        </div>
      )}
      {msg && <p className="text-[11.5px] text-foreground/80" data-el="master-msg">{msg}</p>}
    </section>
  );
}
