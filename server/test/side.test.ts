// Ctrl+K and Ctrl+L as requests to pi (server/engine/pi/side.ts), end to end:
// the real bundle, the engine on the fake pi (fakePiCli.mjs: pi's RPC protocol,
// --fork / --tools / --no-tools / --no-session / --system-prompt as pi's CLI
// takes them), a fake OpenRouter. A side request forks the open conversation's
// pi session (its history is the model's context; the fork's header names the
// conversation's session), has pi's read-only tools (a read runs, a write is
// refused), streams its text over GET /api/v1/side/:id, and leaves the
// conversation's own transcript alone; a popover's next request continues the
// same side thread; a one-shot is pi with no session and no tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
let srv: Running;
let conv = "";

const get = async (p: string) => {
  const r = await fetch(srv.base + p);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: string, b: Record<string, unknown>) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: (await r.json()) as any };
};
/** Follow a side thread as the laptop does (long polls after the last version); every text seen on the way. */
async function follow(id: string, v0 = 0): Promise<{ final: any; seen: string[] }> {
  const seen: string[] = [];
  let v = v0;
  for (let i = 0; i < 400; i++) {
    const r = await get(`/api/v1/side/${id}?after=${v}&wait=5000`);
    expect(r.status).toBe(200);
    v = r.body.v;
    if (r.body.text && seen[seen.length - 1] !== r.body.text) seen.push(r.body.text);
    if (r.body.done) return { final: r.body, seen };
  }
  throw new Error("the side thread never finished");
}
/** Every message's text of one model call. */
const callText = (c: any) => (c?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const sessionsDir = () => join(home, "state", "pi", "sessions");
const sideFiles = (dir: string): string[] => {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    if (n.isDirectory()) out.push(...sideFiles(join(dir, n.name)));
    else if (n.name.endsWith(".jsonl")) out.push(join(dir, n.name));
  }
  return out;
};
const userEntries = async () => {
  const all: any[] = [];
  let cur = 0;
  for (;;) {
    const r = (await get(`/poll?after=${cur}`)).body;
    all.push(...r.events);
    if (!r.events.length || !r.more) break;
    cur = r.next;
  }
  return all.filter((x) => x.conv === conv && x.type === "entry" && x.entry.message?.role === "user").length;
};

beforeAll(async () => {
  home = tmp("vcside-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("Here is the answer.");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
  // The conversation Carl has open: one exchange, on its own pi session.
  const r = await post("/api/v2/intent", { type: "send", clientId: "c-side-1", text: "What is a KV cache?" });
  expect(r.body.ok).toBe(true);
  conv = r.body.convId;
  await waitFor(async () => (await get(`/api/v2/conversations/${conv}/checkpoint`)).body?.picture?.meta?.threadPath && !(await get(`/api/v2/conversations/${conv}/checkpoint`)).body.picture.meta.running, 30_000);
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("Ctrl+L and Ctrl+K are requests to pi", () => {
  let askId = "";

  it("Ctrl+L forks the conversation's session, reads the vault with a read tool, and answers", async () => {
    const before = await userEntries();
    const n = or.calls.length;
    or.script.push({ toolCall: { name: "read", args: { path: "notes/ideas.md" } } }, { text: "Your ideas file lists one idea." });
    const r = await post("/api/v1/side", { kind: "ask", convId: conv, text: "# Ctrl+L: a question about the file\n\nQUESTION:\nwhat is in my ideas file?" });
    expect(r.status).toBe(200);
    askId = r.body.id;
    const { final } = await follow(askId, r.body.v);
    expect(final).toMatchObject({ done: true, error: null, text: "Your ideas file lists one idea." });
    const calls = or.calls.slice(n);
    expect(calls.length).toBe(2);
    // One agent, shared context: the conversation's exchange is the side thread's history.
    expect(callText(calls[0])).toContain("What is a KV cache?");
    expect(callText(calls[0])).toContain("Here is the answer.");
    expect(callText(calls[0])).toContain("what is in my ideas file?");
    // pi's read ran: the file's contents went back to the model.
    expect(callText(calls[1])).toContain("- an idea");
    // A linked side thread: its own session, whose header names the conversation's.
    const meta = (await get(`/api/v2/conversations/${conv}/checkpoint`)).body.picture.meta;
    const files = sideFiles(join(sessionsDir(), "side", conv));
    expect(files.length).toBe(1);
    const header = JSON.parse(readFileSync(files[0]!, "utf8").split("\n")[0]!);
    expect(header.parentSession).toBe(meta.threadPath);
    expect(files[0]!.endsWith(`_${askId}.jsonl`)).toBe(true);
    // The conversation's own transcript is untouched.
    expect(await userEntries()).toBe(before);
    expect(readFileSync(meta.threadPath, "utf8")).not.toContain("what is in my ideas file?");
  });

  it("a follow-up in the popover continues the same side thread", async () => {
    const n = or.calls.length;
    or.script.push({ text: "It is a one-line list." });
    const r = await post("/api/v1/side", { kind: "ask", side: askId, text: "how long is it?" });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(askId);
    const { final } = await follow(askId, r.body.v);
    expect(final.text).toBe("It is a one-line list.");
    const t = callText(or.calls[n]);
    expect(t).toContain("what is in my ideas file?");
    expect(t).toContain("Your ideas file lists one idea.");
    expect(t).toContain("how long is it?");
  });

  it("Ctrl+K streams its replacement, and has read-only tools (a write is refused)", async () => {
    const n = or.calls.length;
    or.script.push({ toolCall: { name: "write", args: { path: "notes/ideas.md", content: "overwritten" } } }, { text: "# A much shorter title for this note about ideas" });
    const r = await post("/api/v1/side", { kind: "edit", convId: conv, text: "# Ctrl+K: an inline edit\n\nINSTRUCTION:\nshorten the title [slow]\n\nSELECTION:\n# A title" });
    expect(r.status).toBe(200);
    const { final, seen } = await follow(r.body.id, r.body.v);
    expect(final).toMatchObject({ done: true, error: null, text: "# A much shorter title for this note about ideas" });
    // It streamed: partial texts before the whole one.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.slice(0, -1).every((s) => final.text.startsWith(s) && s.length < final.text.length)).toBe(true);
    expect(callText(or.calls[n + 1])).toContain("Tool write not found");
    expect(readFileSync(join(vault, "notes", "ideas.md"), "utf8")).toBe("- an idea\n");
  }, 60_000);

  it("Esc stops it on the box", async () => {
    or.script.push({ text: "a long answer that is stopped part way through" });
    const r = await post("/api/v1/side", { kind: "ask", convId: conv, text: "explain everything [slow]" });
    await waitFor(async () => (await get(`/api/v1/side/${r.body.id}?after=${r.body.v}&wait=2000`)).body.text, 10_000);
    expect((await post(`/api/v1/side/${r.body.id}/stop`, {})).body.ok).toBe(true);
    const { final } = await follow(r.body.id);
    expect(final.done).toBe(true);
    expect(final.text.length).toBeLessThan("a long answer that is stopped part way through".length);
  }, 30_000);

  it("a one-shot (a note's title) is pi with its own system prompt, no tools and no session", async () => {
    const n = or.calls.length;
    const before = sideFiles(sessionsDir()).length;
    or.script.push({ text: "KV cache basics" });
    const r = await post("/api/v1/side", { kind: "once", system: "You write the headline for a saved note.", text: "A KV cache keeps keys and values.", fast: true });
    expect(r.status).toBe(200);
    const { final } = await follow(r.body.id, r.body.v);
    expect(final.text).toBe("KV cache basics");
    const call = or.calls[n];
    expect(call.messages[0]).toMatchObject({ role: "system", content: "You write the headline for a saved note." });
    expect(callText(call)).not.toContain("What is a KV cache?");
    expect(sideFiles(sessionsDir()).length).toBe(before);
  });

  it("refusals: no text, an unknown side thread", async () => {
    expect((await post("/api/v1/side", { kind: "ask", text: "  " })).status).toBe(400);
    expect((await get("/api/v1/side/nope?after=0&wait=0")).status).toBe(404);
    expect((await post("/api/v1/side", { kind: "ask", side: "nope", text: "x" })).body.error).toMatch(/gone/);
  });
});
