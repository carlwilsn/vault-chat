// The "you" layer (Carl's conversation model, 2026-10-18): conversations are
// separate pi sessions and run in parallel; a shared sliding window of what Carl
// just did reaches every one of them; a conversation's content never bleeds
// into another (other chats are pointers to Carl's own words, read on request);
// a new conversation is a clean slate except for the layer.
//
// End to end on the real bundle: the host asks for the layer and puts it in the
// prompt itself (Claude Code has no extension to store it in), so what the model
// is sent is where it is read from here — the transcript Carl reads never has it.
// Then the pure builder (src/activityCore.ts buildYouLayer): pointer format,
// budget, dedupe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import * as core from "../../src/activityCore";

let home: string, vault: string, secrets: string;
let or: FakeApi;
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
/** The "you" layer this turn was sent: the host puts it in the prompt itself, and
 *  a request carries the whole conversation, so the turn's own layer is the last. */
const layerOf = (call: any): string => (callText(call).match(/<you>[\s\S]*?<\/you>/g) ?? [""]).at(-1)!;
/** Every message's text of one model call. */
const callText = (c: any) => (c?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
/** The model call of the turn whose prompt starts with this marker (a pointer to it elsewhere says "Carl: <marker>"). */
const msgText = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join(""));
/** The call of the turn this marker was sent in: the FIRST one carrying it (a
 *  later request repeats the whole conversation, so the newest is not its turn). */
const callWith = (marker: string) => or.calls.find((c) => (c?.messages ?? []).some((m: any) => m.role === "user" && new RegExp(`(^|\\n)${marker}`).test(msgText(m))));

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
  or = await fakeAnthropic("ok");
  srv = await startServer({ home, vault, secrets, anthropic: or.url });
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("the you layer, in the prompt the host sends", () => {
  let a = "";
  let b = "";

  it("reaches the model with the turn, and is never in the transcript Carl reads", async () => {
    await focus("papers/spectral.pdf", "page 4 of 12");
    a = await send("MARK-A1 what does lemma 3 say?", "ALPHA-REPLY-1 lemma 3 bounds the radius.");
    const you = layerOf(callWith("MARK-A1"));
    expect(you).toContain("Focus: papers/spectral.pdf (page 4 of 12)");
    expect(you).toContain(`file vault: ${vault}/ (not the project cwd)`);
    expect(you).toContain("Device: laptop");
    // His own message is his words alone: the layer is the host's context around
    // it, not something he said.
    const es = entries((await meta(a)).threadPath).filter((e) => e.type !== "session");
    const user = es.find((e) => e.type === "message" && e.message.role === "user")!;
    expect(user.message.content.map((c: any) => c.text ?? "").join("")).not.toContain("<you>");
    // Nor is it in the transcript, or anywhere a client would draw it.
    expect(JSON.stringify(es)).not.toContain("<you>");
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
    expect(layerOf(callWith("MARK-A1"))).toContain("papers/spectral.pdf");
    expect(layerOf(callWith("MARK-A2"))).not.toContain("papers/spectral.pdf");
    // The device moved: B's layer says the phone (its own message), A's says the laptop.
    expect(layerOf(callWith("MARK-B1"))).toContain("Device: phone");
    expect(layerOf(callWith("MARK-A1"))).toContain("Device: laptop");
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
    // Its session starts clean: its only message is its own.
    const es = entries((await meta(c)).threadPath);
    expect(es.filter((e) => e.type === "message" && e.message.role === "user").length).toBe(1);
  });

  it("a Ctrl+L side thread gets the same layer, deduped against its conversation", async () => {
    await focus("notes/ideas.md", "L1-L3");
    or.script.push({ text: "SIDE-ANSWER" });
    const r = await post("/api/v1/side", { kind: "ask", convId: a, text: "MARK-SIDE what is this?" });
    expect(r.status).toBe(200);
    await waitFor(async () => ((await get(`/api/v1/side/${r.body.id}?after=0&wait=2000`)).body.done ? true : null), 30_000);
    // Its own layer: what is new since its conversation's last one, and no more.
    const you = layerOf(callWith("MARK-SIDE"));
    expect(you).toContain("Focus: notes/ideas.md (L1-L3)");
    expect(you).not.toContain("MARK-A1");
  });
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
