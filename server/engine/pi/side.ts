// Side threads: Ctrl+K / Ctrl+L, and the tool-less one-shots (a note's title
// and summary, spoken math as notation). Each is one pi, launched like any
// other (backend.spawn: sandbox, key on fd 3, the path guard), on pi's own
// mechanisms only:
//
//  - context: pi's --fork of the conversation's session — the side thread
//    starts with the conversation's history and its instructions (one agent,
//    shared context), and its session header names the conversation's session
//    as its parent (a linked side thread, kept under sessions/side/);
//  - tools: pi's --tools allowlist (Ctrl+K and Ctrl+L: the agent's read-only
//    tools — pi's read/grep/find/ls and every vault-chat tool the engine marks
//    readOnly, PdfRead and WebSearch among them, answered by the engine as of the
//    conversation) or --no-tools (one-shots);
//  - what Carl did elsewhere: the "you" layer, through the same extension hook
//    as a conversation's turn (before_agent_start → a vc-you custom message in
//    the side session; the fork carries what the conversation saw already);
//  - a popover's refinement: the next prompt in the same pi session;
//  - one-shots: --no-session, --system-prompt (theirs replaces pi's own).
//
// The answer streams as pi's own text deltas (the current assistant message's
// text, read by GET /api/v1/side/:id); the final text is pi's
// get_last_assistant_text. Nothing here writes a session file.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sinceOf, type PiBackend, type ToolSpec } from "./backend";
import type { PiProc } from "./proc";
import { TurnRecorder, type TurnLine } from "../turnLog";

/** pi's read-only built-ins (Ctrl+K and Ctrl+L have these, plus the engine's read-only tools: SideStart.hostTools). */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export type SideStart = {
  /** What it is (the log line). */
  kind: string;
  /** Continue this side thread (a popover's next request). */
  side?: string | null;
  /** Fork this session file (the conversation's). */
  fork?: string | null;
  /** The agent's instructions file (--append-system-prompt); ignored with `system`. */
  instr?: string;
  /** A system prompt of its own (--system-prompt), for a one-shot. */
  system?: string;
  cwd: string;
  model: string;
  /** pi's built-ins allowed; [] (and no hostTools) = --no-tools. */
  tools: string[];
  /** vault-chat tools (the extension registers them; the engine answers): Ctrl+K / Ctrl+L get the read-only ones. */
  hostTools?: ToolSpec[];
  /** --no-session (one-shots). */
  ephemeral?: boolean;
  thinking?: string;
  /** Where the session goes (persisted side threads). */
  sessionDir: string;
  /** Ctrl+K / Ctrl+L: the "you" layer before each request, as of this conversation (null: none open). One-shots: off. */
  you?: { convId: string | null } | null;
  text: string;
  /** data: URLs. */
  images?: string[];
  /** The box's turn log (turnLog.ts): one line per request of this side thread, mode "side". Kept for its next requests. */
  log?: SideLog;
};

export type SideLog = { vault: string; conv: string | null; via: string; version: string; write: (line: TurnLine) => void };

export type SideState = { id: string; text: string; v: number; done: boolean; error: string | null; file: string | null };

type Run = {
  id: string;
  proc: PiProc | null;
  file: string | null;
  meta: { instr?: string; system?: string; cwd: string; model: string; tools: string[]; hostTools?: ToolSpec[]; thinking?: string; sessionDir: string; ephemeral: boolean; you?: { convId: string | null } | null };
  text: string;
  v: number;
  done: boolean;
  error: string | null;
  busy: boolean;
  lastUsed: number;
  waiters: Set<() => void>;
  log?: SideLog;
  rec?: TurnRecorder | null;
};

const IDLE_MS = 10 * 60_000;
const FORGET_MS = 60 * 60_000;

/** data: URLs → pi's ImageContent. */
export function piImages(urls: string[] | undefined): { type: "image"; data: string; mimeType: string }[] {
  const out: { type: "image"; data: string; mimeType: string }[] = [];
  for (const u of (urls ?? []).slice(0, 8)) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(typeof u === "string" ? u : "");
    if (m) out.push({ type: "image", data: m[2]!, mimeType: m[1]! });
  }
  return out;
}

export class SideRuns {
  private runs = new Map<string, Run>();
  private timer: NodeJS.Timeout;

  constructor(
    private b: PiBackend,
    private log: (s: string) => void,
  ) {
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref?.();
  }

  health(): Record<string, unknown> {
    return { running: [...this.runs.values()].filter((r) => r.busy).length, open: [...this.runs.values()].filter((r) => r.proc?.isAlive()).length };
  }

  /** Start a side request (or the next request of a side thread). Throws when pi does not take it. */
  async start(o: SideStart): Promise<SideState> {
    let run = o.side ? this.runs.get(o.side) ?? this.fromDisk(o.side) : null;
    if (o.side && !run) throw new Error("that side thread is gone");
    if (run?.busy) throw new Error("that side thread is still answering");
    if (!run) {
      run = await this.open(o);
    } else if (!run.proc?.isAlive()) {
      // Closed while idle: pi resumes its session file.
      if (!run.file) throw new Error("that side thread is gone");
      run.proc = (await this.spawn(run.meta, { file: run.file })).proc;
      this.attach(run);
    }
    run.text = "";
    run.error = null;
    run.done = false;
    run.busy = true;
    run.v++;
    run.lastUsed = Date.now();
    if (o.log) run.log = o.log;
    if (run.log) {
      const l = run.log;
      run.rec = new TurnRecorder({ vault: l.vault, conv: l.conv ?? "side", turn: `side-${run.id.slice(-12)}-${run.v}`, session: run.id, mode: "side", via: l.via, cmid: null, model: run.meta.model, start: Date.now(), version: l.version });
    }
    const imgs = piImages(o.images);
    const r = await run.proc!.request({ type: "prompt", message: o.text, ...(imgs.length ? { images: imgs } : {}) }, 60_000).catch((e) => ({ success: false, error: (e as Error).message }));
    if (!r?.success) {
      this.finish(run, String(r?.error ?? "prompt rejected"));
      throw new Error(run.error!);
    }
    return this.state(run);
  }

  private async open(o: SideStart): Promise<Run> {
    const meta: Run["meta"] = { instr: o.instr, system: o.system, cwd: o.cwd, model: o.model, tools: o.tools, hostTools: o.hostTools ?? [], thinking: o.thinking, sessionDir: o.sessionDir, ephemeral: !!o.ephemeral, you: o.you ?? null };
    if (o.system) {
      // pi's --system-prompt takes a file's contents too (no prompt in argv).
      mkdirSync(this.b.paths.instrDir, { recursive: true });
      meta.system = join(this.b.paths.instrDir, `side-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`);
      writeFileSync(meta.system, o.system);
    }
    const { proc, id, file } = await this.spawn(meta, { fork: o.fork ?? null });
    const run: Run = { id, proc, file: file || null, meta, text: "", v: 0, done: false, error: null, busy: false, lastUsed: Date.now(), waiters: new Set() };
    this.runs.set(id, run);
    // Beside the session: how to reopen it (a refinement after the box restarted).
    if (run.file) writeFileSync(join(this.b.paths.instrDir, `side-${id}.json`), JSON.stringify({ file: run.file, meta }));
    this.attach(run);
    return run;
  }

  private spawn(meta: Run["meta"], at: { fork?: string | null; file?: string | null }) {
    mkdirSync(meta.sessionDir, { recursive: true });
    return this.b.spawn({
      cwd: meta.cwd,
      model: meta.model,
      file: at.file ?? null,
      fork: at.fork ?? undefined,
      instr: meta.instr ?? "",
      system: meta.system,
      ephemeral: meta.ephemeral,
      thinking: meta.thinking,
      tools: this.b.writeTools(meta.hostTools ?? []),
      sessionDir: meta.sessionDir,
      // pi's --tools names every active tool, extension ones too.
      builtins: [...meta.tools, ...(meta.hostTools ?? []).map((t) => t.name)],
      you: !!meta.you,
    });
  }

  private fromDisk(id: string): Run | null {
    try {
      const { file, meta } = JSON.parse(readFileSync(join(this.b.paths.instrDir, `side-${id}.json`), "utf8"));
      if (!readdirSync(meta.sessionDir).some((n) => n.endsWith(`_${id}.jsonl`))) return null;
      const run: Run = { id, proc: null, file, meta, text: "", v: 0, done: true, error: null, busy: false, lastUsed: Date.now(), waiters: new Set() };
      this.runs.set(id, run);
      return run;
    } catch {
      return null;
    }
  }

  private attach(run: Run): void {
    const proc = run.proc!;
    proc.on("event", (e: any) => {
      if (run.proc !== proc) return;
      run.rec?.pi(e);
      if (e?.type === "message_start" && e.message?.role === "assistant") {
        // A new assistant message (after a tool call): what streams is this one.
        run.text = "";
        this.bump(run);
      } else if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        run.text += String(e.assistantMessageEvent.delta ?? "");
        this.bump(run);
      } else if (e?.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") {
        run.error = String(e.message.errorMessage ?? "the model failed").slice(0, 500);
      } else if (e?.type === "agent_settled") {
        void (async () => {
          const t = await proc.request({ type: "get_last_assistant_text" }, 15_000).catch(() => null);
          if (typeof t?.data?.text === "string") run.text = t.data.text;
          this.finish(run, run.error ?? (e.aborted ? "stopped" : null));
          if (run.meta.ephemeral) {
            void proc.close(3000);
            if (run.meta.system) rmSync(run.meta.system, { force: true });
          }
        })();
      }
    });
    // Host calls: the "you" layer and the read-only vault-chat tools (as of the conversation it was opened from); dialogs are cancelled.
    proc.on("ui", async (req: any) => {
      const reply = (o: Record<string, unknown>) => proc.write({ type: "extension_ui_response", id: req.id, ...o });
      if (req.method === "editor" && req.title === "vc:host-call") {
        let call: any = {};
        try {
          call = JSON.parse(String(req.prefill ?? "{}"));
        } catch {
          /* not a call */
        }
        if (call?.tool === "__you" && run.meta.you) return reply({ value: JSON.stringify(await this.b.you({ convId: run.meta.you.convId, since: sinceOf(call.args) })) });
        const name = String(call?.tool ?? "");
        const h = this.b.handlers?.sideTool;
        if (h && (run.meta.hostTools ?? []).some((t) => t.name === name)) {
          const r = await h(run.meta.you?.convId ?? null, name, call.args ?? {}).catch((e) => ({ ok: false, text: `${name} failed: ${(e as Error).message}` }));
          return reply({ value: JSON.stringify({ text: r.text, ...(r.ok ? {} : { isError: true }) }) });
        }
        return reply({ value: JSON.stringify({ text: "Not available here: this request has read-only tools.", isError: true }) });
      }
      if (["select", "confirm", "input", "editor"].includes(req.method)) reply({ cancelled: true });
    });
    proc.on("exit", () => {
      if (run.proc !== proc || !run.busy) return;
      this.log(`side thread ${run.id}: pi exited mid-answer${proc.stderrTail ? `: ${proc.stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""}`);
      this.finish(run, "pi exited");
    });
  }

  private bump(run: Run): void {
    run.v++;
    for (const w of [...run.waiters]) w();
  }

  private finish(run: Run, error: string | null): void {
    run.busy = false;
    run.done = true;
    run.error = error;
    run.lastUsed = Date.now();
    this.bump(run);
    const rec = run.rec;
    run.rec = null;
    if (rec && run.log) {
      const stopped = error === "stopped";
      try {
        run.log.write(rec.line({ status: error ? (stopped ? "interrupted" : "failed") : "completed", outcome: error ? (stopped ? "stopped" : "error") : "ok", error: stopped ? null : error }));
      } catch (e) {
        this.log(`side turn log: ${(e as Error).message}`);
      }
    }
  }

  private state(run: Run): SideState {
    return { id: run.id, text: run.text, v: run.v, done: run.done, error: run.error, file: run.file };
  }

  /** The side thread's text now, once it is past `after` (or done), waiting up to `waitMs`. */
  async poll(id: string, after: number, waitMs: number): Promise<SideState | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.v <= after && !run.done && waitMs > 0) {
      await new Promise<void>((res) => {
        const done = () => {
          clearTimeout(t);
          run.waiters.delete(done);
          res();
        };
        const t = setTimeout(done, waitMs);
        run.waiters.add(done);
      });
    }
    return this.state(run);
  }

  /** Until it is done (the server's own one-shots). */
  async wait(id: string): Promise<SideState> {
    for (;;) {
      const s = await this.poll(id, Number.MAX_SAFE_INTEGER, 30_000);
      if (!s) throw new Error("the side thread is gone");
      if (s.done) return s;
    }
  }

  async stop(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run?.proc?.isAlive() || !run.busy) return false;
    await run.proc.request({ type: "abort" }, 10_000).catch(() => run.proc?.killGroup("SIGKILL"));
    return true;
  }

  /** Drop a finished one-shot at once. */
  forget(id: string): void {
    const run = this.runs.get(id);
    if (run && !run.busy) {
      this.runs.delete(id);
      if (run.proc?.isAlive()) void run.proc.close(3000);
    }
  }

  /** Idle side threads give their process back (their session stays); old ones are forgotten. */
  private reap(): void {
    const now = Date.now();
    for (const r of [...this.runs.values()]) {
      if (r.busy) continue;
      if (r.proc?.isAlive() && now - r.lastUsed > IDLE_MS) void r.proc.close(3000);
      if (now - r.lastUsed > FORGET_MS) this.runs.delete(r.id);
    }
  }
}
