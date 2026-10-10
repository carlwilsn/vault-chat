// The Codex engine end to end: the built bundle, the REAL pinned Codex binary
// (VC_TEST_CODEX_BIN), and a fake OpenRouter that speaks the Responses API.
// Each scenario is keyed by a marker word in the user's message.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, tinyPdf, type Running } from "./helpers";
import { fakeResponses, COST_PER_CALL, type FakeResponses, type Step } from "./fakeResponses";

const BIN = process.env.VC_TEST_CODEX_BIN;
const CANARY = "sk-or-canary-ENGINE-not-real";
const PASS = "test-passphrase-not-a-secret";
const linux = process.platform === "linux";

function lastItem(body: any): any {
  const inp: any[] = body?.input ?? [];
  return inp[inp.length - 1];
}
function lastUserText(body: any): string {
  const inp: any[] = body?.input ?? [];
  for (let i = inp.length - 1; i >= 0; i--) {
    const it = inp[i];
    if (it?.type === "message" && it.role === "user") return (it.content ?? []).map((c: any) => c?.text ?? "").join("\n");
  }
  return "";
}
function allText(body: any): string {
  return JSON.stringify(body?.input ?? []);
}

describe.skipIf(!BIN)("engine (real Codex, fake Responses API)", () => {
  let home: string, vault: string, secrets: string, state: string;
  let or: FakeResponses;
  let srv: Running;
  const outputs: Record<string, string> = {};

  const boot = async () => {
    srv = await startServer({
      home,
      vault,
      secrets,
      openrouter: or.url,
      extra: { VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: state, VC_CODEX_BIN: "" },
    });
    await waitFor(async () => {
      const h = await (await fetch(srv.base + "/api/v1/health")).json();
      return h.engine?.codex?.state === "up" ? h : null;
    }, 60_000);
  };
  const post = (p: string, body: unknown) =>
    fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const conv = async (id: string) => {
    const f = join(vault, ".vault-chat", "conversations", `${id}.jsonl`);
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const metas = lines.filter((l) => "id" in l);
    return { ...metas[metas.length - 1], messages: lines.filter((l) => "role" in l) };
  };
  const assistantSays = (id: string, re: RegExp, ms = 60_000) =>
    waitFor(async () => {
      const c = await conv(id);
      return c.messages.some((m: any) => m.role === "assistant" && re.test(String(m.content))) ? c : null;
    }, ms);

  beforeAll(async () => {
    home = tmp("vce-");
    vault = makeVault(join(home, "vault"));
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": CANARY });
    state = join(home, "state");
    // The server's own install path: $VC_STATE_DIR/codex/<pin>/node_modules → the cached install.
    const nm = join(dirname(BIN!), "..", "..", "..", "..", "..");
    mkdirSync(join(state, "codex", "0.162.1"), { recursive: true });
    symlinkSync(nm, join(state, "codex", "0.162.1", "node_modules"));
    writeFileSync(join(vault, "doc.pdf"), tinyPdf("Quarterly banana report"));
    // Learned before boot: the fake model "has" subagents, and the fake refuses
    // the namespace tool they bring — the first turn must fall back silently.
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "capabilities.json"),
      JSON.stringify({ "test/fake-model": { model: "test/fake-model", codexVersion: "0.162.1", testedAt: Date.now(), results: { subagents: true }, evidence: {} } }),
    );
    or = await fakeResponses();
    or.rejectNamespace = true;
    or.respond = (body): Step => {
      const last = lastItem(body);
      // Codex places a steer after the tool output, as the newest user message.
      if (lastUserText(body).includes("kiwi steer")) return { text: "saw the kiwi steer" };
      const user = lastUserText(body);
      const all = allText(body);
      if (last?.type === "function_call_output") {
        const out = typeof last.output === "string" ? last.output : JSON.stringify(last.output);
        if (out.startsWith("echo:")) return { text: "DONE" };
        const key = Object.keys(scenarios).find((k) => all.includes(k)) ?? "";
        outputs[key] = (outputs[key] ?? "") + "\n" + out;
        if (key === "STEER1") return { text: all.includes("kiwi steer") ? "saw the kiwi steer" : "no steer seen" };
        if (key === "NUDGE1") return { text: "working on it" };
        return { text: `${key} done: ${out.slice(0, 60)}` };
      }
      if (user.includes("keep-going mode")) return { text: "still nothing to report" };
      if (user.includes("box restarted")) return { text: "resumed after the crash" };
      if (user.includes("Wake: check the run")) return { text: "woke up and checked" };
      if (allText(body).includes("ProbeEcho") && user.includes("ProbeEcho tool with word=alpha")) return { call: { name: "ProbeEcho", args: { word: "alpha" } } };
      const key = Object.keys(scenarios).find((k) => user.includes(k));
      return key ? scenarios[key]!() : { text: "hello from codex" };
    };
    await boot();
  });

  const scenarios: Record<string, () => Step> = {
    CHAT1: () => ({ text: "hello from codex" }),
    TOOL1: () => ({ call: { name: "exec_command", args: { cmd: "echo banana > banana.txt && cat banana.txt" } } }),
    STEER1: () => ({ call: { name: "exec_command", args: { cmd: "sleep 6; echo step1", yield_time_ms: 20000 } } }),
    INT1: () => ({ call: { name: "exec_command", args: { cmd: "sleep 60; echo late", yield_time_ms: 30000 } } }),
    ASK1: () => ({ call: { name: "AskUser", args: { question: "apple or pear?", options: ["apple", "pear"] } } }),
    PDF1: () => ({ call: { name: "PdfRead", args: { path: "doc.pdf" } } }),
    KEY1: () => ({
      call: {
        name: "exec_command",
        args: { cmd: `env | grep -c OPENROUTER; cat ${secrets}/fallback.key ${secrets}/secrets.age 2>&1 | head -c 300; echo END-KEY1` },
      },
    }),
    KEY2: () => ({
      call: {
        name: "exec_command",
        args: { cmd: `cat ${secrets}/fallback.key 2>&1 | head -c 200; echo END-KEY2`, sandbox_permissions: "require_escalated", justification: "test" },
      },
    }),
    NUDGE1: () => ({ call: { name: "KeepWorking", args: { on: true } } }),
    CRASH1: () => ({ call: { name: "exec_command", args: { cmd: "sleep 40; echo survived > crash.txt", yield_time_ms: 30000 } } }),
    WAKE1: () => ({ call: { name: "ScheduleWake", args: { in: "12s", reason: "check the run" } } }),
  };

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("health reports the supervised app-server and the pinned version", async () => {
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h.engine.codex.state).toBe("up");
    expect(h.engine.version).toBe("0.162.1");
    expect(typeof h.engine.codex.pid).toBe("number");
    const toml = readFileSync(join(state, "codex-home", "config.toml"), "utf8");
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('"OPENROUTER_*"');
    expect(toml).toContain("model_auto_compact_token_limit");
    if (linux) expect(toml).toContain(`${JSON.stringify(secrets)} = "deny"`);
    expect(srv.logs()).not.toContain(CANARY);
    expect(existsSync(join(state, "codex-home", ".tmp", "plugins"))).toBe(false);
  });

  let chatId = "";
  it("a chat turn: /message creates the conversation, the reply lands, /poll carries the events", async () => {
    const cursor = (await (await fetch(srv.base + "/poll?after=latest")).json()).next;
    const r = await post("/message", { text: "CHAT1 hi there", clientMsgId: "c-1" });
    expect(r.ok).toBe(true);
    chatId = r.convId;
    const again = await post("/message", { text: "CHAT1 hi there", clientMsgId: "c-1" });
    expect(again.convId).toBe(chatId); // idempotent
    const c = await assistantSays(chatId, /hello from codex/);
    expect(c.codexThreadId).toBeTruthy();
    // The namespace rejection was learned and the turn retried without subagents, silently.
    const ns = (b: any) => JSON.stringify(b.tools ?? []).includes('"type":"namespace"');
    expect(or.calls.some(ns)).toBe(true);
    expect(ns(or.calls[or.calls.length - 1])).toBe(false);
    expect(c.messages.some((m: any) => m.failed)).toBe(false);
    expect(c.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    const evs: any[] = [];
    await waitFor(async () => {
      const p = await (await fetch(srv.base + `/poll?after=${cursor}`)).json();
      evs.push(...p.events);
      return evs.some((e) => e.type === "message" && e.convId === chatId && e.role === "assistant") ? true : null;
    }, 20_000);
    expect(evs.some((e) => e.type === "status" && e.convId === chatId && e.status === "running")).toBe(true);
    // Phone shapes: the list and the thread.
    const list = await (await fetch(srv.base + "/conversations")).json();
    expect(list.conversations.find((x: any) => x.id === chatId)).toMatchObject({ title: "CHAT1 hi there", source: "phone" });
    const d = await (await fetch(srv.base + `/conversation?id=${chatId}`)).json();
    expect(d.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(Object.keys(d.messages[1]).sort()).toEqual(["askOptions", "content", "decision", "direct", "role", "system", "timeline", "tools"]);
  });

  it("/api/v1/models: capabilities from the catalog and learned use", async () => {
    const { models } = await (await fetch(srv.base + "/api/v1/models")).json();
    const fake = models.find((m: any) => m.id === "test/fake-model");
    expect(fake.capabilities).toMatchObject({ tools: true, images: false, subagents: false, context: 400000 });
    expect(fake.source).toBe("learned");
    const sol = models.find((m: any) => m.id === "openai/gpt-6.1-sol");
    expect(sol.capabilities).toMatchObject({ images: true, pdf: true, caching: true, subagents: true });
    expect(sol.source).toBe("learned"); // the shipped seed (server/engine/capabilities.json)
    const unknown = models.find((m: any) => m.id === "test/unlisted");
    expect(unknown).toBeUndefined();
  });

  it("/conversation full=1 returns the stored meta and messages; the default shape is unchanged", async () => {
    const d = await (await fetch(srv.base + `/conversation?id=${chatId}&full=1`)).json();
    expect(d.full).toBe(true);
    expect(d.meta.codexThreadId).toBeTruthy();
    expect(d.meta.messages).toBeUndefined();
    expect(d.messages[1].mid).toBeTruthy();
    const plain = await (await fetch(srv.base + `/conversation?id=${chatId}`)).json();
    expect(plain.full).toBeUndefined();
  });

  it("images on /message reach Codex; a model that can't see uses the vision model for that turn", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1×1 PNG
    const r = await post("/message", { text: "IMG1 what is this", images: [{ name: "x.png", mime: "image/png", dataBase64: png }], context: "Context: notes/ideas.md" });
    await assistantSays(r.convId, /hello from codex/);
    const req = or.calls.find((b) => lastUserText(b).includes("IMG1"));
    expect(req.model).toBe("openai/gpt-6.1-sol");
    const userParts = (req.input as any[]).filter((i) => i?.type === "message" && i.role === "user").flatMap((i) => i.content ?? []);
    if (process.env.VC_TEST_LOGS) console.log("IMG PARTS", JSON.stringify(userParts.map((p: any) => ({ type: p.type, head: JSON.stringify(p).slice(0, 120) }))));
    expect(userParts.some((p: any) => p.type === "input_image" && String(p.image_url ?? "").startsWith("data:image/"))).toBe(true);
    expect(lastUserText(req)).toContain("Context: notes/ideas.md");
    const c = await conv(r.convId);
    const u = c.messages.find((m: any) => m.role === "user");
    expect(u.content).toBe("IMG1 what is this");
    expect(u.attachments[0].capturedFilePath).toMatch(/^\.vault-chat\/captures\//);
    // The next turn is back on the default model.
    await post("/message", { convId: r.convId, text: "IMG1 again, no image" });
    await waitFor(() => or.calls.find((b) => lastUserText(b).includes("IMG1 again")) || null, 30_000);
    expect(or.calls.find((b) => lastUserText(b).includes("IMG1 again")).model).toBe("test/fake-model");
  });

  it("a tombstone from the laptop removes the conversation file on the box", async () => {
    const r = await post("/message", { text: "CHAT1 to be deleted" });
    await assistantSays(r.convId, /hello from codex/);
    const f = join(vault, ".vault-chat", "conversations", `${r.convId}.jsonl`);
    expect(existsSync(f)).toBe(true);
    writeFileSync(join(vault, ".vault-chat", "conversations-deleted.jsonl"), JSON.stringify({ id: r.convId, ts: Date.now() }) + String.fromCharCode(10), { flag: "a" });
    const list = await (await fetch(srv.base + "/conversations")).json();
    expect(list.conversations.some((x: any) => x.id === r.convId)).toBe(false);
    expect(existsSync(f)).toBe(false);
  });

  it("the paid probe runs only on request and records what it saw", async () => {
    or.rejectNamespace = false;
    const before = or.calls.length;
    const p = await post(`/api/v1/models/${encodeURIComponent("test/fake-model")}/probe`, {});
    expect(p.ok).toBe(true);
    expect(p.tools).toBe(true);
    expect(p.subagents).toBe(false); // the fake never spawns
    // The probe thread ran with multi_agent on (a per-thread config override): its requests carry the namespace tool.
    expect(or.calls.slice(before).some((b) => JSON.stringify(b.tools ?? []).includes("multi_agent"))).toBe(true);
    const probeCalls = or.calls.slice(before).filter((b) => JSON.stringify(b.input ?? []).includes("capability probe")).length;
    expect(probeCalls).toBeGreaterThanOrEqual(3); // tool call, its follow-up, the cache check
    expect(p.costUsd).toBeCloseTo(COST_PER_CALL * probeCalls, 6);
    const { models } = await (await fetch(srv.base + "/api/v1/models")).json();
    expect(models.find((m: any) => m.id === "test/fake-model").status).toBe("tested");
  });

  it("the cost ledger sums the fake costs from the rollout's response ids", async () => {
    const c = await waitFor(async () => {
      const x = await conv(chatId);
      return x.costUsd > 0 ? x : null;
    }, 45_000);
    expect(c.costUsd).toBeCloseTo(COST_PER_CALL, 6);
    const a = c.messages.find((m: any) => m.role === "assistant");
    expect(a.costUsd).toBeCloseTo(COST_PER_CALL, 6);
  });

  it("a tool call runs in the vault and is recorded on the message", async () => {
    const r = await post("/message", { text: "TOOL1 make a banana file" });
    const c = await assistantSays(r.convId, /TOOL1 done/);
    expect(readFileSync(join(vault, "banana.txt"), "utf8").trim()).toBe("banana");
    const a = c.messages.find((m: any) => m.role === "assistant");
    expect(a.toolCalls[0].name).toBe("Bash");
    expect(a.toolCalls[0].result).toContain("banana");
  });

  it("steer mid-turn: a second /message joins the running turn", async () => {
    const r = await post("/message", { text: "STEER1 run the slow step" });
    await waitFor(() => or.calls.some((b) => lastUserText(b).includes("STEER1")) || null, 30_000);
    await new Promise((res) => setTimeout(res, 1500));
    const s = await post("/message", { convId: r.convId, text: "kiwi steer: also mention kiwi" });
    expect(s.steered).toBe(true);
    const c = await assistantSays(r.convId, /saw the kiwi steer/, 60_000);
    expect(c.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["STEER1 run the slow step", "kiwi steer: also mention kiwi"]);
  });

  it("interrupt: /kill stops the running command", async () => {
    const r = await post("/message", { text: "INT1 sleep a long time" });
    await waitFor(() => or.calls.some((b) => lastUserText(b).includes("INT1")) || null, 30_000);
    await new Promise((res) => setTimeout(res, 1500));
    const t0 = Date.now();
    const k = await post("/kill", { convId: r.convId });
    expect(k.ok).toBe(true);
    const c = await assistantSays(r.convId, /stopped/, 20_000);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(c.state).not.toBe("running");
  });

  it("AskUser → the question shows and pushes, /answer resumes the same turn", async () => {
    const r = await post("/message", { text: "ASK1 pick a fruit" });
    const c = await assistantSays(r.convId, /apple or pear\?/);
    expect(c.state).toBe("waiting_user");
    expect(c.pendingAsk.question).toBe("apple or pear?");
    const feed = readFileSync(join(vault, ".vault-chat", "notifications.jsonl"), "utf8");
    expect(feed).toContain('"kind":"ask"');
    expect(feed).toContain(r.convId);
    const a = await post("/answer", { convId: r.convId, text: "pear" });
    expect(a.answered).toBe(true);
    const c2 = await assistantSays(r.convId, /ASK1 done: Carl answered: pear/);
    expect(c2.pendingAsk).toBeUndefined();
    expect(c2.messages.some((m: any) => m.role === "user" && m.decision && m.content === "pear")).toBe(true);
  });

  it("PdfRead returns page-limited text with the page count", async () => {
    const r = await post("/message", { text: "PDF1 read the pdf" });
    await assistantSays(r.convId, /PDF1 done/);
    expect(outputs.PDF1).toContain("Quarterly banana report");
    expect(outputs.PDF1).toMatch(/1 page\(s\)/);
  });

  it.skipIf(!linux)("the key is not visible from the agent's shell (env, key store, escalation)", async () => {
    const r = await post("/message", { text: "KEY1 look around" });
    await assistantSays(r.convId, /KEY1 done/);
    expect(outputs.KEY1).toContain("END-KEY1");
    expect(outputs.KEY1).not.toContain(CANARY);
    expect(outputs.KEY1).not.toContain(PASS);
    expect(outputs.KEY1).toMatch(/(^|\n|")0\\?n?/); // grep -c OPENROUTER → 0
    const r2 = await post("/message", { text: "KEY2 escalate" });
    await assistantSays(r2.convId, /KEY2 done/);
    expect(outputs.KEY2 ?? "").not.toContain(PASS);
  });

  it("keep-going: one nudge, then blocked with a push", async () => {
    const r = await post("/message", { text: "NUDGE1 keep at it" });
    const c = await waitFor(async () => {
      const x = await conv(r.convId);
      return x.state === "blocked" ? x : null;
    }, 60_000);
    expect(c.messages.some((m: any) => m.role === "user" && String(m.content).includes("keep-going mode"))).toBe(true);
    expect(c.messages.some((m: any) => m.role === "assistant" && /still nothing/.test(m.content))).toBe(true);
    const feed = readFileSync(join(vault, ".vault-chat", "notifications.jsonl"), "utf8");
    expect(feed).toMatch(/Stopped: NUDGE1/);
  });

  it("kill -9 the app-server mid-turn → the turn is marked and a resume turn runs", async () => {
    const r = await post("/message", { text: "CRASH1 long command" });
    await waitFor(() => or.calls.some((b) => lastUserText(b).includes("CRASH1")) || null, 30_000);
    await new Promise((res) => setTimeout(res, 1500));
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    process.kill(h.engine.codex.pid, "SIGKILL");
    const c = await assistantSays(r.convId, /resumed after the crash/, 90_000);
    expect(c.messages.some((m: any) => /Interrupted by a restart/.test(m.content))).toBe(true);
    expect(existsSync(join(vault, "crash.txt"))).toBe(false);
    const h2 = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h2.engine.codex.restarts).toBeGreaterThanOrEqual(1);
  });

  it("ScheduleWake survives a server restart and fires", async () => {
    const r = await post("/message", { text: "WAKE1 check back soon" });
    const c = await assistantSays(r.convId, /WAKE1 done/);
    expect(c.nextWakeAt).toBeGreaterThan(Date.now() - 1000);
    const wakes = JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "wakes.json"), "utf8"));
    expect(wakes.some((w: any) => w.conv === r.convId && w.reason === "check the run")).toBe(true);
    expect(readFileSync(join(vault, ".git", "info", "exclude"), "utf8")).toContain(".vault-chat/local/");
    await srv.stop();
    await boot();
    const c2 = await assistantSays(r.convId, /woke up and checked/, 60_000);
    expect(c2.messages.some((m: any) => m.role === "user" && /Wake: check the run/.test(m.content))).toBe(true);
    expect(JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "wakes.json"), "utf8"))).toEqual([]);
    // The restart cut the first turn's cost lookup short; the boot reconcile puts it on its message.
    const priced = await waitFor(async () => {
      const x = await conv(r.convId);
      const as = x.messages.filter((m: any) => m.role === "assistant");
      return as.length >= 2 && as.every((m: any) => m.costUsd > 0) ? x : null;
    }, 45_000);
    expect(priced.costUsd).toBeCloseTo(COST_PER_CALL * or.calls.filter((b) => JSON.stringify(b.input).includes("WAKE1")).length, 6);
  });
});
