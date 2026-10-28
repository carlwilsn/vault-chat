// Several vaults on one box. In process (no pi, no network): each vault's
// engine on a fake backend writes its own conversations, projects and wakes,
// its runs never enter the app's store (whose persist writes the main vault),
// its live events carry its name, its agent's path guard (the env pi gets,
// read the way the extension reads it) refuses the other vault, and the wakes
// of both come back after a restart. Then the real server: a request without a
// vault is the main vault's, `?vault=` scopes it, /poll hands each client its
// own vault's events.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, startServer, sh, waitFor, type Running } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcv-");
const mainVault = join(root, "vaults", "school2");
const second = join(root, "vaults", "physics");
for (const v of [mainVault, second]) mkdirSync(join(v, ".vault-chat", "conversations"), { recursive: true });
const state = join(root, "state");
const projectsHome = join(root, "projects-home");
process.env.VC_VAULT = mainVault;
process.env.VC_STATE_DIR = state;
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  constructor(readonly thread: string) {
    super();
  }
  setHandlers(h: any) {
    this.h = h;
  }
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    return { threadId: this.thread, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `turn-${this.thread}-${this.turns.length}` };
  }
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async subagentControl() {
    return { ok: true };
  }
  end(text: string) {
    const turnId = `turn-${this.thread}-${this.turns.length}`;
    for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: this.thread, ...x });
    this.emit("event", { threadId: this.thread, kind: "turnCompleted", turnId, status: "completed", error: null });
  }
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const convFiles = (v: string) => readdirSync(join(v, ".vault-chat", "conversations")).filter((f) => f.endsWith(".jsonl"));
const logFiles = (v: string) => readdirSync(join(v, ".vault-chat", "events")).filter((f) => f.endsWith(".jsonl") && !f.startsWith("_"));

describe("two vaults on one box (engines on fake backends)", () => {
  let Engine: any, store: any, readConv: any;
  const engines: any[] = [];
  const events: any[] = [];
  let a: { engine: any; backend: FakeBackend }, b: { engine: any; backend: FakeBackend };

  const boot = (vault: string, thread: string, tag?: string) => {
    const backend = withPiSessions(new FakeBackend(thread), join(root, `pi-${thread}`));
    // The main vault's engine runs the projects' threads (server/engine/index.ts); another vault's hands them to it.
    const home = vault === mainVault;
    const engine: any = new Engine({
      runsProjects: home,
      ...(home ? {} : { projectsEngine: async () => a.engine }),
      vault,
      backend,
      ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false },
      jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} },
      model: () => "openai/gpt-6.1-sol",
      webSearchModel: "x",
      apiKey: () => null,
      notify: async () => null,
      broadcast: (ev: any) => events.push(tag ? { vault: tag, ...ev } : ev),
      log: () => {},
    });
    engine.start();
    engines.push(engine);
    return { engine, backend };
  };

  beforeAll(async () => {
    await import("../shims/globals");
    const { registerAll } = await import("../commands/registry");
    registerAll((await import("../commands/fs")).fsCommands);
    registerAll((await import("../commands/conversations")).conversationCommands);
    store = (await import("../../src/store")).useStore;
    store.setState({ vaultPath: mainVault, conversationsLoaded: true });
    ({ readConv } = await import("../engine/convs"));
    const { configureContext } = await import("../context");
    mkdirSync(projectsHome, { recursive: true });
    (await import("../convlog/log")).setProjectsHomeLog(projectsHome);
    configureContext({ vault: mainVault, agentModel: "openai/gpt-6.1-sol", projectsHome });
    ({ Engine } = await import("../engine/engine"));
    a = boot(mainVault, "ta");
    b = boot(second, "tb", "physics");
  });

  afterAll(() => {
    for (const e of engines) e.stop();
    cleanup(root);
  });

  const convA = "main";
  const convB = "main";

  it("Main is each vault's own: a message to each lands in its own vault's log", async () => {
    await a.engine.message({ text: "main vault: hello" });
    await b.engine.message({ text: "physics vault: hello" });
    await until(() => a.backend.turns.length === 1 && b.backend.turns.length === 1);
    a.backend.end("answer from main");
    b.backend.end("answer from physics");
    await until(async () => !!(await readConv(second, "main"))?.messages.some((m: any) => m.role === "assistant"));
    await until(async () => !!(await readConv(mainVault, "main"))?.messages.some((m: any) => m.role === "assistant"));
    expect((await readConv(mainVault, "main")).messages.map((m: any) => m.content).join(" ")).not.toMatch(/physics/);
    expect((await readConv(second, "main")).messages.map((m: any) => m.content).join(" ")).not.toMatch(/main vault/);
    expect(logFiles(mainVault)).toContain("main.jsonl");
    expect(logFiles(second)).toContain("main.jsonl");
    expect(convFiles(mainVault)).toEqual([]);
    expect(convFiles(second)).toEqual([]);
    // No app store holds a conversation: each is its vault's log.
    expect(store.getState().conversations.map((c: any) => c.id)).not.toContain("main");
  });

  it("a project is the machine's: made from either vault, its thread runs on the home engine, in the projects home's log, the same from both", async () => {
    const turnsA = a.backend.turns.length;
    const turnsB = b.backend.turns.length;
    // From the physics vault: "New chat in project" (a project named, no conversation).
    const rb = await b.engine.message({ text: "physics vault: start on optics", project: "Optics" });
    expect(rb.convId).toBe("project-optics");
    await until(() => a.backend.turns.length === turnsA + 1);
    // The home engine ran it, not the physics vault's.
    expect(b.backend.turns.length).toBe(turnsB);
    a.backend.end("optics answer");
    await until(async () => !!(await readConv(mainVault, "project-optics"))?.messages.some((m: any) => m.role === "assistant"));
    // Its files: the projects home, no vault.
    expect(existsSync(join(projectsHome, "optics", "project.md"))).toBe(true);
    for (const v of [mainVault, second]) expect(existsSync(join(v, "agent-projects"))).toBe(false);
    // Its thread: the projects home's log, never a vault's.
    expect(readdirSync(join(projectsHome, ".vault-chat", "events"))).toContain("project-optics.jsonl");
    for (const v of [mainVault, second]) expect(logFiles(v)).not.toContain("project-optics.jsonl");
    // The same thread from either vault: every line, in order.
    const fromMain = (await readConv(mainVault, "project-optics")).messages.map((m: any) => [m.role, m.content]);
    const fromPhys = (await readConv(second, "project-optics")).messages.map((m: any) => [m.role, m.content]);
    expect(fromPhys).toEqual(fromMain);
    expect(fromMain).toEqual(expect.arrayContaining([["user", "physics vault: start on optics"], ["assistant", "optics answer"]]));
    // And a message from the main vault continues the same thread.
    await a.engine.message({ convId: "project-optics", text: "main vault: more optics" });
    await until(() => a.backend.turns.length === turnsA + 2);
    a.backend.end("more optics answer");
    await until(async () => (await readConv(second, "project-optics")).messages.some((m: any) => m.content === "more optics answer"));
    // Each vault's list: its own Main, and the same project threads.
    const { logOf } = await import("../engine/convs");
    expect(logOf(mainVault).ids().sort()).toEqual(["main", "project-optics"]);
    expect(logOf(second).ids().sort()).toEqual(["main", "project-optics"]);
    const { listProjects, withVault } = await import("../context");
    expect(withVault(second, () => listProjects().map((p: any) => p.slug))).toEqual(withVault(mainVault, () => listProjects().map((p: any) => p.slug)));
  });

  it("each agent's path guard refuses the other vault (the env pi gets, read as the extension reads it)", async () => {
    const { PiBackend } = await import("../engine/pi/backend");
    const { buildSandbox, otherVaultPaths, vaultState } = await import("../engine/index");
    const { piPaths } = await import("../engine/pi/config");
    // @ts-expect-error plain JS module
    const { guardToolCall, resolveList } = await import("../engine/pi/ext/policy.mjs");
    const base = piPaths(state);
    const refs = [
      { name: "school2", path: mainVault, bare: join(root, "vaults", "school2.git"), main: true },
      { name: "physics", path: second, bare: join(root, "vaults", "physics.git"), main: false },
    ];
    const guardOf = (v: (typeof refs)[number]) => {
      const st = vaultState(state, base, v);
      const sandbox = {
        ...buildSandbox({ bwrap: null, home: root, stateDir: state, secretsDir: join(root, "secrets"), hideFiles: [], sessionsDir: st.pi.sessionsDir, agentDir: st.pi.agentDir, vault: v.path, uid: -1 }),
        others: () => otherVaultPaths(v, refs, (w) => vaultState(state, base, w).walls),
      };
      const be = new PiBackend({ install: { version: "t", cli: "", node: "" } as any, paths: st.pi, catalog: new Map(), sandbox, apiKey: () => null, thinking: "low", idleMs: 1, maxProcs: 1, subagents: {} as any });
      const env = be.piEnv("tools.json");
      const denyRead = resolveList(JSON.parse(env.VC_PI_DENY_READ!), root);
      const denyWrite = resolveList(JSON.parse(env.VC_PI_DENY_WRITE!), root);
      return (tool: string, path: string) => guardToolCall(tool, { path }, { cwd: v.path, home: root, denyRead, denyWrite });
    };
    const gMain = guardOf(refs[0]!);
    const gPhys = guardOf(refs[1]!);
    // Its own vault: open. The other's working copy, bare repo and engine state: refused.
    expect(gMain("read", "notes.md")).toBeNull();
    expect(gMain("write", join(mainVault, "x.md"))).toBeNull();
    expect(gMain("read", join(second, "notes.md"))).toMatch(/protected/);
    expect(gMain("write", "../physics/planted.md")).toMatch(/protected/);
    expect(gMain("read", join(root, "vaults", "physics.git", "HEAD"))).toMatch(/protected/);
    expect(gMain("read", join(state, "vaults", "physics", "pi", "sessions", "s.jsonl"))).toMatch(/protected/);
    expect(gPhys("read", "notes.md")).toBeNull();
    expect(gPhys("read", join(mainVault, "README.md"))).toMatch(/protected/);
    expect(gPhys("edit", "../school2/README.md")).toMatch(/protected/);
    expect(gPhys("read", join(state, "pi", "sessions", "s.jsonl"))).toMatch(/protected/);
    // The conversation files and the log stay the server's in each vault.
    expect(gPhys("write", join(second, ".vault-chat", "conversations", "x.jsonl"))).toMatch(/read-only/);
    expect(gPhys("write", join(second, ".vault-chat", "events", "x.jsonl"))).toMatch(/read-only/);
  });

  it("the wakes of both vaults come back after a restart", async () => {
    const { addWake } = await import("../engine/wakes");
    for (const e of engines.splice(0)) e.stop();
    // Due now, written while "down".
    addWake(mainVault, { conv: convA, at: Date.now() - 1000, reason: "check the main run" });
    addWake(second, { conv: convB, at: Date.now() - 1000, reason: "check the physics run" });
    const a2 = boot(mainVault, "ta");
    const b2 = boot(second, "tb", "physics");
    await until(() => a2.backend.turns.length === 1 && b2.backend.turns.length === 1, 15_000);
    expect(JSON.stringify(a2.backend.turns[0].texts)).toMatch(/check the main run/);
    expect(JSON.stringify(b2.backend.turns[0].texts)).toMatch(/check the physics run/);
    await until(async () => (await readConv(second, convB)).messages.some((m: any) => /check the physics run/.test(m.content)));
    expect((await readConv(mainVault, convA)).messages.some((m: any) => /physics/.test(m.content ?? "") && m.system)).toBe(false);
  });
});

describe("vault-scoped routes (the real server)", () => {
  let home: string;
  let srv: Running;
  let main: string;
  const conv = (id: string, title: string) =>
    JSON.stringify({ id, title, createdAt: 1, lastActivityAt: Date.now(), source: "phone", state: "idle" }) + "\n" + JSON.stringify({ role: "user", content: title, mid: `m-${id}` }) + "\n";

  beforeAll(async () => {
    home = tmp("vcvs-");
    main = makeVault(join(home, "school2"));
    const bare = join(home, "school2.git");
    sh(home, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    srv = await startServer({ home, vault: main, bare, secrets: join(home, "secrets"), extra: { VC_SYNC_INTERVAL_MS: "600000" } });
    const r = await (await fetch(srv.base + "/api/v1/vaults", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "physics" }) })).json();
    expect(r.ok).toBe(true);
    mkdirSync(join(main, ".vault-chat", "conversations"), { recursive: true });
    mkdirSync(join(home, "physics", ".vault-chat", "conversations"), { recursive: true });
    writeFileSync(join(main, ".vault-chat", "conversations", "cmain.jsonl"), conv("cmain", "Main chat"));
    writeFileSync(join(home, "physics", ".vault-chat", "conversations", "cphys.jsonl"), conv("cphys", "Physics chat"));
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    cleanup(home);
  });

  const ids = async (path: string) => ((await (await fetch(srv.base + path)).json()).conversations ?? []).map((c: any) => c.id);
  const post = (path: string, body: unknown) => fetch(srv.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("health names the box's user and each vault's working copy (the laptop's terminal opens ssh there)", async () => {
    const { userInfo } = await import("node:os");
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h.user).toBe(userInfo().username);
    expect(h.vaultPath).toBe(main);
    expect(h.vaults).toEqual(expect.arrayContaining([{ name: "school2", path: main }, { name: "physics", path: join(home, "physics") }]));
    expect((await (await fetch(srv.base + "/api/v1/health?vault=physics")).json()).vaultPath).toBe(join(home, "physics"));
    expect((await (await fetch(srv.base + "/api/v1/health?vault=nope")).json()).vaultPath).toBeNull();
  });

  it("no vault is the main vault; ?vault= and X-VC-Vault scope the request; an unknown vault is 404", async () => {
    // (The app keeps a fresh empty chat of its own in the main vault.)
    expect(await ids("/conversations")).toContain("cmain");
    expect(await ids("/conversations")).not.toContain("cphys");
    expect(await ids("/conversations?vault=school2")).toEqual(await ids("/conversations"));
    // Each vault also has its own Main (src/threads.ts).
    expect((await ids("/conversations?vault=physics")).filter((id: string) => id !== "main")).toEqual(["cphys"]);
    const h = await (await fetch(srv.base + "/conversations", { headers: { "x-vc-vault": "physics" } })).json();
    expect(h.conversations.map((c: any) => c.id).filter((id: string) => id !== "main")).toEqual(["cphys"]);
    expect((await fetch(srv.base + "/conversation?id=cphys")).status).toBe(404);
    expect((await fetch(srv.base + "/conversation?id=cphys&vault=physics")).status).toBe(200);
    expect((await fetch(srv.base + "/conversations?vault=nope")).status).toBe(404);
    // The old app's routes are the main vault's only.
    expect((await post("/notes?vault=physics", { text: "x" })).status).toBe(409);
  });

  it("projects are the machine's (the same list and threads from every vault); notifications, chats and /poll's other records stay per vault", async () => {
    const r = await (await post("/conversation/project?vault=physics", { convId: "cphys", project: "Optics" })).json();
    expect(r).toEqual({ ok: true, project: "optics" });
    // In the projects home, no vault (no vault-chat folder here: ~/.local/share/vault-chat/projects).
    const home2 = join(home, ".local", "share", "vault-chat", "projects");
    expect(existsSync(join(home2, "optics", "project.md"))).toBe(true);
    expect(existsSync(join(home, "physics", "agent-projects"))).toBe(false);
    expect(existsSync(join(main, "agent-projects"))).toBe(false);
    const list = async (q: string) => (await (await fetch(srv.base + `/projects${q}`)).json()).projects.map((p: any) => p.slug);
    expect(await list("?vault=physics")).toEqual(["optics"]);
    expect(await list("")).toEqual(["optics"]);
    // The tag itself is the chat's, and the chat is the physics vault's.
    expect((await post("/conversation/project", { convId: "cphys", project: "Optics" })).status).toBe(400);

    // A project's thread, made from one vault, is the same from the other: rows and events.
    const made = await (await post("/projects?vault=physics", { name: "Lab Reports" })).json();
    expect(made).toMatchObject({ ok: true, slug: "lab-reports", convId: "project-lab-reports" });
    const rows = async (q: string) => (await (await fetch(srv.base + `/api/v2/conversations${q}`)).json()).rows.filter((x: any) => x.id.startsWith("project-")).map((x: any) => [x.id, x.title]);
    expect(await rows("?vault=physics")).toEqual(await rows(""));
    expect(await rows("")).toEqual(expect.arrayContaining([["project-lab-reports", "Lab Reports"]]));
    const ev = async (q: string) => (await (await fetch(srv.base + `/api/v2/conversations/project-lab-reports/events?after=0${q}`)).json()).events.map((e: any) => [e.seq, e.type]);
    expect(await ev("&vault=physics")).toEqual(await ev(""));
    // A line sent to it from physics goes to the main engine (which runs every project's thread) and is in the thread
    // from both vaults. (The first build forwarded it to the physics engine itself, over and over, until the heap ran out.)
    const sent = await (await post("/api/v2/intent?vault=physics", { type: "send", clientId: "lab-1", convId: "project-lab-reports", text: "From physics: LAB-LINE" })).json();
    expect(sent).toMatchObject({ ok: true, convId: "project-lab-reports" });
    const lines = async (q: string) => (await (await fetch(srv.base + `/api/v2/conversations/project-lab-reports/events?after=0${q}`)).json()).events.filter((e: any) => e.type === "entry" && JSON.stringify(e.entry).includes("LAB-LINE")).length;
    await waitFor(async () => (await lines("")) > 0, 20_000);
    expect(await lines("&vault=physics")).toBe(await lines(""));
    expect((await (await fetch(srv.base + "/api/v1/health")).json()).ok ?? true).toBeTruthy();

    // Each vault's /poll: its own records, and every project's (one sequence): the tag is a record of cphys, the project a signal both see.
    const phys = await (await fetch(`${srv.base}/poll?after=0&vault=physics`)).json();
    expect(phys.events.filter((e: any) => e.type === "meta" && "project" in e.patch && e.conv === "cphys")).toEqual([expect.objectContaining({ conv: "cphys", patch: { project: "optics" } })]);
    expect(phys.events.filter((e: any) => e.type === "signal" && e.signal.type === "project")).toEqual(expect.arrayContaining([expect.objectContaining({ conv: null, signal: { type: "project", convId: "cphys", project: "optics" } })]));
    const mainAll = await (await fetch(`${srv.base}/poll?after=0`)).json();
    expect(mainAll.events.some((e: any) => e.conv === "cphys")).toBe(false);
    expect(mainAll.events.some((e: any) => e.type === "signal" && e.signal.type === "project" && e.signal.convId === "cphys")).toBe(true);
    expect(mainAll.events.some((e: any) => e.conv === "project-lab-reports")).toBe(true);
    const seqs = mainAll.events.map((e: any) => e.seq);
    expect([...seqs].sort((x: number, y: number) => x - y)).toEqual(seqs);
    const latestNow = (await (await fetch(srv.base + "/poll?after=latest")).json()).next;
    // The main vault's client gets nothing of it (and its cursor still moves past it).
    const t0 = Date.now();
    const mainPoll = fetch(`${srv.base}/poll?after=${latestNow}`).then((x) => x.json());
    await post("/notifications/clear?vault=physics", {});
    await post("/conversation/project", { convId: "cmain", project: "Notes" });
    const m = await mainPoll;
    expect(Date.now() - t0).toBeLessThan(20_000);
    // The main vault's poll answers with the main vault's records only (the tag on cmain), nothing of physics.
    expect(m.events.length).toBeGreaterThan(0);
    expect(m.events.every((e: any) => e.conv === "cmain" || String(e.conv).startsWith("project-") || (e.type === "signal" && (e.signal.convId === "cmain" || e.signal.type === "project")))).toBe(true);
    expect(m.events.some((e: any) => e.conv === "cphys")).toBe(false);

    await post("/decision-record?vault=physics", { answer: "yes", title: "t", question: "q", convId: "cphys" });
    await waitFor(() => existsSync(join(home, "physics", ".vault-chat", "notifications.jsonl")), 5000);
    expect((await (await fetch(srv.base + "/notifications?vault=physics")).json()).notifications.length).toBe(1);
    expect((await (await fetch(srv.base + "/notifications")).json()).notifications.length).toBe(0);
  });

  it("the activity stream is per vault: written in the vault the request names", async () => {
    const r = await (await post("/api/v1/activity?vault=physics", { entry: { kind: "edit", modality: "ctrl-k", text: '"shorten the optics intro"', path: "optics.md" } })).json();
    expect(r.ok).toBe(true);
    const log = join(home, "physics", ".vault-chat", "local", "activity.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("shorten the optics intro");
    // (The main vault's stream has the project thread's line above — the main engine runs projects — never this.)
    const mainLog = join(main, ".vault-chat", "local", "activity.jsonl");
    expect(existsSync(mainLog) ? readFileSync(mainLog, "utf8") : "").not.toContain("shorten the optics intro");
    expect((await post("/api/v1/activity?vault=physics", { entry: { kind: "nope", text: "x" } })).status).toBe(400);
  });
});
