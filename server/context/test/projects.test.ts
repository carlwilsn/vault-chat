// Projects are plain groupings (Carl, 2026-10-18): a folder of chats plus an
// optional shared notes file, project.md. Only Carl makes a project or moves a
// chat (the app); the agent reads them through box:chats (server/model/chats.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listProjects, listProjectsText, readProject, createProject, ensureProject } from "../index";
import { agentToolSpecs } from "../../engine/engine";
import type { ContextConv } from "../types";
import { tempVault, writeConv } from "./helpers";

let vault: string;
let cleanup: () => void;
let conv: ContextConv;

beforeEach(() => {
  ({ vault, cleanup } = tempVault());
  conv = { id: "c1", title: "t", messages: [] };
});
afterEach(() => cleanup());

const pdir = (slug: string) => join(vault, "agent-projects", slug);

describe("projects are plain groupings", () => {
  it("the agent has no project tool: box:chats reads them, none creates a project or moves a chat", async () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const name of ["ListProjects", "SetProject", "ProjectMemory", "Plan", "ProjectCost", "OpenProject"]) expect(names).not.toContain(name);
    expect(existsSync(join(vault, "agent-projects"))).toBe(false);
    expect(conv.project).toBeUndefined();
  });

  it("a new project (Carl's action) is its folder and a project.md that names it: no plan, progress or memory files", () => {
    const p = createProject("Coconut Detector");
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
    createProject("Psych 221");
    createProject("Whiteboard");
    const convs: ContextConv[] = [
      { id: "a", title: "Week 3 reading", project: "psych-221", lastActivityAt: 3 },
      { id: "b", title: "Essay outline", project: "psych-221", lastActivityAt: 5 },
      { id: "c", title: "Unfiled chat", lastActivityAt: 6 },
    ];
    for (const c of convs) writeConv(vault, c);
    const snapshot = () => readdirSync(join(vault, ".vault-chat", "conversations")).map((f) => readFileSync(join(vault, ".vault-chat", "conversations", f), "utf8"));
    const before = snapshot();
    let r = listProjectsText(null, "psych-221", convs);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('- Psych 221 (psych-221) — this chat: 2 chat(s): "Essay outline", "Week 3 reading"');
    expect(r.text).toContain("- Whiteboard (whiteboard): 0 chat(s)");
    expect(r.text).toMatch(/only he makes them and moves chats into them/);
    expect(r.text).not.toContain("Unfiled chat");
    r = listProjectsText("psych 221", (conv as any).project ?? null, convs);
    expect(r.text).toContain("Notes file: agent-projects/psych-221/project.md");
    expect(r.text).toContain("Readings and essays.");
    expect(r.text).toContain('- "Essay outline" (b)\n- "Week 3 reading" (a)');
    r = listProjectsText("nope", null);
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(listProjects()).toHaveLength(2);
  });

  it("bad input never throws", () => {
    expect(listProjectsText(null, null).ok).toBe(true);
  });
});
