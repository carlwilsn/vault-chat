import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";
import { DEFAULT_SKILLS } from "./defaultSkills";

export type Skill = {
  name: string;
  description: string;
  path: string;
  dir: string;
  body: string;
};

// Scan a `<root>/<name>/SKILL.md` layout into Skill objects. Missing root
// or unreadable entries yield an empty list rather than throwing.
async function loadSkillsFromRoot(root: string): Promise<Skill[]> {
  let entries: { path: string; name: string; is_dir: boolean }[] = [];
  try {
    entries = await invoke("list_dir", { path: root });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.is_dir) continue;
    const skillFile = `${entry.path}/SKILL.md`;
    try {
      const raw = await invoke<string>("read_text_file", { path: skillFile });
      const parsed = matter(raw);
      const name = (parsed.data.name as string | undefined) ?? entry.name;
      const description = (parsed.data.description as string | undefined) ?? "";
      skills.push({
        name,
        description,
        path: skillFile,
        dir: entry.path,
        body: parsed.content.trim(),
      });
    } catch {
      continue;
    }
  }
  return skills;
}

export async function loadSkills(vault: string): Promise<Skill[]> {
  // Skills live in the open vault at <vault>/.vault-chat/skills/ — which
  // syncs via git, so skills built in a vault reach every machine that
  // opens it. Invoked with `/name`.
  const byName = new Map<string, Skill>();
  // Built-in defaults first; a vault skill with the same name overrides one.
  for (const d of DEFAULT_SKILLS) {
    byName.set(d.name, { ...d, path: `(built in)/${d.name}/SKILL.md`, dir: `(built in)/${d.name}` });
  }
  if (vault) {
    for (const s of await loadSkillsFromRoot(`${vault}/.vault-chat/skills`)) {
      byName.set(s.name, s);
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function skillPromptIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- /${s.name} — ${s.description || "(no description)"}`);
  return `## Available skills (slash commands)\n\nThe user can invoke these as /<name> anywhere in their message (at the start or mid-text — multiple skills can be invoked in one message). When they do, the skill's full instructions are injected as <skill> blocks before their message. You can also suggest a skill when appropriate.\n\n${lines.join("\n")}`;
}
