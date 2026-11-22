import { invoke } from "@tauri-apps/api/core";
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

/** Per-vault voice-mode prompt at `.vault-chat/agent/voice.md`. */
export async function loadVaultVoicePrompt(vault: string | null): Promise<string> {
  if (!vault) return "";
  return readAgentConfig(vault, "voice.md");
}

export async function ensureVaultVoicePrompt(vault: string | null): Promise<void> {
  if (!vault) return;
  await ensureAgentConfig(vault, "voice.md", "default_voice_prompt");
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

function formatNorthStarBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `## Vault north star\n\nThe user has declared this brief for the vault you're working in. Treat it as load-bearing — it tells you what kind of help the user wants here (tutor / co-engineer / from-scratch / etc.). When the brief conflicts with your default behavior, the brief wins.\n\nThe brief lives at \`<vault>/.vault-chat/agent/north-star.md\`. If the user asks you to update, append to, or revise it, edit that file directly with the Edit or Write tool.\n\n${trimmed}`;
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
