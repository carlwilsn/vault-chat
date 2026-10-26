import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookup, terms } from "../engine/lookup";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vc-lookup-"));
  mkdirSync(join(v, "Real 320-1"), { recursive: true });
  mkdirSync(join(v, "node_modules", "x"), { recursive: true });
  const filler = Array.from({ length: 120 }, (_, i) => `filler line ${i}`).join("\n");
  writeFileSync(
    join(v, "Real 320-1", "Chapter 1 - Proof Workbook.md"),
    `# Chapter 1 — Proof Workbook\n\n## Progress\n- [x] 1.1 Uniqueness of 0 *(needs a fix)*\n- [ ] 1.3 a · 0 = 0\n\n${filler}\n\n### Theorem 1.1 (Uniqueness of 0)\nIf 0' is another element with a + 0' = a for all a, then 0' = 0.\n\n### Theorem 1.2 (Cancellation)\nFor all a, b, c: if a + c = b + c, then a = b.\n\n**Your proof:** Suppose a + c = b + c.\n`,
  );
  writeFileSync(join(v, "Real 320-1", "Sequences - Problem Set Proof Workbook.md"), `# Sequences — Problem Set Proof Workbook\n\n## Problem 1 — True or false?\n### 1(a) Absolute values\nIf x_n → x then |x_n| → |x|.\n`);
  writeFileSync(join(v, "node_modules", "x", "README.md"), "Theorem 1.2 proof workbook in a dependency\n");
  return v;
}

describe("Lookup: find and read in one call", () => {
  it("his words become terms: spelled numbers as digits, filler dropped", () => {
    expect(terms("Read me theorem one point two from the proof workbook")).toEqual(["theorem", "1.2", "proof", "workbook"]);
    expect(terms("What does axiom two say, exactly?")).toEqual(["axiom", "2"]);
  });

  it("the theorem asked for, from the right workbook, with its lines — one result to answer from", () => {
    const r = lookup(vault(), { query: "theorem one point two from the proof workbook" }, 1);
    // The right file first, and the passage with the statement in it.
    expect(r.startsWith("--- Real 320-1/Chapter 1 - Proof Workbook.md")).toBe(true);
    const chapter = r.split("--- Real 320-1/Sequences")[0]!;
    expect(chapter).toContain("### Theorem 1.2 (Cancellation)");
    expect(chapter).toContain("if a + c = b + c, then a = b");
    expect(r).not.toContain("node_modules");
  });

  it("a number matches whole (1.2 is not 1.21 or 11.2), and a file hint narrows the search", () => {
    const v = vault();
    writeFileSync(join(v, "Real 320-1", "Other.md"), "Theorem 11.2 and 1.21 are elsewhere\n");
    const r = lookup(v, { query: "theorem 1.2", file: "workbook" }, 2);
    expect(r).not.toContain("Other.md");
    expect(r).toContain("Theorem 1.2 (Cancellation)");
  });

  it("nothing matching says so; no words says what it needs", () => {
    expect(lookup(vault(), { query: "zebra quaternion" }, 3)).toMatch(/Nothing in the vault matches/);
    expect(lookup(vault(), { query: "the of" }, 4)).toMatch(/needs a few words/);
  });
});

/** A small real PDF, one line of text per page (Helvetica), with a correct xref. */
function tinyPdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${t.replace(/[()\\]/g, "")}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("Lookup reads his PDFs too (roleplay: 'I can't find a lecture on Bellman-Ford' with lecture6_typed.pdf in the folder)", () => {
  it("finds the lecture PDF by what it says, with the page", async () => {
    const { lookupAll } = await import("../engine/lookup");
    const v = vault();
    mkdirSync(join(v, "CS 336", "Lectures", "Lecture 06"), { recursive: true });
    writeFileSync(join(v, "CS 336", "Lectures", "Lecture 06", "lecture6_typed.pdf"), tinyPdf(["Dijkstra with a heap", "Bellman-Ford relaxes every edge n - 1 times"]));
    writeFileSync(join(v, "CS 336", "Day 1.md"), "# Day 1\nStable matching.\n");
    const r = await lookupAll(v, { query: "Bellman-Ford lecture" }, 2);
    expect(r.startsWith("--- CS 336/Lectures/Lecture 06/lecture6_typed.pdf")).toBe(true);
    expect(r).toContain("(page 2)");
    expect(r).toContain("relaxes every edge");
    // Text notes are searched as before.
    expect(await lookupAll(v, { query: "theorem one point two" }, 3)).toContain("Theorem 1.2 (Cancellation)");
  });
});
