// Text out of files the agent's tools hand over on the box: a PDF's pages
// (server/engine/extraTools.ts PdfRead) and a notebook's cells (voice's Read
// and NotebookEdit, server/voice.ts).
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

function parsePageSpec(spec: string | undefined, total: number): number[] {
  if (!spec || !spec.trim()) {
    const out: number[] = [];
    for (let i = 1; i <= total; i++) out.push(i);
    return out;
  }
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) set.add(i);
    } else {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= total) set.add(n);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

export async function extractPdfText(path: string, pageSpec?: string): Promise<string> {
  const bytes = await invoke<number[]>("read_binary_file", { path });
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const pages = parsePageSpec(pageSpec, doc.numPages);
    const out: string[] = [];
    out.push(`[${path}] ${doc.numPages} page(s) · extracting ${pages.length}`);
    for (const pageNum of pages) {
      const page = await doc.getPage(pageNum);
      const tc = await page.getTextContent();
      const lines: string[] = [];
      let cur = "";
      let lastY: number | null = null;
      for (const item of tc.items as any[]) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          if (cur) lines.push(cur);
          cur = "";
        }
        cur += item.str;
        if (item.hasEOL) {
          lines.push(cur);
          cur = "";
        }
        if (y !== undefined) lastY = y;
      }
      if (cur) lines.push(cur);
      out.push(`\n--- page ${pageNum} ---\n${lines.join("\n").trim()}`);
      page.cleanup();
    }
    return out.join("\n");
  } finally {
    doc.destroy();
  }
}

// Jupyter stores cell source as an array of lines with trailing newlines
// (except the last one). Match that format so diffs stay minimal.
export function splitSource(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  return lines.map((line, i) =>
    i === lines.length - 1 ? line : line + "\n",
  );
}

// Apply a single notebook-cell mutation to a raw .ipynb string. Returns
// the new raw JSON and a one-line summary, or an error message string.
export function applyNotebookEdit(
  raw: string,
  action: "replace" | "insert" | "delete" | "append",
  cell_index: number,
  source: string | undefined,
  cell_type: "code" | "markdown" | "raw" | undefined,
): { ok: true; contents: string; summary: string } | { ok: false; error: string } {
  let nb: any;
  try {
    nb = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `failed to parse notebook: ${(e as Error).message}` };
  }
  if (!nb || !Array.isArray(nb.cells)) {
    return { ok: false, error: "not a notebook (missing cells array)" };
  }
  const cells = nb.cells as any[];

  if (action === "delete") {
    if (cell_index < 0 || cell_index >= cells.length) {
      return { ok: false, error: `cell_index ${cell_index} out of range (0..${cells.length - 1})` };
    }
    cells.splice(cell_index, 1);
  } else if (action === "replace") {
    if (cell_index < 0 || cell_index >= cells.length) {
      return { ok: false, error: `cell_index ${cell_index} out of range (0..${cells.length - 1})` };
    }
    if (source === undefined) {
      return { ok: false, error: "replace requires `source`" };
    }
    const target = cells[cell_index];
    target.source = splitSource(source);
    if (cell_type && target.cell_type !== cell_type) {
      target.cell_type = cell_type;
      if (cell_type === "code") {
        target.outputs = [];
        target.execution_count = null;
        delete target.attachments;
      } else {
        delete target.outputs;
        delete target.execution_count;
      }
    }
    if (target.cell_type === "code") {
      target.outputs = [];
      target.execution_count = null;
    }
  } else if (action === "append") {
    if (cell_index < 0 || cell_index >= cells.length) {
      return { ok: false, error: `cell_index ${cell_index} out of range (0..${cells.length - 1})` };
    }
    if (source === undefined) {
      return { ok: false, error: "append requires `source`" };
    }
    const target = cells[cell_index];
    const existing = Array.isArray(target.source)
      ? target.source.join("")
      : String(target.source ?? "");
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    target.source = splitSource(existing + sep + source);
    if (target.cell_type === "code") {
      target.outputs = [];
      target.execution_count = null;
    }
  } else if (action === "insert") {
    if (source === undefined) {
      return { ok: false, error: "insert requires `source`" };
    }
    const type = cell_type ?? "code";
    const newCell: any = {
      cell_type: type,
      metadata: {},
      source: splitSource(source),
    };
    if (type === "code") {
      newCell.outputs = [];
      newCell.execution_count = null;
    }
    if (cell_index === -1 || cell_index >= cells.length) {
      cells.push(newCell);
    } else if (cell_index < 0) {
      return { ok: false, error: "negative cell_index not allowed for insert (use -1 for append)" };
    } else {
      cells.splice(cell_index, 0, newCell);
    }
  }

  const contents = JSON.stringify(nb, null, 1) + "\n";
  return {
    ok: true,
    contents,
    summary: `${action} cell ${cell_index} (now ${cells.length} cells)`,
  };
}

export function stripNotebook(raw: string): string {
  try {
    const nb = JSON.parse(raw);
    if (!nb || !Array.isArray(nb.cells)) return raw;
    const out: string[] = [];
    nb.cells.forEach((cell: any, i: number) => {
      const type = cell.cell_type ?? "code";
      const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
      out.push(`# Cell ${i} [${type}]`);
      out.push(src.trimEnd());
      out.push("");
    });
    return out.join("\n");
  } catch {
    return raw;
  }
}
