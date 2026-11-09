// A client retry of an intent (same rid) after a dropped connection never applies it twice (server/http.ts dedupeIntent).
import { describe, it, expect } from "vitest";
import { dedupeIntent } from "../intentDedupe";
import { withRetry } from "../../src/boxRetry";

describe("intent retry", () => {
  it("runs once per rid, even when the retry arrives while the first is still running", async () => {
    let runs = 0;
    const slow = () => new Promise<Record<string, unknown>>((r) => setTimeout(() => (runs++, r({ ok: true, n: runs })), 30));
    const [a, b] = await Promise.all([dedupeIntent("v:r1", slow), dedupeIntent("v:r1", slow)]);
    expect(runs).toBe(1);
    expect(b).toEqual(a);
    await dedupeIntent("v:r1", slow);
    expect(runs).toBe(1);
    await dedupeIntent("v:r2", slow);
    expect(runs).toBe(2);
  });
  it("no rid: always runs", async () => {
    let runs = 0;
    const f = async () => ({ ok: true, n: ++runs });
    await dedupeIntent("v:", f);
    await dedupeIntent("v:", f);
    expect(runs).toBe(2);
  });
  it("withRetry survives a killed first connection, and gives up after the window", async () => {
    let calls = 0;
    const waits: number[] = [];
    const ok = await withRetry(async () => { if (++calls === 1) throw new Error("error sending request for url"); return "done"; }, [300, 700], async (ms) => void waits.push(ms));
    expect(ok).toBe("done");
    expect(waits).toEqual([300]);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("down"); }, [1, 1, 1], async () => {})).rejects.toThrow("down");
    expect(calls).toBe(4);
  });
});
