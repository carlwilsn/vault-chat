// Main and /compact end to end: the real bundle running the real Claude Code,
// its model answered by the scripted stand-in API. What the model is sent is
// what that stand-in records; what a client shows is the fold of /poll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, seedProject, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { fold, shown } from "../../src/convlog/reduce";

let home: string, vault: string, secrets: string, coconut: string;
let or: FakeApi;
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
  coconut = seedProject(vault, "coconut", { folder: "Coconut", memory: "# Coconut: memory\n\n- 2026-10-20: overlap 128\n" });
  mkdirSync(join(vault, ".vault-chat"), { recursive: true });
  writeFileSync(join(vault, ".vault-chat", "MEMORY.md"), "# Memory\n\n- 2026-10-01: Carl likes one worked example\n");
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeAnthropic("NO_REPLY");
  srv = await startServer({ home, vault, secrets, anthropic: or.url });
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
    // Where each project is (its folder), never what it remembers.
    expect(sent).toContain(`- Coconut: ${coconut.split("\\").join("/")}`);
    expect(sent).not.toContain("overlap 128");
  });

  it("/compact: the engine compacts Main's context now (a compaction entry in the session file, the raw history kept); the thread shows the summary divider", async () => {
    const r = await post("/api/v2/intent", { type: "compact", convId: "main", focus: "the Friday deadline" });
    expect(r).toMatchObject({ ok: true, compacted: true });
    const dir = join(vault, ".vault-chat", "events", "sessions");
    // The runtime summarises on its own command, so the boundary lands after the
    // intent returns — in the same transcript, which still holds the raw history.
    const body = await waitFor(
      () =>
        readdirSync(dir)
          .filter((n) => n.endsWith(".jsonl"))
          .map((n) => readFileSync(join(dir, n), "utf8"))
          .find((t) => t.includes("MARKER-ONE") && t.includes('"type":"compaction"')),
      30_000,
    );
    expect(body.split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.type === "compaction")).toBe(true);
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
    expect(texts, JSON.stringify(texts)).toContain("What was I saying?");
  });

  it("the model is the chat's OWN (the composer's picker): this chat's next turn runs on it, and a new chat starts from the last choice", async () => {
    // The list the picker draws: real names, never a raw id or a provider.
    const answer = await get("/api/v1/models");
    const list = answer.models as { id: string; name: string; efforts: string[] }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => m.name && !m.name.includes("/")), JSON.stringify(list)).toBe(true);
    // And what a chat that has chosen nothing is running on, so the picker can
    // name it instead of showing the first row and being wrong.
    expect(typeof answer.default).toBe("string");
    expect(answer.default).toBeTruthy();

    expect(await post("/api/v1/conversations/main/model", { model: "not a model" })).toMatchObject({ ok: false });
    expect(await post("/api/v1/conversations/main/model", { model: "openai/gpt-6.1-sol" })).toMatchObject({ ok: false });
    expect(await post("/api/v1/conversations/main/model", { model: "opus", effort: "high" })).toMatchObject({ ok: true, model: "opus", effort: "high" });
    // It is the conversation's own field, so every client reads it off the feed.
    expect((await picture("main")).meta).toMatchObject({ model: "opus", effort: "high" });

    const calls0 = or.calls.length;
    await post("/api/v2/intent", { type: "send", clientId: "c-model", text: "Which model are you?" });
    await waitFor(() => idle("main"), 30_000);
    expect(or.calls.slice(calls0).some((c: any) => /opus/.test(String(c.model))), JSON.stringify(or.calls.slice(calls0).map((c: any) => c.model))).toBe(true);

    // A NEW chat starts from what he picked last, without picking again.
    const calls1 = or.calls.length;
    await post("/api/v2/intent", { type: "send", clientId: "c-new-chat", convId: "chat-after-the-pick", text: "And you?" });
    await waitFor(() => idle("chat-after-the-pick"), 30_000);
    expect(or.calls.slice(calls1).some((c: any) => /opus/.test(String(c.model))), JSON.stringify(or.calls.slice(calls1).map((c: any) => c.model))).toBe(true);

    // And one chat's choice is not every chat's: this one goes back on its own.
    expect(await post("/api/v1/conversations/main/model", { model: "haiku", effort: null })).toMatchObject({ ok: true, model: "haiku" });
    expect((await picture("main")).meta.effort ?? null).toBe(null);
  });

  it("+ New project makes the project and its thread; a send to a project carries its memory", async () => {
    const r = await post("/projects", { name: "Psych 221" });
    expect(r).toMatchObject({ ok: true, slug: "psych-221", convId: "project-psych-221" });
    const calls0 = or.calls.length;
    await post("/api/v2/intent", { type: "send", clientId: "c-3", convId: "project-coconut", text: "Which overlap?" });
    await waitFor(() => idle("project-coconut"), 30_000);
    expect(JSON.stringify(or.calls.slice(calls0))).toContain("overlap 128");
  });
});
