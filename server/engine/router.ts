// Two engines, one contract.
//
// A conversation runs on pi or on Claude Code, and the engine above does not
// have to know which: every call it makes names a thread, and a thread id says
// whose it is (Claude Code's start `cc-`, server/engine/claude/backend.ts), so
// routing needs no state and survives a restart. The one call that names no
// thread yet — startThread — is given the conversation, and the setting decides.
//
// While pi is the default this is a pass-through: a box with no Claude Code
// installed gets exactly the pi behaviour it had.
import { EventEmitter } from "node:events";
import type { CallRecord } from "./ledger";
import {
  type BackendEvent,
  type Detached,
  type EngineBackend,
  type Handlers,
  type LiveChild,
  type SideRunner,
  type ToolSpec,
} from "./backend";
import { isClaudeThread } from "./claude/backend";
import { isClaudeSide } from "./claude/side";
import type { UserRequest } from "./piFeed";

export type EngineName = "pi" | "claude";

export type RouterOptions = {
  pi: EngineBackend;
  /** Absent: no Claude Code on this box, and everything runs on pi. */
  claude?: EngineBackend | null;
  /** Which engine a conversation's NEXT thread starts on. */
  engineOf: (convId: string | undefined) => EngineName;
  log?: (s: string) => void;
};

export class BackendRouter extends EventEmitter implements EngineBackend {
  constructor(private readonly o: RouterOptions) {
    super();
    for (const b of this.all()) {
      b.on("event", (e: BackendEvent) => this.emit("event", e));
      b.on("up", () => this.emit("up"));
      b.on("down", () => this.emit("down"));
    }
  }

  private all(): EngineBackend[] {
    return this.o.claude ? [this.o.pi, this.o.claude] : [this.o.pi];
  }

  /** The engine a conversation's next thread starts on (pi unless Claude Code is there and chosen). */
  private chosen(convId?: string): EngineBackend {
    return (this.o.claude && this.o.engineOf(convId) === "claude") ? this.o.claude : this.o.pi;
  }

  /** The engine that owns an existing thread, from its id alone. */
  private of(threadId: string): EngineBackend {
    return this.o.claude && isClaudeThread(threadId) ? this.o.claude : this.o.pi;
  }

  /** The engine in charge: what health and the engine's own messages name. */
  private get head(): EngineBackend {
    return this.chosen(undefined);
  }

  get name(): string {
    return this.head.name;
  }

  // -- lifecycle: both engines, every time
  setHandlers(h: Handlers): void {
    for (const b of this.all()) b.setHandlers(h);
  }

  start(): void {
    for (const b of this.all()) b.start();
  }

  /**
   * The engine asks this before it knows which engine the turn will run on, so
   * the answer is "can a turn run at all": one engine being down does not stop
   * a conversation whose own engine is up (it fails later, by name, if it is
   * that engine that is down).
   */
  ready(ms?: number): Promise<boolean> {
    const checks = this.all().map((b) => b.ready(ms).catch(() => false));
    // The first engine to say yes answers, so a conversation on a healthy engine
    // never waits out another engine's timeout.
    return new Promise<boolean>((resolve) => {
      let left = checks.length;
      for (const c of checks) void c.then((ok) => (ok ? resolve(true) : --left === 0 && resolve(false)));
    });
  }

  /**
   * The engine in charge, with the other one beside it — so health reads the way
   * it always did on a pi box. `engines` says the same thing by name whichever
   * engine leads, which is what a client should read: the merged shape moves
   * fields around when the default changes, and that is not a client's problem.
   */
  health(): Record<string, unknown> {
    const other = this.all().find((b) => b !== this.head);
    const engines = Object.fromEntries(this.all().map((b) => [b.name, b.health()]));
    return { ...this.head.health(), ...(other ? { [other.name]: other.health() } : {}), engines: { default: this.head.name, ...engines } };
  }

  // -- threads
  async startThread(o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean; conv?: string }): Promise<{ threadId: string; ref?: string }> {
    const b = this.chosen(o.conv);
    const r = await b.startThread(o);
    this.o.log?.(`conversation ${o.conv ?? "?"} starts a thread on ${b.name}`);
    return r;
  }

  resumeThread(threadId: string, o: { model: string; subagents: boolean; cwd?: string }): Promise<void> {
    return this.of(threadId).resumeThread(threadId, o);
  }

  holds(threadId: string): boolean {
    return this.of(threadId).holds(threadId);
  }

  forget(threadId: string): void {
    this.of(threadId).forget(threadId);
  }

  threadSource(threadId: string): { file: string; instr: string; cwd: string } | null {
    return this.of(threadId).threadSource(threadId);
  }

  note(threadId: string, data: Record<string, unknown>): Promise<boolean> {
    return this.of(threadId).note(threadId, data);
  }

  compact(threadId: string, customInstructions?: string): Promise<{ tokensBefore?: number; summary?: string }> {
    return this.of(threadId).compact(threadId, customInstructions);
  }

  // -- turns
  startTurn(threadId: string, o: Parameters<EngineBackend["startTurn"]>[1]): Promise<{ turnId: string | null }> {
    return this.of(threadId).startTurn(threadId, o);
  }

  steer(threadId: string, turnId: string, o: { texts: string[]; context?: string; request?: UserRequest; images: string[] }): Promise<void> {
    return this.of(threadId).steer(threadId, turnId, o);
  }

  followUp(threadId: string, o: { texts: string[]; context?: string; request?: UserRequest; images?: string[] }): Promise<void> {
    return this.of(threadId).followUp(threadId, o);
  }

  clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }> {
    return this.of(threadId).clearQueue(threadId);
  }

  interrupt(threadId: string, turnId: string): Promise<void> {
    return this.of(threadId).interrupt(threadId, turnId);
  }

  // -- cost: a thread's own engine answers (Claude Code reports usage, not price)
  usageCalls(ref: string | undefined, turnId?: string | null): CallRecord[] {
    return this.o.pi.usageCalls(ref, turnId);
  }

  childUsageCalls(threadId: string): CallRecord[] {
    return this.of(threadId).childUsageCalls(threadId);
  }

  // -- files: vault-chat has one path policy, and it is pi's extension today (phase 4 moves it)
  externalPath(root: string, path: unknown, write?: boolean): Promise<string | null> {
    return this.o.pi.externalPath(root, path, write);
  }

  nativePath(cwd: string, path: unknown): Promise<string | null> {
    return this.o.pi.nativePath?.(cwd, path) ?? Promise.resolve(null);
  }

  filesystem(...a: Parameters<EngineBackend["filesystem"]>): ReturnType<EngineBackend["filesystem"]> {
    return this.o.pi.filesystem(...a);
  }

  /**
   * Side threads (Ctrl+K / Ctrl+L) and the box's one-shots. A run's id says
   * whose it is; a NEW one belongs to the engine that holds the conversation it
   * was opened from, which the engine names by its transcript file. A one-shot
   * (no conversation to fork) runs on the engine in charge.
   */
  readonly side: SideRunner = {
    start: (o) => this.sideOf(o.side ?? null, o.fork ?? null).start(o),
    poll: (id, after, waitMs) => this.sideOf(id, null).poll(id, after, waitMs),
    wait: (id) => this.sideOf(id, null).wait(id),
    stop: (id) => this.sideOf(id, null).stop(id),
    forget: (id) => this.sideOf(id, null).forget(id),
    health: () => {
      const other = this.all().find((b) => b !== this.head);
      return { ...this.head.side.health(), ...(other ? { [other.name]: other.side.health() } : {}) };
    },
  };

  private sideOf(id: string | null, fork: string | null): SideRunner {
    const claude = this.o.claude;
    if (!claude) return this.o.pi.side;
    if (id) return isClaudeSide(id) ? claude.side : this.o.pi.side;
    // A fork names the conversation's transcript: whoever wrote it answers.
    if (fork && typeof (claude as { ownsFile?: (f: string) => boolean }).ownsFile === "function") {
      return (claude as unknown as { ownsFile: (f: string) => boolean }).ownsFile(fork) ? claude.side : this.o.pi.side;
    }
    return this.chosen(undefined).side;
  }

  get paths(): { sessionsDir: string; instrDir: string } {
    return this.o.pi.paths;
  }

  // -- background work
  background(parentThreadId: string, a: Record<string, unknown>, onStarted?: (id: string) => void, boardMake?: Parameters<EngineBackend["background"]>[3]): Promise<Record<string, unknown>> {
    return this.of(parentThreadId).background(parentThreadId, a, onStarted, boardMake);
  }

  async subagentControl(childId: string, op: "steer" | "stop", text?: string): Promise<{ ok: boolean; error?: string }> {
    // A child's id is its own engine's, not a thread id: ask the one that knows it.
    for (const b of this.all()) {
      if (b.liveChild?.(childId) || b.endedChild?.(childId)) return b.subagentControl(childId, op, text);
    }
    return this.o.pi.subagentControl(childId, op, text);
  }

  detach(parentThreadId: string): Detached[] {
    return this.of(parentThreadId).detach(parentThreadId);
  }

  liveChildren(parentThreadId: string): LiveChild[] {
    return this.of(parentThreadId).liveChildren(parentThreadId);
  }

  /** Headroom is per account, not per thread: any engine that is out holds back the host's own work. */
  usageLimit(): { resetsAt: number | null; kind: string | null } | null {
    for (const b of this.all()) {
      const l = b.usageLimit?.();
      if (l) return l;
    }
    return null;
  }

  cancelContinuation(threadId: string): Promise<boolean> {
    return this.of(threadId).cancelContinuation?.(threadId) ?? Promise.resolve(false);
  }

  liveChild(childId: string): LiveChild | null {
    for (const b of this.all()) {
      const hit = b.liveChild?.(childId);
      if (hit) return hit;
    }
    return null;
  }

  endedChild(childId: string): { state: string; endedAt: number } | null {
    for (const b of this.all()) {
      const hit = b.endedChild?.(childId);
      if (hit) return hit;
    }
    return null;
  }
}
