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
    const engine = new Engine({
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
    configureContext({ vault: mainVault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
    ({ Engine } = await import("../engine/engine"));
    a = boot(mainVault, "ta");
    b = boot(second, "tb", "physics");
  });

  afterAll(() => {
    for (const e of engines) e.stop();
    cleanup(root);
  });

  let convA = "";
  let convB = "";

  it("a message to each lands in its own vault: conversation, project, live events", async () => {
    const ra = await a.engine.message({ text: "main vault: hello", project: "Alpha" });
    const rb = await b.engine.message({ text: "physics vault: hello", project: "Beta" });
    convA = ra.convId;
    convB = rb.convId;
    await until(() => a.backend.turns.length === 1 && b.backend.turns.length === 1);
    a.backend.end("answer from main");
    b.backend.end("answer from physics");
    await until(async () => !!(await readConv(second, convB))?.messages.some((m: any) => m.role === "assistant"));
    await until(async () => !!(await readConv(mainVault, convA))?.messages.some((m: any) => m.role === "assistant"));

    // Each vault's own log; never a conversation file.
    expect(logFiles(mainVault)).toEqual([`${convA}.jsonl`]);
    expect(logFiles(second)).toEqual([`${convB}.jsonl`]);
    expect(convFiles(mainVault)).toEqual([]);
    expect(convFiles(second)).toEqual([]);
    expect(await readConv(mainVault, convB)).toBeNull();
    expect((await readConv(second, convB)).project).toBe("beta");
    // Projects are the vault's own (CONTEXT runs scoped to the engine's vault).
    expect(existsSync(join(second, "agent-projects", "beta"))).toBe(true);
    expect(existsSync(join(mainVault, "agent-projects", "beta"))).toBe(false);
    expect(existsSync(join(mainVault, "agent-projects", "alpha"))).toBe(true);
    // No app store holds a conversation: each is its vault's log.
    expect(store.getState().conversations.map((c: any) => c.id)).not.toContain(convA);
    const { logOf } = await import("../engine/convs");
    expect(logOf(mainVault).ids()).toEqual([convA]);
    expect(logOf(second).ids()).toEqual([convB]);
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
    expect(await ids("/conversations?vault=physics")).toEqual(["cphys"]);
    const h = await (await fetch(srv.base + "/conversations", { headers: { "x-vc-vault": "physics" } })).json();
    expect(h.conversations.map((c: any) => c.id)).toEqual(["cphys"]);
    expect((await fetch(srv.base + "/conversation?id=cphys")).status).toBe(404);
    expect((await fetch(srv.base + "/conversation?id=cphys&vault=physics")).status).toBe(200);
    expect((await fetch(srv.base + "/conversations?vault=nope")).status).toBe(404);
    // The old app's routes are the main vault's only.
    expect((await post("/notes?vault=physics", { text: "x" })).status).toBe(409);
  });

  it("projects, notifications and /poll are per vault", async () => {
    const latest = (await (await fetch(srv.base + "/poll?after=latest")).json()).next;
    const r = await (await post("/conversation/project?vault=physics", { convId: "cphys", project: "Optics" })).json();
    expect(r).toEqual({ ok: true, project: "optics" });
    expect(existsSync(join(home, "physics", "agent-projects", "optics"))).toBe(true);
    expect(existsSync(join(main, "agent-projects", "optics"))).toBe(false);
    expect((await (await fetch(srv.base + "/projects?vault=physics")).json()).projects.map((p: any) => p.slug)).toEqual(["optics"]);
    expect((await (await fetch(srv.base + "/projects")).json()).projects).toEqual([]);
    expect((await post("/conversation/project", { convId: "cphys", project: "Optics" })).status).toBe(400); // not in the main vault

    // Each vault's /poll is its own log (its own sequence): the tag is a record of cphys, the project a signal.
    const phys = await (await fetch(`${srv.base}/poll?after=0&vault=physics`)).json();
    expect(phys.events.filter((e: any) => e.type === "meta" && "project" in e.patch)).toEqual([expect.objectContaining({ conv: "cphys", patch: { project: "optics" } })]);
    expect(phys.events.filter((e: any) => e.type === "signal")).toEqual([expect.objectContaining({ conv: null, signal: { type: "project", convId: "cphys", project: "optics" } })]);
    // The main vault's client gets nothing of it (and its cursor still moves past it).
    const t0 = Date.now();
    const mainPoll = fetch(`${srv.base}/poll?after=${latest}`).then((x) => x.json());
    await post("/notifications/clear?vault=physics", {});
    await post("/conversation/project", { convId: "cmain", project: "Notes" });
    const m = await mainPoll;
    expect(Date.now() - t0).toBeLessThan(20_000);
    // The main vault's poll answers with the main vault's records only (the tag on cmain), nothing of physics.
    expect(m.events.length).toBeGreaterThan(0);
    expect(m.events.every((e: any) => e.conv === "cmain" || (e.type === "signal" && e.signal.convId === "cmain"))).toBe(true);

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
    expect(existsSync(join(main, ".vault-chat", "local", "activity.jsonl"))).toBe(false);
    expect((await post("/api/v1/activity?vault=physics", { entry: { kind: "nope", text: "x" } })).status).toBe(400);
  });
});
