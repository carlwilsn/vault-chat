import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeveloperInstructions, configureContext, createProject, rulesPrefixForTurn, RECHECK_RULE, ROLE_PROMPT } from "../index";
import type { ContextConv } from "../types";
import { tempVault } from "./helpers";

let vault: string;
let cleanup: () => void;
beforeEach(() => ({ vault, cleanup } = tempVault()));
afterEach(() => cleanup());

const vc = (...p: string[]) => join(vault, ".vault-chat", ...p);
const ap = (...p: string[]) => join(vault, "agent-projects", ...p);

describe("rules on every turn", () => {
  it("rulesPrefixForTurn carries the global and project rules in full, read fresh each turn", () => {
    expect(rulesPrefixForTurn({ id: "c" })).toBe("");
    writeFileSync(vc("rules.md"), "- Never spend over $5 without asking.\n- Reply in English.\n");
    createProject("Coconut");
    writeFileSync(ap("coconut", "rules.md"), "- Never train on the test set.\n");
    const conv: ContextConv = { id: "c", project: "coconut" };

    // Simulate ten turns, with a rule added after turn 5: every prefix has every rule.
    for (let turn = 1; turn <= 10; turn++) {
      if (turn === 6) writeFileSync(vc("rules.md"), "- Never spend over $5 without asking.\n- Reply in English.\n- Commit as [agent].\n");
      const p = rulesPrefixForTurn(conv);
      expect(p.startsWith("<rules>\n")).toBe(true);
      expect(p).toContain("- Never spend over $5 without asking.\n- Reply in English.");
      expect(p).toContain("## Project rules: Coconut\n\n- Never train on the test set.");
      if (turn >= 6) expect(p).toContain("- Commit as [agent].");
    }
    // A conversation without a project gets only the global rules.
    expect(rulesPrefixForTurn({ id: "d" })).not.toContain("Project rules");
  });

  it("the rules are in the developer instructions in full, however long", () => {
    const long = Array.from({ length: 400 }, (_, i) => `- rule number ${i}`).join("\n");
    writeFileSync(vc("rules.md"), long);
    const s = buildDeveloperInstructions({ id: "c" });
    expect(s).toContain(long);
  });
});

describe("buildDeveloperInstructions", () => {
  it("has the role prompt, the project's files, the re-check rule; no project lists the projects", () => {
    createProject("Coconut", "Find coconuts.");
    createProject("Thesis");
    let s = buildDeveloperInstructions({ id: "c" });
    expect(s.startsWith(ROLE_PROMPT)).toBe(true);
    expect(s).toContain("This conversation has no project");
    expect(s).toContain("- Coconut (coconut)\n- Thesis (thesis)");
    expect(s).toContain(RECHECK_RULE);
    expect(s).toContain("(none yet; global rules go in .vault-chat/rules.md)");

    s = buildDeveloperInstructions({ id: "c", project: "coconut" });
    expect(s).toContain("# Project: Coconut");
    expect(s).toContain("Find coconuts.");
    expect(s).toContain("# Memory: Coconut");
    expect(s).toContain("# Plan: Coconut");
    expect(s).not.toContain("This conversation has no project");
    expect(s.trimEnd().endsWith(RECHECK_RULE)).toBe(true);

    expect(buildDeveloperInstructions({ id: "c" }, { rolePrompt: "ROLE X" }).startsWith("ROLE X")).toBe(true);
  });

  it("caps the project files, with a pointer to read more", () => {
    configureContext({ caps: { project: 500, memory: 1_000, plan: 300, progress: 200, recap: 12_000 } });
    createProject("Big");
    const p = (f: string) => ap("big", f);
    writeFileSync(p("memory.md"), "# Memory\n\n" + "M".repeat(50_000) + "\nMEMORY-END");
    writeFileSync(p("plan.md"), "PLAN-START " + "p".repeat(5_000));
    writeFileSync(p("progress.md"), "PROGRESS-OLD " + "q".repeat(5_000) + " PROGRESS-NEWEST");
    writeFileSync(p("project.md"), "# Big\n\n" + "w".repeat(9_000));
    const s = buildDeveloperInstructions({ id: "c", project: "big" });
    expect(s).not.toContain("MEMORY-END");
    expect(s).toMatch(/\[… \d+ more characters — read more with ProjectMemory \{action:"read"\}\]/);
    expect(s).toContain("PLAN-START");
    expect(s).toContain('read more with Plan {action:"read"}');
    // progress keeps the newest end
    expect(s).toContain("PROGRESS-NEWEST");
    expect(s).not.toContain("PROGRESS-OLD");
    expect(s.length).toBeLessThan(ROLE_PROMPT.length + 500 + 1_000 + 300 + 200 + 2_500);
  });

  it("includes the recap after a roll-over (the latest one)", () => {
    const conv: ContextConv = {
      id: "c",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Rolled over to a fresh session", system: true, rollover: { at: 1, recap: "OLD RECAP" } },
        { role: "user", content: "more" },
        { role: "assistant", content: "Rolled over to a fresh session", system: true, rollover: { at: 2, recap: "NEW RECAP" } },
      ],
    };
    const s = buildDeveloperInstructions(conv);
    expect(s).toContain("# Recap: this conversation continues from an earlier session\n\nNEW RECAP");
    expect(s).not.toContain("OLD RECAP");
    expect(buildDeveloperInstructions({ id: "c", messages: [{ role: "user", content: "x" }] })).not.toContain("# Recap");
  });

  it("ignores a project tag whose folder is gone", () => {
    mkdirSync(ap(), { recursive: true });
    const s = buildDeveloperInstructions({ id: "c", project: "deleted" });
    expect(s).toContain("This conversation has no project");
  });
});
