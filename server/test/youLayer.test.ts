// The "you" layer (Carl's conversation model, 2026-10-18): conversations are
// separate pi sessions and run in parallel; a shared sliding window of what Carl
// just did reaches every one of them; a conversation's content never bleeds
// into another (other chats are pointers to Carl's own words, read on request);
// a new conversation is a clean slate except for the layer.
//
// End to end on the real bundle: the engine on the fake pi (fakePiCli.mjs runs
// the extension's before_agent_start as pi does: the host call `__you` with the
// session's own `since`, the answer stored as a `vc-you` custom_message after
// the user message and sent to the model), a fake OpenRouter. Then the pure
// builder (src/activityCore.ts buildYouLayer): pointer format, budget, dedupe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import * as core from "../../src/activityCore";
// @ts-ignore a plain .mjs (the pi extension's helpers)
import { YOU_TYPE, youSince } from "../engine/pi/ext/policy.mjs";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
let srv: Running;

const get = async (p: string) => {
  const r = await fetch(srv.base + p);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: string, b: Record<string, unknown>) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: (await r.json()) as any };
};
const meta = async (conv: string) => (await get(`/api/v2/conversations/${conv}/checkpoint`)).body?.picture?.meta ?? {};
const idle = (conv: string) => waitFor(async () => {
  const m = await meta(conv);
  return m.threadPath && !m.running ? m : null;
}, 30_000);
const entries = (file: string): any[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const layers = (file: string) => entries(file).filter((e) => e.type === "custom_message" && e.customType === YOU_TYPE);
/** Every message's text of one model call. */
const callText = (c: any) => (c?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
/** The model call of the turn whose prompt starts with this marker (a pointer to it elsewhere says "Carl: <marker>"). */
const msgText = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join(""));
const callWith = (marker: string) => [...or.calls].reverse().find((c) => (c?.messages ?? []).some((m: any) => m.role === "user" && new RegExp(`(^|\\n)${marker}`).test(msgText(m))));

/** One message in a conversation (a new separate chat without `conv`), the model answering `reply`; the turn waited out. */
async function send(text: string, reply: string, conv?: string, client = "laptop"): Promise<string> {
  or.script.push({ text: reply });
  const r = await post("/api/v2/intent", { type: "send", clientId: `c-${Math.random().toString(36).slice(2, 9)}`, text, client, convId: conv ?? `sep-${Math.random().toString(36).slice(2, 10)}` });
  expect(r.body.ok).toBe(true);
  await idle(r.body.convId);
  return r.body.convId;
}
const focus = (path: string, where?: string) => post("/api/v1/activity", { entry: { kind: "focus", modality: "editor", text: "opened the file", path, ...(where ? { where } : {}) } });

beforeAll(async () => {
  home = tmp("vcyou-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("ok");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("the you layer, through pi's extension (before_agent_start → a vc-you custom message)", () => {
  let a = "";
  let b = "";

  it("lands in the conversation's pi session as a custom entry after the user message, and the model gets it", async () => {
    await focus("papers/spectral.pdf", "page 4 of 12");
    a = await send("MARK-A1 what does lemma 3 say?", "ALPHA-REPLY-1 lemma 3 bounds the radius.");
    const file = (await meta(a)).threadPath;
    const es = entries(file).filter((e) => e.type !== "session");
    const i = es.findIndex((e) => e.type === "custom_message" && e.customType === YOU_TYPE);
    expect(i).toBeGreaterThan(0);
    const you = es[i];
    // pi's order: the user message, then before_agent_start's message; not shown in the transcript (display false).
    expect(es[i - 1].type).toBe("message");
    expect(es[i - 1].message.role).toBe("user");
    expect(you.display).toBe(false);
    expect(you.content).toContain("<you>");
    expect(you.content).toContain("Focus: papers/spectral.pdf (page 4 of 12)");
    expect(you.content).toContain("Device: laptop");
    expect(Number.isFinite(you.details.until)).toBe(true);
    // Sent to the model with the turn (pi: a custom message is a user message to the provider).
    expect(callText(callWith("MARK-A1"))).toContain("Focus: papers/spectral.pdf");
    // The prompt itself carries no layer (one path: the extension's).
    const user = es[i - 1].message.content.map((c: any) => c.text).join("");
    expect(user).not.toContain("<you>");
    // The transcript Carl sees does not show it.
    const items = (await get(`/api/v2/conversations/${a}/checkpoint`)).body.picture.items ?? [];
    expect(JSON.stringify(items)).not.toContain("<you>");
  });

  it("two parallel conversations both see a focus change; neither sees the other's replies", async () => {
    b = await send("MARK-B1 unrelated: define a sigma-algebra", "BRAVO-REPLY-1 closed under complements.", undefined, "phone");
    // B's first layer: A's message as a pointer (Carl's words), never A's reply.
    const bFirst = callText(callWith("MARK-B1"));
    expect(bFirst).toContain("Carl: MARK-A1 what does lemma 3 say?");
    expect(bFirst).not.toContain("ALPHA-REPLY-1");
    // Carl opens another file, then writes in both.
    await focus("notes/measure.md");
    await send("MARK-A2 and lemma 4?", "ALPHA-REPLY-2 it is the converse.", a);
    await send("MARK-B2 example please", "BRAVO-REPLY-2 the Borel sets.", b, "phone");
    const a2 = callText(callWith("MARK-A2"));
    const b2 = callText(callWith("MARK-B2"));
    for (const t of [a2, b2]) expect(t).toContain("Focus: notes/measure.md");
    // Content does not bleed: each conversation's model call has its own replies only.
    expect(a2).not.toContain("BRAVO-REPLY");
    expect(b2).not.toContain("ALPHA-REPLY");
    // A pointer to the other's message, by title and id (read on request), with Carl's words only.
    expect(a2).toMatch(/\[MARK-B1 unrelated: define a sigma-algebra chat, (just now|\d+ min ago)\] Carl: MARK-B1 unrelated: define a sigma-algebra \(id [^)]+\)/);
    // Deduped against what this session saw: A's second layer has the new focus, not the first one again.
    const aLayers = layers((await meta(a)).threadPath);
    expect(aLayers.length).toBe(2);
    expect(aLayers[1].content).not.toContain("papers/spectral.pdf");
    expect(aLayers[1].details.since).toBe(aLayers[0].details.until);
    expect(youSince(entries((await meta(a)).threadPath))).toBe(aLayers[1].details.until);
    // The device moved: B's layer says the phone (its own message), A's says the laptop.
    expect(layers((await meta(b)).threadPath)[0].content).toContain("Device: phone");
  });

  it("a new conversation gets the layer but no other conversation's content", async () => {
    const c = await send("MARK-C1 fresh start", "CHARLIE-REPLY-1 hi.");
    const t = callText(callWith("MARK-C1"));
    expect(t).toContain("<you>");
    expect(t).toContain("Focus: notes/measure.md");
    expect(t).toContain("Carl: MARK-A2 and lemma 4?");
    expect(t).toContain("Carl: MARK-B2 example please");
    expect(t).not.toMatch(/ALPHA-REPLY|BRAVO-REPLY/);
    expect(t).not.toContain("it is the converse");
    // Its session starts clean: its only messages are its own, and one layer.
    const es = entries((await meta(c)).threadPath);
    expect(es.filter((e) => e.type === "message" && e.message.role === "user").length).toBe(1);
    expect(layers((await meta(c)).threadPath).length).toBe(1);
  });

  it("a Ctrl+L side thread gets the same layer through the same hook, deduped against its conversation", async () => {
    await focus("notes/ideas.md", "L1-L3");
    or.script.push({ text: "SIDE-ANSWER" });
    const r = await post("/api/v1/side", { kind: "ask", convId: a, text: "MARK-SIDE what is this?" });
    expect(r.status).toBe(200);
    await waitFor(async () => ((await get(`/api/v1/side/${r.body.id}?after=0&wait=2000`)).body.done ? true : null), 30_000);
    const dir = join(home, "state", "pi", "sessions", "side", a);
    const file = readdirSync(dir).map((n) => join(dir, n)).find((f) => f.endsWith(`_${r.body.id}.jsonl`))!;
    expect(existsSync(file)).toBe(true);
    const ls = layers(file);
    // The fork carries A's two layers; the side request adds one with only what is new since A's last.
    expect(ls.length).toBe(3);
    expect(ls[2].content).toContain("Focus: notes/ideas.md (L1-L3)");
    expect(ls[2].content).not.toContain("MARK-A1");
    expect(callText(callWith("MARK-SIDE"))).toContain("Focus: notes/ideas.md");
    // A's own session is untouched by the side thread.
    expect(layers((await meta(a)).threadPath).length).toBe(2);
  });
});

// ---------------------------------------------------------------- the real pi and the real extension

const PI_DIR = process.env.VC_TEST_PI_DIR;

describe.skipIf(!PI_DIR)("the you layer with the real pi 1.1.0 and ext/vc.mjs", () => {
  let rhome = "";
  let rsrv: Running;
  let chat: import("./fakeChat").FakeChat;
  const rget = async (p: string) => (await (await fetch(rsrv.base + p)).json()) as any;
  const rpost = async (p: string, b: Record<string, unknown>) =>
    (await (await fetch(rsrv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json()) as any;
  const rmeta = async (conv: string) => (await rget(`/api/v2/conversations/${conv}/checkpoint`))?.picture?.meta ?? {};
  const rsend = async (text: string, conv?: string) => {
    const r = await rpost("/api/v2/intent", { type: "send", clientId: `r-${Math.random().toString(36).slice(2, 9)}`, text, client: "laptop", convId: conv ?? `sep-${Math.random().toString(36).slice(2, 10)}` });
    expect(r.ok).toBe(true);
    await waitFor(async () => {
      const m = await rmeta(r.convId);
      return m.threadPath && !m.running ? m : null;
    }, 90_000);
    return String(r.convId);
  };

  beforeAll(async () => {
    const { fakeChat } = await import("./fakeChat");
    rhome = tmp("vcyoureal-");
    const rvault = makeVault(join(rhome, "vault"));
    const rsecrets = await makeKeyStore(join(rhome, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
    chat = await fakeChat();
    chat.respond = () => ({ text: "ok from the real pi" });
    rsrv = await startServer({ home: rhome, vault: rvault, secrets: rsecrets, openrouter: chat.url, extra: { VC_ENGINE: "pi", VC_PI_DIR: PI_DIR!, VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: join(rhome, "state"), VC_PI_UNSAFE: "1" } });
    await waitFor(async () => ((await rget("/api/v1/health")).engine?.pi?.state === "up" ? true : null), 60_000);
  }, 120_000);
  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(rsrv?.logs());
    await rsrv?.stop();
    await chat?.close();
    cleanup(rhome);
  });

  it("pi stores the layer (custom_message vc-you, after the user message), sends it, and the next turn gets only what is new", async () => {
    await rpost("/api/v1/activity", { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "papers/real.pdf", where: "page 2" } });
    const conv = await rsend("REAL-1 hello");
    let file = (await rmeta(conv)).threadPath;
    let ls = layers(file);
    expect(ls.length).toBe(1);
    expect(ls[0].content).toContain("Focus: papers/real.pdf (page 2)");
    expect(ls[0].display).toBe(false);
    const es = entries(file);
    const at = es.findIndex((e) => e.type === "custom_message" && e.customType === YOU_TYPE);
    expect(es[at - 1]?.message?.role).toBe("user");
    expect(JSON.stringify(chat.calls.at(-1))).toContain("Focus: papers/real.pdf");
    // The next turn: a new focus only, `since` from pi's own branch (youSince over getBranch()).
    await rpost("/api/v1/activity", { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "notes/real-2.md" } });
    await rsend("REAL-2 again", conv);
    file = (await rmeta(conv)).threadPath;
    ls = layers(file);
    expect(ls.length).toBe(2);
    expect(ls[1].details.since).toBe(ls[0].details.until);
    expect(ls[1].content).toContain("Focus: notes/real-2.md");
    expect(ls[1].content).not.toContain("papers/real.pdf");
    // Nothing new: no layer at all.
    await rsend("REAL-3 and again", conv);
    expect(layers((await rmeta(conv)).threadPath).length).toBe(2);
  }, 240_000);

  it("a voice call's lines go into the conversation's pi session through pi (vc-voice custom messages), and the model gets them on the next turn", async () => {
    const conv = await rsend("REAL-V1 a chat voice will join");
    // While pi has the session open: the box's /vc-note with `voice` → pi.sendMessage (no turn of its own).
    const n = chat.calls.length;
    for (const [role, text] of [["user", "REAL-VOICE what is lemma 2 again?"], ["assistant", "REAL-VOICE-REPLY the contraction lemma."]] as const) {
      const r = await rpost("/api/v1/voice/transcript", { convId: conv, role, text, device: "phone" });
      expect(r.convId).toBe(conv);
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(chat.calls.length).toBe(n);
    const file = (await rmeta(conv)).threadPath;
    const said = entries(file).filter((e) => e.type === "custom_message" && e.customType === "vc-voice");
    expect(said.map((e) => e.content)).toEqual(["[voice call] Carl said: REAL-VOICE what is lemma 2 again?", "[voice call] You said to Carl (spoken by your voice): REAL-VOICE-REPLY the contraction lemma."]);
    // The next typed turn: the model gets both lines from pi's own context.
    await rsend("REAL-V2 and what did I just ask by voice?", conv);
    const sent = JSON.stringify(chat.calls.at(-1));
    expect(sent).toContain("[voice call] Carl said: REAL-VOICE what is lemma 2 again?");
    expect(sent).toContain("REAL-VOICE-REPLY the contraction lemma.");
  }, 240_000);
});

// ---------------------------------------------------------------- the builder

const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);
const E = (minAgo: number, e: Partial<core.ActivityEntry>): core.ActivityEntry => ({ ts: NOW - minAgo * 60_000, kind: "focus", modality: "editor", text: "x", ...e }) as core.ActivityEntry;

describe("buildYouLayer", () => {
  it("a pointer is \"[<title> chat, <ago>] Carl: <first 120 chars>\", never the reply (older entries held one)", () => {
    const long = `Fill in hw4 problem 2 in the same form as the others, ${"and keep the notation consistent ".repeat(6)}`;
    const e = { ...core.chatPointerEntry({ convId: "c-hw4", title: "Physics hw4", user: long, device: "phone" }), ts: NOW - 2 * 60_000 } as core.ActivityEntry;
    const line = core.chatPointer(e, NOW);
    expect(line.startsWith("[Physics hw4 chat, 2 min ago] Carl: Fill in hw4 problem 2")).toBe(true);
    const quoted = line.slice(line.indexOf("Carl: ") + 6, line.lastIndexOf(" (id "));
    expect(quoted.length).toBe(core.POINTER_CHARS);
    expect(quoted.endsWith("…")).toBe(true);
    expect(line.endsWith("(id c-hw4)")).toBe(true);
    expect(e.device).toBe("phone");
    // An entry written before (the exchange with the agent's reply): only Carl's side is shown.
    const old = E(1, { kind: "chat", modality: "chat", text: 'Chat "KV"', detail: 'Carl: "explain caching" → Agent: "SECRET-REPLY the cache stores keys"', convId: "c-kv" });
    const l = core.buildYouLayer({ entries: [old] }, { now: NOW });
    expect(l.text).toContain("[KV chat, 1 min ago] Carl: explain caching (id c-kv)");
    expect(l.text).not.toContain("SECRET-REPLY");
  });

  it("the reader's own conversation (its voice lines too: they are in its pi session) and other conversations' replies stay out", () => {
    const es = [
      E(3, { kind: "chat", modality: "chat", text: "Mine", detail: 'Carl: "my own message"', convId: "me" }),
      E(3, { kind: "capture", modality: "chat", text: 'pasted into "Mine"', path: ".vault-chat/captures/mine.png", convId: "me" }),
      E(2, { kind: "voice", modality: "voice", text: 'Voice replied: "OTHER-VOICE-REPLY"', convId: "other" }),
      E(2, { kind: "voice", modality: "voice", text: 'Voice replied: "MY-VOICE-REPLY"', convId: "me" }),
      E(1, { kind: "voice", modality: "voice", text: 'Carl said: "rename lemma 2"', convId: "other" }),
    ];
    const t = core.buildYouLayer({ entries: es }, { now: NOW, convId: "me" }).text;
    expect(t).not.toContain("my own message");
    expect(t).not.toContain("mine.png");
    expect(t).not.toContain("OTHER-VOICE-REPLY");
    expect(t).not.toContain("MY-VOICE-REPLY");
    expect(t).toContain('Voice (in chat other): Carl said: "rename lemma 2"');
  });

  it("holds its budget: a busy hour stays under maxChars, newest kept, the rest counted", () => {
    const es: core.ActivityEntry[] = [];
    for (let i = 0; i < 80; i++) {
      es.push(E(40 - i * 0.4, { kind: "chat", modality: "chat", text: `Chat ${i}`, detail: `Carl: "${"word ".repeat(40)}${i}"`, convId: `c${i}` }));
      es.push(E(40 - i * 0.4, { kind: "ask", modality: "ctrl-l", text: `asked "${"why ".repeat(30)}${i}"`, detail: `answer: ${"because ".repeat(60)}`, path: "papers/a.pdf" }));
      es.push(E(40 - i * 0.4, { kind: "capture", modality: "capture", text: "captured", path: "papers/a.pdf", where: `page ${i}`, image: `.vault-chat/local/captures/c${i}.png` }));
    }
    const notes: core.NoteSnap[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, ts: NOW - (30 - i) * 60_000, created: true, status: "open", text: "remember ".repeat(40) }));
    const board: core.BoardSnap = { slug: "proof", name: "Proof", updated: NOW - 60_000, strokes: 900, items: Array.from({ length: 40 }, (_, i) => ({ kind: "image", label: `Part ${i}` })), overview: "boards/proof/overview.png" };
    const l = core.buildYouLayer({ entries: es, notes, board }, { now: NOW });
    expect(l.text.length).toBeLessThanOrEqual(core.YOU_MAX_CHARS);
    expect(l.text).toMatch(/\(\d+ older entries left out\)/);
    // The newest of each kind made it.
    expect(l.text).toContain("(id c79)");
    expect(l.text).toContain("c79.png");
    expect(l.text).toContain("(n29)");
    expect(l.text).toContain('Board: "Proof"');
    expect(l.text.startsWith("<you>")).toBe(true);
    expect(l.text.endsWith("</you>")).toBe(true);
  });

  it("dedupes: only what is new since the reader's last layer; nothing new is nothing; a repeat counts once", () => {
    const es = [
      E(10, { kind: "focus", text: "opened", path: "a.md" }),
      E(9, { kind: "focus", text: "opened", path: "b.md" }),
      E(8, { kind: "focus", text: "opened", path: "a.md" }),
      E(7, { kind: "ask", modality: "ctrl-l", text: 'asked "same"', detail: "answer: x" }),
      E(6, { kind: "ask", modality: "ctrl-l", text: 'asked "same"', detail: "answer: x" }),
    ];
    const first = core.buildYouLayer({ entries: es }, { now: NOW });
    expect(first.text.match(/asked "same"/g)?.length).toBe(1);
    expect(first.text).toContain("Focus: a.md");
    expect(first.until).toBe(NOW);
    // Asked again with nothing new since: empty.
    expect(core.buildYouLayer({ entries: es }, { now: NOW + 1000, since: first.until }).text).toBe("");
    // One new thing: only it (and the device, which did not change, is not news on its own).
    const more = [...es, E(-0.5, { kind: "focus", text: "opened", path: "c.md" })];
    const next = core.buildYouLayer({ entries: more }, { now: NOW + 60_000, since: first.until });
    expect(next.text).toContain("Focus: c.md");
    expect(next.text).not.toContain('asked "same"');
    expect(next.text).toContain("since your last turn");
  });

  it("a sliding window, and the last thing he did is there whatever its age (for a reader that has not seen it)", () => {
    const es = [E(300, { kind: "ask", modality: "ctrl-l", text: 'asked "old one"' }), E(200, { kind: "ask", modality: "ctrl-l", text: 'asked "the last thing"' })];
    const t = core.buildYouLayer({ entries: es }, { now: NOW }).text;
    expect(t).toContain("the last thing");
    expect(t).toContain("3 h 20 min ago");
    expect(t).not.toContain("old one");
    // Seen already: not again.
    expect(core.buildYouLayer({ entries: es }, { now: NOW, since: NOW - 100 * 60_000 }).text).toBe("");
  });
});
