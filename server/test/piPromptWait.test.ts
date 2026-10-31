// Offline transport/backend contract, not real Main/UI proof.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PiBackend } from "../engine/pi/backend";
import { PiProc } from "../engine/pi/proc";

function fixture() {
  const p = new PiProc({ argv: [], cwd: "/tmp", env: {}, key: null });
  const sent: any[] = [];
  (p as any).child = { stdin: { write: (s: string) => sent.push(JSON.parse(s)) } };
  const event = (e: any) => (p as any).onData(JSON.stringify(e) + "\n");
  const answer = (i = 0, result: any = { success: true }) => event({ id: sent[i].id, type: "response", ...result });
  const t = { id: "same-session", proc: p, model: "fixture", lastUsed: 0, turnId: null };
  const b = Object.setPrototypeOf(new EventEmitter(), PiBackend.prototype) as PiBackend;
  Object.assign(b, { o: { thinking: "off" }, threads: new Map([[t.id, t]]), subs: { stopAll: () => {} } });
  return { p, b, t, sent, event, answer };
}
afterEach(() => vi.useRealTimers());

describe("native prompt preflight ownership", () => {
  it("awaits the original native response beyond 98s without a compaction mirror or resend", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const wait = f.b.startTurn(f.t.id, { texts: ["actual user"], images: [], model: "fixture", turnId: "caller-turn" }).finally(() => settled = true);
    f.event({ type: "compaction_start", reason: "threshold" });
    await vi.advanceTimersByTimeAsync(98000);
    expect(settled).toBe(false);
    expect(f.t.turnId).toBe("caller-turn");
    f.event({ type: "compaction_end", aborted: false });
    f.answer();
    expect(await wait).toEqual({ turnId: "caller-turn" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ type: "prompt", message: "actual user" });
    expect((f.p as any).pending.size).toBe(0);
  });

  it("does not interpret a failed compaction event as acceptance; preserves native rejection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const wait = f.b.startTurn(f.t.id, { texts: ["actual"], images: [], model: "fixture", turnId: "caller-turn" }).catch(e => e);
    f.event({ type: "compaction_start" });
    await vi.advanceTimersByTimeAsync(98000);
    f.event({ type: "compaction_end", errorMessage: "summary failed", aborted: false });
    f.answer(0, { success: false, error: "native preflight rejected" });
    expect((await wait).message).toBe("native preflight rejected");
    expect(f.t.turnId).toBeNull();
    expect(f.sent).toHaveLength(1);
  });

  it("still deadlines inspection while the native prompt is pending and preserves abort correlation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const wait = f.b.startTurn(f.t.id, { texts: ["actual"], images: [], model: "fixture", turnId: "caller-turn" }).catch(e => e);
    f.event({ type: "compaction_start" });
    const state = f.p.request({ type: "get_state" }, 60000).catch(e => e);
    await vi.advanceTimersByTimeAsync(61000);
    expect((await state).message).toContain("did not answer get_state");
    const abort = f.b.interrupt(f.t.id, "caller-turn");
    f.answer(2); // clear_queue
    await Promise.resolve();
    expect(f.sent[3].type).toBe("abort");
    f.event({ type: "compaction_end", aborted: true });
    f.answer(0, { success: false, error: "native preflight aborted" });
    f.answer(3);
    await abort;
    expect((await wait).message).toBe("native preflight aborted");
    expect(f.t.turnId).toBeNull();
    expect(f.sent.map(x => x.type)).toEqual(["prompt", "get_state", "clear_queue", "abort"]);
    expect((f.p as any).pending.size).toBe(0);
  });

  it("rejects an unbounded operation wait when its own offline subprocess exits", async () => {
    const p = new PiProc({ argv: [process.execPath, "-e", 'process.stdin.once("data", () => process.exit(7))'], cwd: "/tmp", env: {}, key: null });
    p.start();
    try {
      await expect(p.request({ type: "prompt", message: "fixture" }, 0)).rejects.toThrow("pi exited (7)");
      expect((p as any).pending.size).toBe(0);
    } finally { await p.close(); }
  });
});
