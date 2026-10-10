// The seam to Order C (CONTEXT, `server/context/**`). ENGINE calls only the
// functions below. Until CONTEXT merges they are a minimal local stub with the
// same names; when it lands, replace the bodies in this file with re-exports
// from "../context" (one file, no other engine change).
//
//   buildDeveloperInstructions(conv, vault) → string   (thread/start)
//   rulesPrefixForTurn(conv, vault)         → string   (every turn's first input item)
//   shouldRoll(conv, usage)                 → boolean  (after every turn)
//   buildRecap(conv, vault)                 → string   (developerInstructions of the new thread)
//   verifyDone({conv, vault, summary, evidence}) → {verdict, notes[]}  (Done tool, ≤90 s)
//   contextTools                            → dynamic tools: SetProject, ProjectMemory, Plan
//   projectCost(vault, project)             → {totalUsd, conversations}
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Conversation } from "../../src/conversations";
import { modelMeta } from "./catalog";
import { ENGINE_ROLE_PROMPT } from "./prompt";

export type EngineConv = Conversation & {
  codexThreadId?: string;
  codexThreadPath?: string;
  project?: string;
  working?: boolean;
  nextWakeAt?: number;
  state?: "idle" | "running" | "sleeping" | "waiting_user" | "blocked" | "done";
  recap?: string;
};

export type Verdict = { verdict: "pass" | "fail" | "unsure"; notes: string[] };

export type ToolCtx = {
  conv: EngineConv;
  vault: string;
  /** Merge fields into the conversation's meta (e.g. `project`). */
  setMeta: (patch: Partial<EngineConv>) => Promise<void>;
};

export type ContextTool = {
  spec: { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> };
  handle: (args: any, ctx: ToolCtx) => Promise<string>;
};

const read = (p: string, cap = 20_000): string => {
  try {
    const t = readFileSync(p, "utf8");
    return t.length > cap ? t.slice(0, cap) + "\n…[capped — read more with ProjectMemory]" : t;
  } catch {
    return "";
  }
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

const projectDir = (vault: string, slug: string) => join(vault, ".vault-chat", "projects", slug);

export async function rulesPrefixForTurn(conv: EngineConv, vault: string): Promise<string> {
  const parts: string[] = [];
  const g = read(join(vault, ".vault-chat", "rules.md")).trim();
  if (g) parts.push(`Carl's rules:\n${g}`);
  if (conv.project) {
    const p = read(join(projectDir(vault, conv.project), "rules.md")).trim();
    if (p) parts.push(`Project rules (${conv.project}):\n${p}`);
  }
  return parts.length ? `<rules>\n${parts.join("\n\n")}\n</rules>` : "";
}

export async function buildDeveloperInstructions(conv: EngineConv, vault: string): Promise<string> {
  const parts = [ENGINE_ROLE_PROMPT];
  const rules = await rulesPrefixForTurn(conv, vault);
  if (rules) parts.push(rules);
  if (conv.project) {
    const d = projectDir(vault, conv.project);
    for (const f of ["project.md", "memory.md", "plan.md", "progress.md"]) {
      const t = read(join(d, f), 6_000).trim();
      if (t) parts.push(`<project file="${f}">\n${t}\n</project>`);
    }
  }
  if (conv.recap) parts.push(`<recap>\n${conv.recap}\n</recap>`);
  parts.push("Notes and memory can be stale: re-check reality (files, processes, logs) before trusting them.");
  return parts.join("\n\n");
}

export function shouldRoll(conv: EngineConv, usage: { inputTokens: number; model: string }): boolean {
  const ctx = modelMeta(usage.model)?.contextLength ?? 200_000;
  return usage.inputTokens > Math.min(ctx * 0.6, 400_000);
}

export async function buildRecap(conv: EngineConv, vault: string): Promise<string> {
  const msgs = conv.messages.filter((m) => !m.hidden && (m.content ?? "").trim()).slice(-20);
  const body = msgs.map((m) => `${m.role}: ${(m.content ?? "").slice(0, 800)}`).join("\n");
  const mem = conv.project ? read(join(projectDir(vault, conv.project), "memory.md"), 4_000) : "";
  return `Earlier in this conversation (recap):\n${body}${mem ? `\n\nProject memory:\n${mem}` : ""}`;
}

export async function verifyDone(_a: { conv: EngineConv; vault: string; summary: string; evidence: string[] }): Promise<Verdict> {
  return { verdict: "unsure", notes: ["verifier not installed yet (CONTEXT stub)"] };
}

export function projectCost(vault: string, project: string, convs: EngineConv[]): { totalUsd: number; conversations: number } {
  const mine = convs.filter((c) => c.project === project);
  return { totalUsd: Math.round(mine.reduce((s, c) => s + (c.costUsd ?? 0), 0) * 1e6) / 1e6, conversations: mine.length };
}

export const contextTools: ContextTool[] = [
  {
    spec: {
      type: "function",
      name: "SetProject",
      description: "Attach this conversation to a project (created if new). Use when Carl says what the work is for, e.g. 'this is for Coconut'.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    handle: async (a, ctx) => {
      const slug = slugify(String(a?.name ?? ""));
      const d = projectDir(ctx.vault, slug);
      mkdirSync(d, { recursive: true });
      if (!existsSync(join(d, "project.md"))) writeFileSync(join(d, "project.md"), `# ${String(a?.name ?? slug)}\n`);
      await ctx.setMeta({ project: slug });
      return `Conversation attached to project ${slug}.`;
    },
  },
  {
    spec: {
      type: "function",
      name: "ProjectMemory",
      description: "Read or add to the current project's memory (decisions, what was tried and learned, conventions).",
      inputSchema: {
        type: "object",
        properties: { op: { type: "string", enum: ["read", "append", "update"] }, section: { type: "string" }, text: { type: "string" } },
        required: ["op"],
      },
    },
    handle: async (a, ctx) => {
      if (!ctx.conv.project) return "No project on this conversation — call SetProject first.";
      const p = join(projectDir(ctx.vault, ctx.conv.project), "memory.md");
      if (a?.op === "read") return read(p, 60_000) || "(empty)";
      mkdirSync(projectDir(ctx.vault, ctx.conv.project), { recursive: true });
      appendFileSync(p, `\n## ${String(a?.section ?? "Notes")}\n${String(a?.text ?? "")}\n`);
      return "Saved.";
    },
  },
  {
    spec: {
      type: "function",
      name: "Plan",
      description: "Read or replace the current project's plan.md / progress.md.",
      inputSchema: {
        type: "object",
        properties: { op: { type: "string", enum: ["read", "update"] }, file: { type: "string", enum: ["plan", "progress"] }, text: { type: "string" } },
        required: ["op"],
      },
    },
    handle: async (a, ctx) => {
      if (!ctx.conv.project) return "No project on this conversation — call SetProject first.";
      const p = join(projectDir(ctx.vault, ctx.conv.project), `${a?.file === "progress" ? "progress" : "plan"}.md`);
      if (a?.op !== "update") return read(p, 60_000) || "(empty)";
      mkdirSync(projectDir(ctx.vault, ctx.conv.project), { recursive: true });
      writeFileSync(p, String(a?.text ?? ""));
      return "Saved.";
    },
  },
];
