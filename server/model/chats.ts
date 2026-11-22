// The chats noun (report 24 §4, noun 7, the last): Carl's chats and projects in every vault. Read: the chats newest
// first, one chat's recent messages, the projects (or one project's notes and chats), what is deleted. Act: what the
// chat list's own controls change (app/chats, src/plugins/chats: newChat = start, rename, renameProject, delete,
// restore), each through the same box path the app's intent takes, plus what only the agent does on Carl's ask:
// restoreProject, openProject (his screens and a live call follow to the thread) and post (hand work to the chat that
// owns it). Where the list is on screen (open, expand, Show more, the panel) stays app/chats: that is the laptop's view.
// Watched by re-reading every 2 s (a chat changes through each vault's own log, not one event).
// Was the ListConversations, ReadConversation, ListProjects, RenameConversation, DeleteConversation,
// RestoreConversation, RestoreProject, OpenProject and PostToConversation tools, and (piece D) Compact and Cost.
import type { ActResult, Noun } from "./index";

/** What the engine gives the noun for one asking conversation (`self`: its id, "" for an outside client). */
export type ChatsCtl = {
  self: string;
  list: (limit?: number) => Promise<string>;
  read: (id: string, lastN?: number) => Promise<ActResult>;
  projects: (project?: string) => Promise<ActResult>;
  deleted: () => string;
  start: (text: string, place?: string) => Promise<ActResult>;
  rename: (id: string, title?: string) => Promise<ActResult>;
  renameProject: (place: string, name: string) => Promise<ActResult>;
  delete: (ids: string[]) => Promise<ActResult>;
  restore: (id: string) => Promise<ActResult>;
  restoreProject: (project: string) => Promise<ActResult>;
  openProject: (args: Record<string, unknown>) => Promise<ActResult>;
  post: (id: string, text: string) => Promise<ActResult>;
  compact: (id?: string, focus?: string) => Promise<ActResult>;
  cost: (id?: string, project?: string) => Promise<ActResult>;
};

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const WATCH_MS = 2_000;

export function chatsNoun(ctl: ChatsCtl): Noun {
  return {
    id: "chats",
    name: "Chats",
    state: {
      recent: {
        description: "Carl's other chats in every vault, newest first (deleted ones left out): id — \"title\" · what it is (Main, a project's thread, a chat in a project, a loose chat, an older read-only one) · who named it, last active",
        read: () => ctl.list(25),
      },
      projects: {
        description: "his projects (folders of chats, each with its notes file project.md and its own thread project-<slug>) and their chats' titles",
        read: async () => (await ctl.projects()).text,
      },
    },
    actions: {
      list: {
        readOnly: true,
        description: "the chats, newest first: limit (default 25, max 100)",
        args: obj({ limit: { type: "number" } }),
        run: async (a) => ({ ok: true, text: await ctl.list(Number(a.limit) || undefined) }),
      },
      read: {
        readOnly: true,
        description: "another chat's recent messages (Carl's and the agent's), by its id (from the list or the \"you\" layer's pointer); only when it matters for what Carl asks",
        args: obj({ id: str("the chat's id"), last_n: { type: "number", description: "how many (default 12, max 50)" } }, ["id"]),
        run: (a) => ctl.read(s(a.id), Number(a.last_n) || undefined),
      },
      project: {
        readOnly: true,
        description: "one project: its folder, its notes file (project.md) and all its chats",
        args: obj({ project: str("its name or slug") }, ["project"]),
        run: (a) => ctl.projects(s(a.project)),
      },
      cost: {
        readOnly: true,
        description: "model spend in USD: this chat by default, another by id, or a project's total",
        args: obj({ id: str("a chat's id (default: this chat)"), project: str("a project's name or slug: its total") }),
        run: (a) => ctl.cost(s(a.id) || undefined, s(a.project) || undefined),
      },
      deleted: {
        readOnly: true,
        description: "what Carl deleted and restore / restoreProject can bring back: chats and projects, newest first",
        run: () => ({ ok: true, text: ctl.deleted() }),
      },
      start: {
        description: "start a new chat with a message (the list's New chat, then the first message): its own turn does the work and tells Carl. place: main (default) or a project",
        args: obj({ text: str("the whole message: the new chat has none of this context"), place: str('"main" or a project\'s name / slug') }, ["text"]),
        run: (a) => ctl.start(s(a.text), s(a.place) || undefined),
      },
      rename: {
        description: "name a chat, only when Carl asks; id left out: this chat; title left out: a fresh short summary written now. Main and a project's thread are named by their place",
        args: obj({ id: str("the chat's id (default: this chat)"), title: str("the name he wants") }),
        run: (a) => ctl.rename(s(a.id) || ctl.self, s(a.title) || undefined),
      },
      renameProject: {
        description: "rename a project (its name only; folder and chats stay), only when Carl asks",
        args: obj({ place: str("the project's name or slug"), name: str("the new name") }, ["place", "name"]),
        run: (a) => ctl.renameProject(s(a.place), s(a.name)),
      },
      delete: {
        description: "delete chats by id, only when Carl asks; recoverable with restore. Main, a project's thread and this chat are never deleted",
        args: obj({ ids: { type: "array", items: { type: "string" }, description: "the chats' ids" } }, ["ids"]),
        run: (a) => ctl.delete(Array.isArray(a.ids) ? a.ids.map(String) : typeof a.ids === "string" ? [a.ids] : []),
      },
      restore: {
        description: "bring back a deleted chat by its id (from deleted), only when Carl asks",
        args: obj({ id: str("the chat's id") }, ["id"]),
        run: (a) => ctl.restore(s(a.id)),
      },
      restoreProject: {
        description: "bring back a deleted project whole (folder, notes, memory, its thread), only when Carl asks; never move files out of agent-projects/.deleted yourself",
        args: obj({ project: str("its name, slug or deleted entry") }, ["project"]),
        run: (a) => ctl.restoreProject(s(a.project)),
      },
      openProject: {
        description: "only when Carl asks in so many words (\"start a project for HW4\": create true; \"let's work on Physics\"; \"back to Main\": project \"main\"): makes or finds it, and his screens and a live call move to its thread. request: what he asked to be done there (that thread does it, not you)",
        args: obj({ project: str("its name as Carl said it, or main"), create: { type: "boolean", description: "he asked to start (make) one" }, request: str("what he asked to be done there, in his words") }, ["project"]),
        run: (a) => ctl.openProject(a),
      },
      compact: {
        description: "compact a chat's context now (a summary of the earlier conversation; the raw history stays), only when Carl asks (\"compact\", \"/compact\", \"make the context smaller\"); it runs when the turn ends. focus: what the summary must keep",
        args: obj({ id: str("the chat (default: this chat)"), focus: str("what the summary must keep") }),
        run: (a) => ctl.compact(s(a.id) || undefined, s(a.focus) || undefined),
      },
      post: {
        description: "hand work to the chat that already owns it: posts a message there, which starts its own turn (it tells Carl itself; don't wait). Never this chat, never for something Carl should just be told (Notify)",
        args: obj({ id: str("the chat's id"), text: str("what that chat should do, in full") }, ["id", "text"]),
        run: (a) => ctl.post(s(a.id), s(a.text)),
      },
    },
    watch: (fn) => {
      const t = setInterval(fn, WATCH_MS);
      return () => clearInterval(t);
    },
  };
}
