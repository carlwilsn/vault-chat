// The `subagent` tool, vendored from pi's official example extension
// (@earendil-works/pi-coding-agent 1.1.0, examples/extensions/subagent/,
// index.ts + agents.ts; MIT License, Copyright (c) Earendil Works / pi
// contributors). Kept from it: the three modes (single / parallel / chain with
// {previous}), agents as markdown with frontmatter (name, description, tools,
// model), the concurrency mapper, the per-task output cap and the result text.
// Changed for vault-chat: the child is not spawned here. Each child is a
// host call ("vc:host-call" tool "__subagent") and the SERVER starts it as a
// sibling of this pi — its own bubblewrap, pid namespace, process group, key
// fd, scrubbed env, persisted session, timeout and cost ledger — so the key and
// the policy never pass through this process. The TUI rendering is dropped
// (RPC mode has none).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const E = process.env;
const MAX_PARALLEL_TASKS = Number(E.VC_PI_SUBAGENT_MAX_TASKS) || 8;
const MAX_CONCURRENCY = Number(E.VC_PI_SUBAGENT_CONCURRENCY) || 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function parseToolList(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir, source) {
  const agents = [];
  let entries = [];
  try {
    if (!statSync(dir).isDirectory()) return agents;
    entries = readdirSync(dir);
  } catch {
    return agents;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

/** Built-in agents first, then the vault's (.vault-chat/agents) override by name. */
function discoverAgents() {
  const dirs = (() => {
    try {
      return JSON.parse(E.VC_PI_AGENTS_DIRS || "[]");
    } catch {
      return [];
    }
  })();
  const map = new Map();
  dirs.forEach((d, i) => {
    if (existsSync(d)) for (const a of loadAgentsFromDir(d, i === 0 ? "builtin" : "vault")) map.set(a.name, a);
  });
  return [...map.values()];
}

function truncateOutput(output) {
  const n = Buffer.byteLength(output, "utf8");
  if (n <= PER_TASK_OUTPUT_CAP) return output;
  let t = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(t, "utf8") > PER_TASK_OUTPUT_CAP) t = t.slice(0, -1);
  return `${t}\n\n[Output truncated: ${n - Buffer.byteLength(t, "utf8")} bytes omitted. The child's session keeps the full output.]`;
}

async function mapWithConcurrencyLimit(items, concurrency, fn) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    new Array(limit).fill(null).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** One child, run by the host. Never throws: a failure is a failed result. */
async function runSingleAgent(ctx, agents, agentName, task, cwd, model, step, mode, toolCallId) {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return { agent: agentName, task, ok: false, text: `Unknown agent: "${agentName}". Available agents: ${available}.`, step };
  }
  const v = await ctx.ui.editor(
    "vc:host-call",
    JSON.stringify({
      tool: "__subagent",
      args: { agent: { name: agent.name, tools: agent.tools ?? null, model: agent.model ?? null, systemPrompt: agent.systemPrompt }, task, cwd: cwd ?? null, model: model ?? null, step: step ?? null, mode, toolCallId: toolCallId ?? null },
    }),
  );
  let r;
  try {
    r = JSON.parse(v ?? "");
  } catch {
    r = { ok: false, text: "vault-chat did not answer for this subagent." };
  }
  return { agent: agent.name, task, step, ...r };
}

const isFailed = (r) => !r.ok;

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent (default: the vault)" })),
  model: Type.Optional(Type.String({ description: "OpenRouter model id for this child (default: the agent's, else vault-chat's subagent model)" })),
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent (default: the vault)" })),
  model: Type.Optional(Type.String({ description: "OpenRouter model id for this child" })),
});
const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  model: Type.Optional(Type.String({ description: "OpenRouter model id (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent (single mode)" })),
});

export function registerSubagentTool(pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to subagents: separate agents with their own isolated context, run in parallel when you give several.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      `At most ${MAX_PARALLEL_TASKS} tasks per call, ${MAX_CONCURRENCY} at once.`,
      "Subagents cannot ask Carl anything: they report back to you, and you decide what reaches him.",
      "This tool waits: your turn stays open until they report. Use it only for quick fan-out (seconds); anything longer goes to Delegate, which runs in the background while you keep talking. If Carl writes while it waits, the children move to the background and their reports come back as new turns.",
      `Agents: ${discoverAgents().map((a) => `${a.name}: ${a.description}`).join("; ") || "none"}.`,
    ].join(" "),
    parameters: SubagentParams,

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const agents = discoverAgents();
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
        const available = agents.map((a) => a.name).join(", ") || "none";
        return { content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }], details: undefined, isError: true };
      }

      if (hasChain) {
        let previous = "";
        const results = [];
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const r = await runSingleAgent(ctx, agents, s.agent, s.task.replace(/\{previous\}/g, previous), s.cwd, s.model, i + 1, "chain", toolCallId);
          results.push(r);
          if (isFailed(r)) return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${s.agent}): ${r.text}` }], details: { mode: "chain", results }, isError: true };
          previous = r.text;
        }
        return { content: [{ type: "text", text: results[results.length - 1].text || "(no output)" }], details: { mode: "chain", results } };
      }

      if (hasTasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: undefined, isError: true };
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, (t) => runSingleAgent(ctx, agents, t.agent, t.task, t.cwd, t.model, undefined, "parallel", toolCallId));
        const ok = results.filter((r) => !isFailed(r)).length;
        const summaries = results.map((r) => `### [${r.agent}] ${isFailed(r) ? `failed${r.state ? ` (${r.state})` : ""}` : "completed"}\n\n${truncateOutput(r.text || "(no output)")}`);
        return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: { mode: "parallel", results } };
      }

      const r = await runSingleAgent(ctx, agents, params.agent, params.task, params.cwd, params.model, undefined, "single", toolCallId);
      if (isFailed(r)) return { content: [{ type: "text", text: `Agent ${r.state || "failed"}: ${r.text}` }], details: { mode: "single", results: [r] }, isError: true };
      return { content: [{ type: "text", text: r.text || "(no output)" }], details: { mode: "single", results: [r] } };
    },
  });
}
