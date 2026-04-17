import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const READ_CAP = 24_000;
const SHORT_CAP = 8_000;
const PDF_CAP = 60_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return (
    text.slice(0, max) +
    `\n…[truncated, ${omitted.toLocaleString()} more chars]`
  );
}

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

async function extractPdfText(path: string, pageSpec?: string): Promise<string> {
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
function splitSource(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  return lines.map((line, i) =>
    i === lines.length - 1 ? line : line + "\n",
  );
}

function stripNotebook(raw: string): string {
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

export function buildTools(vault: string, tavilyKey?: string) {
  const base = {
    Read: tool({
      description:
        "Read a UTF-8 text file. Use absolute paths. Returns the file contents. Jupyter notebooks (.ipynb) return source cells only (outputs stripped). Long files are truncated; use Edit/Grep for surgical access.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file."),
      }),
      execute: async ({ path }) => {
        const raw = await invoke<string>("read_text_file", { path });
        const text = path.toLowerCase().endsWith(".ipynb") ? stripNotebook(raw) : raw;
        return truncate(text, READ_CAP);
      },
    }),

    Write: tool({
      description:
        "Write a UTF-8 text file. Creates parent directories as needed. Overwrites existing files. Use absolute paths.",
      inputSchema: z.object({
        path: z.string(),
        contents: z.string(),
      }),
      execute: async ({ path, contents }) => {
        await invoke("write_text_file", { path, contents });
        return `wrote ${path}`;
      },
    }),

    Delete: tool({
      description:
        "Delete a file or directory at the given absolute path. Directories are removed recursively. Irreversible — only use when the user has asked for deletion.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file or directory to delete."),
      }),
      execute: async ({ path }) => {
        await invoke("delete_file", { path });
        return `deleted ${path}`;
      },
    }),

    Edit: tool({
      description:
        "Replace a string in a file. old_string must be unique in the file unless replace_all is true. Fails if old_string is not found or is not unique (without replace_all). Prefer Edit over Write for small changes to large files.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        return await invoke<string>("edit_text_file", {
          path,
          oldString: old_string,
          newString: new_string,
          replaceAll: replace_all ?? false,
        });
      },
    }),

    Glob: tool({
      description:
        "Find files matching a glob pattern (e.g., '**/*.md', 'lectures/**/notes.md'). Relative patterns resolve from the vault root. Returns paths sorted by modification time (newest first).",
      inputSchema: z.object({
        pattern: z.string(),
      }),
      execute: async ({ pattern }) => {
        const results = await invoke<string[]>("glob_files", {
          pattern,
          cwd: vault,
        });
        if (!results.length) return "(no matches)";
        return truncate(results.join("\n"), SHORT_CAP);
      },
    }),

    Grep: tool({
      description:
        "Search file contents with a regular expression. Returns matching lines as 'path:line: text'. Use glob_filter like '*.md' to restrict file types.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().describe("Directory or file to search. Defaults to vault root."),
        glob_filter: z.string().optional().describe("Filename glob, e.g. '*.md'"),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().optional(),
      }),
      execute: async ({ pattern, path, glob_filter, case_insensitive, max_results }) => {
        const results = await invoke<{ path: string; line: number; text: string }[]>(
          "grep_files",
          {
            pattern,
            path: path ?? vault,
            globFilter: glob_filter ?? null,
            caseInsensitive: case_insensitive ?? false,
            maxResults: max_results ?? 500,
          }
        );
        if (!results.length) return "(no matches)";
        return truncate(results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n"), SHORT_CAP);
      },
    }),

    Bash: tool({
      description:
        "Execute a shell command. Runs with the vault as the working directory by default. Returns stdout, stderr, and exit code. Use for git, pytest, scripts, etc. Default timeout 120s.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional().describe("Working directory. Defaults to vault root."),
        timeout_ms: z.number().int().optional(),
      }),
      execute: async ({ command, cwd, timeout_ms }) => {
        const result = await invoke<{
          stdout: string;
          stderr: string;
          code: number;
          timed_out: boolean;
        }>("bash_exec", {
          command,
          cwd: cwd ?? vault,
          timeoutMs: timeout_ms ?? 120_000,
        });
        const parts: string[] = [];
        parts.push(`exit: ${result.code}${result.timed_out ? " (TIMED OUT)" : ""}`);
        if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout, SHORT_CAP)}`);
        if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr, SHORT_CAP)}`);
        return parts.join("\n");
      },
    }),

    NotebookEdit: tool({
      description:
        "Cell-aware edit of a Jupyter notebook (.ipynb). Use `action` to replace/insert/delete a cell. Cells are 0-indexed in the notebook's top-to-bottom order. For `insert`, the new cell is placed at `cell_index` (pushing the existing cell down); use `cell_index: -1` to append at the end. For `replace`, `source` fully replaces the target cell's source; `cell_type` can switch the cell type too. Much safer than using Write/Edit on raw JSON.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the .ipynb file."),
        action: z.enum(["replace", "insert", "delete"]),
        cell_index: z
          .number()
          .int()
          .describe("0-based cell index. Use -1 with insert to append."),
        source: z
          .string()
          .optional()
          .describe("New cell source. Required for replace/insert."),
        cell_type: z
          .enum(["code", "markdown", "raw"])
          .optional()
          .describe("Cell type for insert/replace. Defaults to 'code' on insert; preserves existing type on replace when omitted."),
      }),
      execute: async ({ path, action, cell_index, source, cell_type }) => {
        try {
          const raw = await invoke<string>("read_text_file", { path });
          const nb = JSON.parse(raw);
          if (!nb || !Array.isArray(nb.cells)) {
            return `not a notebook (missing cells array): ${path}`;
          }
          const cells = nb.cells as any[];

          if (action === "delete") {
            if (cell_index < 0 || cell_index >= cells.length) {
              return `cell_index ${cell_index} out of range (0..${cells.length - 1})`;
            }
            cells.splice(cell_index, 1);
          } else if (action === "replace") {
            if (cell_index < 0 || cell_index >= cells.length) {
              return `cell_index ${cell_index} out of range (0..${cells.length - 1})`;
            }
            if (source === undefined) {
              return "replace requires `source`";
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
          } else if (action === "insert") {
            if (source === undefined) {
              return "insert requires `source`";
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
              return `negative cell_index not allowed for insert (use -1 for append)`;
            } else {
              cells.splice(cell_index, 0, newCell);
            }
          }

          const contents = JSON.stringify(nb, null, 1) + "\n";
          await invoke("write_text_file", { path, contents });
          return `${action} cell ${cell_index} in ${path} (now ${cells.length} cells)`;
        } catch (e) {
          return `NotebookEdit failed: ${(e as Error).message}`;
        }
      },
    }),

    PdfExtract: tool({
      description:
        "Extract text from a PDF file. Returns plain text grouped by page. Use `pages` to limit (e.g., '1', '1-5', '1,3,7-9'); omit to extract all. Output is truncated at ~60k chars — prefer page ranges for long PDFs. Useful for reading lecture slides, papers, and other PDF content in the vault.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the PDF file."),
        pages: z
          .string()
          .optional()
          .describe("Page selection: '1', '1-5', '1,3,7-9'. Omit for all pages."),
      }),
      execute: async ({ path, pages }) => {
        try {
          const text = await extractPdfText(path, pages);
          return truncate(text, PDF_CAP);
        } catch (e) {
          return `PDF extraction failed: ${(e as Error).message}`;
        }
      },
    }),

    ListDir: tool({
      description: "List the immediate contents of a directory (non-recursive). Returns files and subdirectories.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        const entries = await invoke<{ path: string; name: string; is_dir: boolean }[]>(
          "list_dir",
          { path }
        );
        return truncate(
          entries.map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}`).join("\n"),
          SHORT_CAP,
        );
      },
    }),

    WebFetch: tool({
      description:
        "Fetch a URL over HTTPS and return the body as text. HTML is stripped to readable text. Use for documentation, articles, and API responses. Follows redirects. Output is truncated at ~120k chars.",
      inputSchema: z.object({
        url: z.string().describe("Fully-qualified URL starting with http:// or https://"),
        max_chars: z.number().int().optional().describe("Cap on returned text length. Default 120000."),
      }),
      execute: async ({ url, max_chars }) => {
        return await invoke<string>("http_fetch", { url, maxChars: max_chars ?? null });
      },
    }),
  };

  if (!tavilyKey) return base;

  return {
    ...base,
    WebSearch: tool({
      description:
        "Search the web and return the top results (title, URL, snippet) plus a synthesized answer. Use this when the user asks a question that requires current information, or when you don't know a specific URL. Prefer WebFetch if you already know the URL.",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
        max_results: z.number().int().optional().describe("Default 5, max 10."),
      }),
      execute: async ({ query, max_results }) => {
        return await invoke<string>("tavily_search", {
          query,
          apiKey: tavilyKey,
          maxResults: max_results ?? null,
          includeAnswer: true,
        });
      },
    }),
  };
}

export type ToolName = keyof ReturnType<typeof buildTools>;
