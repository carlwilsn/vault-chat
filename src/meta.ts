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
export async function loadMetaTools(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const diag: string[] = [];
  let metaPath: string;
  try {
    metaPath = await getMetaVaultPath();
  } catch (e) {
    console.warn("[meta-tools] no meta path:", e);
    return out;
  }
  const toolsRoot = `${metaPath}/tools`;
  let entries: { path: string; name: string; is_dir: boolean }[] = [];
  try {
    entries = await invoke("list_dir", { path: toolsRoot });
  } catch (e) {
    console.warn("[meta-tools] list_dir failed:", toolsRoot, e);
    return out;
  }
  console.log(
    "[meta-tools] toolsRoot:",
    toolsRoot,
    "entry count:",
    entries.length,
    "names:",
    entries.map((e) => e.name).join(","),
  );

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

  console.log("[meta-tools]", diag.join(" | "), "→ registered:", Object.keys(out));
  return out;
}
