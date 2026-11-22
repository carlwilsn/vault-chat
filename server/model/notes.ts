// The notes noun (report 24 §4, noun 2): Carl's notes, the entries of his Notes panel (.vault-chat/notes.jsonl; the
// shape is src/noteTypes.ts). One registry on the box (server/notesStorage.ts: every note stays in the file it came from).
// State: the open and the resolved notes. Actions: add, edit (in place: never a second note to fix one), resolve, reopen,
// delete (as the panel's clear: it leaves every view, git history keeps it), clearResolved. The app's Notes panel and
// the phone call these through the box's /notes routes (server/http.ts), the agent through PluginAct {plugin: "box:notes"}.
// Each write is read back from the file and the result says only what the file now holds. A markdown write-up is a
// vault .md file, not a note.
import { buildNote, type Note } from "../../src/notes";
import { appendGlobalNote, globalNotes, onNotesChanged, writeGlobalNotes } from "../notesStorage";
import type { ActResult, Noun } from "./index";

export const NOTES_FILE = ".vault-chat/notes.jsonl";

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const one = (t: string, n: number) => {
  const x = t.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
};

/** A note's own text: what Carl typed (or the exchange it came from), not the cached summary. */
export function noteText(n: any): string {
  const draft = s(n?.user_draft).trim();
  if (draft) return draft;
  const turns = Array.isArray(n?.turns) ? n.turns.map((t: any) => s(t?.content)).join("\n").trim() : "";
  return turns || s(n?.formatted).trim();
}

const newest = (x: Note, y: Note) => (x.timestamp < y.timestamp ? 1 : -1);
const row = (n: Note, len: number) => ({
  id: n.id,
  at: s(n.timestamp).slice(0, 16),
  ...(n.title ? { title: one(s(n.title), 80) } : {}),
  text: one(noteText(n), len),
  ...(n.anchors?.[0]?.source_path ? { source: n.anchors[0].source_path } : {}),
});

/** The headless store keeps a copy of the main vault's notes (the phone's relay routes): reread it after a write. */
async function refreshStoreNotes(): Promise<void> {
  try {
    const st = (await import("../../src/store")).useStore.getState() as any;
    if (st.vaultPath && st.notesLoaded) await st.loadNotes?.();
  } catch {
    /* no store */
  }
}

const ID = { type: "object", properties: { id: { type: "string", description: "the note's id (from the state)" } }, required: ["id"], additionalProperties: false };

export function notesNoun(vault: string): Noun {
  const all = () => globalNotes(vault);
  const fail = (text: string): ActResult => ({ ok: false, text: `Error: ${text}` });
  const done = async (text: string): Promise<ActResult> => (await refreshStoreNotes(), { ok: true, text });
  const guard = async (what: string, f: () => Promise<ActResult>): Promise<ActResult> => {
    try {
      return await f();
    } catch (e) {
      return fail(`${what} failed: ${(e as Error)?.message ?? String(e)}; nothing was confirmed.`);
    }
  };
  /** One note to `status` (resolved, open, or cleared = deleted), read back. */
  const status = (want: "resolved" | "open" | "cleared", verb: string) => (a: Record<string, unknown>) =>
    guard(verb, async () => {
      const id = s(a.id).trim();
      const n = all().find((x) => x.id === id && (x.status !== "cleared" || want === "cleared"));
      if (!n) return fail(`no note with id "${id}" in ${NOTES_FILE}; nothing changed.`);
      if (n.status === want) return { ok: true, text: `Note ${id} is already ${want === "cleared" ? "deleted" : want}; nothing changed.` };
      writeGlobalNotes(vault, [{ ...n, status: want, last_updated: new Date().toISOString() }]);
      const after = all().find((x) => x.id === id);
      if (after?.status !== want) return fail(`note ${id} did not change in ${NOTES_FILE}; it is still ${after?.status ?? "missing"}.`);
      return done(`${verb} note ${id} in ${NOTES_FILE}.${want === "cleared" ? " It is gone from the Notes panel (git history keeps it)." : ""}`);
    });
  return {
    id: "notes",
    name: "Notes",
    state: {
      open: { description: "Carl's open notes (the Notes panel), newest first: {id, at, title?, text, source?}", read: () => all().filter((n) => n.status === "open").sort(newest).slice(0, 50).map((n) => row(n, 400)) },
      resolved: { description: "the newest 20 resolved notes", read: () => all().filter((n) => n.status === "resolved").sort(newest).slice(0, 20).map((n) => row(n, 160)) },
    },
    actions: {
      add: {
        description: "add a note (a short reminder or flag; a write-up is a vault .md file). To change a note, edit it: never add a second note to fix one",
        args: { type: "object", properties: { text: { type: "string", description: "the note" }, source_path: { type: "string", description: "a vault file it points at" } }, required: ["text"], additionalProperties: false },
        run: (a) =>
          guard("add", async () => {
            const text = s(a.text).trim();
            if (!text) return fail("add needs the note's text; nothing was saved.");
            const anchors = s(a.source_path) ? [{ source_path: s(a.source_path), source_kind: "code" as const, source_anchor: null, primary: true }] : [];
            const note = buildNote({ anchors, userDraft: text });
            appendGlobalNote(vault, note);
            if (!all().some((n) => n.id === note.id)) return fail(`the note was written but is not in ${NOTES_FILE} when read back; it was not saved.`);
            return done(`Saved note ${note.id} in your global notes (${NOTES_FILE} on the box): every vault's Notes reads this same note.`);
          }),
      },
      edit: {
        description: "replace a note's text in place",
        args: { type: "object", properties: { id: { type: "string", description: "the note's id" }, text: { type: "string", description: "its new text" } }, required: ["id", "text"], additionalProperties: false },
        run: (a) =>
          guard("edit", async () => {
            const id = s(a.id).trim();
            const text = s(a.text).trim();
            if (!text) return fail("edit needs the new text; nothing changed.");
            const n = all().find((x) => x.id === id && x.status !== "cleared");
            if (!n) return fail(`no note with id "${id}" in ${NOTES_FILE}; nothing changed.`);
            // The cached headline and summary were of the old text: dropped, the panel writes new ones.
            writeGlobalNotes(vault, [{ ...n, user_draft: text, turns: [], formatted: null, title: null, last_updated: new Date().toISOString() }]);
            const after = all().find((x) => x.id === id);
            if (!after || noteText(after) !== text) return fail(`note ${id} did not change in ${NOTES_FILE} when read back.`);
            return done(`Updated note ${id} in place in ${NOTES_FILE}. It now reads: ${one(text, 300)}`);
          }),
      },
      resolve: { description: "mark a note done (it moves to the resolved list)", args: ID, run: status("resolved", "Resolved") },
      reopen: { description: "open a resolved note again", args: ID, run: status("open", "Reopened") },
      delete: { description: "delete a note, as the panel's clear does (git history keeps it)", args: ID, run: status("cleared", "Deleted") },
      clearResolved: {
        description: "delete every resolved note, as the panel's Clear resolved does",
        run: () =>
          guard("clearResolved", async () => {
            const now = new Date().toISOString();
            const resolved = all().filter((n) => n.status === "resolved");
            if (!resolved.length) return { ok: true, text: "No resolved notes; nothing changed." };
            writeGlobalNotes(vault, resolved.map((n) => ({ ...n, status: "cleared" as const, last_updated: now })));
            const left = all().filter((n) => n.status === "resolved").length;
            if (left) return fail(`${left} resolved note(s) are still in ${NOTES_FILE} when read back.`);
            return done(`Cleared ${resolved.length} resolved note(s) from the Notes panel (git history keeps them).`);
          }),
      },
    },
    watch: (fn) => onNotesChanged(fn),
  };
}
