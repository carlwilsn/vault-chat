// The Notes plugin (Stage 2, the first part of the app to become a plugin; src/appPlugins.ts NOTES_PLUGIN_ID): the
// Notes panel, mounted through the plugin host (src/mountHost.ts) with the widget contract mount(el, api). The app
// mounts it in its overlays (src/App.tsx, AppPluginMount); the supervisor's records turn it off or on there
// (a stopped plugin is unmounted: its React root and every listener of the panel go).
//
// Unchanged for Carl: the panel itself (NotesPanel.tsx), its data (.vault-chat/notes.jsonl through src/notes.ts and
// the store, and the box's sync of it), its Esc and its opening from the titlebar.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the panel, its cards and the note composer as readable
// state and actions, and a `changed` event. The notes themselves are box:notes (one route; the panel's controls call it).
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import type { HostApi } from "../../hostApi";
import type { Note } from "../../notes";
import { NotesPanel } from "./NotesPanel";
import { createNotesView, type NotesView } from "./view";
import { discussNote } from "./NotesPanel";
import { noteIsSummarizable } from "../../notes";
import { addNoteAnchorAt, captureForNote, closeNoteComposer, noteComposerNow, openNoteComposer, removeNoteAnchor, removeNoteImage, saveNoteComposer, setNoteComposerText, useNoteComposer } from "../../noteComposer";

const ID = { type: "object", properties: { id: { type: "string", description: "The note's id (from the notes state)." } }, required: ["id"], additionalProperties: false } as const;

function noteNamed(host: HostApi, id: unknown, want?: Note["status"][]): Note {
  const n = host.state().notes.find((x) => x.id === String(id ?? "") && x.status !== "cleared");
  if (!n) throw new Error(`no note with id "${String(id ?? "")}"`);
  if (want && !want.includes(n.status)) throw new Error(`note ${n.id} is ${n.status}`);
  return n;
}

/** The plugin's offers over the host API and its view state (exported for tests). The notes themselves are the box's
 *  notes noun (box:notes: read, add, edit, resolve, reopen, delete, clear resolved), one route for the agent and the
 *  panel's controls alike; this part offers what is on Carl's screen: the panel, its cards, the note composer (Ctrl+N),
 *  and what only the laptop does with a note (regenerate its summary, discuss it in the chat, open its source). */
export function notesOffers(host: HostApi, view: NotesView) {
  const card = (id: unknown) => {
    const n = noteNamed(host, id);
    return n;
  };
  return {
    state: {
      panel: {
        description: "The panel on Carl's screen: open or closed, which list it shows (active | resolved), its search text, the card expanded, the card showing its raw note, the card being edited in place (id, text). The notes themselves: box:notes.",
        read: () => ({ open: host.state().notesPanelOpen, ...view.get() }),
      },
      composer: {
        description: "The note composer (Ctrl+N, a Ctrl+K box's save as note): open, its text, its anchors (path, anchor, primary, images captured) and the chat turns it carries.",
        read: () => noteComposerNow(),
      },
    },
    watch: (fn: () => void) => {
      const offs = [host.subscribe(fn), view.subscribe(fn), useNoteComposer.subscribe(fn)];
      return () => offs.forEach((f) => f());
    },
    actions: {
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
      expand: {
        description: "Expand a card (its summary, anchors and buttons), as clicking it; id null collapses. A note without a summary gets one written, as the click does.",
        args: { type: "object", properties: { id: { type: ["string", "null"] } }, required: ["id"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          if (a.id === null) return view.set({ expanded: null }), { expanded: null };
          const n = card(a.id);
          view.set({ expanded: n.id });
          if (!n.formatted && noteIsSummarizable(n)) host.notes.reformat(n.id);
          return { expanded: n.id };
        },
      },
      viewRaw: {
        description: "Show a card's raw note (its button), id null hides it.",
        args: { type: "object", properties: { id: { type: ["string", "null"] } }, required: ["id"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          view.set({ raw: a.id === null ? null : card(a.id).id });
          return { raw: view.get().raw };
        },
      },
      reformat: {
        description: "Regenerate a note's summary (the card's ↻): an AI call on the laptop rewrites its cached title and summary; its own text is unchanged.",
        args: ID,
        run: (a: Record<string, unknown>) => {
          const n = card(a.id);
          host.notes.reformat(n.id);
          return { reformatting: n.id };
        },
      },
      discuss: {
        description: "Discuss a note in the chat (the card's button): the open chat is primed with the note (no turn runs) and the panel closes. Only when Carl asks.",
        args: ID,
        run: async (a: Record<string, unknown>) => {
          const n = card(a.id);
          await discussNote(host, n);
          host.panel.close();
          return { discussing: n.id };
        },
      },
      openSource: {
        description: "Open a note's source in the viewer at its place (the card's file link).",
        args: ID,
        run: async (a: Record<string, unknown>) => {
          const n = card(a.id);
          const p = n.anchors.find((x) => x.primary) ?? n.anchors[0];
          if (!p?.source_path) throw new Error(`note ${n.id} points at no file`);
          await host.openFile(p.source_path, { anchor: p.source_anchor ?? undefined, origin: n.origin_vault });
          return { opened: p.source_path };
        },
      },
      editInPlace: {
        description: "Start editing a card in place (its Edit), set the text being edited, or stop (text left out and stop true). Saving is box:notes edit (the card's Save calls it).",
        args: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, stop: { type: "boolean" } }, required: ["id"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const n = card(a.id);
          if (a.stop === true) view.set({ editing: null });
          else view.set({ editing: { id: n.id, text: typeof a.text === "string" ? a.text : (n.user_draft ?? n.turns.map((t) => t.content).join("\n")) } });
          return { editing: view.get().editing };
        },
      },
      openComposer: {
        description: "Open the note composer (as Ctrl+N), with text and the open file as its anchor.",
        args: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          openNoteComposer({ text: typeof a.text === "string" ? a.text : undefined });
          return noteComposerNow();
        },
      },
      setComposerText: {
        description: "Set the open note composer's text.",
        args: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needComposer();
          setNoteComposerText(String(a.text ?? ""));
          return noteComposerNow();
        },
      },
      addComposerFile: {
        description: "Link another vault file or folder to the open note composer (its Link another file or folder).",
        args: { type: "object", properties: { path: { type: "string", description: "vault-relative" } }, required: ["path"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needComposer();
          if (!addNoteAnchorAt(String(a.path ?? ""))) throw new Error(`no file or folder "${String(a.path ?? "")}" in the vault`);
          return noteComposerNow();
        },
      },
      removeComposerFile: {
        description: "Remove an anchor from the open note composer (its ×), by its path as composer lists it.",
        args: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needComposer();
          removeNoteAnchor(String(a.path ?? ""));
          return noteComposerNow();
        },
      },
      removeComposerImage: {
        description: "Remove a captured picture from the open note composer: the anchor's path and the picture's index.",
        args: { type: "object", properties: { path: { type: "string" }, index: { type: "integer", minimum: 0 } }, required: ["path", "index"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needComposer();
          removeNoteImage(String(a.path ?? ""), Number(a.index));
          return noteComposerNow();
        },
      },
      captureForComposer: {
        description: "Capture region for the open note composer (its button): it hides while Carl drags a region in the viewer, then comes back with the picture.",
        run: () => {
          needComposer();
          captureForNote();
          return { capturing: true };
        },
      },
      saveComposer: {
        description: "Save the open note composer's note (its Save note: the notes noun's add on the box), and close it. Only when Carl asks.",
        run: async () => {
          needComposer();
          return { saved: await saveNoteComposer() };
        },
      },
      closeComposer: {
        description: "Close the note composer without saving (Esc, Cancel).",
        run: () => {
          closeNoteComposer();
          return { open: false };
        },
      },
    },
    events: {
      changed: { description: "The notes changed: {open, resolved} counts after the change." },
    },
  };
}

const needComposer = () => {
  if (!noteComposerNow().open) throw new Error("the note composer is not open (openComposer opens it)");
};

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
