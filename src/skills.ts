import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
};

export async function loadSkills(vault: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const searchRoots = [
    `${vault}/.claude/skills`,
    `${vault}/learn/.claude/skills`,
  ];

  for (const root of searchRoots) {
    let entries: { path: string; name: string; is_dir: boolean }[] = [];
    try {
      entries = await invoke("list_dir", { path: root });
    } catch {
      continue;
    }

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
          body: parsed.content.trim(),
        });
      } catch {
        continue;
      }
    }

    if (skills.length) break;
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function skillPromptIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- /${s.name} — ${s.description || "(no description)"}`);
  return `## Available skills (slash commands)\n\nThe user can invoke these as /<name>. When they do, their message will be prefixed with the skill's full instructions. You can also suggest a skill when appropriate.\n\n${lines.join("\n")}`;
}

export function expandSkillInvocation(
  text: string,
  skills: Skill[]
): { body: string; skill: Skill | null; rest: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { body: text, skill: null, rest: text };
  const match = trimmed.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { body: text, skill: null, rest: text };
  const [, cmd, rest] = match;
  const skill = skills.find((s) => s.name === cmd);
  if (!skill) return { body: text, skill: null, rest: text };
  const args = rest ?? "";
  const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>\n\n${args ? `User arguments: ${args}` : "(no additional arguments)"}`;
  return { body, skill, rest: args };
}
