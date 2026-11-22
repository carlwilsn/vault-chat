// The box's side of change by asking (src/pluginDrafts.ts): Carl's Keep / Discard / Switch back on a plugin's draft is
// one plugin.change record in the log, and the box moves the slot's files to match (the laptop and the phone get them by
// the vault's sync; a host trusts the record before they arrive). The script draft-check.ts goes
// through the same route (scripts/boxChange.ts), so every change is a record.
//
//   keep     prev := live (none: prev removed, the built-in one was in effect), live := draft, draft removed
//   discard  draft removed (only the version Carl saw: a newer draft written meanwhile stays)
//   switch   live and prev swap (a missing file is the built-in one): undo of the last keep, and of the undo; with a
//            version, only while that version is live (an auto-revert after Keep)
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN, boxPluginName, boxSlot, versionOf, vaultSlot, type ChangeKind, type DraftSlot } from "../src/pluginDrafts";
import { isVaultPluginFile, vaultPluginFile } from "../src/vaultPlugins";

/** The slot of a plugin id: a box plugin (box/<name>) or a vault plugin (its .js path). */
export function slotOf(plugin: string): DraftSlot | null {
  if (plugin.startsWith("box/")) {
    const name = boxPluginName(plugin);
    return name ? boxSlot(name) : null;
  }
  const file = vaultPluginFile(plugin);
  if (file && isVaultPluginFile(file)) {
    const m = /^(.*?)(\.m?js)$/i.exec(file);
    if (m) return vaultSlot(m[1]!, m[2]!);
  }
  return null;
}

const read = (f: string): string | undefined => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
};

/** The slot's code on disk. */
export function slotCode(vault: string, slot: DraftSlot): { draft?: string; live?: string; prev?: string } {
  const dir = join(vault, slot.dir);
  const out: { draft?: string; live?: string; prev?: string } = {};
  for (const k of ["draft", "live", "prev"] as const) {
    const c = read(join(dir, slot[k]));
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export type Landed = { ok: true; version: string; from?: string; text: string } | { ok: false; status: number; error: string };

/**
 * Move the slot's files for one change. `version`: the draft's version Carl decided on (keep / discard). Returns the
 * versions the record names, or why not (nothing moved).
 */
export function landChange(vault: string, slot: DraftSlot, change: ChangeKind, version: string): Landed {
  const dir = join(vault, slot.dir);
  const f = (k: "draft" | "live" | "prev") => join(dir, slot[k]);
  const err = (k: "draft" | "live" | "prev") => `${f(k)}.error.txt`;
  const code = slotCode(vault, slot);
  const lv = code.live !== undefined ? versionOf(code.live) : BUILT_IN;
  try {
    if (change === "keep") {
      if (code.draft === undefined) return { ok: false, status: 409, error: `${slot.plugin} has no draft (already kept or discarded?)` };
      if (versionOf(code.draft) !== version) return { ok: false, status: 409, error: `the draft of ${slot.plugin} changed since it was shown (now ${versionOf(code.draft)}); look again` };
      mkdirSync(dir, { recursive: true });
      if (code.live !== undefined) writeFileSync(f("prev"), code.live);
      else rmSync(f("prev"), { force: true });
      writeFileSync(f("live"), code.draft);
      rmSync(f("draft"), { force: true });
      rmSync(err("draft"), { force: true });
      rmSync(err("live"), { force: true });
      return { ok: true, version, from: lv, text: `kept: ${slot.dir}/${slot.live} is the draft ${version}; the copy it replaced (${lv}) is ${code.live !== undefined ? `${slot.dir}/${slot.prev}` : "the built-in one"}` };
    }
    if (change === "discard") {
      if (code.draft !== undefined && versionOf(code.draft) === version) {
        rmSync(f("draft"), { force: true });
        rmSync(err("draft"), { force: true });
      }
      return { ok: true, version, text: `discarded the draft ${version} of ${slot.plugin}` };
    }
    // switch: live and prev swap. With a version (an auto-revert names the kept copy it undoes): only while that copy
    // is the live one, so two windows reverting the same keep switch once, never back again.
    if (version && version !== lv) return { ok: false, status: 409, error: `${slot.plugin} is no longer at ${version} (now ${lv}): already switched` };
    const pv = code.prev !== undefined ? versionOf(code.prev) : BUILT_IN;
    if (pv === lv) return { ok: false, status: 409, error: `${slot.plugin} has nothing to switch back to` };
    mkdirSync(dir, { recursive: true });
    if (code.prev !== undefined) writeFileSync(f("live") + ".swap", code.prev);
    if (code.live !== undefined) writeFileSync(f("prev"), code.live);
    else rmSync(f("prev"), { force: true });
    if (code.prev !== undefined) renameSync(f("live") + ".swap", f("live"));
    else rmSync(f("live"), { force: true });
    rmSync(err("live"), { force: true });
    return { ok: true, version: pv, from: lv, text: `switched ${slot.plugin} back: ${pv === BUILT_IN ? "the built-in copy" : `version ${pv}`} runs (${lv} is kept as ${slot.dir}/${slot.prev})` };
  } catch (e) {
    return { ok: false, status: 500, error: `the files could not be moved: ${(e as Error).message}` };
  }
}
