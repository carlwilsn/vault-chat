import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushGate, resetAttention, type PushOffer } from "../pushGate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineNotify } from "../engine";

const offer = (extra: Partial<PushOffer> = {}): PushOffer => ({
  vault: "/synthetic/push-opt-in", why: "finished", title: "Done: requested work", body: "Written.",
  url: "/phone?conv=synthetic", tag: "synthetic", convId: "synthetic", trigger: "Notify", byCarl: true, ...extra,
});
let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vc-push-opt-in-")); });
afterEach(() => { resetAttention(); rmSync(vault, { recursive: true, force: true }); });

describe("push opt-in", () => {
  it("missing preference is off for finishes, questions, failures and sync alerts", async () => {
    const send = vi.fn(async () => 1);
    const g = new PushGate({ send, log: () => {} });
    for (const extra of [{}, { why: "ask", trigger: "AskUser" }, { why: "failed" }, { why: "failed", trigger: "box sync", convId: null }] as Partial<PushOffer>[]) {
      expect((await g.offer(offer(extra))).act).toBe("drop");
    }
    expect(send).not.toHaveBeenCalled();
    expect(g.pending()).toHaveLength(0);
  });
  it("one explicit Notify event sends once, never arming later alerts", async () => {
    const send = vi.fn(async () => 1);
    const g = new PushGate({ send, log: () => {} });
    const requested = offer({ explicitPush: true, workId: "original-user-turn", eventId: "event-1" });
    expect((await g.offer(requested)).sent).toBe(1);
    expect((await g.offer(requested)).act).toBe("drop");
    expect((await g.offer({ ...requested, title: "Same event, new preview" })).act).toBe("drop");
    expect((await g.offer({ ...requested, eventId: "repeated-invocation" })).act).toBe("drop");
    for (const why of ["ask", "failed", "finished"] as const) await g.offer(offer({ why, title: "Unrelated later alert" }));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("an explicit requested failure waits for away once; explicit finish while looking is seen there", async () => {
    let looking = true;
    const send = vi.fn(async () => 1);
    const g = new PushGate({ send, attention: () => ({ looking, where: "laptop" }), log: () => {} });
    try {
      expect((await g.offer(offer({ explicitPush: true, workId: "work", eventId: "finish" }))).act).toBe("drop");
      expect((await g.offer(offer({ why: "failed", explicitPush: true, workId: "work", eventId: "failure" }))).act).toBe("hold");
      looking = false;
      await g.tick(); await g.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(g.pending()).toHaveLength(0);
    } finally { g.stop(); }
  });
  it("explicit argument alone cannot authorize questions, unbound or background callers", async () => {
    const send = vi.fn(async () => 1);
    const g = new PushGate({ send, log: () => {} });
    for (const extra of [{}, { byCarl: false, workId: "background" }, { why: "ask", workId: "user-turn" }, { trigger: "turn end", workId: "user-turn" }]) {
      await g.offer(offer({ explicitPush: true, eventId: "event-1", ...extra } as Partial<PushOffer>));
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("legacy true alone restores old rules; turning off drops held legacy failures", async () => {
    const send = vi.fn(async () => 1);
    let legacy = true;
    let looking = true;
    const g = new PushGate({ send, legacyEnabled: () => legacy, attention: () => ({ looking, where: "laptop" }), log: () => {} });
    expect((await g.offer(offer({ why: "failed" }))).act).toBe("hold");
    legacy = false; looking = false;
    await g.tick();
    expect(send).not.toHaveBeenCalled();
    expect(g.pending()).toHaveLength(0);
    legacy = true;
    expect((await g.offer(offer({ why: "ask", trigger: "AskUser" }))).sent).toBe(1);
  });
  it("explicit scoped Notify reaches the existing transport once without muting the in-app feed", async () => {
    const sendPush = vi.fn(async () => 1);
    const feed: string[] = [];
    const notify = engineNotify({ vault, sendPush, notificationAppend: (_v: string, line: string) => feed.push(line) } as any);
    const notice = { kind: "info" as const, convId: "requested", title: "Done: requested", body: "Saved", why: "finished" as const, byCarl: true, trigger: "Notify", explicitPush: true, workId: "original-user-turn" };
    await notify(notice);
    await notify(notice);
    await notify({ kind: "info", convId: "ordinary", title: "Done: ordinary", body: "Saved", why: "finished", byCarl: true, trigger: "Notify" });
    expect(feed).toHaveLength(3);
    expect(sendPush).toHaveBeenCalledExactlyOnceWith("Done: requested", "Saved", "/phone?conv=requested", "requested");
  });
  it("in-app Notify remains delivered with zero transport calls by default", async () => {
    const sendPush = vi.fn(async () => 1);
    const feed: string[] = [];
    const notify = engineNotify({ vault, sendPush, notificationAppend: (_v: string, line: string) => feed.push(line) } as any);
    await notify({ kind: "info", convId: "synthetic", title: "Done", body: "Saved", why: "finished", byCarl: true, trigger: "Notify" });
    await notify({ kind: "ask", convId: "synthetic", title: "Question", body: "Which?" });
    expect(feed).toHaveLength(2);
    expect(sendPush).not.toHaveBeenCalled();
  });
});
