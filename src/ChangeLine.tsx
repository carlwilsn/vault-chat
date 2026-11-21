// A change's action inline in its chat line (src/changeFlow.ts): "Done: <what>" has Undo. Where it stands comes from the
// records (src/pluginDrafts.ts), so every window and the line read after a restart agree; the words after it say what
// happened (Undone., Undone by itself …). Part of the core: a change can never take its own Undo away (and the shell's
// Ctrl+Alt+Z works even then).
import { useState } from "react";
import { lineState, stateWords, type ChangeRef } from "./changeFlow";
import { changesOf, switchBack } from "./changeReady";
import { useSupervisorVersion } from "./pluginSupervisorApp";
import { useElsewhere } from "./changeElsewhere";

const btn = "shrink-0 rounded-md border border-border/70 px-2 py-0.5 text-[11px] leading-snug text-foreground/90 hover:bg-accent/60 disabled:opacity-50";

export function ChangeLine({ change }: { change: ChangeRef }) {
  useSupervisorVersion();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A change of a vault the laptop does not have open: that vault's records, and Undo written there.
  const away = useElsewhere(change);
  const s = lineState(change, away ? (away.changes ?? []) : changesOf(change.plugin));
  const undo = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await (away ? away.undo() : switchBack(change.plugin));
      if (r && r.ok === false) setErr(`Couldn't: ${r.text ?? "the box refused it"}`);
    } finally {
      setBusy(false);
    }
  };
  const words = stateWords(s);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 ml-1.5 align-middle" data-el="change-line" data-vc-state={s.state}>
      {s.state === "applied" && (
        <button type="button" className={btn} data-el="change-undo" disabled={busy} onClick={() => void undo()}>
          Undo
        </button>
      )}
      {away && <span className="text-muted-foreground" data-el="change-vault">(in {change.vault})</span>}
      {words && (
        <span className="text-muted-foreground" data-el="change-state">
          {words}
        </span>
      )}
      {err && (
        <span className="text-destructive" data-el="change-error">
          {err}
        </span>
      )}
    </span>
  );
}
