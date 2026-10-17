// A small, valid PDF for the tests and the preview seed: US Letter pages, each
// a content stream of PDF operators (Helvetica text, lines), real xref table.
export function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) - 1 + 1; // 1-based object numbers
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids: number[] = [];
  for (const content of pages) {
    const c = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A page's content: a title and lines of body text. */
export function textPage(title: string, lines: string[]): string {
  const esc = (s: string) => s.replace(/[\()]/g, (c) => "\\" + c);
  let s = `BT /F2 22 Tf 72 720 Td (${esc(title)}) Tj ET\n0.6 w 72 706 m 540 706 l S\n`;
  lines.forEach((l, i) => (s += `BT /F1 13 Tf 72 ${676 - i * 22} Td (${esc(l)}) Tj ET\n`));
  return s;
}
