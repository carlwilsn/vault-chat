// The shared context stream (server/activity.ts, src/activityCore.ts): one
// activity log per vault, written by every surface, read by every surface.
// Unit: append, rotation, caps, redaction, the summary (dedupe, order, cap,
// project first, window), isolation, the off switch. In process (the engine
// on a fake pi, voice's routes for real): a Ctrl+K edit reaches the next chat
// turn's prefix; what Carl said by voice reaches a Ctrl+L layer and a chat turn
// (pointing at its chat); a capture's stored image is referenced; voice's Ask
// from a fresh call carries the call's lines; a second vault never sees the first's.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vca-");
const vault = join(root, "vault");
const vault2 = join(root, "vault2");
for (const v of [vault, vault2]) {
  mkdirSync(join(v, ".vault-chat", "conversations"), { recursive: true });
  mkdirSync(join(v, "notes"), { recursive: true });
  git(v, "init", "-q");
}
writeFileSync(join(vault, "notes", "a.md"), "# A very long and winding title about transformers\nthe quick fox\n");
writeFileSync(join(vault2, "notes", "b.md"), "# B\nsecond vault\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** pi, faked: a thread per conversation, every turn recorded. */
class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: { threadId: string; texts: string[]; turnId: string }[] = [];
  private n = 0;
  constructor(private tag: string) {
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
    return { threadId: `${this.tag}-t${++this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    const turnId = `${threadId}-turn${this.turns.length + 1}`;
    // What the model gets this turn: the prompt, then the "you" layer pi adds after it (the extension, fakeSession.ts).
    this.turns.push({ threadId, texts: o.you ? [...o.texts, o.you] : o.texts, turnId });
    return { turnId };
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
  /** End the latest turn (so the next message starts a new one). */
  end() {
    const t = this.turns[this.turns.length - 1]!;
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let act: typeof import("../activity");
let core: typeof import("../../src/activityCore");
let voice: typeof import("../voice");
let engine: any, engine2: any;
let backend: FakeBackend, backend2: FakeBackend;
let deps: import("../voice").VoiceDeps;
/** Voice's Asks (pi side threads, faked): what each was given. */
const sideAsks: { kind: string; convId: string; text: string; tools?: string }[] = [];

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** Send a chat message and return the texts its turn started with (the prefix and the message). */
async function chatTurn(e: any, b: FakeBackend, body: Record<string, unknown>): Promise<{ texts: string; convId: string }> {
  const before = b.turns.length;
  // No convId: a chat of its own (a separate chat; a message naming none would be Main's).
  const out = await e.message({ ...(body.convId ? {} : { convId: `sep-${Math.random().toString(36).slice(2, 10)}` }), ...body });
  expect(out?.ok).toBe(true);
  await until(() => b.turns.length > before);
  const t = b.turns[b.turns.length - 1]!;
  b.end();
  const { readConv } = await import("../engine/convs");
  await until(async () => (await readConv(e.d.vault, String(out.convId)))?.state !== "running");
  return { texts: t.texts.join("\n\n"), convId: String(out.convId) };
}

function makeEngine(Engine: any, v: string, b: FakeBackend) {
  const e = new Engine({
    vault: v,
    backend: b as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => null,
    log: () => {},
  });
  e.start();
  return e;
}

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend("a"), join(root, "pi-a"));
  backend2 = withPiSessions(new FakeBackend("b"), join(root, "pi-b"));
  engine = makeEngine(Engine, vault, backend);
  engine2 = makeEngine(Engine, vault2, backend2);
  act = await import("../activity");
  core = await import("../../src/activityCore");
  voice = await import("../voice");
  deps = { vault, name: "main", main: true, message: (b) => engine.message(b), side: { start: async (b) => (sideAsks.push(b), { id: `s${sideAsks.length}` }), wait: async () => ({ text: "Summarised.", error: null }) } };
});

afterAll(() => {
  engine?.stop();
  engine2?.stop();
  cleanup(root);
});

afterEach(() => {
  delete process.env.VC_ACTIVITY;
});

const logOf = (v: string) => {
  try {
    return readFileSync(join(v, ".vault-chat", "local", "activity.jsonl"), "utf8");
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- unit

describe("the log", () => {
  it("appends sanitized entries under .vault-chat/local/, kept out of git", () => {
    const v = join(root, "u1");
    mkdirSync(v, { recursive: true });
    const e = act.appendActivity(v, { kind: "focus", text: "opened the file", path: "notes\\x.md", bogus: "dropped", ts: 5 }, 1_000_000);
    expect(e).toEqual({ ts: 1_000_000, kind: "focus", modality: "editor", text: "opened the file", path: "notes/x.md", device: "laptop" });
    expect(readFileSync(join(v, ".vault-chat", "local", ".gitignore"), "utf8")).toBe("*\n");
    expect(act.appendActivity(v, { kind: "nope", text: "x" })).toBeNull();
    expect(act.appendActivity(v, { kind: "chat", text: "   " })).toBeNull();
    expect(act.appendActivity(v, { kind: "capture", text: "x", image: "../../etc/passwd" })?.image).toBeUndefined();
    expect(core.parseLog(logOf(v))).toHaveLength(2);
  });

  it("caps every field and every line", () => {
    const v = join(root, "u2");
    mkdirSync(v, { recursive: true });
    const e = act.appendActivity(v, { kind: "ask", text: "q".repeat(10_000), detail: "a ".repeat(10_000), path: "p/".repeat(500), where: "w".repeat(500) })!;
    expect(e.text.length).toBeLessThanOrEqual(core.CAPS.text);
    expect(e.detail!.length).toBeLessThanOrEqual(core.CAPS.detail);
    expect(e.path!.length).toBeLessThanOrEqual(core.CAPS.path);
    expect(e.where!.length).toBeLessThanOrEqual(core.CAPS.where);
    for (const l of logOf(v).trim().split("\n")) expect(l.length).toBeLessThanOrEqual(core.ENTRY_MAX_BYTES);
  });

  it("never writes key-like strings", () => {
    const v = join(root, "u3");
    mkdirSync(v, { recursive: true });
    const secrets = [
      "sk-or-v1-0123456789abcdef0123456789abcdef",
      "sk-ant-api03-AbCdEf0123456789xyz",
      "ghp_0123456789abcdefABCDEF0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghij",
      "hunter2-is-my-password",
      "QmFzZTY0QmxvYk9mQVNlY3JldEtleTEyMzQ1Njc4OTA",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    ];
    act.appendActivity(v, { kind: "voice", text: `Carl said: my key is ${secrets[0]} and ${secrets[1]}`, detail: `token=${secrets[2]} ${secrets[3]} ${secrets[4]}` });
    act.appendActivity(v, { kind: "edit", text: `password: ${secrets[5]}`, detail: `Authorization: Bearer ${secrets[6]} jwt ${secrets[7]}` });
    const log = logOf(v);
    for (const s of secrets) expect(log).not.toContain(s);
    expect(log).toContain("[redacted]");
    expect(log).toContain("password: [redacted]");
    // Ordinary text survives.
    expect(core.redactSecrets("make the title shorter in notes/a.md, page 3")).toBe("make the title shorter in notes/a.md, page 3");
  });

  it("rotates past its size, keeps the previous half, and reads both", () => {
    const v = join(root, "u4");
    mkdirSync(v, { recursive: true });
    const t0 = 2_000_000;
    let n = 0;
    while (!existsSync(join(v, ".vault-chat", "local", "activity.1.jsonl"))) {
      act.appendActivity(v, { kind: "ask", text: `question ${n}`, detail: "x ".repeat(280) }, t0 + n);
      n++;
      expect(n).toBeLessThan(2000);
    }
    expect(statSync(join(v, ".vault-chat", "local", "activity.1.jsonl")).size).toBeLessThanOrEqual(core.LOG_MAX_BYTES);
    const all = act.readActivity(v, t0 + n, 10 * 60_000);
    expect(all.length).toBe(n);
    expect(all[all.length - 1]!.text).toBe(`question ${n - 1}`);
    // Past the window: ignored.
    expect(act.readActivity(v, t0 + n + 11 * 60_000, 10 * 60_000)).toHaveLength(0);
  });

  it("VC_ACTIVITY=0 writes nothing", () => {
    const v = join(root, "u5");
    mkdirSync(v, { recursive: true });
    process.env.VC_ACTIVITY = "0";
    expect(act.appendActivity(v, { kind: "focus", text: "opened" })).toBeNull();
    expect(act.activityPost(v, { entry: { kind: "edit", text: "x" }, imageBase64: PNG }).body).toEqual({ ok: true, off: true });
    expect(act.saveCapture(v, PNG)).toBeNull();
    expect(existsSync(join(v, ".vault-chat", "local"))).toBe(false);
  });
});

describe("the you layer (buildYouLayer)", () => {
  const now = 10_000_000;
  const E = (ago: number, e: Partial<import("../../src/activityCore").ActivityEntry>) =>
    ({ ts: now - ago * 60_000, modality: "editor", kind: "focus", text: "x", ...e }) as import("../../src/activityCore").ActivityEntry;

  it("dedupes, orders oldest first, drops the window's outside, and is empty when there is nothing", () => {
    const s = core.buildYouLayer(
      {
        entries: [
          E(60, { kind: "ask", modality: "ctrl-l", text: "too old" }),
          E(9, { text: "opened the file", path: "notes/a.md" }),
          E(8, { kind: "ask", modality: "ctrl-l", text: 'asked "what is RoPE"', path: "paper.pdf", where: "page 3" }),
          E(7, { text: "reading", path: "notes/a.md", where: "L4" }),
          E(6, { kind: "ask", modality: "ctrl-l", text: 'asked "what is RoPE"', path: "paper.pdf", where: "page 3" }),
          E(2, { kind: "chat", modality: "chat", text: "Plan", detail: 'Carl: "first"', convId: "c1" }),
          E(1, { kind: "chat", modality: "chat", text: "Plan v2", detail: 'Carl: "second"', convId: "c1" }),
        ],
      },
      { now },
    ).text;
    expect(s).toMatch(/^<you>/);
    expect(s).toMatch(/<\/you>$/);
    expect(s).not.toContain("too old");
    expect(s.match(/notes\/a\.md/g)).toHaveLength(1); // the later view of the file replaced the earlier
    expect(s).toContain("Focus: notes/a.md (L4)");
    expect(s.match(/what is RoPE/g)).toHaveLength(1);
    // Each of Carl's messages is a pointer of its own, oldest first.
    expect(s.indexOf("Carl: first")).toBeLessThan(s.indexOf("Carl: second"));
    expect(s).toContain("1 min ago");
    expect(core.buildYouLayer({ entries: [] }, { now }).text).toBe("");
  });

  it("honours since and the reader's conversation, and keeps under the cap", () => {
    const entries = [
      E(5, { kind: "voice", modality: "voice", text: "Voice edited notes/x.md" }),
      E(4, { kind: "edit", modality: "ctrl-k", text: '"tighten"', path: "coconut/readme.md" }),
      E(3, { kind: "chat", modality: "chat", text: "Me", detail: 'Carl: "mine"', convId: "me" }),
      E(2, { kind: "ask", modality: "ctrl-l", text: 'asked "why"' }),
    ];
    const s = core.buildYouLayer({ entries }, { now, convId: "me" }).text;
    expect(s).toContain("Elsewhere (Ctrl+K/L, voice, inbox):");
    expect(s.indexOf("Voice edited")).toBeLessThan(s.indexOf("tighten"));
    expect(s).not.toContain("Carl: mine");
    const later = core.buildYouLayer({ entries }, { now, since: now - 2.5 * 60_000 }).text;
    expect(later).toContain('asked "why"');
    expect(later).not.toContain("tighten");
    // The cap: many big entries, the newest kept.
    const many = Array.from({ length: 200 }, (_, i) => E(29 - i * 0.1, { kind: "ask", modality: "ctrl-l", text: `question number ${i} ${"z".repeat(200)}` }));
    const capped = core.buildYouLayer({ entries: many }, { now }).text;
    expect(capped.length).toBeLessThanOrEqual(core.YOU_MAX_CHARS);
    expect(capped).toContain("question number 199");
    expect(capped).not.toContain("question number 0 ");
    expect(capped).toMatch(/older entries left out/);
  });

  it("formats each surface's entry with what is needed to act on it", () => {
    const s = core.buildYouLayer(
      {
        entries: [
          E(1, {
            kind: "edit",
            modality: "ctrl-k",
            text: '"make the title shorter"',
            path: "notes/a.md",
            outcome: "accepted",
            detail: core.editSummary("# A very long title", "# Short title"),
          }),
          E(1, { kind: "capture", modality: "capture", text: "captured a region for the chat", path: "paper.pdf", where: "page 2", image: ".vault-chat/local/captures/x.png" }),
        ],
      },
      { now },
    ).text;
    expect(s).toContain('Ctrl+K edit · notes/a.md: "make the title shorter" (accepted) — replaced 1 line(s) with 1: "# A very long title" → "# Short title"');
    expect(s).toContain("capture of paper.pdf (page 2) — captured a region for the chat: .vault-chat/local/captures/x.png");
  });

  it("the project's memory (.vault-chat/memory.md in its folder) and the rules, capped; an old agent-projects/ file is not read", async () => {
    const { ensureProject } = await import("../context");
    const { withVault } = await import("../context");
    withVault(vault, () => ensureProject("Coconut"));
    writeFileSync(join(vault, "Coconut", ".vault-chat", "memory.md"), `# Coconut: memory\n\nDetect coconuts in drone images.\n\n- use YOLO\n${"filler ".repeat(3000)}`);
    mkdirSync(join(vault, "agent-projects", "coconut"), { recursive: true });
    writeFileSync(join(vault, "agent-projects", "coconut", "project.md"), "# Coconut\n\n- OLD-MEMORY\n");
    writeFileSync(join(vault, ".vault-chat", "rules.md"), "Always cite the page.\n");
    const p = await act.projectContextFor(vault, "coconut");
    expect(p).toMatch(/^<project_context>/);
    expect(p).toContain("# Project: Coconut (coconut)");
    expect(p).toContain("Detect coconuts");
    expect(p).toContain("use YOLO");
    expect(p).toContain("Always cite the page.");
    expect(p).not.toContain("OLD-MEMORY");
    expect(p.length).toBeLessThan(4200);
    // The name works too; no project = the rules only.
    expect(await act.projectContextFor(vault, "Coconut")).toContain("use YOLO");
    expect(await act.projectContextFor(vault, null)).not.toContain("Coconut");
  });
});

// ---------------------------------------------------------------- in process

describe("every surface sees the same stream (engine on a fake pi)", () => {
  it("a Ctrl+K edit reaches the next chat turn's you layer, with what to undo — once", async () => {
    const r = act.activityPost(vault, {
      entry: {
        kind: "edit",
        modality: "ctrl-k",
        text: '"make the title shorter"',
        detail: core.editSummary("# A very long and winding title about transformers", "# Transformers"),
        outcome: "accepted",
        path: "notes/a.md",
        where: "L1",
      },
    });
    expect(r.status).toBe(200);
    const first = await chatTurn(engine, backend, { text: "undo the Ctrl+K edit I just made" });
    expect(first.texts).toContain("<you>");
    expect(first.texts).toContain("Ctrl+K edit · notes/a.md (L1)");
    expect(first.texts).toContain('"# A very long and winding title about transformers" → "# Transformers"');
    expect(first.texts).toContain("(accepted)");
    // pi adds the layer after the message (before_agent_start's custom message).
    expect(first.texts.indexOf("<you>")).toBeGreaterThan(first.texts.indexOf("undo the Ctrl+K edit"));
    // The same conversation's next turn: nothing new, no layer again.
    const again = await chatTurn(engine, backend, { text: "thanks", convId: first.convId });
    expect(again.texts).not.toContain("<you>");
    // A different chat started afterwards points back at the first one, not at itself.
    const other = await chatTurn(engine, backend, { text: "what was I doing?" });
    expect(other.texts).toContain(`(id ${first.convId})`);
    expect(other.texts).not.toContain(`(id ${other.convId})`);
  });

  it("what Carl said by voice reaches a later Ctrl+L layer and a later chat turn, pointing at its chat; voice's reply stays there", async () => {
    const t = await voice.voiceTranscript(deps, { role: "user", text: "shorten the heading, please" });
    expect(t.status).toBe(200);
    await voice.voiceTranscript(deps, { role: "assistant", text: "Done — the title is now Transformers.", convId: t.body.convId });
    // What a Ctrl+L side thread with no conversation gets (the same layer, through the same function).
    const sum = { activity: act.youLayer(vault).text };
    expect(sum.activity).toContain(`Voice (in chat ${t.body.convId}): Carl said: "shorten the heading, please"`);
    // Voice's reply is that conversation's content: it stays there.
    expect(sum.activity).not.toContain("Done — the title is now Transformers.");
    // The chat it was said in has it in its own thread (its pi session): not again in its layer.
    expect(act.youLayer(vault, { convId: String(t.body.convId) }).text).not.toContain("shorten the heading, please");
    // Another chat.
    const chat = await chatTurn(engine, backend, { text: "what did I just say by voice?" });
    expect(chat.texts).toContain('Carl said: "shorten the heading, please"');
  });

  it("an image capture is stored under .vault-chat/local/captures and the chat's you layer references it", async () => {
    const r = act.activityPost(vault, {
      entry: { kind: "capture", modality: "capture", text: "captured a region for the chat", path: "paper.pdf", where: "page 2", image: "notes/a.md" },
      imageBase64: PNG,
      imageMime: "image/png",
    });
    expect(r.status).toBe(200);
    const rel = String(r.body.image);
    expect(rel).toMatch(/^\.vault-chat\/local\/captures\/[a-z0-9]+-[a-z0-9]+\.png$/);
    expect(readFileSync(join(vault, ...rel.split("/"))).toString("base64")).toBe(PNG);
    // No base64 in the log, ever.
    expect(logOf(vault)).not.toContain(PNG.slice(0, 40));
    const chat = await chatTurn(engine, backend, { text: "what's in the thing I just circled?" });
    expect(chat.texts).toContain(`capture of paper.pdf (page 2) — captured a region for the chat: ${rel}`);
  });

  it("Ask from a fresh call: its side request carries the call's lines before it (no session to fork yet), and starts no turn", async () => {
    const line = await voice.voiceTranscript(deps, { role: "user", text: "can you have the agent summarise the transformers note" });
    const before = backend.turns.length;
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Summarise notes/a.md into notes/summary.md", act: true }, convId: line.body.convId });
    expect(r.convId).toBe(line.body.convId);
    await voice.voiceAsksSettled();
    const s = sideAsks.at(-1)!;
    expect(s).toMatchObject({ kind: "voice-act", convId: line.body.convId, tools: "act" });
    expect(s.text).toContain("can you have the agent summarise the transformers note");
    expect(s.text).toContain("Summarise notes/a.md into notes/summary.md");
    expect(backend.turns.length).toBe(before);
  });

  it("a voice session on a chat has that chat's turns and the recent stream (its you layer)", async () => {
    const { appendMessage, createConv } = await import("../engine/convs");
    const c = await createConv(vault, {}, "Planning the survey");
    await appendMessage(vault, c.id, { role: "user", content: "Draft section 4 on KV caches" });
    await appendMessage(vault, c.id, { role: "assistant", content: "Section 4 drafted in survey.md." });
    const prompt = await voice.voicePrompt(deps, c.id, "phone");
    expect(prompt).toContain('This conversation — "Planning the survey"');
    expect(prompt).toContain("Carl: Draft section 4 on KV caches");
    expect(prompt).toContain("Agent: Section 4 drafted in survey.md.");
    expect(prompt).toContain("<you>");
    expect(prompt).toContain('Carl said: "shorten the heading, please"');
  });

  it("two vaults: the second never sees the first's entries, and its own stay its own", async () => {
    expect(act.youLayer(vault2).text).toBe("");
    const chat2 = await chatTurn(engine2, backend2, { text: "what did I just do?" });
    expect(chat2.texts).not.toContain("<you>");
    expect(chat2.texts).not.toContain("notes/a.md");
    // vault2's own entry stays in vault2.
    act.activityPost(vault2, { entry: { kind: "edit", modality: "ctrl-k", text: '"lab only edit"', path: "notes/b.md" } });
    expect(act.youLayer(vault2).text).toContain("lab only edit");
    expect(act.youLayer(vault).text).not.toContain("lab only edit");
    expect(logOf(vault)).not.toContain("lab only edit");
    const chat1 = await chatTurn(engine, backend, { text: "anything new?" });
    expect(chat1.texts).not.toContain("lab only edit");
  });

  it("with VC_ACTIVITY=0 nothing is written by any surface", async () => {
    const size = logOf(vault).length;
    process.env.VC_ACTIVITY = "0";
    await voice.voiceTranscript(deps, { role: "user", text: "silent" });
    act.activityPost(vault, { entry: { kind: "edit", text: "off" } });
    await chatTurn(engine, backend, { text: "off" });
    expect(logOf(vault).length).toBe(size);
  });
});
