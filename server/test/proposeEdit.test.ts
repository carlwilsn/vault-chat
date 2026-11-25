import { describe, expect, it } from "vitest";
import { resolveProposal, rewordedCopy } from "../engine/proposeEdit";

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
});
