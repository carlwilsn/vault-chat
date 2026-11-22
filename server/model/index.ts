// The model on the box (report 24 §4): each noun Carl and the agent share is one file here with its state, its actions
// and its changes, answered by the box with or without a device. The app's controls and the agent's tools both call
// these actions; a parity test (server/test/model.test.ts) keeps every UI action of a moved noun reachable here.
//
// Moved so far: settings. The agent reaches a noun through PluginRead / PluginAct {plugin: "box:<noun>"} (server/boxOffers.ts
// turns each noun into a box offer); the noun's own tool is gone once it is here.
import type { JsonSchema } from "../boxOffers";
import { settingsNoun } from "./settings";

export type ActResult = { ok: boolean; text: string };
export type NounAction = { description: string; args?: JsonSchema; run: (args: Record<string, unknown>, by: string) => ActResult | Promise<ActResult> };
export type Noun = {
  id: string;
  name: string;
  /** What each part of its state is, and how to read it now. */
  state: Record<string, { description: string; read: () => unknown | Promise<unknown> }>;
  actions: Record<string, NounAction>;
  /** Call `fn` each time its state changes; returns the unsubscribe. */
  watch: (fn: () => void) => () => void;
};

export const NOUNS: Noun[] = [settingsNoun];

export const noun = (id: string): Noun | null => NOUNS.find((n) => n.id === id) ?? null;

/** Resolve on the noun's next change, or after `ms`; true when it changed. */
export function nextChange(n: Noun, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let off = () => {};
    const t = setTimeout(() => (off(), resolve(false)), Math.max(0, ms));
    off = n.watch(() => (clearTimeout(t), off(), resolve(true)));
  });
}
