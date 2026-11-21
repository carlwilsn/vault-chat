// The stateless work model (reports/19-stateless): waiting is the box's, the work's state is the ledger.
//   - WaitFor records the wait on a ledger ask and tells the agent to end its turn;
//   - a ship result for it (by name, or by branch) starts a FRESH conversation whose only input is the
//     entry + the event, never a turn in the chat that asked; an unrelated lane's result starts nothing;
//   - a GitHub run is asked about by the box, not by the agent;
//   - setting an ask done tells Carl once, as a line in the chat he asked in (no model turn) and an alert.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";
import { readLedger, shipMatches, upsertAsk, writeLedger } from "../engine/ledger";

let rig: Rig;
let results: string;
const runs = new Map<string, any>();
beforeAll(async () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `vc-ship-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  results = dir;
  rig = await makeRig({ deps: { shipResults: dir, fetchJson: async (u: string) => runs.get(u.split("/").pop()!) ?? { status: "in_progress" } } });
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

describe("the work ledger", () => {
  it("matches a result by name or branch, only when it is newer than the wait", () => {
    const w = { ship: "stateless-2", since: 10_000, until: 9e15, brief: "x" };
    expect(shipMatches(w, "stateless-2.result", "exit=0", 12_000)).toBe(true);
    expect(shipMatches(w, "stateless-2.result", "exit=0", 10)).toBe(false);
    expect(shipMatches(w, "agency-4.result", "branch=agent/stateless-2", 12_000)).toBe(false);
    expect(shipMatches({ branch: "stateless-2", since: 0, until: 9e15, brief: "x" }, "s.result", "exit=1\nbranch=agent/stateless-2", 5)).toBe(true);
  });

  it("drops closed asks after a few days, keeps open ones", () => {
    const v = join(rig.root, "lv");
    upsertAsk(v, "a", { words: "old done" }, 0);
    upsertAsk(v, "a", { status: "done" }, 0);
    upsertAsk(v, "b", { words: "still open" }, 0);
    writeLedger(v, readLedger(v), 10 * 86_400_000);
    expect(readLedger(v).map((e) => e.id)).toEqual(["b"]);
  });

  it("WaitFor: the box waits; a ship result starts a fresh session with only the entry and the event", async () => {
    const s = await rig.start("Fix the updater and ship it.");
    const r = await rig.backend.call(s.tid, "WaitFor", { ask: "Fix the updater", ship: "upd-1", brief: "If it was accepted, set the ask done; else fix and resubmit." });
    expect(out(r)).toMatch(/The box waits for it \(ask fix-the-updater\).*End your turn now/);
    await settle(s);
    const e = readLedger(rig.vault).find((x) => x.id === "fix-the-updater")!;
    expect(e).toMatchObject({ status: "waiting", conv: s.convId, wait: { ship: "upd-1" } });
    // Another lane's result: nothing starts.
    const turns = rig.backend.turns.length;
    writeFileSync(join(results, "agency-4.result"), "exit=1\nbranch=agent/agency-4\n");
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns);
    // Its own: a fresh conversation, not a turn in the chat that asked.
    writeFileSync(join(results, "upd-1.result"), "exit=0\nbranch=agent/upd-1\npushed=yes\n");
    await rig.engine.tickLedger();
    await until(() => rig.backend.turns.length > turns);
    const t = rig.backend.turns[turns];
    const text = String(t.texts?.join("\n") ?? t.text ?? "");
    expect(text).toContain("A fresh work session");
    expect(text).toContain("Ask fix-the-updater [waiting]: Fix the updater");
    expect(text).toContain("If it was accepted, set the ask done");
    expect(text).toContain("Ship result upd-1:\nexit=0");
    expect(t.threadId).not.toBe(s.tid);
    const after = readLedger(rig.vault).find((x) => x.id === "fix-the-updater")!;
    expect(after.wait).toBeUndefined();
    expect(after.sessions).toEqual(["work-fix-the-updater-1"]);
    expect((await rig.readConv("work-fix-the-updater-1"))?.title).toBe("Work: Fix the updater");
    // The session closes the ask: one line in Carl's chat, one alert; no turn there.
    const carlTurns = rig.backend.turns.filter((x: any) => x.threadId === s.tid).length;
    const done = await rig.backend.call(t.threadId, "Ledger", { action: "set", id: "fix-the-updater", status: "done", last: "Shipped as 1a2b3c; the updater installs again." });
    expect(out(done)).toContain("[done]");
    await until(async () => JSON.stringify(await rig.readConv(s.convId)).includes("Done: Fix the updater — Shipped as 1a2b3c"));
    expect(rig.pings.some((p: any) => String(p.title).startsWith("Done: Fix the updater"))).toBe(true);
    expect(rig.backend.turns.filter((x: any) => x.threadId === s.tid).length).toBe(carlTurns);
    // Later ticks start nothing more.
    const n = rig.backend.turns.length;
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(n);
  });

  it("WaitFor a GitHub run: the box asks GitHub, the agent never polls", async () => {
    const s = await rig.start("Watch CI for the release.");
    const r = await rig.backend.call(s.tid, "WaitFor", { ask: "Release 0.7.40 builds", githubRun: "777", repo: "o/r", brief: "Report the conclusion." });
    expect(out(r)).toContain("The box waits");
    await settle(s);
    const turns = rig.backend.turns.length;
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns);
    runs.set("777", { status: "completed", conclusion: "success", name: "ship" });
    // Asked at most every 2 minutes.
    await rig.engine.tickLedger(Date.now() + 3 * 60_000);
    await until(() => rig.backend.turns.length > turns);
    expect(String(rig.backend.turns[turns].texts?.join("\n"))).toContain('GitHub run 777 (o/r) "ship" completed: success');
  });

  it("a wait that never lands times out into a fresh session", async () => {
    upsertAsk(rig.vault, "slow", { words: "slow thing", wait: { ship: "never", since: Date.now(), until: Date.now() - 1, brief: "b" } });
    const turns = rig.backend.turns.length;
    await rig.engine.tickLedger();
    await until(() => rig.backend.turns.length > turns);
    expect(String(rig.backend.turns[turns].texts?.join("\n"))).toContain("Timed out");
  });

  it("an old result with the waited name does not fire the wait", async () => {
    const f = join(results, "stale-1.result");
    writeFileSync(f, "exit=0\n");
    utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    upsertAsk(rig.vault, "stale", { words: "stale", wait: { ship: "stale-1", since: Date.now(), until: Date.now() + 3600_000, brief: "b" } });
    const turns = rig.backend.turns.length;
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns);
  });
});
