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
