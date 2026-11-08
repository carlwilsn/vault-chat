// The folder a session ran in, and a vault that moves under it.
//
// Two things store one, and `master switch` (or `back`) moves the vault out from
// under both: Carl's older pi transcripts, which keep it in the session file's
// first line and are still read (server/convlog/piSession.ts), and the live
// engine's own record of every Claude Code thread (<state>/claude/threads.json).
// The live bug this came from, 2026-10-28: "Stored session working directory
// does not exist: /home/carlwilsn/vaults/school2".
//
// (The engine-resume case went with pi: there is no pi backend to resume. A
// Claude thread heals itself at the next turn, because the engine hands the
// thread's folder back on every resume — this is for the thread whose next turn
// has not come, and for transcripts nobody is resuming at all.)
import { describe, it, expect, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { appendEntries, newSessionFile } from "../convlog/piSession";

const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } }) as any;
const cwdOf = (f: string) => JSON.parse(readFileSync(f, "utf8").split("\n")[0]!).cwd;

describe("the folder a session ran in, when the vault moves under it", () => {
  const root = tmp("vcsp-");
  afterAll(() => cleanup(root));

  it("healSessionCwd: a stored folder that is gone, or under a root the sandbox empties, becomes the thread's folder now; a visible one stays", async () => {
    const { healSessionCwd } = await import("../sessionPaths");
    const now = join(root, "vc", "vaults", "school2");
    mkdirSync(now, { recursive: true });
    const f = newSessionFile(join(root, "s", "a.jsonl"), join(root, "gone", "school2"));
    appendEntries(f, [userEntry("hi")]);
    expect(healSessionCwd(f, now)).toBe(true);
    expect(cwdOf(f)).toBe(now);
    expect(readFileSync(f, "utf8")).toContain('"hi"');
    // Still on disk (the original is kept) but hidden in the sandbox (~/vaults is emptied there).
    const old = join(root, "vaults", "school2");
    mkdirSync(old, { recursive: true });
    const g = newSessionFile(join(root, "s", "b.jsonl"), old);
    expect(healSessionCwd(g, now, [join(root, "vaults")])).toBe(true);
    expect(cwdOf(g)).toBe(now);
    // There and visible: untouched.
    const other = join(root, "github", "x");
    mkdirSync(other, { recursive: true });
    const h = newSessionFile(join(root, "s", "c.jsonl"), other);
    expect(healSessionCwd(h, now, [join(root, "vaults")])).toBe(false);
    expect(cwdOf(h)).toBe(other);
  });

  it("a vault that moves: the live engine's record of every thread's folder is rewritten, however deep it sits", async () => {
    const { rewriteSessionPaths, stateSessionDirs, movePaths } = await import("../sessionPaths");
    const state = join(root, "state2");
    const from = join(root, "vc", "vaults", "school2");
    const to = join(root, "elsewhere", "school2");
    // Claude Code's record: a map of threads, each holding the folder its
    // session runs in. pi's was flat, so only the top level used to be read.
    const threads = join(state, "claude", "threads.json");
    mkdirSync(join(state, "claude"), { recursive: true });
    writeFileSync(
      threads,
      JSON.stringify({
        "cc-1": { sessionId: "s1", cwd: from, file: join(from, ".vault-chat", "events", "sessions", "cc-1.jsonl"), instructions: "x" },
        "cc-2": { sessionId: null, cwd: join(root, "github", "other"), file: join(root, "github", "other", "t.jsonl"), instructions: "y" },
      }),
    );
    // And a side thread's own session file, where pi's used to be.
    const side = join(state, "claude", "sessions");
    mkdirSync(side, { recursive: true });
    const sf = newSessionFile(join(side, "side.jsonl"), from);

    const dirs = stateSessionDirs(state);
    expect(dirs.instr, JSON.stringify(dirs)).toContain(join(state, "claude"));
    expect(dirs.sessions).toContain(side);
    const r = rewriteSessionPaths({ ...dirs, from, to });
    expect(r.records).toBe(1);
    expect(r.sessions).toBe(1);

    const after = JSON.parse(readFileSync(threads, "utf8"));
    expect(after["cc-1"].cwd).toBe(to);
    expect(after["cc-1"].file).toBe(join(to, ".vault-chat", "events", "sessions", "cc-1.jsonl"));
    expect(after["cc-1"].sessionId).toBe("s1");
    // A thread in a folder that did not move is left exactly as it was.
    expect(after["cc-2"].cwd).toBe(join(root, "github", "other"));
    expect(cwdOf(sf)).toBe(to);

    // Idempotent: running it again finds nothing to do.
    expect(rewriteSessionPaths({ ...dirs, from, to }).records).toBe(0);
    // And the helper itself leaves everything that is not under `from` alone.
    const { value, changed } = movePaths({ a: "no", b: { c: ["also no", from] } }, from, to);
    expect(changed).toBe(true);
    expect(value).toEqual({ a: "no", b: { c: ["also no", to] } });
    expect(movePaths({ a: 1, b: null, c: "x" }, from, to).changed).toBe(false);
  });
});
