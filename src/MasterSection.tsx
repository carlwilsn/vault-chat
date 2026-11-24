// Settings → "vault-chat folder": the laptop's one folder (src/master.ts), vaults/ and projects/ in it, everything in
// it synced with the box. Only the path is shown and set here; the vaults and projects in it, and the box's folder,
// stay readable by the agent (app/settings' folder state, src/settingsBox.ts). Everything lives in the folder (Carl,
// 2026-10-28): no copy-in from elsewhere in the app.
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Button, Input } from "./ui";
import { masterPath, suggestedMaster } from "./master";
import { setFolder } from "./settingsBox";

export function MasterSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [mine, setMine] = useState<string | null>(masterPath());
  const [draft, setDraft] = useState(masterPath() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!masterPath()) void suggestedMaster().then((s) => setDraft((d) => d || s));
  }, []);
  useEffect(() => setMine(masterPath()), [vaultPath]);

  const save = async () => {
    setBusy(true);
    // The one set (src/settingsBox.ts), as app/settings' setFolder.
    setMsg(await setFolder(draft));
    setMine(masterPath());
    setBusy(false);
  };

  return (
    <section className="space-y-3" data-settings="master">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">vault-chat folder</h3>
        <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">Your vaults and projects live here, each synced with the box.</p>
      </div>
      <div className="flex gap-1.5">
        <Input data-el="master-path" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-[12px]" />
        <Button data-offer="app/settings.setFolder" size="sm" data-el="master-save" disabled={busy || !draft.trim() || draft.trim() === mine} onClick={() => void save()}>
          {mine ? "Change" : "Set"}
        </Button>
      </div>
      {msg && <p className="text-[11.5px] text-foreground/80" data-el="master-msg">{msg}</p>}
    </section>
  );
}
