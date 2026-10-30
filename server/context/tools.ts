// The reading tools ENGINE exposes to the agent: ListProjects, and the other
// chats (ListConversations, ReadConversation: the "you" layer points at Carl's
// messages in other chats by title; their content is read only on request).
// Carl decides what is a project (the app's New project and move-to-project
// menu, or his own explicit ask, which the engine's OpenProject carries out:
// server/projectRoutes.ts); no tool here creates a project or moves a chat. The
// agent may still read and write a project's files (its project.md, anything
// in its folder) with its ordinary file tools.
import { conversationObjects as readConversationObjects } from "../engine/convs";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { allProjects, PROJECT_DIR, PROJECT_NOTES_FILE } from "./projects";
import { readOr, slugify } from "./files";
import { join } from "node:path";
import type { ContextConv, DynamicToolCallResponse, DynamicToolSpec, ToolContext } from "./types";

export const CONTEXT_TOOL_NAMES = ["ListProjects", "ListConversations", "ReadConversation"] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

export const contextToolSpecs: DynamicToolSpec[] = [
  {
    type: "function",
    name: "ListProjects",
    readOnly: true,
    description:
      "Carl's projects (folders of chats, each with an optional shared notes file, project.md) and the chats in each. Without `project`: every project with its chats' titles. With `project` (name or slug): its notes file and all its chats. Read-only: only Carl makes projects (in the app, or by asking you: OpenProject) and moves chats between them. You may read and edit a project's files (its project.md included) with your file tools.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "A project's name or slug." } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ListConversations",
    readOnly: true,
    description: "Carl's other chats, most recent first: id, title, project and when it was last active. The \"you\" layer points at his recent messages in them; read one with ReadConversation.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "ReadConversation",
    readOnly: true,
    description: "Read another chat's recent messages (Carl's and the agent's), by its id (from the \"you\" layer's pointer or ListConversations). Only when it matters for what Carl asks: another chat's content is not yours by default.",
    inputSchema: {
      type: "object",
      properties: { conversation_id: { type: "string" }, last_n: { type: "number", description: "How many recent messages (default 12, max 50)." } },
      required: ["conversation_id"],
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


/** ListProjects as text: the shared answer for pi and voice. `convs` defaults to every conversation in the vault. */
export function listProjectsText(project?: string | null, currentProject?: string | null, convs?: ContextConv[]): { ok: boolean; text: string } {
  const rows = chats(convs);
  const want = typeof project === "string" ? project.trim() : "";
  if (want) {
    const low = want.toLowerCase();
    const p = allProjects().find((x) => x.slug === slugify(want) || x.name.toLowerCase() === low);
    if (!p) return { ok: false, text: `No project "${want}". ListProjects without a name lists them.` };
    const memFile = join(p.folder, PROJECT_DIR, PROJECT_NOTES_FILE).split("\\").join("/");
    const notes = readOr(memFile);
    const mine = rows.filter((r) => r.project === p.slug);
    return {
      ok: true,
      text:
        `Project ${p.name} (${p.slug})${currentProject === p.slug ? " — this chat is in it" : ""}\n` +
        `Folder: ${p.folder.split("\\").join("/")} (its AGENTS.md: the instructions)\nMemory: ${memFile}${notes.trim() ? "" : " (empty or missing)"}\n\n` +
        (notes.trim() ? `${cap(notes, 20_000, "read the file for the rest")}\n\n` : "") +
        `Chats (${mine.length}):\n${mine.length ? mine.map((r) => `- "${r.title}" (${r.id})`).join("\n") : "(none yet)"}`,
    };
  }
  const all = allProjects();
  if (!all.length) return { ok: true, text: "Carl has no projects yet. Only he makes them: in the app, or by asking you (OpenProject)." };
  return {
    ok: true,
    text:
      `Carl's projects (only he makes them: in the app, or by asking you):\n` +
      all
        .map((p) => {
          const mine = rows.filter((r) => r.project === p.slug);
          const shown = mine.slice(0, 8).map((r) => `"${r.title}"`).join(", ");
          return `- ${p.name} (${p.slug}), the folder ${p.folder.split("\\").join("/")}${currentProject === p.slug ? " — this chat" : ""}: ${mine.length} chat(s)${shown ? `: ${shown}${mine.length > 8 ? ", …" : ""}` : ""}`;
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
    if (name === "ListConversations" || name === "ReadConversation") {
      const all = ((ctx.convs as any[] | undefined) ?? readConversationObjects(ctxConfig().vault)).filter((c: any) => typeof c?.id === "string" && c.id !== ctx.conv.id);
      const at = (c: any) => Number(c.lastActivityAt ?? c.updatedAt ?? c.createdAt ?? 0) || 0;
      if (name === "ListConversations") {
        const n = Math.min(Math.max(Number(a.limit) || 25, 1), 100);
        const rows = all.sort((x, y) => at(y) - at(x)).slice(0, n);
        return ok(rows.length ? rows.map((c) => `${c.id} — "${String(c.title ?? "").trim() || "(untitled)"}"${c.project ? ` (project ${c.project})` : ""}, last active ${new Date(at(c)).toISOString().slice(0, 16)}`).join("\n") : "(no other chats)");
      }
      const id = String(a.conversation_id ?? "").trim();
      const c = all.find((x) => x.id === id);
      if (!c) return fail(`No other chat with id "${id}". ListConversations lists them.`);
      const n = Math.min(Math.max(Number(a.last_n) || 12, 1), 50);
      const msgs = (Array.isArray(c.messages) ? c.messages : []).filter((m: any) => !m.hidden && (m.role === "user" || m.role === "assistant") && String(m.content ?? "").trim()).slice(-n);
      const body = msgs.map((m: any) => `[${m.role === "user" ? "Carl" : "agent"}] ${cap(String(m.content), 1500, "the rest is in that chat")}`).join("\n\n");
      return ok(`"${String(c.title ?? "").trim() || "(untitled)"}" (${c.id})\n\n${body || "(no messages)"}`);
    }
    return fail(`Unknown context tool ${name}`);
  } catch (e) {
    return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
