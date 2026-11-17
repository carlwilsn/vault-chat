// The "Change ready" notice (src/changeReady.ts): a plugin's draft waits for Carl. Shaped like "Update ready"
// (src/UpdateBanner.tsx): Try runs it on his windows only; then Keep or Discard (each a record on the box); Back stops
// trying. A settings draft of only the box's settings (the model, the voice …) has no Try: Keep / Discard at once. Part of the core, never of the plugin tried, with shortcuts that work whatever the draft does to the screen.
import { useEffect, useState } from "react";
import { FlaskConical, X, Check, Undo2, Play } from "lucide-react";
import { Button } from "./ui";
import { declareOffers } from "./pluginOffers";
import { chordText, hit, shortcut } from "./shortcuts";
import {
  CHANGES_PLUGIN,
  changeOffers,
  clearOutcome,
  discardChange,
  keepChange,
  noticeAutoSwitch,
  refreshBoxDrafts,
  startChangeReady,
  stopTrying,
  switchBack,
  tryChange,
  useOutcome,
  usePendingChanges,
  useTries,
  watchTyping,
  type PendingChange,
} from "./changeReady";
import { useSupervisorVersion } from "./pluginSupervisorApp";

const tip = (label: string, id: "change.try" | "change.keep" | "change.discard") => `${label} (${chordText(shortcut(id).keys[0]!)})`;

export function ChangeReady() {
  const pending = usePendingChanges();
  const outcome = useOutcome();
  const [later, setLater] = useState<string | null>(null);
  const tries = useTries();
  // The one shown: the draft being tried, else the first waiting.
  const shown: PendingChange | null = pending.find((p) => tries[p.plugin] === p.version) ?? pending[0] ?? null;
  const trying = !!shown && tries[shown.plugin] === shown.version;
  // A draft Try can't run (settings only the box applies): Keep / Discard straight away.
  const direct = !!shown && !shown.triable;
  const [busy, setBusy] = useState(false);

  useEffect(() => startChangeReady(), []);
  // The box plugins' drafts live on the box: read again when the records change, and every minute.
  useEffect(() => {
    const t = setInterval(() => void refreshBoxDrafts(), 60_000);
    return () => clearInterval(t);
  }, []);
  // The records changed: a keep to watch (or one no longer watched), a switch back by itself to tell of.
  const rv = useSupervisorVersion();
  useEffect(() => {
    watchTyping();
    noticeAutoSwitch();
  }, [rv, pending]);
  useEffect(() => void refreshBoxDrafts(), [rv]);
  // The offers: the agent reads whether Carl is trying a draft (PluginRead app/changes) and can act on it.
  useEffect(() => declareOffers(CHANGES_PLUGIN.id, CHANGES_PLUGIN.name, changeOffers()).undo, []);

  const act = async (fn: () => Promise<unknown> | void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const doTry = () => shown && !direct && (trying ? stopTrying(shown.plugin) : tryChange(shown.plugin, shown.version));
  const doKeep = () => shown && void act(() => keepChange(shown.plugin, shown.version));
  const doDiscard = () => shown && void act(() => discardChange(shown.plugin, shown.version));

  // The shortcuts: in the capture phase, so a draft that swallows keys cannot hide them.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (hit(e, "change.try")) doTry();
      else if (hit(e, "change.keep") && (trying || direct)) doKeep();
      else if (hit(e, "change.discard")) doDiscard();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const hidden = !shown || (later === `${shown.plugin}@${shown.version}` && !trying);
  if (hidden && !outcome) return null;

  return (
    <div data-el="change-ready" data-vc-trying={trying ? "1" : undefined} className="fixed top-12 right-4 w-80 z-50 rounded-lg border border-border bg-card shadow-xl overflow-hidden">
      {!hidden && shown && (
        <>
          <div className="flex items-start gap-2.5 p-3 border-b border-border bg-gradient-to-br from-accent/40 to-transparent">
            <div className="h-7 w-7 rounded-md bg-accent/60 text-foreground flex items-center justify-center shrink-0">
              <FlaskConical className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-foreground/95" data-el="change-ready-title">
                Change ready: {shown.what || (shown.added ? `new plugin ${shown.name}` : shown.name)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
                {shown.name} · {shown.version}
                {pending.length > 1 ? ` · ${pending.length - 1} more` : ""}
              </div>
            </div>
            {!trying && (
              <button onClick={() => setLater(`${shown.plugin}@${shown.version}`)} className="text-muted-foreground hover:text-foreground" title="Later">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="p-3 space-y-2.5">
            {trying && <div className="text-[11.5px] text-muted-foreground/90 leading-relaxed">Trying it on this laptop's windows. Nothing on the box changes until you keep it.</div>}
            {direct && <div data-el="change-direct" className="text-[11.5px] text-muted-foreground/90 leading-relaxed">The box applies this, so it can't be tried on your windows only. Keep sets it; Switch back undoes it.</div>}
            <div className="flex gap-2">
              {trying || direct ? (
                <>
                  <Button size="sm" data-el="change-keep" disabled={busy} onClick={doKeep} title={tip("Keep", "change.keep")} className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1">
                    <Check className="h-3 w-3 mr-1.5" />
                    Keep
                  </Button>
                  <Button size="sm" variant="ghost" data-el="change-discard" disabled={busy} onClick={doDiscard} title={tip("Discard", "change.discard")}>
                    Discard
                  </Button>
                  {trying && (
                    <Button size="sm" variant="ghost" data-el="change-back" disabled={busy} onClick={doTry} title={tip("Back to the current one", "change.try")}>
                      <Undo2 className="h-3 w-3" />
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button size="sm" data-el="change-try" disabled={busy} onClick={doTry} title={tip("Try it on your windows", "change.try")} className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1">
                    <Play className="h-3 w-3 mr-1.5" />
                    Try
                  </Button>
                  <Button size="sm" variant="ghost" data-el="change-discard" disabled={busy} onClick={doDiscard} title={tip("Discard", "change.discard")}>
                    Discard
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      )}
      {outcome && (
        <div data-el="change-outcome" className={`flex items-start gap-2 px-3 py-2 text-[11.5px] ${hidden ? "" : "border-t border-border"} ${outcome.ok ? "text-muted-foreground" : "text-destructive"}`}>
          <span className="flex-1 min-w-0 break-words">
            {outcome.name}: {outcome.text}
          </span>
          {outcome.ok && /^Kept/.test(outcome.text) && (
            <button data-el="change-switch-back" className="underline hover:text-foreground shrink-0" onClick={() => void act(() => switchBack(outcome.plugin))}>
              Switch back
            </button>
          )}
          <button onClick={clearOutcome} className="text-muted-foreground hover:text-foreground shrink-0" title="Dismiss">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
