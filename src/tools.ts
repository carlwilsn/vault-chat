import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useStore, type TodoItem } from "./store";
import { buildNote } from "./notes";

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

// Render one PDF page to a PNG data URL off-DOM. We aim for legibility
// without overshooting provider limits: Anthropic recommends ≤1568 px
// on the long edge and rejects oversized base64 payloads as "invalid
// base64 data". Cap the long edge at 1568 px and pick the scale that
// hits it; pages smaller than that natively render at scale 2 for crisp
// text without ballooning.
const SNAPSHOT_MAX_EDGE = 1568;
const SNAPSHOT_MAX_SCALE = 2.0;

export async function capturePageImage(path: string, pageNum: number): Promise<{ dataUrl: string; totalPages: number }> {
  const bytes = await invoke<number[]>("read_binary_file", { path });
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    if (pageNum < 1 || pageNum > doc.numPages) {
      throw new Error(`page ${pageNum} out of range (1..${doc.numPages})`);
    }
    const page = await doc.getPage(pageNum);
    try {
      const base = page.getViewport({ scale: 1.0 });
      const longEdge = Math.max(base.width, base.height);
      const fitScale = SNAPSHOT_MAX_EDGE / longEdge;
      const scale = Math.min(SNAPSHOT_MAX_SCALE, fitScale);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("failed to get 2d canvas context");
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      // JPEG quality 0.9 — far smaller than PNG for photographic
      // content and similar quality for rendered slides/diagrams.
      // Anthropic accepts image/jpeg as image source.
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      return { dataUrl, totalPages: doc.numPages };
    } finally {
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
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
// Shared by the agent's NotebookEdit tool and the voice-mode handler so
// the two can't drift.
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

export type BuildToolsOptions = {
  tavilyKey?: string;
  // When true, file-op tools refuse paths outside the active vault.
  // Doesn't constrain Bash — that's a separate switch because we have
  // no real shell sandbox.
  strictVault?: boolean;
  // When true, the Bash tool is omitted from the agent's toolset.
  bashDisabled?: boolean;
  // Current conversation context. Lets the Schedule tool bind new
  // schedules to this conversation, so when the schedule fires the
  // reply lands in (and routes from) the right chat.
  conversationId?: string;
  // Which layer this conversation sits in — assistant → missions → workers.
  // The layers are enforced HERE, not by prompt discipline: assistants mint
  // missions but cannot spawn workers; only a mission thread holds
  // StartWorker; workers hold neither (they do the task, not orchestration).
  tier?: "assistant" | "mission" | "worker";
  // The run's abort signal. Used to HARD-interrupt a long tool (Bash) — on
  // Stop we kill the subprocess instead of waiting for it to run to completion.
  abortSignal?: AbortSignal;
};

// Pure-string path containment check. Symlinks are NOT resolved — a
// determined attacker (or an LLM doing something dumb) could bypass via
// a symlink inside the vault. Documented in README. We reject any path
// containing a `..` segment to block the obvious traversal escape.
function isInside(absPath: string, root: string): boolean {
  const np = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const nr = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!nr) return false;
  return np === nr || np.startsWith(nr + "/");
}

function assertAllowed(
  path: string,
  vault: string,
  strict: boolean,
): void {
  if (!strict) return;
  const np = path.replace(/\\/g, "/");
  if (np.split("/").some((seg) => seg === "..")) {
    throw new Error(`refusing path with '..' segment (strict vault mode): ${path}`);
  }
  if (isInside(np, vault)) return;
  throw new Error(
    `refusing access outside vault (strict vault mode): ${path}\nallowed: ${vault}`,
  );
}

// Globs that resolve outside the vault would defeat the guard. With
// `cwd: vault` set on glob_files, an absolute pattern (e.g. /etc/**) or
// one starting with ../ is the obvious escape — reject those when
// strict.
function assertGlobAllowed(pattern: string, strict: boolean): void {
  if (!strict) return;
  const p = pattern.replace(/\\/g, "/");
  const isAbsolute = /^([a-zA-Z]:)?\//.test(p);
  if (isAbsolute) {
    throw new Error(
      `refusing absolute glob pattern (strict vault mode): ${pattern}`,
    );
  }
  if (p.split("/").some((seg) => seg === "..")) {
    throw new Error(
      `refusing glob with '..' segment (strict vault mode): ${pattern}`,
    );
  }
}

// Throw if `absPath` is in the vault's humanized.json (exact match
// only, no ancestor inheritance). Humanized files are AI-readable but
// every write tool refuses them. Phrased exactly as the spec requires
// so the model doesn't try alternate write strategies.
export const HUMANIZED_REFUSAL =
  "File is humanized — user has chosen to hand-edit this file. Do not retry.";

export async function assertCanWrite(absPath: string, vault: string): Promise<void> {
  const np = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!nv) return;
  if (np !== nv && !np.startsWith(nv + "/")) return;
  const rel = np === nv ? "" : np.slice(nv.length + 1);
  if (!rel) return;
  let list: string[];
  try {
    list = await invoke<string[]>("read_humanized", { vault });
  } catch {
    return;
  }
  for (const entry of list) {
    const e = entry.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (e && e === rel) {
      throw new Error(HUMANIZED_REFUSAL);
    }
  }
}

// Throw if `absPath` lives under (or is) any entry in the vault's
// .vaultchatdeny file. Read fresh per call so a user toggling
// "Restrict from agent" mid-chat takes effect on the very next tool
// invocation — the file is small, the IPC is sub-ms, and rebuilding
// the toolset on every change would be a much bigger surface.
async function assertNotDenied(absPath: string, vault: string): Promise<void> {
  const np = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!nv) return;
  if (np !== nv && !np.startsWith(nv + "/")) return; // outside vault — deny doesn't apply
  const rel = np === nv ? "" : np.slice(nv.length + 1);
  if (!rel) return;
  let lines: string[];
  try {
    lines = await invoke<string[]>("read_deny_lines", { vault });
  } catch {
    return;
  }
  for (const entry of lines) {
    const e = entry.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
    if (!e) continue;
    if (rel === e || rel.startsWith(e + "/")) {
      throw new Error(
        `Refused: '${rel}' is restricted from the agent (.vaultchatdeny). Right-click → "Allow agent access" in the file tree to revoke.`,
      );
    }
  }
}

export function buildTools(vault: string, options: BuildToolsOptions = {}) {
  const {
    tavilyKey,
    strictVault = false,
    bashDisabled = false,
    conversationId,
    tier = "assistant",
    abortSignal,
  } = options;
  const guardPath = (path: string) => assertAllowed(path, vault, strictVault);
  const guardDenied = (path: string) => assertNotDenied(path, vault);
  const guardWritable = (path: string) => assertCanWrite(path, vault);
  const base = {
    Read: tool({
      description:
        "Read a UTF-8 text file. Use absolute paths. Returns the file contents. Jupyter notebooks (.ipynb) return source cells only (outputs stripped). Long files are truncated; use Edit/Grep for surgical access.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file."),
      }),
      execute: async ({ path }) => {
        guardPath(path);
        await guardDenied(path);
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
        guardPath(path);
        await guardDenied(path);
        await guardWritable(path);
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
        guardPath(path);
        await guardDenied(path);
        await guardWritable(path);
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
        guardPath(path);
        await guardDenied(path);
        await guardWritable(path);
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
        assertGlobAllowed(pattern, strictVault);
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
        if (path) {
          guardPath(path);
          await guardDenied(path);
        }
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
        // Filter denied paths from results so a directory grep can't
        // surface content from a restricted subtree even when the
        // search path itself is allowed.
        const denyLines = await invoke<string[]>("read_deny_lines", { vault }).catch(() => [] as string[]);
        const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
        const denyRels = denyLines.map((l) => l.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
        const isDenied = (abs: string): boolean => {
          const np = abs.replace(/\\/g, "/").replace(/\/+$/, "");
          if (!np.startsWith(nv + "/") && np !== nv) return false;
          const rel = np === nv ? "" : np.slice(nv.length + 1);
          return denyRels.some((e) => rel === e || rel.startsWith(e + "/"));
        };
        const kept = results.filter((r) => !isDenied(r.path));
        if (!kept.length) return "(no matches)";
        return truncate(kept.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n"), SHORT_CAP);
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
        // Best-effort deny gate for Bash: refuse if the command string
        // mentions a restricted path (relative or absolute). Catches the
        // obvious `cat secrets/x` case; doesn't catch glob expansion or
        // env-var indirection — Bash is fundamentally an escape hatch
        // and the user accepts that by enabling it.
        try {
          const denyLines = await invoke<string[]>("read_deny_lines", { vault });
          const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
          for (const raw of denyLines) {
            const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            if (!rel) continue;
            const abs = `${nv}/${rel}`;
            if (command.includes(rel) || command.includes(abs)) {
              return `Refused: command references restricted path '${rel}' (.vaultchatdeny). Right-click → "Allow agent access" in the file tree to revoke.`;
            }
          }
        } catch {
          // No deny file or read failed — fall through, original behaviour.
        }
        // Same best-effort gate for humanized files. Bash can still
        // smuggle writes through indirection — accepted, same caveat.
        try {
          const humanized = await invoke<string[]>("read_humanized", { vault });
          const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
          for (const raw of humanized) {
            const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            if (!rel) continue;
            const abs = `${nv}/${rel}`;
            if (command.includes(rel) || command.includes(abs)) {
              return HUMANIZED_REFUSAL;
            }
          }
        } catch {
          // fall through
        }
        // Hard interrupt: Stop should KILL an in-flight command, not wait for it
        // to finish. Hand the Rust side a cancel id and, when the run's abort
        // fires, signal it — the bash poll loop kills the subprocess within a
        // few ms. Without this, hitting Stop mid-`pytest`/`git`/training left the
        // command running to completion (or its 120s timeout) before the turn
        // could end.
        const cancelId = `bash_${conversationId ?? "fg"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        let aborted = abortSignal?.aborted ?? false;
        const onAbort = () => {
          aborted = true;
          void invoke("bash_cancel", { cancelId }).catch(() => {});
        };
        if (aborted) onAbort();
        else abortSignal?.addEventListener("abort", onAbort, { once: true });
        let result: { stdout: string; stderr: string; code: number; timed_out: boolean };
        try {
          result = await invoke("bash_exec", {
            command,
            cwd: cwd ?? vault,
            timeoutMs: timeout_ms ?? 120_000,
            cancelId,
          });
        } finally {
          abortSignal?.removeEventListener("abort", onAbort);
        }
        if (aborted) return "(interrupted — command killed)";
        const parts: string[] = [];
        parts.push(`exit: ${result.code}${result.timed_out ? " (TIMED OUT)" : ""}`);
        if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout, SHORT_CAP)}`);
        if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr, SHORT_CAP)}`);
        return parts.join("\n");
      },
    }),

    NotebookEdit: tool({
      description:
        "Cell-aware edit of a Jupyter notebook (.ipynb). Use `action` to replace/insert/delete/append a cell. Cells are 0-indexed in the notebook's top-to-bottom order. For `insert`, the new cell is placed at `cell_index` (pushing the existing cell down); use `cell_index: -1` to append a new cell at the end. For `replace`, `source` fully replaces the target cell's source; `cell_type` can switch the cell type too. For `append`, `source` is concatenated onto the END of the target cell's existing source (with a newline if needed) — much safer than `replace` when you only want to add a line without retyping the cell. Much safer than using Write/Edit on raw notebook JSON.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the .ipynb file."),
        action: z.enum(["replace", "insert", "delete", "append"]),
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
          guardPath(path);
          await guardDenied(path);
          await guardWritable(path);
          const raw = await invoke<string>("read_text_file", { path });
          const result = applyNotebookEdit(raw, action, cell_index, source, cell_type);
          if (!result.ok) return `${result.error}: ${path}`;
          await invoke("write_text_file", { path, contents: result.contents });
          return `${result.summary} in ${path}`;
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
          guardPath(path);
          await guardDenied(path);
          const text = await extractPdfText(path, pages);
          return truncate(text, PDF_CAP);
        } catch (e) {
          return `PDF extraction failed: ${(e as Error).message}`;
        }
      },
    }),

    PdfPageSnapshot: tool({
      description:
        "Capture a single PDF page as a high-resolution image and return it to YOU as vision input. Use this when text extraction alone is insufficient — diagrams, figures, formulas with non-trivial layout, tables, hand-drawn content, or anything where the visual structure matters. Prefer PdfExtract for plain-text questions; this tool costs tokens per image. One page per call.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the PDF file."),
        page: z.number().int().describe("1-based page number to capture."),
      }),
      execute: async ({ path, page }) => {
        guardPath(path);
        await guardDenied(path);
        const { dataUrl, totalPages } = await capturePageImage(path, page);
        return { dataUrl, totalPages, page, path };
      },
      // AI SDK v6 calls this with { toolCallId, input, output } — NOT the
      // raw execute return. An earlier version of this code mistook the
      // whole parameter object for `output`, so `output.dataUrl` was
      // always undefined and the regex below always fell back to the
      // "not a valid data URL" error.
      toModelOutput: ({ output }: any) => {
        if (typeof output === "string") {
          return { type: "content", value: [{ type: "text", text: output }] };
        }
        // Parse data URL strictly: capture both the mediaType and the
        // base64 payload, and bail if either is missing. Earlier versions
        // used a literal-prefix `.replace` and silently shipped the
        // original `data:image/...,...` string when the prefix didn't
        // match — Anthropic rejected that as "invalid base64 data"
        // because `:` and `/` aren't in the base64 alphabet.
        const m = String(output.dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (!m) {
          return {
            type: "content",
            value: [{ type: "text", text: `PdfPageSnapshot failed: rendered image was not a valid data URL.` }],
          };
        }
        const [, mediaType, base64] = m;
        return {
          type: "content",
          value: [
            { type: "text", text: `Page ${output.page} of ${output.totalPages} from ${output.path}:` },
            { type: "media", data: base64, mediaType },
          ],
        };
      },
    }),

    ListNotes: tool({
      description:
        "List the user's saved notes (their scratchpad) for the current vault. Each note has an id, timestamp, status (open|resolved), anchored file path(s), optional text + conversation turns, and an optional AI summary. Use when the user asks about 'my notes', 'what did I flag', 'what's in my slop', or similar. Default returns open notes; pass status='resolved' for the archive or status='all' for everything.",
      inputSchema: z.object({
        status: z.enum(["open", "resolved", "all"]).optional(),
        limit: z.number().int().optional(),
      }),
      execute: async ({ status = "open", limit = 50 }) => {
        const notes = useStore.getState().notes;
        const filtered = notes.filter((n) => status === "all" || n.status === status);
        const sliced = filtered.slice(0, limit);
        if (sliced.length === 0) return `No ${status === "all" ? "" : status + " "}notes.`;
        const lines = sliced.map((n) => {
          const primary = n.anchors.find((a) => a.primary) ?? n.anchors[0];
          const anchor = primary
            ? `${primary.source_path.split("/").pop()}${primary.source_anchor ? ` (${primary.source_anchor})` : ""}`
            : "(no anchor)";
          const body = n.formatted ?? n.user_draft ?? (n.turns[0]?.content ?? "").slice(0, 160);
          return `[${n.id}] ${n.status} · ${anchor} · ${n.timestamp.slice(0, 16)}\n  ${body.replace(/\n+/g, " ")}`;
        });
        return `${filtered.length} note${filtered.length === 1 ? "" : "s"} (showing ${sliced.length}):\n\n${lines.join("\n\n")}`;
      },
    }),

    ResolveNote: tool({
      description:
        "Mark a note as resolved. Call this when the user confirms an open note has been addressed (by the conversation, by a code change, or otherwise). The note stays in history but drops out of the default 'Active' panel view.",
      inputSchema: z.object({
        id: z.string(),
      }),
      execute: async ({ id }) => {
        const n = useStore.getState().notes.find((n) => n.id === id);
        if (!n) return `No note with id "${id}".`;
        if (n.status === "resolved") return `Note ${id} was already resolved.`;
        await useStore.getState().setNoteStatus(id, "resolved");
        return `Resolved note ${id}.`;
      },
    }),

    ReopenNote: tool({
      description: "Mark a previously resolved note as open again. Use when the user realises an issue isn't actually solved.",
      inputSchema: z.object({
        id: z.string(),
      }),
      execute: async ({ id }) => {
        const n = useStore.getState().notes.find((n) => n.id === id);
        if (!n) return `No note with id "${id}".`;
        if (n.status === "open") return `Note ${id} is already open.`;
        await useStore.getState().setNoteStatus(id, "open");
        return `Reopened note ${id}.`;
      },
    }),

    CreateNote: tool({
      description:
        "Save a new entry to the user's scratchpad — use when the user says 'remember this', 'save a note', 'add a TODO to my notes', or when you notice something worth flagging for them to come back to. Provide `text` with what they'd want to see on review. Optionally anchor to a source file with `source_path` + optional `source_anchor` (e.g. 'page=3', 'L42'). Keep notes short — these are reminders, not essays.",
      inputSchema: z.object({
        text: z.string(),
        source_path: z.string().optional(),
        source_anchor: z.string().optional(),
      }),
      execute: async ({ text, source_path, source_anchor }) => {
        const vault = useStore.getState().vaultPath;
        if (!vault) return "No vault open.";
        const anchors = source_path
          ? [
              {
                source_path,
                source_kind: "code" as const,
                source_anchor: source_anchor ?? null,
                primary: true,
              },
            ]
          : [];
        const note = buildNote({ anchors, userDraft: text });
        await useStore.getState().addNote(note);
        return `Saved note ${note.id}.`;
      },
    }),

    TodoWrite: tool({
      description:
        "Maintain a live to-do list visible to the user while you work on a multi-step task. Call this at the start of a larger task to lay out the plan, then re-call after each meaningful step to update status (pending → in_progress → completed). The user sees the list update in real time. Use for tasks with 3+ steps or when the user asked for several things. Skip for trivial one-step requests. Each item: `content` (imperative: 'Read the file'), `status`, and optional `activeForm` (present continuous: 'Reading the file') shown while in_progress. Keep to at most one in_progress at a time.",
      inputSchema: z.object({
        todos: z.array(
          z.object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z.string().optional(),
          }),
        ),
      }),
      execute: async ({ todos }) => {
        // The plan/todo block is GLOBAL ephemeral UI state (store.agentTodos),
        // shown for whichever conversation the user is currently viewing.
        // A background/off-target run (Telegram, scheduled) must not write
        // it, or its plan clobbers the foreground chat's block. Mirror the
        // streaming handlers' `live` guard: only update the global block
        // when this run IS the active conversation. The agent still gets
        // its summary string either way, so its own planning is unaffected.
        const live =
          conversationId == null ||
          useStore.getState().activeConversationId === conversationId;
        if (live) useStore.getState().setAgentTodos(todos as TodoItem[]);
        const counts = todos.reduce(
          (acc, t) => {
            acc[t.status] = (acc[t.status] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
        return `updated: ${todos.length} items (${counts.completed ?? 0} done, ${counts.in_progress ?? 0} active, ${counts.pending ?? 0} pending)`;
      },
    }),

    ListDir: tool({
      description: "List the immediate contents of a directory (non-recursive). Returns files and subdirectories.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        // Models often write a vault-relative path with a leading slash
        // ("/DeepDL") or bare ("DeepDL") when they mean "<vault>/DeepDL". Try
        // the literal path first; if that fails and the path isn't already a
        // real absolute path under the vault, retry the vault-relative reading
        // before giving up — a sloppy path shouldn't dead-end the agent.
        const candidates = [path];
        if (vault) {
          const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
          const norm = path.replace(/\\/g, "/");
          const vaultRel = `${v}/${norm.replace(/^\/+/, "")}`;
          if (vaultRel !== path && norm !== v && !norm.startsWith(v + "/")) {
            candidates.push(vaultRel);
          }
        }
        let entries: { path: string; name: string; is_dir: boolean }[] | undefined;
        let lastErr: unknown;
        for (const p of candidates) {
          try {
            guardPath(p);
            await guardDenied(p);
            entries = await invoke<{ path: string; name: string; is_dir: boolean }[]>(
              "list_dir",
              { path: p }
            );
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!entries) throw lastErr;
        // Hide denied descendants from the listing too — otherwise the
        // agent would see filenames inside a restricted folder even
        // though it can't open them.
        const denyLines = await invoke<string[]>("read_deny_lines", { vault }).catch(() => [] as string[]);
        const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
        const denyRels = denyLines.map((l) => l.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
        const isDenied = (abs: string): boolean => {
          const np = abs.replace(/\\/g, "/").replace(/\/+$/, "");
          if (!np.startsWith(nv + "/") && np !== nv) return false;
          const rel = np === nv ? "" : np.slice(nv.length + 1);
          return denyRels.some((e) => rel === e || rel.startsWith(e + "/"));
        };
        const kept = entries.filter((e) => !isDenied(e.path));
        return truncate(
          kept.map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}`).join("\n"),
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

  if (bashDisabled) {
    delete (base as Partial<typeof base>).Bash;
  }

  // Only WebSearch needs the Tavily key. The git/conversation/schedule
  // tools below are always available, so headless coach and monitoring
  // runs can read git evidence and chat history without a key configured.
  const full = {
    ...base,
    ...(tavilyKey
      ? {
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
        }
      : {}),
    GitLog: tool({
      description:
        "Read recent git history from a repo inside the vault — including nested work repos like `DeepDL/bitnet-repro`, `DeepDL/torchtitan`, or `Blog/...`. Always available (unlike Bash). Use it to gauge real momentum from objective evidence: what was committed, when, and by whom. Returns oneline `<short-hash> <subject>` rows. Note the vault root is mostly autosave commits — the real work lives in the nested repos, so target those.",
      inputSchema: z.object({
        subdir: z
          .string()
          .describe(
            "Vault-relative path to the repo, e.g. 'DeepDL/bitnet-repro'. Use '' or '.' for the vault root.",
          ),
        since: z
          .string()
          .optional()
          .describe("Only commits newer than this, e.g. '10 days ago' or '2026-06-01'."),
        author: z
          .string()
          .optional()
          .describe("Filter to commits whose author matches this substring."),
        max_count: z
          .number()
          .int()
          .optional()
          .describe("Max commits to return. Default 40, max 500."),
      }),
      execute: async ({ subdir, since, author, max_count }) => {
        const { gitLogSubdir } = await import("./git");
        const out = await gitLogSubdir(vault, subdir ?? ".", {
          since,
          author,
          maxCount: max_count,
        });
        return out.trim() === "" ? "(no commits match)" : out;
      },
    }),
    ListConversations: tool({
      description:
        "List the other chats in this vault — useful for finding a specific conversation to peek into (see ReadConversation). Returns id, title, source, status (idle/running), unread, last activity time, and message count for each. Excludes the current chat.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max number of conversations to return, sorted by recency. Default 20."),
      }),
      execute: async ({ limit }) => {
        const cap = Math.max(1, Math.min(100, limit ?? 20));
        const { readConversations } = await import("./conversations");
        const list = await readConversations(vault);
        const filtered = list
          .filter((c) => c.id !== conversationId)
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
          .slice(0, cap);
        if (filtered.length === 0) return "(no other conversations)";
        const fmt = (ts: number) => {
          const diff = Date.now() - ts;
          const min = Math.floor(diff / 60_000);
          if (min < 60) return `${Math.max(0, min)}m ago`;
          const hr = Math.floor(min / 60);
          if (hr < 24) return `${hr}h ago`;
          return `${Math.floor(hr / 24)}d ago`;
        };
        return filtered
          .map((c) =>
            JSON.stringify({
              id: c.id,
              title: c.title || "(untitled)",
              source: c.source,
              status: c.status,
              unread: !!c.unread,
              messageCount: c.messages.length,
              lastActivity: fmt(c.lastActivityAt),
            }),
          )
          .join("\n");
      },
    }),
    ReadConversation: tool({
      description:
        "Read the recent history of another chat in this vault, including the most recent tool calls. Use when the user asks 'how is the X chat doing', 'what's the deep-dive chat working on', or similar monitoring questions. Pair with ListConversations to find the id. Returns the last N messages with role, content (truncated), and any tool-call summaries.",
      inputSchema: z.object({
        conversation_id: z.string().describe("Conversation id from ListConversations."),
        last_n: z
          .number()
          .int()
          .optional()
          .describe("How many recent messages to return. Default 12, max 50."),
      }),
      execute: async ({ conversation_id, last_n }) => {
        const cap = Math.max(1, Math.min(50, last_n ?? 12));
        const { readConversations } = await import("./conversations");
        const list = await readConversations(vault);
        const conv = list.find((c) => c.id === conversation_id);
        if (!conv) return `Conversation not found: ${conversation_id}`;
        const tail = conv.messages.slice(-cap);
        const lines: string[] = [
          `# ${conv.title || "(untitled)"} [${conv.status}]`,
          `source: ${conv.source} · ${conv.messages.length} total messages`,
          ...tail.map((m) => {
            const content = (m.content ?? "").slice(0, 800);
            const tools =
              m.toolCalls && m.toolCalls.length > 0
                ? `\n  tools: ${m.toolCalls
                    .map((t) => `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 80)})`)
                    .join(", ")}`
                : "";
            return `[${m.role}${m.hidden ? " hidden" : ""}] ${content}${content.length === 800 ? "…" : ""}${tools}`;
          }),
        ];
        return lines.join("\n\n");
      },
    }),
    AskWorker: tool({
      description:
        "Relay a message to ANOTHER thread in this vault and get its reply back — a long-running WORKER, or a MISSION's SUPERVISOR. Use this to ask a supervisor something for the user (\"what's the status of the BitNet mission?\", \"tell it to deprioritize seed 3\") and report its answer, or to hand a worker an instruction. Find the thread's id with ListConversations (a mission is source 'mission'). NOTE: on an idle thread this runs a FULL model turn and blocks until it answers — so for a plain status/progress check, prefer ReadConversation (its thread tells you what it did) and the heartbeat; reserve this for steering, correcting, or genuinely asking it something. By default it does NOT interrupt a busy thread: if it's mid-run you'll get its current status instead of forcing an answer. Set interrupt=true to abort its current turn and make it act on your message NOW. Returns the thread's reply, or its status when busy and not interrupted.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .describe("The worker conversation id (from ListConversations)."),
        message: z
          .string()
          .describe("What to say to the worker — phrase it as you'd speak to that agent."),
        interrupt: z
          .boolean()
          .optional()
          .describe(
            "If true, abort the worker's current turn and make it handle your message now. Default false — don't disrupt a busy worker.",
          ),
      }),
      execute: async ({ conversation_id, message, interrupt }) => {
        if (conversationId && conversation_id === conversationId) {
          return "Refused: that id is THIS conversation. AskWorker targets a different thread.";
        }
        const { readConversations } = await import("./conversations");
        const list = await readConversations(vault);
        const conv = list.find((c) => c.id === conversation_id);
        if (!conv) return `Worker thread not found: ${conversation_id}`;
        const busy = conv.status === "running";
        if (busy && !interrupt) {
          const tail = conv.messages
            .slice(-6)
            .map((m) => `[${m.role}] ${(m.content ?? "").slice(0, 400)}`)
            .join("\n");
          return `Worker "${conv.title || conversation_id}" is BUSY (mid-run) — not interrupted. Recent activity:\n${tail}\n\n(To make it act on your message now, call again with interrupt=true.)`;
        }
        if (busy && interrupt) {
          const { abortRun } = await import("./runRegistry");
          abortRun(conversation_id);
          await new Promise((r) => setTimeout(r, 600)); // let the abort unwind
        }
        const { runWorkerTurn } = await import("./offVaultRun");
        // Don't let a long/stuck worker hold the caller hostage. The user watched
        // a supervisor block on AskWorker for ~2 hours waiting on a worker that
        // wasn't answering. Time-box the wait: on timeout we do NOT abort the
        // worker (its turn keeps running in the background) — we stop waiting and
        // report back so the caller's turn can END and it can check in later via
        // the worker's finish-wake or ReadConversation.
        const ASK_TIMEOUT_MS = 3 * 60_000;
        const runP = runWorkerTurn(vault, conversation_id, message, {});
        const outcome = await Promise.race([
          runP.then((r) => ({ timedOut: false as const, ...r })),
          new Promise<{ timedOut: true }>((res) =>
            setTimeout(() => res({ timedOut: true }), ASK_TIMEOUT_MS),
          ),
        ]);
        if (outcome.timedOut) {
          runP.catch(() => {}); // keeps running in the background; swallow late rejection
          return `Worker "${conv.title || conversation_id}" is still working after 3 min — it keeps running in the background. Don't block on it: end your turn now. You'll be woken when it finishes, or check it with ReadConversation (id ${conversation_id}).`;
        }
        const { reply, error } = outcome;
        if (error && !reply.trim()) return `Worker run failed: ${error}`;
        return `Worker "${conv.title || conversation_id}" replied:\n${reply}`;
      },
    }),
    StopMission: tool({
      description:
        "STOP and clear a mission the user asks you to end. Full teardown: aborts its supervisor and every worker on it, cancels their scheduled wakes, and removes the mission from the user's Activity board — not a pause. Find the mission's id with ListConversations (source 'mission'). Use when the user says to kill/stop/cancel/scrap a mission. To merely PAUSE or redirect it, don't use this — relay to its supervisor with AskWorker instead.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .describe("The mission's conversation id (source 'mission', from ListConversations)."),
      }),
      execute: async ({ conversation_id }) => {
        const { readConversations } = await import("./conversations");
        const list = await readConversations(vault);
        const conv = list.find((c) => c.id === conversation_id);
        if (!conv) return `Mission thread not found: ${conversation_id}`;
        if (conv.source !== "mission")
          return `That thread isn't a mission (source: ${conv.source ?? "?"}). StopMission only stops missions; for a worker, steer its supervisor instead.`;
        const { stopAndDeleteMission } = await import("./offVaultRun");
        await stopAndDeleteMission(vault, conversation_id);
        return `Mission "${conv.mission || conv.title || conversation_id}" stopped and cleared — its supervisor and all its workers are aborted and removed from Activity.`;
      },
    }),
    StartWorker: tool({
      description:
        "Spawn a NEW worker (a subagent) for YOUR mission and kick its task off in the background. Only mission threads hold this tool: you spawn however many workers the goal needs — in parallel or in sequence — and spawn MORE later when monitoring teaches you something new. Returns the new worker's conversation id + title; afterward you watch it (heartbeat / ReadConversation) and steer it (AskWorker). The worker starts FRESH with no other context, so make the task self-contained. Don't use this for quick things you can just do yourself in this turn.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "The full, self-contained task for the worker — be specific; it starts with no other context.",
          ),
        title: z
          .string()
          .optional()
          .describe("Short title for the worker chat. Defaults to a slug of the task."),
        mission: z
          .string()
          .optional()
          .describe(
            "The North Star this worker serves — the short name of the user-approved goal (e.g. the plan title, or the goal slug). EVERY worker belongs to a mission. If THIS chat is itself a mission thread, omit it — the worker joins your mission automatically. Otherwise it's required; workers for the same goal share the same mission string so Activity groups them.",
          ),
      }),
      execute: async ({ task, title, mission }) => {
        // Workers are never standalone: a mission thread's workers inherit its
        // mission automatically; any other caller must name one.
        let effectiveMission = mission?.trim() || "";
        if (!effectiveMission && conversationId) {
          const caller = useStore
            .getState()
            .conversations.find((c) => c.id === conversationId);
          effectiveMission = caller?.mission?.trim() || "";
        }
        if (!effectiveMission) {
          return "Refused: every worker belongs to a mission. You're inside one, so this should inherit automatically — pass `mission` (this goal's short name) if it didn't. Workers only ever run under a mission; nothing spawns them standalone.";
        }
        const { startWorker } = await import("./offVaultRun");
        const { id, title: t } = await startWorker(vault, task, title, undefined, effectiveMission);
        return `Spawned worker "${t}" (id ${id}) under mission "${effectiveMission}" — it's running the task in the background. It runs independently; keep talking to the user. Check on it with ReadConversation (id ${id}) or the run heartbeat, and relay to it with AskWorker.`;
      },
    }),
    CompleteMission: tool({
      description:
        "Mark THIS mission FINISHED — call it once the goal's 'Done when' criteria are all met. It stamps the mission complete so it drops off the user's Activity page (a finished mission shouldn't linger there), stops any leftover workers, and sends the user a final wrap-up via the summary you pass. Only call it when the work is genuinely DONE — not to pause, abandon, or hand back. After calling it, end your turn: the mission is over.",
      inputSchema: z.object({
        summary: z
          .string()
          .describe(
            "The final wrap-up for the user: what was accomplished and where the deliverables live. One short, headline-worthy paragraph.",
          ),
      }),
      execute: async ({ summary }) => {
        if (!conversationId) return "No mission context — can't complete.";
        // completeMission atomically stamps completedAt and returns true only on
        // the call that actually retired the mission — so the "Mission complete"
        // notification fires exactly once, even if this tool is called twice
        // (parallel calls, or a follow-up turn re-confirming done).
        const { completeMission } = await import("./offVaultRun");
        const didComplete = await completeMission(vault, conversationId).catch((e) => {
          console.warn("[mission] complete failed:", e);
          return false;
        });
        if (!didComplete) {
          return "This mission is already complete — nothing more to do. End your turn.";
        }
        const { notify } = await import("./phoneApp");
        await notify("info", "Mission complete", summary, conversationId, {
          intention: "Mission complete",
          summary: summary.slice(0, 200),
          icon: "✓",
          cls: "g",
        });
        return "Mission marked complete, the user notified, and it's cleared from Activity. End your turn — the mission is done.";
      },
    }),
    MarkDoneWhen: tool({
      description:
        "Check off ONE of this mission's 'Done when' criteria — call it the moment you've VERIFIED that specific criterion is met (by the success test / on disk, not on a worker's word). The bullet turns green in the user's mission spec, so they watch progress accrue one criterion at a time. Pass the criterion as it reads in the brief (a close paraphrase is fine — it's fuzzy-matched). Mark each as you confirm it; this is NOT completing the mission (use CompleteMission only once every criterion is done). Mission-tier only.",
      inputSchema: z.object({
        criterion: z
          .string()
          .describe("The 'Done when' item you've just verified, roughly as it reads in the brief."),
      }),
      execute: async ({ criterion }) => {
        if (!conversationId) return "No mission context — can't mark a criterion.";
        const { markDoneWhen } = await import("./offVaultRun");
        const matched = await markDoneWhen(vault, conversationId, criterion).catch(() => null);
        return matched
          ? `Checked off "${matched}" — the user sees that criterion go green.`
          : `Recorded "${criterion}". Couldn't match it to a listed criterion, but noted it.`;
      },
    }),
    ProposeMission: tool({
      description:
        "Propose a mission to the user as an Approve card — the ONLY way you (the assistant) put real work in motion. Call this for any substantial ask instead of grinding it in this chat. A mission is a briefly-stated GOAL plus the sub-results that DEFINE IT DONE. It does NOT start anything: it renders a card the user taps to approve, and approval mints the mission deterministically. You can't start a mission or spawn workers — proposing is your job; running is the mission's. After calling it, tell the user it's ready to approve and stay conversational — do NOT claim you started anything.",
      inputSchema: z.object({
        title: z
          .string()
          .describe("The mission, briefly stated — the goal in a short phrase. Heads the card and groups its workers in Activity. e.g. 'Fix BitNet gamma-scale and rerun the A/B'."),
        tasks: z
          .array(z.string())
          .min(1)
          .describe(
            "The sub-components that define the mission DONE — each a concrete sub-result, not a vague aim. Together they ARE the success criterion. Each is likely to become its own worker, but you're describing what 'complete' means, not assigning workers — the supervisor decides how to break the work down (it may merge or split). Prefer 2-4; each should be checkable.",
          ),
      }),
      execute: async ({ title, tasks }) => {
        // The card itself is rendered client-side from this call (chat-controller
        // injects the canonical plan block into the cockpit reply). Here we only
        // confirm back to the model so it doesn't re-propose or claim it started.
        const n = Array.isArray(tasks) ? tasks.length : 0;
        return `Proposed mission "${title}" — ${n} done-when component${n === 1 ? "" : "s"}, shown to the user as an Approve card. Nothing has started: if they approve, the mission is created and runs itself. Don't repeat the proposal or start work yourself; tell them it's ready to approve and stay conversational.`;
      },
    }),
    Notify: tool({
      description:
        "Proactively surface something to the user on their phone — it lands as a card in the Alerts feed AND as a push notification. Use it to tell them, without being asked, about something worth their attention: a mission or worker you finished, an action you took on your own (e.g. 'stopped an idle box'), a heads-up they'd want. This is ONE-WAY — it informs, it doesn't ask. For a decision you need back from them, use AskUser. Keep `title` to a short headline and `body` to one or two sentences (the essential update — depth goes to a file you point at). Don't notify for trivial chatter or for replies in a chat the user is actively having with you; reserve it for things that earn an interruption.",
      inputSchema: z.object({
        title: z.string().describe("Short headline, e.g. 'Shakedown run complete'."),
        body: z
          .string()
          .describe("One or two sentences — the essential update. Point to a vault file for the depth."),
      }),
      execute: async ({ title, body }) => {
        const { notify } = await import("./phoneApp");
        await notify("info", title, body, conversationId);
        return "Sent to the user's Alerts feed (and a push if enabled).";
      },
    }),
    AskUser: tool({
      description:
        "Surface a decision you need from the user as a 'Needs you' card on their phone (plus a push). They answer in their OWN words — no fixed options — and their reply comes back as the next message in THIS conversation. So the pattern is: call AskUser, then END YOUR TURN and wait; you'll be re-run with their answer. Use it ONLY at a real fork you shouldn't settle alone — a scope or design choice, a spend approval, a genuinely ambiguous result, or to get a freshly-scoped mission approved before you build the team. Do NOT use it for things you can reasonably decide yourself; the whole point of the system is to keep the user out of the loop except where their judgment is the input.",
      inputSchema: z.object({
        about: z
          .string()
          .describe("Short title for the card, e.g. 'Seed 3 diverged' or 'Approve mission?'."),
        question: z
          .string()
          .describe(
            "The decision, stated tightly with the context/options they need — e.g. 'step 800, +0.05 nat above seed 1. real effect, or match the LR and rerun?'",
          ),
      }),
      execute: async ({ about, question }) => {
        const { notify } = await import("./phoneApp");
        await notify("ask", about || "Needs your call", question, conversationId);
        return "Asked the user — their reply will arrive as the next message in this conversation. End your turn now and wait for it; do not guess the answer.";
      },
    }),
    ListSchedules: tool({
      description:
        "List the scheduled prompts in this vault. Use to find a schedule's id before cancelling it, or to remind the user what they have set up. Returns id, name, prompt (truncated), recurrence, next-fire time, target conversation, and enabled state.",
      inputSchema: z.object({}),
      execute: async () => {
        const { readSchedules, nextFireAt, recurrenceLabel } = await import("./schedules");
        const list = await readSchedules(vault);
        if (list.length === 0) return "(no schedules set)";
        return list
          .map((s) => {
            const next = nextFireAt(s);
            return JSON.stringify({
              id: s.id,
              name: s.name || "(unnamed)",
              prompt: s.prompt.slice(0, 200),
              recurrence: recurrenceLabel(s.recurrence),
              time: s.time,
              date: s.date,
              nextFire: next ? new Date(next).toLocaleString() : "(none)",
              target:
                s.target.kind === "existing"
                  ? `chat:${s.target.conversationId}`
                  : "new chat",
              enabled: s.enabled,
            });
          })
          .join("\n");
      },
    }),
    CancelSchedule: tool({
      description:
        "Delete a schedule by id. Use when the user asks to cancel a reminder, stop a recurring brief, or undo a duplicate. Pair with ListSchedules to find the id. To temporarily pause without deleting, set enabled=false instead via UpdateSchedule (not implemented — for now CancelSchedule is the only option).",
      inputSchema: z.object({
        schedule_id: z.string().describe("The schedule id, from ListSchedules."),
      }),
      execute: async ({ schedule_id }) => {
        const { readSchedules } = await import("./schedules");
        const { deleteSchedule } = await import("./schedulerLoop");
        const list = await readSchedules(vault);
        const target = list.find((s) => s.id === schedule_id);
        if (!target) return `No schedule with id ${schedule_id}.`;
        // Route through deleteSchedule so the deletion tombstone
        // (schedules-deleted.jsonl) is written BEFORE the row is rewritten out.
        // schedules.jsonl is merge=union, so omitting the row without a tombstone
        // resurrects the schedule on the next multi-machine sync (the "cancelled
        // watchdog keeps firing after a wake" bug). It also keeps the live
        // scheduler loop's in-memory list and the Schedules panel in sync.
        await deleteSchedule(vault, schedule_id);
        return `Cancelled: ${target.name || target.prompt.slice(0, 60)}`;
      },
    }),
    Schedule: tool({
      description:
        "Schedule a prompt to fire at a future time, either once or recurring. The prompt runs as a new turn in the *current* conversation when it fires, and its result is surfaced in the user's Alerts feed (with a push notification). Use for reminders ('remind me at 9pm'), recurring briefs ('daily news at 8am'), or polling tasks ('check X every hour'). Exactly one of `when_iso`, `daily_at`, `weekdays_at`, or `every_minutes` must be set — that choice picks the recurrence. The schedule fires while vault-chat is running with this vault available; if the app is closed at fire time, the schedule fires on the next launch when the vault is loaded.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "The text that will be sent as the user's turn each time it fires. Phrase it as what you want the agent to do at fire time. Example for a daily brief: 'Give me the top 5 news stories of the day with one sentence analysis each.'",
          ),
        description: z
          .string()
          .optional()
          .describe("Short label shown in the Schedules panel."),
        when_iso: z
          .string()
          .optional()
          .describe(
            "ONE-TIME fire. ISO 8601 local datetime e.g. '2026-05-29T21:30'. Compute from the current time.",
          ),
        daily_at: z
          .string()
          .optional()
          .describe("DAILY fire. Time of day in 'HH:MM' 24h format, e.g. '08:00'."),
        weekdays_at: z
          .string()
          .optional()
          .describe("WEEKDAYS-ONLY fire (Mon-Fri). Time in 'HH:MM' 24h format."),
        every_minutes: z
          .number()
          .int()
          .optional()
          .describe(
            "EVERY-N-MINUTES fire. Integer minutes between fires, minimum 5. Use sparingly — at 60 you're calling the model 24 times a day; cheaper models / shorter prompts help. Warn the user about cost if they ask for something <30 minutes.",
          ),
      }),
      execute: async ({
        prompt,
        description,
        when_iso,
        daily_at,
        weekdays_at,
        every_minutes,
      }) => {
        if (!conversationId) {
          return "Schedule tool unavailable: no current conversation id.";
        }
        const recurrenceOptions = [
          when_iso ? "when_iso" : null,
          daily_at ? "daily_at" : null,
          weekdays_at ? "weekdays_at" : null,
          every_minutes ? "every_minutes" : null,
        ].filter(Boolean);
        if (recurrenceOptions.length === 0) {
          return "Set exactly one of when_iso, daily_at, weekdays_at, or every_minutes.";
        }
        if (recurrenceOptions.length > 1) {
          return `Set exactly one recurrence option (got ${recurrenceOptions.join(", ")}).`;
        }

        let recurrence: import("./schedules").Recurrence;
        let time = "08:00";
        let date: string | undefined;
        let fireDescription: string;

        if (when_iso) {
          const dt = new Date(when_iso);
          if (isNaN(dt.getTime())) {
            return `Invalid datetime '${when_iso}'. Use ISO local format like 2026-05-29T21:30.`;
          }
          if (dt.getTime() <= Date.now()) {
            return `Refusing to schedule in the past (${when_iso}). Pick a future time.`;
          }
          recurrence = { kind: "once" };
          date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
          time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
          fireDescription = `once at ${dt.toLocaleString()}`;
        } else if (daily_at) {
          if (!/^\d{1,2}:\d{2}$/.test(daily_at)) {
            return `Invalid daily_at '${daily_at}'. Use 'HH:MM' 24h format like 08:00.`;
          }
          recurrence = { kind: "daily" };
          time = daily_at.padStart(5, "0");
          fireDescription = `daily at ${time}`;
        } else if (weekdays_at) {
          if (!/^\d{1,2}:\d{2}$/.test(weekdays_at)) {
            return `Invalid weekdays_at '${weekdays_at}'. Use 'HH:MM' 24h format like 08:00.`;
          }
          recurrence = { kind: "weekdays" };
          time = weekdays_at.padStart(5, "0");
          fireDescription = `weekdays at ${time}`;
        } else {
          const n = every_minutes!;
          if (n < 5) {
            return `every_minutes minimum is 5 (got ${n}). Anything finer is just burning API calls.`;
          }
          recurrence = { kind: "every", minutes: n };
          fireDescription = `every ${n} minutes`;
        }

        const { readSchedules, writeSchedules, emptySchedule } = await import("./schedules");
        const { useStore } = await import("./store");
        const store = useStore.getState();
        const list = await readSchedules(vault);
        // Idempotency: an identical enabled wake already on the books (same thread,
        // prompt, cadence, time) returns it instead of stacking a duplicate — so a
        // supervisor that re-issues the same self-check doesn't end up firing twice.
        const dupSched = list.find(
          (s) =>
            s.enabled &&
            s.target.kind === "existing" &&
            s.target.conversationId === conversationId &&
            s.prompt === prompt &&
            s.time === time &&
            (s.date || "") === (date || "") &&
            JSON.stringify(s.recurrence) === JSON.stringify(recurrence),
        );
        if (dupSched) return `Already scheduled (${fireDescription}) in this conversation — not duplicating it.`;
        const fresh = {
          ...emptySchedule(store.modelId),
          name: description ?? prompt.split(/\s+/).slice(0, 6).join(" "),
          prompt,
          recurrence,
          time,
          date,
          target: { kind: "existing" as const, conversationId },
          enabled: true,
          markUnreadOnFinish: true,
        };
        await writeSchedules(vault, [...list, fresh]);
        return `Scheduled ${fireDescription}. Will fire as a turn in this conversation; its result lands in the Alerts feed.`;
      },
    }),
    WatchRun: tool({
      description:
        "Hand a LONG-RUNNING EXTERNAL job (a training run on rented GPU, a batch eval, an overnight sweep — anything that outlives this turn) to the run-watcher so it's polled deterministically, even after your turn ends and across app restarts. YOU launch the job first, detached (e.g. `ssh box 'cd run && nohup python train.py >train.log 2>&1 &'`), THEN call this with a `check_command` the watcher runs on a timer to learn the job's state. The watcher pings the user and wakes THIS thread the moment the job finishes, fails, or stalls — so no one has to remember to check back, and a dead run never sits silent. Don't use this for a quick command you can just run now; it's for jobs measured in hours/days.",
      inputSchema: z.object({
        title: z
          .string()
          .describe("Short human label for the run, e.g. 'BitNet 160M seed 3'. Heads the alert card."),
        check_command: z
          .string()
          .describe(
            "Shell command the watcher runs on a timer to learn the job's state. It MUST print a status token as its FIRST word — RUNNING, DONE, or FAILED — followed while RUNNING by a CHANGING progress metric (e.g. `RUNNING step 12000 loss 2.31`, pulling the LATEST step/loss each check). The token is liveness; the metric after it is progress — and stall detection watches the metric, so a check that prints a bare constant `RUNNING` with no changing number gets flagged STALLED even while the job is advancing fine. Typically an ssh into the rented box that tails the log for the latest step / inspects the process / checks a sentinel file. If the command itself can't run (host unreachable) several times running, the watcher flags the run STALLED on its own.",
          ),
        pull_command: z
          .string()
          .optional()
          .describe(
            "Optional shell command run EVERY cycle to copy artifacts off the remote box (e.g. `rsync -az box:run/ ./runs/seed3/`). Protects results against spot reclaim — at most one cadence of progress is ever at risk. Also run once more on completion.",
          ),
        cadence_minutes: z
          .number()
          .int()
          .optional()
          .describe("How often to check, in minutes. Default 10."),
        stall_minutes: z
          .number()
          .int()
          .optional()
          .describe(
            "If the progress note doesn't change for this long while still RUNNING, flag the run STALLED (catches a hung/wedged job). Default 45.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the check/pull commands. Defaults to the vault root."),
        host: z.string().optional().describe("Informational label for which rented box this run is on."),
      }),
      execute: async ({ title, check_command, pull_command, cadence_minutes, stall_minutes, cwd, host }) => {
        const { registerJob } = await import("./runWatcher");
        // Best-effort: tag the job with the mission it belongs to, for the alert.
        let mission: string | undefined;
        try {
          const { readConversations } = await import("./conversations");
          const conv = (await readConversations(vault)).find((c) => c.id === conversationId);
          mission = (conv?.mission ?? (conv?.source === "mission" ? conv.title : undefined)) || undefined;
        } catch {
          // no grouping — fine
        }
        const job = await registerJob(vault, {
          title,
          ownerConvId: conversationId ?? "",
          checkCmd: check_command,
          pullCmd: pull_command,
          cwd: cwd || undefined,
          host: host || undefined,
          mission,
          cadenceMs: Math.max(1, cadence_minutes ?? 10) * 60_000,
          stallMs: Math.max(1, stall_minutes ?? 45) * 60_000,
        });
        const everyM = Math.round(job.cadenceMs / 60_000);
        return (
          `Watching run "${title}" (id ${job.id}) — checking every ${everyM}m via your check_command. ` +
          `I'll ping the user and wake this thread the moment it finishes, fails, or stalls` +
          `${job.pullCmd ? "; artifacts sync off the box each cycle" : ""}. ` +
          `Nothing else to do here — end your turn and keep working; the watcher carries it.`
        );
      },
    }),
    ListRuns: tool({
      description:
        "List the long external jobs the run-watcher is tracking (training runs, batch evals) with their LIVE status — running / done / failed / stalled — last progress note, and when each was last checked. Use to answer the user's 'what's still running', 'did any runs die overnight', 'how far along is seed 3'. Read-only; this is how you report on background runs without the user opening anything. As a worker you see only the runs YOU started — use it to find the id of a watcher you registered so you can CancelRun a bad one and re-register a corrected watcher (self-healing).",
      inputSchema: z.object({}),
      execute: async () => {
        const { readJobs } = await import("./runWatcher");
        const all = await readJobs(vault);
        // A worker sees only the runs IT registered (its own thread), so it can
        // find the id of a watcher it set up and CancelRun it — self-healing a
        // bad watcher — without surveying other threads' runs.
        const list =
          tier === "worker" ? all.filter((j) => j.ownerConvId === conversationId) : all;
        if (list.length === 0) return "(no watched runs)";
        const ago = (ts?: number) =>
          ts ? `${Math.max(0, Math.round((Date.now() - ts) / 60_000))}m ago` : "not yet";
        return list
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((j) =>
            JSON.stringify({
              id: j.id,
              title: j.title,
              status: j.status,
              mission: j.mission,
              host: j.host,
              lastProgress: j.lastProgress,
              reason: j.status === "failed" || j.status === "stalled" ? j.terminalReason : undefined,
              lastChecked: ago(j.lastCheckedAt),
              started: ago(j.startedAt),
            }),
          )
          .join("\n");
      },
    }),
    CancelRun: tool({
      description:
        "Stop watching a run, and optionally KILL it. Use when a run is finished-and-handled, was a mistake, or you're tearing down the rented box to stop billing. Pass kill_command to actually stop the remote process (e.g. `ssh box 'pkill -f train.py'`); omit it to just stop watching. Find the id with ListRuns.",
      inputSchema: z.object({
        id: z.string().describe("The run id from ListRuns."),
        kill_command: z
          .string()
          .optional()
          .describe("Optional shell command to stop the remote job before un-watching it."),
      }),
      execute: async ({ id, kill_command }) => {
        const { readJobs, removeJob } = await import("./runWatcher");
        const job = (await readJobs(vault)).find((j) => j.id === id);
        if (!job) return `No watched run with id ${id} (see ListRuns).`;
        if (kill_command) {
          await invoke("bash_exec", {
            command: kill_command,
            cwd: job.cwd || vault,
            timeoutMs: 60_000,
            cancelId: `runkill_${id}_${Date.now().toString(36)}`,
          }).catch(() => {});
        }
        await removeJob(vault, id);
        return `Stopped watching run "${job.title}" (id ${id})${kill_command ? " and ran the kill command" : ""}.`;
      },
    }),
  };

  // Enforce the layers in the toolset itself — prompt discipline is a
  // suggestion; a missing tool is a guarantee. No agent can START a mission:
  // the assistant PROPOSES (ProposeMission → an Approve card) and the user's
  // approval mints it deterministically (Approve → startMission in code), so a
  // mission only ever exists because the user said so.
  //   assistant — has ProposeMission; can ask a worker/supervisor (AskWorker) and
  //               STOP a mission for the user (StopMission); can't spawn a worker
  //               or complete a mission. This is the user's main interface: they
  //               mostly talk to the assistant, which relays to and tears down
  //               missions on their behalf.
  //   mission   — spawns/steers ITS workers (StartWorker) and decides when the
  //               goal is met (CompleteMission); can't propose or StopMission (it
  //               ends itself via CompleteMission, not by killing missions).
  //   worker    — does the task, nothing else. No orchestration, and no direct
  //               line to the user (Notify/AskUser): a worker reports by ENDING
  //               its turn with a clear report — its mission is woken with the
  //               result and decides what reaches the user.
  // CompleteMission belongs ONLY to the mission tier: the supervisor is the one
  // that decides the goal is done, so it's the one that retires the mission.
  const drop = (names: string[]) => {
    for (const n of names) delete (full as Record<string, unknown>)[n];
  };
  // Run-watcher tools: a mission (supervisor) gets all three over the whole
  // fleet — it launches, monitors, and tears down long jobs. A worker can
  // launch+watch, list ITS OWN runs, and cancel them — enough to self-heal a
  // watcher it registered (find the id, CancelRun the bad one, re-register a
  // fixed one) without surveying other threads' runs. The assistant only READS
  // the fleet (ListRuns) so it can answer "what's running / did anything die"
  // for the user; it doesn't launch or kill runs itself.
  if (tier === "mission") drop(["ProposeMission", "StopMission"]);
  else if (tier === "worker")
    drop(["StartWorker", "AskWorker", "Notify", "AskUser", "ProposeMission", "CompleteMission", "MarkDoneWhen", "StopMission"]);
  else drop(["StartWorker", "CompleteMission", "MarkDoneWhen", "WatchRun", "CancelRun"]);
  return full;
}

export type ToolName = keyof ReturnType<typeof buildTools>;
