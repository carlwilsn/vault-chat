// The stored session folder of an OLD pi session. pi itself is gone, and with
// it the resume that used to heal one — but the rewrite still matters: a vault
// that moves must not leave Carl's old transcripts pointing at a path that no
// longer exists, and they are still read (server/convlog/piSession.ts).
//
// (The engine-resume case went with pi: there is no pi backend to resume.)
// pi's stored session folder (the live bug after the master switch, 2026-10-28: "Stored session working directory
// does not exist: /home/carlwilsn/vaults/school2"). pi keeps the folder a session ran in, in the session file's first
// line, and refuses to resume one whose folder is gone. server/sessionPaths.ts: master switch/back rewrite it (both
// ways, server/test/master.test.ts), and a resume heals one that is gone or hidden by the sandbox.
import { describe, it, expect, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { appendEntries, newSessionFile } from "../convlog/piSession";

const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } }) as any;
const cwdOf = (f: string) => JSON.parse(readFileSync(f, "utf8").split("\n")[0]!).cwd;

describe("pi's stored session folder", () => {
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

});
