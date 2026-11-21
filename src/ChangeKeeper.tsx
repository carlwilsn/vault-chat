// The core's side of a landed change (src/changeFlow.ts): draws nothing. Each change is a line in a chat
// (src/ChangeLine.tsx) with Undo. This keeps what the lines stand on running: a kept copy watched for breaking
// (src/changeReady.ts), the offers the agent reads (app/changes), and the dead-man's switch (src/changeSafety.ts). Part
// of the core, never of a plugin, so no change can take it away.
import { useEffect } from "react";
import { declareOffers } from "./pluginOffers";
import { CHANGES_PLUGIN, changeOffers, noticeAutoSwitch, startChangeReady, watchTyping } from "./changeReady";
import { useSupervisorVersion } from "./pluginSupervisorApp";
import { startChangeSafety } from "./changeSafety";

export function ChangeKeeper() {
  useEffect(() => {
    startChangeReady();
    return startChangeSafety();
  }, []);
  const rv = useSupervisorVersion();
  useEffect(() => {
    watchTyping();
    noticeAutoSwitch();
  }, [rv]);
  // The offers: what happened last and the undo (PluginRead / PluginAct app/changes).
  useEffect(() => declareOffers(CHANGES_PLUGIN.id, CHANGES_PLUGIN.name, changeOffers()).undo, []);
  return null;
}
