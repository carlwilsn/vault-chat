// The developer instructions for an engine thread, and the rules prefix for every turn.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { listProjects, readGlobalRules, readProject } from "./projects";
import type { ContextConv, RolloverInfo } from "./types";

export const ROLE_PROMPT = `You are vault-chat's agent. You run on Carl's box ("thinkbox"), in his vault's working copy; he talks to you from his laptop and his phone, often while away. One conversation can keep working for hours or days.

- Long work is bounded. In keep-going mode, every stretch of work ends in exactly one of: ScheduleWake (a one-off check toward the goal), AskUser (a real fork: money, something irreversible, or taste), Done (with evidence), or Blocked (with the reason). No recurring loops.
- Done means checked. Call Done with a summary and evidence a second model can verify: file paths, and the commands you ran with their output.
- Projects are memory, kept in agent-projects/<slug>/ (a vault folder Carl's file tree hides by default), never in Carl's own folders. Chats without a project are normal; never move a chat into a project or start one on your own. SetProject only proposes: Carl gets a card and only his yes applies it. Propose when he asks ("this is for Coconut"), or when the conversation clearly belongs to an existing project or is becoming one, at most once per conversation and never again after "Not now" unless he asks; don't nag. In a project, keep its memory current: ProjectMemory append for decisions, what was tried and learned, and conventions; Plan update for the plan and progress. Write down what a fresh session would need.
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
        `This conversation is tagged with project "${p.slug}" (${p.dir}).`,
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
      `# Projects\n\nThis conversation has no project, which is fine. Only if it clearly belongs to one of these (or is becoming a project), propose it once with SetProject (Carl decides).\nExisting projects:\n${list}`,
    );
  }

  const roll = latestRollover(conv);
  if (roll) {
    // The recap ends with the project's memory as it was at the roll-over; the
    // live memory.md is above, so that copy is left out (said once, and current).
    const recap = p ? roll.recap.replace(/\n+## Project memory at roll-over \([^)]*\)\n[\s\S]*$/, "") : roll.recap;
    out.push(
      `# Recap: this conversation continues from an earlier session\n\n` +
        cap(recap, caps.recap, "the full history is in the conversation file"),
    );
  }

  const machine = machineBlock();
  if (machine) out.push(machine);

  out.push(`# Before you trust any of this\n\n${RECHECK_RULE}`);
  return out.join("\n\n---\n\n") + "\n";
}

/** The vault's work area outside the vault (the sandbox makes it writable; engine/index.ts agentWorkDir). */
export function agentWorkArea(vault: string): string {
  const home = process.env.HOME || homedir();
  return join(home, "agent-work", basename(vault.replace(/[\\/]+$/, "")));
}

/**
 * The machine section: what the sandbox lets the agent write, and what the box
 * offers beyond the tools (a browser). The box is headless, so "seeing" a page
 * is a headless screenshot the agent then reads. `--headless=new` hangs in the
 * sandbox (it wants the session dbus under /run/user, which is hidden); the old
 * headless mode with its own profile in /tmp works, and `timeout` bounds it.
 */
export function machineText(o: { chrome: string | null; work: string | null }): string {
  const parts = ["# This machine"];
  if (o.work) {
    parts.push(
      `Your sandbox: your home directory is read-only, and credentials (SSH keys, tokens, other vaults) are not visible. ` +
        `You can write to this vault's working copy, to /tmp, and to your work area \`${o.work}/\` — use it for code checkouts, builds, ` +
        `virtualenvs and scratch that don't belong in the vault (point caches there or at /tmp, e.g. \`npm_config_cache=/tmp/npm-cache\`).`,
    );
  }
  if (o.chrome) {
    const flags = `--headless=old --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/chrome-agent`;
    parts.push(
      `A browser is installed: \`${o.chrome}\`. To look at a web page (a local dev server, a site, an HTML file), render it headless and read the image: ` +
        `\`timeout 60 ${o.chrome} ${flags} --window-size=1400,900 --screenshot=/tmp/page.png <url>\`, then Read /tmp/page.png. ` +
        `For the page's DOM: \`timeout 60 ${o.chrome} ${flags} --dump-dom <url>\`. Use exactly these flags (\`--headless=new\` hangs here). Check UI work this way before calling it done.`,
    );
  }
  return parts.join("\n\n");
}

let chromeCache: string | null | undefined;
function findChrome(): string | null {
  if (chromeCache !== undefined) return chromeCache;
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  chromeCache = null;
  for (const n of ["chromium", "chromium-browser", "google-chrome"]) {
    const d = dirs.find((x) => existsSync(join(x, n)));
    if (d) {
      chromeCache = join(d, n);
      break;
    }
  }
  return chromeCache;
}

function machineBlock(): string | null {
  if (process.platform === "win32") return null;
  return machineText({ chrome: findChrome(), work: agentWorkArea(ctxConfig().vault) });
}
