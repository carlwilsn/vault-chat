// The agent's own notes tools, under either viewer scope.
//
// Carl's notes are GLOBAL: one registry, read from the original files, with
// every note keeping the vault it came from. globalNotes.test.ts drove these
// tools through a real model turn in three vaults to prove it — and that turn
// never came back on the ship host (the reporter there drops a test's own
// output, so three runs said nothing), so those two lines were taken out with
// pi rather than left guessing. This is the same contract without a turn:
// server/notesTools.ts is the code the engine and the voice both call
// (engine.ts onToolCall → noteTool), so calling it per viewer IS the per-viewer
// scope. What a turn adds — that the model can reach them — is covered by the
// routes and by the /mcp catalogue.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault } from "./helpers";

const root = tmp("vcnotes-");
let home = "", a = "", b = "";
let noteTool: typeof import("../notesTools").noteTool;
let isNoteTool: typeof import("../notesTools").isNoteTool;

/** A note as the app writes one (src/notes.ts buildNote): the reader dedupes on
 *  its turns and anchors, so a hand-made stub without them is not a note. */
const seed = {
  id: "note-seeded-in-b",
  timestamp: "2026-11-01T10:00:00.000Z",
  last_updated: "2026-11-01T10:00:00.000Z",
  anchors: [],
  turns: [],
  user_draft: "SEEDED IN FIXTURE B",
  status: "open",
};

/** A second note in the same file that nothing in this test touches: its line
 *  must come out byte for byte (notesStorage.ts persistEdits promises that). */
const untouched = { ...{ ...seed }, id: "note-untouched-in-b", user_draft: "UNTOUCHED IN FIXTURE B" };

beforeAll(async () => {
  await import("../shims/globals");
  // The notes tools read and write through the box's own commands (src/notes.ts
  // → invoke("notes_read"/"notes_append")), so the registry has to be there, as
  // the running server sets it up.
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  home = makeVault(join(root, "home"));
  a = makeVault(join(root, "fixture-a"));
  b = makeVault(join(root, "fixture-b"));
  for (const v of [home, a, b]) mkdirSync(join(v, ".vault-chat"), { recursive: true });
  writeFileSync(join(b, ".vault-chat", "notes.jsonl"), JSON.stringify(seed) + "\n" + JSON.stringify(untouched) + "\n");
  // The registry the box runs with: one conversation root, the other vaults as
  // read-only compatibility sources (server/context/config.ts).
  const { configureContext } = await import("../context");
  configureContext({ vault: home, conversationRoot: home, vaults: () => [a, b] });
  ({ noteTool, isNoteTool } = await import("../notesTools"));
});

afterAll(() => cleanup(root));

const list = async (viewer: string, status = "all") => (await noteTool(viewer, "ListNotes", { status })).text;

describe("the notes tools, per viewer scope", () => {

  it("one note, the same under either viewer, read from the file it really lives in", async () => {
    // Whichever vault the request named, the agent sees the same note…
    for (const viewer of [home, a, b]) {
      const text = await list(viewer);
      expect(text, `viewer ${viewer}`).toContain(seed.id);
      expect(text, `viewer ${viewer}`).toContain("SEEDED IN FIXTURE B");
    }
    // …and nothing copied it: it is still only in b's own file.
    expect(readFileSync(join(b, ".vault-chat", "notes.jsonl"), "utf8")).toContain(seed.id);
    for (const v of [home, a]) {
      let text = "";
      try {
        text = readFileSync(join(v, ".vault-chat", "notes.jsonl"), "utf8");
      } catch {
        text = "";
      }
      expect(text, `${v} must not hold a copy`).not.toContain(seed.id);
    }
  });

  it("a note the agent writes under one viewer lands in the registry, and every viewer sees it", async () => {
    const made = await noteTool(a, "CreateNote", { text: "WRITTEN UNDER VIEWER A" });
    expect(made.ok, made.text).toBe(true);
    expect(made.wrote).toBe(true);
    // The registry's own file, not the viewer's: notes are global, and the
    // conversation root is the authority (never the viewer).
    expect(readFileSync(join(home, ".vault-chat", "notes.jsonl"), "utf8")).toContain("WRITTEN UNDER VIEWER A");
    for (const viewer of [home, a, b]) expect(await list(viewer), `viewer ${viewer}`).toContain("WRITTEN UNDER VIEWER A");
  });

  it("resolving under one viewer resolves it for every viewer, and leaves every other note's line alone", async () => {
    const done = await noteTool(home, "ResolveNote", { id: seed.id });
    expect(done.ok, done.text).toBe(true);
    for (const viewer of [home, a, b]) {
      expect(await list(viewer, "open"), `viewer ${viewer}`).not.toContain(seed.id);
      expect(await list(viewer, "resolved"), `viewer ${viewer}`).toContain(seed.id);
    }
    // The change is written into b's own file — the note never moved to the
    // viewer's — and the note beside it comes out byte for byte, which is what
    // notesStorage promises about a file Carl may also edit by hand.
    const lines = readFileSync(join(b, ".vault-chat", "notes.jsonl"), "utf8").split("\n").filter(Boolean);
    const resolved = lines.map((l) => JSON.parse(l)).find((n) => n.id === seed.id);
    expect(resolved.status).toBe("resolved");
    expect(lines).toContain(JSON.stringify(untouched));
  });

  it("every notes tool the engine routes is one of these, and nothing else is taken for one", () => {
    for (const n of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote"]) expect(isNoteTool(n), n).toBe(true);
    for (const n of ["ListProjects", "notes", "", "CreateNotes", "Note"]) expect(isNoteTool(n), n).toBe(false);
  });
});
