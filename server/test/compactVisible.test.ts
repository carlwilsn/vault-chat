// /compact on Claude Code, as Carl sees it: the real bundle running the real
// Claude Code CLI, its model answered by the scripted stand-in API, which holds
// the summary request open so the test can look at the chat WHILE it is being
// written (Carl, 2026-11-12: "all I see is my context go down, I don't see
// anything in the chat and my message doesn't send").
//
// What a client shows is the fold of /poll, as on every surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, chatText, type FakeApi, type ScriptStep } from "./claudeFakeApi";
import { fold, shown, isOpen, pendingOf } from "../../src/convlog/reduce";
import { makeChatView } from "../../src/convlog/view";

let home: string, vault: string, secrets: string;
let api: FakeApi;
let srv: Running;

const get = async (p: string) => (await fetch(srv.base + p)).json();
const post = async (p: string, b: Record<string, unknown>) => (await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
async function all(): Promise<any[]> {
  const out: any[] = [];
  let cur = 0;
  for (;;) {
    const r = await get(`/poll?after=${cur}`);
    out.push(...r.events);
    if (!r.events.length || !r.more) return out;
    cur = r.next;
  }
}
const picture = async (id = "main") => fold((await all()).filter((r) => r.conv === id), id);
const idle = async (id = "main") => {
  const p = await picture(id);
  return !p.meta.running && !pendingOf(p).length;
};
const compacting = (p: Awaited<ReturnType<typeof picture>>) => shown(p).filter((x) => x.kind === "compaction" && isOpen(x));
const dividers = (p: Awaited<ReturnType<typeof picture>>) => shown(p).filter((x) => x.kind === "compaction" && !isOpen(x));

/** Claude Code's summary request (its own prompt asks for a summary of the conversation). */
const isSummary = (body: any) => /CRITICAL: Respond with TEXT ONLY/.test(JSON.stringify((body?.messages ?? []).slice(-1)));

/** Hold the summary request until released; every other request answers as usual. */
function holdSummary(answer: ScriptStep): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  api.respond = async (body) => {
    if (!isSummary(body)) return null;
    await gate;
    return answer;
  };
  return release;
}

beforeAll(async () => {
  home = tmp("vccompact-");
  vault = makeVault(join(home, "vault"));
  mkdirSync(join(vault, ".vault-chat"), { recursive: true });
  secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
  api = await fakeAnthropic();
  srv = await startServer({ home, vault, secrets, anthropic: api.url });
  await post("/api/v2/intent", { type: "send", clientId: "c-first", text: "Remember the plan: MARKER-PLAN." });
  await waitFor(() => idle(), 60_000);
}, 180_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await api?.close();
  cleanup(home);
});

describe("/compact shows itself, holds what Carl sends meanwhile, and moves the dial", () => {
  it("says it is summarizing at once, keeps a message sent meanwhile waiting, then the divider, the new size, and the answer", async () => {
    const before = await picture();
    expect(before.usage?.context ?? 0).toBeGreaterThan(0);
    const release = holdSummary({ text: "<summary>Carl's plan is MARKER-PLAN.</summary>" });
    try {
      // The intent answers at once (a client's request times out long before a summary is written).
      const t0 = Date.now();
      const r = await post("/api/v2/intent", { type: "compact", convId: "main" });
      expect(r).toMatchObject({ ok: true, started: true });
      expect(Date.now() - t0).toBeLessThan(5_000);

      // Symptom 1: the chat says so while it works — one line, the one clients draw as "Summarizing…".
      const during = await waitFor(async () => {
        const p = await picture();
        return compacting(p).length === 1 && api.requests.some(isSummary) ? p : null;
      }, 60_000);
      const view = makeChatView()(during);
      const line = view.messages.filter((m) => m.working);
      expect(line.map((m) => m.content)).toEqual(["Summarizing the earlier conversation…"]);

      // Symptom 2: a message sent now is in the chat at once, as his and waiting, and nothing runs yet.
      const sent = await post("/api/v2/intent", { type: "send", convId: "main", clientId: "c-during", text: "While you summarize: MARKER-DURING" });
      expect(sent).toMatchObject({ ok: true, queued: true });
      const waiting = await picture();
      expect(pendingOf(waiting).map((x) => [x.id, x.text])).toEqual([["c-during", "While you summarize: MARKER-DURING"]]);
      expect(compacting(waiting).length).toBe(1);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(api.calls.some((c) => chatText(c).includes("MARKER-DURING"))).toBe(false);
    } finally {
      release();
    }

    // The summary lands: the divider replaces the line, with the size before and after.
    const landed = await waitFor(async () => {
      const p = await picture();
      return dividers(p).length === 1 && !compacting(p).length ? p : null;
    }, 60_000);
    const div = dividers(landed)[0]!;
    const m = /at ([\d,]+) tokens, down to ([\d,]+)/.exec(div.text ?? "");
    expect(m, div.text).toBeTruthy();
    const after = Number(m![2]!.replace(/,/g, ""));
    // Symptom 3: the dial reads the size after the summary the moment it lands, never the old one.
    expect(after).toBeGreaterThan(0);
    const recs = (await all()).filter((r) => r.conv === "main");
    const at = recs.findIndex((r) => r.type === "entry" && r.entry?.type === "compaction");
    expect(fold(recs.slice(0, at), "main").usage?.context).toBe(before.usage?.context);
    expect(fold(recs.slice(0, at + 1), "main").usage?.context).toBe(after);

    // His message runs right after, once, and is answered.
    const answered = await waitFor(async () => {
      const p = await picture();
      const i = p.items.findIndex((x) => x.id === "c-during");
      return (await idle()) && i >= 0 && p.items.slice(i + 1).some((x) => x.kind === "assistant" && (x.text ?? "").trim()) ? p : null;
    }, 60_000).catch(async (e) => {
      console.log(JSON.stringify({ items: (await picture()).items.map((x) => [x.kind, x.id, x.status, (x.text ?? "").slice(0, 80)]), meta: (await picture()).meta }, null, 1));
      throw e;
    });
    expect(api.calls.filter((c) => chatText(c).includes("MARKER-DURING")).length).toBeGreaterThan(0);
    const users = shown(answered).filter((x) => x.kind === "user" && (x.text ?? "").includes("MARKER-DURING"));
    expect(users.map((x) => x.id)).toEqual(["c-during"]);
    const order = shown(answered).filter((x) => x.kind === "compaction" || x.id === "c-during").map((x) => x.kind);
    expect(order).toEqual(["compaction", "user"]);
  }, 180_000);

  it("a message taken back while it waits for the summary never runs", async () => {
    const release = holdSummary({ text: "<summary>Again.</summary>" });
    try {
      expect(await post("/api/v2/intent", { type: "compact", convId: "main" })).toMatchObject({ ok: true, started: true });
      await waitFor(async () => compacting(await picture()).length === 1, 60_000);
      expect(await post("/api/v2/intent", { type: "send", convId: "main", clientId: "c-takeback", text: "MARKER-TAKEN-BACK" })).toMatchObject({ queued: true });
      expect(await post("/api/v2/intent", { type: "unqueue", convId: "main", id: "c-takeback" })).toMatchObject({ ok: true });
    } finally {
      release();
    }
    await waitFor(async () => {
      const p = await picture();
      return dividers(p).length === 2 && !compacting(p).length;
    }, 60_000);
    api.respond = null;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(api.calls.some((c) => chatText(c).includes("MARKER-TAKEN-BACK"))).toBe(false);
    expect(shown(await picture()).some((x) => (x.text ?? "").includes("MARKER-TAKEN-BACK"))).toBe(false);
  }, 180_000);

  it("a summary that fails says so in one line, and the line stops", async () => {
    await post("/api/v2/intent", { type: "send", clientId: "c-more", text: "Something more to summarize: MARKER-MORE." });
    await waitFor(() => idle(), 60_000);
    // Every request refused from here (Claude Code tries other ways to summarize before it gives up).
    api.respond = () => ({ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "MARKER-REFUSED the summary" } }) });
    expect(await post("/api/v2/intent", { type: "compact", convId: "main" })).toMatchObject({ ok: true, started: true });
    const p = await waitFor(async () => {
      const p = await picture();
      return p.items.some((x) => x.kind === "notice" && /Summarizing the earlier conversation failed/.test(x.text ?? "")) && !compacting(p).length ? p : null;
    }, 90_000).catch(async (e) => {
      const p = await picture();
      console.log("DEBUG", api.requests.filter(isSummary).length, JSON.stringify({ items: shown(p).map((x) => [x.kind, x.id, x.status, (x.text ?? "").slice(0, 100)]) }, null, 1));
      throw e;
    });
    const lines = p.items.filter((x) => x.kind === "notice" && /Summarizing the earlier conversation failed/.test(x.text ?? ""));
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("MARKER-REFUSED");
    expect(dividers(p).length).toBe(2);
    api.respond = null;
  }, 180_000);
});
