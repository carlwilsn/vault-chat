// The developer instructions for a Codex thread, and the rules prefix for every turn.
import { ctxConfig } from "./config";
import { cap, vcPath } from "./files";
import { listProjects, readGlobalRules, readProject } from "./projects";
import type { ContextConv, RolloverInfo } from "./types";

export const ROLE_PROMPT = `You are vault-chat's agent. You run on Carl's box ("thinkbox"), in his vault's working copy; he talks to you from his laptop and his phone, often while away. One conversation can keep working for hours or days.

- Long work is bounded. In keep-going mode, every stretch of work ends in exactly one of: ScheduleWake (a one-off check toward the goal), AskUser (a real fork: money, something irreversible, or taste), Done (with evidence), or Blocked (with the reason). No recurring loops.
- Done means checked. Call Done with a summary and evidence a second model can verify: file paths, and the commands you ran with their output.
- Projects are memory, kept in .vault-chat/projects/<slug>/, never in Carl's own folders. When work belongs to a project ("this is for Coconut"), call SetProject with its name; it creates the project or attaches to it. Then keep its memory current: ProjectMemory append for decisions, what was tried and learned, and conventions; Plan update for the plan and progress. Write down what a fresh session would need.
- Rules are binding. Carl's rules are below in full. When he states a standing rule, add it: global rules to .vault-chat/rules.md, project rules with ProjectMemory {action:"append", file:"rules"}. Keep rules short.`;

export const RECHECK_RULE = `Notes, plans, recaps and memory can be stale or wrong. Before you act on one (a job "running", a file "done", a number), re-check reality: read the file, run the command, look at the process. Say what you checked.`;

/** The latest roll-over marker's info, if the conversation rolled over. */
export function latestRollover(conv: ContextConv): RolloverInfo | null {
  const msgs = conv.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const r = msgs[i]?.rollover;
    if (r && typeof r.recap === "string") return r;
  }
  return null;
}

function rulesBlock(conv?: ContextConv): string {
  const global = readGlobalRules().trim();
  const p = conv?.project ? readProject(conv.project) : null;
  const parts: string[] = [];
  if (global) parts.push(`## Global rules (.vault-chat/rules.md)\n\n${global}`);
  if (p?.rules.trim()) parts.push(`## Project rules: ${p.name}\n\n${p.rules.trim()}`);
  return parts.join("\n\n");
}

/**
 * The rules, in full, for ENGINE to put in front of every turn's input
 * (turn/start and wake turns). "" when there are no rules files.
 */
export function rulesPrefixForTurn(conv?: ContextConv): string {
  const block = rulesBlock(conv);
  if (!block) return "";
  return `<rules>\nCarl's standing rules. They are binding on this turn.\n\n${block}\n</rules>\n\n`;
}

export type BuildOptions = {
  /** Replaces ROLE_PROMPT (ENGINE's adapted system prompt goes before it, or here). */
  rolePrompt?: string;
};

/**
 * developerInstructions for thread/start: role prompt, the rules in full, the
 * project's files (capped, with a pointer to ProjectMemory/Plan), the recap if
 * the conversation rolled over, and the re-check rule.
 */
export function buildDeveloperInstructions(conv: ContextConv, opts: BuildOptions = {}): string {
  const { caps } = ctxConfig();
  const out: string[] = [opts.rolePrompt ?? ROLE_PROMPT];

  const rules = rulesBlock(conv);
  out.push(`# Carl's rules (binding)\n\n${rules || "(none yet; global rules go in .vault-chat/rules.md)"}`);

  const p = conv.project ? readProject(conv.project) : null;
  if (p) {
    const more = (what: string) => `read more with ${what}`;
    out.push(
      [
        `# Project: ${p.name}`,
        `This conversation is tagged with project "${p.slug}" (${vcPath(ctxConfig().vault, "projects", p.slug)}).`,
        `## project.md\n\n${cap(p.project, caps.project, more('ProjectMemory {action:"read", file:"project"}'))}`,
        `## memory.md\n\n${cap(p.memory, caps.memory, more('ProjectMemory {action:"read"}'))}`,
        `## plan.md\n\n${cap(p.plan, caps.plan, more('Plan {action:"read"}'))}`,
        `## progress.md (latest)\n\n${cap(p.progress, caps.progress, more('Plan {action:"read"}'), "tail")}`,
      ].join("\n\n"),
    );
  } else {
    const all = listProjects();
    const list = all.length
      ? all.slice(0, 40).map((x) => `- ${x.name} (${x.slug})`).join("\n")
      : "(none yet)";
    out.push(
      `# Projects\n\nThis conversation has no project. If the work belongs to one, call SetProject with its name.\nExisting projects:\n${list}`,
    );
  }

  const roll = latestRollover(conv);
  if (roll) {
    out.push(
      `# Recap: this conversation continues from an earlier session\n\n` +
        cap(roll.recap, caps.recap, "the full history is in the conversation file"),
    );
  }

  out.push(`# Before you trust any of this\n\n${RECHECK_RULE}`);
  return out.join("\n\n---\n\n") + "\n";
}
