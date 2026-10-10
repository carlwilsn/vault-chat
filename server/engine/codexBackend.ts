// EngineBackend on Codex 0.162.1's app-server: the supervised child
// (appServer.ts), its JSON-RPC methods, and the mapping of its items and
// server requests to neutral events and handler calls.
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexSupervisor } from "./appServer";
import type { BackendEvent, EngineBackend, ToolCallHandler, ToolSpec, UserInputHandler } from "./backend";
import { codexLimits } from "./catalog";
import { rolloutCalls, type CallRecord } from "./ledger";

const RESULT_CAP = 4_000;
const cap = (s: string, n = RESULT_CAP) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);

export class CodexBackend extends EventEmitter implements EngineBackend {
  readonly name = "codex";
  private loaded = new Set<string>();
  private h: { toolCall: ToolCallHandler; userInput: UserInputHandler } | null = null;

  constructor(
    private sup: CodexSupervisor,
    readonly version: string,
    private o: { codexHome: string; permissions: string | null },
  ) {
    super();
    this.setMaxListeners(50);
    sup.on("notification", (m: any) => this.onNotification(m));
    sup.on("up", () => {
      this.loaded.clear();
      this.emit("up");
    });
    sup.on("down", () => this.emit("down"));
  }

  start(): void {
    this.sup.start();
  }
  ready(ms: number): Promise<boolean> {
    return this.sup.ready(ms);
  }
  health(): Record<string, unknown> {
    return { ...this.sup.health };
  }
  killHard(): number | null {
    return this.sup.killHard();
  }
  setHandlers(h: { toolCall: ToolCallHandler; userInput: UserInputHandler }): void {
    this.h = h;
  }

  private perms(): Record<string, unknown> {
    return this.o.permissions ? { permissions: this.o.permissions } : { sandbox: "danger-full-access" };
  }

  async startThread(o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean }): Promise<{ threadId: string; ref?: string }> {
    const r: any = await this.sup.request("thread/start", {
      cwd: o.cwd,
      model: o.model,
      modelProvider: "openrouter",
      approvalPolicy: "never",
      ...this.perms(),
      developerInstructions: o.instructions,
      dynamicTools: o.tools,
      // Subagents (multi_agent) per thread; a thread keeps them for life.
      config: { ...codexLimits(o.model), features: { multi_agent: o.subagents } },
    }, 60_000);
    const threadId: string = r?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.loaded.add(threadId);
    return { threadId, ref: r?.thread?.path ?? undefined };
  }

  async resumeThread(threadId: string, o: { model: string; subagents: boolean }): Promise<void> {
    if (this.loaded.has(threadId)) return;
    await this.sup.request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...(this.o.permissions ? { permissions: this.o.permissions } : {}),
      config: { ...codexLimits(o.model), features: { multi_agent: o.subagents } },
    }, 60_000);
    this.loaded.add(threadId);
  }

  private input(texts: string[], images: string[]): any[] {
    return [...texts.filter(Boolean).map((text) => ({ type: "text", text, text_elements: [] })), ...images.map((path) => ({ type: "localImage", path }))];
  }

  async startTurn(threadId: string, o: { texts: string[]; images: string[]; model: string }): Promise<{ turnId: string | null }> {
    const r: any = await this.sup.request("turn/start", { threadId, input: this.input(o.texts, o.images), model: o.model }, 60_000);
    return { turnId: r?.turn?.id ?? null };
  }

  async steer(threadId: string, turnId: string, o: { texts: string[]; images: string[] }): Promise<void> {
    await this.sup.request("turn/steer", { threadId, expectedTurnId: turnId, input: this.input(o.texts, o.images) });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.sup.request("turn/interrupt", { threadId, turnId }, 30_000);
  }

  forget(threadId: string): void {
    this.loaded.delete(threadId);
  }

  usageCalls(ref: string | undefined, turnId?: string | null): CallRecord[] {
    return ref ? rolloutCalls(ref, turnId ?? undefined) : [];
  }

  childUsageCalls(threadId: string): CallRecord[] {
    const f = findRollout(join(this.o.codexHome, "sessions"), threadId);
    return f ? rolloutCalls(f) : [];
  }

  /** Server → client requests (a turn waits on every one of them). */
  async onServerRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "item/tool/call": {
        if (!this.h) return { success: false, contentItems: [{ type: "inputText", text: "engine not ready" }] };
        const r = await this.h.toolCall(String(params?.threadId ?? ""), String(params?.tool ?? ""), params?.arguments ?? {});
        return { success: r.ok, contentItems: [{ type: "inputText", text: r.text }] };
      }
      case "item/tool/requestUserInput": {
        const qs: any[] = Array.isArray(params?.questions) ? params.questions : [];
        const q = qs.map((x) => x?.question).filter(Boolean).join("\n") || "Question";
        const opts = (qs[0]?.options ?? []).map((x: any) => String(x?.label ?? "")).filter(Boolean);
        const answer = this.h ? await this.h.userInput(String(params?.threadId ?? ""), q, opts) : "No one is available to answer.";
        const answers: Record<string, { answers: string[] }> = {};
        for (const x of qs) answers[x.id] = { answers: [answer] };
        return { answers };
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "accept" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "mcpServer/elicitation/request":
        return { action: "decline" };
      case "currentTime/read":
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      default:
        return {};
    }
  }

  private ev(e: BackendEvent): void {
    this.emit("event", e);
  }

  private onNotification(m: { method: string; params: any }): void {
    const p = m.params ?? {};
    const threadId = String(p.threadId ?? "");
    if (!threadId) return;
    switch (m.method) {
      case "turn/started":
        if (p.turn?.id) this.ev({ kind: "turnStarted", threadId, turnId: p.turn.id });
        return;
      case "item/agentMessage/delta":
        return this.ev({ kind: "textDelta", threadId, itemId: String(p.itemId ?? "msg"), delta: String(p.delta ?? "") });
      case "thread/tokenUsage/updated":
        if (p.tokenUsage) this.ev({ kind: "usage", threadId, usage: p.tokenUsage });
        return;
      case "turn/completed": {
        const e = p.turn?.error;
        const err = e ? (typeof e === "string" ? e : String(e.message ?? e.codexErrorInfo ?? JSON.stringify(e))).slice(0, 500) : null;
        return this.ev({ kind: "turnCompleted", threadId, turnId: p.turn?.id ?? null, status: String(p.turn?.status ?? "completed"), error: err });
      }
      case "item/started":
      case "item/completed":
        return this.onItem(threadId, p.item ?? {}, m.method === "item/completed");
      default:
        return;
    }
  }

  private onItem(threadId: string, it: any, done: boolean): void {
    const tool = (name: string, input: unknown, result?: string) => this.ev({ kind: "tool", threadId, itemId: String(it.id), name, input, result });
    switch (it.type) {
      case "agentMessage":
        if (done || typeof it.text === "string") this.ev({ kind: "text", threadId, itemId: String(it.id), text: String(it.text ?? "") });
        return;
      case "reasoning": {
        if (!done) return;
        const s = [...(it.summary ?? []), ...(it.summary?.length ? [] : it.content ?? [])].join("\n").trim();
        if (s) this.ev({ kind: "reasoning", threadId, text: s });
        return;
      }
      case "commandExecution":
        return tool(
          "Bash",
          { command: it.commandActions?.[0]?.command ?? it.command },
          done ? cap(String(it.aggregatedOutput ?? "")) + (it.exitCode != null && it.exitCode !== 0 ? `\n[exit ${it.exitCode}]` : "") : undefined,
        );
      case "fileChange": {
        const ch = (it.changes ?? [])[0] ?? {};
        return tool(ch.kind?.type === "add" ? "Write" : "Edit", { file_path: ch.path, changes: (it.changes ?? []).length }, done ? cap(String(ch.diff ?? "")) : undefined);
      }
      case "dynamicToolCall":
        return tool(String(it.tool ?? "tool"), it.arguments ?? {}, done ? cap((it.contentItems ?? []).map((c: any) => c?.text ?? "").join("\n")) : undefined);
      case "webSearch":
        return tool("WebSearch", it.query ?? {});
      case "mcpToolCall":
        return tool(String(it.tool ?? "mcp"), it.arguments ?? {});
      case "contextCompaction":
        if (done) tool("Compaction", {}, "context compacted");
        return;
      case "collabAgentToolCall":
        return this.ev({
          kind: "subagents",
          threadId,
          itemId: String(it.id),
          children: Array.isArray(it.receiverThreadIds) ? it.receiverThreadIds : [],
          op: String(it.tool ?? ""),
          prompt: it.prompt ?? undefined,
          model: it.model ?? null,
          done,
          ok: String(it.status ?? "") === "completed",
        });
      case "subAgentActivity":
        if (it.agentThreadId) this.ev({ kind: "subagentStatus", threadId, child: it.agentThreadId, status: String(it.kind ?? "") === "completed" ? "completed" : "running", path: it.agentPath });
        return;
      default:
        return;
    }
  }
}

/** The rollout file of a thread: sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl */
export function findRollout(dir: string, threadId: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names.sort().reverse()) {
    const p = join(dir, n);
    if (n.endsWith(".jsonl")) {
      if (n.includes(threadId)) return p;
      continue;
    }
    if (/^\d+$/.test(n)) {
      const hit = findRollout(p, threadId);
      if (hit) return hit;
    }
  }
  return null;
}
