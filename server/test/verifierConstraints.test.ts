// The Done verifier checks the task's explicit constraints against the evidence
// (a box run passed checks made seconds apart when the task said 2 minutes).
// A fake verifier model that does what its prompt tells it: it compares the
// log's timestamps only when the instructions ask for constraint checking.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel, tempVault, inputText, type FakeModel, type FakeReq } from "../context/test/helpers";
import { verifyDone } from "../context";

let fake: FakeModel;
let vault: string;
let done: () => void;

function obedientVerifier(req: FakeReq) {
  const items = Array.isArray(req.input) ? req.input : [];
  const out = items.find((i: any) => i.type === "function_call_output");
  if (!out) return { calls: [{ name: "read_file", arguments: { path: "checks.log" } }] };
  const checksConstraints = /explicit constraints/i.test(req.instructions ?? "") && /timestamps/i.test(req.instructions ?? "");
  if (!checksConstraints) return { text: `{"verdict":"pass","notes":["checks.log has 3 checks"]}` };
  const times = [...String(out.output).matchAll(/(\d\d):(\d\d):(\d\d)/g)].map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  return gaps.every((g) => g >= 120)
    ? { text: `{"verdict":"pass","notes":["3 checks, 2 minutes apart"]}` }
    : { text: `{"verdict":"fail","notes":["asked for checks 2 minutes apart; the log shows gaps of ${gaps.join(", ")} s"]}` };
}

beforeEach(async () => {
  fake = await startFakeModel(obedientVerifier);
  ({ vault, cleanup: done } = tempVault(fake.base));
  mkdirSync(join(vault, "notes"), { recursive: true });
});
afterEach(async () => {
  done();
  await fake.close();
});

const conv = { id: "c", model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user" as const, content: "Check the site 3 times, 2 minutes apart, and log each check to checks.log." }] };

describe("the verifier checks stated constraints", () => {
  it("its prompt tells it to check timing/counts/spacing/formats against timestamps and to fail a violation", async () => {
    writeFileSync(join(vault, "checks.log"), "12:00:01 ok\n12:00:04 ok\n12:00:09 ok\n");
    const v = await verifyDone({ conv, summary: "Checked the site 3 times; see checks.log.", evidence: ["file: checks.log"] });
    const ins = fake.requests[0]!.instructions ?? "";
    expect(ins).toMatch(/explicit constraints/);
    expect(ins).toMatch(/timing and intervals/);
    expect(ins).toMatch(/counts/);
    expect(ins).toMatch(/spacing/);
    expect(ins).toMatch(/formats/);
    expect(ins).toMatch(/timestamps in files, logs and tool results/);
    expect(ins).toMatch(/stated constraint is violated/);
    expect(inputText(fake.requests[0]!)).toMatch(/check every explicit constraint in what Carl asked/);
    expect(v.verdict).toBe("fail");
    expect(v.notes[0]).toMatch(/2 minutes apart/);
  });

  it("passes when the evidence meets the constraint", async () => {
    writeFileSync(join(vault, "checks.log"), "12:00:01 ok\n12:02:02 ok\n12:04:05 ok\n");
    const v = await verifyDone({ conv, summary: "Checked the site 3 times; see checks.log.", evidence: ["file: checks.log"] });
    expect(v.verdict).toBe("pass");
  });
});
