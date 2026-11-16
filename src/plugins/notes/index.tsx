// The Notes plugin (Stage 2, the first part of the app to become a plugin; src/appPlugins.ts NOTES_PLUGIN_ID): the
// Notes panel, mounted through the plugin host (src/mountHost.ts) with the widget contract mount(el, api). The app
// mounts it in its overlays (src/App.tsx, AppPluginMount); the supervisor's records turn it off or on there
// (a stopped plugin is unmounted: its React root and every listener of the panel go).
//
// Unchanged for Carl: the panel itself (NotesPanel.tsx), its data (.vault-chat/notes.jsonl through src/notes.ts and
// the store, and the box's sync of it), its Esc and its opening from the titlebar.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): its notes and its panel as readable state, add / edit /
// resolve / reopen / delete and the panel's open, close and view as actions, and a `changed` event. The agent reaches
// them through its generic PluginRead / PluginAct tools (server/pluginOffersTool.ts); nothing here is agent-specific.
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import type { HostApi } from "../../hostApi";
import type { Note } from "../../notes";
import { NotesPanel } from "./NotesPanel";
import { createNotesView, type NotesView } from "./view";

const one = (t: string, n: number) => {
  const x = t.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
};
/** A note's own text: what Carl typed (or the exchange it came from), else its summary. */
const textOf = (n: Note) => (n.user_draft ?? "").trim() || n.turns.map((t) => t.content).join("\n").trim() || (n.formatted ?? "").trim();
const row = (n: Note) => ({
  id: n.id,
  text: one(textOf(n), 400),
  ...(n.title ? { title: n.title } : {}),
  at: n.timestamp,
  ...(n.anchors[0]?.source_path ? { source: n.anchors[0].source_path } : {}),
});
const ID = { type: "object", properties: { id: { type: "string", description: "The note's id (from the notes state)." } }, required: ["id"], additionalProperties: false } as const;

function noteNamed(host: HostApi, id: unknown, want?: Note["status"][]): Note {
  const n = host.state().notes.find((x) => x.id === String(id ?? "") && x.status !== "cleared");
  if (!n) throw new Error(`no note with id "${String(id ?? "")}"`);
  if (want && !want.includes(n.status)) throw new Error(`note ${n.id} is ${n.status}`);
  return n;
}

/** The plugin's offers over the host API and its view state (exported for tests). */
export function notesOffers(host: HostApi, view: NotesView) {
  return {
    state: {
      notes: {
        description: "Every note in the Notes panel (.vault-chat/notes.jsonl), newest first: open and resolved, each {id, text, title?, at, source?}.",
        read: () => {
          const all = host.state().notes;
          return { open: all.filter((n) => n.status === "open").map(row), resolved: all.filter((n) => n.status === "resolved").map(row) };
        },
      },
      panel: {
        description: "The panel on Carl's screen: open or closed, which list it shows (active | resolved) and its search text.",
        read: () => ({ open: host.state().notesPanelOpen, ...view.get() }),
      },
    },
    actions: {
      add: {
        description: "Add a note (a short reminder or flag; a write-up is a vault .md file).",
        args: { type: "object", properties: { text: { type: "string" }, source_path: { type: "string", description: "Optional vault file the note points at." } }, required: ["text"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const r = await host.notes.add(String(a.text ?? ""), typeof a.source_path === "string" && a.source_path ? a.source_path : undefined);
          if (!r.ok) throw new Error(r.error ?? "the note was not saved");
          return { added: r.id };
        },
      },
      edit: {
        description: "Replace a note's text in place.",
        args: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const n = noteNamed(host, a.id);
          if (!String(a.text ?? "").trim()) throw new Error("edit needs the new text");
          await host.notes.saveDraft(n.id, String(a.text));
          return { edited: n.id };
        },
      },
      resolve: {
        description: "Mark a note done (it moves to the resolved list).",
        args: ID,
        run: async (a: Record<string, unknown>) => {
          const n = noteNamed(host, a.id, ["open"]);
          await host.notes.setStatus(n.id, "resolved");
          return { resolved: n.id };
        },
      },
      reopen: {
        description: "Open a resolved note again.",
        args: ID,
        run: async (a: Record<string, unknown>) => {
          const n = noteNamed(host, a.id, ["resolved"]);
          await host.notes.setStatus(n.id, "open");
          return { reopened: n.id };
        },
      },
      delete: {
        description: "Delete a note, as the panel's clear does (git history keeps it).",
        args: ID,
        run: async (a: Record<string, unknown>) => {
          const n = noteNamed(host, a.id);
          await host.notes.remove(n.id);
          return { deleted: n.id };
        },
      },
      open: {
        description: "Open the Notes panel on Carl's screen.",
        run: () => ({ open: host.runCommand("notes.open") }),
      },
      close: {
        description: "Close the Notes panel.",
        run: () => {
          host.panel.close();
          return { open: false };
        },
      },
      view: {
        description: "Set what the panel shows: filter (active | resolved) and/or search text; open: true also opens it.",
        args: {
          type: "object",
          properties: { filter: { type: "string", enum: ["active", "resolved"] }, query: { type: "string" }, open: { type: "boolean" } },
          additionalProperties: false,
        },
        run: (a: Record<string, unknown>) => {
          view.set({ ...(a.filter === "active" || a.filter === "resolved" ? { filter: a.filter } : {}), ...(typeof a.query === "string" ? { query: a.query } : {}) });
          if (a.open === true) host.runCommand("notes.open");
          return view.get();
        },
      },
    },
    events: {
      changed: { description: "The notes changed: {open, resolved} counts after the change." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  const view = createNotesView();
  const offers = api.offer(notesOffers(api.host, view));
  let last = api.host.state().notes;
  api.host.subscribe(() => {
    const now = api.host.state().notes;
    if (now === last) return;
    last = now;
    offers.emit("changed", { open: now.filter((n) => n.status === "open").length, resolved: now.filter((n) => n.status === "resolved").length });
  });
  // A render error the panel does not catch is the plugin's failure (its error card), not the app's.
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  root.render(<NotesPanel host={api.host} view={view} />);
  // The host may run this while the app's React is committing; a root is unmounted outside of that.
  return () => queueMicrotask(() => root.unmount());
}
