// Tool bodies that are not about the conversation itself: PdfRead (page
// ranges, never the whole document by default) and WebSearch (OpenRouter's web
// plugin on a cheap model). Detached jobs are in pi/jobs.ts.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
  return out;
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
