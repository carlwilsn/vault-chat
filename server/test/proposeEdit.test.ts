import { describe, expect, it } from "vitest";
import { copiesOutside, resolveProposal, rewordedCopy } from "../engine/proposeEdit";
import { proposalRange } from "../../src/plugins/ask/view";

// Psych 221/vite.config.ts as Carl had it open (9 lines), asked "add some comments".
const VITE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
`;
const doc = { text: VITE, from: 0, to: 0 };
const apply = (t: string, p: { from?: number; to?: number; newText: string }) => t.slice(0, p.from) + p.newText + t.slice(p.to);

const COMMENTED = `// Vite configuration for this project.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build and dev-server settings.
export default defineConfig({
  // React support (JSX transform, fast refresh).
  plugins: [react()],
  server: {
    // The dev server's port.
    port: 5173,
  },
});
`;

describe("ProposeEdit resolves against the open file", () => {
  it("refuses an insert that carries a commented copy of the whole file (the file would be duplicated)", () => {
    const r = resolveProposal(doc, { action: "insert", afterLine: 0, newText: COMMENTED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repeats \d+ line/);
    // The same copy inserted at the cursor, or below the file, is refused too.
    expect(resolveProposal(doc, { action: "insert", newText: COMMENTED }).ok).toBe(false);
    expect(resolveProposal(doc, { action: "insert", afterLine: 9, newText: COMMENTED }).ok).toBe(false);
  });

  it("accepts a replace of the lines with the commented version, and it applies cleanly", () => {
    const r = resolveProposal(doc, { action: "replace", startLine: 1, endLine: 9, newText: COMMENTED, note: "comments" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal).toMatchObject({ kind: "replace", from: 0, to: VITE.length, removed: VITE, note: "comments" });
    const out = apply(VITE, r.proposal);
    expect(out).toBe(COMMENTED);
    expect(out.split("\n").filter((l) => l === 'import { defineConfig } from "vite";')).toHaveLength(1);
  });

  it("accepts an insert of only the new comment lines", () => {
    const r = resolveProposal(doc, { action: "insert", beforeLine: 4, newText: "// Build and dev-server settings." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(apply(VITE, r.proposal)).toBe(VITE.replace("export default", "// Build and dev-server settings.\nexport default"));
    const top = resolveProposal(doc, { action: "insert", afterLine: 0, newText: "// Vite configuration." });
    expect(top.ok && apply(VITE, top.proposal)).toBe("// Vite configuration.\n" + VITE);
  });

  it("replaces by exact text, deletes lines, and says why when it cannot", () => {
    const byText = resolveProposal(doc, { action: "replace", oldText: "port: 5173", newText: "port: 3000" });
    expect(byText.ok && apply(VITE, byText.proposal)).toBe(VITE.replace("5173", "3000"));
    const del = resolveProposal(doc, { action: "delete", startLine: 6, endLine: 8 });
    expect(del.ok && apply(VITE, del.proposal)).toBe(VITE.replace(/  server: \{\n    port: 5173,\n  \},\n/, ""));
    expect(del.ok && del.proposal).toMatchObject({ kind: "delete", newText: "" });
    expect(resolveProposal(doc, { action: "replace", oldText: "nope", newText: "x" })).toMatchObject({ ok: false });
    expect(resolveProposal(doc, { action: "replace", oldText: "import", newText: "x" })).toMatchObject({ ok: false });
    expect(resolveProposal(doc, { action: "replace", startLine: 3, endLine: 40, newText: "x" })).toMatchObject({ ok: false });
    expect(resolveProposal(doc, { action: "replace", startLine: 1, endLine: 1, newText: 'import { defineConfig } from "vite";' })).toMatchObject({ ok: false });
  });

  it("without a line range, replace and delete act on the selection and insert at the cursor", () => {
    const from = VITE.indexOf("5173");
    const sel = { text: VITE, from, to: from + 4 };
    const r = resolveProposal(sel, { action: "replace", newText: "3000" });
    expect(r.ok && apply(VITE, r.proposal)).toBe(VITE.replace("5173", "3000"));
    const ins = resolveProposal({ text: VITE, from: 0, to: 0 }, { action: "insert", newText: "// top\n" });
    expect(ins.ok && apply(VITE, ins.proposal)).toBe("// top\n" + VITE);
    expect(resolveProposal(doc, { action: "delete" })).toMatchObject({ ok: false });
  });

  // A to-do note with the same items written twice in different words, asked "organize this file" with nothing
  // selected (11-25: the organized version came back as an insert at the cursor, beside the old text).
  const MESSY = `Thursday: holiday
Sunday: evening flight home

## This week
- Lab work - regression stats and plots

- seminar presentation + assignments

- Email advisor about the program

# Work
- Email from Sam to do the grading thing
- Emailing the advisor
- Lab's work
- Seminar Presentation

- Can you fit the new class and is it worth it?
- Algorithms Final exam is what date?
- Databases Final Exam is what date?

During Break:
Lab work
seminar 2 interviews
seminar final presentation
Databases Homework 8
Algorithms - Just a final exam - what date?
`;
  const ORGANIZED = `## This week
- Lab work: regression stats and plots
- Seminar: presentation and assignments
- Email the advisor about the program
- Email Sam to do the grading thing

## Final exam dates
- Algorithms: final exam, what date?
- Databases: final exam, what date?

## During break
- Lab work
- Seminar: final presentation, 2 interviews left
- Databases: Homework 8

## Open questions
- Can you fit the new class, and is it worth it?
`;

  it("refuses an insert of a reworded, organized copy of the file, and accepts it as a replace of the whole file", () => {
    const messy = { text: MESSY, from: MESSY.length, to: MESSY.length };
    expect(rewordedCopy(MESSY, ORGANIZED)).toBe(true);
    const r = resolveProposal(messy, { action: "insert", newText: ORGANIZED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/replace .*startLine 1, endLine 26/);
    const whole = resolveProposal(messy, { action: "replace", startLine: 1, endLine: 26, newText: ORGANIZED });
    expect(whole.ok && apply(MESSY, whole.proposal)).toBe(ORGANIZED);
  });

  it("still accepts inserts of genuinely new text into that file: a short summary, a new item", () => {
    const messy = { text: MESSY, from: 0, to: 0 };
    expect(resolveProposal(messy, { action: "insert", afterLine: 0, newText: "TL;DR: finish lab and seminar work, email the advisor, find the final exam dates.\n" }).ok).toBe(true);
    expect(resolveProposal(messy, { action: "insert", afterLine: 9, newText: "- Book a dentist appointment\n- Renew the library loan\n" }).ok).toBe(true);
    expect(rewordedCopy(MESSY, "## Plan\n- Lab work first thing Monday, then the seminar slides.\n- Ask the advisor about funding for the summer.\n")).toBe(false);
  });

  // A made-up break plan with a pasted picture at the top and "the items above" pointers. One pointer line selected,
  // asked "remove the image and put the real items here" (11-25: the rewrite of the top 23 lines replaced only the
  // selected line, so the file held its top half twice and kept the image).
  const PLAN = `# Break plan

![](assets/pasted-shot.png)

All of the studio project has to be done over break.

## Break: today to Monday
Deadline for this block: **Monday**.

**Wed (today)**
- [ ] Stats homework due today
- [ ] Email the lab manager
- [ ] Ask Jo about the tutoring shift
- [ ] Email the professor about attendance

**Thu:** holiday
- [ ] Studio: final presentation and the items above

**Fri**
- [ ] Studio: final presentation and the items above
- [ ] Stats: homework 8
`;
  const POINTER = PLAN.split("\n").lastIndexOf("- [ ] Studio: final presentation and the items above") + 1; // line 19
  const lineAt = (n: number) => {
    let from = 0;
    for (let i = 1; i < n; i++) from = PLAN.indexOf("\n", from) + 1;
    return { from, to: PLAN.indexOf("\n", from) + 1 };
  };
  const ITEMS = `- [ ] Studio team assignment: final presentation (Mon noon)
- [ ] Studio reflection paper (Wed noon)
- [ ] Studio peer review (Wed noon)
`;
  // The model's newText: the top of the file rewritten (image gone, the pointer replaced by the real items).
  const TOP = `# Break plan

All of the studio project has to be done over break, so only the presentation is left after.

## Break: today to Monday
Deadline for this block: **Monday**.

**Wed (today)**
- [ ] Stats homework due today
- [ ] Email the lab manager
- [ ] Ask Jo about the tutoring shift
- [ ] Email the professor about attendance

**Thu:** holiday
${ITEMS}
**Fri**
`;

  it("refuses a replace of one selected line whose newText rewrites the lines above it, and says to widen the range", () => {
    const sel = { text: PLAN, ...lineAt(POINTER) };
    for (const args of [{ action: "replace", newText: TOP }, { action: "replace", startLine: POINTER, endLine: POINTER, newText: TOP }]) {
      const r = resolveProposal(sel, args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/outside that range.*widen startLine\/endLine/s);
    }
    // Reworded rather than copied line for line: refused too.
    const reworded = TOP.replace(/- \[ \] /g, "* ").replace("Email the lab manager", "Write to the lab manager").replace("today to Monday", "now until Monday");
    expect(copiesOutside(PLAN, sel.from, sel.to, reworded)).not.toBeNull();
    expect(resolveProposal(sel, { action: "replace", newText: reworded }).ok).toBe(false);
  });

  it("accepts the same rewrite as a range spanning the lines it rewrites, and it applies cleanly", () => {
    const r = resolveProposal({ text: PLAN, ...lineAt(POINTER) }, { action: "replace", startLine: 1, endLine: POINTER, newText: TOP });
    expect(r.ok).toBe(true);
    const out = r.ok ? apply(PLAN, r.proposal) : "";
    expect(out).not.toContain("pasted-shot.png");
    expect(out.split("\n").filter((l) => l === "- [ ] Email the lab manager")).toHaveLength(1);
    expect(out.endsWith("**Fri**\n- [ ] Stats: homework 8\n")).toBe(true);
  });

  it("no false alarms on ordinary replaces: new items for a pointer, rewording, commenting, reordering, a whole-file rewrite", () => {
    const sel = { text: PLAN, ...lineAt(POINTER) };
    expect(resolveProposal(sel, { action: "replace", newText: ITEMS }).ok).toBe(true);
    expect(resolveProposal(sel, { action: "replace", startLine: 5, endLine: 5, newText: "The whole studio project gets finished over break.\n" }).ok).toBe(true);
    // Reorder the Wed items (they repeat their own range only).
    expect(resolveProposal(sel, { action: "replace", startLine: 11, endLine: 14, newText: "- [ ] Email the professor about attendance\n- [ ] Email the lab manager\n- [ ] Ask Jo about the tutoring shift\n- [ ] Stats homework due today\n" }).ok).toBe(true);
    // Remove the image and the pointer lines by replacing the whole file.
    expect(resolveProposal(sel, { action: "replace", startLine: 1, endLine: 21, newText: TOP + "- [ ] Stats: homework 8\n" }).ok).toBe(true);
    // Code: comment one block of the Vite config.
    expect(resolveProposal(doc, { action: "replace", startLine: 4, endLine: 9, newText: COMMENTED.split("\n").slice(4).join("\n") }).ok).toBe(true);
    // Organize one section of the messy note, leaving the others.
    const messy = { text: MESSY, from: 0, to: 0 };
    expect(resolveProposal(messy, { action: "replace", startLine: 20, endLine: 26, newText: "## During break\n- Lab work\n- Seminar: final presentation, 2 interviews left\n- Databases: Homework 8\n- Algorithms: final exam, what date?\n" }).ok).toBe(true);
  });

  it("with no file from the editor, a call that names lines or text elsewhere is refused instead of landing on the selection", () => {
    expect(resolveProposal(null, { action: "replace", startLine: 1, endLine: 24, newText: TOP })).toMatchObject({ ok: false });
    expect(resolveProposal(null, { action: "replace", oldText: "x", newText: "y" })).toMatchObject({ ok: false });
    expect(resolveProposal(null, { action: "replace", newText: ITEMS })).toMatchObject({ ok: true, proposal: { newText: ITEMS, kind: "replace" } });
  });

  it("an accept lands on the resolved range (found again by its text if the file moved), the selection only without one", () => {
    const sel = lineAt(POINTER);
    const r = resolveProposal({ text: PLAN, ...sel }, { action: "replace", startLine: 1, endLine: POINTER, newText: TOP });
    if (!r.ok) throw new Error(r.error);
    expect(proposalRange(PLAN, r.proposal, sel)).toEqual({ from: 0, to: sel.to });
    expect(proposalRange("typed above\n" + PLAN, r.proposal, sel)).toEqual({ from: 12, to: sel.to + 12 });
    expect(proposalRange("gone", r.proposal, sel)).toBeNull();
    expect(proposalRange(PLAN, { newText: ITEMS }, sel)).toEqual(sel);
  });
});
