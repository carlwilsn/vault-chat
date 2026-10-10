// The engine: every agent turn on the box runs in Codex. A conversation maps to
// one Codex thread (a new one after a roll-over); each turn's streamed items
// become the existing message shapes in the conversation file, and the live
// run is mirrored into the store so the phone host emits the /poll events the
// phone already renders. vault-chat's own tools reach Codex as dynamicTools.
import { existsSync, statSync } from "node:fs";
import type { ChatMessage } from "../../src/store";
import { registerRun, unregisterRun } from "../../src/runRegistry";
import type { CodexSupervisor } from "./appServer";
import {
  contextToolSpecs,
  handleContextTool,
  isContextTool,
  buildDeveloperInstructions,
  rulesPrefixForTurn,
  shouldRoll,
  buildRecap,
  verifyDone,
  formatVerdict,
  projectCost,
  type EngineConv,
  type ThreadTokenUsage,
} from "./context";
import { codexLimits } from "./catalog";
import { appendMessage, patchMeta, readConv, allConvs, createConv, mutateConv, setLive, setRuntime, newMessageId } from "./convs";
import { addWake, readWakes, removeWakes, nextWakeFor, parseDelay, type Wake } from "./wakes";
import { Ledger, rolloutCalls } from "./ledger";
import { pdfRead, webSearch, startJob, jobStatus, type JobEnv } from "./extraTools";
import { ENGINE_ROLE_PROMPT } from "./prompt";

export type EngineDeps = {
  vault: string;
  sup: CodexSupervisor;
  ledger: Ledger;
  jobEnv: JobEnv;
  model: () => string;
  webSearchModel: string;
  apiKey: () => string | null;
  /** Web Push + notifications.jsonl + the /poll "notif" event. */
  notify: (n: { kind: "info" | "ask"; title: string; body: string; convId: string; options?: string[] }) => Promise<string | null>;
  /** One-line log. */
  log?: (s: string) => void;
  stallMs?: number;
  /** Linux: run tool shells under the `vc` permission profile. */
  permissions?: string | null;
};

type ToolRec = { id?: string; name: string; input: any; result?: string };
type TurnKind = "user" | "wake" | "nudge" | "resume";

type Live = {
  convId: string;
  threadId: string;
  turnId: string | null;
  kind: TurnKind;
  startedAt: number;
  lastEventAt: number;
  order: string[];
  texts: Map<string, string>;
  tools: ToolRec[];
  toolIndex: Map<string, number>;
  reasoning: string[];
  usage: ThreadTokenUsage | null;
  flags: { wake: boolean; done: boolean; blocked: boolean };
  ask: { resolve: (answer: string) => void; question: string } | null;
  cut: boolean;
  stalled: boolean;
  stopped: boolean;
  controller: AbortController;
  finished: boolean;
};

const MSG_CAP = 20_000;
const RESULT_CAP = 4_000;
const NUDGE_TEXT = "You're in keep-going mode: schedule your next check (ScheduleWake), or say Done or Blocked.";
const RESUME_TEXT =
  "The box restarted (or the engine stopped) while your last turn was running, so any command it was running was killed and may not have finished. Re-check reality (files, processes, logs), then continue from where you were.";
const LEGACY_SOURCES = new Set(["mission", "worker", "ask"]);

export const ENGINE_TOOL_SPECS = [
  {
    type: "function",
    name: "AskUser",
    description:
      "Ask Carl a question and wait for his answer (he gets a push on his phone). Only when stuck, for anything irreversible or that spends money, for matters of taste, or when he asked to be consulted. Give 2-4 short options when they help.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ScheduleWake",
    description:
      "Schedule ONE future turn of this conversation (survives restarts). Give `in` (e.g. \"2m\", \"1h30m\") or `at` (ISO time), and the reason you will read when woken. Then end your turn.",
    inputSchema: {
      type: "object",
      properties: { in: { type: "string" }, at: { type: "string" }, reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "KeepWorking",
    description: "Turn keep-going mode on or off for this conversation. On: every turn must end with ScheduleWake, AskUser, Done or Blocked.",
    inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
  },
  {
    type: "function",
    name: "Done",
    description: "Declare the work done, with a summary and the evidence (file paths, quoted command outputs). A separate verifier checks it; its verdict is returned and shown to Carl.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Blocked",
    description: "Say you cannot continue without Carl, and why. Ends keep-going work and pushes him.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
  },
  {
    type: "function",
    name: "Notify",
    description: "Send Carl a push notification (for news he should see now, not for questions).",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "PdfRead",
    description: "Read text from a PDF: the page count plus the pages asked for (default 1-3), capped at maxChars (default 12000). Use page ranges; never read a whole long PDF at once.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, pages: { type: "string", description: "e.g. \"1\", \"4-8\", \"1,3,7-9\"" }, maxChars: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "WebSearch",
    description: "Search the web; returns a short answer with source URLs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    type: "function",
    name: "StartJob",
    description:
      "Start a long-running shell command that must outlive this turn (training, downloads, builds). It runs detached, sandboxed, in the vault; output goes to a log. Returns a job id for JobStatus.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, name: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "JobStatus",
    description: "State and last output lines of a job started with StartJob.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, tail: { type: "number" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "Cost",
    description: "Model spend in USD: this conversation by default, or a project's total.",
    inputSchema: {
      type: "object",
      properties: { conversation: { type: "string" }, project: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const text = (t: string) => ({ success: true, contentItems: [{ type: "inputText", text: t }] });

export class Engine {
  private live = new Map<string, Live>(); // convId → live turn
  private byThread = new Map<string, string>(); // threadId → convId
  private loaded = new Set<string>(); // threads loaded in the current app-server process
  private chains = new Map<string, Promise<unknown>>();
  private nudged = new Set<string>();
  private resumeQueue = new Set<string>();
  private firstUp = true;
  private timers: NodeJS.Timeout[] = [];
  private firing = new Set<string>();

  constructor(private d: EngineDeps) {}

  private log(s: string): void {
    (this.d.log ?? ((m) => console.log(`[engine] ${m}`)))(s);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.d.sup.on("notification", (m: any) => this.onNotification(m));
    this.d.sup.on("down", () => this.onDown());
    this.d.sup.on("up", () => void this.onUp());
    this.timers.push(setInterval(() => void this.tickWakes(), 2_000));
    this.timers.push(setInterval(() => this.tickWatchdog(), 15_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  health(): Record<string, unknown> {
    return {
      codex: { ...this.d.sup.health },
      liveTurns: [...this.live.values()].map((l) => ({ convId: l.convId, kind: l.kind, waitingUser: !!l.ask, sinceMs: Date.now() - l.startedAt })),
      wakes: readWakes(this.d.vault).length,
    };
  }

  isRunning(convId: string): boolean {
    const l = this.live.get(convId);
    return !!l && !l.ask;
  }

  /** Server request handler for the supervisor. */
  async onServerRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "item/tool/call":
        return this.onToolCall(params);
      case "item/tool/requestUserInput": {
        const qs: any[] = Array.isArray(params?.questions) ? params.questions : [];
        const q = qs.map((x) => x?.question).filter(Boolean).join("\n") || "Question";
        const opts = (qs[0]?.options ?? []).map((o: any) => String(o?.label ?? "")).filter(Boolean);
        const answer = await this.waitForAnswer(params?.threadId, q, opts);
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

  private async onUp(): Promise<void> {
    this.loaded.clear();
    if (this.firstUp) {
      this.firstUp = false;
      // A turn cut by a crash or restart of the whole server: the file still
      // says running. Mark it, then resume it.
      for (const c of await allConvs(this.d.vault).catch(() => [])) {
        if (c.state === "running" && c.codexThreadId && !this.live.has(c.id)) {
          await appendMessage(this.d.vault, c.id, {
            role: "assistant",
            content: "⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.",
            failed: true,
          });
          this.resumeQueue.add(c.id);
        }
      }
    }
    const q = [...this.resumeQueue];
    this.resumeQueue.clear();
    for (const id of q) void this.run(id, RESUME_TEXT, "resume").catch((e) => this.log(`resume ${id} failed: ${e}`));
  }

  private onDown(): void {
    // In-flight tool work died with the app-server. Close each turn as cut and
    // resume it when Codex is back. A turn parked on a question keeps its
    // question (persisted); the answer starts a new turn.
    for (const l of [...this.live.values()]) {
      if (l.ask) {
        this.live.delete(l.convId);
        unregisterRun(l.convId, l.controller);
        continue;
      }
      l.cut = true;
      this.resumeQueue.add(l.convId);
      void this.finishTurn(l, "interrupted", null);
    }
  }

  // ---------------------------------------------------------------- inbound

  /** /message. Returns null when the conversation is a legacy mission thread (old path). */
  async message(body: { convId?: string | null; text?: string; project?: string }): Promise<Record<string, unknown> | null> {
    const textIn = String(body?.text ?? "").trim();
    if (!textIn) return { error: "empty message" };
    let conv: EngineConv | null = null;
    if (body.convId) {
      conv = await readConv(this.d.vault, body.convId);
      if (!conv) return { error: `conversation ${body.convId} not found` };
      if (LEGACY_SOURCES.has(conv.source)) return null;
    } else {
      conv = await createConv(this.d.vault, { project: body.project || undefined }, textIn);
    }
    const id = conv.id;
    this.nudged.delete(id);
    // An open question: this message is the answer.
    if (this.live.get(id)?.ask || conv.pendingAsk) {
      await this.answer(id, textIn);
      return { ok: true, convId: id, answered: true };
    }
    // A running turn: steer it.
    const l = this.live.get(id);
    if (l && l.turnId && !l.finished) {
      await appendMessage(this.d.vault, id, { role: "user", content: textIn, direct: true });
      try {
        await this.d.sup.request("turn/steer", {
          threadId: l.threadId,
          expectedTurnId: l.turnId,
          input: [{ type: "text", text: textIn, text_elements: [] }],
        });
        return { ok: true, convId: id, steered: true };
      } catch (e) {
        this.log(`steer failed (${(e as Error).message}); starting a new turn`);
        void this.run(id, textIn, "user", { alreadyAppended: true });
        return { ok: true, convId: id };
      }
    }
    void this.run(id, textIn, "user").catch((e) => this.log(`turn failed: ${e}`));
    return { ok: true, convId: id };
  }

  /** /answer. null → legacy path. */
  async answerRoute(body: { convId?: string; text?: string; defer?: boolean }): Promise<Record<string, unknown> | null> {
    const id = String(body?.convId ?? "");
    if (!id) return null;
    const conv = await readConv(this.d.vault, id);
    if (!conv || LEGACY_SOURCES.has(conv.source)) return null;
    const t = body.defer
      ? "Not now — I'm not picking an option. Take the default you named if there is a safe one; otherwise hold, and don't do anything irreversible or that spends money."
      : String(body?.text ?? "").trim();
    if (!t) return { error: "answer needs a convId and non-empty text" };
    if (!this.live.get(id)?.ask && !conv.pendingAsk) {
      // No open question (already answered elsewhere): a plain message.
      return (await this.message({ convId: id, text: t })) ?? { ok: true, convId: id };
    }
    await this.answer(id, t);
    return { ok: true, convId: id, answered: true };
  }

  /** /kill. null → legacy path. Stop means stop: interrupt, keep-going off, wakes cancelled. */
  async kill(body: { convId?: string | null }): Promise<Record<string, unknown> | null> {
    const id = body?.convId ? String(body.convId) : "";
    if (!id) {
      let n = 0;
      for (const l of [...this.live.values()]) if (await this.interrupt(l.convId, true)) n++;
      return n ? { ok: true, result: `Stopped ${n} run(s).` } : null;
    }
    const conv = await readConv(this.d.vault, id);
    if (!conv || LEGACY_SOURCES.has(conv.source)) return null;
    const hit = await this.interrupt(id, true);
    return { ok: true, result: hit ? "Stopped — interrupting now (an in-flight command is killed)." : "Nothing running on that thread." };
  }

  async interrupt(convId: string, byUser: boolean): Promise<boolean> {
    if (byUser) {
      removeWakes(this.d.vault, (w) => w.conv === convId);
      await patchMeta(this.d.vault, convId, { working: false, nextWakeAt: undefined });
    }
    const l = this.live.get(convId);
    if (!l) return false;
    if (l.ask) {
      // Parked on a question: release the call so the turn can close.
      l.stopped = true;
      const a = l.ask;
      l.ask = null;
      await patchMeta(this.d.vault, convId, { pendingAsk: undefined });
      a.resolve("Carl stopped this turn instead of answering. End the turn now; do nothing else.");
    }
    l.stopped = byUser || l.stopped;
    if (!l.turnId) return true;
    try {
      await this.d.sup.request("turn/interrupt", { threadId: l.threadId, turnId: l.turnId }, 30_000);
    } catch (e) {
      this.log(`interrupt failed: ${(e as Error).message}`);
    }
    return true;
  }

  // ---------------------------------------------------------------- turns

  private serial<T>(convId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(convId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(convId, next.catch(() => undefined));
    return next;
  }

  /** Start a turn (or, if one is running, steer the input into it). */
  run(convId: string, input: string, kind: TurnKind, opts: { alreadyAppended?: boolean } = {}): Promise<void> {
    return this.serial(convId, async () => {
      const existing = this.live.get(convId);
      if (existing && !existing.finished) {
        if (existing.turnId && !existing.ask) {
          await this.d.sup
            .request("turn/steer", { threadId: existing.threadId, expectedTurnId: existing.turnId, input: [{ type: "text", text: input, text_elements: [] }] })
            .catch(() => undefined);
        }
        return;
      }
      if (!(await this.d.sup.ready(120_000))) throw new Error("codex app-server is not up");
      let conv = await readConv(this.d.vault, convId);
      if (!conv) throw new Error(`conversation ${convId} not found`);
      if (!opts.alreadyAppended) {
        const visible: ChatMessage =
          kind === "user"
            ? { role: "user", content: input, direct: true }
            : { role: "user", content: kind === "wake" ? `⏰ ${input}` : kind === "nudge" ? `↻ ${input}` : `↻ ${input}`, system: true };
        conv = (await appendMessage(this.d.vault, convId, visible)) ?? conv;
      }
      if (!existsSync(this.d.vault) || !statSync(this.d.vault).isDirectory()) {
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The vault ${this.d.vault} is missing on the box; no turn was run.`, failed: true });
        return;
      }
      const threadId = await this.ensureThread(conv);
      const live: Live = {
        convId,
        threadId,
        turnId: null,
        kind,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        order: [],
        texts: new Map(),
        tools: [],
        toolIndex: new Map(),
        reasoning: [],
        usage: null,
        flags: { wake: false, done: false, blocked: false },
        ask: null,
        cut: false,
        stalled: false,
        stopped: false,
        controller: new AbortController(),
        finished: false,
      };
      // The old Stop path (runRegistry) reaches Codex runs too.
      live.controller.signal.addEventListener("abort", () => void this.interrupt(convId, true));
      this.live.set(convId, live);
      registerRun(convId, live.controller);
      setLive(convId, true);
      await patchMeta(this.d.vault, convId, { state: "running" });
      // A legacy chat (history from the old loop) carries its transcript into the first Codex turn.
      let body = input;
      const prior = (conv as any).__legacyHistory as string | undefined;
      if (prior) body = `${prior}\n\n${input}`;
      const rules = rulesPrefixForTurn(conv as any);
      const items = [
        ...(rules ? [{ type: "text", text: rules, text_elements: [] }] : []),
        { type: "text", text: kind === "wake" ? input : body, text_elements: [] },
      ];
      try {
        const r: any = await this.d.sup.request("turn/start", { threadId, input: items }, 60_000);
        if (!live.turnId) live.turnId = r?.turn?.id ?? null;
      } catch (e) {
        live.finished = true;
        this.live.delete(convId);
        unregisterRun(convId, live.controller);
        setLive(convId, false);
        await appendMessage(this.d.vault, convId, { role: "assistant", content: `⚠️ The engine could not start this turn: ${(e as Error).message}`, failed: true }, { state: "idle" });
      }
    });
  }

  private async ensureThread(conv: EngineConv): Promise<string> {
    const model = this.d.model();
    if (conv.codexThreadId) {
      if (!this.loaded.has(conv.codexThreadId)) {
        await this.d.sup.request("thread/resume", {
          threadId: conv.codexThreadId,
          excludeTurns: true,
          ...(this.d.permissions ? { permissions: this.d.permissions } : {}),
        }, 60_000);
        this.loaded.add(conv.codexThreadId);
      }
      this.byThread.set(conv.codexThreadId, conv.id);
      return conv.codexThreadId;
    }
    const devInstr = buildDeveloperInstructions(conv as any, { rolePrompt: ENGINE_ROLE_PROMPT });
    const r: any = await this.d.sup.request("thread/start", {
      cwd: this.d.vault,
      model,
      modelProvider: "openrouter",
      approvalPolicy: "never",
      ...(this.d.permissions ? { permissions: this.d.permissions } : { sandbox: "danger-full-access" }),
      developerInstructions: devInstr,
      dynamicTools: [...ENGINE_TOOL_SPECS, ...contextToolSpecs],
      config: { ...codexLimits(model) },
    }, 60_000);
    const threadId: string = r?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.loaded.add(threadId);
    this.byThread.set(threadId, conv.id);
    // History from before the engine (a legacy chat): hand it over once.
    const old = conv.messages.filter((m) => !m.hidden && !m.system && (m.content ?? "").trim()).slice(0, -1);
    if (old.length && !conv.messages.some((m: any) => m.rollover)) {
      const t = old.slice(-30).map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1500)}`).join("\n");
      (conv as any).__legacyHistory = `<earlier_conversation>\n${t.slice(-12_000)}\n</earlier_conversation>`;
    }
    await patchMeta(this.d.vault, conv.id, { codexThreadId: threadId, codexThreadPath: r?.thread?.path ?? undefined });
    conv.codexThreadId = threadId;
    conv.codexThreadPath = r?.thread?.path;
    return threadId;
  }

  // ---------------------------------------------------------------- events

  private liveByThread(threadId: string | undefined): Live | undefined {
    if (!threadId) return undefined;
    const c = this.byThread.get(threadId);
    return c ? this.live.get(c) : undefined;
  }

  private pushRuntime(l: Live): void {
    const txt = l.order.map((k) => l.texts.get(k) ?? "").filter((s) => s.trim()).join("\n\n");
    setRuntime(l.convId, { text: txt.slice(-6000), tools: l.tools, startedAt: l.startedAt });
  }

  private onNotification(m: { method: string; params: any }): void {
    const p = m.params ?? {};
    const l = this.liveByThread(p.threadId);
    if (!l) return;
    l.lastEventAt = Date.now();
    switch (m.method) {
      case "turn/started":
        if (!l.turnId) l.turnId = p.turn?.id ?? null;
        break;
      case "item/agentMessage/delta": {
        const id = String(p.itemId ?? "msg");
        if (!l.texts.has(id)) l.order.push(id);
        l.texts.set(id, (l.texts.get(id) ?? "") + String(p.delta ?? ""));
        this.pushRuntime(l);
        break;
      }
      case "item/started":
      case "item/completed": {
        const it = p.item ?? {};
        const done = m.method === "item/completed";
        if (it.type === "agentMessage") {
          if (!l.texts.has(it.id)) l.order.push(it.id);
          if (done || typeof it.text === "string") l.texts.set(it.id, String(it.text ?? l.texts.get(it.id) ?? ""));
        } else if (it.type === "reasoning" && done) {
          const s = [...(it.summary ?? []), ...(it.summary?.length ? [] : it.content ?? [])].join("\n").trim();
          if (s) l.reasoning.push(s);
        } else if (it.type === "commandExecution") {
          this.upsertTool(l, it.id, {
            name: "Bash",
            input: { command: it.commandActions?.[0]?.command ?? it.command },
            result: done ? capStr(String(it.aggregatedOutput ?? ""), RESULT_CAP) + (it.exitCode != null && it.exitCode !== 0 ? `\n[exit ${it.exitCode}]` : "") : undefined,
          });
        } else if (it.type === "fileChange") {
          const ch = (it.changes ?? [])[0] ?? {};
          this.upsertTool(l, it.id, {
            name: ch.kind?.type === "add" ? "Write" : "Edit",
            input: { file_path: ch.path, changes: (it.changes ?? []).length },
            result: done ? capStr(String(ch.diff ?? ""), RESULT_CAP) : undefined,
          });
        } else if (it.type === "dynamicToolCall") {
          this.upsertTool(l, it.id, {
            name: String(it.tool ?? "tool"),
            input: it.arguments ?? {},
            result: done ? capStr((it.contentItems ?? []).map((c: any) => c?.text ?? "").join("\n"), RESULT_CAP) : undefined,
          });
        } else if (it.type === "webSearch" || it.type === "mcpToolCall") {
          this.upsertTool(l, it.id, { name: it.type === "webSearch" ? "WebSearch" : String(it.tool ?? "mcp"), input: it.query ?? it.arguments ?? {} });
        } else if (it.type === "contextCompaction" && done) {
          this.upsertTool(l, it.id, { name: "Compaction", input: {}, result: "context compacted" });
        }
        this.pushRuntime(l);
        break;
      }
      case "thread/tokenUsage/updated":
        l.usage = p.tokenUsage ?? l.usage;
        break;
      case "turn/completed":
        void this.finishTurn(l, String(p.turn?.status ?? "completed"), p.turn?.error ?? null);
        break;
      default:
        break;
    }
  }

  private upsertTool(l: Live, id: string, t: Omit<ToolRec, "id">): void {
    const i = l.toolIndex.get(id);
    if (i === undefined) {
      l.toolIndex.set(id, l.tools.length);
      l.tools.push({ id, ...t });
    } else {
      const cur = l.tools[i]!;
      l.tools[i] = { ...cur, ...t, result: t.result ?? cur.result };
    }
  }

  private turnContent(l: Live): string {
    return l.order.map((k) => l.texts.get(k) ?? "").filter((s) => s.trim()).join("\n\n");
  }

  private async finishTurn(l: Live, status: string, error: any): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    if (this.live.get(l.convId) === l) this.live.delete(l.convId);
    unregisterRun(l.convId, l.controller);
    const vault = this.d.vault;
    let content = this.turnContent(l);
    let failed = false;
    if (l.cut) {
      content = `${content}\n\n⚠️ Interrupted by a restart — the command it was running was killed and may not have finished.`.trim();
      failed = true;
    } else if (status === "failed") {
      content = `${content}\n\n⚠️ The turn failed: ${errText(error)}`.trim();
      failed = true;
    } else if (status === "interrupted") {
      content = `${content}\n\n_(${l.stalled ? "stalled — interrupted by the watchdog" : "stopped"})_`.trim();
    }
    const mid = newMessageId();
    const usage = l.usage?.last;
    const msg: ChatMessage & Record<string, unknown> = {
      role: "assistant",
      content: capStr(content, MSG_CAP),
      mid,
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
      ...(l.reasoning.length ? { thinking: capStr(l.reasoning.join("\n\n"), 8_000) } : {}),
      ...(usage
        ? { usage: { prompt: usage.inputTokens ?? 0, completion: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0, context: usage.inputTokens ?? 0 } }
        : {}),
      ...(failed ? { failed: true } : {}),
    };
    const conv0 = await readConv(vault, l.convId);
    const wakeAt = nextWakeFor(vault, l.convId);
    let state: EngineConv["state"] = l.flags.blocked ? "blocked" : l.flags.done ? "done" : wakeAt ? "sleeping" : "idle";
    if (conv0?.pendingAsk) state = "waiting_user";
    if (l.cut) state = "running"; // resumed on the next up
    const hasBody = !!(content.trim() || l.tools.length);
    let conv = hasBody
      ? await appendMessage(vault, l.convId, msg, { state, nextWakeAt: wakeAt })
      : await patchMeta(vault, l.convId, { state, nextWakeAt: wakeAt });
    setLive(l.convId, false);
    this.log(`turn ${l.kind} on ${l.convId} ${status}${l.cut ? " (cut)" : ""} → ${state}`);

    // Cost, from the rollout's response ids (async; lands a few seconds later).
    void this.settleCost(l.convId, conv?.codexThreadPath ?? conv0?.codexThreadPath, l.turnId, hasBody ? mid : null);

    if (l.cut || !conv) return;

    // A stalled turn gets a resume turn.
    if (l.stalled && !l.stopped) {
      void this.run(l.convId, `Your last turn made no progress for ${Math.round((this.d.stallMs ?? 0) / 60000)} minutes and was interrupted by the watchdog. ${RESUME_TEXT}`, "resume");
      return;
    }

    // Rolling sessions: past the threshold, retire the thread with a recap.
    if (status === "completed" && l.usage && shouldRoll(conv as any, l.usage)) {
      await this.rollOver(conv).catch((e) => this.log(`roll-over failed: ${e}`));
      conv = (await readConv(vault, l.convId)) ?? conv;
    }

    // Keep-going rule.
    const ended = l.flags.wake || l.flags.done || l.flags.blocked || !!conv.pendingAsk || !!wakeAt;
    if (ended) this.nudged.delete(l.convId);
    if (conv.working && !ended && !l.stopped && status !== "failed") {
      if (!this.nudged.has(l.convId)) {
        this.nudged.add(l.convId);
        void this.run(l.convId, NUDGE_TEXT, "nudge");
      } else {
        this.nudged.delete(l.convId);
        await patchMeta(vault, l.convId, { state: "blocked" });
        await this.d.notify({
          kind: "info",
          title: `Stopped: ${conv.title}`.slice(0, 90),
          body: "It ended a keep-going turn twice without scheduling a check, asking you, or saying Done or Blocked.",
          convId: l.convId,
        });
      }
    }
  }

  private async rollOver(conv: EngineConv): Promise<void> {
    const r = await buildRecap(conv as any);
    const from = conv.codexThreadId;
    await mutateConv(this.d.vault, conv.id, (c) => {
      c.messages.push({ ...(r.marker as any), mid: newMessageId() });
      c.recap = r.recap;
      c.codexThreadId = undefined;
      c.codexThreadPath = undefined;
      if (typeof r.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + r.costUsd);
    });
    if (from) this.byThread.delete(from);
    this.log(`rolled ${conv.id} over (from ${from}); next turn starts a new thread`);
  }

  private async settleCost(convId: string, threadPath: string | undefined, turnId: string | null, mid: string | null): Promise<void> {
    if (!threadPath || !turnId) return;
    await new Promise((r) => setTimeout(r, 1500));
    const res = await this.d.ledger.settle(rolloutCalls(threadPath, turnId));
    if (!res.calls) return;
    await mutateConv(this.d.vault, convId, (c) => {
      c.costUsd = round((c.costUsd ?? 0) + res.usd);
      if (res.missing) c.costMissingCalls = (c.costMissingCalls ?? 0) + res.missing;
      if (mid) {
        const i = c.messages.findIndex((m) => m.mid === mid);
        if (i >= 0) c.messages[i] = { ...c.messages[i]!, costUsd: round(((c.messages[i] as any).costUsd ?? 0) + res.usd) } as any;
      }
    });
  }

  // ---------------------------------------------------------------- tools

  private async onToolCall(p: any): Promise<unknown> {
    const convId = this.byThread.get(p?.threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (l) l.lastEventAt = Date.now();
    const vault = this.d.vault;
    const conv = convId ? await readConv(vault, convId) : null;
    if (!convId || !conv) return { success: false, contentItems: [{ type: "inputText", text: "No conversation for this thread." }] };
    const a = p?.arguments ?? {};
    const name = String(p?.tool ?? "");
    try {
      if (isContextTool(name)) {
        return await handleContextTool(name, a, {
          conv: conv as any,
          setConversationProject: async (slug: string) => {
            await patchMeta(vault, convId, { project: slug });
          },
        });
      }
      switch (name) {
        case "AskUser": {
          const opts = Array.isArray(a.options) ? a.options.map(String).filter(Boolean).slice(0, 6) : [];
          const ans = await this.waitForAnswer(p.threadId, String(a.question ?? "").trim() || "?", opts);
          return text(`Carl answered: ${ans}`);
        }
        case "ScheduleWake": {
          const reason = String(a.reason ?? "").trim() || "scheduled check";
          let at = a.at ? Date.parse(String(a.at)) : NaN;
          if (!Number.isFinite(at)) {
            const ms = parseDelay(a.in);
            if (ms === null) return text("ScheduleWake needs `in` (e.g. \"10m\") or `at` (ISO time).");
            at = Date.now() + ms;
          }
          at = Math.max(at, Date.now() + 5_000);
          addWake(vault, { conv: convId, at, reason });
          if (l) l.flags.wake = true;
          await patchMeta(vault, convId, { nextWakeAt: nextWakeFor(vault, convId) });
          return text(`Wake scheduled for ${new Date(at).toISOString()} ("${reason}"). End your turn now; you'll be woken then.`);
        }
        case "KeepWorking": {
          const on = a.on !== false;
          await patchMeta(vault, convId, { working: on, ...(on && (conv.state === "done" || conv.state === "blocked") ? { state: "running" } : {}) });
          if (!on) this.nudged.delete(convId);
          return text(on ? "Keep-going mode on. End every turn with ScheduleWake, AskUser, Done or Blocked." : "Keep-going mode off.");
        }
        case "Done": {
          if (l) l.flags.done = true;
          const summary = String(a.summary ?? "").trim();
          const evidence = Array.isArray(a.evidence) ? a.evidence.map(String) : [];
          const v = await verifyDone({ conv: conv as any, summary, evidence });
          const line = formatVerdict(v);
          await mutateConv(vault, convId, (c) => {
            c.working = false;
            c.verdict = { verdict: v.verdict, notes: v.notes, at: v.at, summary };
            if (typeof v.costUsd === "number") c.costUsd = round((c.costUsd ?? 0) + v.costUsd);
          });
          await this.d.notify({ kind: "info", title: `Done: ${conv.title}`.slice(0, 90), body: `${summary.slice(0, 300)}\n${line}`, convId });
          return text(`Recorded as done. ${line}\nTell Carl the verdict in your reply.`);
        }
        case "Blocked": {
          if (l) l.flags.blocked = true;
          const reason = String(a.reason ?? "").trim();
          await patchMeta(vault, convId, { state: "blocked", working: false });
          await this.d.notify({ kind: "info", title: `Blocked: ${conv.title}`.slice(0, 90), body: reason.slice(0, 600), convId });
          return text("Recorded as blocked; Carl has been notified. End your turn.");
        }
        case "Notify": {
          const sent = await this.d.notify({ kind: "info", title: String(a.title ?? "vault-chat").slice(0, 90), body: String(a.body ?? "").slice(0, 2000), convId });
          return text(sent ? "Notified." : "Recorded in the feed (no phone subscribed).");
        }
        case "PdfRead":
          return text(await pdfRead(vault, a));
        case "WebSearch":
          return text(await webSearch(String(a.query ?? ""), this.d.apiKey(), this.d.webSearchModel));
        case "StartJob":
          return text(startJob(this.d.jobEnv, vault, a));
        case "JobStatus":
          return text(jobStatus(this.d.jobEnv, a));
        case "Cost": {
          if (a.project) {
            const pc = projectCost(String(a.project), (await allConvs(vault)) as any);
            return text(pc ? `Project ${pc.name}: $${pc.totalUsd.toFixed(4)} over ${pc.parts.length} conversation(s)${pc.missingCalls ? ` (${pc.missingCalls} call(s) without a cost)` : ""}.` : `No project "${a.project}".`);
          }
          const target = a.conversation ? await readConv(vault, String(a.conversation)) : conv;
          if (!target) return text(`No conversation ${a.conversation}.`);
          return text(`Conversation "${target.title}": $${(target.costUsd ?? 0).toFixed(4)}${target.costMissingCalls ? ` (+${target.costMissingCalls} call(s) without a cost)` : ""}. (Costs land a few seconds after each turn.)`);
        }
        default:
          return { success: false, contentItems: [{ type: "inputText", text: `Unknown tool ${name}.` }] };
      }
    } catch (e) {
      return { success: false, contentItems: [{ type: "inputText", text: `${name} failed: ${(e as Error).message}` }] };
    }
  }

  /** Park the turn on a question until Carl answers (via /message or /answer). */
  private async waitForAnswer(threadId: string, question: string, options: string[]): Promise<string> {
    const convId = this.byThread.get(threadId);
    const l = convId ? this.live.get(convId) : undefined;
    if (!convId || !l) return "No one is available to answer right now. Continue with your best judgement and say what you assumed.";
    const vault = this.d.vault;
    const conv = await readConv(vault, convId);
    // Show what was said so far plus the question as an assistant message.
    const before = this.turnContent(l);
    const optsBlock = options.length ? `\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : "";
    const msg: any = {
      role: "assistant",
      content: `${before ? before + "\n\n" : ""}**❓ ${question}**${optsBlock}`,
      ...(l.tools.length ? { toolCalls: l.tools } : {}),
      ...(options.length ? { askOptions: options.map((o) => ({ answer: o, title: o, body: "" })) } : {}),
    };
    l.order = [];
    l.texts = new Map();
    l.tools = [];
    l.toolIndex = new Map();
    const p = new Promise<string>((resolve) => {
      l.ask = { resolve, question };
    });
    await appendMessage(vault, convId, msg, { state: "waiting_user", pendingAsk: { question, options, at: Date.now() } });
    setLive(convId, false);
    await this.d.notify({ kind: "ask", title: (conv?.title ? `Needs you: ${conv.title}` : "Needs your call").slice(0, 90), body: question, convId, options });
    return p;
  }

  private async answer(convId: string, answer: string): Promise<void> {
    const vault = this.d.vault;
    const l = this.live.get(convId);
    const conv = await readConv(vault, convId);
    await appendMessage(vault, convId, { role: "user", content: answer, direct: true, decision: true }, { pendingAsk: undefined, state: l?.ask ? "running" : conv?.state === "waiting_user" ? "idle" : conv?.state });
    this.nudged.delete(convId);
    if (l?.ask) {
      const a = l.ask;
      l.ask = null;
      l.lastEventAt = Date.now();
      setLive(convId, true);
      a.resolve(answer);
      return;
    }
    // The turn that asked is gone (restart): a new turn carries the answer.
    const q = conv?.pendingAsk?.question;
    void this.run(convId, q ? `Carl's answer to your question "${q}": ${answer}` : answer, "user", { alreadyAppended: true });
  }

  // ---------------------------------------------------------------- wakes & watchdog

  private async tickWakes(): Promise<void> {
    const now = Date.now();
    const due = readWakes(this.d.vault).filter((w) => w.at <= now && !this.firing.has(w.id));
    for (const w of due) {
      const l = this.live.get(w.conv);
      if (l?.ask) continue; // waiting on Carl: the wake waits too
      this.firing.add(w.id);
      removeWakes(this.d.vault, (x) => x.id === w.id);
      void this.fireWake(w).finally(() => this.firing.delete(w.id));
    }
  }

  private async fireWake(w: Wake): Promise<void> {
    const conv = await readConv(this.d.vault, w.conv);
    if (!conv) return;
    await patchMeta(this.d.vault, w.conv, { nextWakeAt: nextWakeFor(this.d.vault, w.conv) });
    this.log(`wake ${w.id} → ${w.conv}: ${w.reason}`);
    await this.run(w.conv, `Wake: ${w.reason}`, "wake").catch((e) => this.log(`wake failed: ${e}`));
  }

  private tickWatchdog(): void {
    const stall = this.d.stallMs ?? 30 * 60_000;
    const now = Date.now();
    for (const l of this.live.values()) {
      if (l.ask || l.finished || l.stalled) continue;
      if (now - l.lastEventAt > stall) {
        l.stalled = true;
        this.log(`watchdog: ${l.convId} silent for ${Math.round((now - l.lastEventAt) / 1000)} s — interrupting`);
        void this.interrupt(l.convId, false);
      }
    }
  }
}

function capStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}
function round(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
function errText(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message ?? e.codexErrorInfo ?? JSON.stringify(e)).slice(0, 500);
}
