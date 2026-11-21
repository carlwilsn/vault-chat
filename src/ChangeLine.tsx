// A change's actions inline in its chat line (src/changeFlow.ts): "Done: <what>" has Undo; "<what> — Try it?" has Try,
// then Keep / Undo while it is tried. Where it stands comes from the records (src/pluginDrafts.ts), so every window
// and the line read after a restart agree; the words after it say what happened (Kept., Undone., Undone by itself …).
// Part of the core: a change can never take its own Undo away (and the shell's Ctrl+Alt+Z works even then).
import { useState } from "react";
import { lineState, stateWords, type ChangeRef } from "./changeFlow";
import { changesOf, discardChange, keepChange, migrationTryOf, switchBack, tryChange, useMigrationTry, usePendingChanges, useTried } from "./changeReady";
import { useSupervisorVersion } from "./pluginSupervisorApp";
import { useElsewhere } from "./changeElsewhere";

const btn = "shrink-0 rounded-md border border-border/70 px-2 py-0.5 text-[11px] leading-snug text-foreground/90 hover:bg-accent/60 disabled:opacity-50";

export function ChangeLine({ change }: { change: ChangeRef }) {
  useSupervisorVersion();
  useMigrationTry();
  const pending = usePendingChanges();
  const tried = useTried(change.plugin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = pending.find((p) => p.plugin === change.plugin && p.version === change.version) ?? null;
  const waiting = !!mine;
  // A change of a vault the laptop does not have open: that vault's records, and Undo written there.
  const away = useElsewhere(change);
  const s = away ? lineState(change, away.changes ?? [], false, null) : lineState(change, changesOf(change.plugin), waiting, tried);
  const act = async (fn: () => Promise<{ ok: boolean; text: string }> | unknown) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = (await fn()) as { ok?: boolean; text?: string } | undefined;
      if (r && r.ok === false) setErr(`Couldn't: ${r.text ?? "the box refused it"}`);
    } finally {
      setBusy(false);
    }
  };
  const words = stateWords(s);
  const mig = migrationTryOf(change.plugin, change.version);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 ml-1.5 align-middle" data-el="change-line" data-vc-state={s.state}>
      {(s.state === "applied" || s.state === "kept") && (
        <button type="button" className={btn} data-el="change-undo" disabled={busy} onClick={() => void act(() => (away ? away.undo() : switchBack(change.plugin)))}>
          Undo
        </button>
      )}
      {away && <span className="text-muted-foreground" data-el="change-vault">(in {change.vault})</span>}
      {s.state === "offered" && mine?.triable !== false && (
        <button type="button" className={btn} data-el="change-try" disabled={busy} onClick={() => void act(() => tryChange(change.plugin, change.version))}>
          Try
        </button>
      )}
      {s.state === "offered" && mine?.triable === false && (
        // Nothing to try here (a setting only the box applies): Keep sets it, Undo drops it.
        <>
          <button type="button" className={btn} data-el="change-keep" disabled={busy} onClick={() => void act(() => keepChange(change.plugin, change.version))}>
            Keep
          </button>
          <button type="button" className={btn} data-el="change-undo" disabled={busy} onClick={() => void act(() => discardChange(change.plugin, change.version))}>
            Undo
          </button>
        </>
      )}
      {s.state === "trying" && (
        <>
          <button type="button" className={btn} data-el="change-keep" disabled={busy || (!!mig && mig.state !== "done")} onClick={() => void act(() => keepChange(change.plugin, change.version))}>
            Keep
          </button>
          <button type="button" className={btn} data-el="change-undo" disabled={busy} onClick={() => void act(() => discardChange(change.plugin, change.version))}>
            Undo
          </button>
          {mig && <span className="text-muted-foreground" data-el="change-migration">{mig.state === "running" ? "Checking it on a copy of your data…" : mig.state === "failed" ? `It failed on a copy of your data: ${mig.error}` : mig.line}</span>}
        </>
      )}
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
