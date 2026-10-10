import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleContextTool, listProjects, readProject, contextToolSpecs } from "../index";
import type { ContextConv, ToolContext } from "../types";
import { tempVault } from "./helpers";

let vault: string;
let cleanup: () => void;
let conv: ContextConv;
let tagged: string[];
let ctx: ToolContext;

beforeEach(() => {
  ({ vault, cleanup } = tempVault());
  conv = { id: "c1", title: "t", messages: [] };
  tagged = [];
  ctx = { conv, setConversationProject: (s) => void tagged.push(s) };
});
afterEach(() => cleanup());

const text = (r: { contentItems: { text: string }[] }) => r.contentItems.map((c) => c.text).join("");
const pdir = (slug: string) => join(vault, ".vault-chat", "projects", slug);

describe("project tools", () => {
  it("exposes the tool specs", () => {
    expect(contextToolSpecs.map((t) => t.name)).toEqual(["SetProject", "ProjectMemory", "Plan", "ProjectCost"]);
    for (const t of contextToolSpecs) expect(t).toMatchObject({ type: "function", inputSchema: { type: "object" } });
  });

  it("SetProject creates the project's files under .vault-chat and tags the conversation", async () => {
    const r = await handleContextTool("SetProject", { name: "Coconut Detector", description: "Find coconuts in photos." }, ctx);
    expect(r.success).toBe(true);
    expect(text(r)).toMatch(/^Created project Coconut Detector \(coconut-detector\)/);
    expect(tagged).toEqual(["coconut-detector"]);
    expect(conv.project).toBe("coconut-detector");
    for (const f of ["project.md", "memory.md", "plan.md", "progress.md"]) expect(existsSync(join(pdir("coconut-detector"), f))).toBe(true);
    expect(existsSync(join(pdir("coconut-detector"), "rules.md"))).toBe(false);
    expect(readFileSync(join(pdir("coconut-detector"), "project.md"), "utf8")).toContain("Find coconuts in photos.");
    expect(listProjects()).toEqual([{ slug: "coconut-detector", name: "Coconut Detector", dir: pdir("coconut-detector") }]);
  });

  it("SetProject attaches to an existing project by name or slug, never overwriting it", async () => {
    await handleContextTool("SetProject", { name: "Coconut" }, ctx);
    await handleContextTool("ProjectMemory", { action: "append", section: "Decisions", text: "- use YOLO" }, ctx);
    const other: ContextConv = { id: "c2" };
    const tags2: string[] = [];
    const r = await handleContextTool("SetProject", { name: "coconut", description: "ignored" }, { conv: other, setConversationProject: (s) => void tags2.push(s) });
    expect(text(r)).toMatch(/^Attached to project Coconut \(coconut\)/);
    expect(text(r)).toContain("- use YOLO");
    expect(tags2).toEqual(["coconut"]);
    expect(listProjects()).toHaveLength(1);
  });

  it("ProjectMemory reads, appends to and updates sections", async () => {
    await handleContextTool("SetProject", { name: "Coconut" }, ctx);
    let r = await handleContextTool("ProjectMemory", { action: "append", section: "Decisions", text: "- batch size 32" }, ctx);
    expect(r.success).toBe(true);
    await handleContextTool("ProjectMemory", { action: "append", section: "Decisions", text: "- lr 3e-4" }, ctx);
    await handleContextTool("ProjectMemory", { action: "append", section: "Open questions", text: "- which GPU?" }, ctx);
    r = await handleContextTool("ProjectMemory", { action: "read", section: "Decisions" }, ctx);
    expect(text(r)).toBe("- batch size 32\n- lr 3e-4");
    await handleContextTool("ProjectMemory", { action: "update", section: "Decisions", text: "- batch size 64 (32 ran out of memory)" }, ctx);
    const mem = readProject("coconut")!.memory;
    expect(mem).toContain("## Decisions\n\n- batch size 64 (32 ran out of memory)\n\n## Tried and learned");
    expect(mem).not.toContain("lr 3e-4");
    expect(mem).toContain("## Open questions\n\n- which GPU?");
    r = await handleContextTool("ProjectMemory", { action: "read" }, ctx);
    expect(text(r)).toContain("# Memory: Coconut");

    await handleContextTool("ProjectMemory", { action: "update", file: "project", section: "Done when", text: "mAP ≥ 0.8 on the test set" }, ctx);
    expect(readProject("coconut")!.project).toContain("## Done when\n\nmAP ≥ 0.8 on the test set");

    await handleContextTool("ProjectMemory", { action: "append", file: "rules", text: "- Never train on the test set." }, ctx);
    expect(readProject("coconut")!.rules).toBe("- Never train on the test set.\n");

    r = await handleContextTool("ProjectMemory", { action: "read", section: "Nope" }, ctx);
    expect(r.success).toBe(false);
    r = await handleContextTool("ProjectMemory", { action: "update", text: "x" }, ctx);
    expect(r.success).toBe(false);
  });

  it("Plan reads and updates plan.md and progress.md", async () => {
    await handleContextTool("SetProject", { name: "Coconut" }, ctx);
    let r = await handleContextTool("Plan", { action: "update", plan: "# Plan\n\n1. label\n2. train" }, ctx);
    expect(text(r)).toBe("plan.md replaced.");
    await handleContextTool("Plan", { action: "update", progressNote: "labelled 200 images" }, ctx);
    await handleContextTool("Plan", { action: "update", progressNote: "training started (tmux coconut)" }, ctx);
    r = await handleContextTool("Plan", { action: "read" }, ctx);
    expect(text(r)).toContain("1. label\n2. train");
    expect(text(r)).toMatch(/- \d{4}-\d\d-\d\d \d\d:\d\d labelled 200 images\n- .* training started \(tmux coconut\)/);
    r = await handleContextTool("Plan", { action: "update" }, ctx);
    expect(r.success).toBe(false);
  });

  it("memory tools refuse without a project, and bad input never throws", async () => {
    let r = await handleContextTool("ProjectMemory", { action: "read" }, ctx);
    expect(r.success).toBe(false);
    expect(text(r)).toContain("SetProject");
    r = await handleContextTool("Plan", { action: "read" }, ctx);
    expect(r.success).toBe(false);
    r = await handleContextTool("SetProject", { name: "!!!" }, ctx);
    expect(r.success).toBe(false);
    r = await handleContextTool("SetProject", null, ctx);
    expect(r.success).toBe(false);
    r = await handleContextTool("Bogus", {}, ctx);
    expect(r.success).toBe(false);
  });
});
