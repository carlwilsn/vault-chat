// Main and /compact end to end: the real bundle, the engine on the fake pi (fakePiCli.mjs: pi's RPC,
// its `compact` command and its session file in pi's format), a fake OpenRouter. What the model
// is sent is what the fake OpenRouter records; what a client shows is the fold of /poll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import { fold, shown } from "../../src/convlog/reduce";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
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
const picture = async (id: string) => fold((await all()).filter((r) => r.conv === id), id);
const idle = async (id: string) => {
  const p = await picture(id);
  return !p.meta.running && !p.meta.clearing;
};

beforeAll(async () => {
  home = tmp("vcclear-");
  vault = makeVault(join(home, "vault"));
  mkdirSync(join(vault, "agent-projects", "coconut"), { recursive: true });
  writeFileSync(join(vault, "agent-projects", "coconut", "project.md"), "# Coconut\n\n## Memory\n\n- 2026-10-20: overlap 128\n");
  mkdirSync(join(vault, ".vault-chat"), { recursive: true });
  writeFileSync(join(vault, ".vault-chat", "MEMORY.md"), "# Memory\n\n- 2026-10-01: Carl likes one worked example\n");
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("NO_REPLY");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("Main over HTTP", () => {
  it("the box has Main and each project's thread from its start", async () => {
    const rows = (await get("/api/v2/conversations")).rows;
    expect(rows.map((r: any) => [r.id, r.kind])).toEqual(expect.arrayContaining([["main", "main"], ["project-coconut", "project"]]));
  });

  it("a send naming no conversation is Main's; the model gets the global memory, never a project's", async () => {
    const r = await post("/api/v2/intent", { type: "send", clientId: "c-1", text: "We settled it: due Friday, MARKER-ONE." });
    expect(r).toMatchObject({ ok: true, convId: "main" });
    await waitFor(() => idle("main"), 30_000);
    const sent = JSON.stringify(or.calls.at(-1));
    expect(sent).toContain("Carl likes one worked example");
    expect(sent).toContain("agent-projects/coconut/project.md");
    expect(sent).not.toContain("overlap 128");
  });

  it("/compact: pi compacts Main's context now (a compaction entry in pi's file, the raw history kept); the thread shows the summary divider", async () => {
    const r = await post("/api/v2/intent", { type: "compact", convId: "main", focus: "the Friday deadline" });
    expect(r).toMatchObject({ ok: true, compacted: true });
    const dir = join(home, "state", "pi", "sessions");
    const file = readdirSync(dir).map((n) => join(dir, n)).find((f) => f.endsWith(".jsonl") && readFileSync(f, "utf8").includes("MARKER-ONE"))!;
    const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(entries.some((e) => e.type === "compaction")).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("MARKER-ONE");
    await waitFor(async () => shown(await picture("main")).some((x) => x.kind === "compaction"), 10_000);
    // Clear is not the box's: there is no such intent.
    expect((await post("/api/v2/intent", { type: "clear", convId: "main" })).error).toMatch(/unknown intent/);
  });

  it("after /compact the agent gets its memory again with the next turn; the thread still has everything", async () => {
    const calls0 = or.calls.length;
    const r = await post("/api/v2/intent", { type: "send", clientId: "c-2", text: "What was I saying?", client: "phone" });
    expect(r.convId).toBe("main");
    await waitFor(() => idle("main"), 30_000);
    const sent = JSON.stringify(or.calls.slice(calls0));
    expect(sent).toContain("Carl likes one worked example");
    expect(sent).toContain("[Carl, on his phone]");
    const texts = shown(await picture("main")).map((x) => x.text ?? "");
    expect(texts.some((t) => t.includes("MARKER-ONE"))).toBe(true);
    expect(texts).toContain("What was I saying?");
  });

  it("the agent's model is one setting the laptop changes (Settings and the composer): the next turn runs on it", async () => {
    const before = await get("/api/v1/models");
    expect(typeof before.box?.chat?.id).toBe("string");
    expect(await post("/api/v1/models/agent", { model: "not a model" })).toMatchObject({ ok: false });
    expect(await post("/api/v1/models/agent", { model: "anthropic/claude-test-model" })).toMatchObject({ ok: true, model: "anthropic/claude-test-model" });
    expect((await get("/api/v1/models")).box.chat.id).toBe("anthropic/claude-test-model");
    const calls0 = or.calls.length;
    await post("/api/v2/intent", { type: "send", clientId: "c-model", text: "Which model are you?" });
    await waitFor(() => idle("main"), 30_000);
    expect(or.calls.slice(calls0).some((c: any) => /claude-test-model/.test(String(c.model)))).toBe(true);
    await post("/api/v1/models/agent", { model: before.box.chat.id });
  });

  it("+ New project makes the project and its thread; a send to it carries its project.md", async () => {
    const r = await post("/projects", { name: "Psych 221" });
    expect(r).toMatchObject({ ok: true, slug: "psych-221", convId: "project-psych-221" });
    const calls0 = or.calls.length;
    await post("/api/v2/intent", { type: "send", clientId: "c-3", convId: "project-coconut", text: "Which overlap?" });
    await waitFor(() => idle("project-coconut"), 30_000);
    expect(JSON.stringify(or.calls.slice(calls0))).toContain("overlap 128");
  });
});
