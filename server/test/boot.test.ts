// Boot the real bundle on a temp vault with a fake OpenRouter, then drive the
// phone routes the way the phone does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, fakePushService, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

const TOKEN = "canary-phone-token-0000";

describe("boot + phone routes", () => {
  let home: string;
  let vault: string;
  let secrets: string;
  let or: FakeOpenRouter;
  let srv: Running;

  const env = () => ({
    home,
    vault,
    secrets,
    openrouter: or.url,
    token: TOKEN,
  });

  beforeAll(async () => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
    // Missions/workers on an OpenRouter model (the seed defaults are Anthropic).
    writeFileSync(
      join(home, "mission-engine.localstorage"),
      JSON.stringify({
        vault_chat_supervisor_model: "openai/gpt-5.6-sol",
        vault_chat_worker_model: "openai/gpt-5.6-sol",
        vault_chat_model: "openai/gpt-5.6-sol",
      }),
    );
    or = await fakeOpenRouter("Acknowledged. I have the brief and I am starting.");
    srv = await startServer(env());
    expect(srv.logs()).toContain("listening on");
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  const get = (p: string, h: Record<string, string> = {}) => fetch(srv.base + p, { headers: h });
  const post = (p: string, body: unknown) =>
    fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("health reports version, keys, git, busy", async () => {
    const h = await (await get("/api/v1/health")).json();
    expect(h.ok).toBe(true);
    expect(h.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.git).toBe("ok");
    expect(h.keys).toEqual({ openrouter: true, elevenlabs: false });
    expect(typeof h.busy.runs).toBe("number");
    expect(srv.logs()).not.toContain("sk-or-canary-not-real");
  });

  it("/status answers through the in-process relay", async () => {
    const r = await get("/status");
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.vault).toBe("vault");
    expect(Array.isArray(s.runs)).toBe(true);
    expect(Array.isArray(s.schedules)).toBe(true);
  });

  it("/conversations lists from disk", async () => {
    const r = await (await get("/conversations")).json();
    expect(r.vault).toBe("vault");
    expect(Array.isArray(r.conversations)).toBe(true);
  });

  it("/phone serves the shell with the token cookie", async () => {
    const r = await get("/phone");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("vc_token=");
    expect(await r.text()).toContain("<html");
    expect((await get("/phone-sw.js")).status).toBe(200);
    expect((await get("/apple-touch-icon.png")).headers.get("content-type")).toBe("image/png");
  });

  let missionId = "";

  it("/message with no conversation is Main's: one scripted turn into its log (never a conversation file)", async () => {
    const r = await post("/message", { text: "Write a haiku." });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    missionId = j.convId;
    expect(missionId).toBeTruthy();
    // The scripted reply lands in the conversation's log on disk.
    const recs = await waitFor(() => {
      const f = join(vault, ".vault-chat", "events", `${missionId}.jsonl`);
      let body = "";
      try {
        body = readFileSync(f, "utf8");
      } catch {
        return null;
      }
      const rs = body.trim().split("\n").map((l) => JSON.parse(l));
      return rs.some((x) => x.type === "meta" && x.patch.running === null) ? rs : null;
    }, 60_000);
    expect(missionId).toBe("main");
    expect(recs[0]).toMatchObject({ type: "meta", conv: missionId, patch: { source: "main", kind: "main" } });
    // The reply streamed (pi's deltas), then pi's own entry: on disk a pointer into its session file.
    expect(recs.filter((x: any) => x.type === "live" && x.ev.assistantMessageEvent?.type === "text_delta").map((x: any) => x.ev.assistantMessageEvent.delta).join("")).toContain("Acknowledged. I have the brief");
    const entries = recs.filter((x: any) => x.type === "entry");
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every((x: any) => typeof x.file === "string" && typeof x.id === "string" && !("entry" in x))).toBe(true);
    expect(existsSync(join(vault, ".vault-chat", "conversations", `${missionId}.jsonl`))).toBe(false);
    expect(or.calls.length).toBeGreaterThan(0);
    // And the phone sees it.
    const list = await (await get("/conversations")).json();
    expect(list.conversations.some((c: any) => c.id === missionId)).toBe(true);
    const conv = await (await get(`/conversation?id=${missionId}`)).json();
    expect(conv.messages.some((m: any) => String(m.content).includes("Acknowledged"))).toBe(true);
  });

  it("/answer sends the answer as the next message in the conversation", async () => {
    await waitFor(async () => (await (await get("/api/v1/health")).json()).busy.runs === 0, 60_000);
    const before = or.calls.length;
    or.reply = "Thanks, going with option A.";
    const r = await post("/answer", { convId: missionId, text: "Option A", clientMsgId: "ans-1" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.convId).toBe(missionId);
    await waitFor(() => or.calls.length > before, 30_000);
    const conv = await waitFor(async () => {
      const c = await (await get(`/conversation?id=${missionId}`)).json();
      return c.messages.some((m: any) => String(m.content).includes("going with option A")) ? c : null;
    }, 60_000);
    expect(conv.messages.some((m: any) => m.role === "user" && String(m.content).includes("Option A"))).toBe(true);
  });

  it("/answer without text is refused like the desktop", async () => {
    const j = await (await post("/answer", { convId: missionId })).json();
    expect(j.error).toMatch(/convId and non-empty text/);
  });

  // What `tailscale serve` adds for a tailnet user (the laptop / the phone).
  const viaServe = {
    "content-type": "application/json",
    "x-forwarded-for": "100.64.0.7",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "carwilson0929@gmail.com",
  };

  it("/message and /answer work through serve with the identity header and no token", async () => {
    const r = await fetch(srv.base + "/message", { method: "POST", headers: viaServe, body: JSON.stringify({ text: "Say hi." }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    await waitFor(async () => (await (await get("/api/v1/health")).json()).busy.runs === 0, 60_000);
    const a = await fetch(srv.base + "/answer", { method: "POST", headers: viaServe, body: JSON.stringify({ convId: j.convId, text: "go" }) });
    expect(a.status).toBe(200);
    expect((await a.json()).ok).toBe(true);
    // Its turn ends here, not under the next test (busy counts a turn from when it is accepted).
    await waitFor(async () => (await (await get("/api/v1/health")).json()).busy.runs === 0, 60_000);
    const bad = await fetch(srv.base + "/message", { method: "POST", headers: { ...viaServe, "tailscale-user-login": "x@y.z" }, body: "{}" });
    expect(bad.status).toBe(401);
  });

  it("/api/v1/alert delivers a Web Push with the alert's tag", async () => {
    const push = await fakePushService();
    try {
      const sub = await fetch(srv.base + "/push/subscribe", { method: "POST", headers: viaServe, body: JSON.stringify({ subscription: push.subscription }) });
      expect(sub.status).toBe(200);
      const vapid = await (await get("/push/vapid")).json();
      expect(vapid.key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
      const r = await fetch(srv.base + "/api/v1/alert", {
        method: "POST",
        headers: viaServe,
        body: JSON.stringify({ title: "Sync conflict", body: "notes/a.md", tag: "vc-sync-conflict-vault" }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).sent).toBe(1);
      expect(push.received).toHaveLength(1);
      expect(push.received[0]!.payload).toMatchObject({ title: "Sync conflict", body: "notes/a.md", tag: "vc-sync-conflict-vault" });
      expect(String(push.received[0]!.headers.authorization)).toMatch(/^vapid t=.+, k=/);
      // Unsubscribe again so later tests see no subscriptions.
      await fetch(srv.base + "/push/unsubscribe", { method: "POST", headers: viaServe, body: JSON.stringify({ endpoint: push.subscription.endpoint }) });
    } finally {
      await push.close();
    }
  });

  it("the push rule: an alert waits while Carl is at a screen; a recovery never buzzes; a dead subscription is dropped", async () => {
    const push = await fakePushService();
    const dead = await fakePushService(400);
    const subsFile = join(home, "phone-push-subs.json");
    const subs = () => (JSON.parse(readFileSync(subsFile, "utf8")) as { endpoint: string; refusals?: number }[]).map((s) => [s.endpoint, s.refusals ?? 0]);
    const alert = (b: Record<string, unknown>) => fetch(srv.base + "/api/v1/alert", { method: "POST", headers: viaServe, body: JSON.stringify(b) }).then((r) => r.json());
    const attention = (looking: boolean) => fetch(srv.base + "/api/v1/attention", { method: "POST", headers: viaServe, body: JSON.stringify({ device: "laptop", looking, convId: "main" }) });
    try {
      for (const s of [push.subscription, dead.subscription]) await fetch(srv.base + "/push/subscribe", { method: "POST", headers: viaServe, body: JSON.stringify(s) });
      expect((await fetch(srv.base + "/api/v1/attention", { method: "POST", headers: viaServe, body: JSON.stringify({ device: "toaster", looking: true }) })).status).toBe(400);
      // At the laptop: held.
      expect((await attention(true)).status).toBe(200);
      expect((await alert({ title: "Needs you: sync conflict in school2", body: "notes/a.md", tag: "vc-sync-conflict-school2" })).sent).toBe(0);
      expect(push.received).toHaveLength(0);
      // Fixed itself: never.
      expect((await alert({ title: "Server update failed", body: "rolled back", tag: "vault-chat-update", needsYou: false })).sent).toBe(0);
      // He leaves: the held alert goes out (the gate looks again every 15 s).
      await attention(false);
      await waitFor(async () => push.received.length === 1, 30_000);
      expect(push.received[0]!.payload).toMatchObject({ title: "Needs you: sync conflict in school2", tag: "vc-sync-conflict-school2" });
      expect(srv.logs()).toMatch(/\[push\] held trigger=laptop sync why=failed "Needs you: sync conflict in school2" — Carl is looking \(laptop\)/);
      expect(srv.logs()).toMatch(/\[push\] dropped trigger=self-update why=failed "Server update failed" — nothing for Carl to do/);
      // The 400s: the dead subscription refused that push and two more; the third refusal removes it.
      // (The held push goes to both phones in turn: the good one answers first, so wait for the refusal to be written.)
      await waitFor(async () => subs().some(([e, n]) => e === dead.subscription.endpoint && n === 1), 10_000);
      for (const n of [2, 3]) expect((await alert({ title: `Needs you: test ${n}`, body: "x", tag: `t${n}` })).sent).toBe(1);
      expect(subs()).toEqual([[push.subscription.endpoint, 0]]);
      expect(srv.logs()).toMatch(/answered 400: \{"reason":"BadJwtToken"\}/);
      expect(srv.logs()).toMatch(/push service answered 400 — the subscription is dead, removed/);
    } finally {
      await fetch(srv.base + "/push/unsubscribe", { method: "POST", headers: viaServe, body: JSON.stringify({ endpoint: push.subscription.endpoint }) });
      await fetch(srv.base + "/push/unsubscribe", { method: "POST", headers: viaServe, body: JSON.stringify({ endpoint: dead.subscription.endpoint }) });
      await push.close();
      await dead.close();
    }
  });

  it("a thread from the old missions system is archived: readable, never run", async () => {
    const dir = join(vault, ".vault-chat", "conversations");
    const now = Date.now();
    writeFileSync(
      join(dir, "old-mission.jsonl"),
      JSON.stringify({ id: "old-mission", title: "Old mission", source: "mission", status: "idle", createdAt: now, lastActivityAt: now, unread: false }) +
        "\n" +
        JSON.stringify({ role: "user", content: "MISSION BRIEF" }) +
        "\n",
    );
    const j = await (await post("/message", { convId: "old-mission", text: "status?" })).json();
    expect(j.error).toMatch(/archived/);
    // Refused before anything starts: nothing is busy, no turn was logged, and no model call ever
    // carried this thread (only its brief or this message would show it ran; other chats' calls don't count).
    expect((await (await get("/api/v1/health")).json()).busy.runs).toBe(0);
    const log = join(vault, ".vault-chat", "events", "old-mission.jsonl");
    const recs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    expect(recs.filter((x: any) => x.patch?.running || x.type === "live" || (x.type === "entry" && x.via !== "import"))).toEqual([]);
    expect(or.calls.filter((c: any) => /MISSION BRIEF|status\?/.test(JSON.stringify(c.messages ?? [])))).toEqual([]);
    const conv = await (await get("/conversation?id=old-mission")).json();
    expect(conv.messages.some((m: any) => String(m.content).includes("MISSION BRIEF"))).toBe(true);
  });

  it("projects: list, tag a conversation (creating the project), clear it", async () => {
    expect((await (await get("/projects")).json()).projects).toEqual([]);
    const r = await (await post("/conversation/project", { convId: missionId, project: "BitNet 160M" })).json();
    expect(r).toEqual({ ok: true, project: "bitnet-160m" });
    expect((await (await get("/projects")).json()).projects).toEqual([{ slug: "bitnet-160m", name: "BitNet 160M" }]);
    const row = (await (await get("/conversations")).json()).conversations.find((c: any) => c.id === missionId);
    expect(row.project).toBe("bitnet-160m");
    expect((await (await get(`/conversation?id=${missionId}`)).json()).project).toBe("bitnet-160m");
    expect(await (await post("/conversation/project", { convId: missionId, project: null })).json()).toEqual({ ok: true, project: null });
    expect((await (await post("/conversation/project", { convId: "nope", project: "x" })).json()).error).toMatch(/not found/);
  });

  it("the Claude/feedback screen's routes are gone", async () => {
    expect((await get("/feedback")).status).toBe(404);
    expect((await get("/coder-latest")).status).toBe(404);
    expect((await post("/alert-followup", {})).status).toBe(404);
  });

  it("unknown routes 404", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});
