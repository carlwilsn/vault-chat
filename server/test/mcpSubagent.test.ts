import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSubagentTool, subagentTool } from "../mcp/subagent";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function agents() {
  const root = mkdtempSync(join(tmpdir(), "mcp-agents-")); roots.push(root);
  writeFileSync(join(root, "worker.md"), "---\nname: worker\ndescription: Worker\ntools: [read]\n---\nReport only.");
  return root;
}
describe("host-owned MCP subagent orchestration", () => {
  it("treats agent frontmatter as data, never host-executable code", () => {
    const root = agents(); const sentinel = join(root, "host-executed");
    writeFileSync(join(root, "evil.md"), `---javascript\n(require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad'), {name: 'evil', description: 'bad'})\n---\nBad`);
    const spec = subagentTool([root], 8, 4);
    expect(spec.description).toContain("worker: Worker");
    expect(spec.description).not.toContain("evil");
    expect(existsSync(sentinel)).toBe(false);
  });
  it("runs a chain through the existing host runner with explicit agents and previous output", async () => {
    const calls: any[] = [];
    const result = await runSubagentTool({ chain: [{ agent: "worker", task: "first" }, { agent: "worker", task: "then {previous}" }] }, {
      dirs: [agents()], maxTasks: 8, concurrency: 4, signal: new AbortController().signal,
      run: async (args) => { calls.push(args); return { ok: true, text: args.task }; },
    });
    expect(result).toEqual({ ok: true, text: "then first" });
    expect(calls[0].agent).toMatchObject({ name: "worker", tools: ["read"], systemPrompt: "Report only." });
    expect(calls[1].task).toBe("then first");
    expect(calls.map((args) => args.mode)).toEqual(["chain", "chain"]);
  });
  it("stops a chain when Carl's interruption detaches its current child", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await runSubagentTool({ chain: [{ agent: "worker", task: "slow first" }, { agent: "worker", task: "consume {previous}" }] }, {
      dirs: [agents()], maxTasks: 8, concurrency: 4, signal: new AbortController().signal,
      // Subagents.run returns ok:false for a detached chain, ok:true for a
      // detached single/parallel task. Preserve that existing runner contract.
      run: async (args) => { calls.push(args); return { ok: args.mode !== "chain", state: "background", text: "Still working; report comes later." }; },
    });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ ok: false, text: "Chain stopped at step 1: Still working; report comes later." });
  });
  it("never starts queued work once its SDK signal has been cancelled", async () => {
    const abort = new AbortController(); abort.abort(); let calls = 0;
    await expect(runSubagentTool({ agent: "worker", task: "never" }, {
      dirs: [agents()], maxTasks: 8, concurrency: 4, signal: abort.signal,
      run: async () => { calls++; return { ok: true }; },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
