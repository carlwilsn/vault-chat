import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeveloperInstructions, configureContext, createProject, rulesPrefixForTurn, RECHECK_RULE, ROLE_PROMPT, WORK_RULES, PROJECTS_RULE } from "../index";
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
  it("has the role prompt, how to work, the project's shared notes, the re-check rule; no project lists the projects", () => {
    createProject("Coconut", "Find coconuts.");
    createProject("Thesis");
    let s = buildDeveloperInstructions({ id: "c" });
    expect(s.startsWith(ROLE_PROMPT)).toBe(true);
    expect(s).toContain(WORK_RULES);
    expect(s).toContain("This chat is in no project, which is normal.");
    expect(s).toContain("- Coconut (coconut)\n- Thesis (thesis)");
    expect(s).toContain(RECHECK_RULE);
    expect(s).toContain("add it to .vault-chat/rules.md");

    s = buildDeveloperInstructions({ id: "c", project: "coconut" });
    expect(s).toContain("# Project: Coconut");
    expect(s).toContain(`This chat is in Carl's project "Coconut" (${ap("coconut")}).`);
    expect(s).toContain("## Its shared notes (project.md)\n\n# Coconut\n\nFind coconuts.");
    expect(s).not.toContain("This chat is in no project");
    expect(s.trimEnd().endsWith(RECHECK_RULE)).toBe(true);
    // Said once, in either case: only Carl decides what is a project; a project is context, not a boundary.
    for (const x of [s, buildDeveloperInstructions({ id: "c" })]) {
      expect(x.split(PROJECTS_RULE).length).toBe(2);
      expect(x).toContain("Only Carl decides what is a project");
      expect(x).toContain("you may read and write anywhere in the vault (other projects' files and project.md included)");
      expect(x).not.toMatch(/SetProject|ProjectMemory|Plan \{|plan\.md|progress\.md|memory\.md/);
    }

    expect(buildDeveloperInstructions({ id: "c" }, { rolePrompt: "ROLE X" }).startsWith("ROLE X")).toBe(true);
  });

  it("the size rule, do-it-now, read-back and the notes rule are in every thread's instructions", () => {
    const s = buildDeveloperInstructions({ id: "c" });
    expect(s).toContain("A small ask (an edit, a fix, a note, a quick question) is done now, directly, in the real file, in place: no copy of the file, no sandbox");
    expect(s).toContain("git is the undo");
    expect(s).toContain("Heavier checking only for long work, or when Carl asks for it.");
    expect(s).toContain("not as a mission, a schedule or a background job");
    expect(s).toContain("Read back before you claim.");
    expect(s).toContain("an entry in Carl's Notes panel (.vault-chat/notes.jsonl)");
    expect(s).toContain("UpdateNote (change a note in place");
    expect(s).toContain('A "markdown file", a "write-up", or anything "detailed" is a vault .md file');
  });

  it("only project.md loads: an old project's memory, plan and progress stay on disk, unread", () => {
    configureContext({ caps: { project: 500, recap: 12_000 } });
    createProject("Big");
    const p = (f: string) => ap("big", f);
    writeFileSync(p("memory.md"), "MEMORY-TEXT");
    writeFileSync(p("plan.md"), "PLAN-TEXT");
    writeFileSync(p("progress.md"), "PROGRESS-TEXT");
    writeFileSync(p("project.md"), "# Big\n\nNOTES-START " + "w".repeat(9_000) + " NOTES-END");
    const s = buildDeveloperInstructions({ id: "c", project: "big" });
    expect(s).toContain("NOTES-START");
    expect(s).not.toContain("NOTES-END");
    expect(s).toMatch(/\[… \d+ more characters — the rest is in agent-projects\/big\/project\.md\]/);
    for (const x of ["MEMORY-TEXT", "PLAN-TEXT", "PROGRESS-TEXT"]) expect(s).not.toContain(x);
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
    expect(s).toContain("This chat is in no project");
  });
});
