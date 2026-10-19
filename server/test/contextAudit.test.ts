// The context audit: the exact prompt each mode sends for one realistic
// sample — a box chat's first turn (developer instructions + the message +
// the "you" layer pi's extension adds after it), its next turn, a turn after a
// roll-over (new instructions with the recap), a voice session's prompt (the
// box's), a Ctrl+K and a Ctrl+L request (a side thread forking that chat's pi
// session: its instructions and history are the chat's, so only the request and
// the layer the extension adds to it are audited) — assembled by the
// real code (the engine on a fake pi, voice's builder, the inline builders). Each is written, normalised, to
// server/test/__snapshots__/context-audit/<mode>.txt (committed: a change to
// what a model receives shows in review) and, with a per-section token
// estimate and the duplication found, to preview-proof/context-audit/.
// Assertions: no section of a prompt says the same thing twice, the removed
// long-run features are nowhere, and the shared block keeps its caps.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcaudit-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "papers"), { recursive: true });
git(vault, "init", "-q");
writeFileSync(join(vault, "papers", "attention.md"), "# Attention\n");
writeFileSync(join(vault, ".vault-chat", "rules.md"), "- Cite the page when you quote a paper.\n- Never edit files under courses/ without asking.\n");
writeFileSync(join(vault, "AGENTS.md"), "# How I work\n\nI study ML papers. Explain with one worked example.\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SNAP = resolve(__dirname, "__snapshots__", "context-audit");
const PROOF = resolve(__dirname, "..", "..", "preview-proof", "context-audit");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  threads: { threadId: string; instructions: string }[] = [];
  turns: { threadId: string; texts: string[]; images: string[]; turnId: string }[] = [];
  setHandlers() {}
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread(o: any) {
    const threadId = `t${this.threads.length + 1}`;
    this.threads.push({ threadId, instructions: o.instructions });
    return { threadId, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    const turnId = `${threadId}-turn${this.turns.length + 1}`;
    // What the model gets this turn: the prompt, then the "you" layer pi adds after it (the extension, fakeSession.ts).
    this.turns.push({ threadId, texts: o.you ? [...o.texts, o.you] : o.texts, images: o.images ?? [], turnId });
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
  // Side threads (pi/side.ts): what the engine asks pi for.
  sides: any[] = [];
  paths = { sessionsDir: join(root, "pi", "sessions"), instrDir: join(root, "pi", "instr") };
  side = {
    start: async (o: any) => {
      this.sides.push(o);
      return { id: `side${this.sides.length}`, text: "", v: 0, done: false, error: null, file: null };
    },
  };
  threadSource(threadId: string) {
    return { file: join(root, "pi", `${threadId}.jsonl`), instr: join(root, "pi", `${threadId}.md`), cwd: vault };
  }
  reply(text: string) {
    const t = this.turns[this.turns.length - 1]!;
    for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: t.threadId, ...x });
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let engine: any;
let backend: FakeBackend;
let act: typeof import("../activity");

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function turn(body: Record<string, unknown>, reply: string) {
  const before = backend.turns.length;
  const threadsBefore = backend.threads.length;
  const out = await engine.message(body);
  await until(() => backend.turns.length > before);
  const t = backend.turns.at(-1)!;
  const instructions = backend.threads.length > threadsBefore ? backend.threads.at(-1)!.instructions : null;
  backend.reply(reply);
  const { readConv } = await import("../engine/convs");
  await until(async () => (await readConv(vault, String(out.convId)))?.state !== "running");
  return { texts: t.texts, images: t.images, instructions, convId: String(out.convId) };
}

// ---------------------------------------------------------------- the report

type Section = { name: string; chars: number; tokens: number };
type ModeReport = { mode: string; chars: number; tokens: number; sections: Section[]; duplicates: { text: string; count: number }[]; leftovers: string[] };

const tok = (s: string) => Math.ceil(s.length / 4);

/** Split a prompt part into sections: a heading, a tag block, or a "Label:" line starts one. */
function sections(label: string, text: string): Section[] {
  const out: Section[] = [];
  let name = `${label}: (start)`;
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n");
    if (t.trim()) out.push({ name, chars: t.length, tokens: tok(t) });
    buf = [];
  };
  for (const l of text.split("\n")) {
    const h = /^(#{1,2} .{0,70}|<([a-z_]+)>|[A-Z][A-Za-z ,&()'-]{2,60}:)$/.exec(l.trim());
    if (h && !l.startsWith(" ")) {
      flush();
      name = `${label}: ${h[1]!.slice(0, 70)}`;
    }
    buf.push(l);
  }
  flush();
  return out;
}

/** Paragraphs and long lines that occur more than once across the whole prompt a model holds. */
function duplicates(all: string): { text: string; count: number }[] {
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const l of all.split("\n")) {
    const t = l.trim();
    if (t.length >= 40 && !/^[-=#`]+$/.test(t)) add(t);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([text, count]) => ({ text: text.slice(0, 160), count }));
}

const REMOVED = /SetProject|ProjectMemory|ProjectCost|Done means proved|^## (memory|plan|progress).md|SetBudget|SetCheck|SetMetric|RunWorkers|TaskAdd|TaskClaim|TaskUpdate|TaskList|<status>|budget|plateau|worker conversation|Done when.*command|pinned check/i;

function normalise(s: string): string {
  return s
    .split(vault.replace(/\\/g, "/"))
    .join("<vault>")
    .split(vault)
    .join("<vault>")
    .replace(/\[(\d+ min ago|just now|\d+ h \d+ min ago)\]/g, "[N min ago]")
    .replace(/, (\d+ min ago|just now)\]/g, ", N min ago]")
    .replace(/\((\d+ min ago|just now)\)/g, "(N min ago)")
    .replace(/, (\d+ min ago|just now)( —|$)/gm, ", N min ago$2")
    .replace(/[0-9a-f]{8}-[0-9a-f]{3,4}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/g, "<id>")
    .replace(/\.vault-chat\/local\/captures\/[a-z0-9]+-[a-z0-9]+\.png/g, ".vault-chat/local/captures/<capture>.png")
    .replace(/Current date and time: [^\n]*/g, "Current date and time: <now>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/\\/g, "/");
}

const reports: ModeReport[] = [];

/** Record a mode: its parts (in the order the model reads them), snapshot and report. */
async function audit(mode: string, parts: { label: string; text: string }[]): Promise<ModeReport> {
  const full = parts.map((p) => `===== ${p.label} =====\n${normalise(p.text)}`).join("\n\n");
  const secs = parts.flatMap((p) => sections(p.label, normalise(p.text)));
  const all = parts.map((p) => normalise(p.text)).join("\n");
  const r: ModeReport = {
    mode,
    chars: all.length,
    tokens: tok(all),
    sections: secs,
    duplicates: duplicates(all),
    leftovers: all.split("\n").filter((l) => REMOVED.test(l)).map((l) => l.slice(0, 160)),
  };
  reports.push(r);
  mkdirSync(PROOF, { recursive: true });
  writeFileSync(join(PROOF, `${mode}.txt`), full);
  await expect(full).toMatchFileSnapshot(join(SNAP, `${mode}.txt`));
  return r;
}

// ---------------------------------------------------------------- the sample

let convId = "";

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const ctx = await import("../context");
  ctx.configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  ctx.withVault(vault, () => ctx.ensureProject("Coconut", "Detect coconuts in drone images."));
  const pdir = join(vault, "agent-projects", "coconut");
  writeFileSync(join(pdir, "memory.md"), "# Memory\n\n## Decisions\n\n- YOLOv8 at 640px; tiles of 1024 with 128 overlap.\n- Labels in labels/ (CVAT export).\n\n## Learned\n\n- Shadows cause false positives before 9am.\n");
  writeFileSync(join(pdir, "plan.md"), "# Plan\n\n1. Tile the March flight.\n2. Train v3.\n3. Count per hectare.\n");
  writeFileSync(join(pdir, "progress.md"), "# Progress\n\n- 2026-10-14: tiled the March flight (4,812 tiles).\n- 2026-10-15: v3 training started, mAP50 0.71 at epoch 20.\n");
  writeFileSync(join(pdir, "rules.md"), "- Report mAP50 and the count error together.\n");
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend(), join(root, "pi"));
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => null,
    log: () => {},
  });
  engine.start();
  act = await import("../activity");
  // What Carl did across his surfaces before he opens the chat.
  act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "reading", path: "papers/yolo.pdf", where: "page 4 of 15", project: "coconut" } });
  act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: 'selected "anchor-free detection head"', path: "papers/yolo.pdf", where: "selection", project: "coconut" } });
  act.activityPost(vault, { entry: { kind: "capture", modality: "capture", text: "captured a region", path: "papers/yolo.pdf", where: "page 4", project: "coconut" }, imageBase64: PNG, imageMime: "image/png" });
  act.activityPost(vault, { entry: { kind: "ask", modality: "ctrl-l", text: 'asked "what does the decoupled head change?"', detail: "answer: classification and box regression get separate branches, which speeds convergence.", path: "papers/yolo.pdf", where: "page 4", project: "coconut" } });
  act.activityPost(vault, { entry: { kind: "edit", modality: "ctrl-k", text: '"tighten this paragraph"', detail: 'replaced 3 line(s) with 2: "We use a detector that..." → "We use YOLOv8..."', outcome: "accepted", path: "agent-projects/coconut/project.md", project: "coconut" } });
  act.activityPost(vault, { entry: { kind: "voice", modality: "voice", text: 'Carl said: "how many tiles did the March flight make?"' } });
  act.activityPost(vault, { entry: { kind: "voice", modality: "voice", text: 'Voice replied: "4,812 tiles, from the progress notes."' } });
});

afterAll(() => {
  engine?.stop();
  mkdirSync(PROOF, { recursive: true });
  writeFileSync(join(PROOF, "report.json"), JSON.stringify(reports, null, 2));
  // One table on the console: what each mode sends, by section.
  for (const r of reports) {
    console.log(`\n${r.mode}: ~${r.tokens} tokens (${r.chars} chars)`);
    for (const s of r.sections) console.log(`  ${String(s.tokens).padStart(6)}  ${s.name}`);
    if (r.duplicates.length) console.log(`  duplicates: ${r.duplicates.map((d) => `${d.count}× "${d.text.slice(0, 70)}"`).join("; ")}`);
    if (r.leftovers.length) console.log(`  leftovers: ${r.leftovers.join(" | ")}`);
  }
  cleanup(root);
});

describe("what each mode sends", () => {
  it("box chat: first turn (developer instructions + message + you layer), then the next turn", async () => {
    const { createConv, appendMessage } = await import("../engine/convs");
    const c = await createConv(vault, { project: "coconut" } as any, "YOLO tiling");
    convId = c.id;
    const first = await turn({ text: "Given what I just captured, should we switch to the decoupled head?", convId }, "Yes for v4: the decoupled head converged faster in the paper (p. 4). I would keep 640px tiles.");
    expect(first.instructions).toBeTruthy();
    expect(first.images).toHaveLength(1); // "what I just captured" → the capture itself
    const r1 = await audit("box-chat-first-turn", [
      { label: "developer instructions (thread)", text: first.instructions! },
      ...first.texts.map((t, i) => ({ label: `turn input ${i + 1}`, text: t })),
    ]);
    // Something new elsewhere, then the next turn of the same chat.
    act.activityPost(vault, { entry: { kind: "ask", modality: "ctrl-l", text: 'asked "what is mAP50?"', detail: "answer: mean average precision at IoU 0.5.", project: "coconut" } });
    const next = await turn({ text: "OK, plan it.", convId }, "Planned in plan.md.");
    expect(next.instructions).toBeNull();
    const r2 = await audit("box-chat-next-turn", next.texts.map((t, i) => ({ label: `turn input ${i + 1}`, text: t })));
    // The thread holds instructions + both turns: nothing said twice.
    const thread = [first.instructions!, ...first.texts, ...next.texts].map(normalise).join("\n");
    expect(duplicates(thread)).toEqual([]);
    expect([...r1.leftovers, ...r2.leftovers]).toEqual([]);
    // The rules are in the instructions; a turn repeats them only when they change.
    expect(first.texts.join("\n")).not.toContain("<rules>");
    expect(next.texts.join("\n")).not.toContain("<rules>");
    writeFileSync(join(vault, ".vault-chat", "rules.md"), "- Cite the page when you quote a paper.\n- Never edit files under courses/ without asking.\n- Answer in English.\n");
    const changed = await turn({ text: "Noted?", convId }, "Noted.");
    expect(changed.texts.join("\n")).toContain("<rules>");
    expect(changed.texts.join("\n")).toContain("- Answer in English.");
    const after = await turn({ text: "Go on.", convId }, "OK.");
    expect(after.texts.join("\n")).not.toContain("<rules>");
    void appendMessage;
  });

  it("box chat after a roll-over: the new thread's instructions carry the recap", async () => {
    // The roll-over as the engine writes it: the divider item, and the thread retired with its recap.
    const { emitTo, appendNotes } = await import("../engine/convs");
    const recap = "## Goal\n\nDetect coconuts; v3 training.\n\n## Decided\n\n- Decoupled head for v4.\n\n## Project memory at roll-over (Coconut)\n\n# Memory\n\n## Decisions\n\n- YOLOv8 at 640px; tiles of 1024 with 128 overlap.";
    appendNotes(vault, convId, [{ kind: "divider", text: recap, rollover: true }]);
    emitTo(vault, convId, { type: "meta", patch: { recap, threadId: null, threadPath: null } });
    const r = await turn({ text: "Where are we?", convId }, "v3 is training; v4 gets the decoupled head.");
    expect(r.instructions).toBeTruthy();
    const rep = await audit("box-chat-rollover-turn", [
      { label: "developer instructions (new thread)", text: r.instructions! },
      ...r.texts.map((t, i) => ({ label: `turn input ${i + 1}`, text: t })),
    ]);
    expect(rep.leftovers).toEqual([]);
    expect(r.instructions).toContain("# Recap: this conversation continues from an earlier session");
  });

  it("voice session (the box's prompt, started from the chat)", async () => {
    const v = await import("../../src/voice-elevenlabs");
    const meta = await import("../../src/meta");
    const voice = await import("../voice");
    const { readConv } = await import("../engine/convs");
    const store = (await import("../../src/store")).useStore;
    const conv = await readConv(vault, convId);
    const state = { ...store.getState(), vaultPath: vault, followAlong: true } as any;
    const base = v.buildSystemPrompt(
      state,
      await meta.loadVaultVoicePrompt(vault),
      await meta.loadVaultNorthStar(vault),
      await v.loadVoicePromptContext(vault),
      (conv?.messages ?? []) as any,
      true,
      await voice.fileIndex(vault),
      [],
    );
    // As voiceSession: the chat's last exchange only when the builder did not carry its turns.
    const shared = await voice.voiceContextBlock({ vault, name: "main", main: true } as any, convId, { exchange: !voice.hasThreadHistory(base) });
    const rep = await audit("voice-session", [{ label: "voice system prompt", text: voice.composeVoicePrompt(base, shared) }]);
    expect(rep.leftovers).toEqual([]);
    expect(rep.duplicates).toEqual([]);
  });

  it("Ctrl+K and Ctrl+L requests (side threads of the chat)", async () => {
    const inline = await import("../../src/inlineEdit");
    // As the box takes them (POST /api/v1/side): the engine forks the chat's thread with pi's read-only tools.
    const sent = async (req: any) => {
      const r = await engine.sideStart(req);
      expect(r.ok).toBe(true);
      const o = backend.sides[backend.sides.length - 1];
      expect(o.fork).toMatch(/\.jsonl$/);
      expect(o.tools).toEqual(["read", "grep", "find", "ls"]);
      return o.text as string;
    };
    // What pi's extension adds after the request (before_agent_start): the layer since the chat's last one,
    // as the engine answers the side thread's `__you` host call.
    const { readConv } = await import("../engine/convs");
    const { readEntries } = await import("../convlog/piSession");
    // @ts-ignore a plain .mjs (the pi extension's helpers)
    const { youSince } = await import("../engine/pi/ext/policy.mjs");
    const layerFor = async () => {
      const c: any = await readConv(vault, convId);
      return act.youLayer(vault, { convId, since: youSince(readEntries(c.threadPath)) }).text;
    };
    const k = inline.buildInlineEditRequest({
      prompt: "make this shorter",
      selection: "We tile each orthomosaic into 1024 px squares with 128 px of overlap so that coconuts on tile edges are seen whole at least once.",
      before: "# Coconut\n\n## What\n\nDetect coconuts in drone images.\n\n## How\n\n",
      after: "\n\n## Done when\n\n(not decided yet)\n",
      language: "markdown",
      convId,
    });
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "agent-projects/coconut/project.md", where: "L7" } });
    const rk = await audit("ctrl-k", [
      { label: "side request (after the chat's instructions and history)", text: await sent(k) },
      { label: "you layer (pi's extension, after the request)", text: await layerFor() },
    ]);
    const l = inline.buildInlineAskRequest({
      prompt: "why is the overlap 128?",
      selection: "128 px of overlap",
      before: "We tile each orthomosaic into 1024 px squares with ",
      after: " so that coconuts on tile edges are seen whole.",
      language: "markdown",
      convId,
    });
    const rl = await audit("ctrl-l", [
      { label: "side request (after the chat's instructions and history)", text: await sent(l) },
      { label: "you layer (pi's extension, after the request)", text: await layerFor() },
    ]);
    for (const r of [rk, rl]) {
      expect(r.leftovers).toEqual([]);
      expect(r.duplicates).toEqual([]);
    }
  });
});
