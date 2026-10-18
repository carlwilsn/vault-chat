// The notes tools, one implementation for every surface: pi (engine.ts) and
// voice (voice.ts) call these. A note is an entry in the vault's Notes panel,
// `.vault-chat/notes.jsonl` (src/notes.ts has the shape); a markdown write-up is
// a vault .md file, not a note. Each write is read back from the file, and the
// result says only what the file now holds — the agent tells Carl only that.
// UpdateNote edits a note in place (Carl, summer: "NO! The LIST THE LIST YOU
// MADE", when a fix came as a second note). DeleteNote clears a note, as the
// Notes panel's clear does: it leaves every view, and git history keeps it.
import { resolve } from "node:path";

export const NOTES_FILE = ".vault-chat/notes.jsonl";
export const NOTE_TOOL_NAMES = ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote"] as const;
export type NoteToolName = (typeof NOTE_TOOL_NAMES)[number];

export function isNoteTool(name: string): name is NoteToolName {
  return (NOTE_TOOL_NAMES as readonly string[]).includes(name);
}

export type NoteResult = { ok: boolean; text: string; wrote: boolean };

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

/** The headless store keeps a copy of the main vault's notes (the phone's relay routes): reread it after a write. */
async function refreshStoreNotes(vault: string): Promise<void> {
  try {
    const st = (await import("../src/store")).useStore.getState() as any;
    if (st.vaultPath && resolve(st.vaultPath) === resolve(vault) && st.notesLoaded) await st.loadNotes?.();
  } catch {
    /* no store */
  }
}

/** Specs for the engine's tool list (the voice agent's are in src/voice-elevenlabs.ts, same names and arguments). */
export const noteToolSpecs = [
  {
    type: "function" as const,
    name: "ListNotes",
    description: `Carl's notes: the entries in his Notes panel (${NOTES_FILE}), newest first, each with its id, status and text. status: open (default), resolved or all.`,
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "resolved", "all"] }, limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "CreateNote",
    description: `Add a note to Carl's Notes panel (${NOTES_FILE}): a short reminder or flag. Not for write-ups: a "markdown file", "write-up" or anything "detailed" is a vault .md file. To change a note, use UpdateNote; never add a second note to fix one.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, source_path: { type: "string", description: "Optional vault file the note points at." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "UpdateNote",
    description: "Change a note's text in place (its id from ListNotes). The whole text is replaced with `text`.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
  },
  {
    type: "function" as const,
    name: "ResolveNote",
    description: "Mark a note done (it moves to the resolved list).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function" as const,
    name: "ReopenNote",
    description: "Open a resolved note again.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function" as const,
    name: "DeleteNote",
    description: "Delete a note from the Notes panel (as its clear does; git history keeps it).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
];

/** Run a notes tool on `vault`. Never throws: a failure is the result. `where` names the vault in a result ("the "main" vault's notes"). */
export async function noteTool(vault: string, name: NoteToolName, a: Record<string, unknown>, where = "the vault's notes"): Promise<NoteResult> {
  const notes = await import("../src/notes");
  const fail = (text: string): NoteResult => ({ ok: false, text: `Error: ${text}`, wrote: false });
  const done = async (text: string): Promise<NoteResult> => {
    await refreshStoreNotes(vault);
    return { ok: true, text, wrote: true };
  };
  try {
    switch (name) {
      case "ListNotes": {
        const status = s(a.status) || "open";
        const all: any[] = (await notes.readNotes(vault))
          .filter((n: any) => n.status !== "cleared" && (status === "all" || n.status === status))
          .sort((x: any, y: any) => (x.timestamp < y.timestamp ? 1 : -1));
        const shown = all.slice(0, Number(a.limit) || 50);
        if (!shown.length) return { ok: true, text: `No ${status === "all" ? "" : status + " "}notes in ${NOTES_FILE}.`, wrote: false };
        return {
          ok: true,
          wrote: false,
          text: `${all.length} note(s) in ${NOTES_FILE} (showing ${shown.length}):\n\n${shown
            .map((n) => `[${n.id}] ${n.status} · ${s(n.timestamp).slice(0, 16)}${n.title ? ` · ${one(s(n.title), 80)}` : ""}\n  ${one(noteText(n), 400)}`)
            .join("\n\n")}`,
        };
      }
      case "CreateNote": {
        const text = s(a.text).trim();
        if (!text) return fail("CreateNote needs the note's text; nothing was saved.");
        const anchors = s(a.source_path) ? [{ source_path: s(a.source_path), source_kind: "code" as const, source_anchor: (a.source_anchor as string) ?? null, primary: true }] : [];
        const note = notes.buildNote({ anchors, userDraft: text });
        try {
          await notes.appendNote(vault, note);
        } catch (e) {
          return fail(`the note was not saved: ${(e as Error)?.message ?? String(e)}`);
        }
        const saved = (await notes.readNotes(vault).catch(() => [])).some((n: any) => n.id === note.id);
        if (!saved) return fail(`the note was written but is not in ${NOTES_FILE} when read back; it was not saved.`);
        return done(`Saved note ${note.id} in ${where} (${NOTES_FILE} on the box): the phone's Notes show it now; the laptop gets it with its next sync with the box (within about a minute).`);
      }
      case "UpdateNote": {
        const id = s(a.id).trim();
        const text = s(a.text).trim();
        if (!text) return fail("UpdateNote needs the new text; nothing changed.");
        const all: any[] = await notes.readNotes(vault);
        const n = all.find((x) => x.id === id && x.status !== "cleared");
        if (!n) return fail(`no note with id "${id}" in ${NOTES_FILE}; nothing changed.`);
        const now = new Date().toISOString();
        // The cached headline and summary were of the old text: dropped, the panel writes new ones.
        await notes.writeAllNotes(vault, all.map((x) => (x.id === id ? { ...x, user_draft: text, turns: [], formatted: null, title: null, last_updated: now } : x)));
        const after = (await notes.readNotes(vault)).find((x: any) => x.id === id);
        if (!after || noteText(after) !== text) return fail(`note ${id} did not change in ${NOTES_FILE} when read back.`);
        return done(`Updated note ${id} in place in ${NOTES_FILE}. It now reads: ${one(text, 300)}`);
      }
      case "ResolveNote":
      case "ReopenNote":
      case "DeleteNote": {
        const want = name === "ResolveNote" ? "resolved" : name === "ReopenNote" ? "open" : "cleared";
        const id = s(a.id).trim();
        const all: any[] = await notes.readNotes(vault);
        const n = all.find((x) => x.id === id && (x.status !== "cleared" || want === "cleared"));
        if (!n) return fail(`no note with id "${id}" in ${NOTES_FILE}; nothing changed.`);
        if (n.status === want) return { ok: true, text: `Note ${id} is already ${want === "cleared" ? "deleted" : want}; nothing changed.`, wrote: false };
        const now = new Date().toISOString();
        await notes.writeAllNotes(vault, all.map((x) => (x.id === id ? { ...x, status: want, last_updated: now } : x)));
        const after = (await notes.readNotes(vault)).find((x: any) => x.id === id);
        if (after?.status !== want) return fail(`note ${id} did not change in ${NOTES_FILE}; it is still ${after?.status ?? "missing"}.`);
        const verb = want === "resolved" ? "Resolved" : want === "open" ? "Reopened" : "Deleted";
        return done(`${verb} note ${id} in ${NOTES_FILE}.${want === "cleared" ? " It is gone from the Notes panel (git history keeps it)." : ""}`);
      }
    }
  } catch (e) {
    return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}; nothing was confirmed.`);
  }
  return fail(`unknown notes tool ${name}.`);
}
