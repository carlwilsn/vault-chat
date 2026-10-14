// Long runs, in process on a fake pi: Done gated by a check the agent cannot
// edit, budget caps, the progress metric and its plateau alert, job control,
// the task queue with fresh worker sessions, worktrees per worker, model tiering.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { inputText } from "../context/test/helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let verifierSaw: string[] = [];

beforeAll(async () => {
  rig = await makeRig({
    verifier: (req) => {
      verifierSaw.push(inputText(req));
      return { text: '{"verdict":"pass","notes":["checked"]}' };
    },
  });
});

afterAll(async () => {
  rig?.engine?.stop();
  await rig?.verifier.close();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");

/** A project with a check script in the vault, declared in project.md's "Done when". */
async function projectWithCheck(name: string, script: string, block?: string): Promise<{ convId: string; tid: string; slug: string }> {
  const s = await rig.start(`Work on ${name} and keep going.`);
  const r = await rig.backend.call(s.tid, "SetProject", { name });
  expect(r.ok).toBe(true);
  const slug = name.toLowerCase();
  writeFileSync(join(rig.vault, `${slug}-check.js`), script);
  const pmd = join(rig.vault, ".vault-chat", "projects", slug, "project.md");
  const cur = readFileSync(pmd, "utf8");
  writeFileSync(pmd, cur.replace("(not decided yet)", `All functions match.\n\n\`\`\`sh\n${block ?? `node ${slug}-check.js`}\n\`\`\`\n\n# a comment line in the section is fine`));
  await rig.backend.call(s.tid, "KeepWorking", { on: true });
  return { ...s, slug };
}

describe("1. Done is gated by an executable check the agent cannot edit", () => {
  it("a passing check: Done goes through, and the verifier reads the server's own check output", async () => {
    verifierSaw = [];
    const p = await projectWithCheck("Alpha", `console.log("matched 412/412 functions CHECKMARK-7731"); process.exit(0);`);
    const r = await rig.backend.call(p.tid, "Done", { summary: "All 412 functions match.", evidence: ["ran the check"] });
    expect(r.ok).toBe(true);
    expect(out(r)).toMatch(/check passed/);
    rig.backend.end(p.tid);
    await until(async () => (await rig.readConv(p.convId))?.state === "done");
    const c = await rig.readConv(p.convId);
    expect(c.working).toBe(false);
    expect(c.verdict.verdict).toBe("pass");
    expect(c.long.lastCheck.ok).toBe(true);
    // The verifier was given the check's real output (not the agent's quote), and where its log is.
    expect(verifierSaw.join("\n")).toMatch(/CHECKMARK-7731/);
    expect(verifierSaw.join("\n")).toMatch(/run by the server itself/);
    expect(readFileSync(join(rig.vault, ".vault-chat", "local", "projects", "alpha", "check-last.log"), "utf8")).toMatch(/CHECKMARK-7731/);
  });

  it("a failing check refuses Done: keep-going stays on, the agent gets the output tail, the turn is nudged on", async () => {
    const p = await projectWithCheck("Beta", `console.log("matched 300/412 functions"); console.error("mismatch in fn_8001c0"); process.exit(1);`);
    const turns = rig.backend.turns.length;
    const r = await rig.backend.call(p.tid, "Done", { summary: "All done.", evidence: [] });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/Done refused: the project's check failed \(exit 1\)/);
    expect(out(r)).toMatch(/mismatch in fn_8001c0/);
    rig.backend.end(p.tid);
    // Not done: still keep-going, so the unended turn gets the nudge turn.
    await until(() => rig.backend.turns.length === turns + 1);
    const c = await rig.readConv(p.convId);
    expect(c.state).not.toBe("done");
    expect(c.working).toBe(true);
    expect(c.long.lastCheck.ok).toBe(false);
    expect(c.verdict).toBeUndefined();
    expect(rig.pings.some((x) => x.convId === p.convId && /^Done:/.test(x.title))).toBe(false);
    rig.backend.end(p.tid);
  });

  it("a script edited after the check was set (or the command in project.md) refuses Done without running it; only Carl can re-set it", async () => {
    const p = await projectWithCheck("Gamma", `console.log("ok"); process.exit(0);`);
    // First sight pins it (the agent's own SetCheck is refused from now on).
    const sc = await rig.backend.call(p.tid, "SetCheck", { command: "node -e \"process.exit(0)\"" });
    expect(sc.ok).toBe(false);
    expect(out(sc)).toMatch(/Only Carl can change it/);
    // The agent "fixes" the oracle instead of the work.
    writeFileSync(join(rig.vault, "gamma-check.js"), `console.log("ok, trust me"); process.exit(0);`);
    const r = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/gamma-check\.js changed since the check was set/);
    // Put the script back but swap the command in project.md: refused too.
    writeFileSync(join(rig.vault, "gamma-check.js"), `console.log("ok"); process.exit(0);`);
    const pmd = join(rig.vault, ".vault-chat", "projects", "gamma", "project.md");
    writeFileSync(pmd, readFileSync(pmd, "utf8").replace("node gamma-check.js", "node -e 0"));
    const r2 = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r2.ok).toBe(false);
    expect(out(r2)).toMatch(/command in project\.md changed/);
    // Carl re-sets it through the API: Done passes.
    const ctl = await rig.engine.control({ project: "gamma" }, "check", { command: "node gamma-check.js" });
    expect(ctl.ok).toBe(true);
    const r3 = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r3.ok).toBe(true);
    rig.backend.end(p.tid);
    await until(async () => (await rig.readConv(p.convId))?.state === "done");
  });

  it("SetCheck: the agent may set a project's first check (pass_regex), once", async () => {
    const s = await rig.start("Delta work");
    await rig.backend.call(s.tid, "SetProject", { name: "Delta" });
    mkdirSync(join(rig.vault, "tools"), { recursive: true });
    writeFileSync(join(rig.vault, "tools", "score.js"), `console.log("score: 97%")`);
    const a = await rig.backend.call(s.tid, "SetCheck", { command: "node tools/score.js", pass_regex: "score: (9\\d|100)%" });
    expect(a.ok).toBe(true);
    expect(out(a)).toMatch(/score\.js/);
    const b = await rig.backend.call(s.tid, "SetCheck", { command: "node -e 0" });
    expect(b.ok).toBe(false);
    const r = await rig.backend.call(s.tid, "Done", { summary: "97%.", evidence: [] });
    expect(r.ok).toBe(true);
    rig.backend.end(s.tid);
  });
});

describe("2. Budget caps", () => {
  it("80%: the agent is told before its turn; 100%: the conversation ends blocked with one push, its wake never runs", async () => {
    const s = await rig.start("Grind through it, keep going.");
    const set = await rig.engine.control({ convId: s.convId }, "budget", { usd: 10 });
    expect(set.ok).toBe(true);
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state !== "running");
    // $8.50 spent: the next turn's input carries the 80% line.
    const { mutateConv } = await import("../engine/convs");
    await mutateConv(rig.vault, s.convId, (c) => {
      c.costUsd = 8.5;
    });
    const n = rig.backend.turns.length;
    await rig.engine.run(s.convId, "Wake: next step", "wake");
    await until(() => rig.backend.turns.length === n + 1);
    const t = rig.backend.turns[n].texts.join("\n");
    expect(t).toMatch(/Budget: \$8\.50 of the conversation's \$10\.00 spent \(85%\)/);
    await rig.backend.call(s.tid, "KeepWorking", { on: true });
    await rig.backend.call(s.tid, "ScheduleWake", { in: "1h", reason: "next step" });
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state === "sleeping");
    // $10.20: the wake fires but runs no turn; blocked, one push.
    await mutateConv(rig.vault, s.convId, (c) => {
      c.costUsd = 10.2;
    });
    await rig.engine.run(s.convId, "Wake: next step", "wake");
    const c = await rig.readConv(s.convId);
    expect(rig.backend.turns.length).toBe(n + 1);
    expect(c.state).toBe("blocked");
    expect(c.working).toBe(false);
    expect(c.nextWakeAt).toBeUndefined();
    expect(c.messages.at(-1).content).toMatch(/Budget reached/);
    await rig.engine.run(s.convId, "Wake: again", "wake");
    expect(rig.pings.filter((p) => p.convId === s.convId && /^Budget reached/.test(p.title))).toHaveLength(1);
    // Carl's own message still runs a turn, told the budget is spent.
    await rig.engine.message({ convId: s.convId, text: "What's the state?" });
    await until(() => rig.backend.turns.length === n + 2);
    expect(rig.backend.turns[n + 1].texts.join("\n")).toMatch(/Budget reached: \$10\.20/);
    rig.backend.end(s.tid);
  });

  it("a project budget counts every conversation of the project; SetBudget needs Carl's approval", async () => {
    const s = await rig.start("Project budget");
    await rig.backend.call(s.tid, "SetProject", { name: "Epsilon" });
    const pending = rig.backend.call(s.tid, "SetBudget", { usd: 5, scope: "project", reason: "a long grind" });
    await until(async () => !!(await rig.readConv(s.convId))?.pendingAsk);
    expect((await rig.readConv(s.convId)).pendingAsk.question).toMatch(/\$5\.00 budget on this project \(epsilon\)/);
    await rig.engine.answerRoute({ convId: s.convId, text: "Approve" });
    const r = await pending;
    expect(out(r)).toMatch(/Budget set/);
    // A second conversation in the project spends $4.20: the first one is past 80%.
    const s2 = await rig.start("Other work", { project: "Epsilon" });
    const { mutateConv } = await import("../engine/convs");
    await mutateConv(rig.vault, s2.convId, (c) => {
      c.costUsd = 4.2;
    });
    const b = rig.engine.budgetOf(await rig.readConv(s.convId));
    expect(b.scope).toBe("project");
    expect(b.frac).toBeCloseTo(0.84, 2);
    // Declined: nothing set.
    const p2 = rig.backend.call(s2.tid, "SetBudget", { usd: 50 });
    await until(async () => !!(await rig.readConv(s2.convId))?.pendingAsk);
    await rig.engine.answerRoute({ convId: s2.convId, text: "Decline" });
    expect(out(await p2)).toMatch(/did not approve/);
    expect((await rig.readConv(s2.convId)).long?.budgetUsd).toBeUndefined();
    rig.backend.end(s.tid);
    rig.backend.end(s2.tid);
  });
});

describe("3. Progress metric and the plateau alert", () => {
  it("samples the pinned metric into a series, shows \"62.4% · +1.8 today\", alerts once on a plateau, tells the agent, and puts it in the Blocked push", async () => {
    const s = await rig.start("Decompile it, keep going.");
    await rig.backend.call(s.tid, "SetProject", { name: "Zeta" });
    await rig.backend.call(s.tid, "KeepWorking", { on: true });
    const val = join(rig.vault, "zeta-value.txt");
    writeFileSync(join(rig.vault, "zeta-metric.js"), `const v = require("fs").readFileSync(${JSON.stringify(val)}, "utf8").trim(); console.log("functions: 4120; matched " + v + "%");`);
    writeFileSync(val, "60.6");
    const set = await rig.engine.control({ project: "zeta" }, "metric", { command: "node zeta-metric.js", every_min: 15, window_h: 1 });
    expect(set.ok).toBe(true);
    // The agent can't replace it.
    const sm = await rig.backend.call(s.tid, "SetMetric", { command: "node -e \"console.log(100)\"" });
    expect(sm.ok).toBe(false);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const now = Math.max(Date.now(), midnight.getTime() + 2 * 3_600_000);
    expect((await rig.engine.sampleMetric("zeta", midnight.getTime() - 3_600_000)).value).toBe(60.6);
    writeFileSync(val, "62.4");
    await rig.engine.sampleMetric("zeta", now);
    await until(async () => (await rig.readConv(s.convId))?.long?.metric === "62.4% · +1.8 today");
    // Flat for 5 samples 15 min apart (75 min of work ≥ the 1 h window): one push.
    for (let i = 1; i <= 5; i++) await rig.engine.sampleMetric("zeta", now + i * 15 * 60_000);
    const plateauPings = () => rig.pings.filter((p) => p.convId === s.convId && /^No progress in 1 h/.test(p.title));
    expect(plateauPings()).toHaveLength(1);
    expect(plateauPings()[0].body).toMatch(/not risen past 62\.4%/);
    await rig.engine.sampleMetric("zeta", now + 6 * 15 * 60_000);
    expect(plateauPings()).toHaveLength(1);
    expect(rig.engine.turnNotes(await rig.readConv(s.convId))).toMatch(/No progress: the project's metric has not risen past 62\.4%/);
    // A rise clears the note.
    writeFileSync(val, "63");
    await rig.engine.sampleMetric("zeta", now + 7 * 15 * 60_000);
    expect(rig.engine.turnNotes(await rig.readConv(s.convId))).not.toMatch(/No progress/);
    // The Blocked push carries the line.
    await rig.backend.call(s.tid, "Blocked", { reason: "need the symbols file" });
    expect(rig.pings.find((p) => p.convId === s.convId && /^Blocked:/.test(p.title)).body).toMatch(/Progress: 63%/);
    rig.backend.end(s.tid);
    // An edited metric script is not run.
    writeFileSync(join(rig.vault, "zeta-metric.js"), `console.log("matched 100%")`);
    expect(await rig.engine.sampleMetric("zeta", now + 8 * 15 * 60_000)).toBeNull();
  });

  it("the series math: last number, today's change, plateau counted in active time only", async () => {
    const { parseMetric, metricLine, plateauOf } = await import("../engine/long");
    expect(parseMetric("built 3 files\nmatched 1203/4120 = 29.2%\n")).toEqual({ value: 29.2, unit: "%" });
    expect(parseMetric("no numbers here")).toBeNull();
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    const day = t.getTime();
    expect(metricLine([{ at: day - 86_400_000, value: 10 }, { at: day, value: 12.5 }], day)).toBe("12.5 · +2.5 today");
    expect(metricLine([{ at: day, value: 7 }], day)).toBe("7");
    // A 10 h gap overnight counts as 30 min of work (2 × 15 min).
    const flat = [0, 15, 600].map((m) => ({ at: day + m * 60_000, value: 5 }));
    expect(plateauOf(flat, 15, 1)).toBeNull(); // 15 + 30 min
    expect(plateauOf([...flat, { at: day + 615 * 60_000, value: 5 }], 15, 1)?.best).toBe(5); // + 15 = 1 h
    expect(plateauOf([...flat, { at: day + 615 * 60_000, value: 6 }], 15, 1)).toBeNull(); // it rose
  });
});
