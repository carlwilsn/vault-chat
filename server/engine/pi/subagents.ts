// Subagents: a parent pi's native MCP `subagent` tool (mcp/subagent.ts,
// adapted from pi's example) asks the host, per child; the host
// starts the child here as a SIBLING of the parent — the same launch as any pi
// (its own bubblewrap, pid namespace and process group, the key on its own fd,
// scrubbed env, path guard), in RPC mode so it can be steered and stopped, on a
// persisted session of its own under sessions/sub/<parent session>/. A child
// gets file/shell tools plus Notify (an agent may allow PdfRead/WebSearch)
// and never AskUser: it reports to the parent, which decides what reaches Carl.
// Its OpenRouter cost (the vc-cost entries in its session) is rolled onto the
// parent conversation by the engine (childUsageCalls) and summed into
// subagents[] on the meta. A parent that stops or dies takes its children down.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostToolName } from "../../../src/mcpNames";
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
  stopped: ChildState | null;
  /** Started in the background (Delegate, BoardMake) or moved there (detach): outlives the parent's turn (only the
   *  parent's process ending stops it). */
  background: boolean;
  settle: (aborted: boolean) => void;
  /** Resolves when the child's run settles (true: aborted). */
  done: Promise<boolean>;
  timer: NodeJS.Timeout | null;
  /** The parent's call that carries it (its toolCallId), for its row. */
  itemId: string;
  /** What Carl reads in its row: Delegate's title, else the task's first words. */
  title: string;
  /** What it is doing now, from its own pi events: its latest tool and target, tool calls done, its latest words. */
  activity: string;
  steps: number;
  said: string;
  /** A blocking `subagent` call that Carl talked over: the parent's call answers at once, the report comes later. */
  detach: () => void;
  detached: Promise<void>;
  /** Its report, once it ends. */
  result: Promise<Record<string, unknown>> | null;
};

/** A child moved to the background: its id, title and the report it will give. */
export type Detached = { id: string; title: string; result: Promise<Record<string, unknown>> };

/** A running child as the agent's JobList / JobStatus read it. */
export type LiveChild = { id: string; parent: string; title: string; activity: string; steps: number; said: string; startedAt: number; background: boolean };

/** A child's latest tool call in a few words ("writing physics.html", "running npm test"), from pi's tool_execution_start. */
export function activityOf(tool: string, args: any): string {
  const base = (p: unknown) => String(p ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  const one = (v: unknown, n = 60) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const path = base(args?.path ?? args?.file_path);
  switch (hostToolName(tool)) {
    case "write":
      return path ? `writing ${path}` : "writing a file";
    case "edit":
      return path ? `editing ${path}` : "editing a file";
    case "read":
    case "PdfRead":
      return path ? `reading ${path}` : "reading";
    case "bash":
      return args?.command ? `running ${one(args.command)}` : "running a command";
    case "grep":
      return args?.pattern ? `searching for ${one(args.pattern, 40)}` : "searching";
    case "find":
    case "ls":
      return "looking through files";
    case "WebSearch":
      return args?.query ? `searching the web for ${one(args.query, 40)}` : "searching the web";
    case "BoardSend":
      return "sending to the whiteboard";
    case "Notify":
      return "notifying Carl";
    default:
      return tool;
  }
}

/** An assistant message's text, its last non-empty line, short (a child's latest words in its row). */
function lastWords(m: any): string {
  const t = (Array.isArray(m?.content) ? m.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
  const line = t.split("\n").map((l: string) => l.trim()).filter(Boolean).pop() ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** A task's first words, for a row with no title. */
function firstWords(task: string): string {
  const t = task.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Host tools a child may have; AskUser, subagent, ScheduleWake, StartJob… never. */
const CHILD_HOST_TOOLS = ["Notify", "PdfRead", "WebSearch", "BoardSend"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "Notify"];

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

  /** One child, start to report. Never throws. A child moved to the background while it runs (detach) answers at
   *  once with a line saying so; its report then comes through detach's `result`. */
  async run(parentId: string, a: any, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    await this.acquire();
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.release();
    };
    try {
      signal?.throwIfAborted();
      const c = await this.startOne(parentId, a);
      if (!isChild(c)) {
        release();
        return c;
      }
      const cancel = () => { void this.stop(c, "stopped"); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const result = this.finishOne(c).finally(() => { signal?.removeEventListener("abort", cancel); release(); });
      c.result = result;
      const first = await Promise.race([result, c.detached.then(() => null)]);
      if (first) return first;
      const chain = a?.mode === "chain";
      return {
        ok: !chain,
        state: "background",
        childId: c.id,
        text: `Carl wrote while this subagent ran, so it moved to the background and keeps working${chain ? " (the chain stopped here: its later steps did not run)" : ""}. Its report comes back to you as a new turn ("Delegated work finished: …"). Answer Carl now; don't wait for it and don't start it again.`,
      };
    } catch (e) {
      release();
      return { ok: false, state: "failed", text: `The subagent could not start: ${(e as Error).message}` };
    }
  }

  /** Carl wrote while the parent's `subagent` call was waiting: its running children move to the background (each
   *  parent call answers at once, each child keeps working); their reports arrive through `result`. */
  detach(parentId: string): Detached[] {
    const out: Detached[] = [];
    for (const c of this.children.values()) {
      if (c.parent !== parentId || c.background || c.stopped || !c.result) continue;
      c.background = true;
      this.b.ev({ kind: "subagentStatus", threadId: parentId, child: c.id, status: "running", patch: { background: true } });
      this.log(`subagent ${c.id} moved to the background (Carl wrote)`);
      c.detach();
      out.push({ id: c.id, title: c.title, result: c.result });
    }
    return out;
  }

  /** A running child (JobList / JobStatus), or null. */
  live(childId: string): LiveChild | null {
    const c = this.children.get(childId);
    return c ? { id: c.id, parent: c.parent, title: c.title, activity: c.activity, steps: c.steps, said: c.said, startedAt: c.startedAt, background: c.background } : null;
  }

  /** The running children of a parent thread (JobList). */
  liveOf(parentId: string): LiveChild[] {
    return [...this.children.values()].filter((c) => c.parent === parentId).map((c) => this.live(c.id)!);
  }

  private async startOne(parentId: string, a: any): Promise<Child | Record<string, unknown>> {
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

    const { proc, id, file } = await this.b.spawn({
      cwd, model, file: null, instr, tools, sessionDir,
      builtins: [...(builtins.length ? builtins : ["read"]), ...hostTools],
      hostCall: async (name, args, context) => this.b.handlers ? this.b.handlers.toolCall(parentId, name, args, context.signal) : { ok: false, text: "Parent unavailable." },
      services: {
        ...(builtins.includes("bash") ? { env: () => this.b.agentEnv() } : {}),
        fileWrite: async () => builtins.includes("write") || builtins.includes("edit"),
      },
    });
    let settled = false;
    let resolveDone!: (aborted: boolean) => void;
    const done = new Promise<boolean>((r) => (resolveDone = r));
    let detachNow!: () => void;
    const detached = new Promise<void>((r) => (detachNow = r));
    // A worker owns its task row. No model/MCP call-id correlation or newest-call fallback.
    const itemId = `sub-${id}`;
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
      stopped: null,
      background: a?.background === true,
      settle: (aborted) => {
        if (settled) return;
        settled = true;
        resolveDone(aborted);
      },
      done,
      timer: null,
      itemId,
      title: String(a?.title ?? "").trim().slice(0, 120) || firstWords(task),
      activity: "starting",
      steps: 0,
      said: "",
      detach: () => detachNow(),
      detached,
      result: null,
    };
    this.children.set(id, child);
    this.files.set(id, file);
    this.b.ev({ kind: "subagents", threadId: parentId, itemId, children: [id], op: "spawnAgent", prompt: task, model, done: false, ok: false });
    this.b.ev({ kind: "subagentStatus", threadId: parentId, child: id, status: "running", path: file, patch: { task: task.slice(0, 500), title: child.title, ...(a?.expect === "short" || a?.expect === "long" ? { expect: a.expect } : {}), ...(child.background ? { background: true } : {}), agent: child.agent, model, state: "running", startedAt: child.startedAt, sessionFile: file, costUsd: 0 } });

    // What it is doing, from its own pi events, onto its row: at most one update a second, the newest always lands.
    let lastPush = 0;
    let pushTimer: NodeJS.Timeout | null = null;
    const push = () => {
      pushTimer = null;
      lastPush = Date.now();
      if (settled) return;
      this.b.ev({ kind: "subagentStatus", threadId: parentId, child: id, status: "running", patch: { activity: child.activity, steps: child.steps, ...(child.said ? { said: child.said } : {}), activityAt: lastPush } });
    };
    const changed = () => {
      if (pushTimer) return;
      pushTimer = setTimeout(push, Math.max(0, 1000 - (Date.now() - lastPush)));
      pushTimer.unref?.();
    };
    const writes = new Map<string, Record<string, unknown>>();
    proc.on("event", (e: any) => {
      if (e?.type === "message_end" && e.message?.role === "assistant") {
        child.stopReason = e.message.stopReason ?? null;
        child.error = e.message.stopReason === "error" ? String(e.message.errorMessage ?? "error").slice(0, 500) : null;
        const words = lastWords(e.message);
        if (words) {
          child.said = words;
          changed();
        }
      } else if (e?.type === "tool_execution_start") {
        child.activity = activityOf(String(e.toolName ?? "tool"), e.args ?? {});
        if (e.toolName === "write" || e.toolName === "edit") writes.set(String(e.toolCallId ?? ""), e.args ?? {});
        changed();
      } else if (e?.type === "tool_execution_end") {
        child.steps++;
        // A worker's file edit reaches the screens showing that file at once, as the agent's own does (it waited for
        // the next sync: the roleplay's delegated LaTeX edit landed on the box and the open pane kept the old text).
        const w = writes.get(String(e.toolCallId ?? ""));
        writes.delete(String(e.toolCallId ?? ""));
        if (w && !e.isError) this.b.handlers?.childWrote?.(child.parent, w);
        changed();
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
    child.timer = timer;

    const r = await proc.request({ type: "prompt", message: `Task: ${task}` }, 60_000).catch((e) => ({ success: false, error: (e as Error).message }));
    if (!r?.success) {
      child.error = String(r?.error ?? "prompt rejected");
      child.settle(false);
    }
    return child;
  }

  /** A started child, to its report. */
  private async finishOne(child: Child): Promise<Record<string, unknown>> {
    const { proc, id, file, task, model, itemId } = child;
    const parentId = child.parent;
    await child.done;
    if (child.timer) clearTimeout(child.timer);
    let text = "";
    if (proc.isAlive()) {
      const t = await proc.request({ type: "get_last_assistant_text" }, 15_000).catch(() => null);
      text = String(t?.data?.text ?? "");
    }
    await proc.close(this.o.graceMs);
    this.children.delete(id);

    const state: ChildState = child.stopped ?? (child.error ? "failed" : "completed");
    const costUsd = round(this.b.usageCalls(file).reduce((s, c) => s + (typeof c.cost === "number" ? c.cost : 0), 0));
    const report = text || "";
    const ok = state === "completed";
    this.b.ev({ kind: "subagents", threadId: parentId, itemId, children: [id], op: "spawnAgent", prompt: task, model, done: true, ok });
    this.b.ev({ kind: "subagentStatus", threadId: parentId, child: id, status: state, patch: { state, costUsd, steps: child.steps, endedAt: Date.now(), ...(report ? { summary: report.slice(0, 500) } : {}) } });
    this.log(`subagent ${id} (${child.agent}, ${model}) ${state}, $${costUsd}`);
    const failText = state === "timeout" ? "The subagent ran out of time and was stopped." : state === "stopped" ? "The subagent was stopped." : state === "killed" ? "The subagent's process ended unexpectedly." : child.error ?? "";
    return { ok, state, text: ok ? report || "(no output)" : [failText, report].filter(Boolean).join("\n\n"), childId: id, model, costUsd, sessionFile: file };
  }

  /** A child's tool capability is fixed at spawn; interactive UI is unavailable. */
  private async onChildUi(c: Child, req: any): Promise<void> {
    const reply = (o: Record<string, unknown>) => c.proc.write({ type: "extension_ui_response", id: req.id, ...o });
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
      if (c.background && !hard) continue; // a make keeps going when Carl stops a later turn
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

function isChild(c: Child | Record<string, unknown>): c is Child {
  return typeof (c as Child).detach === "function";
}
