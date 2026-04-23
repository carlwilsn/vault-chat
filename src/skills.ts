import { invoke } from "@tauri-apps/api/core";
import matter from "gray-matter";
import { getMetaVaultPath } from "./meta";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
};

export async function loadSkills(_vault: string): Promise<Skill[]> {
  // Skills are global — they live in the meta vault and are available
  // in every vault. No per-vault skill scope.
  let root: string | null = null;
  try {
    const meta = await getMetaVaultPath();
    if (meta) root = `${meta}/skills`;
  } catch {
    return [];
  }
  if (!root) return [];

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
        body: parsed.content.trim(),
      });
    } catch {
      continue;
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function skillPromptIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- /${s.name} — ${s.description || "(no description)"}`);
  return `## Available skills (slash commands)\n\nThe user can invoke these as /<name> anywhere in their message (at the start or mid-text — multiple skills can be invoked in one message). When they do, the skill's full instructions are injected as <skill> blocks before their message. You can also suggest a skill when appropriate.\n\n${lines.join("\n")}`;
}

// Scan text for every /skill-name token (at the start or after
// whitespace, terminated by whitespace or EOL) and return the unique
// skills invoked in source order. Used by expandSkillInvocation below.
function matchInvokedSkills(text: string, skills: Skill[]): Skill[] {
  if (!skills.length || !text) return [];
  const byName = new Map(skills.map((s) => [s.name, s]));
  const out: Skill[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)\/([\w-]+)(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = byName.get(m[1]);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

// Expand /skill invocations anywhere in the user's message. Each
// invoked skill's body is prepended as a <skill> block; the user's
// original text is kept intact (including the /name tokens), so the
// agent can see which skill the user was pointing at and what they
// actually asked. `skill` and `rest` in the return value are kept for
// backward compatibility with older single-skill call sites.
export function expandSkillInvocation(
  text: string,
  skills: Skill[]
): { body: string; skill: Skill | null; rest: string } {
  const invoked = matchInvokedSkills(text, skills);
  if (invoked.length === 0) return { body: text, skill: null, rest: text };
  const blocks = invoked
    .map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`)
    .join("\n\n");
  const body = `${blocks}\n\n${text}`;
  return { body, skill: invoked[0], rest: text };
}
