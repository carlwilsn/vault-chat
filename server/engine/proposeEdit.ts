// ProposeEdit: the one tool that turns Ctrl+K / Ctrl+L into an edit. The agent says WHAT kind of edit (replace, insert
// or delete) and WHERE (line numbers or exact text); nothing is written. The box resolves it against the open file into
// a concrete range (resolveProposal) and refuses what cannot be right (an insertion that repeats lines the file already
// has, a text that is not there) with an error the agent can act on. The proposal reaches the popover
// (SideState.proposals, handled in claude/side.ts), where Carl accepts or rejects it; git is the undo.
import type { EditProposal, ToolSpec } from "./backend";

export const PROPOSE_EDIT = "ProposeEdit";

export const proposeEditSpec: ToolSpec = {
  type: "function",
  name: PROPOSE_EDIT,
  description:
    "Propose ONE edit to the file Carl has open. Nothing is written; he sees the removed lines struck and the added lines in green, and accepts or rejects. " +
    "Pick the action that matches the change: " +
    "replace = existing text becomes newText (rewording, adding comments to existing code, fixing, reformatting: the result REPLACES the old lines, so newText is the new version of just that range, not an addition next to it); " +
    "insert = newText is NEW text that is not in the file yet, added at one spot (before/after a line, or at the cursor); it must carry only the new lines, never a copy of lines already in the file; " +
    "delete = existing text is removed. " +
    "Where: line numbers (startLine/endLine, 1-based, inclusive; afterLine/beforeLine for an insert, afterLine 0 = top of the file) as numbered in FILE, or oldText (exact text of the file, which must occur once). With neither: replace and delete act on his SELECTION, insert at his CURSOR. Organizing, cleaning up or rewriting the file is a replace of its lines (all of them for the whole file), never an insert of a new version. " +
    "His selection is where he points, not a limit: when the ask reaches other lines (remove an image elsewhere, merge what is above), the edit covers those lines too (a range spanning them; startLine/endLine may lie outside the selection). To change several places, replace one range that spans them. A later call replaces an earlier proposal. If the tool returns an error, fix the call and call it again. newText has no code fences and no commentary, and is in the file's own style. Afterwards say in a line what you proposed. " +
    "Use it when Carl asks for a change to the file; answer in words when he only asks a question.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["replace", "insert", "delete"], description: "replace existing text, insert new text, or delete existing text." },
      newText: { type: "string", description: "replace: the new text for the range. insert: the new lines only. delete: omit." },
      startLine: { type: "integer", description: "replace/delete: first line of the range (1-based)." },
      endLine: { type: "integer", description: "replace/delete: last line of the range (inclusive); default startLine." },
      oldText: { type: "string", description: "replace/delete: the exact existing text to act on (must occur exactly once); alternative to line numbers." },
      afterLine: { type: "integer", description: "insert: put newText after this line (0 = at the very top)." },
      beforeLine: { type: "integer", description: "insert: put newText before this line." },
      note: { type: "string", description: "Optional: one short line saying what changed." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

/** The open file as the popover saw it: its text and the selection (from === to: the cursor), as character offsets. */
export type EditDoc = { text: string; from: number; to: number };

export type Resolved = { ok: true; proposal: EditProposal } | { ok: false; error: string };

const fail = (error: string): Resolved => ({ ok: false, error });

/** Offset where line n (1-based) starts, and where it ends including its newline. */
function lineBounds(text: string, startLine: number, endLine: number): { from: number; to: number } {
  let from = 0;
  for (let i = 1; i < startLine; i++) from = text.indexOf("\n", from) + 1;
  let to = from;
  for (let i = startLine; i <= endLine; i++) {
    const nl = text.indexOf("\n", to);
    to = nl < 0 ? text.length : nl + 1;
  }
  return { from, to };
}

const lineCount = (t: string): number => (t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0));
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** Lines worth comparing: not blank, not a lone brace or `end`. */
const substantive = (l: string): boolean => l.trim().length >= 4;

/** The lines of `newText` that the file already has (trimmed, whole-line match). */
export function repeatedLines(doc: string, newText: string): string[] {
  const have = new Set(doc.split("\n").map((l) => l.trim()));
  return newText.split("\n").filter((l) => substantive(l) && have.has(l.trim()));
}

/** Distinct words (4+ letters or digits, lowercased). */
const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);

/**
 * Whether `newText` is a reworded copy of the file (an "organized" version of it): nearly all its words are the
 * file's, it carries most of the file's words, and it is at least half the file's size. A summary is much shorter
 * and carries few of the file's words; a new item or function carries few too. Carl's "organize this file" became
 * an insert of the clean version beside the old one (11-25: 93% of its words were the file's, 80% of the file's words were in it).
 */
export function rewordedCopy(doc: string, newText: string): boolean {
  const have = words(doc);
  const add = words(newText);
  if (have.size < 12 || add.size < 8) return false;
  const size = (t: string) => t.split("\n").filter(substantive).length;
  if (size(newText) * 2 < size(doc)) return false;
  let shared = 0;
  for (const w of add) if (have.has(w)) shared++;
  return shared >= 0.85 * add.size && shared >= 0.6 * have.size;
}

/**
 * Whether a replace's `newText` is largely a copy of the file OUTSIDE the range it replaces (said as what it repeats),
 * or null. Lines the replaced range itself has do not count: rewording, commenting or reformatting those lines repeats
 * them by design. Two ways it shows: lines repeated as they are (at least 3, and half of newText's lines), or a reworded
 * copy of the outside text (most of the outside's own words, the replaced range's left out, and not much shorter).
 * 11-25: one selected line was replaced with a rewrite of the 23 lines above it, so the file held both.
 */
export function copiesOutside(t: string, from: number, to: number, newText: string): string | null {
  const outside = t.slice(0, from) + t.slice(to);
  if (!outside.trim()) return null;
  const inRange = new Set(t.slice(from, to).split("\n").map((l) => l.trim()));
  const outLines = new Set(outside.split("\n").map((l) => l.trim()));
  const subst = newText.split("\n").filter(substantive);
  const dup = subst.filter((l) => outLines.has(l.trim()) && !inRange.has(l.trim()));
  if (dup.length >= 3 && dup.length * 2 >= subst.length) return `${dup.length} lines as they are, for example ${JSON.stringify(dup[0]!.trim())}`;
  // Reworded: newText carries most of the outside's own words (those the range does not have) and is not much
  // shorter than it. New words in newText do not matter here (a rewrite that also adds the asked-for items is one).
  const own = words(t.slice(from, to));
  const have = [...words(outside)].filter((w) => !own.has(w));
  if (have.length < 12) return null;
  const size = (x: string) => x.split("\n").filter(substantive).length;
  if (size(newText) * 2 < size(outside)) return null;
  const add = words(newText);
  const shared = have.filter((w) => add.has(w)).length;
  return shared >= 0.6 * have.length ? `a reworded copy of it: ${shared} of its ${have.length} words` : null;
}

/** Turn the agent's call into one concrete range of the open file, or the reason it cannot. */
export function resolveProposal(doc: EditDoc | null, args: unknown): Resolved {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = a.action === undefined ? "replace" : a.action;
  if (action !== "replace" && action !== "insert" && action !== "delete") return fail('action must be "replace", "insert" or "delete".');
  const newText = typeof a.newText === "string" ? a.newText : null;
  const note = typeof a.note === "string" && a.note.trim() ? { note: a.note.trim().slice(0, 300) } : {};
  if (action !== "delete" && newText === null) return fail(`${action} needs newText (a string).`);
  // A client that sends no file: the selection (or cursor) is the only place there is. Lines or text elsewhere cannot
  // be placed, and must not land on the selection instead (11-25: a rewrite of lines 1-24 replaced the one selected line).
  if (!doc) {
    if (["startLine", "endLine", "afterLine", "beforeLine", "oldText"].some((k) => a[k] !== undefined && a[k] !== null && a[k] !== "")) {
      return fail("This editor sent no file, so lines or text elsewhere cannot be placed: leave out startLine/endLine/afterLine/beforeLine/oldText; replace and delete then act on his selection, insert at his cursor.");
    }
    return { ok: true, proposal: { newText: newText ?? "", kind: action, ...note } };
  }

  const t = doc.text;
  const n = lineCount(t);
  const startLine = int(a.startLine);
  const endLine = int(a.endLine) ?? startLine;
  const oldText = typeof a.oldText === "string" && a.oldText !== "" ? a.oldText : null;

  // The range the action applies to (replace, delete), or the point (insert).
  let from: number;
  let to: number;
  let wholeLines = false;
  if (action === "insert") {
    const after = int(a.afterLine);
    const before = int(a.beforeLine);
    if (after !== null && before !== null) return fail("insert takes afterLine or beforeLine, not both.");
    if (after !== null) {
      if (after < 0 || after > n) return fail(`afterLine ${after} is outside the file (0 to ${n}).`);
      from = to = after === 0 ? 0 : lineBounds(t, after, after).to;
      wholeLines = true;
    } else if (before !== null) {
      if (before < 1 || before > n + 1) return fail(`beforeLine ${before} is outside the file (1 to ${n + 1}).`);
      from = to = before > n ? t.length : lineBounds(t, before, before).from;
      wholeLines = true;
    } else {
      from = to = doc.to;
    }
    const dup = repeatedLines(t, newText!);
    const subst = newText!.split("\n").filter(substantive).length;
    if (dup.length >= 2 && dup.length * 2 >= subst) {
      return fail(
        `This insert repeats ${dup.length} line(s) the file already has (for example ${JSON.stringify(dup[0]!.trim())}). An insert must carry only NEW lines. ` +
          "To change existing lines (add comments, reword, fix), call replace over their startLine/endLine with the new version; to add only new lines, insert just those at the right spot.",
      );
    }
    if (rewordedCopy(t, newText!)) {
      return fail(
        "This insert is a new version of the file's own content, so the file would hold the old text and the new copy. " +
          "To organize, clean up or rewrite existing text, call replace over the lines it covers (startLine 1, endLine " + n + " for the whole file).",
      );
    }
  } else if (oldText !== null) {
    const i = t.indexOf(oldText);
    if (i < 0) return fail("oldText is not in the file; copy it exactly, or use startLine/endLine.");
    if (t.indexOf(oldText, i + 1) >= 0) return fail("oldText occurs more than once; use startLine/endLine, or more of the surrounding text.");
    from = i;
    to = i + oldText.length;
  } else if (startLine !== null) {
    if (endLine === null || startLine < 1 || endLine < startLine || endLine > n) return fail(`The line range ${startLine}-${endLine} is outside the file (1 to ${n}).`);
    ({ from, to } = lineBounds(t, startLine, endLine));
    wholeLines = true;
  } else {
    if (doc.from === doc.to) return fail(`${action} needs startLine/endLine or oldText when nothing is selected.`);
    from = doc.from;
    to = doc.to;
  }

  if (action === "replace") {
    const copied = copiesOutside(t, from, to, newText!);
    if (copied) {
      const [a1, b1] = [t.slice(0, from).split("\n").length, t.slice(0, Math.max(from, to - 1)).split("\n").length];
      return fail(
        `This replace covers lines ${a1}-${b1}, but newText repeats text from outside that range (${copied}), so the file would hold the old lines and the new copy. ` +
          "A selection is where Carl points, not a limit: widen startLine/endLine to cover every line the new text rewrites (the whole file: startLine 1, endLine " + n + "), or make separate edits; otherwise leave the outside text out of newText.",
      );
    }
  }

  let out = action === "delete" ? "" : newText!;
  if (wholeLines && out !== "") {
    // Whole lines stay whole lines: a newline where the neighbours need one.
    if (!out.endsWith("\n") && (t.slice(from, to).endsWith("\n") || action === "insert")) out += "\n";
    if (action === "insert" && from === t.length && from > 0 && !t.endsWith("\n")) out = "\n" + out.replace(/\n$/, "");
  }
  const removed = t.slice(from, to);
  if (action !== "insert" && removed === "") return fail("Nothing to " + action + " there.");
  if (removed === out) return fail("That proposal changes nothing.");
  return { ok: true, proposal: { newText: out, kind: action, from, to, removed, ...note } };
}
