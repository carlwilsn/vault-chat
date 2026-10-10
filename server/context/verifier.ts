// The Done verifier: a model from a different family than the agent's checks
// each claim against the files (read-only) and the command outputs given as
// evidence. Advisory: ENGINE stores the verdict and shows it; it never blocks.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fsCommands } from "../commands/fs";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { callResponses, familyOf } from "./model";
import { readProject } from "./projects";
import type { ContextConv, Verdict } from "./types";

/** The verifier model for an agent model: never the same family. */
export function verifierModelFor(agentModel: string): string {
  const cfg = ctxConfig();
  return familyOf(agentModel) === familyOf(cfg.verifierModel) ? cfg.verifierModelAlt : cfg.verifierModel;
}

const INSTRUCTIONS = `You are an independent verifier. An agent says it has finished a task for Carl. Check its claims; do not trust them.

- Check every claim in the summary against the evidence: read the files it names with your tools (read-only), and compare against the command outputs quoted in the evidence. You cannot run commands.
- A claim about a file passes only if the file says so. A claim about a command passes only if its quoted output supports it and nothing in the files contradicts it.
- verdict "pass": every material claim is backed. "fail": a claim is contradicted, or a file it depends on is missing or wrong. "unsure": something material could not be checked.
- Be brief. Use a few tool calls, not dozens.

Reply with JSON only, no prose around it:
{"verdict":"pass"|"fail"|"unsure","notes":["one short line per claim checked, saying what you found"]}`;

const TOOLS = [
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a text file (absolute, or relative to the vault). Returns at most `limit` lines from `offset` (1-based).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    type: "function" as const,
    name: "list_dir",
    description: "List a directory (absolute, or relative to the vault).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function" as const,
    name: "grep",
    description: "Search files under a path for a regular expression. Returns path:line: text, at most 100 hits.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } },
      required: ["pattern"],
    },
  },
];

function defaultDeny(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const secrets = process.env.VC_SECRETS_DIR || join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "vault-chat");
  return [secrets];
}

function real(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : resolve(p);
  } catch {
    return resolve(p);
  }
}

/** Resolve a path for the verifier; throws when it is off-limits. */
export function verifierPath(p: string): string {
  const cfg = ctxConfig();
  const full = real(isAbsolute(p) ? p : join(cfg.vault, p));
  const norm = full.replace(/\\/g, "/");
  if (/(^|\/)\.git(\/|$)/.test(norm)) throw new Error("the .git folder is off-limits");
  for (const d of [...defaultDeny(), ...cfg.verifierDeny]) {
    const dr = real(d);
    if (full === dr || full.startsWith(dr.endsWith(sep) ? dr : dr + sep)) throw new Error("that path is off-limits");
  }
  return full;
}

function runTool(name: string, rawArgs: string): string {
  let a: any;
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {
    return "error: arguments were not JSON";
  }
  try {
    if (name === "read_file") {
      const text = fsCommands.read_text_file({ path: verifierPath(String(a.path)) }) as string;
      const lines = text.split("\n");
      const off = Math.max(1, Number(a.offset) || 1);
      const lim = Math.min(Math.max(1, Number(a.limit) || 400), 2_000);
      const slice = lines.slice(off - 1, off - 1 + lim).join("\n");
      const more = off - 1 + lim < lines.length ? `\n[… ${lines.length - (off - 1 + lim)} more lines; use offset]` : "";
      return cap(slice, 40_000, "use offset/limit") + more;
    }
    if (name === "list_dir") {
      const ents = fsCommands.list_dir({ path: verifierPath(String(a.path ?? ".")) }) as { name: string; is_dir: boolean }[];
      return ents.slice(0, 300).map((e) => (e.is_dir ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    }
    if (name === "grep") {
      const hits = fsCommands.grep_files({
        pattern: String(a.pattern),
        path: verifierPath(String(a.path ?? ".")),
        globFilter: a.glob ? String(a.glob) : undefined,
        maxResults: 100,
      }) as { path: string; line: number; text: string }[];
      return hits.map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 300)}`).join("\n") || "(no matches)";
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${typeof e === "string" ? e : (e as Error)?.message ?? String(e)}`;
  }
}

/** Pull {verdict, notes} out of the model's reply. */
export function parseVerdict(text: string): { verdict: Verdict["verdict"]; notes: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const v = j?.verdict;
    if (v !== "pass" && v !== "fail" && v !== "unsure") return null;
    const notes = Array.isArray(j.notes) ? j.notes.filter((n: unknown) => typeof n === "string").map((n: string) => n.trim()) : [];
    return { verdict: v, notes };
  } catch {
    return null;
  }
}

function goalOf(conv: ContextConv): string {
  const asks = (conv.messages ?? [])
    .filter((m) => m.role === "user" && !m.system && !m.hidden && (m.content ?? "").trim())
    .map((m) => m.content.trim());
  const picked = asks.length > 6 ? [...asks.slice(0, 2), "…", ...asks.slice(-4)] : asks;
  return cap(picked.join("\n---\n"), 6_000, "earlier messages omitted", "tail");
}

const MAX_ROUNDS = 10;

/**
 * Verify a Done claim. Resolves within `verifierTimeoutMs` (90 s) with
 * {verdict, notes}; a model failure or the time limit yields "unsure". Never throws.
 */
export async function verifyDone(args: { conv: ContextConv; summary: string; evidence: string[] }): Promise<Verdict> {
  const cfg = ctxConfig();
  const model = verifierModelFor(args.conv.model ?? cfg.agentModel);
  const ctl = new AbortController();
  let cost: number | null = null;
  const addCost = (c: number | null) => {
    if (c !== null) cost = (cost ?? 0) + c;
  };
  const result = (verdict: Verdict["verdict"], notes: string[]): Verdict => ({
    verdict,
    notes,
    model,
    at: Date.now(),
    costUsd: cost === null ? null : Math.round((cost as number) * 1e6) / 1e6,
  });

  const project = args.conv.project ? readProject(args.conv.project) : null;
  const task =
    `# What Carl asked\n\n${goalOf(args.conv) || "(no user message)"}\n\n` +
    (project ? `# The project's "done when" (${project.name})\n\n${cap(project.project, 3_000, "project.md is longer")}\n\n` : "") +
    `# The agent's summary\n\n${args.summary}\n\n# The agent's evidence\n\n` +
    (args.evidence.length ? args.evidence.map((e, i) => `${i + 1}. ${cap(String(e), 6_000, "evidence cut")}`).join("\n") : "(none given)") +
    `\n\nThe vault (working directory) is ${cfg.vault}.`;

  const work = async (): Promise<Verdict> => {
    const input: any[] = [{ role: "user", content: [{ type: "input_text", text: task }] }];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      if (last) input.push({ role: "user", content: [{ type: "input_text", text: "Stop checking. Give your JSON verdict now." }] });
      const r = await callResponses({ model, instructions: INSTRUCTIONS, input, tools: last ? undefined : TOOLS, maxOutputTokens: 3_000, signal: ctl.signal });
      addCost(r.costUsd);
      if (!r.functionCalls.length || last) {
        const v = parseVerdict(r.text);
        return v ? result(v.verdict, v.notes) : result("unsure", ["The verifier's reply was not a verdict.", cap(r.text, 300, "cut")]);
      }
      input.push(...r.output);
      for (const fc of r.functionCalls) {
        input.push({ type: "function_call_output", call_id: fc.callId, output: runTool(fc.name, fc.arguments) });
      }
    }
    return result("unsure", ["The verifier did not reach a verdict."]);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Verdict>((res) => {
    timer = setTimeout(() => {
      ctl.abort();
      res(result("unsure", [`The verifier ran out of time (${Math.round(cfg.verifierTimeoutMs / 1000)} s).`]));
    }, cfg.verifierTimeoutMs);
  });
  try {
    return await Promise.race([
      work().catch((e) => result("unsure", [`The verifier could not run: ${(e as Error)?.message ?? String(e)}`])),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One line for the reply and the push, e.g. "Verifier (anthropic/claude-sonnet-5.5): pass". */
export function formatVerdict(v: Verdict): string {
  const word = v.verdict === "pass" ? "pass" : v.verdict === "fail" ? "FAIL" : "unsure";
  const first = v.notes[0] ? ` — ${v.notes[0]}` : "";
  return `Verifier (${v.model}): ${word}${first}`;
}
