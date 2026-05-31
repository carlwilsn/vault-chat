import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";
import { tool } from "ai";
import { z } from "zod";
import { getUserKeysAsEnv } from "./keychain";

export type MetaInit = { path: string; fresh: boolean };

let cachedPath: string | null = null;

export async function initMetaVault(): Promise<MetaInit> {
  const res = await invoke<MetaInit>("meta_vault_init");
  cachedPath = res.path;
  return res;
}

export async function getMetaVaultPath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const p = await invoke<string>("meta_vault_path");
  cachedPath = p;
  return p;
}

/** Read the system prompt from the meta vault. Falls back to an empty
 *  string if the file is missing (caller is expected to have a
 *  baseline compiled-in prompt to concatenate with). */
export async function loadMetaSystemPrompt(): Promise<string> {
  try {
    const p = await getMetaVaultPath();
    return await invoke<string>("read_text_file", { path: `${p}/system.md` });
  } catch {
    return "";
  }
}

/** Read the per-vault north-star brief (the user's declaration of
 *  what the vault is for). Stored at <vault>/.vault-chat/north-star.md.
 *  Prepended to every agent system prompt (chat, voice, inline) so the
 *  agent enters every turn pre-briefed on the vault's purpose. Returns
 *  "" when the file is missing or no vault is open. */
export async function loadVaultNorthStar(vault: string | null): Promise<string> {
  if (!vault) return "";
  try {
    return await invoke<string>("read_text_file", {
      path: `${vault}/.vault-chat/north-star.md`,
    });
  } catch {
    return "";
  }
}

export async function saveVaultNorthStar(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/.vault-chat/north-star.md`,
    contents,
  });
}

function formatNorthStarBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `## Vault north star\n\nThe user has declared this brief for the vault you're working in. Treat it as load-bearing — it tells you what kind of help the user wants here (tutor / co-engineer / from-scratch / etc.). When the brief conflicts with your default behavior, the brief wins.\n\nThe brief lives at \`<vault>/.vault-chat/north-star.md\`. If the user asks you to update, append to, or revise it, edit that file directly with the Edit or Write tool — the modal in the titlebar reads from the same place and will reflect your changes when reopened.\n\n${trimmed}`;
}

export function northStarPromptBlock(text: string): string {
  return formatNorthStarBlock(text);
}

/** Read the per-vault memory index. The agent keeps a file-based memory
 *  at <vault>/.vault-chat/memory/ — one fact per markdown file, with an
 *  MEMORY.md index (one line per fact). Only the index is loaded into
 *  the system prompt each session; the agent reads individual fact files
 *  on demand with the Read tool and writes/updates them with Write/Edit.
 *  This keeps the prompt small as the memory grows. Returns "" when no
 *  memory has been written yet (or no vault is open). */
export async function loadVaultMemoryIndex(vault: string | null): Promise<string> {
  if (!vault) return "";
  try {
    return await invoke<string>("read_text_file", {
      path: `${vault}/.vault-chat/memory/MEMORY.md`,
    });
  } catch {
    return "";
  }
}

export function vaultMemoryPromptBlock(index: string): string {
  const dir = "<vault>/.vault-chat/memory/";
  const trimmed = index.trim();
  const indexSection = trimmed
    ? `Your current memory index (one line per stored fact):\n\n${trimmed}\n\nTo recall a fact in full, Read its file. To revise one, Edit it; if it turns out to be wrong, Delete the file and remove its index line. Keep \`MEMORY.md\` in sync with the files — it is what loads next session.`
    : `You have no stored memories for this vault yet. The directory may not exist; the Write tool creates it on first save.`;

  return `## Vault memory

You keep a persistent, file-based memory scoped to this vault at \`${dir}\`, the way Claude Code keeps memory for itself. It survives across sessions and travels with the vault in git. Use your existing Read / Write / Edit / Glob tools — there are no special memory tools.

Each memory is ONE markdown file holding ONE fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: project | reference | preference | fact
---

<the fact, stated plainly. Link related memories with [[their-name]].>
\`\`\`

\`${dir}MEMORY.md\` is the index loaded into your context each session — one line per memory (\`- [Title](file.md) — hook\`), no frontmatter, never put fact content there. After writing or changing a fact file, update the index line.

**Save** durable facts about THIS vault that you'd want at the start of a future session and can't cheaply re-derive: how the project is organized beyond what's obvious from the files, decisions and their rationale, the user's stated preferences for working in this vault, external references (URLs, IDs). Before saving, check the index for an existing file that already covers it and update that instead of duplicating. Convert relative dates to absolute.

**Don't save** things the vault already records (file contents, what's plainly visible in the tree, git history) or things that only matter to the current conversation. If a fact later proves wrong, delete its file and its index line rather than leaving it stale.

${indexSection}`;
}

/** Read the voice-mode personality prompt from the meta vault.
 *  voice.md is the user-editable header that controls how the voice
 *  agent talks (tone, length, persona, speech rules). Returns ""
 *  when the file is missing — caller falls back to a baseline. */
export async function loadMetaVoicePrompt(): Promise<string> {
  try {
    const p = await getMetaVaultPath();
    return await invoke<string>("read_text_file", { path: `${p}/voice.md` });
  } catch {
    return "";
  }
}

// ----- vault-tool loader -----
//
// A vault-tool is a folder under <meta>/tools/<name>/ containing:
//   - TOOL.md         : YAML front-matter with name, description, input_schema
//   - run.(py|js|ts|sh) : the executable
//
// At agent startup we scan the folder, parse each TOOL.md, build an AI
// SDK tool() whose `execute` runs the corresponding script via the
// Rust `run_script` command.

type FieldSpec = {
  type?: "string" | "integer" | "number" | "boolean";
  description?: string;
  default?: unknown;
  required?: boolean;
};

type ToolSpec = {
  name: string;
  description: string;
  input_schema?: unknown;
  requires_keys?: string[];
  // Optional per-tool timeout in milliseconds. Defaults to 60s. Long-running
  // tools (download/transcribe pipelines) declare e.g. 600000 (10 min).
  timeout_ms?: number;
};

// Accept either convention:
//   1. Flat map: { field_name: { type, description, default, required } }
//   2. JSON Schema: { type: "object", properties: { field_name: {...} }, required: [...] }
// Claude models default to the JSON Schema form when asked to write a
// TOOL.md, so we need to handle both.
function zodFromSchema(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.object({});

  const obj = schema as Record<string, unknown>;

  // JSON Schema shape
  if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
    const required = new Set(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    const flat: Record<string, FieldSpec> = {};
    for (const [key, prop] of Object.entries(obj.properties as Record<string, unknown>)) {
      if (!prop || typeof prop !== "object") continue;
      const p = prop as Record<string, unknown>;
      flat[key] = {
        type: normalizeType(p.type),
        description: typeof p.description === "string" ? p.description : undefined,
        default: p.default,
        required: required.has(key),
      };
    }
    return buildZod(flat);
  }

  // Flat shape — if every value is itself an object that could be a FieldSpec
  const flat: Record<string, FieldSpec> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const v = val as Record<string, unknown>;
      flat[key] = {
        type: normalizeType(v.type),
        description: typeof v.description === "string" ? v.description : undefined,
        default: v.default,
        required: v.required === true,
      };
    }
  }
  return buildZod(flat);
}

function normalizeType(t: unknown): FieldSpec["type"] {
  if (t === "integer" || t === "int") return "integer";
  if (t === "number" || t === "float" || t === "double") return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  return "string";
}

function buildZod(schema: Record<string, FieldSpec>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(schema)) {
    let field: z.ZodTypeAny;
    switch (spec.type) {
      case "integer":
        field = z.number().int();
        break;
      case "number":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "string":
      default:
        field = z.string();
        break;
    }
    if (spec.description) field = field.describe(spec.description);
    if (!spec.required) field = field.optional();
    if (spec.default !== undefined) {
      field = (field as any).default(spec.default);
    }
    shape[key] = field;
  }
  return z.object(shape);
}

async function findRunFile(toolDir: string): Promise<string | null> {
  for (const name of ["run.py", "run.js", "run.mjs", "run.ts", "run.sh", "run.bash"]) {
    try {
      await invoke<string>("read_text_file", { path: `${toolDir}/${name}` });
      return `${toolDir}/${name}`;
    } catch {
      // Not found, try next.
    }
  }
  return null;
}

// Return type is intentionally loose — each tool's zod schema is built
// at runtime from TOOL.md, so we can't statically type them.
//
// Scans a `<root>/<name>/TOOL.md` + run.* layout and returns a dict of
// ai-sdk tool objects. Shared by both the global meta-tool loader and
// the per-vault loader below — the only difference between them is the
// root directory.
async function loadToolsFromRoot(toolsRoot: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const diag: string[] = [];
  let entries: { path: string; name: string; is_dir: boolean }[] = [];
  try {
    entries = await invoke("list_dir", { path: toolsRoot });
  } catch {
    // A missing root is normal — a vault with no local tools, or a meta
    // vault that has no tools dir yet. Quietly register nothing.
    return out;
  }

  for (const entry of entries) {
    if (!entry.is_dir) {
      diag.push(`skip ${entry.name}: not a dir`);
      continue;
    }
    const toolDir = entry.path;
    let spec: ToolSpec;
    try {
      const raw = await invoke<string>("read_text_file", {
        path: `${toolDir}/TOOL.md`,
      });
      const parsed = matter(raw);
      const data = parsed.data as Partial<ToolSpec>;
      if (!data.name || !data.description) {
        diag.push(`skip ${entry.name}: missing name or description`);
        continue;
      }
      spec = {
        name: data.name,
        description: data.description,
        input_schema: data.input_schema,
        requires_keys: Array.isArray(data.requires_keys)
          ? (data.requires_keys as string[])
          : [],
        timeout_ms:
          typeof data.timeout_ms === "number" && data.timeout_ms > 0
            ? data.timeout_ms
            : undefined,
      };
    } catch (e) {
      diag.push(`skip ${entry.name}: ${(e as Error).message}`);
      continue;
    }
    const runPath = await findRunFile(toolDir);
    if (!runPath) {
      diag.push(`skip ${entry.name}: no run.{py,js,mjs,ts,sh,bash}`);
      continue;
    }

    try {
      const inputSchema = zodFromSchema(spec.input_schema);
      out[spec.name] = tool({
        description: spec.description,
        inputSchema: inputSchema as any,
        execute: async (args: unknown) => {
        try {
          // Pull any user-key values the tool declared it needs and
          // pass them as environment variables. The values don't flow
          // through the agent's context — script reads them via
          // os.environ (or equivalent).
          const requiredKeys = spec.requires_keys ?? [];
          const env =
            requiredKeys.length > 0
              ? await getUserKeysAsEnv(requiredKeys)
              : undefined;
          const result = await invoke<{
            stdout: string;
            stderr: string;
            code: number;
            timed_out: boolean;
          }>("run_script", {
            scriptPath: runPath,
            stdinJson: JSON.stringify(args),
            cwd: toolDir,
            timeoutMs: spec.timeout_ms ?? 60_000,
            env,
          });
          if (result.timed_out) return `(timed out)\n${result.stderr}`;
          if (result.code !== 0) {
            return `exit ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`;
          }
          return result.stdout.trim() || "(no output)";
        } catch (e) {
          return `run_script failed: ${(e as Error).message}`;
        }
      },
      });
      diag.push(`loaded ${spec.name}`);
    } catch (e) {
      diag.push(`skip ${entry.name}: schema build failed: ${(e as Error).message}`);
    }
  }

  console.log("[tools]", toolsRoot, "→", diag.join(" | "), "→ registered:", Object.keys(out));
  return out;
}

/** Global tools: <meta>/tools/<name>/. Available in every vault. */
export async function loadMetaTools(): Promise<Record<string, unknown>> {
  let metaPath: string;
  try {
    metaPath = await getMetaVaultPath();
  } catch (e) {
    console.warn("[meta-tools] no meta path:", e);
    return {};
  }
  return loadToolsFromRoot(`${metaPath}/tools`);
}

/** Per-vault tools: <vault>/.vault-chat/tools/<name>/ (same TOOL.md +
 *  run.* shape as meta tools). Scoped to a single vault so a one-off
 *  custom tool doesn't bloat the model's tool choice in every other
 *  vault. Merged on top of the global meta tools by the caller — a
 *  local tool with the same name as a global one wins. */
export async function loadVaultTools(vault: string | null): Promise<Record<string, unknown>> {
  if (!vault) return {};
  return loadToolsFromRoot(`${vault}/.vault-chat/tools`);
}
