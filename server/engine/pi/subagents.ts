// Subagents: a parent pi's `subagent` tool (ext/subagent.mjs, vendored from
// pi's example) asks the host, per child, over the extension bridge; the host
// starts the child here as a SIBLING of the parent — the same launch as any pi
// (its own bubblewrap, pid namespace and process group, the key on its own fd,
// scrubbed env, path guard), in RPC mode so it can be steered and stopped, on a
// persisted session of its own under sessions/sub/<parent session>/. A child
// gets file/shell tools plus Done/Notify (an agent may allow PdfRead/WebSearch)
// and never AskUser: it reports to the parent, which decides what reaches Carl.
// Its OpenRouter cost (the vc-cost entries in its session) is rolled onto the
// parent conversation by the engine (childUsageCalls) and summed into
// subagents[] on the meta. A parent that stops or dies takes its children down.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PiBackend, ToolSpec } from "./backend";
import type { PiProc } from "./proc";

export type SubagentOptions = {
  /** Agent definitions: built-ins first, then the vault's (.vault-chat/agents) override by name. */
  agentsDirs: string[];
  /** Children at once per subagent call, tasks per call (the extension enforces both). */
  concurrency: number;
  maxTasks: number;
  /** Children at once on the whole box. */
  hostMax: number;
  /** Wall-clock limit per child, then the grace between abort and SIGKILL of its group. */
  timeoutMs: number;
  graceMs: number;
  /** Model for children whose agent names none (null: the parent's). */
  defaultModel: string | null;
};

type ChildState = "running" | "completed" | "failed" | "stopped" | "timeout" | "killed";

type Child = {
  id: string;
  parent: string;
  proc: PiProc;
  file: string;
  agent: string;
  model: string;
  task: string;
  startedAt: number;
  stopReason: string | null;
  error: string | null;
  summary: string | null;
  stopped: ChildState | null;
  settle: (aborted: boolean) => void;
};

const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Host tools a child may have; AskUser, subagent, ScheduleWake, KeepWorking, Blocked, StartJob… never. */
const CHILD_HOST_TOOLS = ["Done", "Notify", "PdfRead", "WebSearch"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "Done", "Notify"];

const PREAMBLE = `You are a subagent: a helper that vault-chat's agent started for one task, in a context of your own.
You cannot ask Carl anything and nobody will answer questions: decide, and say what you assumed.
Work the task to the end, then reply with your report — your final message is exactly what the parent agent receives.
Never read, print or copy keys, tokens or the key store.`;

export class Subagents {
  private children = new Map<string, Child>();
  private files = new Map<string, string>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private seq = 0;

  constructor(
    private b: PiBackend,
    private o: SubagentOptions,
    private log: (s: string) => void,
  ) {}

  health(): Record<string, unknown> {
    return {
      running: this.active,
      max: this.o.hostMax,
      children: [...this.children.values()].map((c) => ({ id: c.id, parent: c.parent, pid: c.proc.pid, agent: c.agent, model: c.model, sinceMs: Date.now() - c.startedAt })),
    };
  }

  sessionFileOf(childId: string): string | null {
    const hit = this.files.get(childId);
    if (hit) return hit;
    // After a restart: sessions/sub/<parent>/<child dir>/<ts>_<id>.jsonl
    const root = join(this.b.paths.sessionsDir, "sub");
    try {
      for (const p of readdirSync(root))
        for (const d of readdirSync(join(root, p))) {
          const f = readdirSync(join(root, p, d)).find((n) => n.endsWith(`_${childId}.jsonl`));
          if (f) return join(root, p, d, f);
        }
    } catch {
      /* none */
    }
    return null;
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.o.hostMax) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }
  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  /** One child, start to report. Never throws. */
  async run(parentId: string, a: any): Promise<Record<string, unknown>> {
    await this.acquire();
    try {
      return await this.runOne(parentId, a);
    } catch (e) {
      return { ok: false, state: "failed", text: `The subagent could not start: ${(e as Error).message}` };
    } finally {
      this.release();
    }
  }

  private async runOne(parentId: string, a: any): Promise<Record<string, unknown>> {
    const agent = a?.agent ?? {};
    const task = String(a?.task ?? "").trim();
    if (!task) return { ok: false, state: "failed", text: "subagent needs a task." };
    const model = String(a?.model || agent.model || this.o.defaultModel || this.b.modelOf(parentId) || "openai/gpt-6.1-sol").replace(/^openrouter\//, "");
    const wanted: string[] = Array.isArray(agent.tools) && agent.tools.length ? agent.tools.map(String) : DEFAULT_TOOLS;
    const builtins = wanted.filter((t) => PI_BUILTINS.includes(t));
    const hostTools = wanted.filter((t) => CHILD_HOST_TOOLS.includes(t));
    let specs: ToolSpec[] = [];
    try {
      const f = this.b.toolsFileOf(parentId);
      specs = f ? (JSON.parse(readFileSync(f, "utf8")) as ToolSpec[]).filter((s) => hostTools.includes(s.name)) : [];
    } catch {
      specs = [];
    }
    const tools = this.b.writeTools(specs);
    const n = ++this.seq;
    const instr = join(this.b.paths.instrDir, `sub-${Date.now().toString(36)}-${n}.md`);
    writeFileSync(instr, `${PREAMBLE}\n\n${String(agent.systemPrompt ?? "").trim()}`);
    let parentCwd = process.cwd();
    try {
      parentCwd = JSON.parse(readFileSync(join(this.b.paths.instrDir, `${parentId}.json`), "utf8")).cwd ?? parentCwd;
    } catch {
      /* default */
    }
    const cwd = a?.cwd ? resolve(parentCwd, String(a.cwd)) : parentCwd;
    const sessionDir = join(this.b.paths.sessionsDir, "sub", parentId, `${Date.now().toString(36)}-${n}`);
    mkdirSync(sessionDir, { recursive: true });

    const { proc, id, file } = await this.b.spawn({ cwd, model, file: null, instr, tools, sessionDir, builtins: [...(builtins.length ? builtins : ["read"]), ...hostTools] }); // pi's --tools names every active tool, extension ones too
    let settled = false;
    let resolveDone!: (aborted: boolean) => void;
    const done = new Promise<boolean>((r) => (resolveDone = r));
    const child: Child = {
      id,
      parent: parentId,
      proc,
      file,
      agent: String(agent.name ?? "agent"),
      model,
      task,
      startedAt: Date.now(),
      stopReason: null,
      error: null,
      summary: null,
      stopped: null,
      settle: (aborted) => {
        if (settled) return;
        settled = true;
        resolveDone(aborted);
      },
    };
    this.children.set(id, child);
    this.files.set(id, file);
    this.b.ev({ kind: "subagents", threadId: parentId, itemId: `sub-${id}`, children: [id], op: "spawnAgent", prompt: task, model, done: false, ok: false });
    this.b.ev({ kind: "subagentStatus", threadId: parentId, child: id, status: "running", path: file, patch: { task: task.slice(0, 500), agent: child.agent, model, state: "running", startedAt: child.startedAt, sessionFile: file, costUsd: 0 } });

    proc.on("event", (e: any) => {
      // Any child activity keeps the parent's turn alive for the watchdog.
      this.b.ev({ kind: "tool", threadId: id, itemId: "child", name: "child", input: {} });
      if (e?.type === "message_end" && e.message?.role === "assistant") {
        child.stopReason = e.message.stopReason ?? null;
        child.error = e.message.stopReason === "error" ? String(e.message.errorMessage ?? "error").slice(0, 500) : null;
      } else if (e?.type === "agent_settled") child.settle(!!e.aborted);
    });
    proc.on("ui", (r: any) => void this.onChildUi(child, r));
    proc.on("exit", () => {
      if (!settled && !child.stopped) child.stopped = "killed";
      child.settle(true);
    });
    const timer = setTimeout(() => {
      this.log(`subagent ${id} hit its ${Math.round(this.o.timeoutMs / 1000)} s limit — stopping`);
      void this.stop(child, "timeout");
    }, this.o.timeoutMs);
    timer.unref?.();

    const r = await proc.request({ type: "prompt", message: `Task: ${task}` }, 60_000).catch((e) => ({ success: false, error: (e as Error).message }));
    if (!r?.success) {
      child.error = String(r?.error ?? "prompt rejected");
      child.settle(false);
    }
    await done;
    clearTimeout(timer);
    let text = "";
    if (proc.isAlive()) {
      const t = await proc.request({ type: "get_last_assistant_text" }, 15_000).catch(() => null);
      text = String(t?.data?.text ?? "");
    }
    await proc.close(this.o.graceMs);
    this.children.delete(id);

    const state: ChildState = child.stopped ?? (child.error ? "failed" : "completed");
    const costUsd = round(this.b.usageCalls(file).reduce((s, c) => s + (typeof c.cost === "number" ? c.cost : 0), 0));
    const report = text || child.summary || "";
    const ok = state === "completed";
    this.b.ev({ kind: "subagents", threadId: parentId, itemId: `sub-${id}`, children: [id], op: "spawnAgent", prompt: task, model, done: true, ok });
    this.b.ev({ kind: "subagentStatus", threadId: parentId, child: id, status: state, patch: { state, costUsd, endedAt: Date.now(), ...(child.summary ? { summary: child.summary.slice(0, 500) } : {}) } });
    this.log(`subagent ${id} (${child.agent}, ${model}) ${state}, $${costUsd}`);
    const failText = state === "timeout" ? "The subagent ran out of time and was stopped." : state === "stopped" ? "The subagent was stopped." : state === "killed" ? "The subagent's process ended unexpectedly." : child.error ?? "";
    return { ok, state, text: ok ? report || "(no output)" : [failText, report].filter(Boolean).join("\n\n"), childId: id, model, costUsd, sessionFile: file };
  }

  /** A child's host calls: Done is noted for its report; Notify/PdfRead/WebSearch run as the parent's; nothing else. */
  private async onChildUi(c: Child, req: any): Promise<void> {
    const reply = (o: Record<string, unknown>) => c.proc.write({ type: "extension_ui_response", id: req.id, ...o });
    if (req.method === "editor" && req.title === "vc:host-call") {
      let call: any = {};
      try {
        call = JSON.parse(String(req.prefill ?? "{}"));
      } catch {
        return reply({ value: JSON.stringify({ text: "bad host call", isError: true }) });
      }
      const name = String(call.tool ?? "");
      if (name === "Done") {
        c.summary = String(call.args?.summary ?? "").trim() || null;
        return reply({ value: JSON.stringify({ text: "Recorded. Now end with your report: your final message is what the parent agent receives." }) });
      }
      if (!CHILD_HOST_TOOLS.includes(name) || !this.b.handlers) return reply({ value: JSON.stringify({ text: `${name} is not available to subagents; report to the parent agent instead.`, isError: true }) });
      const r = await this.b.handlers.toolCall(c.parent, name, call.args ?? {}).catch((e) => ({ ok: false, text: `${name} failed: ${(e as Error).message}` }));
      return reply({ value: JSON.stringify({ text: r.text, ...(r.ok ? {} : { isError: true }) }) });
    }
    if (["select", "confirm", "input", "editor"].includes(req.method)) return reply({ cancelled: true });
  }

  /** Abort the child's turn; SIGKILL its group if it is still there after the grace period (or at once when `hard`). */
  async stop(c: Child, why: ChildState, hard = false): Promise<void> {
    if (!c.stopped) c.stopped = why;
    if (hard) {
      c.proc.killGroup("SIGKILL");
      return;
    }
    const killer = setTimeout(() => c.proc.killGroup("SIGKILL"), this.o.graceMs);
    killer.unref?.();
    await c.proc.request({ type: "abort" }, this.o.graceMs).catch(() => c.proc.killGroup("SIGKILL"));
    c.settle(true);
  }

  stopAll(parentId: string, reason: string, hard: boolean): void {
    for (const c of [...this.children.values()]) {
      if (c.parent !== parentId) continue;
      this.log(`subagent ${c.id}: ${reason}`);
      void this.stop(c, hard ? "killed" : "stopped", hard);
    }
  }

  async control(childId: string, op: "steer" | "stop", text?: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.children.get(childId);
    if (!c) return { ok: false, error: "that subagent is not running" };
    if (op === "stop") {
      await this.stop(c, "stopped");
      return { ok: true };
    }
    const t = String(text ?? "").trim();
    if (!t) return { ok: false, error: "steer needs text" };
    const r = await c.proc.request({ type: "steer", message: t }, 30_000).catch((e) => ({ success: false, error: (e as Error).message }));
    return r?.success ? { ok: true } : { ok: false, error: String(r?.error ?? "steer rejected") };
  }

  /** Child ids of a parent thread (running now). */
  childrenOf(parentId: string): string[] {
    return [...this.children.values()].filter((c) => c.parent === parentId).map((c) => c.id);
  }
}

function round(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
