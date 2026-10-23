// The push rule (server/pushGate.ts): the phone buzzes only when something Carl started finished
// while he was not looking at any surface, or when something needs him — and then only once he
// is away. Never for background work, voice turns in a call, a thing he saw, or a duplicate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAT_MS, HOLD_MAX_MS, PushGate, decide, noteAttention, resetAttention, type Attention, type PushOffer } from "../pushGate";
import { engineNotify } from "../engine";

const away: Attention = { looking: false, where: null };
const here: Attention = { looking: true, where: "laptop" };

describe("decide: the rule", () => {
  it("a finish Carl started, while he is away from every screen: buzz", () => {
    expect(decide({ why: "finished", byCarl: true, attention: away, duplicate: false, stillNeeded: true }).act).toBe("push");
  });
  it("background work he did not start never buzzes, away or not", () => {
    expect(decide({ why: "finished", byCarl: false, attention: away, duplicate: false, stillNeeded: true })).toEqual({ act: "drop", reason: "background work Carl did not start" });
  });
  it("a finish while he looks at a surface: seen there, never buzzes", () => {
    expect(decide({ why: "finished", byCarl: true, attention: here, duplicate: false, stillNeeded: true }).act).toBe("drop");
  });
  it("a question or a failure while he looks: held until he leaves", () => {
    expect(decide({ why: "ask", attention: here, duplicate: false, stillNeeded: true }).act).toBe("hold");
    expect(decide({ why: "failed", attention: { looking: true, where: "a voice call" }, duplicate: false, stillNeeded: true }).act).toBe("hold");
    expect(decide({ why: "ask", attention: away, duplicate: false, stillNeeded: true }).act).toBe("push");
  });
  it("answered, duplicate or held too long: dropped", () => {
    expect(decide({ why: "ask", attention: away, duplicate: false, stillNeeded: false }).act).toBe("drop");
    expect(decide({ why: "failed", attention: away, duplicate: true, stillNeeded: true }).act).toBe("drop");
    expect(decide({ why: "ask", attention: here, duplicate: false, stillNeeded: true, heldMs: HOLD_MAX_MS + 1 }).act).toBe("drop");
  });
});

describe("PushGate", () => {
  let t = 1_000_000;
  let sent: { title: string; body: string; url: string; tag: string }[];
  let lines: string[];
  let voice = false;
  const vault = "/vaults/school2";
  const gate = () =>
    new PushGate({
      send: async (title, body, url, tag) => {
        sent.push({ title, body, url, tag });
        return 1;
      },
      attention: () => (voice ? { looking: true, where: "a voice call" } : { looking: false, where: null }),
      now: () => t,
      log: (l) => lines.push(l),
    });
  const offer = (o: Partial<PushOffer>): PushOffer => ({ vault, why: "finished", title: "Done: Main", body: "The proof is written.", url: "/phone?conv=main", tag: "main", convId: "main", trigger: "turn end", byCarl: true, ...o });

  beforeEach(() => {
    resetAttention();
    sent = [];
    lines = [];
    voice = false;
    t = 1_000_000;
  });

  it("away: a finish he started goes out at once, with plain text, and is logged with its trigger", async () => {
    const g = gate();
    expect((await g.offer(offer({}))).act).toBe("push");
    expect(sent).toEqual([{ title: "Done: Main", body: "The proof is written.", url: "/phone?conv=main", tag: "main" }]);
    expect(lines[0]).toMatch(/^\[push\] sent trigger=turn end why=finished conv=main "Done: Main" — Carl is not looking; 1 phone$/);
  });

  it("the agent's Notify and the turn's own end are one buzz, and a repeat within 30 min is none", async () => {
    const g = gate();
    await g.offer(offer({ trigger: "Notify", title: "Done: proof", body: "Written in hw3.md" }));
    expect((await g.offer(offer({}))).reason).toBe("duplicate");
    t += 10 * 60_000;
    expect((await g.offer(offer({ why: "failed", title: "Needs you: box sync is failing", body: "x", tag: "vault-chat-sync", convId: null }))).act).toBe("push");
    expect((await g.offer(offer({ why: "failed", title: "Needs you: box sync is failing", body: "x", tag: "vault-chat-sync", convId: null }))).reason).toBe("duplicate");
    expect(sent).toHaveLength(2);
  });

  it("a background job he did not start: never", async () => {
    const g = gate();
    expect((await g.offer(offer({ byCarl: false, trigger: "job end" }))).act).toBe("drop");
    expect(sent).toHaveLength(0);
  });

  it("at the laptop: a finish is seen there; a question in the thread he has open is asked there", async () => {
    const g = gate();
    noteAttention(vault, "laptop", true, "main", t);
    expect((await g.offer(offer({}))).act).toBe("drop");
    expect((await g.offer(offer({ why: "ask", title: "Needs your answer: Main", body: "Problem 3(b) or 4?", trigger: "AskUser" }))).reason).toBe("Carl has it open");
    expect(sent).toHaveLength(0);
  });

  it("at the laptop on Main: a project's question waits, and goes out when he leaves", async () => {
    const g = gate();
    noteAttention(vault, "laptop", true, "main", t);
    let open = true;
    expect((await g.offer(offer({ why: "ask", title: "Needs your answer: Proof", body: "Problem 3(b) or 4?", convId: "project-proof", tag: "project-proof", trigger: "AskUser", stillNeeded: () => open }))).act).toBe("hold");
    expect(sent).toHaveLength(0);
    // Still there 30 s later (a beat): still held.
    t += 30_000;
    noteAttention(vault, "laptop", true, "main", t);
    await g.tick();
    expect(sent).toHaveLength(0);
    // He left: the laptop says so. Out it goes.
    t += 5_000;
    noteAttention(vault, "laptop", false, "main", t);
    await g.tick();
    expect(sent.map((s) => s.title)).toEqual(["Needs your answer: Proof"]);
    expect(g.pending()).toHaveLength(0);
    open = false;
  });

  it("a surface that stops beating (the phone locked, the laptop asleep) counts as gone", async () => {
    const g = gate();
    noteAttention(vault, "phone", true, null, t);
    await g.offer(offer({ why: "ask", title: "Needs your answer: Main", body: "?", trigger: "AskUser" }));
    t += BEAT_MS + 1;
    await g.tick();
    expect(sent).toHaveLength(1);
  });

  it("answered while held, or the conversation opened since: never goes out", async () => {
    const g = gate();
    noteAttention(vault, "board", true, null, t);
    let open = true;
    await g.offer(offer({ why: "ask", title: "Needs your answer: Main", body: "?", trigger: "AskUser", stillNeeded: () => open }));
    await g.offer(offer({ why: "failed", title: "Failed: Proj", body: "the turn failed — open it to retry.", convId: "project-x", tag: "project-x" }));
    open = false;
    t += 20_000;
    noteAttention(vault, "board", true, "project-x", t);
    t += 20_000;
    noteAttention(vault, "board", false, null, t);
    await g.tick();
    expect(sent).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("[push] dropped")).map((l) => l.split(" — ")[1])).toEqual(["no longer needed", "Carl opened it"]);
  });

  it("in a voice call: quiet, also for his own voice turns", async () => {
    const g = gate();
    voice = true;
    expect((await g.offer(offer({ trigger: "turn end" }))).act).toBe("drop");
    expect((await g.offer(offer({ why: "ask", title: "Needs your answer: Main", body: "?" }))).act).toBe("hold");
    voice = false;
    await g.tick();
    expect(sent.map((s) => s.title)).toEqual(["Needs your answer: Main"]);
  });

  it("an alert resolved before he left (the laptop's sync recovered) never goes out", async () => {
    const g = gate();
    noteAttention(vault, "laptop", true, null, t);
    await g.offer(offer({ why: "failed", title: "Needs you: laptop sync failing (school2)", body: "x", tag: "vc-sync-laptop-school2", convId: null, trigger: "laptop sync" }));
    expect(g.resolve("vc-sync-laptop-school2")).toBe(1);
    noteAttention(vault, "laptop", false, null, t);
    await g.tick();
    expect(sent).toHaveLength(0);
  });
});

describe("engineNotify: the feed always, the buzz by the rule", () => {
  let dir: string;
  beforeEach(() => {
    resetAttention();
    dir = mkdtempSync(join(tmpdir(), "vc-pushgate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a question while Carl is at the laptop: in his alerts now, not on the phone", async () => {
    const feed: string[] = [];
    const pushes: string[] = [];
    const notify = engineNotify({
      vault: dir,
      sendPush: async (title) => {
        pushes.push(title);
        return 1;
      },
      notificationAppend: (_v, line) => feed.push(line),
    } as any);
    noteAttention(dir, "laptop", true, "main");
    const id = await notify({ kind: "ask", title: "Needs your answer: Proof", body: "Problem 3(b) or 4?", convId: "project-proof", why: "ask", trigger: "AskUser" });
    expect(id).toBeTruthy();
    expect(feed).toHaveLength(1);
    expect(JSON.parse(feed[0]!)).toMatchObject({ kind: "ask", title: "Needs your answer: Proof", convId: "project-proof" });
    expect(pushes).toHaveLength(0);
    // A turn's own end: the buzz only, never a feed card (the chat shows the reply).
    noteAttention(dir, "laptop", false, null);
    await notify({ kind: "info", title: "Done: Project", body: "Written.", convId: "project-p", why: "finished", byCarl: true, trigger: "turn end", pushOnly: true });
    expect(feed).toHaveLength(1);
    expect(pushes).toEqual(["Done: Project"]);
  });
});
