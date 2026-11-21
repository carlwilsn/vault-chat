// The chat lines of a change (src/changeFlow.ts, the Try redesign): the box writes them into the conversation as notices
// with the change they are about (`change: {plugin, version, offer}`), and the chat draws Undo / Try / Keep inline from
// the records (src/ChangeLine.tsx). One line per change and kind (its id), so writing it twice writes it once.
//
//   gateOutcome   what the draft gate found (server/supervisorTools.ts runs scripts/draft-check.ts): asked for and
//                 applied: "Done: <what>" + Undo in the chat that asked; not applied: one plain line there; not asked
//                 for: a visible change is staged and Main gets "<what> — Try it?", an invisible one applies with a log line.
//   offerChange   a change waiting for Carl that the laptop found (a core bundle with something to see, a box plugin's
//                 draft …): the same "Try it?" line in Main (POST /api/v2/changes/offer).
//   undoLast      the native shell's Undo (Ctrl+Alt+Z, the tray) and its dead-man's switch (POST /api/v2/changes/undo-last):
//                 what is tried is discarded, else the newest applied change switches back; the chat says so.
//   autoUndone    a change that reverted by itself (a switch or discard by "auto"): the chat says so.
import { APP_PLUGINS } from "../src/appPlugins";
import { CORE_NAME, CORE_PART } from "../src/coreBundle";
import { BUILT_IN, landing, type ChangeRecord } from "../src/pluginDrafts";
import { autoUndoText, changeLineId, doneText, failedText, notYetText, offerText, plainWhat, plainWhy, UNDO_CHORD, type ChangeRef } from "../src/changeFlow";
import { MAIN_ID } from "../src/threads";
import { laptopElsewhere, vaultName } from "./deviceLink";

export type ChangeLine = { kind: "done" | "failed" | "offer" | "auto"; plugin: string; version: string; text: string; level?: "info" | "error"; offer?: ChangeRef["offer"]; vault?: string };

/** Tests: where lines go instead of the conversation log. */
let sink: ((vault: string, conv: string, line: ChangeLine) => void) | null = null;
export function _setChangeLineSink(fn: typeof sink): void {
  sink = fn;
}
/** What the box logs about changes (a log line for a change applied silently). */
let logLine: (t: string) => void = (t) => console.log(`[changes] ${t}`);
export function _setChangeLog(fn: (t: string) => void): void {
  logLine = fn;
}

/** A plugin's name as Carl knows it. */
export function changeName(plugin: string): string {
  if (plugin === CORE_PART) return CORE_NAME;
  const app = APP_PLUGINS.find((p) => p.id === plugin)?.name;
  if (app) return app;
  const base = plugin.split("/").pop() ?? plugin;
  return base.replace(/\.(?:draft\.)?m?js$/i, "").replace(/[-_]+/g, " ");
}

/** Write one change line into a conversation (null: Main), once. Never throws. */
export async function sayChange(vault: string, conv: string | null, line0: ChangeLine): Promise<void> {
  const convId = conv || MAIN_ID;
  // A part that is one per vault names its vault: the line's Undo acts on that vault's records even when the laptop has
  // another open (src/changeElsewhere.ts).
  const line: ChangeLine = !line0.vault && perVaultPart(line0.plugin) ? { ...line0, vault: vaultName(vault) } : line0;
  if (sink) return sink(vault, convId, line);
  try {
    const c = await import("./engine/convs");
    if (convId === MAIN_ID) await c.ensureMain(vault);
    const id = changeLineId(line.kind, line.plugin, line.version);
    const p = c.pictureOf(vault, convId);
    if (!p || p.items.some((x) => x.id === id)) return;
    await c.writeNotes(vault, convId, [
      { kind: "notice", text: line.text, level: line.level ?? "info", clientId: id, change: { plugin: line.plugin, version: line.version, ...(line.offer ? { offer: line.offer } : {}), ...(line.vault ? { vault: line.vault } : {}) } },
    ]);
  } catch (e) {
    logLine(`could not write "${line.text}" into ${convId}: ${(e as Error).message}`);
  }
}

export type GateOutcome = {
  plugin: string;
  version: string;
  /** The draft's own line (its @vc-change / header what), or "". */
  what: string;
  asked: boolean;
  /** The chat that asked. */
  conv: string | null;
  /** What the gate wrote: keep (applied), discard (dropped), stage (waits for Try), or null: the gate could not run. */
  decision: "keep" | "discard" | "stage" | null;
  reasons: string[];
};

/** A part whose copy in effect is the vault's own (an app plugin's or a vault plugin's records live in its vault's log;
 *  the laptop runs the ones of the vault it has open). The core, the box's settings and box plugins are one per box. */
export const perVaultPart = (plugin: string): boolean => (plugin.startsWith("app/") && plugin !== CORE_PART && plugin !== "app/settings-values") || plugin.startsWith(".vault-chat/plugins/");

/** Where a change in `vault` is not on Carl's screen: the laptop has another vault open. The words after its line, or "". */
export function elsewhereNote(vault: string, plugin: string): string {
  if (!perVaultPart(plugin)) return "";
  const open = laptopElsewhere(vault);
  return open ? ` (in the ${vaultName(vault)} vault; the laptop has ${vaultName(open)} open, so it shows after he switches to ${vaultName(vault)}: Show a file of it on the laptop, or PluginAct app/vaults open)` : "";
}

/** The chat lines of a gate's end. */
export async function gateOutcome(vault: string, o: GateOutcome): Promise<void> {
  const what = plainWhat(o.what, changeName(o.plugin));
  const where = elsewhereNote(vault, o.plugin);
  if (o.decision === null) {
    if (o.asked) await sayChange(vault, o.conv, { kind: "failed", plugin: o.plugin, version: o.version, text: notYetText(what, plainWhy(o.reasons)), level: "error" });
    else logLine(`${o.plugin} ${o.version}: the gate could not run (${o.reasons.join("; ").slice(0, 300)}); the draft waits`);
    return;
  }
  if (o.decision === "discard") {
    if (o.asked) await sayChange(vault, o.conv, { kind: "failed", plugin: o.plugin, version: o.version, text: failedText(what, plainWhy(o.reasons)), level: "error" });
    else logLine(`${o.plugin} ${o.version}: not applied, the gate failed it (${o.reasons.join("; ").slice(0, 300)})`);
    return;
  }
  if (o.decision === "keep") {
    if (o.asked) await sayChange(vault, o.conv, { kind: "done", plugin: o.plugin, version: o.version, text: doneText(what + where), offer: "undo" });
    else logLine(`${o.plugin} ${o.version}: applied silently (${what}); nothing on screen changes`);
    return;
  }
  await sayChange(vault, null, { kind: "offer", plugin: o.plugin, version: o.version, text: offerText(what + where), offer: "try" });
}

/** "<what> — Try it?" in Main for a change waiting for Carl (once). */
export async function offerChange(vault: string, c: { plugin: string; version: string; what: string; name?: string }): Promise<void> {
  await sayChange(vault, null, { kind: "offer", plugin: c.plugin, version: c.version, text: offerText(plainWhat(c.what, c.name ?? changeName(c.plugin))), offer: "try" });
}

/** The words of the change a record undid: the keep's (or staged) what, else the plugin's name. */
export function whatOf(changes: readonly ChangeRecord[], version: string, plugin: string, staged?: readonly { version: string; what: string | null }[]): string {
  const k = [...changes].reverse().find((c) => c.version === version && c.what);
  const s = staged?.slice().reverse().find((x) => x.version === version && x.what);
  return plainWhat(k?.what ?? s?.what ?? "", changeName(plugin));
}

/** A change undone by itself (a switch or discard by "auto"): the chat that asked for it (else Main) says so. */
export async function autoUndone(vault: string, rec: { plugin: string; version: string; reason?: string | null; conv?: string | null }, changes: readonly ChangeRecord[], staged?: readonly { version: string; what: string | null; conv?: string | null }[]): Promise<void> {
  const conv = rec.conv ?? [...changes].reverse().find((c) => c.version === rec.version && c.conv)?.conv ?? staged?.find((s) => s.version === rec.version)?.conv ?? null;
  await sayChange(vault, conv, { kind: "auto", plugin: rec.plugin, version: rec.version, text: autoUndoText(whatOf(changes, rec.version, rec.plugin, staged), plainWhy(rec.reason ?? "")), level: "error" });
}

export type UndoDeps = {
  /** Every plugin with change records in the vault (and the core's, from its own vault). */
  plugins: () => string[];
  changes: (plugin: string) => readonly ChangeRecord[];
  /** Write the word (the supervisor's setPluginChange). */
  write: (b: Record<string, unknown>, by: string) => { ok: boolean; text: string };
  now?: () => number;
};

/** How long after it applied a change can still be undone by the native Undo. */
export const UNDO_WINDOW_MS = 24 * 3600_000;

/**
 * The native shell's Undo: every change this laptop tries is discarded; else the newest applied change (a keep within
 * UNDO_WINDOW_MS that is still in effect) switches back. `by`: "carl" (the shortcut, the tray) or "auto" (the
 * dead-man's switch). Returns what happened, in Carl's words.
 */
export function undoLast(d: UndoDeps, o: { by: "carl" | "auto"; reason: string; tried?: { plugin: string; version: string }[] }): { ok: boolean; text: string; undone: { plugin: string; version: string; what: string; conv: string | null }[] } {
  const undone: { plugin: string; version: string; what: string; conv: string | null }[] = [];
  for (const t of o.tried ?? []) {
    if (typeof t?.plugin !== "string" || typeof t?.version !== "string") continue;
    const w = d.write({ plugin: t.plugin, change: "discard", version: t.version, reason: o.reason }, o.by);
    if (w.ok) undone.push({ plugin: t.plugin, version: t.version, what: whatOf(d.changes(t.plugin), t.version, t.plugin), conv: null });
  }
  if (!undone.length) {
    const now = (d.now ?? Date.now)();
    let best: ChangeRecord | null = null;
    for (const plugin of d.plugins()) {
      const l = landing(d.changes(plugin));
      if (!l || l.change !== "keep" || (l.from ?? BUILT_IN) === l.version || now - l.at > UNDO_WINDOW_MS) continue;
      if (!best || l.at > best.at) best = { ...l, plugin };
    }
    if (best) {
      const w = d.write({ plugin: best.plugin, change: "switch", reason: o.reason }, o.by);
      if (w.ok) undone.push({ plugin: best.plugin, version: best.version, what: whatOf(d.changes(best.plugin), best.version, best.plugin), conv: best.conv ?? null });
      else return { ok: false, text: `Couldn't undo ${whatOf(d.changes(best.plugin), best.version, best.plugin)}: ${w.text}`, undone };
    }
  }
  if (!undone.length) return { ok: true, text: "Nothing to undo: no change applied in the last day.", undone };
  return { ok: true, text: `Undid ${undone.map((u) => u.what).join(", ")}.`, undone };
}

/** The chat line for a native Undo Carl pressed (the dead-man's switch's lines come from autoUndone). */
export async function sayUndone(vault: string, u: { plugin: string; version: string; what: string; conv: string | null }): Promise<void> {
  await sayChange(vault, u.conv, { kind: "auto", plugin: u.plugin, version: u.version, text: `Undid ${u.what} (${UNDO_CHORD}).` });
}
