// Ctrl+K, Ctrl+L and the box's one-shots, on Claude Code.
//
// A side thread is a question asked beside the conversation, never in it: it
// forks the conversation's session so it can see everything said so far, gets
// read-only tools, and whatever it answers is thrown away. /api/v1/side is
// unchanged — the same {id, text, v, done, error, file} the clients already
// long-poll — so the popover does not know which engine answered it.
//
// A request is its own run of the CLI rather than a warm session: a side thread
// is one question most of the time, and the spike measured a cold start at
// ~290 ms, which a popover does not notice. A popover's NEXT question resumes
// the run's own session, so it remembers what it just said.
//
// One-shots (a note's title, spoken maths) are the same machinery with nothing
// attached: their own system prompt, no tools, and no session kept.
import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProcessServices } from "../../mcp/runtime";
import type { McpRuntime } from "../../mcp/runtime";
import type { Handlers, SideLog, SideRunner, SideStart, SideState, ToolSpec } from "../backend";
import { TurnRecorder } from "../turnLog";
import { CLAUDE_BUILTINS_OFF } from "./session";

/** Side-run ids this engine owns, so a router can tell them apart with no state. */
export const CLAUDE_SIDE_PREFIX = "cc-side-";
export const isClaudeSide = (id: string): boolean => id.startsWith(CLAUDE_SIDE_PREFIX);

/** How long a finished run is kept, so a popover can still read it. */
const FORGET_MS = 60 * 60_000;

type Run = {
  id: string;
  /** Claude Code's session for this side thread (absent for a one-shot). */
  sessionId: string | null;
  text: string;
  v: number;
  done: boolean;
  error: string | null;
  busy: boolean;
  endedAt: number;
  waiters: Set<() => void>;
  /** What it was opened with, so its next question runs the same way. */
  meta: {
    cwd: string;
    model: string;
    instr?: string;
    system?: string;
    hostTools: ToolSpec[];
    convId: string | null;
    ephemeral: boolean;
  };
  log?: SideLog;
  rec?: TurnRecorder | null;
  /** The run of the CLI answering right now, so stop() can interrupt it. */
  q?: { interrupt: () => Promise<unknown> } | null;
  /** Carl pressed stop: its end is not a failure. */
  stopped?: boolean;
};

export type ClaudeSideOptions = {
  /** What answers --version, already wrapped in the sandbox if there is one. */
  cli: (cwd: string) => string;
  env: () => NodeJS.ProcessEnv;
  /** vault-chat's read-only tools for a side thread, bound per run. */
  mcp?: McpRuntime;
  handlers: () => Handlers | null;
  /** The Claude Code session a conversation's transcript belongs to, by the file the engine names. */
  sessionOf: (file: string) => string | null;
  /** The model a one-shot runs on when the caller names none. */
  fastModel?: string;
  log?: (s: string) => void;
};

export class ClaudeSideRuns implements SideRunner {
  private runs = new Map<string, Run>();

  constructor(private readonly o: ClaudeSideOptions) {}

  health(): Record<string, unknown> {
    return { runs: this.runs.size, busy: [...this.runs.values()].filter((r) => r.busy).length };
  }

  async start(o: SideStart): Promise<SideState> {
    this.reap();
    let run = o.side ? this.runs.get(o.side) : undefined;
    if (o.side && !run) throw new Error("that side thread is gone");
    if (run?.busy) throw new Error("that side thread is still answering");
    if (!run) {
      run = {
        id: `${CLAUDE_SIDE_PREFIX}${randomUUID()}`,
        sessionId: null,
        text: "",
        v: 0,
        done: false,
        error: null,
        busy: false,
        endedAt: 0,
        waiters: new Set(),
        meta: {
          cwd: o.cwd,
          model: o.model,
          ...(o.instr ? { instr: o.instr } : {}),
          ...(o.system ? { system: o.system } : {}),
          hostTools: o.hostTools ?? [],
          convId: o.you?.convId ?? null,
          ephemeral: !!o.ephemeral,
        },
      };
      this.runs.set(run.id, run);
    } else {
      // The host's policy decides the tools again; a saved list never grants anything new.
      run.meta.hostTools = o.hostTools ?? run.meta.hostTools;
    }
    run.text = "";
    run.error = null;
    run.done = false;
    run.busy = true;
    run.v += 1;
    if (o.log) run.log = o.log;
    if (run.log) {
      const l = run.log;
      run.rec = new TurnRecorder({ vault: l.vault, conv: l.conv ?? "side", turn: `side-${run.id.slice(-12)}-${run.v}`, session: run.id, mode: "side", via: l.via, cmid: null, model: run.meta.model, start: Date.now(), version: l.version });
    }
    // The first question of a forked side thread starts from the conversation's
    // own session, so it can see everything said in it.
    const forkFrom = !o.side && o.fork ? this.o.sessionOf(o.fork) : null;
    void this.run(run, o, forkFrom).catch((e) => this.finish(run!, (e as Error).message));
    return this.state(run);
  }

  async poll(id: string, after: number, waitMs: number): Promise<SideState | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.v <= after && !run.done && waitMs > 0) {
      await new Promise<void>((res) => {
        const wake = () => {
          clearTimeout(t);
          run.waiters.delete(wake);
          res();
        };
        const t = setTimeout(wake, waitMs);
        run.waiters.add(wake);
      });
    }
    return this.state(run);
  }

  /** Until it is done (the box's own one-shots). */
  async wait(id: string): Promise<SideState> {
    for (;;) {
      const s = await this.poll(id, Number.MAX_SAFE_INTEGER, 30_000);
      if (!s) throw new Error("the side thread is gone");
      if (s.done) return s;
    }
  }

  async stop(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run?.busy) return false;
    run.stopped = true;
    await run.q?.interrupt().catch(() => undefined);
    return true;
  }

  /** Drop a finished one-shot at once. */
  forget(id: string): void {
    const run = this.runs.get(id);
    if (run && !run.busy) this.runs.delete(id);
  }

  // ----------------------------------------------------------------- the run itself

  private async run(run: Run, o: SideStart, forkFrom: string | null): Promise<void> {
    const tools = await this.bind(run);
    const options: Options = {
      pathToClaudeCodeExecutable: this.o.cli(run.meta.cwd),
      cwd: run.meta.cwd,
      model: run.meta.model || this.o.fastModel || "haiku",
      includePartialMessages: true,
      env: this.o.env(),
      settingSources: [],
      settings: JSON.stringify({ autoMemoryEnabled: false }),
      disallowedTools: [...CLAUDE_BUILTINS_OFF],
      // A one-shot gets its own prompt and nothing else; a side thread of a
      // conversation keeps Claude Code's prompt and the host's instructions.
      ...(run.meta.system
        ? { systemPrompt: run.meta.system }
        : run.meta.instr
          ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: run.meta.instr } }
          : {}),
      ...(tools ? { mcpServers: tools.servers as never, allowedTools: tools.allowed } : {}),
      // Its own next question resumes it; a fork starts from the conversation's.
      ...(run.sessionId ? { resume: run.sessionId } : forkFrom ? { resume: forkFrom, forkSession: true } : {}),
      // Nothing a one-shot says is kept.
      ...(run.meta.ephemeral ? { persistSession: false } : {}),
    };
    const prompt = [o.context?.trim(), await this.youLayer(run), o.text].filter(Boolean).join("\n\n");
    let errored: string | null = null;
    try {
      const q = query({ prompt, options });
      run.q = q;
      for await (const m of q) this.onMessage(run, m);
    } catch (e) {
      errored = (e as Error).message;
    } finally {
      await tools?.revoke().catch(() => undefined);
      run.q = null;
      this.finish(run, errored);
    }
  }

  private onMessage(run: Run, m: SDKMessage): void {
    if ((m as { parent_tool_use_id?: string | null }).parent_tool_use_id) return;
    if (!run.sessionId && typeof (m as { session_id?: string }).session_id === "string" && !run.meta.ephemeral) {
      run.sessionId = (m as { session_id: string }).session_id;
    }
    if (m.type === "stream_event") {
      const e = (m as { event: any }).event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        run.text += String(e.delta.text ?? "");
        this.bump(run);
      }
      return;
    }
    if (m.type === "result") {
      // The result's own text is the whole answer: prefer it over the deltas.
      const text = String((m as { result?: unknown }).result ?? "");
      if (text.trim()) run.text = text;
      if ((m as { is_error?: boolean }).is_error) run.error = text.slice(0, 500) || "the side thread failed";
    }
  }

  /** vault-chat's read-only tools for this run, bound and revoked with it. */
  private async bind(run: Run): Promise<{ servers: Record<string, unknown>; allowed: string[]; revoke: () => Promise<void> } | null> {
    const h = this.o.handlers();
    const specs = run.meta.hostTools;
    if (!this.o.mcp || !h?.sideTool || !specs.length) return null;
    const services: ProcessServices = { env: () => ({}) };
    const convId = run.meta.convId;
    const scope = await this.o.mcp.bind(
      { specs, call: (name, args, context) => h.sideTool!(convId, name, args, context.signal) },
      services,
    );
    return {
      servers: {
        vault_chat: {
          type: "http",
          url: scope.bootstrap.url,
          headers: { Authorization: scope.bootstrap.authorization },
          alwaysLoad: true,
        },
      },
      allowed: ["mcp__vault_chat"],
      revoke: scope.revoke,
    };
  }

  /** What Carl did elsewhere, as of the conversation this was opened from. */
  private async youLayer(run: Run): Promise<string> {
    const h = this.o.handlers();
    if (!h?.you || !run.meta.convId) return "";
    try {
      const r = await h.you({ convId: run.meta.convId, since: null });
      return String(r?.text ?? "").trim();
    } catch {
      return "";
    }
  }

  private bump(run: Run): void {
    run.v += 1;
    for (const w of [...run.waiters]) w();
  }

  private finish(run: Run, error: string | null): void {
    if (run.done) return;
    run.busy = false;
    run.done = true;
    run.endedAt = Date.now();
    if (error && !run.error) run.error = error;
    if (run.stopped && !run.error) run.error = null;
    if (run.log && run.rec) {
      run.log.write(run.rec.line({ status: run.error ? "failed" : run.stopped ? "interrupted" : "completed", outcome: run.error ? "failed" : "ok", state: "idle", ...(run.error ? { error: run.error } : {}) }));
    }
    run.rec = null;
    this.bump(run);
  }

  private state(run: Run): SideState {
    return { id: run.id, text: run.text, v: run.v, done: run.done, error: run.error, file: null };
  }

  private reap(): void {
    const now = Date.now();
    for (const [id, run] of [...this.runs]) if (!run.busy && run.endedAt && now - run.endedAt > FORGET_MS) this.runs.delete(id);
  }
}
