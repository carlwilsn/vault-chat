// The chat list plugin (Stage 2, Track 1; src/appPlugins.ts CHATS_PLUGIN_ID): the list of places and chats
// (./ChatsList.tsx), mounted through the plugin host (src/mountHost.ts) with the widget contract mount(el, api), under the
// supervisor's records like Notes. Two surfaces, one plugin: `mount` is the overlay (the app mounts it with its overlays,
// src/ChatsPanel.tsx ChatsPanel) and `sidebar.mount` is fullscreen chat's left sidebar (ChatsSidebar). Both read and
// change the same state (the store, the places Carl opened in src/placeOpen.ts, the Show more levels in ./view.ts), so
// whichever instance answers the agent, the list on screen follows. If it fails or is turned off, src/ChatsPanel.tsx
// shows a minimal built-in list instead.
//
// Unchanged for Carl: the list itself, its data (the box's conversations and projects), its menus and its keys.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the places (each one's chats, open or shut, how far
// shown), the open chat and the panel as readable state; open a chat, expand / collapse a place, show more / less,
// new chat, rename, delete / restore and the panel's open / close as actions. The agent reaches them through PluginRead /
// PluginAct (server/pluginOffersTool.ts); nothing here is agent-specific.
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { listProjects, openThread, type ProjectInfo } from "../../projects";
import { newChatIn } from "../../chat-controller";
import { placeOpenChanged } from "../../placeOpen";
import { MAIN_ID, chatTitle, nextChatLevel, panelModel, projectOfThread, visibleChats, type PanelEntry } from "../../threads";
import { placeOpen, setPlaceOpen } from "../../placeOpen";
import { ChatsOverlay, ChatsSidebarView } from "./ChatsList";
import { chatLevels } from "./view";

type Place = Extract<PanelEntry, { type: "main" | "project" }>;
const S = () => useStore.getState();

/** The vault's projects as last read (the state's reads use it: they run on every change, the box's /projects is read
 *  again when a project changes, the vault changes, or an action asks). */
let projectsKept: { vault: string | null; list: ProjectInfo[] } | null = null;
async function projectsOf(fresh: boolean): Promise<ProjectInfo[]> {
  const v = S().vaultPath;
  if (!fresh && projectsKept && projectsKept.vault === v) return projectsKept.list;
  const list = await listProjects(v);
  projectsKept = { vault: v, list };
  return list;
}

/** The list as the screen builds it (src/threads.ts panelModel), with the vault's projects (read now when `fresh`). */
async function model(fresh = true): Promise<{ places: Place[]; projects: ProjectInfo[] }> {
  const s = S();
  const projects = await projectsOf(fresh);
  const { entries } = panelModel(
    s.conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind, project: c.project, lastActivityAt: c.lastActivityAt, running: c.status === "running", unread: c.unread })),
    projects,
    s.activeConversationId,
  );
  return { places: entries.filter((e): e is Place => e.type !== "new-project"), projects };
}

/** Whether a place shows its chats: Carl's own choice, else open where he is (ThreadRow's rule). */
const expanded = (p: Place) => placeOpen(S().vaultPath, p.id) ?? p.active;

/** The place a word names: "main", a project's slug, its name, or its thread's id. */
async function placeNamed(word: unknown): Promise<Place> {
  const w = String(word ?? "").trim();
  const { places } = await model();
  const lw = w.toLowerCase();
  const p =
    places.find((x) => x.id === w) ??
    places.find((x) => (x.type === "main" ? lw === "main" : x.slug === w)) ??
    places.find((x) => x.title.toLowerCase() === lw);
  if (!p) throw new Error(`no place "${w}" (places: ${places.map((x) => (x.type === "main" ? "main" : x.slug)).join(", ")})`);
  return p;
}

function chatNamed(id: unknown) {
  const want = String(id ?? "").trim();
  const c = S().conversations.find((x) => x.id === want);
  if (!c && want !== MAIN_ID && !projectOfThread(want)) throw new Error(`no chat with id "${want}" in the list`);
  return { id: want, title: c ? chatTitle(c) : undefined };
}

const PLACE = { type: "object", properties: { place: { type: "string", description: 'The place: "main", a project\'s slug or name (from the places state).' } }, required: ["place"], additionalProperties: false } as const;
const ID = { type: "object", properties: { id: { type: "string", description: "The chat's id (from the places state)." } }, required: ["id"], additionalProperties: false } as const;

const placeRow = (p: Place) => {
  const open = expanded(p);
  const v = visibleChats(p.chats, chatLevels.get(p.id));
  return {
    place: p.type === "main" ? "main" : p.slug,
    name: p.type === "main" ? "Main" : p.title,
    expanded: open,
    ...(p.active ? { here: true } : {}),
    ...(p.running ? { working: true } : {}),
    ...(p.unread ? { unseen: true } : {}),
    chats: p.chats.length,
    // What the list shows of it (when it is expanded): the first 5, 10 or all, and what the row under them says.
    shown: v.shown.map((c) => ({ id: c.id, title: c.title, ...(c.active ? { open: true } : {}), ...(c.running ? { working: true } : {}), ...(c.unread ? { unseen: true } : {}) })),
    showMore: v.next,
    hidden: v.hidden,
  };
};

/** The panel the list is in: the overlay in the docked layout, the sidebar in fullscreen chat. */
const panel = () => {
  const s = S();
  return s.chatFullscreen ? { surface: "sidebar", open: s.chatSidebarOpen } : { surface: "overlay", open: s.showChatsPanel };
};

/** The plugin's offers (exported for tests). */
export function chatsOffers() {
  return {
    watch: (fn: () => void) => {
      const onProjects = () => {
        projectsKept = null;
        fn();
      };
      const win = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
      win?.addEventListener("vc-projects-changed", onProjects);
      const offs = [useStore.subscribe(fn), chatLevels.subscribe(fn), placeOpenChanged(fn), () => win?.removeEventListener("vc-projects-changed", onProjects)];
      return () => offs.forEach((f) => f());
    },
    state: {
      places: {
        description:
          "Main and each project, in the list's order: place (main or the project's slug), name, expanded, here (the open chat is in it), working, unseen, chats (how many), shown (the chats the list shows when expanded, newest first: id, title, open?, working?, unseen?), showMore (what the row under them says: more | all | null) and hidden.",
        read: async () => (await model(false)).places.map(placeRow),
      },
      selected: {
        description: "The open chat: its id, title and place.",
        read: () => {
          const s = S();
          const id = s.activeConversationId;
          const c = s.conversations.find((x) => x.id === id);
          if (!id) return null;
          const slug = projectOfThread(id) ?? (c?.project || null);
          return { id, title: c ? chatTitle(c) : id === MAIN_ID ? "Main" : "", place: slug ?? "main" };
        },
      },
      panel: {
        description: "Where the list is on screen: surface (overlay in the docked layout, sidebar in fullscreen chat) and whether it is open.",
        read: panel,
      },
    },
    actions: {
      open: {
        description: "Open a chat (or a place's own thread: main, project-<slug>) in the chat pane, as a click on its row does.",
        args: ID,
        run: (a: Record<string, unknown>) => {
          const c = chatNamed(a.id);
          openThread(c.id, c.title);
          if (S().rightCollapsed && !S().chatFullscreen) S().toggleRight();
          return { open: S().activeConversationId };
        },
      },
      expand: {
        description: "Show a place's chats (the place's bar's chevron). Kept, as Carl's own click is.",
        args: PLACE,
        run: async (a: Record<string, unknown>) => {
          const p = await placeNamed(a.place);
          setPlaceOpen(S().vaultPath, p.id, true);
          return { expanded: true };
        },
      },
      collapse: {
        description: "Hide a place's chats (it also forgets its Show more).",
        args: PLACE,
        run: async (a: Record<string, unknown>) => {
          const p = await placeNamed(a.place);
          setPlaceOpen(S().vaultPath, p.id, false);
          chatLevels.delete(p.id);
          return { expanded: false };
        },
      },
      showMore: {
        description: "The place's Show more / Show all row: 5 more (10 in all), then all. Expands the place if it is shut.",
        args: PLACE,
        run: async (a: Record<string, unknown>) => {
          const p = await placeNamed(a.place);
          if (!expanded(p)) setPlaceOpen(S().vaultPath, p.id, true);
          const v = visibleChats(p.chats, chatLevels.get(p.id));
          if (!v.next) return { showMore: null, note: "every chat of this place is already shown" };
          chatLevels.set(p.id, nextChatLevel(p.chats.length, chatLevels.get(p.id)));
          return { showMore: visibleChats(p.chats, chatLevels.get(p.id)).next };
        },
      },
      showLess: {
        description: "Back to the short list (the first 5) for a place.",
        args: PLACE,
        run: async (a: Record<string, unknown>) => {
          const p = await placeNamed(a.place);
          chatLevels.delete(p.id);
          return { showMore: visibleChats(p.chats, 0).next };
        },
      },
      newChat: {
        description: "Start a fresh, empty chat on screen (a place's +, the footer's New chat): in a place, or left out where Carl is. It opens in the chat pane. Renaming, deleting and restoring chats and projects, and a new chat with a first message, are box:chats.",
        args: { type: "object", properties: { place: PLACE.properties.place }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const p = a.place === undefined ? null : await placeNamed(a.place);
          const id = newChatIn(p === null ? null : p.type === "project" ? p.slug : "main");
          if (S().rightCollapsed && !S().chatFullscreen) S().toggleRight();
          return { created: id, place: projectOfThread(id) ?? S().conversations.find((c) => c.id === id)?.project ?? "main" };
        },
      },
      openPanel: {
        description: "Open the list on screen: the overlay, or in fullscreen chat the sidebar.",
        run: () => {
          const s = S();
          if (s.chatFullscreen) {
            if (!s.chatSidebarOpen) s.toggleChatSidebar();
          } else s.setShowChatsPanel(true);
          return panel();
        },
      },
      closePanel: {
        description: "Close the list on screen.",
        run: () => {
          const s = S();
          if (s.chatFullscreen) {
            if (s.chatSidebarOpen) s.toggleChatSidebar();
          } else s.setShowChatsPanel(false);
          return panel();
        },
      },
    },
  };
}

/** The offers, headless: mounted in every layout (src/places.ts "offers"), the overlay or the sidebar drawn or not. */
export const offers = { mount: (_el: HTMLElement, api: PluginApi) => void api.offer(chatsOffers()) };

function mountSurface(el: HTMLElement, api: PluginApi, surface: "overlay" | "sidebar"): () => void {
  // A render error the list does not catch is the plugin's failure (src/ChatsPanel.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  root.render(surface === "overlay" ? <ChatsOverlay /> : <ChatsSidebarView />);
  // The host may run this while the app's React is committing; a root is unmounted outside of that.
  return () => queueMicrotask(() => root.unmount());
}

/** The overlay (the docked layout). */
export function mount(el: HTMLElement, api: PluginApi): () => void {
  return mountSurface(el, api, "overlay");
}

/** Fullscreen chat's (and the popout's) left sidebar. */
export const sidebar = { mount: (el: HTMLElement, api: PluginApi) => mountSurface(el, api, "sidebar") };
