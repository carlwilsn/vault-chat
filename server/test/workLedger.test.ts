// The stateless work model (reports/19-stateless, 20-design-review): waiting is the box's, the work's state is one
// box-wide work list kept as history.
//   - the list is records appended to one file, folded; nothing is rewritten;
//   - WaitFor records a wait on an ask and tells the agent to end its turn;
//   - when it holds (a ship result by name or branch, a GitHub run, the core build, Carl's laptop, a timeout) the
//     box starts a FRESH conversation whose only input is the entry + the event, never a turn in the chat that
//     asked; another lane's result starts nothing; each event is taken up once;
//   - a work session is a chat of the ask's project (its memory, the ship tool) in its own worktree, and may not AskUser;
//   - done / blocked / a question tell Carl once, as a line in the chat he asked in (no model turn) and an alert;
//     his answer starts a fresh session; cancel takes back a ship request not yet taken;
//   - a session that ends without recording where the ask stands is restarted, twice at most, then Carl is told.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cleanup, seedProject } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";
import { getAsk, readLedger, upsertAsk } from "../engine/ledger";
import { waitLoopReason } from "../engine/claude/filePolicy";

let rig: Rig;
let results: string;
let file: string;
const runs = new Map<string, any>();
const box = { core: null as string | null, laptop: null as { commit: string; at: number } | null };
beforeAll(async () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `vc-ship-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, "ship-results"), { recursive: true });
  mkdirSync(join(dir, "ship-requests"), { recursive: true });
  results = join(dir, "ship-results");
  file = join(dir, "state", "work", "work.jsonl");
  rig = await makeRig({
    deps: {
      shipResults: results,
      workFile: file,
      workTree: async (o: any) => {
        const p = join(dir, "worktrees", o.slug, String(Math.random()).slice(2, 8));
        mkdirSync(p, { recursive: true });
        return p;
      },
      waitContext: {
        fetchJson: async (u: string) => runs.get(u.split("/").pop()!) ?? { status: "in_progress" },
        contains: (a: string, b: string) => b.startsWith(a) || b === `${a}-child`,
        coreCommit: () => box.core,
        laptopCommit: () => box.laptop,
      },
    },
  });
});
afterAll(async () => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");
const settle = async (s: { convId: string; tid: string }) => {
  rig.backend.end(s.tid);
  await until(async () => (await rig.readConv(s.convId))?.state !== "running");
};
const textOf = (t: any) => String(t?.texts?.join("\n") ?? "");
const ask = (id: string) => getAsk(id, file)!;
const nextTurn = async (n: number) => {
  await until(() => rig.backend.turns.length > n);
  return rig.backend.turns[n];
};

describe("the work list", () => {
  it("is one file of appended records, folded; a change never rewrites a line", () => {
    const f = join(rig.root, "w.jsonl");
    upsertAsk("a", { words: "first" }, { file: f, now: 1 });
    upsertAsk("a", { status: "done", last: "ok" }, { file: f, now: 2 });
    upsertAsk(undefined, { words: "Second thing to do" }, { file: f, now: 3 });
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ at: 1, id: "a", set: { words: "first", status: "open" } });
    expect(readLedger(f).map((e) => [e.id, e.status, e.last])).toEqual([
      ["a", "done", "ok"],
      ["second-thing-to-do", "open", undefined],
    ]);
  });

  it("WaitFor a ship result: a fresh session gets only the entry and the event; another lane's result starts nothing", async () => {
    const s = await rig.start("Fix the updater and ship it.");
    const r = await rig.backend.call(s.tid, "WaitFor", { ask: "Fix the updater", ship: "upd-1", brief: "If it was accepted, wait for the laptop; else fix and resubmit." });
    expect(out(r)).toMatch(/The box waits for it \(ask fix-the-updater\).*End your turn now/);
    await settle(s);
    expect(ask("fix-the-updater")).toMatchObject({ status: "waiting", ship: "upd-1", origin: { vault: rig.vault, conv: s.convId }, wait: { kind: "ship", args: { name: "upd-1" } } });
    const turns = rig.backend.turns.length;
    writeFileSync(join(results, "agency-4.result"), "exit=1\nbranch=agent/agency-4\n");
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns);
    writeFileSync(join(results, "upd-1.result"), "exit=0\nbranch=agent/upd-1\npushed=yes\n");
    await rig.engine.tickLedger();
    const t = await nextTurn(turns);
    expect(t.threadId).not.toBe(s.tid);
    expect(textOf(t)).toContain("A fresh work session");
    expect(textOf(t)).toContain("Ask fix-the-updater [working]: Fix the updater");
    expect(textOf(t)).toContain("If it was accepted, wait for the laptop");
    expect(textOf(t)).toContain("Ship result upd-1:\nexit=0");
    expect(ask("fix-the-updater")).toMatchObject({ status: "working", owner: "work-fix-the-updater-1", sessions: ["work-fix-the-updater-1"] });
    expect(ask("fix-the-updater").wait).toBeUndefined();
    expect((await rig.readConv("work-fix-the-updater-1"))?.title).toBe("Work: Fix the updater");
    // A work session never waits on Carl.
    expect(out(await rig.backend.call(t.threadId, "AskUser", { question: "ok?" }))).toContain("a work session does not wait");
    // Accepted is not landed: it waits for the laptop. The same result is not taken up twice.
    await rig.backend.call(t.threadId, "WaitFor", { ask: "fix-the-updater", laptop: "abc1234", brief: "Set done." });
    const n = rig.backend.turns.length;
    await rig.engine.tickLedger(Date.now() + 60_000);
    expect(rig.backend.turns.length).toBe(n);
    box.laptop = { commit: "abc1234-child", at: Date.now() };
    await rig.engine.tickLedger(Date.now() + 120_000);
    const t2 = await nextTurn(n);
    expect(textOf(t2)).toContain("Carl's laptop reported running a core that contains abc1234");
    // Done: one line in Carl's chat, one alert; no turn there.
    const carlTurns = rig.backend.turns.filter((x: any) => x.threadId === s.tid).length;
    expect(out(await rig.backend.call(t2.threadId, "Ledger", { action: "set", id: "fix-the-updater", status: "done", last: "On your laptop; the updater installs again." }))).toContain("[done]");
    await until(async () => JSON.stringify(await rig.readConv(s.convId)).includes("Done: Fix the updater — On your laptop"));
    expect(rig.pings.some((p: any) => String(p.title).startsWith("Done: Fix the updater"))).toBe(true);
    expect(rig.backend.turns.filter((x: any) => x.threadId === s.tid).length).toBe(carlTurns);
  });

  it("a work session of a project is a chat of that project, in the ask's own worktree, with the ship tool", async () => {
    seedProject(rig.vault, "vault-chat", { folder: "vault-chat" });
    upsertAsk("proj", { words: "Project work", project: "vault-chat", origin: { vault: rig.vault, conv: "main" } }, { file });
    const n = rig.backend.turns.length;
    const id = await rig.engine.startWorkSession(ask("proj"), "Start.");
    await nextTurn(n);
    expect((await rig.readConv(id))?.project).toBe("vault-chat");
    // (A vault folder is not a gated git project: no worktree; the tool's project check now reads the session's project.)
    const r = await rig.backend.call(rig.backend.turns[n].threadId, "SubmitChange", { title: "x", branch: "agent/x" });
    expect(out(r)).not.toContain("conversation of a project thread");
  });

  it("a question tells Carl without a waiting session; his answer starts a fresh one", async () => {
    upsertAsk("q", { words: "Pick a colour", origin: { vault: rig.vault, conv: "main" } }, { file });
    const n = rig.backend.turns.length;
    const id = await rig.engine.startWorkSession(ask("q"), "Start.");
    const t = await nextTurn(n);
    await rig.backend.call(t.threadId, "Ledger", { action: "set", id: "q", question: "Blue or green?", options: ["blue", "green"] });
    expect(ask("q")).toMatchObject({ status: "question", question: { text: "Blue or green?", options: ["blue", "green"] } });
    expect(rig.pings.some((p: any) => String(p.title).startsWith("Question (q): Blue or green?"))).toBe(true);
    rig.backend.end(t.threadId);
    await until(async () => (await rig.readConv(id))?.state !== "running");
    const main = await rig.start("Blue.", { convId: "main" });
    const m = rig.backend.turns.length;
    expect(out(await rig.backend.call(main.tid, "Ledger", { action: "answer", id: "q", answer: "blue" }))).toContain("a fresh session (work-q-2)");
    const t2 = await nextTurn(m);
    expect(textOf(t2)).toContain('Carl answered "Blue or green?": blue');
    expect(ask("q")).toMatchObject({ answer: "blue", status: "working" });
    expect(ask("q").question).toBeUndefined();
    await settle(main);
  });

  it("cancel takes back a ship request the gate has not taken, and drops the ask", async () => {
    writeFileSync(join(results, "..", "ship-requests", "c-1.req"), "agent/c-1\nt\n");
    upsertAsk("c", { words: "Cancel me", ship: "c-1", origin: { vault: rig.vault, conv: "main" } }, { file });
    const s = await rig.start("Never mind the cancel-me thing.");
    expect(out(await rig.backend.call(s.tid, "Ledger", { action: "cancel", id: "c" }))).toContain("its ship request c-1 was taken back");
    expect(existsSync(join(results, "..", "ship-requests", "c-1.req"))).toBe(false);
    expect(ask("c").status).toBe("dropped");
    await settle(s);
  });

  it("WaitFor a GitHub run or the core build: the box asks, the agent never polls", async () => {
    const s = await rig.start("Watch CI for the release.");
    expect(out(await rig.backend.call(s.tid, "WaitFor", { ask: "Release 0.7.40 builds", githubRun: "777", repo: "o/r", brief: "Report the conclusion." }))).toContain("The box waits");
    await settle(s);
    const turns = rig.backend.turns.length;
    await rig.engine.tickLedger(Date.now() + 10 * 60_000);
    expect(rig.backend.turns.length).toBe(turns);
    runs.set("777", { status: "completed", conclusion: "success", name: "ship" });
    await rig.engine.tickLedger(Date.now() + 20 * 60_000);
    expect(textOf(await nextTurn(turns))).toContain('GitHub run 777 (o/r) "ship" completed: success');
    upsertAsk("core", { words: "core", origin: { vault: rig.vault, conv: "main" }, wait: { kind: "core", args: { commit: "beef123" }, since: Date.now(), until: Date.now() + 3600_000, brief: "b" } }, { file });
    box.core = "beef123-child";
    const k = rig.backend.turns.length;
    await rig.engine.tickLedger(Date.now() + 30 * 60_000);
    expect(textOf(await nextTurn(k))).toContain("built and stored a core bundle that contains beef123");
  });

  it("a wait that never lands times out; an old result with the name does not fire it", async () => {
    const f = join(results, "stale-1.result");
    writeFileSync(f, "exit=0\n");
    utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    upsertAsk("stale", { words: "stale", origin: { vault: rig.vault, conv: "main" }, wait: { kind: "ship", args: { name: "stale-1" }, since: Date.now(), until: Date.now() + 3600_000, brief: "b" } }, { file });
    const turns = rig.backend.turns.length;
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns);
    await rig.engine.tickLedger(Date.now() + 2 * 3600_000);
    expect(textOf(await nextTurn(turns))).toContain("Timed out");
  });

  it("a session that ends without recording where it stands is restarted, twice at most, then Carl is told", async () => {
    upsertAsk("stall", { words: "Stalls", origin: { vault: rig.vault, conv: "main" } }, { file });
    let n = rig.backend.turns.length;
    const first = await rig.engine.startWorkSession(ask("stall"), "Start.");
    for (let i = 0; i < 3; i++) {
      const t = await nextTurn(n);
      rig.backend.end(t.threadId);
      await until(() => ask("stall").lease?.until! <= Date.now());
      n = rig.backend.turns.length;
      await rig.engine.tickLedger(Date.now() + 1000);
      if (i < 2) expect(textOf(await nextTurn(n))).toContain("ended without recording where it stands");
    }
    expect(first).toBe("work-stall-1");
    expect(ask("stall")).toMatchObject({ status: "blocked", reaps: 2 });
    expect(rig.pings.some((p: any) => String(p.title).startsWith("Needs you: Stalls — stalled"))).toBe(true);
  });

  it("a restart: each cut worker gets a fresh session from the work list; the chat gets one line and no turn", async () => {
    const s = await rig.start("Start the cut worker.");
    await settle(s);
    const before = rig.backend.turns.filter((x: any) => x.threadId === s.tid).length;
    const n = rig.backend.turns.length;
    const started = await rig.engine.takeUpCut(s.convId, { workers: [{ id: "w-9", title: "Fix the cut thing" }], commands: [{ id: "c1", title: "npm run dev" }] });
    expect(started).toEqual(["work-fix-the-cut-thing-1"]);
    expect(textOf(await nextTurn(n))).toContain('cut the background worker "Fix the cut thing" (w-9)');
    expect(ask("fix-the-cut-thing")).toMatchObject({ owner: "work-fix-the-cut-thing-1", origin: { conv: s.convId }, handled: ["cut:w-9"] });
    await until(async () => JSON.stringify(await rig.readConv(s.convId)).includes("1 background worker taken up by fresh work sessions"));
    expect(rig.backend.turns.filter((x: any) => x.threadId === s.tid).length).toBe(before);
  });

  it("refuses waiting loops on ship results and CI, not a single read", () => {
    expect(waitLoopReason("Bash", { command: "until [ -f ~/agent-work/vault-chat/ship-results/x.result ]; do sleep 30; done" })).toContain("WaitFor");
    expect(waitLoopReason("Bash", { command: "gh run watch 123" })).toContain("WaitFor");
    expect(waitLoopReason("Monitor", { command: "tail -f ship-results/x.log" })).toContain("WaitFor");
    expect(waitLoopReason("Bash", { command: "cat ~/agent-work/vault-chat/ship-results/x.result" })).toBeNull();
    expect(waitLoopReason("Bash", { command: "sleep 5 && npm test" })).toBeNull();
  });

  it("a flaky ship result is resubmitted by the box: no session, the wait moves to the new request", async () => {
    upsertAsk("flaky", { words: "Flaky ship", origin: { vault: rig.vault, conv: "main" }, wait: { kind: "ship", args: { name: "fl-1" }, since: Date.now() - 1000, until: Date.now() + 3600_000, brief: "b" } }, { file });
    writeFileSync(join(results, "fl-1.result"), "exit=1\nbranch=agent/fl\nnpm ci: ETIMEDOUT\n");
    const n = rig.backend.turns.length;
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(n);
    expect(readFileSync(join(results, "..", "ship-requests", "fl-1-a1.req"), "utf8")).toBe("agent/fl\nFlaky ship\n");
    expect(ask("flaky")).toMatchObject({ status: "waiting", ship: "fl-1-a1", autoShips: 1, wait: { kind: "ship", args: { name: "fl-1-a1" } } });
  });
});
