// A built file (a PDF from its .md) follows its source: the roleplay's "make the second section shorter" changed the
// .md and left the PDF he reads untouched.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REBUILD_MARK, rebuildNote, sourcesChangedSince, staleBuilt } from "../engine/builtFiles";

describe("built files out of date", () => {
  it("a PDF older than its changed .md is stale; a fresh one, or one with no source, is not", () => {
    const v = mkdtempSync(join(tmpdir(), "vc-built-"));
    const dir = join(v, "CS 336", "Lectures", "Lecture 06");
    mkdirSync(dir, { recursive: true });
    const md = join(dir, "bellman-ford-study-sheet.md");
    const pdf = join(dir, "bellman-ford-study-sheet.pdf");
    writeFileSync(pdf, "%PDF old");
    writeFileSync(md, "## 3. Why n − 1 rounds suffice\nshort now\n");
    const t = Date.now() / 1000;
    utimesSync(pdf, t - 600, t - 600);
    utimesSync(md, t, t);
    writeFileSync(join(dir, "lecture6_typed.pdf"), "%PDF");
    const stale = staleBuilt(v, [md]);
    expect(stale).toEqual([{ source: "CS 336/Lectures/Lecture 06/bellman-ford-study-sheet.md", built: "CS 336/Lectures/Lecture 06/bellman-ford-study-sheet.pdf" }]);
    expect(rebuildNote(stale).startsWith(REBUILD_MARK)).toBe(true);
    // The worker's edits are found by time (its tools run in its own session).
    expect(sourcesChangedSince(v, (t - 60) * 1000)).toEqual([md]);
    // Rebuilt: not stale any more.
    utimesSync(pdf, t + 5, t + 5);
    expect(staleBuilt(v, [md])).toEqual([]);
  });
});
