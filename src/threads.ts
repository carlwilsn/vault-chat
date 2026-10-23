// One main conversation (reports/Continuous conversation SOTA research.md, Carl 2026-10-21).
//
// - Main: one persistent conversation, id "main", the default on every surface (laptop, popout,
//   phone, board voice). Every device and call continues it; compaction keeps it bounded.
// - A project's thread: one per project Carl makes, id "project-<slug>".
// - A separate chat: only when Carl asks for one ("New separate chat"); any other new id.
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
export type PanelConv = { id: string; title?: string; kind?: unknown; lastActivityAt?: number; running?: boolean; unread?: boolean; deleted?: boolean };

/** One row of the left panel. */
export type PanelEntry =
  | { type: "main"; id: string; title: string; active: boolean; running: boolean; unread: boolean }
  | { type: "project"; id: string; slug: string; title: string; active: boolean; running: boolean; unread: boolean }
  | { type: "new-project" };

/**
 * The left panel, the same on every surface: Main at the top, then the projects (each opens its
 * thread), then "+ New project". No list of chats: separate and older chats are in the menu
 * ("Older chats"), which `others` lists newest first.
 */
export function panelModel(convs: PanelConv[], projects: PanelProject[], activeId: string | null): { entries: PanelEntry[]; others: PanelConv[] } {
  const byId = new Map(convs.filter((c) => !c.deleted).map((c) => [c.id, c]));
  const main = byId.get(MAIN_ID);
  const entries: PanelEntry[] = [
    { type: "main", id: MAIN_ID, title: MAIN_TITLE, active: activeId === MAIN_ID, running: !!main?.running, unread: !!main?.unread && activeId !== MAIN_ID },
  ];
  const seen = new Set<string>();
  for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    const id = projectThreadId(p.slug);
    const c = byId.get(id);
    entries.push({ type: "project", id, slug: p.slug, title: p.name, active: activeId === id, running: !!c?.running, unread: !!c?.unread && activeId !== id });
  }
  entries.push({ type: "new-project" });
  const others = convs
    .filter((c) => !c.deleted && (threadKindOf(c) === "separate" || threadKindOf(c) === "older"))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return { entries, others };
}
