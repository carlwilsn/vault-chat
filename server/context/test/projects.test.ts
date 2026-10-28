// Projects are plain groupings (Carl, 2026-10-18): a folder of chats plus an
// optional shared notes file, project.md. Only Carl makes a project or moves a
// chat (the app); the agent's one project tool, ListProjects, only reads.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleContextTool, listProjects, readProject, contextToolSpecs, createProject, ensureProject } from "../index";
import type { ContextConv, ToolContext } from "../types";
import { tempVault, writeConv } from "./helpers";

let vault: string;
let projects: string;
let cleanup: () => void;
let conv: ContextConv;
let ctx: ToolContext;

beforeEach(() => {
  ({ vault, projects, cleanup } = tempVault());
  conv = { id: "c1", title: "t", messages: [] };
  ctx = { conv };
});
afterEach(() => cleanup());

const text = (r: { contentItems: { text: string }[] }) => r.contentItems.map((c) => c.text).join("");
const pdir = (slug: string) => join(projects, slug);

describe("projects are plain groupings", () => {
  it("the agent's only project tool is ListProjects: none creates a project or moves a chat", async () => {
    expect(contextToolSpecs.map((t) => t.name)).toEqual(["ListProjects"]);
    for (const t of contextToolSpecs) expect(t).toMatchObject({ type: "function", inputSchema: { type: "object" } });
    expect(Object.keys((contextToolSpecs[0]!.inputSchema as any).properties)).toEqual(["project"]);
    // The old tools are gone: a call is refused and nothing is written.
    for (const name of ["SetProject", "ProjectMemory", "Plan", "ProjectCost"]) {
      const r = await handleContextTool(name, { name: "Coconut", action: "append", text: "x" }, ctx);
      expect(r.success).toBe(false);
    }
    expect(readdirSync(projects)).toEqual([]);
    expect(existsSync(join(vault, "agent-projects"))).toBe(false);
    expect(conv.project).toBeUndefined();
  });

  it("a new project (Carl's action) is its folder and a project.md that names it: no plan, progress or memory files", () => {
    const p = createProject("Coconut Detector", "Find coconuts in photos.");
    expect(p).toEqual({ slug: "coconut-detector", name: "Coconut Detector", dir: pdir("coconut-detector") });
    expect(readdirSync(pdir("coconut-detector"))).toEqual(["project.md"]);
    expect(readFileSync(join(pdir("coconut-detector"), "project.md"), "utf8")).toBe("# Coconut Detector\n\nFind coconuts in photos.\n");
    expect(ensureProject("coconut detector")).toEqual({ project: p, created: false });
    expect(listProjects()).toEqual([p]);
  });

  it("an existing project keeps working: its old files stay on disk untouched; project.md is read as its notes", () => {
    const d = pdir("iems-469-course-notes-visuals");
    mkdirSync(d, { recursive: true });
    const files: Record<string, string> = {
      "project.md": "# IEMS 469 Course Notes Visuals\n\n## What\n\nClearer figures in course-notes.html.\n",
      "memory.md": "# Memory\n\n- old memory\n",
      "plan.md": "# Plan\n\n1. old plan\n",
      "progress.md": "# Progress\n\n- old progress\n",
    };
    for (const [f, b] of Object.entries(files)) writeFileSync(join(d, f), b);
    const p = readProject("iems-469-course-notes-visuals")!;
    expect(p.name).toBe("IEMS 469 Course Notes Visuals");
    expect(p.notes).toBe(files["project.md"]);
    expect(Object.keys(p).sort()).toEqual(["dir", "name", "notes", "rules", "slug"]);
    for (const [f, b] of Object.entries(files)) expect(readFileSync(join(d, f), "utf8")).toBe(b);
    // A folder without project.md is still a project (its name is its slug).
    mkdirSync(pdir("psych-221"));
    expect(listProjects().map((x) => x.name)).toEqual(["IEMS 469 Course Notes Visuals", "psych-221"]);
    expect(readProject("psych-221")!.notes).toBe("");
  });

  it("ListProjects lists the projects with their chats, and one project's notes and chats; it changes nothing", async () => {
    createProject("Psych 221", "Readings and essays.");
    createProject("Whiteboard");
    const convs: ContextConv[] = [
      { id: "a", title: "Week 3 reading", project: "psych-221", lastActivityAt: 3 },
      { id: "b", title: "Essay outline", project: "psych-221", lastActivityAt: 5 },
      { id: "c", title: "Unfiled chat", lastActivityAt: 6 },
    ];
    for (const c of convs) writeConv(vault, c);
    const snapshot = () => readdirSync(join(vault, ".vault-chat", "conversations")).map((f) => readFileSync(join(vault, ".vault-chat", "conversations", f), "utf8"));
    const before = snapshot();
    let r = await handleContextTool("ListProjects", {}, { conv: { id: "a", project: "psych-221" }, convs });
    expect(r.success).toBe(true);
    expect(text(r)).toContain('- Psych 221 (psych-221) — this chat: 2 chat(s): "Essay outline", "Week 3 reading"');
    expect(text(r)).toContain("- Whiteboard (whiteboard): 0 chat(s)");
    expect(text(r)).toMatch(/only he makes them and moves chats into them/);
    expect(text(r)).not.toContain("Unfiled chat");
    r = await handleContextTool("ListProjects", { project: "psych 221" }, { conv, convs });
    expect(text(r)).toContain(`Notes file: ${join(projects, "psych-221", "project.md").split("\\").join("/")}`);
    expect(text(r)).toContain("Readings and essays.");
    expect(text(r)).toContain('- "Essay outline" (b)\n- "Week 3 reading" (a)');
    r = await handleContextTool("ListProjects", { project: "nope" }, ctx);
    expect(r.success).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(listProjects()).toHaveLength(2);
  });

  it("bad input never throws", async () => {
    expect((await handleContextTool("ListProjects", null, ctx)).success).toBe(true);
    expect((await handleContextTool("Bogus", {}, ctx)).success).toBe(false);
  });
});
