// The core's side of a change reaching Carl (src/changeFlow.ts, the Try redesign): draws nothing. There is no card and
// no glow: each change is a line in a chat (src/ChangeLine.tsx) with Undo, or Try then Keep / Undo. This keeps what the
// lines stand on running: what this app's windows try (src/changeReady.ts), the box's waiting changes, a kept copy
// watched for breaking, the offers the agent reads (app/changes: staged, untried), the "Try it?" lines in Main, and
// the dead-man's switch (src/changeSafety.ts). Part of the core, never of a plugin, so no change can take it away.
import { useEffect } from "react";
import { declareOffers } from "./pluginOffers";
import { CHANGES_PLUGIN, changeOffers, dropTriesFromBefore, noticeAutoSwitch, offerPending, refreshBoxDrafts, startChangeReady, usePendingChanges, watchTyping } from "./changeReady";
import { useSupervisorVersion } from "./pluginSupervisorApp";
import { startChangeSafety } from "./changeSafety";

export function ChangeKeeper() {
  const pending = usePendingChanges();
  useEffect(() => {
    startChangeReady();
    void dropTriesFromBefore();
    return startChangeSafety();
  }, []);
  // The box's own changes (box plugins, migrations, the core): read again when the records change, and every minute.
  useEffect(() => {
    const t = setInterval(() => void refreshBoxDrafts(), 60_000);
    return () => clearInterval(t);
  }, []);
  const rv = useSupervisorVersion();
  useEffect(() => {
    watchTyping();
    noticeAutoSwitch();
  }, [rv, pending]);
  useEffect(() => void refreshBoxDrafts(), [rv]);
  // Each change waiting for Carl has its one "Try it?" line in Main.
  const key = pending.map((p) => `${p.plugin}@${p.version}`).join("|");
  useEffect(() => void offerPending(pending), [key]);
  // The offers: the agent reads what is staged and untried (PluginRead app/changes) and can act on it.
  useEffect(() => declareOffers(CHANGES_PLUGIN.id, CHANGES_PLUGIN.name, changeOffers()).undo, []);
  return null;
}
