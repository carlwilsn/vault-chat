// Stage 1.2 of the plugin refactor: a live page's `state` and `log` services (src/liveServices.ts, server/pluginState.ts).
// State is records in the one log (plugin.state signals in the box's feed), so two views of one page (two tokens: the
// viewer and the chat's inline copy) read one state, a subscriber hears the other view's set, and it survives a restart.
// A page reaches only its own state; a page without the grant reaches nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcps-");
const vault = join(root, "vault");
mkdirSync(vault, { recursive: true });

let live: typeof import("../liveProxy");
let log: typeof import("../convlog/log");

beforeAll(async () => {
  // Hermetic: whatever VC_* the runner has must not shape this.
  for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_VAULT = vault;
  process.env.VC_TOKEN_FILE = join(root, "token");
  live = await import("../liveProxy");
  log = await import("../convlog/log");
});
afterAll(() => {
  log._resetConvLogs();
  cleanup(root);
});

function page(name: string, caps: string): string {
  writeFileSync(join(vault, name), `<meta name="vc-capabilities" content="${caps}"><button>count</button>`);
  const m = live.liveManifest(vault, name)!;
  const t = live.liveToken(vault, { path: name, hash: m.hash, caps: m.caps });
  expect(t.status).toBe(200);
  return (t.body as { token: string }).token;
}

async function call(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const out = await live.liveGateway(vault, null, {
    token,
    method,
    path,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { bodyBase64: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64") } : {}),
  });
  if (out.status !== 200) return { status: out.status, json: out.body };
  const o = out.body as { status: number; bodyBase64: string };
  return { status: o.status, json: JSON.parse(Buffer.from(o.bodyBase64, "base64").toString("utf8")) };
}

describe("a page's state service", () => {
  it("two views of one page show one counter", async () => {
    const viewer = page("counter.html", "state");
    const chat = page("counter.html", "state"); // a second token for the same page: the chat's inline copy
    expect(await call(viewer, "GET", "/api/v2/plugin/state")).toEqual({ status: 200, json: { seq: 0, state: {} } });
    const set = await call(viewer, "POST", "/api/v2/plugin/state", { key: "count", value: 1 });
    expect(set.status).toBe(200);
    expect(set.json.seq).toBeGreaterThan(0);
    const seen = await call(chat, "GET", "/api/v2/plugin/state");
    expect(seen).toEqual({ status: 200, json: { seq: set.json.seq, state: { count: 1 } } });
    await call(chat, "POST", "/api/v2/plugin/state", { key: "count", value: 2 });
    expect((await call(viewer, "GET", "/api/v2/plugin/state")).json.state).toEqual({ count: 2 });
    // A view that spells the page's path another way is still the same plugin.
    const m = live.liveManifest(vault, "./counter.html")!;
    const dotted = (live.liveToken(vault, { path: "./counter.html", hash: m.hash, caps: m.caps }).body as { token: string }).token;
    expect((await call(dotted, "GET", "/api/v2/plugin/state")).json.state).toEqual({ count: 2 });
  });

  it("a subscriber waiting on one view hears the other view's set; without a change it answers when its wait ends", async () => {
    const a = page("sub.html", "state");
    const b = page("sub.html", "state");
    const first = await call(a, "GET", "/api/v2/plugin/state?after=-1&wait=20000");
    expect(first.json).toEqual({ seq: 0, state: {} });
    const t0 = Date.now();
    const waiting = call(a, "GET", `/api/v2/plugin/state?after=${first.json.seq}&wait=20000`);
    await new Promise((r) => setTimeout(r, 150));
    const set = await call(b, "POST", "/api/v2/plugin/state", { key: "n", value: 7 });
    const woke = await waiting;
    expect(woke.json).toEqual({ seq: set.json.seq, state: { n: 7 } });
    expect(Date.now() - t0).toBeLessThan(5000);
    // An unrelated record (another page's set) does not end the wait early.
    const other = page("other.html", "state");
    const t1 = Date.now();
    const quiet = call(a, "GET", `/api/v2/plugin/state?after=${set.json.seq}&wait=600`);
    await call(other, "POST", "/api/v2/plugin/state", { key: "n", value: 1 });
    expect((await quiet).json).toEqual({ seq: set.json.seq, state: { n: 7 } });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(500);
  });

  it("each page reaches only its own state; null removes a key; bad input is refused", async () => {
    const a = page("own-a.html", "state");
    const b = page("own-b.html", "state");
    await call(a, "POST", "/api/v2/plugin/state", { key: "x", value: { deep: [1, 2] } });
    await call(a, "POST", "/api/v2/plugin/state", { key: "y", value: "keep" });
    expect((await call(b, "GET", "/api/v2/plugin/state")).json.state).toEqual({});
    // A page cannot name another plugin: the id is the token's page, whatever the body says.
    await call(b, "POST", "/api/v2/plugin/state", { key: "x", value: 9, plugin: "own-a.html" });
    expect((await call(a, "GET", "/api/v2/plugin/state")).json.state).toEqual({ x: { deep: [1, 2] }, y: "keep" });
    await call(a, "POST", "/api/v2/plugin/state", { key: "x", value: null });
    expect((await call(a, "GET", "/api/v2/plugin/state")).json.state).toEqual({ y: "keep" });
    expect((await call(a, "POST", "/api/v2/plugin/state", "{")).status).toBe(400);
    expect((await call(a, "POST", "/api/v2/plugin/state", { value: 1 })).status).toBe(400);
    expect((await call(a, "POST", "/api/v2/plugin/state", { key: "k".repeat(201), value: 1 })).status).toBe(400);
    expect((await call(a, "POST", "/api/v2/plugin/state", { key: "big", value: "x".repeat(70 * 1024) })).status).toBe(413);
    expect((await call(a, "GET", "/api/v2/plugin/state")).json.state).toEqual({ y: "keep" });
  });

  it("state is records in the one log, and survives a restart", async () => {
    const a = page("durable.html", "state");
    const set = await call(a, "POST", "/api/v2/plugin/state", { key: "count", value: 41 });
    const recs = log.convLog(vault).after(0).events.filter((r: any) => r.type === "signal" && r.signal.plugin === "durable.html");
    expect(recs.map((r: any) => [r.seq, r.conv, r.signal])).toEqual([[set.json.seq, null, { type: "plugin.state", plugin: "durable.html", key: "count", value: 41 }]]);
    log._resetConvLogs(); // a restart: the logs are opened again from disk
    const again = page("durable.html", "state");
    expect((await call(again, "GET", "/api/v2/plugin/state")).json).toEqual({ seq: set.json.seq, state: { count: 41 } });
  });
});

describe("an app plugin's state (app/chat-rows' kept choices: GET/POST /api/v2/plugin/app-state)", () => {
  it("is plugin.state records Carl's devices write; every app plugin's or one; survives a restart; pages and bad ids refused", async () => {
    const ps = await import("../pluginState");
    const q = (s = "") => new URLSearchParams(s);
    expect(ps.appPluginStateRoute(vault, "GET", q(), null)).toEqual({ status: 200, body: { states: {} } });
    const set = ps.appPluginStateRoute(vault, "POST", q(), { plugin: "app/chat-rows", key: "off:builtin:notice", value: true });
    expect(set.status).toBe(200);
    const seq = (set.body as { seq: number }).seq;
    expect(set.body).toMatchObject({ ok: true, seq, state: { "off:builtin:notice": true } });
    ps.appPluginStateRoute(vault, "POST", q(), { plugin: "app/chat-rows", key: "use:tool-call", value: "my.js#tool-call" });
    const two = ps.appPluginStateRoute(vault, "POST", q(), { plugin: "app/chat-rows", key: "use:tool-call", value: null });
    expect((two.body as { state: unknown }).state).toEqual({ "off:builtin:notice": true });
    // A page's state is not an app plugin's: the device route names only app/<name>.
    await call(page("p.html", "state"), "POST", "/api/v2/plugin/state", { key: "x", value: 1 });
    const all = ps.appPluginStateRoute(vault, "GET", q(), null).body as { states: Record<string, unknown> };
    expect(Object.keys(all.states)).toEqual(["app/chat-rows"]);
    for (const bad of ["p.html", "app/", "App/x", "app/../x", ""]) expect(ps.appPluginStateRoute(vault, "POST", q(), { plugin: bad, key: "k", value: 1 }).status).toBe(400);
    expect(ps.appPluginStateRoute(vault, "POST", q(), { plugin: "app/chat-rows", value: 1 }).status).toBe(400);
    expect(ps.appPluginStateRoute(vault, "GET", q("plugin=p.html"), null).status).toBe(400);
    log._resetConvLogs(); // a restart
    expect(ps.appPluginStateRoute(vault, "GET", q("plugin=app/chat-rows"), null).body).toEqual({ seq: (two.body as { seq: number }).seq, state: { "off:builtin:notice": true } });
  });
});

describe("a note widget's state (src/noteWidgets.ts: widget:<note>#<widget> on the same device route)", () => {
  it("is plugin.state records under the instance's id, listed beside app plugins, kept over a restart", async () => {
    const ps = await import("../pluginState");
    const q = (s = "") => new URLSearchParams(s);
    const id = "Physics 135/week 3.md#widgets/counter.js";
    const set = ps.appPluginStateRoute(vault, "POST", q(), { plugin: `widget:${id}`, key: "count", value: 3 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, state: { count: 3 } });
    const all = ps.appPluginStateRoute(vault, "GET", q(), null).body as { states: Record<string, { state: unknown }> };
    expect(all.states[`widget:${id}`]!.state).toEqual({ count: 3 });
    for (const bad of ["widget:", "widget:a\nb", "Widget:x"]) expect(ps.appPluginStateRoute(vault, "POST", q(), { plugin: bad, key: "k", value: 1 }).status).toBe(400);
    log._resetConvLogs();
    expect(ps.appPluginStateRoute(vault, "GET", q(`plugin=${encodeURIComponent(`widget:${id}`)}`), null).body).toMatchObject({ state: { count: 3 } });
  });
});

describe("a page's log service", () => {
  it("appends the page's records to the one log, tagged with the page", async () => {
    const t = page("logger.html", "log");
    const out = await call(t, "POST", "/api/v2/plugin/log", { did: "clicked", n: 3 });
    expect(out.status).toBe(200);
    const recs = log.convLog(vault).after(out.json.seq - 1).events;
    expect(recs.map((r: any) => r.signal)).toEqual([{ type: "plugin.log", plugin: "logger.html", record: { did: "clicked", n: 3 } }]);
    expect((await call(t, "POST", "/api/v2/plugin/log", "{")).status).toBe(400);
    expect((await call(t, "POST", "/api/v2/plugin/log", { blob: "x".repeat(70 * 1024) })).status).toBe(413);
  });
});

describe("what a page reaches", () => {
  it("every page reaches its own state and log, declared or not (Carl's input in it is state); only their declared methods and paths", async () => {
    const s = page("only-state.html", "state");
    const l = page("only-log.html", "log");
    const a = page("only-ask.html", "ask");
    const none = page("no-manifest.html", "");
    for (const t of [s, l, a, none])
      for (const [m, p] of [["GET", "/api/v2/plugin/state"], ["POST", "/api/v2/plugin/state"], ["POST", "/api/v2/plugin/log"]] as const)
        expect((await call(t, m, p, m === "POST" ? { key: "k", value: 1 } : undefined)).status).toBe(200);
    // Each its own: the no-manifest page's state is not the ask page's.
    await call(none, "POST", "/api/v2/plugin/state", { key: "mine", value: 1 });
    expect((await call(a, "GET", "/api/v2/plugin/state")).json.state).toEqual({ k: 1 });
    // Only the declared methods and paths.
    expect((await call(s, "GET", "/api/v2/plugin/state/x")).status).toBe(403);
    expect((await call(l, "GET", "/api/v2/plugin/log")).status).toBe(403);
  });

  it("a runaway page is stopped at the write limit", async () => {
    const t = page("runaway.html", "state, log");
    let refused = 0;
    for (let i = 0; i < 305; i++) if ((await call(t, "POST", "/api/v2/plugin/log", { i })).status === 429) refused++;
    expect(refused).toBe(5);
    expect((await call(t, "POST", "/api/v2/plugin/state", { key: "k", value: 1 })).status).toBe(429);
    expect((await call(t, "GET", "/api/v2/plugin/state")).status).toBe(200);
  });
});
