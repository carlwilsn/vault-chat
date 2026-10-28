// Host-side orchestration from pi's vendored subagent example (MIT). One
// authoritative definition for native pi and external MCP clients. Pi still
// owns each child's session/process; these functions only fan out host calls.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { ToolAnswer, ToolSpec } from "../engine/pi/backend";

type Agent = { name: string; description: string; tools: string[] | null; model: string | null; systemPrompt: string };
function discover(dirs: string[]): Agent[] {
  const agents = new Map<string, Agent>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      try {
        const source = readFileSync(join(dir, name), "utf8");
        // Vault-authored agent files are data, never host-side JavaScript.
        // gray-matter otherwise supports an executable ---javascript engine.
        if (!/^---\r?\n/.test(source)) continue;
        const refuseCode = () => { throw new Error("Executable agent frontmatter is disabled"); };
        const { data, content } = matter(source, { engines: { javascript: refuseCode, js: refuseCode } });
        if (typeof data.name !== "string" || typeof data.description !== "string") continue;
        const tools = Array.isArray(data.tools) ? data.tools.map(String) : typeof data.tools === "string" ? data.tools.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
        agents.set(data.name, { name: data.name, description: data.description, tools, model: typeof data.model === "string" ? data.model : null, systemPrompt: content });
      } catch { /* an invalid agent is not executable */ }
    }
  }
  return [...agents.values()];
}
const item = { type: "object", properties: { agent: { type: "string" }, task: { type: "string" }, cwd: { type: "string" }, model: { type: "string" } }, required: ["agent", "task"], additionalProperties: false };
export function subagentTool(dirs: string[], maxTasks: number, concurrency: number): ToolSpec {
  return {
    type: "function", name: "subagent",
    description: `Delegate quick tasks to isolated pi subagents; this waits for their reports. For longer work use Delegate, which runs in the background. Single mode: agent + task; parallel: tasks; chain: chain (task may contain {previous}). At most ${maxTasks} tasks, ${concurrency} at once. Subagents cannot ask Carl anything. Agents: ${discover(dirs).map((a) => `${a.name}: ${a.description}`).join("; ") || "none"}.`,
    inputSchema: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" }, cwd: { type: "string" }, model: { type: "string" }, tasks: { type: "array", items: item, maxItems: maxTasks }, chain: { type: "array", items: item, maxItems: maxTasks } }, additionalProperties: false },
  };
}
export async function runSubagentTool(params: any, options: { dirs: string[]; maxTasks: number; concurrency: number; signal: AbortSignal; run: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }): Promise<ToolAnswer> {
  const agents = discover(options.dirs);
  const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasSingle = Boolean(params.agent && params.task);
  if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) return { ok: false, text: "Provide exactly one mode: agent + task, tasks, or chain." };
  const tasks: any[] = hasChain ? params.chain : hasTasks ? params.tasks : [params];
  if (tasks.length > options.maxTasks) return { ok: false, text: `At most ${options.maxTasks} tasks per call.` };
  const run = async (task: any): Promise<ToolAnswer> => {
    options.signal.throwIfAborted();
    const agent = agents.find((a) => a.name === task.agent);
    if (!agent) return { ok: false, text: `Unknown agent: ${String(task.agent)}. Available: ${agents.map((a) => a.name).join(", ") || "none"}.` };
    const r = await options.run({ agent, task: String(task.task), cwd: task.cwd ?? null, model: task.model ?? null });
    return { ok: r.ok === true, text: String(r.text ?? "(no output)") };
  };
  if (hasChain) {
    let previous = "";
    for (let i = 0; i < tasks.length; i++) {
      const r = await run({ ...tasks[i], task: String(tasks[i].task).replace(/\{previous\}/g, previous) });
      if (!r.ok) return { ok: false, text: `Chain stopped at step ${i + 1}: ${r.text}` };
      previous = r.text;
    }
    return { ok: true, text: previous };
  }
  if (!hasTasks) return run(params);
  const results: ToolAnswer[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, async () => {
    for (;;) { const i = next++; if (i >= tasks.length) return; results[i] = await run(tasks[i]); }
  }));
  return { ok: results.every((r) => r.ok), text: `Parallel: ${results.filter((r) => r.ok).length}/${results.length} succeeded\n\n${results.map((r, i) => `### [${tasks[i].agent}] ${r.ok ? "completed" : "failed"}\n\n${r.text.slice(0, 50 * 1024)}`).join("\n\n---\n\n")}` };
}
