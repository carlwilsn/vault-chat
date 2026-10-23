// One agent, many modalities: what one mode did reaches the next (engine on a
// fake pi, voice's routes for real, the Ctrl+K / Ctrl+L routes the laptop
// calls). Covers: a chat's latest exchange in the stream (both sides, capped,
// only the latest per chat); the capture itself going with a request that is
// about it (box chat turn → the turn's images; Ctrl+K/L → the image route),
// once, capped; the "Now" working set at the top of the summary.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcm-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "notes"), { recursive: true });
git(vault, "init", "-q");
writeFileSync(join(vault, "notes", "kv.md"), "# KV caches\nkeys and values\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** pi, faked: every turn recorded (texts and images); a turn ends with the reply it is given. */
class FakeBackend extends EventEmitter {
  readonly name = "pi";
  turns: { threadId: string; texts: string[]; images: string[]; turnId: string }[] = [];
  private n = 0;
  setHandlers() {}
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    return { threadId: `t${++this.n}`, ref: undefined };
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
  reply(text: string) {
    const t = this.turns[this.turns.length - 1]!;
    if (text) for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: t.threadId, ...x });
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let act: typeof import("../activity");
let core: typeof import("../../src/activityCore");
let voice: typeof import("../voice");
let engine: any;
let backend: FakeBackend;
let deps: import("../voice").VoiceDeps;

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A chat message, answered with `reply`: the turn's texts, images and conversation. */
async function chatTurn(body: Record<string, unknown>, reply = "ok"): Promise<{ texts: string; images: string[]; convId: string }> {
  const before = backend.turns.length;
  // No convId: a chat of its own (a separate chat; a message naming none would be Main's).
  const out = await engine.message({ ...(body.convId ? {} : { convId: `sep-${Math.random().toString(36).slice(2, 10)}` }), ...body });
  expect(out?.ok).toBe(true);
  await until(() => backend.turns.length > before);
  const t = backend.turns[backend.turns.length - 1]!;
  backend.reply(reply);
  const { readConv } = await import("../engine/convs");
  await until(async () => (await readConv(vault, String(out.convId)))?.state !== "running");
  // Carl's message is in the stream as a pointer (the reply never is).
  await until(() => act.readActivity(vault).some((e) => e.kind === "chat" && e.convId === out.convId));
  return { texts: t.texts.join("\n\n"), images: t.images, convId: String(out.convId) };
}

/** Back-date every entry so far (the stream's clock is Date.now()). */
function age(min: number) {
  const p = join(vault, ".vault-chat", "local", "activity.jsonl");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    const e = JSON.parse(l);
    e.ts -= min * 60_000;
    return JSON.stringify(e);
  });
  writeFileSync(p, lines.join("\n") + "\n");
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
  core = await import("../../src/activityCore");
  voice = await import("../voice");
  deps = { vault, name: "main", main: true, message: (b) => engine.message(b) };
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

// ---------------------------------------------------------------- unit

describe("pure parts", () => {
  const now = 50_000_000;
  const E = (ago: number, e: Partial<import("../../src/activityCore").ActivityEntry>) =>
    ({ ts: now - ago * 60_000, modality: "editor", kind: "focus", text: "x", ...e }) as import("../../src/activityCore").ActivityEntry;

  it("a chat pointer: Carl's words only (capped, markdown stripped), never the agent's", () => {
    const e = core.chatPointerEntry({ convId: "c1", title: "KV", user: `explain **KV** caching ${"and more ".repeat(40)}`, device: "phone" });
    expect(e.text).toBe("KV");
    expect(e.detail).toMatch(/^Carl: "explain KV caching and more/);
    expect(e.detail!.length).toBeLessThanOrEqual(core.GIST_MAX + 10);
    expect(e.detail).not.toContain("Agent");
    expect(e.device).toBe("phone");
    const s = core.sanitizeEntry(e, now);
    expect(s?.detail).toBe(e.detail); // fits the log's caps unchanged
    expect(s?.device).toBe("phone");
  });

  it("each of Carl's messages in another chat is a pointer, newest kept; a repeat counts once", () => {
    const P = (ago: number, user: string) => E(ago, core.chatPointerEntry({ convId: "c1", title: "KV", user }) as any);
    const s = core.buildYouLayer({ entries: [P(5, "first question"), P(3, "second question"), P(2, "second question")] }, { now }).text;
    expect(s).toContain("[KV chat, 5 min ago] Carl: first question (id c1)");
    expect(s.match(/second question/g)).toHaveLength(1);
    expect(s).not.toContain("Agent");
  });

  it("where he is, then each kind in its section: focus and selection, captures, other chats, the other surfaces", () => {
    const s = core.buildYouLayer(
      {
        entries: [
          E(20, { kind: "ask", modality: "ctrl-l", text: 'asked "old question"' }),
          E(12, { text: "opened the file", path: "notes/a.md" }),
          E(9, { kind: "edit", modality: "ctrl-k", text: '"shorter"', path: "notes/a.md", outcome: "accepted", detail: "replaced 1 line(s) with 1" }),
          E(8, { kind: "voice", modality: "voice", text: 'Carl said: "read me page 3"', convId: "v1" }),
          E(7, { kind: "voice", modality: "voice", text: 'Voice replied: "Page 3 is about RoPE."', convId: "v1" }),
          E(6, { kind: "voice", modality: "voice", text: "Voice wrote notes/rope.md", convId: "v1" }),
          E(5, { text: "reading", path: "paper.pdf", where: "page 3 of 12", device: "laptop" }),
          E(4, { text: 'selected "rotary position embedding"', path: "paper.pdf", where: "selection" }),
          E(3, { kind: "capture", modality: "capture", text: "captured a region", path: "paper.pdf", where: "page 3", image: ".vault-chat/local/captures/a.png" }),
          E(2, { kind: "ask", modality: "ctrl-l", text: 'asked "what is this"', detail: "answer: a rotation" }),
          E(1, core.chatPointerEntry({ convId: "c9", title: "RoPE", user: "summarise it", device: "phone" }) as any),
        ],
      },
      { now },
    ).text;
    expect(s).toContain("Device: phone (1 min ago)");
    expect(s).toContain('Focus: paper.pdf (page 3 of 12), 5 min ago — current selection: "rotary position embedding"');
    expect(s).toContain("capture of paper.pdf (page 3) — captured a region: .vault-chat/local/captures/a.png");
    expect(s).toContain("[RoPE chat, 1 min ago] Carl: summarise it (id c9)");
    expect(s).toContain('Ctrl+L ask: asked "what is this" — answer: a rotation');
    expect(s).toContain('"shorter" (accepted)');
    expect(s).toContain('Carl said: "read me page 3"');
    expect(s).toContain("Voice wrote notes/rope.md");
    expect(s).toContain('asked "old question"');
    // Another conversation's reply (voice's here) stays in it.
    expect(s).not.toContain("Page 3 is about RoPE.");
    // The file seen before the PDF is replaced by where he is now.
    expect(s).not.toContain("Focus: notes/a.md");
    expect(s.indexOf("Other chats")).toBeLessThan(s.indexOf("Elsewhere"));
    expect(s.length).toBeLessThanOrEqual(core.YOU_MAX_CHARS);
    // `since`: nothing new → nothing.
    expect(core.buildYouLayer({ entries: [E(5, { text: "x", path: "a.md" })] }, { now, since: now - 60_000 }).text).toBe("");
  });

  it("the total cap holds with long lines everywhere", () => {
    const big = "w".repeat(280);
    const many = Array.from({ length: 120 }, (_, i) => E(29 - i * 0.2, { kind: "voice", modality: "voice", text: `Voice ran a command: ${i} ${big}` }));
    many.push(E(1, { kind: "ask", modality: "ctrl-l", text: `asked "${big}"`, detail: `answer: ${"a".repeat(590)}` }));
    many.push(E(1, core.chatPointerEntry({ convId: "c", title: big, user: big }) as any));
    many.push(E(1, { text: `selected "${big}"`, path: "p.md", where: "selection" }));
    const s = core.buildYouLayer({ entries: many }, { now }).text;
    expect(s.length).toBeLessThanOrEqual(core.YOU_MAX_CHARS);
    expect(s).toMatch(/older entries left out/);
    expect(s.endsWith("</you>")).toBe(true);
    for (const l of s.split("\n")) expect(l.length).toBeLessThanOrEqual(600);
  });

  it("which requests are about an image", () => {
    const cap = E(1, { kind: "capture", modality: "capture", text: "captured", image: ".vault-chat/local/captures/a.png" });
    const old = E(10, { kind: "capture", modality: "capture", text: "captured", image: ".vault-chat/local/captures/old.png" });
    const pick = (t: string, o: { deictic?: boolean; exclude?: string[] } = {}, es = [old, cap]) => core.pickContextImage(es, t, { now, ...o })?.image ?? null;
    for (const t of ["what does this plot show?", "explain the figure", "is that screenshot right", "what I just circled", "I circled a term — what is it?", "the captured region, explained", "look at my last capture"]) {
      expect(pick(t), t).toBe(".vault-chat/local/captures/a.png");
    }
    for (const t of ["make the title shorter", "summarise notes/a.md", "what is RoPE"]) expect(pick(t, { deictic: true }), t).toBeNull();
    // "this" counts only with deictic, and only for a fresh capture.
    expect(pick("what is this?")).toBeNull();
    expect(pick("what is this?", { deictic: true })).toBe(".vault-chat/local/captures/a.png");
    expect(pick("what is this?", { deictic: true }, [old])).toBeNull();
    expect(pick("explain the figure", {}, [old])).toBe(".vault-chat/local/captures/old.png");
    // Already given: not again.
    expect(pick("explain the figure", { exclude: [".vault-chat/local/captures/a.png"] })).toBeNull();
    // Outside the window: never.
    expect(pick("explain the figure", {}, [E(40, { kind: "capture", modality: "capture", text: "c", image: ".vault-chat/local/captures/z.png" })])).toBeNull();
  });
});

// ---------------------------------------------------------------- in process

describe("mode A, then mode B sees it", () => {
  it("chat → Ctrl+L and voice: Carl's message as a pointer, never the agent's reply", async () => {
    const reply = "A KV cache keeps the attention keys and values of earlier tokens so each new token only computes its own.";
    const c = await chatTurn({ text: "explain KV caching in one paragraph" }, reply);
    // Ctrl+L / Ctrl+K side threads and voice read the same layer.
    const sum = act.youLayer(vault).text;
    expect(sum).toContain("Carl: explain KV caching in one paragraph");
    expect(sum).not.toContain("A KV cache keeps");
    const block = await voice.voicePrompt(deps, null, "phone");
    expect(block).toContain("Carl: explain KV caching in one paragraph");
    expect(block).not.toContain("A KV cache keeps");
    // A second message is a second pointer; the reply is still that chat's.
    await chatTurn({ text: "and in MLA?", convId: c.convId }, "MLA compresses the KV cache into a latent.");
    const sum2 = act.youLayer(vault).text;
    expect(sum2).toContain("Carl: and in MLA?");
    expect(sum2).not.toContain("MLA compresses");
    // The chat's own next turn does not read its own messages back.
    const own = await chatTurn({ text: "thanks", convId: c.convId });
    expect(own.texts).not.toContain("Carl: and in MLA?");
  });

  it("Ctrl+L, Ctrl+K and voice → the next chat turn's you layer", async () => {
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "reading", path: "paper.pdf", where: "page 4 of 9" } });
    act.activityPost(vault, { entry: { kind: "ask", modality: "ctrl-l", text: 'asked "what is eq. 3"', detail: "answer: the softmax over scaled scores", path: "paper.pdf", where: "page 4" } });
    act.activityPost(vault, { entry: { kind: "edit", modality: "ctrl-k", text: '"fix the typo"', detail: 'replaced 1 line(s) with 1: "teh" → "the"', outcome: "accepted", path: "notes/kv.md" } });
    await voice.voiceTranscript(deps, { role: "user", text: "what page am I on" });
    const t = await voice.voiceTranscript(deps, { role: "assistant", text: "You are on page four." });
    expect(t.status).toBe(200);
    const c = await chatTurn({ text: "where was I?" });
    const you = c.texts.slice(c.texts.indexOf("<you>"), c.texts.indexOf("</you>"));
    expect(you).toContain("Focus: paper.pdf (page 4 of 9)");
    expect(you).toContain('Ctrl+L ask · paper.pdf (page 4): asked "what is eq. 3" — answer: the softmax over scaled scores');
    expect(you).toContain('Ctrl+K edit · notes/kv.md: "fix the typo" (accepted)');
    expect(you).toContain('Carl said: "what page am I on"');
    // Voice's reply is the voice conversation's: not here.
    expect(you).not.toContain("You are on page four.");
    // The chat from the test before: Carl's message, as a pointer.
    expect(you).toContain("Carl: thanks");
  });

  it("a capture → the chat turn about it gets the image itself, once; an unrelated or stale one does not", async () => {
    const r = act.activityPost(vault, {
      entry: { kind: "capture", modality: "capture", text: "captured a region", path: "paper.pdf", where: "page 4" },
      imageBase64: PNG,
      imageMime: "image/png",
    });
    const rel = String(r.body.image);
    const abs = join(vault, ...rel.split("/"));
    const c = await chatTurn({ text: "what does this plot show?" });
    expect(c.images).toEqual([abs]);
    expect(c.texts).toContain("[Attached: Carl's latest image capture from paper.pdf (page 4)");
    // The same chat, the same capture: not again.
    const again = await chatTurn({ text: "and the axis of that plot?", convId: c.convId });
    expect(again.images).toEqual([]);
    // Another chat, an unrelated message: no image.
    const other = await chatTurn({ text: "list my notes" });
    expect(other.images).toEqual([]);
    // "this" alone: only while the capture is fresh.
    const fresh = await chatTurn({ text: "what is this?" });
    expect(fresh.images).toEqual([abs]);
    age(5);
    const stale = await chatTurn({ text: "what is this?" });
    expect(stale.images).toEqual([]);
    // Named, it still counts within the window.
    const named = await chatTurn({ text: "explain the figure I captured" });
    expect(named.images).toEqual([abs]);
    // A message with its own image: that one, and the capture is not added.
    const own = await engine.message({ text: "what about this plot?", images: [{ mime: "image/png", dataBase64: PNG }] });
    await until(() => backend.turns.at(-1)!.texts.join("").includes("what about this plot?"));
    const ownTurn = backend.turns.at(-1)!;
    expect(ownTurn.images).toHaveLength(1);
    expect(ownTurn.images[0]).not.toBe(abs);
    backend.reply("ok");
    const { readConv } = await import("../engine/convs");
    await until(async () => (await readConv(vault, String(own.convId)))?.state !== "running");
  });

  it("Ctrl+K / Ctrl+L: the image route gives the capture as data, capped", async () => {
    const r = act.activityPost(vault, {
      entry: { kind: "capture", modality: "capture", text: "captured a region", path: "fig.pdf", where: "page 1" },
      imageBase64: PNG,
      imageMime: "image/png",
    });
    const rel = String(r.body.image);
    const out = act.activityImageRoute(vault, { text: "what is in this figure?" }) as any;
    expect(out.image.path).toBe(rel);
    expect(out.image.dataBase64).toBe(PNG);
    expect(out.image.mime).toBe("image/png");
    expect(out.image.caption).toContain("from fig.pdf (page 1)");
    expect((act.activityImageRoute(vault, { text: "make it shorter" }) as any).image).toBeNull();
    expect((act.activityImageRoute(vault, { text: "what is this", deictic: true }) as any).image.path).toBe(rel);
    expect((act.activityImageRoute(vault, { text: "the figure", exclude: [rel] }) as any).image).toBeNull();
    // Too big for a request: not sent.
    const big = act.activityPost(vault, {
      entry: { kind: "capture", modality: "capture", text: "captured a big region" },
      imageBase64: Buffer.alloc(core.CONTEXT_IMAGE_MAX_BYTES + 10, 1).toString("base64"),
      imageMime: "image/png",
    });
    expect(big.body.image).toBeTruthy();
    expect((act.activityImageRoute(vault, { text: "the figure" }) as any).image).toBeNull();
  });
});
