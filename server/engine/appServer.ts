// One `codex app-server` child over stdio (newline-delimited JSON-RPC without
// a "jsonrpc" field), supervised: restarted on exit with backoff. The OpenRouter
// key goes only into the child's environment. Every server→client request is
// answered (a turn waits on them); unknown ones get an empty result.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;

export type SupervisorOptions = {
  bin: string;
  codexHome: string;
  env: () => NodeJS.ProcessEnv;
  /** Called before each spawn (regenerate config.toml). */
  beforeStart?: () => void;
  onServerRequest: ServerRequestHandler;
  clientVersion: string;
  log?: (msg: string) => void;
};

export type SupervisorHealth = {
  state: "starting" | "up" | "down" | "stopped";
  pid: number | null;
  restarts: number;
  startedAt: number | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  lastError: string | null;
};

/** Events: "notification" (msg), "up" (pid), "down" (exit info). */
export class CodexSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; t: NodeJS.Timeout | null; method: string }>();
  private stopped = false;
  private backoffMs = 1000;
  private healthyTimer: NodeJS.Timeout | null = null;
  private readyWaiters: (() => void)[] = [];
  readonly health: SupervisorHealth = { state: "stopped", pid: null, restarts: 0, startedAt: null, lastExit: null, lastError: null };

  constructor(private o: SupervisorOptions) {
    super();
    this.setMaxListeners(100);
  }

  private log(m: string): void {
    (this.o.log ?? ((s) => console.log(`[codex] ${s}`)))(m);
  }

  start(): void {
    this.stopped = false;
    void this.spawnOnce();
  }

  stop(): void {
    this.stopped = true;
    this.health.state = "stopped";
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }

  isUp(): boolean {
    return this.health.state === "up";
  }

  /** Resolve when the app-server has finished its handshake (or after ms). */
  ready(ms = 60_000): Promise<boolean> {
    if (this.isUp()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.readyWaiters.push(done);
    });
  }

  /** For tests: kill -9 the child. */
  killHard(): number | null {
    const pid = this.child?.pid ?? null;
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    return pid;
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopped) return;
    this.health.state = "starting";
    try {
      this.o.beforeStart?.();
    } catch (e) {
      this.health.lastError = `config: ${(e as Error).message}`;
      this.log(this.health.lastError);
    }
    let child: ChildProcess;
    try {
      child = spawn(this.o.bin, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...this.o.env(), CODEX_HOME: this.o.codexHome },
        windowsHide: true,
      });
    } catch (e) {
      this.health.lastError = `spawn: ${(e as Error).message}`;
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.health.pid = child.pid ?? null;
    let stderrTail = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      this.health.lastError = `child: ${e.message}`;
    });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.healthyTimer) clearTimeout(this.healthyTimer);
      this.health.pid = null;
      this.health.lastExit = { code, signal, at: Date.now() };
      if (stderrTail.trim()) this.health.lastError = stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      for (const [, p] of this.pending) {
        if (p.t) clearTimeout(p.t);
        p.rej(new Error(`codex app-server exited during ${p.method}`));
      }
      this.pending.clear();
      const wasStopped = this.stopped;
      this.health.state = wasStopped ? "stopped" : "down";
      this.log(`app-server exited (code ${code}, signal ${signal})${wasStopped ? "" : ` — restarting in ${this.backoffMs} ms`}`);
      this.emit("down", { code, signal });
      if (!wasStopped) this.scheduleRestart();
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "vault-chat", title: "vault-chat", version: this.o.clientVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, 30_000);
      this.notify("initialized", {});
    } catch (e) {
      this.health.lastError = `initialize: ${(e as Error).message}`;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      return;
    }
    if (this.child !== child) return;
    this.health.state = "up";
    this.health.startedAt = Date.now();
    this.log(`app-server up (pid ${child.pid})`);
    // Reset the backoff only after a minute of health.
    this.healthyTimer = setTimeout(() => (this.backoffMs = 1000), 60_000);
    this.healthyTimer.unref?.();
    for (const w of this.readyWaiters.splice(0)) w();
    this.emit("up", child.pid);
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.health.restarts++;
    setTimeout(() => void this.spawnOnce(), wait).unref?.();
  }

  private write(msg: RpcMessage): void {
    const c = this.child;
    if (!c || !c.stdin || c.stdin.destroyed) throw new Error("codex app-server is not running");
    c.stdin.write(JSON.stringify(msg) + "\n");
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    return new Promise<T>((res, rej) => {
      const id = this.nextId++;
      const t = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs) : null;
      this.pending.set(id, { res, rej, t, method });
      try {
        this.write({ id, method, params });
      } catch (e) {
        if (t) clearTimeout(t);
        this.pending.delete(id);
        rej(e as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private onLine(line: string): void {
    let m: RpcMessage;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method) {
      const id = m.id;
      void this.o
        .onServerRequest(m.method, m.params)
        .then((result) => this.write({ id, result: result ?? {} }))
        .catch((e) => {
          try {
            this.write({ id, error: { code: -32000, message: String((e as Error)?.message ?? e) } });
          } catch {
            /* child gone */
          }
        });
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (p.t) clearTimeout(p.t);
      if (m.error) p.rej(Object.assign(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`), { rpc: m.error }));
      else p.res(m.result);
      return;
    }
    if (m.method) this.emit("notification", m);
  }
}
