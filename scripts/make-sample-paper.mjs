#!/usr/bin/env node
// Writes assets/first-run/sample-paper.pdf: the first-run tutorial's sample paper (src-tauri/src/first_run_tutorial.rs
// seeds it into a new vault as Welcome/sample-paper.pdf). Three pages, our own text, and a schematic redrawing of John
// Snow's 1854 cholera map drawn here as vector shapes (the original is public domain; nothing is copied from a
// modern source). Plain Node, no dependencies, deterministic output: run it again and the bytes are the same.
//
//   node scripts/make-sample-paper.mjs [out.pdf]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, "..", "assets", "first-run", "sample-paper.pdf"));

const W = 612;
const H = 792;
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n = (x) => (Math.round(x * 100) / 100).toString();

/** Lines of `text` that fit `width` points at `size` (Helvetica, an average glyph of 0.5 em). */
function wrap(text, size, width) {
  const max = Math.floor(width / (size * 0.5));
  const lines = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    if ((line + " " + w).trim().length > max) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

class Page {
  ops = [];
  y = H - 72;
  text(s, x, y, size = 11, font = "F1", gray = 0) {
    this.ops.push(`${n(gray)} g BT /${font} ${size} Tf ${n(x)} ${n(y)} Td (${esc(s)}) Tj ET`);
  }
  para(s, { size = 11, font = "F1", lead = 1.45, gap = 8, x = 72, width = W - 144 } = {}) {
    for (const l of wrap(s, size, width)) {
      this.text(l, x, this.y, size, font);
      this.y -= size * lead;
    }
    this.y -= gap;
  }
  heading(s, size = 15) {
    this.y -= 4;
    this.text(s, 72, this.y, size, "F2");
    this.y -= size * 1.6;
  }
  footer(i) {
    this.text(`The Broad Street Pump (London, 1854)  -  page ${i} of 3`, 72, 40, 8.5, "F1", 0.45);
  }
  stream() {
    return this.ops.join("\n");
  }
}

// ---------- page 1
const p1 = new Page();
p1.text("A short explainer", 72, p1.y, 10, "F3", 0.4);
p1.y -= 30;
p1.text("The Broad Street Pump", 72, p1.y, 26, "F2");
p1.y -= 30;
p1.text("London, 1854", 72, p1.y, 16, "F1", 0.3);
p1.y -= 40;
p1.heading("What happened");
p1.para(
  "At the end of August 1854, cholera broke out in Soho, a crowded district of central London. Within ten days more than " +
    "five hundred people who lived within a few streets of one another had died. Families fled; whole houses stood empty.",
);
p1.para(
  "Most doctors of the time believed that cholera spread through miasma, a poisonous 'bad air' rising from filth and " +
    "rotting matter. If that were true, the deaths should follow the smells: the drains, the cesspools, the tanneries.",
);
p1.heading("A different idea");
p1.para(
  "John Snow, a London physician, thought otherwise. He had argued for years that cholera was carried in water " +
    "contaminated by the waste of the sick, and that people caught it by swallowing it. Soho gave him a test.",
);
p1.para(
  "Snow went from house to house, writing down where each person who died had lived and where the household drew its " +
    "water. In 1854 most homes had no tap: people carried water from public street pumps.",
);
p1.heading("The question");
p1.para(
  "If the cause was the air, deaths should be spread over the whole smelly district. If the cause was the water, they " +
    "should gather around one source. Page 2 shows what Snow found.",
);
p1.footer(1);

// ---------- page 2: the map
const p2 = new Page();
p2.text("The map", 72, p2.y, 20, "F2");
p2.y -= 22;
p2.para("Each black bar is one death, stacked at the house where it happened.", { size: 10.5, gap: 4 });

const MX = 72;
const MY = 210;
const MW = W - 144;
const MH = 430;
const m = p2.ops;
m.push(`0.97 g ${n(MX)} ${n(MY)} ${n(MW)} ${n(MH)} re f`);
m.push(`0.3 G 0.8 w ${n(MX)} ${n(MY)} ${n(MW)} ${n(MH)} re S`);
// Streets in map units (0..100 x 0..100): [x1, y1, x2, y2, name, label at]
const streets = [
  [4, 56, 96, 56, "BROAD STREET", 0.08],
  [4, 84, 96, 84, "OXFORD STREET", 0.08],
  [4, 22, 96, 22, "BREWER STREET", 0.08],
  [12, 92, 12, 10, "REGENT STREET", 0.5],
  [30, 84, 30, 22, "MARSHALL ST", 0.35],
  [47, 84, 47, 22, "CAMBRIDGE ST", 0.18],
  [64, 84, 64, 22, "BERWICK ST", 0.35],
  [80, 84, 80, 22, "WARDOUR ST", 0.35],
  [64, 40, 96, 40, "PETER ST", 0.5],
  [12, 40, 47, 40, "GREAT PULTENEY ST", 0.22],
  [30, 70, 64, 70, "NEW STREET", 0.6],
];
const mx = (u) => MX + 14 + (u / 100) * (MW - 28);
const my = (v) => MY + 14 + (v / 100) * (MH - 28);
m.push("0.78 G 7 w 1 J");
for (const [x1, y1, x2, y2] of streets) m.push(`${n(mx(x1))} ${n(my(y1))} m ${n(mx(x2))} ${n(my(y2))} l S`);
m.push("0 J");
for (const [x1, y1, x2, y2, name, at] of streets) {
  const vertical = x1 === x2;
  const x = mx(x1 + (x2 - x1) * at);
  const y = my(y1 + (y2 - y1) * at);
  if (vertical) m.push(`0.35 g BT /F1 6 Tf 0 1 -1 0 ${n(x + 2)} ${n(y)} Tm (${esc(name)}) Tj ET`);
  else m.push(`0.35 g BT /F1 6 Tf ${n(x)} ${n(y - 2)} Td (${esc(name)}) Tj ET`);
}
// The pumps: the Broad Street one, and others nearby.
const PUMP = [47, 56];
const others = [
  [12, 70],
  [30, 30],
  [64, 77],
  [80, 48],
  [96, 30],
  [22, 22],
];
const pump = ([u, v], main) => {
  const x = mx(u);
  const y = my(v);
  const r = main ? 5.5 : 3.6;
  m.push(`${main ? "0.8 0.1 0.1 rg" : "0.25 0.35 0.75 rg"} ${n(x - r)} ${n(y - r)} ${n(2 * r)} ${n(2 * r)} re f`);
};
// Deaths: houses every few units along each street, a stack of bars whose height falls off with the walking
// distance (approximated as straight-line) from the Broad Street pump. Deterministic.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let deaths = 0;
m.push("0 g");
for (const [x1, y1, x2, y2] of streets) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const vertical = x1 === x2;
  for (let t = 2; t < len - 1; t += 2.6) {
    for (const side of [-1, 1]) {
      const u = x1 + ((x2 - x1) * t) / len;
      const v = y1 + ((y2 - y1) * t) / len;
      // No houses in the crossings: a bar there would sit on the other street.
      if (streets.some(([a1, b1, a2, b2]) => (vertical ? b1 === b2 && Math.abs(v - b1) < 1.6 && u >= Math.min(a1, a2) && u <= Math.max(a1, a2) : a1 === a2 && Math.abs(u - a1) < 1.6 && v >= Math.min(b1, b2) && v <= Math.max(b1, b2)))) continue;
      const d = Math.hypot(u - PUMP[0], (v - PUMP[1]) * 1.1);
      const k = Math.round(16 * Math.exp(-d / 12) + (rand() < 0.5 * Math.exp(-d / 22) ? 1 : 0) - (rand() < 0.3 ? 1 : 0));
      if (k <= 0) continue;
      deaths += k;
      const bx = mx(u);
      const by = my(v);
      for (let j = 0; j < k; j++) {
        const off = 5 + j * 1.9;
        if (vertical) m.push(`${n(bx + side * off - (side < 0 ? 3.2 : 0))} ${n(by - 0.6)} 3.2 1.2 re f`);
        else m.push(`${n(bx - 1.6)} ${n(by + side * off - (side < 0 ? 1.2 : 0))} 3.2 1.2 re f`);
      }
    }
  }
}
for (const o of others) pump(o, false);
pump(PUMP, true);
// Its label on a white tag above the crowd, with a leader line.
const lx = mx(PUMP[0]) + 34;
const lyy = my(PUMP[1]) + 64;
m.push(`0.8 0.1 0.1 RG 0.8 w ${n(mx(PUMP[0]) + 4)} ${n(my(PUMP[1]) + 4)} m ${n(lx)} ${n(lyy)} l S`);
m.push(`1 g ${n(lx - 3)} ${n(lyy - 3)} 84 13 re f 0.8 0.1 0.1 RG ${n(lx - 3)} ${n(lyy - 3)} 84 13 re S`);
m.push(`0.8 0.1 0.1 rg BT /F2 8 Tf ${n(lx)} ${n(lyy)} Td (Broad Street pump) Tj ET`);
// Legend
const ly = MY - 20;
m.push(`0 g ${n(MX)} ${n(ly)} 3.2 1.2 re f`);
p2.text("one death", MX + 8, ly - 2, 8.5);
m.push(`0.8 0.1 0.1 rg ${n(MX + 70)} ${n(ly - 4)} 9 9 re f`);
p2.text("the Broad Street pump", MX + 84, ly - 2, 8.5);
m.push(`0.25 0.35 0.75 rg ${n(MX + 200)} ${n(ly - 3)} 7 7 re f`);
p2.text("other street pumps", MX + 212, ly - 2, 8.5);
p2.y = ly - 26;
p2.para(
  "Schematic redrawing after John Snow's map in On the Mode of Communication of Cholera (2nd ed., 1855), which is in " +
    "the public domain. Streets simplified and not to scale; the bars show the pattern, not Snow's exact counts.",
  { size: 8.5, font: "F3", gap: 6 },
);
p2.para(
  "Read it as Snow did: the bars pile up around one pump and thin out with distance from it, even where other pumps " +
    "are closer. The deaths follow the water, not the air.",
  { size: 10.5 },
);
p2.footer(2);

// ---------- page 3
const p3 = new Page();
p3.heading("The exceptions that proved it", 17);
p3.para(
  "Snow's strongest evidence came from the places that did not fit the simple picture. A workhouse on Poland Street, " +
    "close to the pump, had several hundred residents but very few deaths: it had its own well. The men of a brewery " +
    "on Broad Street drank the beer they were given and did not fetch water from the pump; none of them is known to " +
    "have died.",
);
p3.para(
  "The other way round, a widow living in Hampstead, miles away, died of cholera. She had liked the taste of the " +
    "Broad Street water and had it carried to her. A niece who visited her and drank it died too.",
);
p3.heading("The handle", 17);
p3.para(
  "On 7 September 1854 Snow put his findings to the parish's Board of Guardians, and the next day the handle of the " +
    "pump was taken off. The outbreak was already waning by then, as many people had fled, so the handle alone did not " +
    "end it. But the map made the case in one look.",
);
p3.para(
  "Later investigation found a likely source: a cesspool a few feet from the well, into which the washing of a sick " +
    "baby at 40 Broad Street had been emptied just before the outbreak.",
);
p3.heading("Why it still matters", 17);
p3.para(
  "The Broad Street map is often called the founding picture of epidemiology: count the cases, put them where they " +
    "happened, and let the pattern point at the cause. It also shows how a single clear figure can carry an argument " +
    "that pages of tables could not.",
);
p3.para("Try this: open the chat and ask, 'What is this map telling me?'", { font: "F3" });
p3.footer(3);

// ---------- the file
const pages = [p1, p2, p3];
const objs = [];
const add = (body) => objs.push(body) - 1 + 1;
const catalog = add("");
const pagesObj = add("");
const fonts = [add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"), add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"), add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>")];
const kids = [];
for (const p of pages) {
  const s = p.stream();
  const content = add(`<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >> /Contents ${content} 0 R >>`));
}
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
const info = add("<< /Title (The Broad Street Pump \\(London, 1854\\)) /Producer (vault-chat scripts/make-sample-paper.mjs) >>");
let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
const offsets = [];
objs.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(pdf, "latin1"));
console.log(`${out}: ${pages.length} pages, ${Buffer.byteLength(pdf, "latin1")} bytes, ${deaths} bars`);
