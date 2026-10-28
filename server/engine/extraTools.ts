// Tool bodies that are not about the conversation itself: PdfRead (page
// ranges, never the whole document by default), PdfPages (the pages themselves,
// to the model as a PDF) and WebSearch (OpenRouter's web plugin on a cheap
// model). Detached jobs are in pi/jobs.ts.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolSpec, ToolAnswer } from "./pi/backend";

// ---- PdfRead ----
const PDF_DEFAULT_PAGES = "1-3";
const PDF_DEFAULT_CHARS = 12_000;
const PDF_MAX_CHARS = 40_000;

export async function pdfRead(vault: string, a: { path?: string; pages?: string; maxChars?: number }): Promise<string> {
  const raw = String(a?.path ?? "").trim();
  if (!raw) return "PdfRead needs a path.";
  const path = isAbsolute(raw) ? raw : resolve(vault, raw);
  if (!existsSync(path)) return `No such file: ${path}`;
  const { extractPdfText } = await import("../../src/fileText");
  const pages = String(a?.pages ?? "").trim() || PDF_DEFAULT_PAGES;
  const cap = Math.max(500, Math.min(Number(a?.maxChars) || PDF_DEFAULT_CHARS, PDF_MAX_CHARS));
  let text: string;
  try {
    text = await extractPdfText(path, pages);
  } catch (e) {
    return `PDF extraction failed: ${(e as Error).message}`;
  }
  const m = /\] (\d+) page\(s\)/.exec(text);
  const total = m ? Number(m[1]) : null;
  let out = text.length > cap ? text.slice(0, cap) + `\n…[cut at ${cap} chars of ${text.length}; ask for fewer pages or a larger maxChars]` : text;
  if (!a?.pages && total && total > 3) out += `\n\n(${total} pages in total; this shows pages ${PDF_DEFAULT_PAGES}. Pass pages, e.g. "4-8", for more.)`;
  const blank = [...text.matchAll(/--- page (\d+) ---\n(?=\n--- page |$)/g)].map((m) => m[1]);
  if (blank.length) out += `\n\n(No text layer on page ${blank.join(", ")}: a scan or a drawing. PdfPages shows the page itself.)`;
  return out;
}

// ---- PdfPages ----
// The pages themselves, as Claude reads a PDF: a slice of the asked pages
// (pdf.js's extractPages, the PDF library already here) goes to the model as a
// native PDF part, its text and its page images (pi/ext/pdf.mjs attaches it).
// Slices are cached in the vault's local, never-synced dir by source hash and pages.
const PDF_PAGES_MAX = 10;

export const pdfPagesSpec: ToolSpec = {
  type: "function",
  name: "PdfPages",
  readOnly: true,
  description: `See pages of a PDF in the vault as they look: the pages go to you as a PDF (each page's text and image, as you read PDFs), so scans, handwriting, figures, diagrams, tables and layout are visible. At most ${PDF_PAGES_MAX} pages a call; use PdfRead for plain text.`,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, pages: { type: "string", description: "e.g. \"3\", \"2-4\", \"1,5\"" } },
    required: ["path", "pages"],
    additionalProperties: false,
  },
};

function pageList(spec: string, total: number): number[] {
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    let [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

/** [1,2,3,5] → "1-3,5" */
function rangesOf(ps: number[]): string {
  const r: [number, number][] = [];
  for (const p of ps) {
    const last = r[r.length - 1];
    if (last && last[1] === p - 1) last[1] = p;
    else r.push([p, p]);
  }
  return r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
}

export async function pdfPages(vault: string, a: { path?: string; pages?: string }, attach?: (blob: string, filename: string) => void): Promise<string> {
  const raw = String(a?.path ?? "").trim();
  if (!raw) return "PdfPages needs a path.";
  const path = isAbsolute(raw) ? raw : resolve(vault, raw);
  if (!existsSync(path)) return `No such file: ${path}`;
  const bytes = readFileSync(path);
  const pdfjs: any = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    const total: number = doc.numPages;
    const pages = pageList(String(a?.pages ?? "1"), total);
    if (!pages.length) return `${raw} has ${total} page(s); none of "${a?.pages}" is among them.`;
    if (pages.length > PDF_PAGES_MAX) return `That is ${pages.length} pages; PdfPages takes at most ${PDF_PAGES_MAX} a call.`;
    const dir = join(vault, ".vault-chat", "local", "pdf-pages");
    mkdirSync(dir, { recursive: true });
    if (realpathSync(dir) !== join(realpathSync(vault), ".vault-chat", "local", "pdf-pages")) throw new Error("PDF cache must not escape through symlinks");
    const slice = join(dir, `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}-p${rangesOf(pages)}.pdf`);
    if (existsSync(slice) && !lstatSync(slice).isFile()) throw new Error("PDF cache entry must be a regular file");
    if (!existsSync(slice)) {
      const out: Uint8Array = await doc.extractPages([{ document: null, includePages: pages.map((p) => p - 1) }]);
      mkdirSync(dir, { recursive: true });
      const temporary = `${slice}.${randomUUID()}.tmp`;
      writeFileSync(temporary, out, { flag: "wx" });
      renameSync(temporary, slice);
    }
    attach?.(readFileSync(slice).toString("base64"), slice.slice(dir.length + 1));
    return `${raw}: ${total} page(s). Page ${rangesOf(pages)} attached below as a PDF (its text and page images).\n[PDF pages attached: ${slice}]`;
  } finally {
    void doc.destroy();
  }
}

/** Standard MCP attachment plus the existing private provider marker. Never
 * infer a host file to read from arbitrary tool-result text. */
export async function pdfPagesAnswer(vault: string, a: { path?: string; pages?: string }): Promise<ToolAnswer> {
  const resources: NonNullable<ToolAnswer["resources"]> = [];
  const text = await pdfPages(vault, a, (blob, filename) => resources.push({
    uri: `vault-chat://pdf-pages/${filename}`, mimeType: "application/pdf", blob,
  }));
  return { ok: true, text, resources };
}

// ---- WebSearch ----
export async function webSearch(query: string, apiKey: string | null, model: string): Promise<string> {
  const q = String(query ?? "").trim();
  if (!q) return "WebSearch needs a query.";
  if (!apiKey) return "WebSearch unavailable: no OpenRouter key.";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        plugins: [{ id: "web", max_results: 5 }],
        messages: [
          { role: "system", content: "Answer the query from the web results. Be concise and factual. End with a Sources list of the URLs you used." },
          { role: "user", content: q },
        ],
        max_tokens: 1200,
      }),
    });
    if (!r.ok) return `WebSearch failed: HTTP ${r.status}`;
    const j: any = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    const ann: any[] = j?.choices?.[0]?.message?.annotations ?? [];
    const urls = ann.map((x) => x?.url_citation?.url).filter((u: unknown) => typeof u === "string");
    const extra = urls.length && !urls.every((u: string) => text.includes(u)) ? `\n\nSources:\n${[...new Set(urls)].map((u) => `- ${u}`).join("\n")}` : "";
    return (text || "(no answer)") + extra;
  } catch (e) {
    return `WebSearch failed: ${(e as Error).message}`;
  }
}
