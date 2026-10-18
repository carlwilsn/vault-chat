// The project tool ENGINE exposes to the agent: ListProjects, which only reads.
// Carl decides what is a project (the app's New project and move-to-project
// menu); no agent tool creates a project or moves a chat in or out of one. The
// agent may still read and write a project's files (its project.md, anything
// in its folder) with its ordinary file tools.
import { conversationObjects as readConversationObjects } from "../engine/convs";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { findProject, listProjects, projectNotesPath, readProject } from "./projects";
import { relative } from "node:path";
import type { ContextConv, DynamicToolCallResponse, DynamicToolSpec, ToolContext } from "./types";

export const CONTEXT_TOOL_NAMES = ["ListProjects"] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

export const contextToolSpecs: DynamicToolSpec[] = [
  {
    type: "function",
    name: "ListProjects",
    description:
      "Carl's projects (folders of chats, each with an optional shared notes file, project.md) and the chats in each. Without `project`: every project with its chats' titles. With `project` (name or slug): its notes file and all its chats. Read-only: only Carl makes projects and moves chats between them, in the app. You may read and edit a project's files (its project.md included) with your file tools.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "A project's name or slug." } },
      additionalProperties: false,
    },
  },
];

export function isContextTool(name: string): name is ContextToolName {
  return (CONTEXT_TOOL_NAMES as readonly string[]).includes(name);
}

function ok(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}
function fail(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}

type ChatRow = { id: string; title: string; project?: string; at: number };

function chats(given?: ContextConv[]): ChatRow[] {
  let all: any[] = given ?? [];
  if (!given) {
    try {
      all = readConversationObjects(ctxConfig().vault);
    } catch {
      all = [];
    }
  }
  return all
    .filter((c) => typeof c?.id === "string" && typeof c.project === "string" && c.project)
    .map((c) => ({ id: c.id, title: String(c.title ?? "").trim() || "(untitled)", project: c.project, at: Number(c.lastActivityAt ?? c.updatedAt ?? c.createdAt ?? 0) || 0 }))
    .sort((a, b) => b.at - a.at);
}

const rel = (p: string) => relative(ctxConfig().vault, p).split("\\").join("/");

/** ListProjects as text: the shared answer for pi and voice. `convs` defaults to every conversation in the vault. */
export function listProjectsText(project?: string | null, currentProject?: string | null, convs?: ContextConv[]): { ok: boolean; text: string } {
  const rows = chats(convs);
  const want = typeof project === "string" ? project.trim() : "";
  if (want) {
    const info = findProject(want);
    if (!info) return { ok: false, text: `No project "${want}". ListProjects without a name lists them.` };
    const p = readProject(info.slug)!;
    const mine = rows.filter((r) => r.project === info.slug);
    return {
      ok: true,
      text:
        `Project ${p.name} (${p.slug})${currentProject === p.slug ? " — this chat is in it" : ""}\n` +
        `Notes file: ${rel(projectNotesPath(p.slug))}${p.notes.trim() ? "" : " (empty or missing)"}\n\n` +
        (p.notes.trim() ? `${cap(p.notes, 20_000, "read the file for the rest")}\n\n` : "") +
        `Chats (${mine.length}):\n${mine.length ? mine.map((r) => `- "${r.title}" (${r.id})`).join("\n") : "(none yet)"}`,
    };
  }
  const all = listProjects();
  if (!all.length) return { ok: true, text: "Carl has no projects yet. Only he makes them, in the app." };
  return {
    ok: true,
    text:
      `Carl's projects (only he makes them and moves chats into them, in the app):\n` +
      all
        .map((p) => {
          const mine = rows.filter((r) => r.project === p.slug);
          const shown = mine.slice(0, 8).map((r) => `"${r.title}"`).join(", ");
          return `- ${p.name} (${p.slug})${currentProject === p.slug ? " — this chat" : ""}: ${mine.length} chat(s)${shown ? `: ${shown}${mine.length > 8 ? ", …" : ""}` : ""}`;
        })
        .join("\n"),
  };
}

/** Handle a context tool call (an engine tool call). Never throws. */
export async function handleContextTool(name: string, args: unknown, ctx: ToolContext): Promise<DynamicToolCallResponse> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  try {
    if (name === "ListProjects") {
      const r = listProjectsText(typeof a.project === "string" ? a.project : null, ctx.conv.project ?? null, ctx.convs);
      return r.ok ? ok(r.text) : fail(r.text);
    }
    return fail(`Unknown context tool ${name}`);
  } catch (e) {
    return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
