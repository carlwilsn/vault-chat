// The shared context stream (server/activity.ts, src/activityCore.ts): one
// activity log per vault, written by every surface, read by every surface.
// Unit: append, rotation, caps, redaction, the summary (dedupe, order, cap,
// project first, window), isolation, the off switch. In process (the engine
// on a fake pi, voice's tools for real): a Ctrl+K edit reaches the next chat
// turn's prefix; a voice turn with an Edit reaches a Ctrl+L summary and a chat
// turn; a capture's stored image is referenced; AskAgent's first turn carries
// the voice turns before it; a second vault never sees the first's entries.
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
    this.turns.push({ threadId, texts: o.texts, turnId });
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
  const out = await e.message(body);
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
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend("a"), join(root, "pi-a"));
  backend2 = withPiSessions(new FakeBackend("b"), join(root, "pi-b"));
  engine = makeEngine(Engine, vault, backend);
  engine2 = makeEngine(Engine, vault2, backend2);
  act = await import("../activity");
  core = await import("../../src/activityCore");
  voice = await import("../voice");
  deps = { vault, name: "main", main: true, shell: null, message: (b) => engine.message(b) };
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
    expect(e).toEqual({ ts: 1_000_000, kind: "focus", modality: "editor", text: "opened the file", path: "notes/x.md" });
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

describe("the summary", () => {
  const now = 10_000_000;
  const E = (ago: number, e: Partial<import("../../src/activityCore").ActivityEntry>) =>
    ({ ts: now - ago * 60_000, modality: "editor", kind: "focus", text: "x", ...e }) as import("../../src/activityCore").ActivityEntry;

  it("dedupes, orders oldest first, drops the window's outside, and is empty when there is nothing", () => {
    const s = core.summarizeActivity(
      [
        E(40, { text: "too old", path: "old.md" }),
        E(9, { text: "opened the file", path: "notes/a.md" }),
        E(8, { kind: "ask", modality: "ctrl-l", text: 'asked "what is RoPE"', path: "paper.pdf", where: "page 3" }),
        E(7, { text: "reading", path: "notes/a.md", where: "L4" }),
        E(6, { kind: "ask", modality: "ctrl-l", text: 'asked "what is RoPE"', path: "paper.pdf", where: "page 3" }),
        E(2, { kind: "chat", modality: "chat", text: 'Chat "Plan"', convId: "c1" }),
        E(1, { kind: "chat", modality: "chat", text: 'Chat "Plan v2"', convId: "c1" }),
      ],
      { now },
    );
    expect(s).toMatch(/^<recent_activity>/);
    expect(s).toMatch(/<\/recent_activity>$/);
    expect(s).not.toContain("too old");
    expect(s.match(/notes\/a\.md/g)).toHaveLength(1); // the later view of the file replaced the earlier
    expect(s).toContain("(L4)");
    expect(s.match(/what is RoPE/g)).toHaveLength(1);
    expect(s).not.toContain('"Plan"');
    expect(s).toContain('Chat "Plan v2"');
    expect(s.indexOf("what is RoPE")).toBeLessThan(s.indexOf("Plan v2")); // oldest first
    expect(s).toContain("1 min ago");
    expect(core.summarizeActivity([E(40, {})], { now })).toBe("");
  });

  it("puts the current project first, honours since and excludeConv, and keeps under the cap", () => {
    const entries = [
      E(5, { kind: "voice", modality: "voice", text: "Voice edited notes/x.md", project: "other" }),
      E(4, { kind: "edit", modality: "ctrl-k", text: '"tighten"', path: "coconut/readme.md", project: "coconut" }),
      E(3, { kind: "chat", modality: "chat", text: 'Chat "Me"', convId: "me" }),
      E(2, { kind: "ask", modality: "ctrl-l", text: 'asked "why"', project: "coconut" }),
      E(6, { kind: "voice", modality: "voice", text: "Voice wrote coconut/plan.md", project: "coconut" }),
    ];
    const s = core.summarizeActivity(entries, { now, project: "coconut", excludeConv: "me" });
    // Now: the last turn on each surface; then the earlier entries, the project's first.
    expect(s).toContain("## Now");
    expect(s).toContain("## Earlier — project coconut");
    expect(s).toContain("## Earlier — elsewhere in the vault");
    expect(s.indexOf("tighten")).toBeLessThan(s.indexOf("Voice edited"));
    expect(s.indexOf('asked "why"')).toBeLessThan(s.indexOf("Voice edited"));
    expect(s.indexOf("Voice wrote coconut/plan.md")).toBeLessThan(s.indexOf("Voice edited"));
    expect(s).not.toContain('Chat "Me"');
    const later = core.summarizeActivity(entries, { now, since: now - 2.5 * 60_000 });
    expect(later).toContain('asked "why"');
    expect(later).not.toContain("tighten");
    // The cap: many big entries, the newest kept, the project's first.
    const many = Array.from({ length: 200 }, (_, i) => E(29 - i * 0.1, { kind: "ask", modality: "ctrl-l", text: `question number ${i} ${"z".repeat(200)}` }));
    many.push(E(29.5, { kind: "edit", modality: "ctrl-k", text: "the project's edit", project: "coconut" }));
    const capped = core.summarizeActivity(many, { now, project: "coconut" });
    expect(capped.length).toBeLessThanOrEqual(core.SUMMARY_MAX_CHARS);
    expect(capped).toContain("the project's edit");
    expect(capped).toContain("question number 199");
    expect(capped).not.toContain("question number 0 ");
    expect(capped).toMatch(/older entries left out/);
  });

  it("formats each surface's entry with what is needed to act on it", () => {
    const s = core.summarizeActivity(
      [
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
      { now },
    );
    expect(s).toContain('Ctrl+K edit · notes/a.md: "make the title shorter" (accepted) — replaced 1 line(s) with 1: "# A very long title" → "# Short title"');
    expect(s).toContain("Image capture · paper.pdf (page 2): captured a region for the chat [image: .vault-chat/local/captures/x.png]");
  });

  it("the project's shared notes (project.md) and the rules, capped; an old memory.md is not read", async () => {
    const { ensureProject } = await import("../context");
    const { withVault } = await import("../context");
    withVault(vault, () => ensureProject("Coconut", "Detect coconuts in drone images."));
    writeFileSync(join(vault, "agent-projects", "coconut", "project.md"), `# Coconut\n\nDetect coconuts in drone images.\n\n- use YOLO\n${"filler ".repeat(3000)}`);
    writeFileSync(join(vault, "agent-projects", "coconut", "memory.md"), "# Memory\n\n- OLD-MEMORY\n");
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
  it("a Ctrl+K edit reaches the next chat turn's prefix, with what to undo — once", async () => {
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
    expect(first.texts).toContain("<recent_activity>");
    expect(first.texts).toContain("Ctrl+K edit · notes/a.md (L1)");
    expect(first.texts).toContain('"# A very long and winding title about transformers" → "# Transformers"');
    expect(first.texts).toContain("(accepted)");
    // The prefix comes before the message.
    expect(first.texts.indexOf("<recent_activity>")).toBeLessThan(first.texts.indexOf("undo the Ctrl+K edit"));
    // The same conversation's next turn: nothing new, no block again.
    const again = await chatTurn(engine, backend, { text: "thanks", convId: first.convId });
    expect(again.texts).not.toContain("<recent_activity>");
    // A different chat started afterwards points back at the first one, not at itself.
    const other = await chatTurn(engine, backend, { text: "what was I doing?" });
    expect(other.texts).toContain(`[conversation ${first.convId}]`);
    expect(other.texts).not.toContain(`[conversation ${other.convId}]`);
  });

  it("a voice turn with an Edit reaches a later Ctrl+L summary and a later chat turn", async () => {
    const t = await voice.voiceTranscript(deps, { role: "user", text: "make the title shorter" });
    expect(t.status).toBe(200);
    const edit = await voice.voiceTool(deps, { name: "Edit", args: { path: "notes/a.md", old_string: "# A very long and winding title about transformers", new_string: "# Transformers" } });
    expect(edit.result).not.toMatch(/^(Error|Refused)/);
    expect(readFileSync(join(vault, "notes", "a.md"), "utf8")).toMatch(/^# Transformers/);
    await voice.voiceTranscript(deps, { role: "assistant", text: "Done — the title is now Transformers.", convId: t.body.convId });
    // A read is not logged.
    await voice.voiceTool(deps, { name: "Read", args: { path: "notes/a.md" } });
    // What a Ctrl+L side thread gets (the activity block the box puts before it).
    const sum = { activity: act.activitySummary(vault) };
    expect(sum.activity).toContain('Voice: Carl said: "make the title shorter"');
    expect(sum.activity).toContain('Voice · notes/a.md: Voice edited notes/a.md — "# A very long and winding title about transformers" → "# Transformers"');
    expect(sum.activity).toContain('Voice replied: "Done — the title is now Transformers."');
    expect(sum.activity).not.toMatch(/Voice ran Read|Voice read/);
    // And the chat.
    const chat = await chatTurn(engine, backend, { text: "what did I just change by voice?" });
    expect(chat.texts).toContain('Carl said: "make the title shorter"');
    expect(chat.texts).toContain("Voice edited notes/a.md");
  });

  it("an image capture is stored under .vault-chat/local/captures and the chat prefix references it", async () => {
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
    expect(chat.texts).toContain(`[image: ${rel}]`);
    expect(chat.texts).toContain("Image capture · paper.pdf (page 2)");
  });

  it("AskAgent from voice: the new conversation's first turn carries the voice turns before it", async () => {
    await voice.voiceTranscript(deps, { role: "user", text: "can you have the agent summarise the transformers note" });
    const before = backend.turns.length;
    const r = JSON.parse((await voice.voiceTool(deps, { name: "AskAgent", args: { task: "Summarise notes/a.md into notes/summary.md" } })).result);
    expect(r.started).toBe(true);
    await until(() => backend.turns.length > before);
    const texts = backend.turns[backend.turns.length - 1]!.texts.join("\n\n");
    backend.end();
    expect(texts).toContain('Carl said: "can you have the agent summarise the transformers note"');
    expect(texts).toContain("Voice handed a task to the agent: Summarise notes/a.md into notes/summary.md");
    expect(texts).toContain("Summarise notes/a.md into notes/summary.md");
  });

  it("a voice session started from a chat knows its last exchange and the recent stream", async () => {
    const { appendMessage, createConv } = await import("../engine/convs");
    const c = await createConv(vault, {}, "Planning the survey");
    await appendMessage(vault, c.id, { role: "user", content: "Draft section 4 on KV caches" });
    await appendMessage(vault, c.id, { role: "assistant", content: "Section 4 drafted in survey.md." });
    const block = await voice.voiceContextBlock(deps, c.id);
    expect(block).toContain('started from the chat "Planning the survey"');
    expect(block).toContain("Carl: Draft section 4 on KV caches");
    expect(block).toContain("Agent: Section 4 drafted in survey.md.");
    expect(block).toContain("<recent_activity>");
    expect(block).toContain("Voice edited notes/a.md");
  });

  it("two vaults: the second never sees the first's entries, and its own stay its own", async () => {
    expect(act.activitySummary(vault2)).toBe("");
    const chat2 = await chatTurn(engine2, backend2, { text: "what did I just do?" });
    expect(chat2.texts).not.toContain("<recent_activity>");
    expect(chat2.texts).not.toContain("notes/a.md");
    // vault2's own entry stays in vault2.
    act.activityPost(vault2, { entry: { kind: "edit", modality: "ctrl-k", text: '"lab only edit"', path: "notes/b.md" } });
    expect(act.activitySummary(vault2)).toContain("lab only edit");
    expect(act.activitySummary(vault)).not.toContain("lab only edit");
    expect(logOf(vault)).not.toContain("lab only edit");
    const chat1 = await chatTurn(engine, backend, { text: "anything new?" });
    expect(chat1.texts).not.toContain("lab only edit");
  });

  it("with VC_ACTIVITY=0 nothing is written by any surface", async () => {
    const size = logOf(vault).length;
    process.env.VC_ACTIVITY = "0";
    await voice.voiceTranscript(deps, { role: "user", text: "silent" });
    await voice.voiceTool(deps, { name: "Write", args: { path: "notes/off.md", contents: "x" } });
    act.activityPost(vault, { entry: { kind: "edit", text: "off" } });
    await chatTurn(engine, backend, { text: "off" });
    expect(logOf(vault).length).toBe(size);
  });
});
