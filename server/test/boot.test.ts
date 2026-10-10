// Boot the real bundle on a temp vault with a fake OpenRouter, then drive the
// phone routes the way the phone does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

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
    expect(h.keys).toEqual({ openrouter: true });
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

  it("/message {mission} starts a mission that runs one scripted turn and writes its file", async () => {
    const r = await post("/message", { mission: { title: "Test mission", goal: "Write a haiku.\n\nDone when:\n- a haiku exists" } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.mission).toBe("Test mission");
    missionId = j.convId;
    expect(missionId).toBeTruthy();
    // The scripted reply lands in the conversation file on disk.
    const file = await waitFor(() => {
      const dir = join(vault, ".vault-chat", "conversations");
      const f = readdirSync(dir).find((n) => n.endsWith(".jsonl") && readFileSync(join(dir, n), "utf8").includes(missionId));
      if (!f) return null;
      const body = readFileSync(join(dir, f), "utf8");
      return body.includes("Acknowledged. I have the brief") ? body : null;
    }, 60_000);
    const meta = JSON.parse(file.split("\n")[0]!);
    expect(meta.source).toBe("mission");
    expect(meta.title).toBe("Test mission");
    expect(or.calls.length).toBeGreaterThan(0);
    expect(or.calls.some((c) => c.model === "openai/gpt-5.6-sol")).toBe(true);
    // And the phone sees it.
    const list = await (await get("/conversations")).json();
    expect(list.conversations.some((c: any) => c.id === missionId && c.source === "mission")).toBe(true);
    const conv = await (await get(`/conversation?id=${missionId}`)).json();
    expect(conv.messages.some((m: any) => String(m.content).includes("Acknowledged"))).toBe(true);
  });

  it("/answer resumes the mission with a tagged answer", async () => {
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

  it("unknown routes 404", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});
