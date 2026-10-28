// One pi process in RPC mode (strict JSONL over stdio, split on LF only — never
// readline, which also splits on U+2028). It runs in its own process group and,
// on Linux, inside bubblewrap with its own pid namespace, so killing it kills
// everything it started (pi's bash tool detaches its children into their own
// process groups; only the namespace or a cgroup catches those). The key goes
// in on fd 3 and the pipe is closed at once.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export type PiProcOptions = {
  /** argv[0] and the rest (the node binary, cli.js, pi's flags — or bwrap first). */
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to fd 3 then closed. */
  key: string | null;
  /** Private extension bootstrap, written once on fd 4; never inherited by bash. */
  bootstrap?: string;
  log?: (s: string) => void;
};

export type PiExit = { code: number | null; signal: string | null; at: number };

/** Events: "event" (a session event), "ui" (an extension_ui_request), "exit" (PiExit). */
export class PiProc extends EventEmitter {
  private child: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, { res: (v: any) => void; rej: (e: Error) => void; t: NodeJS.Timeout | null }>();
  exited: PiExit | null = null;
  readonly startedAt = Date.now();
  private exitWaiters: ((e: PiExit) => void)[] = [];
  stderrTail = "";

  constructor(private o: PiProcOptions) {
    super();
    this.setMaxListeners(100);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    const [cmd, ...args] = this.o.argv;
    const child = spawn(cmd!, args, {
      cwd: this.o.cwd,
      env: this.o.env,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      // Its own process group: the whole group is signalled on kill.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
    if (fd3) {
      (fd3 as any).on?.("error", () => undefined);
      fd3.end(this.o.key ? this.o.key + "\n" : "");
    }
    const fd4 = child.stdio[4] as NodeJS.WritableStream | null;
    if (fd4) {
      (fd4 as any).on?.("error", () => undefined);
      fd4.end(this.o.bootstrap ?? "");
    }
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onData(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.on("error", (e) => {
      this.stderrTail += `\n[spawn error] ${e.message}`;
    });
    child.on("exit", (code, signal) => {
      const ex: PiExit = { code, signal: signal ?? null, at: Date.now() };
      this.exited = ex;
      for (const [, p] of this.pending) {
        if (p.t) clearTimeout(p.t);
        p.rej(new Error(`pi exited (${signal ?? code})`));
      }
      this.pending.clear();
      // Whatever is left in the group (a detached child the namespace did not
      // take, when bubblewrap is unavailable) goes with it.
      this.killGroup("SIGKILL");
      for (const w of this.exitWaiters.splice(0)) w(ex);
      this.emit("exit", ex);
    });
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type === "response" && typeof o.id === "string" && this.pending.has(o.id)) {
        const p = this.pending.get(o.id)!;
        this.pending.delete(o.id);
        if (p.t) clearTimeout(p.t);
        p.res(o);
      } else if (o?.type === "extension_ui_request") {
        this.emit("ui", o);
      } else {
        this.emit("event", o);
      }
    }
  }

  isAlive(): boolean {
    return !!this.child && !this.exited;
  }

  /** Send a command and wait for its response ({success, data, error}). */
  request(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
    if (!this.isAlive()) return Promise.reject(new Error("pi is not running"));
    const id = `vc${++this.seq}`;
    return new Promise((res, rej) => {
      const t = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`pi did not answer ${String(cmd.type)} in ${timeoutMs} ms`));
      }, timeoutMs) : null;
      this.pending.set(id, { res, rej, t });
      this.write({ ...cmd, id });
    });
  }

  /** Fire-and-forget (extension_ui_response). */
  write(o: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(JSON.stringify(o) + "\n");
    } catch {
      /* gone */
    }
  }

  /** Signal the whole process group (and so, under bubblewrap, the namespace). */
  killGroup(sig: NodeJS.Signals = "SIGKILL"): void {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, sig);
      } catch {
        /* group gone */
      }
    }
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }

  waitExit(ms: number): Promise<PiExit | null> {
    if (this.exited) return Promise.resolve(this.exited);
    return new Promise((res) => {
      const t = setTimeout(() => res(null), ms);
      this.exitWaiters.push((e) => {
        clearTimeout(t);
        res(e);
      });
    });
  }

  /** Close stdin (pi exits on EOF), then kill the group if it lingers. */
  async close(graceMs = 3000): Promise<void> {
    if (!this.isAlive()) return;
    try {
      this.child?.stdin?.end();
    } catch {
      /* gone */
    }
    if (!(await this.waitExit(graceMs))) {
      this.killGroup("SIGKILL");
      await this.waitExit(5000);
    }
  }
}
