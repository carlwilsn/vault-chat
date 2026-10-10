// Generates papers/attention-survey.pdf: a 320-page, text-dense invented
// "survey" — big enough that the PdfExtract tool's whole-document read blows
// past the 200k context window, which is what the PDF scenario shows.
//   node preview/fixtures/synthetic/make-big-pdf.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "vault", "papers", "attention-survey.pdf");
const PAGES = 320;
const LINES = 52;

// Deterministic PRNG so the fixture is byte-stable.
let s = 1234567;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SUBJ = ["Sparse attention", "Linear attention", "The softmax bottleneck", "Rotary position encoding", "Multi-query attention", "Grouped-query attention", "Sliding-window attention", "The KV cache", "Flash attention", "State-space layers", "Mixture-of-experts routing", "Long-context retrieval"];
const VERB = ["reduces", "trades off", "reshapes", "bounds", "approximates", "dominates", "amortizes", "stabilizes"];
const OBJ = ["memory traffic per token", "the quadratic cost in sequence length", "recall on needle-in-a-haystack probes", "training throughput at 8k context", "perplexity on held-out code", "the effective rank of the attention map", "latency at batch size one", "the variance of gradient estimates"];
const TAIL = ["in most of the settings we surveyed.", "although the gains shrink beyond 32k tokens.", "but only when the head dimension is at least 64.", "as Table 4 summarizes.", "which matters most for on-device inference.", "a result that held across three model scales."];

const sentence = () => `${pick(SUBJ)} ${pick(VERB)} ${pick(OBJ)} ${pick(TAIL)}`;
const esc = (t) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text, width = 95) {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

const objects = [];
const add = (body) => (objects.push(body), objects.length);
const catalogId = add(null);
const pagesId = add(null);
const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
const pageIds = [];

for (let p = 1; p <= PAGES; p++) {
  const lines = [];
  if (p === 1) {
    lines.push(["B", "A Survey of Efficient Attention (preview fixture)"]);
    lines.push(["R", "Invented text for the vault-chat preview harness. 320 pages."]);
    lines.push(["R", ""]);
  }
  if (p % 12 === 1) lines.push(["B", `${Math.ceil(p / 12)}. ${pick(SUBJ)}`]);
  while (lines.length < LINES) {
    const para = Array.from({ length: 3 + Math.floor(rnd() * 3) }, sentence).join(" ");
    for (const l of wrap(para)) if (lines.length < LINES) lines.push(["R", l]);
    if (lines.length < LINES) lines.push(["R", ""]);
  }
  let stream = "BT\n/F1 9.5 Tf\n12 TL\n50 760 Td\n";
  for (const [kind, text] of lines) {
    stream += kind === "B" ? `/F2 12 Tf (${esc(text)}) Tj T* /F1 9.5 Tf\n` : `(${esc(text)}) Tj T*\n`;
  }
  stream += `ET\nBT /F1 8 Tf 290 30 Td (${p}) Tj ET\n`;
  const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
  pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
}
objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(pdf, "latin1"));
console.log(`${OUT}: ${PAGES} pages, ${(pdf.length / 1e6).toFixed(2)} MB`);
