// The memory/project tools ENGINE exposes to the agent, and their handlers.
import { appendSection, cap, getSection, readOr, setSection, slugify, writeFile } from "./files";
import { ensureProject, findProject, projectExists, projectFilePath, readProject, type ProjectFile } from "./projects";
import { projectCost } from "./cost";
import type { DynamicToolCallResponse, DynamicToolSpec, ToolContext } from "./types";

export const CONTEXT_TOOL_NAMES = ["SetProject", "ProjectMemory", "Plan", "ProjectCost"] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

export const contextToolSpecs: DynamicToolSpec[] = [
  {
    type: "function",
    name: "SetProject",
    description:
      "Propose putting this conversation in a project: Carl gets a card (\"Move this chat to Coconut?\" Yes / Not now, or \"Turn this into a new project 'Coconut'?\" Create / Not now) and only his yes applies it — the call waits for his answer. Chats without a project are normal. Use it when Carl asks (\"this is for Coconut\"), or at most once per conversation when it clearly belongs to an existing project or is becoming one; prefer an existing project's exact name when one matches. After \"Not now\", do not propose again unless he asks. On yes, the project's memory loads into every new session. Its files are in agent-projects/<slug>/ (project.md, memory.md, plan.md, progress.md, rules.md), a vault folder hidden from Carl's file tree by default.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The project's name, e.g. \"Coconut\"." },
        description: { type: "string", description: "What the project is, for a new project's project.md." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ProjectMemory",
    description:
      "Read or edit this conversation's project memory. file: memory (decisions, tried and learned, conventions; the default), project (what, why, done when, status) or rules (project rules). read returns the whole file or one `## section`. append adds text to the end of a section (or of the file when no section is given). update replaces a section's text.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "append", "update"] },
        file: { type: "string", enum: ["memory", "project", "rules"] },
        section: { type: "string", description: "A `## ` heading, e.g. \"Decisions\"." },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Plan",
    description:
      "Read or update this conversation's project plan (plan.md) and progress (progress.md). update: `plan` and `progress` replace the files' text; `progressNote` appends one dated line to progress.md.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "update"] },
        plan: { type: "string" },
        progress: { type: "string" },
        progressNote: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ProjectCost",
    description: "What a project has cost so far in model spend (USD), summed over its conversations. Defaults to this conversation's project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name or slug." } },
      additionalProperties: false,
    },
  },
];

export function isContextTool(name: string): name is ContextToolName {
  return (CONTEXT_TOOL_NAMES as readonly string[]).includes(name);
}

const READ_CAP = 60_000;

function ok(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}
function fail(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function needProject(ctx: ToolContext): string | DynamicToolCallResponse {
  const slug = ctx.conv.project;
  if (!slug || !projectExists(slug)) {
    return fail("This conversation has no project yet. Call SetProject with the project's name first.");
  }
  return slug;
}

/** Handle a context tool call (an engine tool call). Never throws. */
export async function handleContextTool(name: string, args: unknown, ctx: ToolContext): Promise<DynamicToolCallResponse> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "SetProject":
        return await setProjectTool(a, ctx);
      case "ProjectMemory":
        return projectMemoryTool(a, ctx);
      case "Plan":
        return planTool(a, ctx);
      case "ProjectCost": {
        const target = str(a.project) ?? ctx.conv.project;
        if (!target) return fail("No project given and this conversation has none.");
        const c = projectCost(target);
        if (!c) return fail(`No project "${target}".`);
        const lines = c.parts.map((p) => `- ${p.title || p.id}: $${p.costUsd.toFixed(4)}`);
        const missing = c.missingCalls ? ` (${c.missingCalls} model call(s) had no cost reported)` : "";
        return ok(`Project ${c.name}: $${c.totalUsd.toFixed(4)} over ${c.parts.length} conversation(s)${missing}\n${lines.join("\n")}`);
      }
      default:
        return fail(`Unknown context tool ${name}`);
    }
  } catch (e) {
    return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

const YES = /^\s*(yes|create|y|ok|okay|sure|do it|move it)\b/i;

/** After a "Not now": may the agent propose again? Only once Carl has said something about a project since. */
function carlAskedSince(conv: ToolContext["conv"], declined: { name: string; at: number }, name: string): boolean {
  const words = [declined.name, name, "project"].map((w) => w.trim().toLowerCase()).filter(Boolean);
  return (conv.messages ?? [])
    .slice(declined.at)
    .some((m) => m.role === "user" && !m.hidden && !m.system && !m.decision && words.some((w) => String(m.content ?? "").toLowerCase().includes(w)));
}

/**
 * The agent proposes; Carl decides. A card asks him ("Move this chat to X?" /
 * "Turn this into a new project 'X'?") and only his yes tags the conversation
 * (and creates the project). "Not now" is remembered on the conversation: no
 * second proposal until Carl brings a project up himself.
 */
async function setProjectTool(a: Record<string, unknown>, ctx: ToolContext): Promise<DynamicToolCallResponse> {
  const name = str(a.name);
  if (!name) return fail("SetProject needs a name.");
  if (!slugify(name)) return fail(`"${name}" does not make a project name.`);
  const existing = findProject(name);
  if (existing && ctx.conv.project === existing.slug) return attachedText(existing.slug, "This conversation is already in it.");
  const declined = ctx.conv.projectDeclined;
  if (declined && !carlAskedSince(ctx.conv, declined, name)) {
    return fail(`Carl said "Not now" to a project ("${declined.name}") for this conversation. Do not propose one again unless he asks; carry on without it.`);
  }
  if (!ctx.ask) return fail("SetProject needs Carl's yes, and he cannot be asked from here.");
  const question = existing ? `Move this chat to ${existing.name}?` : `Turn this into a new project "${name.trim()}"?`;
  const answer = String(await ctx.ask(question, existing ? ["Yes", "Not now"] : ["Create", "Not now"])).trim();
  if (!YES.test(answer)) {
    const mark = { name: existing?.name ?? name.trim(), at: ctx.conv.messages?.length ?? 0 };
    ctx.conv.projectDeclined = mark;
    await ctx.patchConversation?.({ projectDeclined: mark });
    return ok(
      `Carl answered: ${answer || "Not now"}. Nothing changed: the conversation stays ${ctx.conv.project ? `in ${ctx.conv.project}` : "without a project"}. Do not propose a project again unless he asks.`,
    );
  }
  const { project, created } = ensureProject(name, str(a.description) ?? "");
  await ctx.setConversationProject(project.slug);
  ctx.conv.project = project.slug;
  if (ctx.conv.projectDeclined) {
    ctx.conv.projectDeclined = undefined;
    await ctx.patchConversation?.({ projectDeclined: undefined });
  }
  return attachedText(project.slug, `Carl said yes. ${created ? "Created" : "Attached to"} project ${project.name} (${project.slug}); this conversation is tagged with it.`);
}

function attachedText(slug: string, head: string): DynamicToolCallResponse {
  const p = readProject(slug)!;
  return ok(
    `${head}\n\n` +
      `## project.md\n${cap(p.project, 4_000, 'ProjectMemory {action:"read", file:"project"}')}\n\n` +
      `## memory.md\n${cap(p.memory, 8_000, 'ProjectMemory {action:"read"}')}\n\n` +
      `## plan.md\n${cap(p.plan, 4_000, 'Plan {action:"read"}')}`,
  );
}

function projectMemoryTool(a: Record<string, unknown>, ctx: ToolContext): DynamicToolCallResponse {
  const slug = needProject(ctx);
  if (typeof slug !== "string") return slug;
  const file = (str(a.file) ?? "memory") as ProjectFile;
  if (!["memory", "project", "rules"].includes(file)) return fail(`file must be memory, project or rules`);
  const path = projectFilePath(slug, file);
  const doc = readOr(path);
  const section = str(a.section);
  const text = str(a.text);
  switch (a.action) {
    case "read": {
      if (section) {
        const body = getSection(doc, section);
        return body === null ? fail(`No "## ${section}" in ${file}.md.`) : ok(cap(body, READ_CAP, "the file is longer"));
      }
      return ok(doc.trim() ? cap(doc, READ_CAP, "the file is longer") : `(${file}.md is empty)`);
    }
    case "append": {
      if (!text) return fail("append needs text.");
      const next = section ? appendSection(doc, section, text) : `${doc.replace(/\s+$/, "")}${doc.trim() ? "\n" : ""}${text.trim()}\n`;
      writeFile(path, next);
      return ok(`Appended to ${file}.md${section ? ` § ${section}` : ""}.`);
    }
    case "update": {
      if (!section) return fail("update needs a section.");
      if (text === undefined && typeof a.text !== "string") return fail("update needs text.");
      writeFile(path, setSection(doc, section, typeof a.text === "string" ? a.text : ""));
      return ok(`Replaced ${file}.md § ${section}.`);
    }
    default:
      return fail("action must be read, append or update.");
  }
}

function planTool(a: Record<string, unknown>, ctx: ToolContext): DynamicToolCallResponse {
  const slug = needProject(ctx);
  if (typeof slug !== "string") return slug;
  const planPath = projectFilePath(slug, "plan");
  const progPath = projectFilePath(slug, "progress");
  if (a.action === "read") {
    return ok(
      `## plan.md\n${cap(readOr(planPath), READ_CAP, "plan.md is longer")}\n\n## progress.md\n${cap(readOr(progPath), READ_CAP, "progress.md is longer", "tail")}`,
    );
  }
  if (a.action !== "update") return fail("action must be read or update.");
  const done: string[] = [];
  if (typeof a.plan === "string") {
    writeFile(planPath, a.plan.replace(/\s+$/, "") + "\n");
    done.push("plan.md replaced");
  }
  if (typeof a.progress === "string") {
    writeFile(progPath, a.progress.replace(/\s+$/, "") + "\n");
    done.push("progress.md replaced");
  }
  const note = str(a.progressNote);
  if (note) {
    const cur = readOr(progPath).replace(/\s+$/, "");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    writeFile(progPath, `${cur}${cur ? "\n" : ""}- ${stamp} ${note.trim()}\n`);
    done.push("progress note added");
  }
  return done.length ? ok(done.join("; ") + ".") : fail("update needs plan, progress or progressNote.");
}
