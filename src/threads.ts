// One main conversation (reports/Continuous conversation SOTA research.md, Carl 2026-10-21).
//
// - Main: one persistent conversation, id "main", the default on every surface (laptop, popout,
//   phone, board voice). Every device and call continues it; compaction keeps it bounded.
// - A project's thread: one per project Carl makes, id "project-<slug>".
// - A chat Carl started in a place ("New chat"): any other new id, `kind: "separate"`, with the
//   project it was started in (none: the vault's main). It is listed under that place.
// - Older chats: every conversation from before this model (no `kind`). Kept as they were,
//   readable, never listed in the panel: "Older chats" in its menu reaches them.
//
// The conversation's `kind` is a field of its feed (src/convlog/protocol.ts ConvMeta); the box
// sets it when it makes the conversation. Pure: the box, the laptop, the phone and the board use it.

export const MAIN_ID = "main";
export const MAIN_TITLE = "Main";
export const PROJECT_PREFIX = "project-";

export type ThreadKind = "main" | "project" | "separate";

/** A project's one thread. */
export function projectThreadId(slug: string): string {
  return `${PROJECT_PREFIX}${slug}`;
}

/** The project slug of a project thread's id, or null. */
export function projectOfThread(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(PROJECT_PREFIX)) return null;
  const slug = id.slice(PROJECT_PREFIX.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60 ? slug : null;
}

/** What a conversation is under this model: by its id first (Main and project threads are fixed), else its `kind`. */
export function threadKindOf(c: { id: string; kind?: unknown }): ThreadKind | "older" {
  if (c.id === MAIN_ID) return "main";
  if (projectOfThread(c.id)) return "project";
  if (c.kind === "separate") return "separate";
  return "older";
}

/** An older chat (from before one main conversation): readable, not continued. */
export function isOlderChat(c: { id: string; kind?: unknown }): boolean {
  return threadKindOf(c) === "older";
}

export type PanelProject = { slug: string; name: string };
export type PanelConv = { id: string; title?: string; kind?: unknown; project?: string | null; lastActivityAt?: number; running?: boolean; unread?: boolean; deleted?: boolean };

/** One chat inside a group (Carl's place: the vault's main, or a project). */
export type PanelChat = { id: string; title: string; active: boolean; running: boolean; unread: boolean; at: number };

/** Chats shown per step in a long list (src/ChatsPanel.tsx "Show more" / "Show all"). */
export const CHAT_PAGE = 5;

/**
 * The chats a place shows at an expansion level (0 = first 5, 1 = 10, 2 = all). The open chat and any chat
 * that is working or unseen stay visible even past the limit. `hidden`: how many are still hidden, `next`:
 * what the row says ("Show more" first, then "Show all"), null = no row. A place of 10 or fewer has one step.
 */
export function visibleChats(chats: PanelChat[], level: number): { shown: PanelChat[]; hidden: number; next: "more" | "all" | null } {
  const limit = level >= 2 || chats.length <= CHAT_PAGE ? chats.length : CHAT_PAGE * (level + 1);
  const shown = chats.filter((c, i) => i < limit || c.active || c.running || c.unread);
  const hidden = chats.length - shown.length;
  const next = hidden <= 0 ? null : level === 0 ? "more" : "all";
  return { shown, hidden, next };
}

/** One row of the left panel. A place holds its chats, newest first. */
export type PanelEntry =
  | { type: "main"; id: string; title: string; active: boolean; running: boolean; unread: boolean; chats: PanelChat[] }
  | { type: "project"; id: string; slug: string; title: string; active: boolean; running: boolean; unread: boolean; chats: PanelChat[] }
  | { type: "new-project" };

/** The chat a new one in this place would sit beside: the place's own thread. */
export function placeThreadId(place: { slug?: string | null } | null | undefined): string {
  return place?.slug ? projectThreadId(place.slug) : MAIN_ID;
}

/** Which place a conversation belongs to: a project's slug, or null for the vault's main. */
export function placeOf(c: PanelConv): string | null {
  return projectOfThread(c.id) ?? (typeof c.project === "string" && c.project ? c.project : null);
}

/**
 * The left panel, the same on every surface: the vault's main, then the projects, then
 * "+ New project". Each is a place that holds its chats — its own long-running conversation and
 * every chat Carl started there, newest first. `others` is what belongs to no place: the chats
 * from before this model, readable from the menu and never continued.
 */
export function panelModel(convs: PanelConv[], projects: PanelProject[], activeId: string | null): { entries: PanelEntry[]; others: PanelConv[] } {
  const live = convs.filter((c) => !c.deleted);
  const byId = new Map(live.map((c) => [c.id, c]));
  const chatsOf = (slug: string | null): PanelChat[] =>
    live
      // A project's own thread is not one of its chats in the list (Carl, 2026-11-08): it stays, and opens
      // when something takes him there (OpenProject, a call moving to the project), but the bar lists only the
      // chats he started in it.
      .filter((c) => threadKindOf(c) !== "older" && !projectOfThread(c.id) && placeOf(c) === slug)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .map((c) => ({
        id: c.id,
        title: chatTitle(c),
        active: activeId === c.id,
        running: !!c.running,
        unread: !!c.unread && activeId !== c.id,
        at: c.lastActivityAt ?? 0,
      }));
  const main = byId.get(MAIN_ID);
  const mainChats = chatsOf(null);
  const entries: PanelEntry[] = [
    {
      type: "main",
      id: MAIN_ID,
      title: MAIN_TITLE,
      active: mainChats.some((c) => c.active),
      running: !!main?.running || mainChats.some((c) => c.running),
      unread: mainChats.some((c) => c.unread),
      chats: mainChats,
    },
  ];
  const seen = new Set<string>();
  for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    const id = projectThreadId(p.slug);
    const chats = chatsOf(p.slug);
    // Its own thread, hidden from the chats, still says when the project works or is where he is.
    const thread = byId.get(id);
    entries.push({
      type: "project",
      id,
      slug: p.slug,
      title: p.name,
      active: activeId === id || chats.some((c) => c.active),
      running: !!thread?.running || chats.some((c) => c.running),
      unread: chats.some((c) => c.unread),
      chats,
    });
  }
  entries.push({ type: "new-project" });
  const others = live.filter((c) => threadKindOf(c) === "older").sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return { entries, others };
}

/** What a chat is called in the list: the place's own thread says so, else its title (the box
 *  takes that from the first message), else a plain fallback — never an id in front of Carl. */
export function chatTitle(c: PanelConv): string {
  if (c.id === MAIN_ID) return MAIN_TITLE;
  const t = (c.title ?? "").trim();
  if (t) return t;
  return projectOfThread(c.id) ? "This project" : "New chat";
}

/** The level a click on the row moves to: 5 more (10 in all), or everything when that is all there is. */
export function nextChatLevel(total: number, level: number): number {
  return level === 0 && total > CHAT_PAGE * 2 ? 1 : 2;
}
