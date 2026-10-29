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

  it("the engine's resume: a thread whose session stored a vanished folder resumes in the thread's folder instead of failing", async () => {
    await import("../shims/globals");
    const { PiBackend } = await import("../engine/pi/backend");
    const { piPaths } = await import("../engine/pi/config");
    const paths = piPaths(join(root, "state"));
    for (const d of [paths.sessionsDir, paths.instrDir]) mkdirSync(d, { recursive: true });
    const vault = join(root, "vc", "vaults", "school2");
    mkdirSync(vault, { recursive: true });
    const tid = "019a-main-thread";
    const file = newSessionFile(join(paths.sessionsDir, `2026-10-28T00-00-00_${tid}.jsonl`), "/home/nobody-here/vaults/school2");
    writeFileSync(join(paths.instrDir, `${tid}.json`), JSON.stringify({ instr: join(paths.instrDir, "x.md"), tools: "t.json", cwd: "/home/nobody-here/vaults/school2", subagents: false }));
    const be = new PiBackend({ install: { version: "t", cli: "pi.js", node: "node" } as any, paths, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [], roots: [] }, apiKey: () => null, thinking: "low", idleMs: 60_000, maxProcs: 4, subagents: {} as any, log: () => {} } as any);
    (be as any).currentTools = async () => [];
    const spawned: any[] = [];
    (be as any).spawn = async (o: any) => {
      spawned.push(o);
      const proc: any = new EventEmitter();
      proc.pid = 1;
      proc.isAlive = () => true;
      return { proc, id: tid, file };
    };
    await be.resumeThread(tid, { model: "m", subagents: false, cwd: vault });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe(vault);
    expect(spawned[0].file).toBe(file);
    expect(cwdOf(file)).toBe(vault);
    expect(JSON.parse(readFileSync(join(paths.instrDir, `${tid}.json`), "utf8")).cwd).toBe(vault);
  });
});
