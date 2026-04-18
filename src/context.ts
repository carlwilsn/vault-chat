import { invoke } from "@tauri-apps/api/core";

async function tryRead(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return null;
  }
}

async function tryGlob(pattern: string, cwd: string): Promise<string[]> {
  try {
    return await invoke<string[]>("glob_files", { pattern, cwd });
  } catch {
    return [];
  }
}

export async function loadSessionContext(vault: string): Promise<string> {
  const pieces: string[] = [];

  // Load binding-rules files in priority order. First four are neutral /
  // industry conventions (AGENTS.md is the emerging cross-tool standard
  // used by Codex CLI, cline, etc.). CLAUDE.md kept for Claude Code
  // interop. LEARNING_RULES.md is the user-specific convention.
  const rulesPaths = [
    `${vault}/LEARNING_RULES.md`,
    `${vault}/learn/LEARNING_RULES.md`,
    `${vault}/AGENTS.md`,
    `${vault}/learn/AGENTS.md`,
    `${vault}/AGENT.md`,
    `${vault}/learn/AGENT.md`,
    `${vault}/CLAUDE.md`,
    `${vault}/learn/CLAUDE.md`,
  ];
  for (const p of rulesPaths) {
    const body = await tryRead(p);
    if (body) {
      pieces.push(`## ${p}\n\n${body}`);
    }
  }

  const goalPatterns = ["goals/*.md", "learn/goals/*.md"];
  for (const pat of goalPatterns) {
    const paths = await tryGlob(pat, vault);
    for (const path of paths) {
      const body = await tryRead(path);
      if (body) {
        pieces.push(`## ${path}\n\n${body}`);
      }
    }
    if (paths.length) break;
  }

  if (!pieces.length) return "";
  return [
    "# Session context (auto-loaded from vault)",
    "",
    "The following files describe the user's workflow, rules, and active goals. Treat them as binding.",
    "",
    pieces.join("\n\n---\n\n"),
  ].join("\n");
}
