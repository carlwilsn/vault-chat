// What box:chats reads (server/model/chats.ts, report 24 §4 noun 7): the projects (listProjectsText), the chats newest
// first (chatListText) and one chat's recent messages (readChatText). Carl decides what is a project (the app's New
// project and move-to-project menu, or his own explicit ask, which box:chats openProject carries out:
// server/projectRoutes.ts). Was the ListProjects, ListConversations and ReadConversation tools.
import { conversationObjects as readConversationObjects } from "../engine/convs";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { allProjects, PROJECT_DIR, PROJECT_NOTES_FILE } from "./projects";
import { readOr, slugify } from "./files";
import { basename, join } from "node:path";
import { threadKindOf } from "../../src/threads";
import type { ContextConv } from "./types";

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


/** The projects as text (box:chats). `convs` defaults to every conversation in the vault. */
export function listProjectsText(project?: string | null, currentProject?: string | null, convs?: ContextConv[]): { ok: boolean; text: string } {
  const rows = chats(convs);
  const want = typeof project === "string" ? project.trim() : "";
  if (want) {
    const low = want.toLowerCase();
    const p = allProjects().find((x) => x.slug === slugify(want) || x.name.toLowerCase() === low);
    if (!p) return { ok: false, text: `No project "${want}". box:chats projects lists them.` };
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
  if (!all.length) return { ok: true, text: "Carl has no projects yet. Only he makes them: in the app, or by asking you (box:chats openProject)." };
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

/** What a chat is, for box:chats: Main, a project's thread, a chat in a project, a loose chat, an older one. */
export function chatKind(c: { id: string; kind?: unknown; project?: unknown }): string {
  const k = threadKindOf(c);
  if (k === "main") return "Main";
  if (k === "project") return `project thread${c.project ? ` of ${String(c.project)}` : ""}`;
  if (k === "older") return "older chat (read-only)";
  return c.project ? `chat in project ${String(c.project)}` : "loose chat";
}

/** Who named it: Carl (by hand, or the agent on his ask), a summary, his first message, or its place. */
export function namedBy(c: { id: string; kind?: unknown; titleBy?: unknown }): string {
  const k = threadKindOf(c);
  if (k === "main" || k === "project") return "named by its place";
  if (c.titleBy === "carl") return "named by Carl";
  if (c.titleBy === "auto") return "summary title";
  return "his first message";
}

function chatLine(c: any, at: number, withVault: boolean): string {
  const title = String(c.title ?? "").trim() || "(untitled)";
  const vault = withVault && typeof c.vault === "string" && c.vault ? `, vault ${basename(c.vault)}` : "";
  return `${c.id} — "${title}" · ${chatKind(c)} · ${namedBy(c)}${vault}, last active ${new Date(at).toISOString().slice(0, 16)}`;
}

/** The chats newest first, the asking one (`self`) left out. */
export function chatListText(convs: ContextConv[] | undefined, self: string, limit?: number): string {
  const all = ((convs as any[] | undefined) ?? readConversationObjects(ctxConfig().vault)).filter((c: any) => typeof c?.id === "string" && c.id !== self);
  const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = all.sort((x, y) => at(y) - at(x)).slice(0, n);
  const vaults = new Set(all.map((c: any) => (typeof c.vault === "string" ? c.vault : "")).filter(Boolean));
  return rows.length ? rows.map((c) => chatLine(c, at(c), vaults.size > 1)).join("\n") : "(no other chats)";
}

/** Another chat's recent messages (Carl's and the agent's). */
export function readChatText(convs: ContextConv[] | undefined, self: string, id: string, lastN?: number): { ok: boolean; text: string } {
  const all = ((convs as any[] | undefined) ?? readConversationObjects(ctxConfig().vault)).filter((c: any) => typeof c?.id === "string" && c.id !== self);
  const c = all.find((x) => x.id === id);
  if (!c) return { ok: false, text: `No other chat with id "${id}". box:chats list lists them.` };
  const n = Math.min(Math.max(Number(lastN) || 12, 1), 50);
  const msgs = (Array.isArray(c.messages) ? c.messages : []).filter((m: any) => !m.hidden && (m.role === "user" || m.role === "assistant") && String(m.content ?? "").trim()).slice(-n);
  const body = msgs.map((m: any) => `[${m.role === "user" ? "Carl" : "agent"}] ${cap(String(m.content), 1500, "the rest is in that chat")}`).join("\n\n");
  return { ok: true, text: `"${String(c.title ?? "").trim() || "(untitled)"}" (${c.id})\n\n${body || "(no messages)"}` };
}

const at = (c: any) => Number(c.lastActivityAt ?? c.updatedAt ?? c.createdAt ?? 0) || 0;
