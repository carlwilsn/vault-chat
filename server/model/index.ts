// The model on the box (report 24 §4): each noun Carl and the agent share is one file here with its state, its actions
// and its changes, answered by the box with or without a device. The app's controls and the agent's tools both call
// these actions; a parity test (server/test/model.test.ts) keeps every UI action of a moved noun reachable here.
//
// Moved so far: settings, notes, pages, workspace, history. The agent reaches a noun through PluginRead / PluginAct {plugin: "box:<noun>"} (server/boxOffers.ts
// turns each noun into a box offer); the noun's own tool is gone once it is here.
import type { JsonSchema } from "../boxOffers";
import { historyNoun } from "./history";
import { notesNoun } from "./notes";
import { pagesNoun } from "./pages";
import { settingsNoun } from "./settings";
import { workspaceNoun } from "./workspace";

export type ActResult = { ok: boolean; text: string };
export type NounAction = { description: string; args?: JsonSchema; /** A search: it changes nothing (no read-back). */ readOnly?: boolean; run: (args: Record<string, unknown>, by: string) => ActResult | Promise<ActResult> };
export type Noun = {
  id: string;
  name: string;
  /** What each part of its state is, and how to read it now. */
  state: Record<string, { description: string; read: () => unknown | Promise<unknown> }>;
  actions: Record<string, NounAction>;
  /** Call `fn` each time its state changes; returns the unsubscribe. */
  watch: (fn: () => void) => () => void;
};

/** What a noun is read in: the vault of the asking conversation (notes resolve their registry from it, pages their records),
 *  the feed to the devices (the workspace asks the laptop over it), the vaults and the asking chat (history). */
export type NounCtx = {
  vault: string;
  emit?: (ev: Record<string, unknown>) => void;
  ackMs?: number;
  /** Every registered vault's path (history searches all their event logs), and the asking chat (its transcript). */
  vaults?: () => string[];
  conv?: string;
};

/** Every moved noun. */
export const nouns = (ctx: NounCtx): Noun[] => [settingsNoun, notesNoun(ctx.vault), pagesNoun(ctx.vault), workspaceNoun(ctx), historyNoun(ctx)];

export const noun = (id: string, ctx: NounCtx): Noun | null => nouns(ctx).find((n) => n.id === id) ?? null;

/** Resolve on the noun's next change, or after `ms`; true when it changed. */
export function nextChange(n: Noun, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let off = () => {};
    const t = setTimeout(() => (off(), resolve(false)), Math.max(0, ms));
    off = n.watch(() => (clearTimeout(t), off(), resolve(true)));
  });
}
