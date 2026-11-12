// Stage 1.3 of the plugin refactor: a live page's `converse` service (src/pluginConverse.ts, server/liveProxy.ts),
// end to end on the real box with the real engine (its model answered by the scripted stand-in API). A page granted
// `converse` starts a conversation that appears in the chat list, sends to it, lists the chats and reads one; its
// messages are marked as the page's in the log and the agent is told which page sent them. It can do nothing else to
// a chat (delete, rename, stop…), and a page without the grant reaches none of it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";

let home: string, vault: string, secrets: string;
let or: FakeApi;
let srv: Running;

const post = async (p: string, b: unknown) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, json: (await r.json()) as any };
};
const get = async (p: string) => (await fetch(srv.base + p)).json() as Promise<any>;

/** A page in the vault with these services, Carl's Allow, and its token (as the app gets it). */
async function page(rel: string, caps: string): Promise<string> {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), `<meta name="vc-capabilities" content="${caps}"><button>go</button>`);
  const m = await post("/api/v2/live/manifest", { path: rel });
  expect(m.status).toBe(200);
  const t = await post("/api/v2/live/token", { path: rel, hash: m.json.hash, caps: m.json.caps });
  expect(t.status).toBe(200);
  return t.json.token;
}

/** One call the page makes (vc.fetch), through the box's gateway: the box's answer to the page. */
async function call(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const out = await post("/api/v2/live/fetch", {
    token,
    method,
    path,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { bodyBase64: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64") } : {}),
  });
  if (out.status !== 200) return out;
  return { status: out.json.status, json: JSON.parse(Buffer.from(out.json.bodyBase64, "base64").toString("utf8")) };
}

const userEntries = (events: any[]) => events.filter((r) => r.type === "entry" && r.entry?.message?.role === "user" && r.clientId);
const replied = (events: any[], n: number) => events.filter((r) => r.type === "entry" && r.entry?.message?.role === "assistant").length >= n;

beforeAll(async () => {
  home = tmp("vcpc-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
  or = await fakeAnthropic("Noted, from the page.");
  srv = await startServer({ home, vault, secrets, anthropic: or.url });
}, 90_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("a page's converse service", () => {
  let token = "";
  let conv = "";

  it("a page starts a conversation that appears in the chat list, and the agent answers it", async () => {
    token = await page("apps/planner.html", "converse");
    const started = await call(token, "POST", "/api/v2/intent", { type: "start", text: "Plan my week from the planner page", convId: "main", via: "chat" });
    expect(started.status).toBe(200);
    expect(started.json.ok).toBe(true);
    conv = started.json.convId;
    // A new chat (the box chose its id; the page could not aim it at Main).
    expect(conv).toMatch(/^[0-9a-f-]{36}$/);
    const list = await get("/api/v2/conversations");
    const row = list.rows.find((r: any) => r.id === conv);
    expect(row).toBeTruthy();
    expect(row.title).toBe("Plan my week from the planner page");
    // The page reads it back the same way: the chat list, then its records.
    const rows = await call(token, "GET", "/api/v2/conversations");
    expect(rows.status).toBe(200);
    expect(rows.json.rows.map((r: any) => r.id)).toContain(conv);
    const events = await waitFor(async () => {
      const r = await call(token, "GET", `/api/v2/conversations/${conv}/events?after=0`);
      return r.status === 200 && replied(r.json.events, 1) ? r.json.events : null;
    }, 60_000);
    const mine = userEntries(events);
    expect(mine).toHaveLength(1);
    // Marked as the page's in the log (who acted), shown as the page's words.
    expect(mine[0]).toMatchObject({ shown: "Plan my week from the planner page", via: "page" });
    expect(String(mine[0].clientId)).toMatch(/^page-/);
    // The agent is told which page sent it.
    expect(JSON.stringify(or.calls)).toContain("apps/planner.html");
  }, 90_000);

  it("a page sends into a chat that exists, and reads only what came after its cursor", async () => {
    const first = await call(token, "GET", `/api/v2/conversations/${conv}/events?after=0`);
    const cursor = first.json.next as number;
    const sent = await call(token, "POST", "/api/v2/intent", { type: "send", convId: conv, text: "And Friday?" });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ ok: true, convId: conv });
    const later = await waitFor(async () => {
      const r = await call(token, "GET", `/api/v2/conversations/${conv}/events?after=${cursor}`);
      return r.status === 200 && replied(r.json.events, 1) ? r.json.events : null;
    }, 60_000);
    expect(later.every((r: any) => r.seq > cursor)).toBe(true);
    expect(userEntries(later).map((r: any) => [r.shown, r.via])).toEqual([["And Friday?", "page"]]);
    // Still one chat: send never makes a new one.
    expect((await get("/api/v2/conversations")).rows.filter((r: any) => r.title === "Plan my week from the planner page")).toHaveLength(1);
  }, 90_000);

  it("send to a chat that does not exist is refused, and a page can do nothing else to a chat", async () => {
    const before = (await get("/api/v2/conversations")).rows.length;
    expect((await call(token, "POST", "/api/v2/intent", { type: "send", convId: "no-such-chat-123", text: "hi" })).status).toBe(404);
    expect((await get("/api/v2/conversations")).rows.length).toBe(before);
    for (const type of ["delete", "renameConversation", "stop", "compact", "deleteProject"]) {
      const r = await call(token, "POST", "/api/v2/intent", { type, convId: conv, title: "x", slug: "x" });
      expect(r.status, type).toBe(403);
    }
    expect((await get("/api/v2/conversations")).rows.find((r: any) => r.id === conv)?.title).toBe("Plan my week from the planner page");
    expect((await call(token, "POST", "/api/v2/intent", { type: "start", text: "   " })).status).toBe(400);
    // Only the declared routes: no checkpoint, no other box route.
    expect((await call(token, "GET", `/api/v2/conversations/${conv}/checkpoint`)).status).toBe(403);
    expect((await call(token, "POST", "/message", { text: "hi" })).status).toBe(403);
  }, 60_000);

  it("a page without converse reaches none of it; the ask stays ephemeral", async () => {
    const before = (await get("/api/v2/conversations")).rows.length;
    for (const caps of ["ask", "persist", "state, log"]) {
      const t = await page(`apps/no-${caps.replace(/\W+/g, "-")}.html`, caps);
      expect((await call(t, "POST", "/api/v2/intent", { type: "start", text: "hello" })).status, caps).toBe(403);
      expect((await call(t, "GET", "/api/v2/conversations")).status, caps).toBe(403);
      expect((await call(t, "GET", `/api/v2/conversations/${conv}/events`)).status, caps).toBe(403);
    }
    const askT = await page("apps/ask-converse.html", "ask, converse");
    expect((await call(askT, "POST", "/api/v1/side", { text: "hi", persist: true })).status).toBe(403);
    expect((await get("/api/v2/conversations")).rows.length).toBe(before);
  }, 60_000);
});
