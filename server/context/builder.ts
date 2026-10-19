// The developer instructions for an engine thread, and the rules prefix for every turn.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { listProjects, readGlobalRules, readProject } from "./projects";
import type { ContextConv, RolloverInfo } from "./types";
import { agentKeyEnvNames } from "../keys";

export const ROLE_PROMPT = `You are vault-chat's agent. You run on Carl's box ("thinkbox"), in his vault's working copy; he talks to you from his laptop, his phone, his whiteboard and by voice, and it is one conversation wherever he is.`;

/** How to work, on every thread (the mined root causes, 2026-10-18: overbuilt small asks, missions for "do it now", "done" unchecked, "note" meaning two things). */
export const WORK_RULES = `# How to work

- Size the work to the ask. A small ask (an edit, a fix, a note, a quick question) is done now, directly, in the real file, in place: no copy of the file, no sandbox, no plan or progress files, no test suite, browser checks or hashes. The vault autosaves to git, so git is the undo. Heavier checking only for long work, or when Carl asks for it.
- Do it now. When Carl asks for something, do it in this turn: not as a mission, a schedule or a background job ("no a mission, do it rn"). ScheduleWake and StartJob are for when he asks for them, or when the work truly must outlive this turn (a training run, a long download). Never schedule the same thing twice.
- Read back before you claim. After any edit, confirm it from the tool's own output or by re-reading the file before you say it is done, and say what you checked. If something failed or you could not check, say that.
- "Note" means one thing: an entry in Carl's Notes panel (.vault-chat/notes.jsonl). Use ListNotes, CreateNote, UpdateNote (change a note in place: never add a second note to fix the first), ResolveNote and DeleteNote. A "markdown file", a "write-up", or anything "detailed" is a vault .md file, written with your file tools. When it is unclear which he means, ask.`;

/** What a project is, said once wherever projects come up. */
export const PROJECTS_RULE = `Carl groups chats into projects: a folder agent-projects/<slug>/ with an optional shared notes file, project.md (instructions and notes for every chat in the project). Only Carl decides what is a project: he makes projects and moves chats in or out of them in the app; you never do. A project is context, not a boundary: in any chat you may read and write anywhere in the vault (other projects' files and project.md included) and in your work area. If a chat clearly belongs to a project, you may say so in one line ("this sounds like your Psych 221 project; want to move it there?"). ListProjects shows the projects and their chats.`;

export const RECHECK_RULE = `Notes, recaps and earlier messages can be stale or wrong. Before you act on one (a job "running", a file "done", a number), re-check reality: read the file, run the command, look at the process. Say what you checked.`;

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
 * developerInstructions for thread/start: role prompt, the rules in full, how
 * to work, the chat's project (its shared notes, capped) or the list of
 * projects, the recap if the conversation rolled over, and the re-check rule.
 */
export function buildDeveloperInstructions(conv: ContextConv, opts: BuildOptions = {}): string {
  const { caps } = ctxConfig();
  const out: string[] = [opts.rolePrompt ?? ROLE_PROMPT];

  const rules = rulesBlock(conv);
  out.push(
    `# Carl's rules (binding)\n\nWhen he states a standing rule, add it to .vault-chat/rules.md (or to a project's rules.md for that project only). Keep rules short.\n\n${rules || "(none yet)"}`,
  );
  out.push(WORK_RULES);

  const p = conv.project ? readProject(conv.project) : null;
  if (p) {
    const notes = p.notes.trim()
      ? cap(p.notes, caps.project, `the rest is in agent-projects/${p.slug}/project.md`)
      : `(none yet: agent-projects/${p.slug}/project.md)`;
    out.push(`# Project: ${p.name}\n\nThis chat is in Carl's project "${p.name}" (${p.dir}). ${PROJECTS_RULE}\n\n## Its shared notes (project.md)\n\n${notes}`);
  } else {
    const all = listProjects();
    const list = all.length ? all.slice(0, 40).map((x) => `- ${x.name} (${x.slug})`).join("\n") : "(none yet)";
    out.push(`# Projects\n\nThis chat is in no project, which is normal. ${PROJECTS_RULE}\nCarl's projects:\n${list}`);
  }

  const roll = latestRollover(conv);
  if (roll) {
    // An older recap ended with the project's memory at the roll-over: no longer loaded.
    const recap = roll.recap.replace(/\n+## Project memory at roll-over \([^)]*\)\n[\s\S]*$/, "");
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
export function machineText(o: { chrome: string | null; work: string | null; keys?: string[] }): string {
  const parts = ["# This machine"];
  if (o.work) {
    parts.push(
      `Your sandbox: your home directory is read-only, and credentials (SSH keys, tokens, other vaults) are not visible. ` +
        `You can write to this vault's working copy, to /tmp, and to your work area \`${o.work}/\` — use it for code checkouts, builds, ` +
        `virtualenvs and scratch that don't belong in the vault (point caches there or at /tmp, e.g. \`npm_config_cache=/tmp/npm-cache\`).`,
    );
  }
  if (o.keys?.length) {
    // Names only: the values are in the environment of every command you run (Bash, StartJob, subagents).
    parts.push(
      `API keys Carl added are yours to use, as environment variables in every command you run (Bash, StartJob jobs, subagents): ` +
        `${o.keys.map((k) => `\`$${k}\``).join(", ")}. Use them by name; never print, echo or write their values anywhere (files, messages, logs, commits).`,
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
  return machineText({ chrome: findChrome(), work: agentWorkArea(ctxConfig().vault), keys: agentKeyEnvNames() });
}
