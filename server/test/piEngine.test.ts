// The pi engine end to end (VC_ENGINE=pi): the built bundle, the REAL pinned
// pi (VC_TEST_PI_DIR = an npm prefix holding @earendil-works/pi-coding-agent@1.1.0),
// and a fake OpenRouter that speaks chat completions. Each scenario is keyed by
// a marker word in the user's message and is a list of steps: step i runs
// after the i-th tool result.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, tinyPdf, type Running } from "./helpers";
import { fakeChat, chatText, lastUser, CHAT_COST, type FakeChat, type ChatStep } from "./fakeChat";
import { readEntries } from "../convlog/piSession";

const PI_DIR = process.env.VC_TEST_PI_DIR;
const CANARY = "sk-or-canary-PIENGINE-not-real";
const PASS = "test-passphrase-not-a-secret";
const linux = process.platform === "linux";
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Scenario = ((prev: string) => ChatStep)[];

/** Tool results after the scenario's own user message, in order. */
function toolOutputsSince(body: any, key: string): string[] {
  const ms: any[] = body?.messages ?? [];
  let start = -1;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    const t = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    if (m?.role === "user" && t.includes(key)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  return ms
    .slice(start + 1)
    .filter((m) => m?.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join("\n")));
}

function makeResponder(scenarios: Record<string, Scenario>, outputs: Record<string, string>) {
  return (body: any): ChatStep => {
    const user = lastUser(body);
    if (user.includes("kiwi steer")) return { text: "saw the kiwi steer" };
    if (user.includes("box restarted")) return { text: "resumed after the crash" };
    if (user.includes("Wake: check the run")) return { text: "woke up and checked" };
    // The newest scenario mentioned in this conversation's own messages: pi's "you" layer (a user message
    // starting <you>) points at Carl's messages in the OTHER chats, so their scenario words are not this one's.
    const own = (body?.messages ?? []).filter((m: any) => !(m?.role === "user" && chatText({ messages: [m] }).startsWith("<you>")));
    const all = chatText({ messages: own });
    let key = "";
    let at = -1;
    for (const k of Object.keys(scenarios)) {
      const i = all.lastIndexOf(k);
      if (i > at) {
        at = i;
        key = k;
      }
    }
    if (!key) return { text: "hello from pi" };
    const outs = toolOutputsSince(body, key);
    if (outs.length) outputs[key] = outs.join("\n---\n");
    const steps = scenarios[key]!;
    if (!steps.length) return { text: "hello from pi" };
    if (outs.length < steps.length) return steps[outs.length]!(outs[outs.length - 1] ?? "");
    return { text: `${key} done: ${(outs[outs.length - 1] ?? "").slice(0, 80)}` };
  };
}

/** A conversation as the box holds it: the vault's feed folded over pi's session file (its fields and its
 *  transcript as messages), read the way the desktop client reads it (GET /conversation?full=1). */
async function readConvFile(base: string, id: string): Promise<any> {
  const r = await fetch(`${base}/conversation?id=${encodeURIComponent(id)}&full=1&n=200`);
  if (!r.ok) throw new Error(`conversation ${id}: HTTP ${r.status}`);
  const d = await r.json();
  return { ...d.meta, messages: d.messages };
}

describe.skipIf(!PI_DIR)("pi engine (real pi 1.1.0, fake chat-completions OpenRouter)", () => {
  let home: string, vault: string, secrets: string, state: string;
  let or: FakeChat;
  let srv: Running;
  const outputs: Record<string, string> = {};

  const boot = async () => {
    srv = await startServer({
      home,
      vault,
      secrets,
      openrouter: or.url,
      extra: { VC_ENGINE: "pi", VC_PI_DIR: PI_DIR!, VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: state },
    });
    await waitFor(async () => {
      const h = await (await fetch(srv.base + "/api/v1/health")).json();
      return h.engine?.pi?.state === "up" ? h : null;
    }, 60_000);
  };
  const post = (p: string, body: unknown) =>
    fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const conv = (id: string) => readConvFile(srv.base, id);
  const assistantSays = (id: string, re: RegExp, ms = 60_000) =>
    waitFor(async () => {
      const c = await conv(id);
      return c.messages.some((m: any) => m.role === "assistant" && re.test(String(m.content))) ? c : null;
    }, ms);
  const sawCall = (key: string) => waitFor(() => or.calls.some((b) => lastUser(b).includes(key)) || null, 30_000);

  const scenarios: Record<string, Scenario> = {
    CHAT1: [],
    TOOL1: [() => ({ call: { name: "bash", args: { command: "echo banana > banana.txt && cat banana.txt" } } })],
    STEER1: [() => ({ call: { name: "bash", args: { command: "sleep 6; echo step1" } } })],
    INT1: [() => ({ call: { name: "bash", args: { command: "sleep 60; echo late" } } })],
    ASK1: [() => ({ call: { name: "AskUser", args: { question: "apple or pear?", options: ["apple", "pear"] } } })],
    PDF1: [() => ({ call: { name: "PdfRead", args: { path: "doc.pdf" } } })],
    NOCOST1: [],
    KEY1: [
      () => ({
        call: {
          name: "bash",
          args: {
            command:
              // Carl's call: the keys are the agent's, as environment variables (never printed here).
              "echo ENV=$(env | grep -c ^OPENROUTER_API_KEY=); " +
              'echo LEN=$(printf %s "$OPENROUTER_API_KEY" | wc -c); ' +
              "echo STORE=$(cat " + "SECRETS" + "/fallback.key " + "SECRETS" + "/secrets.age 2>/dev/null | wc -c); " +
              "echo PROCENV=$(cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c PASSVAL); " +
              "echo SYSTEMD=$(systemd-run --user --quiet true 2>&1 >/dev/null; echo rc=$?); " +
              "echo END-KEY1",
          },
        },
      }),
    ],
    KEY2: [
      () => ({ call: { name: "read", args: { path: "SECRETS/fallback.key" } } }),
      () => ({ call: { name: "bash", args: { command: "ln -sfn SECRETS keylink && echo linked" } } }),
      () => ({ call: { name: "read", args: { path: "keylink/fallback.key" } } }),
      () => ({ call: { name: "write", args: { path: "keylink/planted.txt", content: "x" } } }),
      () => ({ call: { name: "write", args: { path: "STATE/pi/ext/vc.mjs", content: "export default () => {}" } } }),
    ],
    CRASH1: [() => ({ call: { name: "bash", args: { command: "sleep 8; echo survived > crash.txt" } } })],
    WAKE1: [() => ({ call: { name: "ScheduleWake", args: { in: "12s", reason: "check the run" } } })],
    IMG1: [],
  };

  beforeAll(async () => {
    home = tmp("vcpi-");
    vault = makeVault(join(home, "vault"));
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": CANARY });
    state = join(home, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(vault, "doc.pdf"), tinyPdf("Quarterly banana report"));
    // Path placeholders in scenarios.
    for (const s of Object.values(scenarios))
      s.forEach((f, i) => {
        // (Each path JSON-escaped: a Windows path's backslashes.)
        const esc = (v: string) => JSON.stringify(v).slice(1, -1);
        s[i] = (prev) => JSON.parse(JSON.stringify(f(prev)).replaceAll("SECRETS", esc(secrets)).replaceAll("STATE", esc(state)).replaceAll("PASSVAL", esc(PASS)));
      });
    or = await fakeChat();
    or.respond = makeResponder(scenarios, outputs);
    const orig = or.respond;
    or.respond = (body, n) => {
      const s = orig(body, n);
      if (lastUser(body).includes("NOCOST1") && "text" in s) return { ...s, noCost: true };
      // A reply slow enough for the phone host's store diff to see the run (it coalesces fast flips).
      if (lastUser(body).includes("CHAT1") && "text" in s) return { ...s, delayMs: 1500 };
      return s;
    };
    await boot();
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("health: pi pinned and up, its agent dir written, no key anywhere in the logs", async () => {
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h.engine.backend).toBe("pi");
    expect(h.engine.pi.state).toBe("up");
    expect(h.engine.version).toBe("1.1.0");
    if (linux) expect(h.engine.pi.sandbox).toBe(true);
    const settings = JSON.parse(readFileSync(join(state, "pi", "agent", "settings.json"), "utf8"));
    expect(settings.compaction.modelOverrides["openrouter/test/fake-model"].reserveTokens).toBeGreaterThan(16_000);
    const models = JSON.parse(readFileSync(join(state, "pi", "agent", "models.json"), "utf8"));
    expect(models.providers.openrouter.models.map((m: any) => m.id)).toContain("test/fake-model");
    expect(existsSync(join(state, "pi", "ext", "vc.mjs"))).toBe(true);
    expect(srv.logs()).not.toContain(CANARY);
  });

  let chatId = "";
  it("a chat turn: /message creates the conversation, the reply lands, /poll carries the events", async () => {
    const cursor = (await (await fetch(srv.base + "/poll?after=latest")).json()).next;
    const r = await post("/message", { text: "CHAT1 hi there", clientMsgId: "p-1" });
    expect(r.ok).toBe(true);
    chatId = r.convId;
    const again = await post("/message", { text: "CHAT1 hi there", clientMsgId: "p-1" });
    expect(again.convId).toBe(chatId);
    const c = await assistantSays(chatId, /hello from pi/);
    expect(c.threadId).toBeTruthy(); // the pi session id
    expect(existsSync(c.threadPath)).toBe(true); // its session file
    // Every vault-chat tool was declared to the model.
    const first0 = or.calls.find((b) => lastUser(b).includes("CHAT1"));
    const names = (first0.tools ?? []).map((t: any) => t.function?.name?.replace(/^mcp__vault_chat__/, ""));
    for (const t of ["AskUser", "ScheduleWake", "Notify", "StartJob", "JobStatus", "PdfRead", "WebSearch", "RecentActivity", "ListProjects", "ListNotes", "CreateNote", "UpdateNote", "DeleteNote", "bash", "read", "write", "edit"]) expect(names).toContain(t);
    // The ceremony tools are gone (2026-10-18): no keep-going mode, no Done verifier, no Blocked.
    for (const t of ["KeepWorking", "Done", "Blocked"]) expect(names).not.toContain(t);
    expect(c.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    // /poll is the vault's feed: the turn's start and end (meta), pointers into pi's session file (entry), pi's live events.
    const evs: any[] = [];
    let cur = cursor;
    await waitFor(async () => {
      const p = await (await fetch(srv.base + `/poll?after=${cur}`)).json();
      evs.push(...p.events);
      cur = p.next;
      return evs.some((e) => e.conv === chatId && e.type === "meta" && e.patch?.running === null) ? true : null;
    }, 20_000);
    expect(evs.some((e) => e.conv === chatId && e.type === "meta" && typeof e.patch?.running?.turn === "string")).toBe(true);
    expect(evs.some((e) => e.conv === chatId && e.type === "entry" && e.file === c.threadPath)).toBe(true);
    expect(evs.some((e) => e.conv === chatId && e.type === "live")).toBe(true);
    const list = await (await fetch(srv.base + "/conversations")).json();
    expect(list.conversations.find((x: any) => x.id === chatId)).toMatchObject({ title: "CHAT1 hi there", source: "phone" });
    const d = await (await fetch(srv.base + `/conversation?id=${chatId}`)).json();
    expect(d.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(Object.keys(d.messages[1]).sort()).toEqual(["askOptions", "content", "decision", "direct", "role", "system", "timeline", "tools"]);
    const full = await (await fetch(srv.base + `/conversation?id=${chatId}&full=1`)).json();
    expect(full.full).toBe(true);
    expect(full.meta.threadPath).toBeTruthy();
    // The rules prefix and pi's system prompt with vault-chat's role reached the model.
    const first = or.calls.find((b) => lastUser(b).includes("CHAT1"));
    expect(JSON.stringify(first.messages[0])).toContain("vault-chat's agent");
  });

  it("/api/v1/models: capabilities from the catalog; subagents wherever tools work", async () => {
    const { models } = await (await fetch(srv.base + "/api/v1/models")).json();
    const m = models.find((x: any) => x.id === "test/fake-model");
    expect(m.capabilities.tools).toBe(true);
    expect(m.capabilities.subagents).toBe(true);
    expect(["catalog", "learned", "untested"]).toContain(m.source);
  });

  it("an old conversation file (codexThreadId) still loads; its unknown thread gets a fresh pi session", async () => {
    // Only this synthetic legacy file is imported; no foreign native session is
    // searched or guessed from its obsolete Codex identity.
    const id = "old-codex-conv";
    const meta = { id, title: "Old chat", source: "phone", createdAt: 1700000000000, lastActivityAt: 1700000001000, status: "idle", recap: "Legacy recap", codexThreadId: "0199-not-a-pi-session", codexThreadPath: "/nowhere/rollout.jsonl" };
    const file = join(vault, ".vault-chat", "conversations", `${id}.jsonl`);
    const original = [meta, { role: "user", mid: "old-human", content: "earlier question KIWIWORD" }, { role: "assistant", content: "earlier answer" }].map(x => JSON.stringify(x)).join("\n") + "\n";
    writeFileSync(file, original);
    const get = (path: string) => fetch(srv.base + path).then(r => r.json());
    const checkpoint = async (convId: string) => (await get(`/api/v2/conversations/${convId}/checkpoint`)).picture;
    const d = await get(`/conversation?id=${id}&full=1`);
    expect(d.meta.threadId).toBe(meta.codexThreadId);
    expect(d.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "earlier question KIWIWORD"], ["assistant", "earlier answer"]]);
    const before = await checkpoint(id);
    expect(before.items).toHaveLength(2);
    expect(before.items[0]).toMatchObject({ id: "old-human", kind: "user", text: "earlier question KIWIWORD", via: "import" });
    const mainBefore = await checkpoint("main");
    const text = 'CHAT1 again\n```text\n[Carl, on his laptop]\n```';
    const sent = await post("/message", { convId: id, text, source: "laptop", clientMsgId: "legacy-new-human" });
    expect(sent).toMatchObject({ ok: true, convId: id });
    const c = await assistantSays(id, /hello from pi/);
    expect(c.threadId).toBeTruthy();
    expect(c.threadId).not.toBe(meta.codexThreadId);
    expect(c.threadPath).not.toBe(meta.codexThreadPath);
    expect(c.codexThreadId).toBeUndefined();
    expect(c).toMatchObject({ id, title: meta.title, source: meta.source, createdAt: meta.createdAt, recap: meta.recap });
    expect(c.messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "earlier question KIWIWORD"], ["assistant", "earlier answer"], ["user", text], ["assistant", "hello from pi"],
    ]);
    const calls = or.calls.filter(b => lastUser(b) === text);
    expect(calls).toHaveLength(1);
    // The transcript MUST reach the actual provider, but as hidden custom
    // context, not a prefix glued onto Carl's exact human body.
    expect(lastUser(calls[0])).toBe(text);
    expect(chatText(calls[0])).toContain("<earlier_conversation>\nuser: earlier question KIWIWORD\nassistant: earlier answer\n</earlier_conversation>");
    const entries = readFileSync(c.threadPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const users = entries.filter(e => e.type === "message" && e.message?.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].message).toMatchObject({ content: [{ type: "text", text }], vcRequest: { v: 1, clientId: "legacy-new-human", via: "chat", device: "laptop" } });
    const context = entries.filter(e => e.type === "custom_message" && e.customType === "vc-context" && e.content.includes("KIWIWORD"));
    expect(context).toHaveLength(1);
    expect(context[0].display).toBe(false);
    const after = await checkpoint(id);
    expect(after.items).toHaveLength(4);
    expect(after.items.slice(0, 2)).toEqual(before.items); // original identities, order and metadata
    expect(after.items[2]).toMatchObject({ id: "legacy-new-human", kind: "user", text, via: "chat", device: "laptop" });
    expect((await checkpoint("main")).items).toEqual(mainBefore.items); // old conversation owns this turn
    expect((await get(`/conversation?id=${id}&full=1`)).messages).toEqual(c.messages);
    expect((await checkpoint(id)).items).toEqual(after.items); // reopen does not replay imported history
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("a delete from the laptop (the delete intent) takes the conversation off the box's list", async () => {
    const r = await post("/message", { text: "CHAT1 to be deleted" });
    await assistantSays(r.convId, /hello from pi/);
    const listed = async () => ((await (await fetch(srv.base + "/conversations")).json()).conversations as any[]).some((x) => x.id === r.convId);
    expect(await listed()).toBe(true);
    expect((await post("/api/v2/intent", { type: "delete", convId: r.convId })).ok).toBe(true);
    expect(await listed()).toBe(false);
  });

  it("the cost ledger sums OpenRouter's streamed costs (never pi's own price)", async () => {
    const c = await waitFor(async () => {
      const x = await conv(chatId);
      return x.costUsd > 0 ? x : null;
    }, 20_000);
    expect(c.costUsd).toBeCloseTo(CHAT_COST, 6);
    // (Cost is the conversation's, from its pi session's vc-cost entries; the transcript is pi's own messages.)
    const ledger = JSON.parse(readFileSync(join(state, "ledger.json"), "utf8"));
    expect(Object.keys(ledger).some((k) => k.startsWith("gen-pi-"))).toBe(true);
    expect(or.lookups).toEqual([]); // the streamed cost was used, no lookup needed
  });

  it("a call whose stream carries no cost is priced from /generation by its generation id", async () => {
    const r = await post("/message", { text: "NOCOST1 a quiet one" });
    await assistantSays(r.convId, /hello from pi|NOCOST1/);
    const c = await waitFor(async () => {
      const x = await conv(r.convId);
      return x.costUsd > 0 ? x : null;
    }, 30_000);
    expect(c.costUsd).toBeCloseTo(CHAT_COST, 6);
    expect(or.lookups.length).toBeGreaterThanOrEqual(1);
  });

  it("a tool call runs in the vault and is recorded on the message", async () => {
    const r = await post("/message", { text: "TOOL1 make a banana file" });
    const c = await assistantSays(r.convId, /TOOL1 done/);
    expect(readFileSync(join(vault, "banana.txt"), "utf8").trim()).toBe("banana");
    const a = c.messages.find((m: any) => m.role === "assistant");
    expect(a.toolCalls[0].name).toBe("Bash");
    expect(a.toolCalls[0].result).toContain("banana");
    // Two model calls in this turn, two costs.
    const c2 = await waitFor(async () => {
      const x = await conv(r.convId);
      return x.costUsd > CHAT_COST * 1.5 ? x : null;
    }, 20_000);
    expect(c2.costUsd).toBeCloseTo(CHAT_COST * 2, 6);
  });

  it("split voice continuation: intentionally joins the running turn", async () => {
    // Main may already contain completed turns (including when this case runs
    // alone). A continuation must preserve them, not pretend Main is new.
    const prior = await post("/message", { text: "NOCOST1 earlier completed thought", clientMsgId: "continuation-prior" });
    const before = await waitFor(async () => {
      const c = await conv(prior.convId);
      const at = c.messages.findIndex((m: any) => m.mid === "continuation-prior");
      return at >= 0 && c.messages[at + 1]?.role === "assistant" && c.state !== "running" ? c : null;
    });
    const prefix = readFileSync(before.threadPath);
    const entriesBefore = readEntries(before.threadPath);
    const cursor = (await (await fetch(srv.base + "/poll?after=latest")).json()).next;
    const callsBefore = or.calls.length;
    const first = "STEER1 run the slow step";
    const continuation = "kiwi steer: also mention kiwi\n```text\n[Carl, on his laptop]\n```";
    const r = await post("/message", { convId: prior.convId, text: first, source: "voice", client: "phone", via: "voice", clientMsgId: "continuation-first" });
    // Native assistant/tool-call persistence establishes the in-flight boundary;
    // no fixed sleep, private queue inspection, or second request ledger.
    await waitFor(() => readEntries(before.threadPath).slice(entriesBefore.length).some(e =>
      e.message?.role === "assistant" && e.message.content.some((c: any) => c.type === "toolCall" && /(?:^|__)bash$/.test(c.name))) || null);
    const s = await post("/message", { convId: r.convId, text: continuation, source: "voice", client: "phone", via: "voice", continues: true, clientMsgId: "continuation-rest" });
    expect(s).toMatchObject({ ok: true, steered: true });
    expect(s.queued).toBeUndefined();
    const c = await waitFor(async () => {
      const c = await conv(r.convId);
      return c.state !== "running" && c.messages.at(-1)?.content === "saw the kiwi steer" ? c : null;
    }, 60_000);
    expect(c.threadId).toBe(before.threadId);
    expect(c.threadPath).toBe(before.threadPath);
    expect(c.messages.slice(0, before.messages.length)).toEqual(before.messages);
    const added = c.messages.slice(before.messages.length);
    expect(added.filter((m: any) => m.role === "user").map((m: any) => [m.mid, m.content])).toEqual([
      ["continuation-first", first], ["continuation-rest", continuation],
    ]);
    // One tool-bearing assistant step, then the refinement and the SAME turn's
    // one final reply. A follow-up would produce an extra old STEER1 answer.
    expect(added.filter((m: any) => !m.system).map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(added.filter((m: any) => m.role === "assistant").map((m: any) => m.content)).toEqual(["", "saw the kiwi steer"]);
    expect(c.queued ?? []).toEqual([]);
    const bytes = readFileSync(c.threadPath);
    expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
    const entries = readEntries(c.threadPath).slice(entriesBefore.length);
    const native = entries.filter(e => e.type === "message");
    expect(native.map(e => e.message!.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
    expect(native[2].message!.content).toEqual([{ type: "text", text: "step1\n" }]);
    const users = native.filter(e => e.message!.role === "user");
    expect(users.map(e => e.message!.content)).toEqual([first, continuation].map(text => [{ type: "text", text }]));
    expect(users.map(e => e.message!.vcRequest)).toEqual(["continuation-first", "continuation-rest"].map(clientId => ({ v: 1, clientId, via: "voice", device: "phone" })));
    expect(entries.some(e => e.type === "custom_message" && e.customType === "vc-context" && typeof e.content === "string" && e.content.includes("[Carl, on a voice call (phone)]"))).toBe(true);
    const calls = or.calls.slice(callsBefore);
    expect(calls).toHaveLength(2);
    expect(calls.map(lastUser)).toEqual([first, continuation]);
    expect(toolOutputsSince(calls[1], "STEER1")).toEqual(["step1\n"]);
    const poll = await (await fetch(srv.base + `/poll?after=${cursor}`)).json();
    const starts = poll.events.filter((e: any) => e.conv === r.convId && e.type === "meta" && e.patch?.running?.turn);
    expect(new Set(starts.map((e: any) => e.patch.running.turn)).size).toBe(1);
    expect((await conv(r.convId)).messages).toEqual(c.messages); // reopen does not replay either half
  });

  it("interrupt: /kill aborts the running command at once", async () => {
    const r = await post("/message", { text: "INT1 sleep a long time" });
    await sawCall("INT1");
    await new Promise((res) => setTimeout(res, 1500));
    const t0 = Date.now();
    const k = await post("/kill", { convId: r.convId });
    expect(k.ok).toBe(true);
    const c = await assistantSays(r.convId, /stopped/i, 20_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
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

  it("images on /message reach pi as image content and are kept as attachments", async () => {
    const r = await post("/message", { text: "IMG1 what is this", images: [{ name: "dot.png", mime: "image/png", dataBase64: PNG }] });
    const c = await assistantSays(r.convId, /hello from pi|IMG1/);
    const body = or.calls.find((b) => lastUser(b).includes("IMG1"));
    const image = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((b: any) => b.type === "image_url");
    expect(image.image_url.url).toBe(`data:image/png;base64,${PNG}`);
    const u = c.messages.find((m: any) => m.role === "user");
    expect(u.attachments?.[0]?.capturedFilePath).toMatch(/^\.vault-chat\/captures\//);
  });

  it("pointer-only captures and phone intents reach the genuine pi provider payload unchanged", async () => {
    const rel = ".vault-chat/captures/pointer.png";
    mkdirSync(join(vault, ".vault-chat/captures"), { recursive: true });
    writeFileSync(join(vault, rel), Buffer.from(PNG, "base64"));
    const r = await post("/api/v2/intent", { type: "send", text: "IMG1 pointer", imagePaths: [rel], client: "phone" });
    expect(r.ok).toBe(true);
    await sawCall("IMG1 pointer");
    const body = or.calls.find(b => lastUser(b).includes("IMG1 pointer"));
    const image = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((b: any) => b.type === "image_url");
    expect(image.image_url.url).toBe(`data:image/png;base64,${PNG}`);
    const q = new URLSearchParams({ path: rel, convId: r.convId });
    const asset = await fetch(srv.base + "/file?" + q);
    expect(asset.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await asset.arrayBuffer()).toString("base64")).toBe(PNG);
  });

  it.skipIf(!linux)("the keys are in the command's env by name; the key store, the passphrase and systemd stay out of reach", async () => {
    const r = await post("/message", { text: "KEY1 look around" });
    await assistantSays(r.convId, /KEY1 done/);
    const o = outputs.KEY1 ?? "";
    expect(o).toContain("END-KEY1");
    expect(o).not.toContain(CANARY);
    expect(o).not.toContain(PASS);
    const line = (k: string) => o.split("\n").find((l) => l.startsWith(`${k}=`));
    // Carl's call: the keys he adds are the agent's (asked of the host per command; never in a prompt or log).
    expect(line("ENV")).toBe("ENV=1");
    expect(line("LEN")).toBe(`LEN=${CANARY.length}`);
    expect(line("STORE")).toBe("STORE=0");
    expect(line("PROCENV")).toBe("PROCENV=0");
    expect(line("SYSTEMD")).toMatch(/rc=[1-9]/); // the user's systemd bus is hidden: no escape
  });

  // Linux: the agent's own `ln -s` (Windows' Git Bash copies instead; the junction case is in the describe below).
  it.skipIf(!linux)("pi's own read/write tools cannot reach the key store (path guard, symlinks resolved) or its state", async () => {
    const r = await post("/message", { text: "KEY2 try the in-process tools" });
    await assistantSays(r.convId, /KEY2 done/, 60_000);
    const o = outputs.KEY2 ?? "";
    expect(o).not.toContain(PASS);
    expect(o).not.toContain(CANARY);
    expect((o.match(/protected location/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(o).toMatch(/read-only for the agent/);
    expect(existsSync(join(secrets, "planted.txt"))).toBe(false);
    expect(readFileSync(join(state, "pi", "ext", "vc.mjs"), "utf8")).toContain("vault-chat's extension for pi");
  });

  it("kill -9 pi mid-turn → its whole process tree dies, the turn is marked, a resume turn runs", async () => {
    const r = await post("/message", { text: "CRASH1 long command" });
    await sawCall("CRASH1");
    await new Promise((res) => setTimeout(res, 1500));
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    const cc = await conv(r.convId);
    const p = h.engine.pi.procs.find((x: any) => x.threadId === cc.threadId);
    expect(p?.pid).toBeTruthy();
    process.kill(p.pid, "SIGKILL");
    const c = await assistantSays(r.convId, /resumed after the crash/, 60_000);
    expect(c.messages.some((m: any) => /Interrupted by a restart/.test(m.content))).toBe(true);
    // The orphan would have written crash.txt 8 s in.
    await new Promise((res) => setTimeout(res, 9000));
    // (Linux: pi's process group dies with it. Windows has no process groups to kill.)
    if (linux) expect(existsSync(join(vault, "crash.txt"))).toBe(false);
    const h2 = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h2.engine.pi.crashes).toBeGreaterThanOrEqual(1);
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
    expect(c2.messages.some((m: any) => m.role === "user" && /check the run/.test(m.content))).toBe(true);
    expect(JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "wakes.json"), "utf8"))).toEqual([]);
    // The same pi session file carried the conversation across the restart.
    expect(c2.threadPath).toBe(c.threadPath);
  });
});

describe.skipIf(!PI_DIR)("pi engine without bubblewrap: the path guard alone; Gemini cache markers", () => {
  let home: string, vault: string, secrets: string;
  let or: FakeChat;
  let srv: Running;
  const outputs: Record<string, string> = {};

  beforeAll(async () => {
    home = tmp("vcpig-");
    vault = makeVault(join(home, "vault"));
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": CANARY });
    // (A junction on Windows: a plain directory symlink needs admin rights there.)
    symlinkSync(secrets, join(vault, "sneaky"), process.platform === "win32" ? "junction" : "dir");
    or = await fakeChat();
    const scenarios: Record<string, Scenario> = {
      GUARD1: [
        () => ({ call: { name: "read", args: { path: join(secrets, "fallback.key") } } }),
        () => ({ call: { name: "read", args: { path: "sneaky/secrets.age" } } }),
        () => ({ call: { name: "read", args: { path: "~/secrets/fallback.key" } } }),
      ],
    };
    or.respond = makeResponder(scenarios, outputs);
    srv = await startServer({
      home,
      vault,
      secrets,
      openrouter: or.url,
      // No sandbox: bubblewrap is pointed at nothing; the engine runs only because VC_PI_UNSAFE=1.
      extra: { VC_ENGINE: "pi", VC_PI_DIR: PI_DIR!, VC_ENGINE_MODEL: "google/fake-gemini", VC_BWRAP: join(home, "no-bwrap"), VC_PI_UNSAFE: "1" },
    });
    await waitFor(async () => {
      const h = await (await fetch(srv.base + "/api/v1/health")).json();
      return h.engine?.pi?.state === "up" ? h : null;
    }, 60_000);
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("refuses to start on Linux without bubblewrap unless told to", async () => {
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h.engine.pi.sandbox).toBe(false);
  });

  it("read of the key store is blocked, directly, through a vault symlink and by absolute path", async () => {
    const r = await fetch(srv.base + "/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "GUARD1 read things" }) }).then((x) => x.json());
    const id = r.convId;
    await waitFor(async () => {
      const c = await readConvFile(srv.base, id);
      return c.messages.some((m: any) => m.role === "assistant" && /GUARD1 done/.test(m.content)) ? c : null;
    }, 60_000);
    const o = outputs.GUARD1 ?? "";
    expect((o.match(/protected location/g) ?? []).length).toBe(3);
    expect(o).not.toContain(PASS);
  });

  it("Gemini requests carry a cache_control marker on the system prompt", async () => {
    const body = or.calls.find((b) => lastUser(b).includes("GUARD1"));
    expect(body.model).toBe("google/fake-gemini");
    const sys = body.messages.find((m: any) => m.role === "system" || m.role === "developer");
    expect(JSON.stringify(sys)).toContain('"cache_control":{"type":"ephemeral"}');
  });
});
