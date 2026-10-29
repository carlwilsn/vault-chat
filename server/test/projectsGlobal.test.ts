// Projects are the machine's, not a vault's (Carl, 2026-10-28: "projects belong to vaults? I thought we decoupled
// them"; "a vault is my UI thing, projects are general machine path stuff"). In process:
//   - the feed: every vault's feed is its own log plus the projects home's (server/convlog/log.ts RoutedLog), one
//     sequence across both, so switching vaults leaves the project list and every project thread unchanged;
//   - the migration (server/projectsMigrate.ts) on a copy of a live-shaped layout: copy, verify, hide, and back;
//   - pi's stored session folder: healed at resume when it is gone or hidden (the live bug after the master switch).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { ConvLog, convLog, setProjectsHomeLog, _resetConvLogs, signal } from "../convlog/log";
import { appendEntries, newSessionFile } from "../convlog/piSession";

const fwd = (p: string) => p.split("\\").join("/");
const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });

describe("the feed: a vault's own conversations plus every project's thread, one sequence", () => {
  const root = tmp("vcpg-feed-");
  const A = join(root, "vaults", "school2");
  const B = join(root, "vaults", "physics");
  const P = join(root, "projects-home");
  beforeAll(() => {
    for (const v of [A, B]) mkdirSync(join(v, ".vault-chat"), { recursive: true });
    setProjectsHomeLog(P);
  });
  afterAll(() => {
    setProjectsHomeLog(null);
    _resetConvLogs();
    cleanup(root);
  });

  it("a project thread written through either vault lands in the projects home's log, the same from both; Main stays each vault's", () => {
    const sess = newSessionFile(join(root, "s", "optics.jsonl"), A);
    const [e1] = appendEntries(sess, [userEntry("from school2")]);
    convLog(A).emit("project-optics", { type: "meta", patch: { title: "Optics", kind: "project", project: "optics", createdAt: 1, lastActivityAt: 1 } });
    convLog(A).emit("project-optics", { type: "entry", file: sess, entry: e1! });
    const [e2] = appendEntries(sess, [userEntry("from physics")]);
    convLog(B).emit("project-optics", { type: "entry", file: sess, entry: e2! });
    convLog(A).emit("main", { type: "meta", patch: { title: "Main", kind: "main", createdAt: 1, lastActivityAt: 1 } });
    convLog(B).emit("main", { type: "meta", patch: { title: "Main", kind: "main", createdAt: 1, lastActivityAt: 1 } });
    convLog(B).emit("cphys", { type: "meta", patch: { title: "Physics chat", kind: "separate", createdAt: 1, lastActivityAt: 1 } });

    expect(readdirSync(join(P, ".vault-chat", "events"))).toContain("project-optics.jsonl");
    for (const v of [A, B]) expect(readdirSync(join(v, ".vault-chat", "events"))).not.toContain("project-optics.jsonl");
    const items = (v: string) => convLog(v).picture("project-optics")!.items.map((i: any) => [i.id, i.kind, i.text]);
    expect(items(A)).toEqual(items(B));
    expect(items(A)).toHaveLength(2);
    expect(convLog(A).ids().sort()).toEqual(["main", "project-optics"]);
    expect(convLog(B).ids().sort()).toEqual(["cphys", "main", "project-optics"]);
    // Switching vaults: the project rows are the same, only the vault's own chats differ.
    const proj = (v: string) => convLog(v).rows().filter((r) => r.id.startsWith("project-")).map((r) => [r.id, r.title]);
    expect(proj(B)).toEqual(proj(A));
  });

  it("/poll after N is exact across both logs: strictly increasing seqs, a project's records and signals in every vault's, a vault's own only in its own", () => {
    const a0 = convLog(A).latest();
    const b0 = convLog(B).latest();
    convLog(B).emit("cphys", { type: "meta", patch: { lastActivityAt: 2 } });
    convLog(A).emit("project-optics", { type: "meta", patch: { lastActivityAt: 3 } });
    signal(B, { type: "project", slug: "optics", renamed: "Optics II" });
    signal(A, { type: "vault_changed" });
    const fromA = convLog(A).after(a0).events;
    const fromB = convLog(B).after(b0).events;
    for (const evs of [fromA, fromB]) expect(evs.map((e) => e.seq)).toEqual([...evs.map((e) => e.seq)].sort((x, y) => x - y));
    expect(fromA.map((e) => e.conv ?? (e as any).signal.type)).toEqual(["project-optics", "project", "vault_changed"]);
    expect(fromB.map((e) => e.conv ?? (e as any).signal.type)).toEqual(["cphys", "project-optics", "project"]);
    // One cursor works in both: the head is the highest seq of either log.
    expect(convLog(A).latest()).toBe(convLog(B).latest() + 1);
    expect(convLog(A).after(convLog(A).latest()).events).toEqual([]);
    // Small pages stay exact (a side cut short is never skipped past).
    const all: number[] = [];
    let cur = 0;
    for (let i = 0; i < 50; i++) {
      const r = convLog(B).after(cur, 2);
      all.push(...r.events.map((e) => e.seq));
      cur = r.next;
      if (!r.more) break;
    }
    expect(all).toEqual(convLog(B).after(0).events.map((e) => e.seq));
  });

  it("after a restart (the logs closed, reopened in another order) a seq is never handed out below one a client saw", () => {
    const seen = Math.max(convLog(A).latest(), convLog(B).latest());
    _resetConvLogs();
    // A vault opened late after a restart: its first record is still above everything before.
    const r = convLog(P).emit("project-optics", { type: "meta", patch: { lastActivityAt: 4 } });
    expect(r.seq).toBeGreaterThan(seen);
    const r2 = convLog(B).emit("cphys", { type: "meta", patch: { lastActivityAt: 5 } });
    expect(r2.seq).toBeGreaterThan(r.seq);
    expect(convLog(B).after(seen).events.map((e) => e.seq)).toEqual([r.seq, r2.seq]);
  });

  it("the merged feed has its own identity: a cursor of a vault's log alone (from before projects moved) starts over", () => {
    expect(convLog(A).epoch).toContain(".");
    expect(convLog(A).epoch).not.toBe(convLog(B).epoch);
    expect(convLog(A).epoch.split(".")[1]).toBe(convLog(B).epoch.split(".")[1]);
  });
});

describe("migration (server/projectsMigrate.ts) on a copy of a live-shaped layout", () => {
  const root = tmp("vcpg-mig-");
  const vault = join(root, "vc", "vaults", "school2");
  const home = join(root, "vc", ".projects");
  const state = join(root, "state");
  const piS = join(state, "pi", "sessions");
  const piI = join(state, "pi", "instr");
  const code = join(root, "vc", "projects", "vault-chat");
  const ev = join(vault, ".vault-chat", "events");
  let original: { items: string; folders: Record<string, unknown> };

  beforeAll(() => {
    _resetConvLogs();
    setProjectsHomeLog(null);
    for (const d of [ev, piS, piI, join(vault, "courses", "psych221"), code, join(vault, ".vault-chat", "local")]) mkdirSync(d, { recursive: true });
    const put = (rel: string, s: string) => {
      mkdirSync(join(vault, rel, ".."), { recursive: true });
      writeFileSync(join(vault, rel), s);
    };
    put("agent-projects/vault-chat/project.md", "# vault-chat\n\nThin layer over pi.\n\n## Memory\n\n- 2026-10-27: roleplay runs on the box\n");
    put("agent-projects/psych-221/project.md", "---\nfolder: courses/psych221\n---\n# Psych 221\n\nAPA style.\n");
    put("agent-projects/psych-221/rules.md", "- Cite every source.\n");
    put("agent-projects/.deleted/optics-20261020-101010/project.md", "# Optics\n");
    writeFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), JSON.stringify({ folders: { "vault-chat": { path: code, at: "2026-10-27T00:00:00Z" } }, deleted: {} }));
    // The vault-chat project's thread: its pi session in the engine's sessions folder, in the vault's own log.
    const log = new ConvLog(vault, null, ev);
    const tid = "019a-thread-vc";
    const sfile = newSessionFile(join(piS, `2026-10-27T10-00-00_${tid}.jsonl`), code);
    const entries = appendEntries(sfile, [userEntry("fix the phone list"), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fixed: the list scrolls." }], timestamp: Date.now() } } as any]);
    log.emit("project-vault-chat", { type: "meta", patch: { title: "vault-chat", kind: "project", project: "vault-chat", createdAt: 1, lastActivityAt: 1, threadId: tid, threadPath: sfile } });
    for (const e of entries) log.emit("project-vault-chat", { type: "entry", file: sfile, entry: e });
    // A line with no pi session (the feed's own session file, relative to the log).
    const own = log.ownSession("project-vault-chat");
    newSessionFile(own, vault);
    const [n] = appendEntries(own, [{ type: "custom", customType: "vc-note", data: { kind: "notice", text: "Voice session ended." } } as any]);
    log.emit("project-vault-chat", { type: "entry", file: own, entry: n! });
    log.emit("main", { type: "meta", patch: { title: "Main", kind: "main", createdAt: 1, lastActivityAt: 1 } });
    writeFileSync(join(piI, `${tid}.json`), JSON.stringify({ instr: join(piI, "x.md"), tools: "t.json", cwd: code, subagents: true }));
    original = { items: JSON.stringify(log.picture("project-vault-chat")!.items.map((i: any) => [i.id, i.kind, i.text])), folders: JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), "utf8")).folders };
  });
  afterAll(() => cleanup(root));

  const run = async (dryRun: boolean) => {
    const { migrateProjects } = await import("../projectsMigrate");
    return migrateProjects({ home, vaults: [{ path: vault, piSessions: piS, piInstr: piI }], mainInstr: piI, mainVault: vault, dryRun, log: () => {} });
  };

  it("--dry-run reports what would move and changes nothing", async () => {
    const before = readdirSync(join(vault, "agent-projects")).sort();
    const r = await run(true);
    expect(r.moved.map((m) => m.deleted ?? m.slug).sort()).toEqual(["optics-20261020-101010", "psych-221", "vault-chat"]);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(join(vault, "agent-projects")).sort()).toEqual(before);
  });

  it("copies every project, its folder, its deleted ones and its thread; verifies; hides the originals out of git", async () => {
    const r = await run(false);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(home, "vault-chat", "project.md"), "utf8")).toContain("- 2026-10-27: roleplay runs on the box");
    expect(readFileSync(join(home, "psych-221", "rules.md"), "utf8")).toBe("- Cite every source.\n");
    expect(existsSync(join(home, ".deleted", "optics-20261020-101010", "project.md"))).toBe(true);
    // The folders: the registry's, and a project.md `folder:` inside the vault as its absolute path.
    const reg = JSON.parse(readFileSync(join(home, ".vault-chat", "local", "project-folders.json"), "utf8")).folders;
    expect(reg["vault-chat"].path).toBe(code);
    expect(reg["psych-221"].path).toBe(join(vault, "courses", "psych221"));
    // The thread: in the home's log, its pi session copied with the project, the same items.
    expect(readdirSync(join(home, ".vault-chat", "sessions"))).toEqual([expect.stringMatching(/_019a-thread-vc\.jsonl$/)]);
    const L = new ConvLog(home, null, join(home, ".vault-chat", "events"));
    const pic = L.picture("project-vault-chat")!;
    expect(JSON.stringify(pic.items.map((i: any) => [i.id, i.kind, i.text]))).toBe(original.items);
    expect(pic.items.map((i: any) => i.text)).toEqual(expect.arrayContaining(["fix the phone list", "Fixed: the list scrolls."]));
    expect(fwd(String(pic.meta.threadPath))).toContain(fwd(join(home, ".vault-chat", "sessions")));
    expect(L.ids()).toEqual(["project-vault-chat"]);
    // The vault: no agent-projects/, no project thread, its Main as it was; the originals kept out of git.
    expect(existsSync(join(vault, "agent-projects"))).toBe(false);
    expect(readdirSync(ev).filter((f) => f.startsWith("project-"))).toEqual([]);
    expect(readdirSync(ev)).toContain("main.jsonl");
    const hidden = r.hiddenAt[vault]!;
    expect(fwd(hidden)).toContain("/.vault-chat/local/moved-projects/");
    expect(readdirSync(join(hidden, "agent-projects")).sort()).toEqual([".deleted", "psych-221", "vault-chat"]);
    expect(readdirSync(join(hidden, "events"))).toContain("project-vault-chat.jsonl");
    // The original pi session is untouched.
    expect(readdirSync(piS)).toHaveLength(1);
  });

  it("the moved projects are what the server lists and runs: the same from every vault", async () => {
    const { configureContext, listProjects, readProject } = await import("../context");
    configureContext({ vault, projectsHome: home });
    expect(listProjects().map((p) => p.slug)).toEqual(["psych-221", "vault-chat"]);
    expect(readProject("psych-221")!.rules).toBe("- Cite every source.\n");
    const { projectFolderOf, setFolderWalls } = await import("../projectFolders");
    setFolderWalls({ home: root, protect: () => [state], vaults: () => [vault] });
    expect(projectFolderOf("psych-221")).toEqual({ abs: join(vault, "courses", "psych221") });
    setFolderWalls(null);
    setProjectsHomeLog(home);
    expect(convLog(vault).ids().sort()).toEqual(["main", "project-vault-chat"]);
    setProjectsHomeLog(null);
    _resetConvLogs();
  });

  it("again is a no-op (nothing left in the vault); back puts everything where it was, the home's copies set aside", async () => {
    const again = await run(false);
    expect(again.moved).toEqual([]);
    const { migrateBack } = await import("../projectsMigrate");
    const b = migrateBack({ home, log: () => {} });
    expect(b.problems).toEqual([]);
    expect(readdirSync(join(vault, "agent-projects")).sort()).toEqual([".deleted", "psych-221", "vault-chat"]);
    expect(readdirSync(ev)).toContain("project-vault-chat.jsonl");
    expect(JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), "utf8")).folders).toEqual(original.folders);
    expect(readdirSync(home).filter((n) => !n.startsWith("."))).toEqual([]);
    const log = new ConvLog(vault, null, ev);
    expect(JSON.stringify(log.picture("project-vault-chat")!.items.map((i: any) => [i.id, i.kind, i.text]))).toBe(original.items);
  });
});

describe("pi's stored session folder (the live bug: 'Stored session working directory does not exist')", () => {
  const root = tmp("vcpg-cwd-");
  afterAll(() => cleanup(root));

  it("healSessionCwd: a stored folder that is gone, or under a root the sandbox empties, becomes the thread's folder now; a visible one stays", async () => {
    const { healSessionCwd } = await import("../sessionPaths");
    const now = join(root, "vc", "vaults", "school2");
    mkdirSync(now, { recursive: true });
    const old = join(root, "vaults", "school2");
    const f = newSessionFile(join(root, "s", "a.jsonl"), join(root, "gone", "school2"));
    appendEntries(f, [userEntry("hi")]);
    expect(healSessionCwd(f, now)).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8").split("\n")[0]!).cwd).toBe(now);
    expect(readFileSync(f, "utf8")).toContain('"hi"');
    // Still on disk (the original is kept) but hidden in the sandbox (~/vaults is emptied there).
    mkdirSync(old, { recursive: true });
    const g = newSessionFile(join(root, "s", "b.jsonl"), old);
    expect(healSessionCwd(g, now, [join(root, "vaults")])).toBe(true);
    expect(JSON.parse(readFileSync(g, "utf8").split("\n")[0]!).cwd).toBe(now);
    // A stored folder that is there and visible: untouched (a project that moved folder on purpose keeps its record).
    const other = join(root, "github", "x");
    mkdirSync(other, { recursive: true });
    const h = newSessionFile(join(root, "s", "c.jsonl"), other);
    expect(healSessionCwd(h, now, [join(root, "vaults")])).toBe(false);
    expect(JSON.parse(readFileSync(h, "utf8").split("\n")[0]!).cwd).toBe(other);
  });

  it("the engine's resume: a thread whose session stored a vanished folder resumes in the current vault instead of failing", async () => {
    await import("../shims/globals");
    const { PiBackend } = await import("../engine/pi/backend");
    const { piPaths } = await import("../engine/pi/config");
    const paths = piPaths(join(root, "state"));
    for (const d of [paths.sessionsDir, paths.instrDir]) mkdirSync(d, { recursive: true });
    const vault = join(root, "vc", "vaults", "school2");
    const tid = "019a-main-thread";
    const file = newSessionFile(join(paths.sessionsDir, `2026-10-28T00-00-00_${tid}.jsonl`), "/home/carlwilsn/vaults/school2");
    writeFileSync(join(paths.instrDir, `${tid}.json`), JSON.stringify({ instr: join(paths.instrDir, "x.md"), tools: "t.json", cwd: "/home/carlwilsn/vaults/school2", subagents: false }));
    const be = new PiBackend({ install: { version: "t", cli: "pi.js", node: "node" } as any, paths, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [], roots: [] }, apiKey: () => null, thinking: "low", idleMs: 60_000, maxProcs: 4, subagents: {} as any, log: () => {} });
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
    expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).cwd).toBe(vault);
    expect(JSON.parse(readFileSync(join(paths.instrDir, `${tid}.json`), "utf8")).cwd).toBe(vault);
  });
});

describe("migration of a project from a second vault (the live shape: vault-chat in ~/vc/vaults/vault-chat)", () => {
  const root = tmp("vcpg-mig2-");
  const main = join(root, "vc", "vaults", "school2");
  const second = join(root, "vc", "vaults", "vault-chat");
  const home = join(root, "vc", ".projects");
  const code = join(root, "vc", "projects", "vault-chat");
  const st = join(root, "state");
  const mainPi = { s: join(st, "pi", "sessions"), i: join(st, "pi", "instr") };
  const secPi = { s: join(st, "vaults", "vault-chat", "pi", "sessions"), i: join(st, "vaults", "vault-chat", "pi", "instr") };
  const area = (v: string) => join(root, "agent-work", basename(v));
  const oldClone = join(area(second), "changes", "vault-chat");
  const newClone = join(area(main), "changes", "vault-chat");
  const tid = "019a-vc-roleplay";

  beforeAll(() => {
    _resetConvLogs();
    setProjectsHomeLog(null);
    for (const d of [join(main, ".vault-chat", "local"), join(second, ".vault-chat", "local"), join(second, "agent-projects", "vault-chat"), code, mainPi.s, mainPi.i, secPi.s, secPi.i, join(oldClone, "src")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(second, "agent-projects", "vault-chat", "project.md"), "# vault-chat\n\n## Memory\n\n- 2026-10-28: the roleplay is on\n");
    writeFileSync(join(second, ".vault-chat", "local", "project-folders.json"), JSON.stringify({ folders: { "vault-chat": { path: code, at: "2026-10-28T04:39:01Z" } }, deleted: {} }));
    // The agent's clone with its work in progress (an uncommitted file), and a change waiting for Keep.
    writeFileSync(join(oldClone, "src", "wip.ts"), "export const wip = 1;\n");
    mkdirSync(join(second, ".vault-chat", "proof", "call_1"), { recursive: true });
    writeFileSync(join(second, ".vault-chat", "proof", "call_1", "1-shot.png"), "PNG");
    writeFileSync(join(second, ".vault-chat", "local", "reviews.json"), JSON.stringify({ "project-vault-chat": { convId: "project-vault-chat", slug: "vault-chat", folder: code, clone: oldClone, base: "main", branch: "agent/x", sha: "abc", title: "t", at: "x" } }));
    const sfile = newSessionFile(join(secPi.s, `2026-10-28T05-00-00_${tid}.jsonl`), oldClone);
    const entries = appendEntries(sfile, [userEntry("roleplay: fix it")]);
    const log = new ConvLog(second, null, join(second, ".vault-chat", "events"));
    log.emit("project-vault-chat", { type: "meta", patch: { title: "vault-chat", kind: "project", project: "vault-chat", createdAt: 1, lastActivityAt: 1, threadId: tid, threadPath: sfile } });
    log.emit("project-vault-chat", { type: "entry", file: sfile, entry: entries[0]! });
    writeFileSync(join(secPi.i, "inst-1.md"), "instructions");
    writeFileSync(join(secPi.i, `${tid}.json`), JSON.stringify({ instr: join(secPi.i, "inst-1.md"), tools: "t.json", cwd: oldClone, subagents: true }));
  });
  afterAll(() => cleanup(root));

  it("its thread, pi session and record go to the main engine; its clone and its waiting change to the main vault's work area", async () => {
    const { migrateProjects } = await import("../projectsMigrate");
    const r = migrateProjects({
      home,
      vaults: [
        { path: main, piSessions: mainPi.s, piInstr: mainPi.i },
        { path: second, piSessions: secPi.s, piInstr: secPi.i },
      ],
      mainInstr: mainPi.i,
      mainVault: main,
      workArea: area,
      log: () => {},
    });
    expect(r.problems).toEqual([]);
    expect(r.moved.map((m) => m.slug)).toEqual(["vault-chat"]);
    // The clone, whole (work in progress included); the old one stays.
    expect(readFileSync(join(newClone, "src", "wip.ts"), "utf8")).toBe("export const wip = 1;\n");
    expect(existsSync(join(oldClone, "src", "wip.ts"))).toBe(true);
    // The pi session: with the project, its stored folder the new clone.
    const [s] = readdirSync(join(home, ".vault-chat", "sessions"));
    expect(JSON.parse(readFileSync(join(home, ".vault-chat", "sessions", s!), "utf8").split("\n")[0]!).cwd).toBe(newClone);
    // The engine's record of the thread: where the main engine reads it, in the new clone, its instructions with it.
    const rec = JSON.parse(readFileSync(join(mainPi.i, `${tid}.json`), "utf8"));
    expect(rec.cwd).toBe(newClone);
    expect(readFileSync(rec.instr, "utf8")).toBe("instructions");
    expect(fwd(rec.instr)).toContain(fwd(mainPi.i));
    // The waiting change: the main vault's now, pointing at the new clone.
    // Its proof card's images (vault-relative): in the main vault too, where the thread's card shows them.
    expect(readFileSync(join(main, ".vault-chat", "proof", "call_1", "1-shot.png"), "utf8")).toBe("PNG");
    const rv = JSON.parse(readFileSync(join(main, ".vault-chat", "local", "reviews.json"), "utf8"));
    expect(rv["project-vault-chat"].clone).toBe(newClone);
    // The project and its folder; nothing of it left in the second vault.
    expect(JSON.parse(readFileSync(join(home, ".vault-chat", "local", "project-folders.json"), "utf8")).folders["vault-chat"].path).toBe(code);
    expect(existsSync(join(second, "agent-projects"))).toBe(false);
    const L = new ConvLog(home, null, join(home, ".vault-chat", "events"));
    expect(L.picture("project-vault-chat")!.items.map((i: any) => i.text)).toEqual(["roleplay: fix it"]);
  });
});

describe("the update before the move: until `projects migrate` ran, each vault keeps its projects (no window where they vanish)", () => {
  const root = tmp("vcpg-mode-");
  const a = join(root, "vaults", "school2");
  const b = join(root, "vaults", "physics");
  const home = join(root, "vc", ".projects");
  afterAll(() => cleanup(root));

  it("projectsMode: a vault with projects of its own and no migration yet → each vault's; a new box → the home; after the migration → the home", async () => {
    const { projectsMode, migrateProjects } = await import("../projectsMigrate");
    for (const v of [a, b]) mkdirSync(join(v, ".vault-chat", "events"), { recursive: true });
    expect(projectsMode(home, [a, b])).toEqual({ mode: "home", waiting: [] });
    mkdirSync(join(a, "agent-projects", "coconut"), { recursive: true });
    writeFileSync(join(a, "agent-projects", "coconut", "project.md"), "# Coconut\n");
    expect(projectsMode(home, [a, b])).toEqual({ mode: "vaults", waiting: [a] });
    // The legacy context reads each vault's own projects, scoped to the vault a call runs in.
    const { configureContext, resetContextConfig, listProjects, withVault } = await import("../context");
    resetContextConfig();
    configureContext({ vault: a, projectsHome: home, legacyProjects: true });
    expect(withVault(a, () => listProjects().map((p) => p.slug))).toEqual(["coconut"]);
    expect(withVault(b, () => listProjects().map((p) => p.slug))).toEqual([]);
    const r = migrateProjects({ home, vaults: [a, b].map((v) => ({ path: v, piSessions: join(root, "s"), piInstr: join(root, "i") })), mainInstr: join(root, "i"), mainVault: a, log: () => {} });
    expect(r.ok).toBe(true);
    expect(projectsMode(home, [a, b])).toEqual({ mode: "home", waiting: [] });
    // A vault that gets projects again later (a laptop in local mode) does not flip the box back: reported only.
    mkdirSync(join(b, "agent-projects", "optics"), { recursive: true });
    writeFileSync(join(b, "agent-projects", "optics", "project.md"), "# Optics\n");
    expect(projectsMode(home, [a, b])).toEqual({ mode: "home", waiting: [b] });
    resetContextConfig();
  });
});
