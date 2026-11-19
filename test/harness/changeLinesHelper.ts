// The chat's change lines as the tests see them (src/ChangeLine.tsx): every change waiting for Carl gets its
// "<what> — Try it?" line (as the box writes into Main), and a line stays once seen (as it does in the chat), so a kept or
// undone one still shows where it stands. Not part of the app.
import { createElement, useEffect, useRef } from "react";
import { declareOffers } from "../../src/pluginOffers.ts";
import { ChangeLine } from "../../src/ChangeLine.tsx";
import { CHANGES_PLUGIN, changeOffers, startChangeReady, usePendingChanges, type PendingChange } from "../../src/changeReady.ts";
import { offerText, plainWhat } from "../../src/changeFlow.ts";

export function TestLines() {
  const pending = usePendingChanges();
  // What the app's ChangeKeeper starts (without its timers): the following, and the offers the agent reads.
  useEffect(() => {
    startChangeReady();
    return declareOffers(CHANGES_PLUGIN.id, CHANGES_PLUGIN.name, changeOffers()).undo;
  }, []);
  const seen = useRef<PendingChange[]>([]);
  for (const p of pending) if (!seen.current.some((x) => x.plugin === p.plugin && x.version === p.version)) seen.current.push(p);
  return createElement(
    "div",
    null,
    ...seen.current.map((p) =>
      createElement(
        "div",
        { key: `${p.plugin}@${p.version}`, "data-el": "test-line", "data-plugin": p.plugin, "data-version": p.version },
        offerText(plainWhat(p.what, p.name)),
        createElement(ChangeLine, { change: { plugin: p.plugin, version: p.version, offer: "try" } }),
      ),
    ),
  );
}

/** The newest line's state (data-vc-state), or null. */
export const lineStateOf = (root: { querySelectorAll(s: string): ArrayLike<Element> }): string | null => {
  const all = root.querySelectorAll('[data-el="change-line"]');
  return all.length ? (all[all.length - 1] as Element).getAttribute("data-vc-state") : null;
};
