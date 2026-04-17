import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";
import { tool } from "ai";
import { z } from "zod";

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
  input_schema?: Record<string, FieldSpec>;
};

function zodFromSchema(schema: Record<string, FieldSpec> | undefined): z.ZodTypeAny {
  if (!schema) return z.object({});
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
export async function loadMetaTools(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let metaPath: string;
  try {
    metaPath = await getMetaVaultPath();
  } catch {
    return out;
  }
  const toolsRoot = `${metaPath}/tools`;
  let entries: { path: string; name: string; is_dir: boolean }[] = [];
  try {
    entries = await invoke("list_dir", { path: toolsRoot });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.is_dir) continue;
    const toolDir = entry.path;
    let spec: ToolSpec;
    try {
      const raw = await invoke<string>("read_text_file", {
        path: `${toolDir}/TOOL.md`,
      });
      const parsed = matter(raw);
      const data = parsed.data as Partial<ToolSpec>;
      if (!data.name || !data.description) continue;
      spec = {
        name: data.name,
        description: data.description,
        input_schema: data.input_schema,
      };
    } catch {
      continue;
    }
    const runPath = await findRunFile(toolDir);
    if (!runPath) continue;

    const inputSchema = zodFromSchema(spec.input_schema);
    out[spec.name] = tool({
      description: spec.description,
      inputSchema: inputSchema as any,
      execute: async (args: unknown) => {
        try {
          const result = await invoke<{
            stdout: string;
            stderr: string;
            code: number;
            timed_out: boolean;
          }>("run_script", {
            scriptPath: runPath,
            stdinJson: JSON.stringify(args),
            cwd: toolDir,
            timeoutMs: 60_000,
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
  }

  return out;
}
