import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";
import { tool } from "ai";
import { z } from "zod";
import { getUserKeysAsEnv } from "./keychain";
import { DEFAULT_PROMPT_HISTORY } from "./defaultPromptHistory";

// ----- per-vault agent config -----
//
// The agent's editable config lives in the vault at `.vault-chat/agent/`
// (system.md, voice.md, north-star.md), so it syncs across machines via
// git and is fully customizable per-vault. There is no global meta vault;
// new vaults seed each file from the app's bundled defaults on open.

const AGENT_DIR = ".vault-chat/agent";

// Canonical prompt normalization — MUST stay identical to the normalize() in
// scripts/gen-default-hashes.mjs, so a file written on Windows (CRLF) hashes the
// same as the LF-seeded original: CRLF/CR → LF, strip trailing whitespace, one
// trailing newline.
function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/, "") + "\n";
}
async function normalizedPromptHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizePrompt(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read a config file from `.vault-chat/agent/<name>`, falling back to an
 *  older flat `.vault-chat/<legacyRel>` location if present. "" if absent. */
async function readAgentConfig(
  vault: string,
  name: string,
  legacyRel?: string,
): Promise<string> {
  try {
    return await invoke<string>("read_text_file", {
      path: `${vault}/${AGENT_DIR}/${name}`,
    });
  } catch {
    /* fall through to legacy location */
  }
  if (legacyRel) {
    try {
      return await invoke<string>("read_text_file", {
        path: `${vault}/.vault-chat/${legacyRel}`,
      });
    } catch {
      /* absent */
    }
  }
  return "";
}

/** Ensure `.vault-chat/agent/<name>` is present AND not a stale default:
 *  - absent  → migrate a legacy flat file if one exists, else seed the bundled
 *    default (via the given Rust command).
 *  - present AND byte-identical (modulo line endings) to a default we once
 *    shipped → it's a pristine-but-OLD seed: upgrade it to the current bundle so
 *    a vault seeded before a prompt improved actually picks up the improvement.
 *  - present and customized (matches no shipped default) → never touched.
 *  This is what lets a supervisor/assistant prompt improvement reach existing
 *  vaults instead of only new ones — without ever clobbering a user's edits. */
async function ensureAgentConfig(
  vault: string,
  name: string,
  defaultCommand: string,
  legacyRel?: string,
): Promise<void> {
  const path = `${vault}/${AGENT_DIR}/${name}`;
  let existing: string | null = null;
  try {
    existing = await invoke<string>("read_text_file", { path });
  } catch {
    /* absent — seed below */
  }

  if (existing && existing.trim()) {
    // Present: keep it, UNLESS it's an unmodified default we shipped in an
    // earlier version — those are safe to refresh to the current bundle.
    try {
      const current = (await invoke<string>(defaultCommand)).trim();
      if (!current) return;
      const [existingHash, currentHash] = await Promise.all([
        normalizedPromptHash(existing),
        normalizedPromptHash(current),
      ]);
      if (existingHash === currentHash) return; // already current
      if ((DEFAULT_PROMPT_HISTORY[name] ?? []).includes(existingHash)) {
        await invoke("write_text_file", { path, contents: current });
        console.log(`[agent-cfg] upgraded ${name}: pristine old default → current bundle`);
      }
      // else: the user edited it (matches no shipped default) — leave it be.
    } catch (e) {
      console.warn(`[agent-cfg] upgrade check ${name} failed:`, e);
    }
    return;
  }

  // Absent — migrate a legacy flat file if present, else seed the bundled default.
  if (legacyRel) {
    try {
      const legacy = await invoke<string>("read_text_file", {
        path: `${vault}/.vault-chat/${legacyRel}`,
      });
      if (legacy.trim()) {
        await invoke("write_text_file", { path, contents: legacy });
        return; // migrated the user's existing file into agent/
      }
    } catch {
      /* no legacy file */
    }
  }
  try {
    const seed = (await invoke<string>(defaultCommand)).trim();
    if (seed) await invoke("write_text_file", { path, contents: seed });
  } catch (e) {
    console.warn(`[agent-cfg] seed ${name} failed:`, e);
  }
}

/** Per-vault system prompt at `.vault-chat/agent/system.md`. Syncs across
 *  machines via git; "" when absent (caller has a compiled-in baseline). */
export async function loadVaultSystemPrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "system.md", "system.md");
}

export async function ensureVaultSystemPrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "system.md", "default_system_prompt", "system.md");
}

export async function saveVaultSystemPrompt(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/system.md`,
    contents,
  });
}

/** Per-vault voice-mode prompt at `.vault-chat/agent/voice.md`. */
export async function loadVaultVoicePrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "voice.md");
}

export async function ensureVaultVoicePrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "voice.md", "default_voice_prompt");
}

export async function saveVaultVoicePrompt(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/voice.md`,
    contents,
  });
}

/** Per-vault Telegram-mode prompt at `.vault-chat/agent/telegram.md`. Steers
 *  how the agent replies to messages arriving via the vault's Telegram bot
 *  (short, plain-text, phone-friendly). "" when absent — the agent then uses
 *  the compiled-in fallback. */
export async function loadVaultTelegramPrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "telegram.md");
}

export async function ensureVaultTelegramPrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "telegram.md", "default_telegram_prompt");
}

export async function saveVaultTelegramPrompt(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/telegram.md`,
    contents,
  });
}

/** Per-vault supervisor role prompt at `.vault-chat/agent/supervisor.md`. Layers
 *  the always-on orchestrator role (persistent mind, goal loop, worker steering)
 *  onto the Telegram agent. "" when absent — the agent stays a plain Telegram
 *  responder with no supervisor section. */
export async function loadVaultSupervisorPrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "supervisor.md");
}

export async function ensureVaultSupervisorPrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "supervisor.md", "default_supervisor_prompt");
}

export async function saveVaultSupervisorPrompt(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/supervisor.md`,
    contents,
  });
}

/** Per-vault cockpit-assistant prompt at `.vault-chat/agent/assistant.md`. Steers
 *  the interactive phone-cockpit chat — light, conversational, proposes missions
 *  via plan cards instead of running work itself. "" when absent (the agent then
 *  falls back to the compiled-in cockpit baseline). */
export async function loadVaultAssistantPrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "assistant.md");
}

export async function ensureVaultAssistantPrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "assistant.md", "default_assistant_prompt");
}

export async function saveVaultAssistantPrompt(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/assistant.md`,
    contents,
  });
}

/** Read the per-vault north-star brief (the user's declaration of
 *  what the vault is for). Stored at <vault>/.vault-chat/agent/north-star.md
 *  (migrated from the older flat `.vault-chat/north-star.md`). Prepended to
 *  every agent system prompt (chat, voice, inline) so the agent enters every
 *  turn pre-briefed on the vault's purpose. "" when missing / no vault. */
export async function loadVaultNorthStar(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "north-star.md", "north-star.md");
}

export async function saveVaultNorthStar(vault: string, contents: string): Promise<void> {
  await invoke("write_text_file", {
    path: `${vault}/${AGENT_DIR}/north-star.md`,
    contents,
  });
}

function formatNorthStarBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `## Vault north star\n\nThe user has declared this brief for the vault you're working in. Treat it as load-bearing — it tells you what kind of help the user wants here (tutor / co-engineer / from-scratch / etc.). When the brief conflicts with your default behavior, the brief wins.\n\nThe brief lives at \`<vault>/.vault-chat/agent/north-star.md\`. If the user asks you to update, append to, or revise it, edit that file directly with the Edit or Write tool — the modal in the titlebar reads from the same place and will reflect your changes when reopened.\n\n${trimmed}`;
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
// Scan a `<root>/<name>/TOOL.md` + run.* layout into parsed specs. Shared by
// every consumer below — the text-agent AI-SDK loader AND the voice loader —
// so the on-disk tool format has exactly one parser. Whatever the text agent
// can run, voice can too, because they read the same folders the same way.
async function scanToolSpecs(
  toolsRoot: string,
): Promise<{ spec: ToolSpec; runPath: string; toolDir: string }[]> {
  const found: { spec: ToolSpec; runPath: string; toolDir: string }[] = [];
  const diag: string[] = [];
  let entries: { path: string; name: string; is_dir: boolean }[] = [];
  try {
    entries = await invoke("list_dir", { path: toolsRoot });
  } catch {
    // A missing root is normal — a vault with no local tools yet. Register nothing.
    return found;
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
    found.push({ spec, runPath, toolDir });
  }
  if (diag.length) console.log("[tools]", toolsRoot, "skips →", diag.join(" | "));
  return found;
}

// Run a scanned tool's script with the args object and return its stdout (or a
// readable error string). Shared by both the text and voice executors so a tool
// behaves identically whether the user typed or spoke.
async function runToolScript(
  spec: ToolSpec,
  runPath: string,
  toolDir: string,
  args: unknown,
): Promise<string> {
  try {
    // Pull any user-key values the tool declared it needs and pass them as
    // environment variables. The values don't flow through the agent's
    // context — the script reads them via os.environ (or equivalent).
    const requiredKeys = spec.requires_keys ?? [];
    const env =
      requiredKeys.length > 0 ? await getUserKeysAsEnv(requiredKeys) : undefined;
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
}

async function loadToolsFromRoot(toolsRoot: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const loaded: string[] = [];
  for (const { spec, runPath, toolDir } of await scanToolSpecs(toolsRoot)) {
    try {
      const inputSchema = zodFromSchema(spec.input_schema);
      out[spec.name] = tool({
        description: spec.description,
        inputSchema: inputSchema as any,
        execute: (args: unknown) => runToolScript(spec, runPath, toolDir, args),
      });
      loaded.push(spec.name);
    } catch (e) {
      console.log("[tools]", `skip ${spec.name}: schema build failed: ${(e as Error).message}`);
    }
  }
  console.log("[tools]", toolsRoot, "→ registered:", loaded);
  return out;
}

/** Per-vault tools: <vault>/.vault-chat/tools/<name>/ — a folder per tool
 *  (TOOL.md + run.*), scoped to the vault and synced with it via git so a
 *  tool built in a vault reaches every machine that opens it. */
export async function loadVaultTools(vault: string | null): Promise<Record<string, unknown>> {
  if (!vault) return {};
  return loadToolsFromRoot(`${vault}/.vault-chat/tools`);
}

// A vault tool shaped for the ElevenLabs voice agent's client-tool protocol.
// ElevenLabs needs a JSON-schema `parameters` block (every property described)
// at agent-provision time, plus an `execute` the box runs when the agent calls
// the tool. Same `execute` path as the text agent — only the schema shape
// differs (JSON schema here vs. zod for the AI SDK).
export type VaultVoiceTool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (args: unknown) => Promise<string>;
};

/**
 * Voice/text tool parity: load the SAME per-vault tools the text agent loads
 * (loadVaultTools), shaped for ElevenLabs. A tool added to a vault is then
 * usable whether the user types or talks — no second place to register it.
 */
export async function loadVaultVoiceTools(
  vault: string | null,
): Promise<VaultVoiceTool[]> {
  if (!vault) return [];
  const out: VaultVoiceTool[] = [];
  for (const { spec, runPath, toolDir } of await scanToolSpecs(
    `${vault}/.vault-chat/tools`,
  )) {
    out.push({
      name: spec.name,
      description: spec.description,
      parameters: inputSchemaToVoiceParameters(spec.input_schema),
      execute: (args: unknown) => runToolScript(spec, runPath, toolDir, args),
    });
  }
  return out;
}

// Convert a TOOL.md input_schema — either the flat `{ field: {type,…} }` form or
// the JSON-Schema `{ type:"object", properties, required }` form — into the
// JSON-Schema `parameters` ElevenLabs requires. ElevenLabs 422s on any property
// missing a description and rejects non-scalar types, so we coerce every leaf to
// a scalar (mirroring zodFromSchema's normalizeType) and fill a description
// (falling back to the property name) for every one.
function inputSchemaToVoiceParameters(
  schema: unknown,
): VaultVoiceTool["parameters"] {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  const add = (key: string, p: Record<string, unknown>, isRequired: boolean) => {
    properties[key] = {
      type: normalizeType(p.type) ?? "string",
      description:
        typeof p.description === "string" && p.description ? p.description : key,
    };
    if (isRequired) required.push(key);
  };
  if (schema && typeof schema === "object") {
    const obj = schema as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const req = new Set(
        Array.isArray(obj.required) ? (obj.required as string[]) : [],
      );
      for (const [key, prop] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        if (prop && typeof prop === "object")
          add(key, prop as Record<string, unknown>, req.has(key));
      }
    } else {
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === "object" && !Array.isArray(val))
          add(key, val as Record<string, unknown>, (val as any).required === true);
      }
    }
  }
  return { type: "object", properties, required };
}
